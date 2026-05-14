import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";
import { EventService } from "./events.js";
import { ThreadQueueService } from "./thread-queue.js";
import { ThreadStopService } from "./thread-stop.js";

describe("thread stop service", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("fails pending and waiting-approval work for a thread", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app);
    const threadId = insertThread(app, appServerId, "codex-thread-1");
    const pendingMessageId = insertMessage(app, appServerId, threadId, "queued");
    const pendingTurnId = insertTurn(app, appServerId, threadId, pendingMessageId, "queued");
    linkMessageToTurn(app, pendingMessageId, pendingTurnId);
    const waitingMessageId = insertMessage(app, appServerId, threadId, "streaming");
    const waitingTurnId = insertTurn(
      app,
      appServerId,
      threadId,
      waitingMessageId,
      "waiting_approval",
      "codex-turn-1"
    );
    linkMessageToTurn(app, waitingMessageId, waitingTurnId);
    insertApproval(app, appServerId, threadId, waitingTurnId);

    const queue = new ThreadQueueService(app.database, app.events);
    const pendingQueueItem = insertQueueItem(
      app,
      appServerId,
      threadId,
      "pending",
      pendingMessageId,
      pendingTurnId
    );
    const waitingQueueItem = insertQueueItem(
      app,
      appServerId,
      threadId,
      "waiting_approval",
      waitingMessageId,
      waitingTurnId
    );
    const service = new ThreadStopService(
      app.database,
      app.events,
      { getTransport: () => { throw new Error("not needed"); } } as never,
      queue
    );

    const result = await service.stop(threadId);

    expect(result).toMatchObject({
      threadId,
      stoppedQueueItemIds: [pendingQueueItem],
      runningQueueItemId: waitingQueueItem,
      runningTurnId: waitingTurnId,
      transportStopAttempted: false,
      transportStopAccepted: false
    });
    expect(readStatus(app, "queue_items", pendingQueueItem)).toBe("failed");
    expect(readStatus(app, "queue_items", waitingQueueItem)).toBe("failed");
    expect(readStatus(app, "turns", pendingTurnId)).toBe("failed");
    expect(readStatus(app, "turns", waitingTurnId)).toBe("failed");
    expect(readStatus(app, "messages", pendingMessageId)).toBe("failed");
    expect(readStatus(app, "messages", waitingMessageId)).toBe("failed");
    expect(readApprovalStatus(app, threadId)).toBe("failed");
  });

  it("best-effort stops a running turn when the transport accepts a stop request", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app);
    const threadId = insertThread(app, appServerId, "codex-thread-2");
    const messageId = insertMessage(app, appServerId, threadId, "streaming");
    const turnId = insertTurn(app, appServerId, threadId, messageId, "running", "codex-turn-2");
    linkMessageToTurn(app, messageId, turnId);
    const queue = new ThreadQueueService(app.database, app.events);
    const queueItemId = insertQueueItem(app, appServerId, threadId, "running", messageId, turnId);
    const requestedMethods: string[] = [];
    const service = new ThreadStopService(
      app.database,
      app.events,
      {
        getTransport: () => ({
          request: async (method: string) => {
            requestedMethods.push(method);
            return { stopped: true };
          }
        })
      } as never,
      queue
    );

    const result = await service.stop(threadId);

    expect(result).toMatchObject({
      stoppedQueueItemIds: [],
      runningQueueItemId: queueItemId,
      runningTurnId: turnId,
      transportStopAttempted: true,
      transportStopAccepted: true
    });
    expect(requestedMethods[0]).toBe("turn/cancel");
    expect(readStatus(app, "queue_items", queueItemId)).toBe("failed");
    expect(readStatus(app, "turns", turnId)).toBe("failed");
    expect(readStatus(app, "messages", messageId)).toBe("failed");
  });
});

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

function insertMessage(
  app: TestBackend["app"],
  appServerId: string,
  threadId: string,
  status: "queued" | "streaming"
): string {
  const now = Date.now();
  const id = `message-${Math.random().toString(16).slice(2)}`;

  app.database.sqlite
    .prepare(
      `
        INSERT INTO messages (
          id,
          app_server_id,
          thread_id,
          turn_id,
          role,
          status,
          parts_json,
          raw_event_ids_json,
          imported_from_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, NULL, 'user', ?, '[{\"type\":\"markdown\",\"text\":\"hi\"}]', '[]', NULL, ?, ?)
      `
    )
    .run(id, appServerId, threadId, status, now, now);

  return id;
}

function insertTurn(
  app: TestBackend["app"],
  appServerId: string,
  threadId: string,
  messageId: string,
  status: "queued" | "running" | "waiting_approval",
  codexTurnId: string | null = null
): string {
  const now = Date.now();
  const id = `turn-${Math.random().toString(16).slice(2)}`;

  app.database.sqlite
    .prepare(
      `
        INSERT INTO turns (
          id,
          app_server_id,
          thread_id,
          codex_turn_id,
          trigger_message_id,
          status,
          started_at,
          completed_at,
          error,
          imported_from_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `
    )
    .run(id, appServerId, threadId, codexTurnId, messageId, status, now, now, now);

  return id;
}

function linkMessageToTurn(app: TestBackend["app"], messageId: string, turnId: string): void {
  app.database.sqlite
    .prepare("UPDATE messages SET turn_id = ?, updated_at = ? WHERE id = ?")
    .run(turnId, Date.now(), messageId);
}

function insertQueueItem(
  app: TestBackend["app"],
  appServerId: string,
  threadId: string,
  status: "pending" | "running" | "waiting_approval",
  messageId: string,
  turnId: string
): string {
  const now = Date.now();
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
        ) VALUES (?, ?, ?, 'send_message', ?, ?, NULL, NULL, ?, ?)
      `
    )
    .run(
      id,
      appServerId,
      threadId,
      status,
        JSON.stringify({
          messageId,
          turnId,
          codexThreadId: "codex-thread",
          text: "hello",
          attachments: []
        }),
      now,
      now
    );

  return id;
}

function insertApproval(
  app: TestBackend["app"],
  appServerId: string,
  threadId: string,
  turnId: string
): void {
  const now = Date.now();
  app.database.sqlite
    .prepare(
      `
        INSERT INTO approvals (
          id,
          app_server_id,
          thread_id,
          turn_id,
          codex_request_id,
          kind,
          status,
          request_json,
          response_json,
          error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'approval-1', 'turn/approval_required', 'pending', '{}', NULL, NULL, ?, ?)
      `
    )
    .run(`approval-${Math.random().toString(16).slice(2)}`, appServerId, threadId, turnId, now, now);
}

function readStatus(app: TestBackend["app"], table: "queue_items" | "turns" | "messages", id: string): string {
  const row = app.database.sqlite
    .prepare(`SELECT status FROM ${table} WHERE id = ?`)
    .get(id) as { status: string };
  return row.status;
}

function readApprovalStatus(app: TestBackend["app"], threadId: string): string {
  const row = app.database.sqlite
    .prepare("SELECT status FROM approvals WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(threadId) as { status: string };
  return row.status;
}
