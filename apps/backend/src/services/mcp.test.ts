import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";
import { AgentMeshMcpService } from "./mcp.js";

describe("MCP tools", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("lists resumed threads for online workspaces using MCP field names", async () => {
    const { app, tempDir, config } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    const service = new AgentMeshMcpService(
      app.database,
      config,
      app.events,
      app.appServerLifecycle,
      app.threadStatusCache
    );

    const { appServerId } = await createStartedAppServer(
      app,
      workspace,
      createFakeCodexScript(tempDir)
    );
    const appServer = app.database.sqlite
      .prepare("SELECT name FROM app_servers WHERE id = ?")
      .get(appServerId) as { name: string };

    expect(service.listWorkspaceThreads()).toMatchObject({
      threads: [
        {
          app_workspace_name: appServer.name,
          thread_name: "Main"
        }
      ]
    });
  });

  it("sends text through the same queue, SQLite, and Codex turn/start pipeline as web sends", async () => {
    const { app, tempDir, config } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    const service = new AgentMeshMcpService(
      app.database,
      config,
      app.events,
      app.appServerLifecycle,
      app.threadStatusCache
    );

    const { appServerId, threadId } = await createStartedAppServer(
      app,
      workspace,
      createFakeCodexScript(tempDir)
    );
    const appServer = app.database.sqlite
      .prepare("SELECT name FROM app_servers WHERE id = ?")
      .get(appServerId) as { name: string };

    const result = service.sendMessage({
      appWorkspaceName: appServer.name,
      threadName: "Main",
      text: "Hello from MCP"
    });

    expect(result).toMatchObject({ status: "queued" });

    if (result.status !== "queued") {
      throw new Error("Expected queued MCP send");
    }

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM messages WHERE id = ?")
        .get(result.message_id) as { status: string } | undefined;
      return row?.status === "completed";
    });

    const turnStart = readJsonLines(path.join(workspace, "requests.ndjson")).find(
      (request): request is { method: string; params: unknown } =>
        typeof request === "object" &&
        request !== null &&
        (request as { method?: unknown }).method === "turn/start"
    );
    const queueItem = app.database.sqlite
      .prepare("SELECT kind, status FROM queue_items WHERE id = ?")
      .get(result.queue_item_id) as { kind: string; status: string };
    const message = app.database.sqlite
      .prepare("SELECT thread_id, status, parts_json FROM messages WHERE id = ?")
      .get(result.message_id) as { thread_id: string; status: string; parts_json: string };

    expect(turnStart?.params).toEqual({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "Hello from MCP" }]
    });
    expect(queueItem).toEqual({ kind: "send_message", status: "completed" });
    expect(message.thread_id).toBe(threadId);
    expect(message.status).toBe("completed");
    expect(JSON.parse(message.parts_json)).toEqual([{ type: "markdown", text: "Hello from MCP" }]);
  });

  it("returns MCP routing errors without guessing", async () => {
    const { app, tempDir, config } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);
    const service = new AgentMeshMcpService(
      app.database,
      config,
      app.events,
      app.appServerLifecycle,
      app.threadStatusCache
    );

    expect(
      service.sendMessage({ appWorkspaceName: "missing", threadName: "Main", text: "hello" })
    ).toEqual({ status: "error", error: "app_server_not_found" });

    const { appServerId } = await createStartedAppServer(
      app,
      workspace,
      createFakeCodexScript(tempDir)
    );
    const appServer = app.database.sqlite
      .prepare("SELECT name FROM app_servers WHERE id = ?")
      .get(appServerId) as { name: string };

    expect(
      service.sendMessage({
        appWorkspaceName: appServer.name,
        threadName: "Missing",
        text: "hello"
      })
    ).toEqual({ status: "error", error: "thread_not_found" });

    insertCurrentThread(app, appServerId, {
      codexThreadId: "codex-thread-2",
      threadName: "Main"
    });

    expect(
      service.sendMessage({ appWorkspaceName: appServer.name, threadName: "Main", text: "hello" })
    ).toEqual({ status: "error", error: "ambiguous_thread_name" });

    app.database.sqlite
      .prepare("DELETE FROM threads WHERE codex_thread_id = ?")
      .run("codex-thread-2");
    await app.inject({ method: "POST", url: `/api/app-servers/${appServerId}/stop` });

    expect(
      service.sendMessage({ appWorkspaceName: appServer.name, threadName: "Main", text: "hello" })
    ).toEqual({ status: "error", error: "app_server_offline" });
  });

  it("exposes the MCP tools over the backend /mcp endpoint", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);

    await createStartedAppServer(app, workspace, createFakeCodexScript(tempDir), "agentmesh_test");

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" }
        }
      }
    });
    const sessionId = String(initialized.headers["mcp-session-id"]);

    await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-session-id": sessionId },
      payload: {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }
    });

    const called = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-session-id": sessionId },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_workspace_threads",
          arguments: {}
        }
      }
    });

    expect(initialized.statusCode).toBe(200);
    expect(sessionId).not.toBe("undefined");
    expect(called.statusCode).toBe(200);
    expect(called.json()).toMatchObject({
      result: {
        structuredContent: {
          threads: [
            {
              app_workspace_name: "agentmesh_test",
              thread_name: "Main"
            }
          ]
        }
      }
    });
  });
});

async function createStartedAppServer(
  app: TestBackend["app"],
  workspace: string,
  scriptPath: string,
  name?: string
): Promise<{ readonly appServerId: string; readonly threadId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/api/app-servers",
    payload: {
      ...(name === undefined ? {} : { name }),
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
    .prepare("SELECT id FROM threads WHERE app_server_id = ? AND codex_thread_id = ?")
    .get(appServerId, "codex-thread-1") as { id: string };

  return { appServerId, threadId: thread.id };
}

function insertCurrentThread(
  app: TestBackend["app"],
  appServerId: string,
  input: { readonly codexThreadId: string; readonly threadName: string }
): void {
  const now = Date.now();
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
        ) VALUES (?, ?, ?, ?, NULL, 'idle', NULL, 1, 0, NULL, ?, ?, ?, ?)
      `
    )
    .run(
      randomUUID(),
      appServerId,
      input.codexThreadId,
      input.threadName,
      now,
      JSON.stringify({ id: input.codexThreadId, name: input.threadName }),
      now,
      now
    );
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
            result: { threads: [{ id: "codex-thread-1", name: "Main", status: "idle" }] }
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

function readJsonLines(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
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
