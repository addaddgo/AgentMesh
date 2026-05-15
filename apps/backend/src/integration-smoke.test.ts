import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalDto, ChatMessage, SseEvent, ThreadDto } from "@agentmesh/shared";

import { createTestBackend, type TestBackend } from "./test-helpers.js";
import { AgentMeshMcpService } from "./services/mcp.js";

describe("backend integration with fake Codex app-server", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  it("covers lifecycle, thread sync/import, sends, approvals, raw events, SSE, and MCP", async () => {
    backend = await createTestBackend();
    const { app, tempDir, config } = backend;
    const workspace = path.join(tempDir, "workspace");
    const observedEvents: SseEvent[] = [];
    fs.mkdirSync(workspace);
    app.events.subscribe((event) => observedEvents.push(event));

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `bash -lc 'exec env -u NODE_OPTIONS ${process.execPath} ${createFakeCodexScript(tempDir)}'`
      }
    });
    expect(created.statusCode).toBe(201);
    const appServerId = created.json<{ id: string }>().id;

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/start`
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ id: appServerId, status: "online" });

    const threads = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    expect(threads.statusCode).toBe(200);
    expect(threads.json<{ threads: ThreadDto[] }>().threads).toEqual([
      expect.objectContaining({
        appServerId,
        codexThreadId: "codex-thread-1",
        threadName: "Main",
        isCurrent: true,
        isGone: false
      })
    ]);
    const threadId = threads.json<{ threads: ThreadDto[] }>().threads[0]?.id;
    expect(threadId).toBeDefined();

    const imported = await app.inject({ method: "POST", url: `/api/threads/${threadId}/import` });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      imported: true,
      messages: [
        expect.objectContaining({
          role: "user",
          parts: [{ type: "markdown", text: "Imported question" }]
        }),
        expect.objectContaining({
          role: "assistant",
          parts: [{ type: "markdown", text: "Imported answer" }]
        })
      ]
    });
    const importSnapshotCount = countRows(app, "thread_imports", "thread_id = ?", [threadId]);
    const realtimeEventsAfterImport = countRows(app, "codex_events", "thread_id = ?", [threadId]);
    expect(importSnapshotCount).toBe(1);
    expect(realtimeEventsAfterImport).toBe(0);

    const textSend = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { threadId, text: "Hello Codex" }
    });
    expect(textSend.statusCode).toBe(202);
    await waitForMessageStatus(
      app,
      textSend.json<{ message: { id: string } }>().message.id,
      "completed"
    );

    const uploaded = await uploadPng(app);
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{
      attachment: {
        kind: "image";
        filename: string;
        localPath: string;
        mimeType: string;
        size: number;
        createdAt: number;
      };
    }>().attachment;
    const imageSend = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { threadId, text: "Describe this", attachments: [attachment] }
    });
    expect(imageSend.statusCode).toBe(202);
    await waitForMessageStatus(
      app,
      imageSend.json<{ message: { id: string } }>().message.id,
      "completed"
    );

    const approvalSend = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { threadId, text: "needs approval" }
    });
    expect(approvalSend.statusCode).toBe(202);
    await waitFor(
      () => countRows(app, "approvals", "thread_id = ? AND status = 'pending'", [threadId]) === 1
    );

    const pendingApprovals = await app.inject({
      method: "GET",
      url: "/api/approvals?status=pending"
    });
    expect(pendingApprovals.statusCode).toBe(200);
    const approval = pendingApprovals.json<{ approvals: ApprovalDto[] }>().approvals[0];
    expect(approval).toMatchObject({
      appServerId,
      threadId,
      codexRequestId: "approval-req-1",
      status: "pending"
    });

    const approvalResponse = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval?.id}/respond`,
      payload: { decision: "approve" }
    });
    expect(approvalResponse.statusCode).toBe(200);
    expect(approvalResponse.json<{ approval: ApprovalDto }>().approval).toMatchObject({
      id: approval?.id,
      status: "approved",
      response: { decision: "approve", result: { decision: "acceptForSession" } }
    });
    await waitForMessageStatus(
      app,
      approvalSend.json<{ message: { id: string } }>().message.id,
      "completed"
    );

    const mcp = new AgentMeshMcpService(app.database, config, app.events, app.appServerLifecycle, app.threadStatusCache);
    const appServerName = started.json<{ name: string }>().name;
    expect(mcp.listWorkspaceThreads()).toMatchObject({
      threads: [
        expect.objectContaining({
          app_workspace_name: appServerName,
          thread_name: "Main"
        })
      ]
    });
    const mcpSend = await mcp.sendMessage({
      appWorkspaceName: appServerName,
      threadName: "Main",
      text: "Hello from MCP"
    });
    expect(mcpSend).toMatchObject({ status: "queued" });

    const copiedImagePath = path.join(workspace, ".agentmesh", "images", attachment.filename);
    const requests = readJsonLines(path.join(workspace, "requests.ndjson"));
    expect(requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "initialize" })])
    );
    expect(requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "thread/list" })])
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/read", params: { threadId: "codex-thread-1" } })
      ])
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "turn/start",
          params: { threadId: "codex-thread-1", input: [{ type: "text", text: "Hello Codex" }] }
        }),
        expect.objectContaining({
          method: "turn/start",
          params: {
            threadId: "codex-thread-1",
            input: [
              { type: "text", text: "Describe this" },
              { type: "localImage", path: copiedImagePath }
            ]
          }
        }),
        expect.objectContaining({
          id: "approval-req-1",
          result: { decision: "acceptForSession" }
        })
      ])
    );
    expect(fs.existsSync(copiedImagePath)).toBe(true);

    const rawEvents = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/codex-events?limit=100`
    });
    expect(rawEvents.statusCode).toBe(200);
    expect(rawEvents.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "thread/message",
          rawJson: expect.stringContaining("Codex response")
        }),
        expect.objectContaining({ eventType: "turn/start.response" })
      ])
    });

    const messages = await app.inject({ method: "GET", url: `/api/threads/${threadId}/messages` });
    expect(messages.json<{ messages: ChatMessage[] }>().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          parts: [{ type: "markdown", text: "Codex response" }]
        }),
        expect.objectContaining({
          role: "event",
          parts: [
            expect.objectContaining({
              type: "approval",
              approvalId: approval?.id,
              status: "approved"
            })
          ]
        }),
        expect.objectContaining({
          role: "user",
          status: "completed",
          parts: [{ type: "markdown", text: "Hello from MCP" }]
        })
      ])
    );

    expect(observedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "app_server.status_changed", app_server_id: appServerId }),
        expect.objectContaining({ type: "thread.list_changed", app_server_id: appServerId }),
        expect.objectContaining({ type: "thread.imported", thread_id: threadId }),
        expect.objectContaining({ type: "thread.message_added", thread_id: threadId }),
        expect.objectContaining({ type: "thread.message_updated", thread_id: threadId }),
        expect.objectContaining({ type: "turn.status_changed", thread_id: threadId }),
        expect.objectContaining({ type: "approval.created", thread_id: threadId }),
        expect.objectContaining({ type: "approval.updated", thread_id: threadId }),
        expect.objectContaining({ type: "queue.item_updated", thread_id: threadId })
      ])
    );
  });
});

describe("optional real Codex app-server smoke tests", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  const maybeIt = process.env.AGENTMESH_REAL_CODEX_SMOKE === "1" ? it : it.skip;

  maybeIt("starts a real local codex app-server and synchronizes threads", async () => {
    backend = await createTestBackend();
    const workspace = process.env.AGENTMESH_REAL_CODEX_WORKSPACE ?? process.cwd();
    const command = process.env.AGENTMESH_REAL_CODEX_COMMAND ?? "codex app-server";
    const appServerId = await createAppServer(backend, { hostKind: "local", workspace, command });

    const started = await backend.app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/start`
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ id: appServerId, status: "online" });

    const threads = await backend.app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    expect(threads.statusCode).toBe(200);
    expect(threads.json()).toHaveProperty("threads");
  });
});

