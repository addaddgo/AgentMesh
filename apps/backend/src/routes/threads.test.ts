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
    ).toEqual([expect.objectContaining({ params: { threadId: "thread-1" } })]);
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
    readonly threadRead: unknown;
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
      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      const threadList = ${JSON.stringify(options.threadList)};
      const threadRead = ${JSON.stringify(options.threadRead)};

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
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: threadRead
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
