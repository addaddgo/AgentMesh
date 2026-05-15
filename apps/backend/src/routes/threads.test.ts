import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

const backends: TestBackend[] = [];

describe("thread routes", () => {
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.cleanup()));
  });

  it("imports thread/read history into turns and multipart messages without codex events", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadList: [{ id: "thread-1", name: "Imported thread", title: "Import me" }],
      threadRead: {
        turns: [
          {
            id: "codex-turn-1",
            started_at: 1_000,
            messages: [
              {
                role: "user",
                created_at: 1_100,
                content: [
                  { type: "text", text: "Please inspect this" },
                  { type: "image", url: "file:///tmp/screenshot.png" }
                ]
              },
              {
                role: "assistant",
                created_at: 1_200,
                parts: [
                  { type: "markdown", text: "I inspected it." },
                  {
                    type: "tool_call",
                    toolName: "shell",
                    callId: "call-1",
                    input: { cmd: "pwd" },
                    status: "completed"
                  }
                ]
              }
            ]
          },
          {
            id: "codex-turn-2",
            started_at: 2_000,
            messages: [
              {
                role: "assistant",
                created_at: 2_100,
                parts: [{ type: "diff", text: "+changed" }]
              }
            ]
          }
        ]
      }
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${appServerId}/start`
        })
      ).statusCode
    ).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const threadId = listed.json<{ threads: readonly { id: string }[] }>().threads[0]?.id;
    expect(threadId).toBeDefined();

    const imported = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/import`
    });
    const body = imported.json<{
      imported: boolean;
      thread: { importedAt: number | null };
      messages: readonly {
        role: string;
        parts: readonly { type: string; text?: string; url?: string; toolName?: string }[];
      }[];
    }>();

    expect(imported.statusCode).toBe(200);
    expect(body.imported).toBe(true);
    expect(body.thread.importedAt).toEqual(expect.any(Number));
    expect(body.messages).toMatchObject([
      {
        role: "user",
        parts: [
          { type: "markdown", text: "Please inspect this" },
          { type: "image", url: "file:///tmp/screenshot.png" }
        ]
      },
      {
        role: "assistant",
        parts: [
          { type: "markdown", text: "I inspected it." },
          { type: "tool_call", toolName: "shell" }
        ]
      },
      {
        role: "assistant",
        parts: [{ type: "diff", text: "+changed" }]
      }
    ]);

    expect(countRows(app, "thread_imports")).toBe(1);
    expect(countRows(app, "turns")).toBe(2);
    expect(countRows(app, "messages")).toBe(3);
    expect(countRows(app, "codex_events")).toBe(0);

    const details = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}`
    });
    const messages = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`
    });
    const rawEvents = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/codex-events`
    });

    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      thread: {
        id: threadId,
        codexThreadId: "thread-1",
        importedAt: expect.any(Number)
      }
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json<{ messages: readonly unknown[] }>().messages).toHaveLength(3);
    expect(rawEvents.statusCode).toBe(200);
    expect(rawEvents.json()).toEqual({ events: [] });
  });

  it("does not duplicate imports, turns, or messages when import is called repeatedly", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadList: [{ id: "thread-1", name: "Import once" }],
      threadRead: {
        messages: [
          { role: "user", text: "Hello", created_at: 1_000 },
          { role: "assistant", text: "Hi", created_at: 1_100 }
        ]
      }
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/start` });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const threadId = listed.json<{ threads: readonly { id: string }[] }>().threads[0]?.id;

    const first = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });
    const second = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ imported: false });
    expect(countRows(app, "thread_imports")).toBe(1);
    expect(countRows(app, "turns")).toBe(1);
    expect(countRows(app, "messages")).toBe(2);
    expect(
      readJsonLines(path.join(workspace, "requests.ndjson")).filter(
        (request) => request.method === "thread/read"
      )
    ).toEqual([
      expect.objectContaining({ params: { threadId: "thread-1", includeTurns: true } }),
      expect.objectContaining({ params: { threadId: "thread-1", includeTurns: true } })
    ]);
  });

  it("incrementally imports newer remote messages when an imported thread is reopened", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadList: [{ id: "thread-1", name: "Mirror me" }],
      threadReads: [
        {
          turns: [
            {
              id: "codex-turn-1",
              started_at: 1_000,
              messages: [
                { role: "user", text: "Hello", created_at: 1_000 },
                { role: "assistant", text: "Hi", created_at: 1_100 }
              ]
            }
          ]
        },
        {
          turns: [
            {
              id: "codex-turn-1",
              started_at: 1_000,
              messages: [
                { role: "user", text: "Hello", created_at: 1_000 },
                { role: "assistant", text: "Hi", created_at: 1_100 }
              ]
            },
            {
              id: "codex-turn-2",
              started_at: 2_000,
              messages: [
                { role: "user", text: "Continue", created_at: 2_000 },
                { role: "assistant", text: "Synced", created_at: 2_100 }
              ]
            }
          ]
        }
      ]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/start` });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const threadId = listed.json<{ threads: readonly { id: string }[] }>().threads[0]?.id;

    const first = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });
    const second = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: true });
    expect(second.statusCode).toBe(200);
    expect(
      second.json<{
        readonly imported: boolean;
        readonly messages: readonly { role: string; parts: readonly { text?: string }[] }[];
      }>()
    ).toMatchObject({
      imported: false,
      messages: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "assistant", parts: [{ text: "Hi" }] },
        { role: "user", parts: [{ text: "Continue" }] },
        { role: "assistant", parts: [{ text: "Synced" }] }
      ]
    });
    expect(countRows(app, "thread_imports")).toBe(2);
    expect(countRows(app, "turns")).toBe(2);
    expect(countRows(app, "messages")).toBe(4);
  });

  it("imports nested thread.turns payloads returned by Codex thread/read", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadList: [{ id: "thread-1", name: "Nested payload" }],
      threadRead: {
        thread: {
          turns: [
            {
              id: "codex-turn-1",
              startedAt: 5_000,
              completedAt: 5_100,
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Outside question" }]
                },
                {
                  type: "agentMessage",
                  text: "Outside answer"
                }
              ]
            }
          ]
        }
      }
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/start` });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const threadId = listed.json<{ threads: readonly { id: string }[] }>().threads[0]?.id;

    const imported = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });

    expect(imported.statusCode).toBe(200);
    expect(
      imported.json<{
        readonly messages: readonly { role: string; createdAt: number; parts: readonly { text?: string }[] }[];
      }>().messages
    ).toMatchObject([
      { role: "user", createdAt: 5_000, parts: [{ text: "Outside question" }] },
      { role: "assistant", createdAt: 5_001, parts: [{ text: "Outside answer" }] }
    ]);
  });

  it("returns queue status scoped to a thread", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app);
    const threadId = insertThread(app, appServerId, "thread-with-queue");
    const otherThreadId = insertThread(app, appServerId, "other-thread");
    const firstQueueItemId = insertQueueItem(app, appServerId, threadId, "pending", 1_000);
    const secondQueueItemId = insertQueueItem(app, appServerId, threadId, "running", 2_000);
    insertQueueItem(app, appServerId, otherThreadId, "pending", 500);

    const response = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/queue`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        { id: firstQueueItemId, threadId, status: "pending" },
        { id: secondQueueItemId, threadId, status: "running" }
      ]
    });
  });

  it("replaces permission settings when switching from read only back to default", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadList: [{ id: "thread-1", name: "Permission thread", cwd: workspace }],
      threadRead: { messages: [] }
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/start` });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const threadId = listed.json<{ threads: readonly { id: string }[] }>().threads[0]?.id;
    expect(threadId).toBeDefined();

    const readOnly = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/codex-command-selection`,
      payload: { command: "/permissions", option: "Read Only" }
    });
    expect(readOnly.statusCode).toBe(200);

    const readOnlyDetails = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}`
    });
    expect(readOnlyDetails.json()).toMatchObject({
      thread: { runtime: { permissionMode: "Read Only" } }
    });

    const defaultPermission = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/codex-command-selection`,
      payload: { command: "/permissions", option: "Default" }
    });
    expect(defaultPermission.statusCode).toBe(200);

    const defaultDetails = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}`
    });
    expect(defaultDetails.json()).toMatchObject({
      thread: { runtime: { permissionMode: "Default" } }
    });

    const stored = app.database.sqlite
      .prepare("SELECT approval_policy_json, sandbox_policy_json FROM thread_settings WHERE thread_id = ?")
      .get(threadId) as {
      readonly approval_policy_json: string;
      readonly sandbox_policy_json: string;
    };
    expect(JSON.parse(stored.approval_policy_json)).toBe("on-request");
    expect(JSON.parse(stored.sandbox_policy_json)).toEqual({
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
  });

  it("applies permission settings without a live app-server transport", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app);
    const threadId = insertThread(app, appServerId, "offline-thread");

    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${threadId}/codex-command-selection`,
      payload: { command: "/permissions", option: "Default" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ applied: true });

    const details = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}`
    });
    expect(details.json()).toMatchObject({
      thread: { runtime: { permissionMode: "Default" } }
    });
  });
});

