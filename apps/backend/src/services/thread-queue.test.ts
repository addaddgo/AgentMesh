import { afterEach, describe, expect, it } from "vitest";

import type { QueueItemDto, SseEvent } from "@agentmesh/shared";

import { createTestBackend, type TestBackend } from "../test-helpers.js";
import { ThreadQueueService } from "./thread-queue.js";

const backends: TestBackend[] = [];

describe("thread queue service", () => {
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.cleanup()));
  });

  it("executes same-thread queue items strictly in insertion order with at most one active item", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app, "online");
    const threadId = insertThread(app, appServerId, "codex-thread-1");
    const firstGate = deferred<void>();
    const handlerCalls: string[] = [];

    const queue = new ThreadQueueService(app.database, app.events, {
      handlers: {
        read_thread: async (item) => {
          handlerCalls.push(item.id);

          if (handlerCalls.length === 1) {
            await firstGate.promise;
          }
        }
      }
    });

    const first = queue.enqueue({
      appServerId,
      threadId,
      kind: "read_thread",
      payload: { ordinal: 1 }
    });
    const second = queue.enqueue({
      appServerId,
      threadId,
      kind: "read_thread",
      payload: { ordinal: 2 }
    });

    await waitFor(() => handlerCalls.length === 1);
    expect(handlerCalls).toEqual([first.id]);
    expect(queue.get(first.id).status).toBe("running");
    expect(queue.get(second.id).status).toBe("pending");
    expect(countActiveItems(app, threadId)).toBe(1);

    firstGate.resolve(undefined);
    await waitFor(() => queue.get(second.id).status === "completed");

    expect(handlerCalls).toEqual([first.id, second.id]);
    expect(queue.listForThread(threadId).map((item) => item.status)).toEqual([
      "completed",
      "completed"
    ]);
  });

  it("does not serialize queue items globally across different threads", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app, "online");
    const firstThreadId = insertThread(app, appServerId, "codex-thread-1");
    const secondThreadId = insertThread(app, appServerId, "codex-thread-2");
    const release = deferred<void>();
    const startedThreadIds: string[] = [];

    const queue = new ThreadQueueService(app.database, app.events, {
      handlers: {
        read_thread: async (item) => {
          startedThreadIds.push(item.threadId);
          await release.promise;
        }
      }
    });

    const first = queue.enqueue({
      appServerId,
      threadId: firstThreadId,
      kind: "read_thread",
      payload: { thread: 1 }
    });
    const second = queue.enqueue({
      appServerId,
      threadId: secondThreadId,
      kind: "read_thread",
      payload: { thread: 2 }
    });

    await waitFor(() => startedThreadIds.length === 2);

    expect(new Set(startedThreadIds)).toEqual(new Set([firstThreadId, secondThreadId]));
    expect(queue.get(first.id).status).toBe("running");
    expect(queue.get(second.id).status).toBe("running");

    release.resolve(undefined);
    await waitFor(() => queue.get(first.id).status === "completed");
    await waitFor(() => queue.get(second.id).status === "completed");
  });

  it("persists queue item status transitions and emits queue.item_updated events", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app, "online");
    const threadId = insertThread(app, appServerId, "codex-thread-1");
    const events: SseEvent[] = [];
    app.events.subscribe((event) => {
      events.push(event);
    });

    const queue = new ThreadQueueService(app.database, app.events, {
      handlers: {
        approval_response: () => ({ result: { accepted: true } })
      }
    });
    const item = queue.enqueue({
      appServerId,
      threadId,
      kind: "approval_response",
      payload: { approvalId: "approval-1", response: "approve" }
    });

    await waitFor(() => queue.get(item.id).status === "completed");

    const persisted = app.database.sqlite
      .prepare("SELECT status, result_json, error FROM queue_items WHERE id = ?")
      .get(item.id) as { status: string; result_json: string; error: string | null };

    expect(persisted.status).toBe("completed");
    expect(JSON.parse(persisted.result_json)).toEqual({ accepted: true });
    expect(persisted.error).toBeNull();
    expect(queueEventsFor(events, item.id).map((event) => event.status)).toEqual([
      "pending",
      "running",
      "completed"
    ]);
  });

  it("fails send_message immediately when the app-server is offline and keeps the failed item visible", async () => {
    const { app } = await setup();
    const appServerId = insertAppServer(app, "offline");
    const threadId = insertThread(app, appServerId, "codex-thread-1");
    const events: SseEvent[] = [];
    let handlerCalled = false;
    app.events.subscribe((event) => {
      events.push(event);
    });

    const queue = new ThreadQueueService(app.database, app.events, {
      handlers: {
        send_message: () => {
          handlerCalled = true;
        }
      }
    });

    const item = queue.enqueue({
      appServerId,
      threadId,
      kind: "send_message",
      payload: { text: "Hello" }
    });
    await Promise.resolve();

    expect(handlerCalled).toBe(false);
    expect(queue.get(item.id)).toMatchObject({
      status: "failed",
      error: "App server is offline"
    });
    expect(queue.listForThread(threadId)).toMatchObject([
      {
        id: item.id,
        status: "failed",
        error: "App server is offline"
      }
    ]);
    expect(queueEventsFor(events, item.id).map((event) => event.status)).toEqual(["failed"]);
  });
});

async function setup(): Promise<TestBackend> {
  const backend = await createTestBackend();
  backends.push(backend);
  return backend;
}

function insertAppServer(app: TestBackend["app"], status: "online" | "offline"): string {
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
        ) VALUES (?, ?, 'local', 'localhost', NULL, NULL, ?, 'codex app-server', ?, NULL, ?, ?)
      `
    )
    .run(id, id, `/workspace/${id}`, status, now, now);

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

function countActiveItems(app: TestBackend["app"], threadId: string): number {
  const row = app.database.sqlite
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM queue_items
        WHERE thread_id = ? AND status IN ('running', 'waiting_approval')
      `
    )
    .get(threadId) as { count: number };

  return row.count;
}

function queueEventsFor(
  events: readonly SseEvent[],
  itemId: string
): { readonly status: string }[] {
  return events
    .filter((event) => event.type === "queue.item_updated")
    .map((event) => event.payload)
    .filter((payload): payload is { readonly item: QueueItemDto } => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "item" in payload &&
        (payload as { readonly item?: { readonly id?: string } }).item?.id === itemId
      );
    })
    .map((payload) => ({ status: payload.item.status }));
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for condition");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}
