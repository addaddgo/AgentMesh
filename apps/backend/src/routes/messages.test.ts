import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage, SseEvent } from "@agentmesh/shared";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("message send API", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("sends text to an existing current Codex thread and stores responses, notifications, and SSE events", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    const events: SseEvent[] = [];
    fs.mkdirSync(workspace);
    app.events.subscribe((event) => {
      events.push(event);
    });

    const { appServerId, threadId } = await createStartedAppServer(app, workspace, scriptPath);

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Hello Codex"
      }
    });

    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({
      message: {
        appServerId,
        threadId,
        role: "user",
        parts: [{ type: "markdown", text: "Hello Codex" }]
      },
      turn: {
        appServerId,
        threadId
      },
      queueItem: {
        appServerId,
        threadId,
        kind: "send_message"
      }
    });

    const messageId = sent.json<{ message: { id: string } }>().message.id;
    const turnId = sent.json<{ turn: { id: string } }>().turn.id;

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM messages WHERE id = ?")
        .get(messageId) as { status: string } | undefined;
      return row?.status === "completed";
    });

    const requests = readJsonLines(path.join(workspace, "requests.ndjson"));
    const turnStart = requests.find(
      (request): request is { method: string; params: unknown } =>
        typeof request === "object" &&
        request !== null &&
        (request as { method?: unknown }).method === "turn/start"
    );
    const userMessage = app.database.sqlite
      .prepare("SELECT status FROM messages WHERE id = ?")
      .get(messageId) as { status: string };
    const turn = app.database.sqlite
      .prepare("SELECT status, codex_turn_id, trigger_message_id FROM turns WHERE id = ?")
      .get(turnId) as { status: string; codex_turn_id: string; trigger_message_id: string };
    const storedMessages = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`
    });
    const eventCount = app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM codex_events WHERE thread_id = ? AND turn_id = ?")
      .get(threadId, turnId) as { count: number };
    const rawEvents = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/codex-events`
    });
    const appServerRawEvents = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/codex-events?limit=1`
    });

    expect(turnStart?.params).toEqual({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "Hello Codex" }]
    });
    expect(userMessage.status).toBe("completed");
    expect(turn).toEqual({
      status: "completed",
      codex_turn_id: "codex-turn-1",
      trigger_message_id: messageId
    });
    expect(storedMessages.json<{ messages: ChatMessage[] }>().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: messageId, role: "user", status: "completed" }),
        expect.objectContaining({
          role: "assistant",
          status: "completed",
          parts: [{ type: "markdown", text: "Codex response" }]
        })
      ])
    );
    expect(eventCount.count).toBeGreaterThanOrEqual(2);
    expect(rawEvents.statusCode).toBe(200);
    expect(rawEvents.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          appServerId,
          threadId,
          turnId,
          eventType: "thread/message",
          rawJson: expect.stringContaining('"method":"thread/message"')
        }),
        expect.objectContaining({
          appServerId,
          threadId,
          turnId,
          eventType: "turn/start.response",
          rawJson: expect.stringContaining('"result":{"turn":{"id":"codex-turn-1"}')
        })
      ])
    });
    expect(appServerRawEvents.statusCode).toBe(200);
    expect(appServerRawEvents.json<{ events: readonly unknown[] }>().events).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.message_added", thread_id: threadId }),
        expect.objectContaining({ type: "thread.message_updated", thread_id: threadId }),
        expect.objectContaining({ type: "turn.status_changed", thread_id: threadId }),
        expect.objectContaining({ type: "queue.item_updated", thread_id: threadId })
      ])
    );
  });

  it("requires explicit resume before sending to a listed but not loaded Codex thread", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createResumeRequiredCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { appServerId, threadId } = await createStartedAppServer(app, workspace, scriptPath);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Hello after resume"
      }
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Thread is not loaded. Resume it before sending."
      }
    });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/threads/${threadId}/resume`
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      thread: { id: threadId, status: "idle" }
    });

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Hello after resume"
      }
    });
    const messageId = sent.json<{ message: { id: string } }>().message.id;

    expect(sent.statusCode).toBe(202);
    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM messages WHERE id = ?")
        .get(messageId) as { status: string } | undefined;
      return row?.status === "completed";
    });

    const requests = readJsonLines(path.join(workspace, "requests.ndjson"));
    const requestMethods = requests.map((request) =>
      typeof request === "object" && request !== null ? (request as { method?: unknown }).method : null
    );
    const thread = app.database.sqlite
      .prepare("SELECT status FROM threads WHERE id = ?")
      .get(threadId) as { status: string };

    expect(requestMethods).toEqual(
      expect.arrayContaining(["thread/list", "turn/start", "thread/resume"])
    );
    expect(requestMethods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(thread.status).toBe("idle");
  });

  it("fails offline sends visibly and leaves the composer draft untouched", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { appServerId, threadId } = await createStartedAppServer(app, workspace, scriptPath);
    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/stop` });
    app.database.sqlite
      .prepare(
        `
          INSERT INTO thread_drafts (app_server_id, thread_id, draft_markdown, updated_at)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(appServerId, threadId, "unsent draft", Date.now());

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Please send"
      }
    });

    const failedMessage = app.database.sqlite
      .prepare("SELECT status FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId) as { status: string };
    const failedTurn = app.database.sqlite
      .prepare(
        "SELECT status, error FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(threadId) as { status: string; error: string };
    const draft = app.database.sqlite
      .prepare("SELECT draft_markdown FROM thread_drafts WHERE app_server_id = ? AND thread_id = ?")
      .get(appServerId, threadId) as { draft_markdown: string };

    expect(sent.statusCode).toBe(409);
    expect(sent.json()).toMatchObject({
      error: { code: "offline", message: "App server is offline" }
    });
    expect(failedMessage.status).toBe("failed");
    expect(failedTurn).toEqual({ status: "failed", error: "App server is offline" });
    expect(draft.draft_markdown).toBe("unsent draft");
  });

  it("rejects sends to gone threads", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { threadId } = await createStartedAppServer(app, workspace, scriptPath);
    app.database.sqlite
      .prepare("UPDATE threads SET is_current = 0, is_gone = 1 WHERE id = ?")
      .run(threadId);

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Should not send"
      }
    });
    const messageCount = app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?")
      .get(threadId) as { count: number };

    expect(sent.statusCode).toBe(400);
    expect(sent.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Cannot send to a gone thread"
      }
    });
    expect(messageCount.count).toBe(0);
  });

  it("rejects messages with more than 5 images", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { threadId } = await createStartedAppServer(app, workspace, scriptPath);

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Too many images",
        attachmentIds: ["1", "2", "3", "4", "5", "6"]
      }
    });

    expect(sent.statusCode).toBe(400);
    expect(sent.json()).toMatchObject({
      error: { code: "validation_error" }
    });
  });

  it("rejects invalid image MIME uploads", async () => {
    const { app } = await setup();

    const uploaded = await uploadMultipartFile(app, {
      filename: "note.txt",
      mimeType: "text/plain",
      content: Buffer.from("not an image")
    });

    expect(uploaded.statusCode).toBe(400);
    expect(uploaded.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Unsupported image MIME type"
      }
    });
  });

  it("rejects path traversal in uploaded image filenames", async () => {
    const { app } = await setup();

    const uploaded = await uploadMultipartFile(app, {
      filename: "..%2Fpixel.png",
      mimeType: "image/png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });

    expect(uploaded.statusCode).toBe(400);
    expect(uploaded.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Uploaded filename is invalid"
      }
    });
  });

  it("copies local uploaded images to .agentmesh/images and sends localImage input", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { threadId } = await createStartedAppServer(app, workspace, scriptPath);
    const uploaded = await uploadPng(app);
    const attachmentId = uploaded.json<{ attachment: { id: string; filename: string } }>()
      .attachment.id;
    const filename = uploaded.json<{ attachment: { filename: string } }>().attachment.filename;

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "Describe this",
        attachmentIds: [attachmentId]
      }
    });

    expect(sent.statusCode).toBe(202);
    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM messages WHERE id = ?")
        .get(sent.json<{ message: { id: string } }>().message.id) as { status: string } | undefined;
      return row?.status === "completed";
    });

    const copiedPath = path.join(workspace, ".agentmesh", "images", filename);
    const requests = readJsonLines(path.join(workspace, "requests.ndjson"));
    const turnStart = requests.find(
      (request): request is { method: string; params: { input: unknown } } =>
        typeof request === "object" &&
        request !== null &&
        (request as { method?: unknown }).method === "turn/start"
    );
    const attachment = app.database.sqlite
      .prepare("SELECT workspace_path FROM attachments WHERE id = ?")
      .get(attachmentId) as { workspace_path: string };
    const linkCount = app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE attachment_id = ?")
      .get(attachmentId) as { count: number };

    expect(fs.existsSync(copiedPath)).toBe(true);
    expect(attachment.workspace_path).toBe(copiedPath);
    expect(linkCount.count).toBe(1);
    expect(turnStart?.params.input).toEqual([
      { type: "text", text: "Describe this" },
      { type: "localImage", path: copiedPath }
    ]);
  });

  it("marks the message failed when local image copy fails", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { threadId } = await createStartedAppServer(app, workspace, scriptPath);
    fs.mkdirSync(path.join(workspace, ".agentmesh"));
    fs.writeFileSync(path.join(workspace, ".agentmesh", "images"), "not a directory");

    const uploaded = await uploadPng(app);
    const attachmentId = uploaded.json<{ attachment: { id: string } }>().attachment.id;
    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "This copy will fail",
        attachmentIds: [attachmentId]
      }
    });

    expect(sent.statusCode).toBe(202);
    const messageId = sent.json<{ message: { id: string } }>().message.id;
    const turnId = sent.json<{ turn: { id: string } }>().turn.id;

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM messages WHERE id = ?")
        .get(messageId) as { status: string } | undefined;
      return row?.status === "failed";
    });

    const turn = app.database.sqlite
      .prepare("SELECT status, error FROM turns WHERE id = ?")
      .get(turnId) as { status: string; error: string };
    const requests = readJsonLines(path.join(workspace, "requests.ndjson"));

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("EEXIST");
    expect(
      requests.some(
        (request) =>
          typeof request === "object" &&
          request !== null &&
          (request as { method?: unknown }).method === "turn/start"
      )
    ).toBe(false);
  });
});