async function setup(): Promise<TestBackend> {
  const backend = await createTestBackend();
  backends.push(backend);
  return backend;
}

function createFakeCodexScript(
  tempDir: string,
  options: {
    readonly threadList: readonly unknown[];
    readonly threadRead?: unknown;
    readonly threadReads?: readonly unknown[];
  }
): string {
  const scriptPath = path.join(tempDir, `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const lines = readline.createInterface({ input: process.stdin });
      process.stdin.resume();
      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      const threadList = ${JSON.stringify(options.threadList)};
      const threadRead = ${JSON.stringify(options.threadRead ?? null)};
      const threadReads = ${JSON.stringify(options.threadReads ?? [])};
      let threadReadIndex = 0;

      for await (const line of lines) {
        const request = JSON.parse(line);
        fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");

        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { ok: true }
          }) + "\\n");
        } else if (request.method === "thread/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { threads: threadList }
          }) + "\\n");
        } else if (request.method === "thread/read") {
          const result = threadReads.length > 0
            ? threadReads[Math.min(threadReadIndex, threadReads.length - 1)]
            : threadRead;
          threadReadIndex += 1;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result
          }) + "\\n");
        }
      }
    `
  );
  return scriptPath;
}

function countRows(app: TestBackend["app"], table: string): number {
  const row = app.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function insertAppServer(app: TestBackend["app"]): string {
  const now = Date.now();
  const id = `app-server-${Math.random().toString(16).slice(2)}`;

  app.database.sqlite
    .prepare(
      `
        INSERT INTO app_servers (
          id,
          name,
          host_kind,
          host,
          ssh_user,
          ssh_port,
          workspace,
          command,
          status,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, 'local', 'localhost', NULL, NULL, ?, 'codex app-server', 'online', NULL, ?, ?)
      `
    )
    .run(id, id, `/workspace/${id}`, now, now);

  return id;
}

function insertThread(app: TestBackend["app"], appServerId: string, codexThreadId: string): string {
  const now = Date.now();
  const id = `thread-${Math.random().toString(16).slice(2)}`;

  app.database.sqlite
    .prepare(
      `
        INSERT INTO threads (
          id,
          app_server_id,
          codex_thread_id,
          thread_name,
          title,
          status,
          cwd,
          is_current,
          is_gone,
          imported_at,
          last_seen_at,
          raw_metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 0, NULL, ?, '{}', ?, ?)
      `
    )
    .run(id, appServerId, codexThreadId, codexThreadId, now, now, now);

  return id;
}

function insertQueueItem(
  app: TestBackend["app"],
  appServerId: string,
  threadId: string,
  status: "pending" | "running",
  createdAt: number
): string {
  const id = `queue-${Math.random().toString(16).slice(2)}`;

  app.database.sqlite
    .prepare(
      `
        INSERT INTO queue_items (
          id,
          app_server_id,
          thread_id,
          kind,
          status,
          payload_json,
          result_json,
          error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'send_message', ?, '{}', NULL, NULL, ?, ?)
      `
    )
    .run(id, appServerId, threadId, status, createdAt, createdAt);

  return id;
}

function readJsonLines(
  filePath: string
): { readonly method?: string; readonly params?: unknown }[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly method?: string; readonly params?: unknown });
}
