import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalDto, ChatMessage, SseEvent } from "@agentmesh/shared";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("approval API", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("creates pending approvals from Codex requests and responds over the original JSON-RPC connection", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createApprovalFakeCodexScript(tempDir);
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
        text: "needs approval"
      }
    });
    expect(sent.statusCode).toBe(202);

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM approvals WHERE thread_id = ?")
        .get(threadId) as { status: string } | undefined;
      return row?.status === "pending";
    });

    const listed = await app.inject({ method: "GET", url: "/api/approvals?status=pending" });
    expect(listed.statusCode).toBe(200);
    const approval = listed.json<{ approvals: ApprovalDto[] }>().approvals[0];
    expect(approval).toMatchObject({
      appServerId,
      threadId,
      codexRequestId: "approval-req-1",
      kind: "item/commandExecution/requestApproval",
      status: "pending"
    });

    const messagesBefore = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`
    });
    expect(messagesBefore.json<{ messages: ChatMessage[] }>().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "event",
          parts: [
            expect.objectContaining({
              type: "approval",
              approvalId: approval?.id,
              status: "pending"
            })
          ]
        })
      ])
    );

    const responded = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval?.id}/respond`,
      payload: {
        decision: "approve"
      }
    });
    expect(responded.statusCode).toBe(200);
    expect(responded.json<{ approval: ApprovalDto }>().approval).toMatchObject({
      id: approval?.id,
      status: "approved",
      response: {
        decision: "approve",
        result: { decision: "acceptForSession" }
      }
    });

    await waitFor(() => {
      const rows = readJsonLines(path.join(workspace, "requests.ndjson"));
      return rows.some(
        (row) =>
          isRecord(row) &&
          row.id === "approval-req-1" &&
          isRecord(row.result) &&
          row.result.decision === "acceptForSession"
      );
    });

    const messagesAfter = await app.inject({
      method: "GET",
      url: `/api/threads/${threadId}/messages`
    });
    expect(messagesAfter.json<{ messages: ChatMessage[] }>().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "event",
          parts: [
            expect.objectContaining({
              type: "approval",
              approvalId: approval?.id,
              status: "approved"
            })
          ]
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "approval.created", thread_id: threadId }),
        expect.objectContaining({ type: "approval.updated", thread_id: threadId })
      ])
    );
  });

  it("marks pending approvals failed when the app-server exits", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createApprovalFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const { appServerId, threadId } = await createStartedAppServer(app, workspace, scriptPath);

    const sent = await app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: {
        threadId,
        text: "needs approval"
      }
    });
    expect(sent.statusCode).toBe(202);

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM approvals WHERE thread_id = ?")
        .get(threadId) as { status: string } | undefined;
      return row?.status === "pending";
    });

    const stopped = await app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/stop`
    });
    expect(stopped.statusCode).toBe(200);

    const approval = app.database.sqlite
      .prepare("SELECT status, error FROM approvals WHERE thread_id = ?")
      .get(threadId) as { status: string; error: string };
    expect(approval.status).toBe("failed");
    expect(approval.error).toContain("Codex app-server exited");
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

function createApprovalFakeCodexScript(tempDir: string): string {
  const scriptPath = path.join(
    tempDir,
    `fake-codex-approval-${Math.random().toString(16).slice(2)}.mjs`
  );
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const lines = readline.createInterface({ input: process.stdin });
      process.stdin.resume();
      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      let pendingTurnRequestId = null;

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
          pendingTurnRequestId = request.id;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: "approval-req-1",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: request.params.threadId,
              command: "touch approved.txt"
            }
          }) + "\\n");
        } else if (request.id === "approval-req-1" && pendingTurnRequestId !== null) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: pendingTurnRequestId,
            result: { turn: { id: "codex-turn-1" }, status: "completed" }
          }) + "\\n");
          pendingTurnRequestId = null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