describe("optional SSH app-server smoke tests", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  const maybeIt = process.env.AGENTMESH_SSH_SMOKE === "1" ? it : it.skip;

  maybeIt("starts a remote codex app-server over SSH and synchronizes threads", async () => {
    backend = await createTestBackend();
    const host = requireEnv("AGENTMESH_SSH_HOST");
    const workspace = requireEnv("AGENTMESH_SSH_WORKSPACE");
    const command = process.env.AGENTMESH_SSH_COMMAND ?? "codex app-server";
    const sshPort =
      process.env.AGENTMESH_SSH_PORT === undefined
        ? undefined
        : Number(process.env.AGENTMESH_SSH_PORT);
    const appServerId = await createAppServer(backend, {
      hostKind: "ssh",
      host,
      sshUser: process.env.AGENTMESH_SSH_USER,
      sshPort,
      workspace,
      command
    });

    const started = await backend.app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/start`
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ id: appServerId, status: "online" });

    const threads = await backend.app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    expect(threads.statusCode).toBe(200);
    expect(threads.json()).toHaveProperty("threads");
  });
});

async function createAppServer(
  backend: TestBackend,
  payload: Record<string, unknown>
): Promise<string> {
  const created = await backend.app.inject({ method: "POST", url: "/api/app-servers", payload });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string }>().id;
}

function createFakeCodexScript(tempDir: string): string {
  const scriptPath = path.join(tempDir, `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      const lines = readline.createInterface({ input: process.stdin });
      process.stdin.resume();
      const keepAlive = setInterval(() => {}, 1 << 30);
      let nextTurnNumber = 1;
      let pendingApprovalTurnRequestId = null;

      lines.on("line", (line) => {
        const request = JSON.parse(line);
        fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");

        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { ok: true, fixture: "fake-codex" }
          }) + "\\n");
          return;
        } else if (request.method === "thread/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              threads: [
                {
                  id: "codex-thread-1",
                  name: "Main",
                  title: "Main thread",
                  status: "idle",
                  cwd: process.cwd()
                }
              ]
            }
          }) + "\\n");
          return;
        } else if (request.method === "thread/read") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              turns: [
                {
                  id: "imported-turn-1",
                  createdAt: 1700000000000,
                  messages: [
                    {
                      role: "user",
                      text: "Imported question",
                      createdAt: 1700000000000
                    },
                    {
                      role: "assistant",
                      text: "Imported answer",
                      createdAt: 1700000000001
                    }
                  ]
                }
              ]
            }
          }) + "\\n");
          return;
        } else if (request.method === "turn/start") {
          const text = getInputText(request.params?.input);

          if (text.includes("approval")) {
            pendingApprovalTurnRequestId = request.id;
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: "approval-req-1",
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: request.params.threadId,
                command: "touch approved.txt"
              }
            }) + "\\n");
            return;
          }

          const turnId = "codex-turn-" + String(nextTurnNumber);
          nextTurnNumber += 1;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "thread/message",
            params: {
              threadId: request.params.threadId,
              role: "assistant",
              status: "completed",
              text: text.includes("MCP") ? "MCP response" : "Codex response"
            }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { turn: { id: turnId }, status: "completed" }
          }) + "\\n");
          return;
        } else if (request.id === "approval-req-1" && pendingApprovalTurnRequestId !== null) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: pendingApprovalTurnRequestId,
            result: { turn: { id: "codex-turn-approved" }, status: "completed" }
          }) + "\\n");
          pendingApprovalTurnRequestId = null;
          return;
        }
      });
      lines.on("close", () => clearInterval(keepAlive));

      function getInputText(input) {
        if (!Array.isArray(input)) {
          return "";
        }

        return input
          .filter((part) => part && typeof part === "object" && part.type === "text")
          .map((part) => part.text)
          .filter((text) => typeof text === "string")
          .join("\\n");
      }
    `
  );
  return scriptPath;
}

async function waitForMessageStatus(
  app: TestBackend["app"],
  messageId: string,
  status: ChatMessage["status"]
): Promise<void> {
  await waitFor(() => {
    const row = app.database.sqlite
      .prepare("SELECT status FROM messages WHERE id = ?")
      .get(messageId) as { status: string } | undefined;
    return row?.status === status;
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

function countRows(
  app: TestBackend["app"],
  table: string,
  where: string,
  params: readonly unknown[]
): number {
  const row = app.database.sqlite
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(...params) as { count: number };
  return row.count;
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
  const boundary = `agentmesh-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
    ]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return app.inject({
    method: "POST",
    url: "/api/uploads/images",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required when AGENTMESH_SSH_SMOKE=1`);
  }

  return value;
}