async function createStartedAppServer(
  app: TestBackend["app"],
  workspace: string,
  scriptPath: string
): Promise<{ readonly appServerId: string; readonly threadId: string }> {
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

  const started = await app.inject({
    method: "POST",
    url: `/api/app-servers/${appServerId}/start`
  });
  expect(started.statusCode).toBe(200);

  const thread = app.database.sqlite
    .prepare(
      "SELECT id FROM threads WHERE app_server_id = ? AND codex_thread_id = 'codex-thread-1'"
    )
    .get(appServerId) as { id: string };

  return { appServerId, threadId: thread.id };
}

function createFakeCodexScript(tempDir: string): string {
  const scriptPath = path.join(tempDir, `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const lines = readline.createInterface({ input: process.stdin });
      const requestsPath = path.join(process.cwd(), "requests.ndjson");

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
            result: { threads: [{ id: "codex-thread-1", name: "Main" }] }
          }) + "\\n");
        } else if (request.method === "turn/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "thread/message",
            params: {
              threadId: request.params.threadId,
              role: "assistant",
              status: "completed",
              text: "Codex response"
            }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { turn: { id: "codex-turn-1" }, status: "completed" }
          }) + "\\n");
        }
      }
    `
  );
  return scriptPath;
}

function createResumeRequiredCodexScript(tempDir: string): string {
  const scriptPath = path.join(
    tempDir,
    `fake-codex-resume-${Math.random().toString(16).slice(2)}.mjs`
  );
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const lines = readline.createInterface({ input: process.stdin });
      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      let loaded = false;

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
            result: {
              data: [{
                id: "codex-thread-1",
                name: "Main",
                status: { type: loaded ? "idle" : "notLoaded" }
              }]
            }
          }) + "\\n");
        } else if (request.method === "thread/resume") {
          loaded = true;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { thread: { id: request.params.threadId, name: "Main", status: { type: "idle" } } }
          }) + "\\n");
        } else if (request.method === "turn/start" && !loaded) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32600, message: "thread not found: " + request.params.threadId }
          }) + "\\n");
        } else if (request.method === "turn/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "thread/message",
            params: {
              threadId: request.params.threadId,
              role: "assistant",
              status: "completed",
              text: "Codex response after resume"
            }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { turn: { id: "codex-turn-1" }, status: "completed" }
          }) + "\\n");
        }
      }
    `
  );
  return scriptPath;
}

function readJsonLines(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function uploadPng(app: TestBackend["app"]) {
  return uploadMultipartFile(app, {
    filename: "pixel.png",
    mimeType: "image/png",
    content: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
    ])
  });
}

async function uploadMultipartFile(
  app: TestBackend["app"],
  input: { readonly filename: string; readonly mimeType: string; readonly content: Buffer }
) {
  const boundary = `agentmesh-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`
    ),
    input.content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return app.inject({
    method: "POST",
    url: "/api/uploads/images",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error("Timed out waiting for condition");
}
