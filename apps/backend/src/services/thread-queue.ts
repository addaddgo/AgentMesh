import { randomUUID } from "node:crypto";

import type { QueueItemDto, QueueItemKind, QueueItemStatus } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, RequestValidationError } from "../errors.js";
import type { EventService } from "./events.js";

export type QueueItemExecutionResult = {
  readonly status?: Extract<QueueItemStatus, "completed" | "waiting_approval"> | undefined;
  readonly result?: unknown;
};

export type QueueItemHandler = (
  item: QueueItemDto
) => Promise<QueueItemExecutionResult | void> | QueueItemExecutionResult | void;

export type ThreadQueueServiceOptions = {
  readonly handlers?: Partial<Record<QueueItemKind, QueueItemHandler>> | undefined;
};

export type EnqueueQueueItemInput = {
  readonly appServerId: string;
  readonly threadId: string;
  readonly kind: QueueItemKind;
  readonly payload: unknown;
};

type QueueItemRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly kind: QueueItemKind;
  readonly status: QueueItemStatus;
  readonly payload_json: string;
  readonly result_json: string | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
};

type AppServerRow = {
  readonly id: string;
  readonly status: string;
};

const ACTIVE_STATUSES: readonly QueueItemStatus[] = ["running", "waiting_approval"];

export class ThreadQueueService {
  private readonly activeThreads = new Set<string>();
  private readonly handlers: Partial<Record<QueueItemKind, QueueItemHandler>>;

  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService,
    options: ThreadQueueServiceOptions = {}
  ) {
    this.handlers = options.handlers ?? {};
  }

  public enqueue(input: EnqueueQueueItemInput): QueueItemDto {
    this.ensureThreadBelongsToAppServer(input.appServerId, input.threadId);

    if (input.kind === "send_message" && !this.isAppServerOnline(input.appServerId)) {
      return this.insertItem({
        ...input,
        status: "failed",
        error: "App server is offline"
      });
    }

    const item = this.insertItem({
      ...input,
      status: "pending",
      error: null
    });

    this.scheduleThread(input.threadId);
    return item;
  }

  public get(id: string): QueueItemDto {
    const row = this.findRow(id);

    if (row === undefined) {
      throw new NotFoundError("Queue item not found");
    }

    return toDto(row);
  }

  public listForThread(threadId: string): QueueItemDto[] {
    this.ensureThreadExists(threadId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM queue_items
          WHERE thread_id = ?
          ORDER BY created_at ASC, rowid ASC
        `
      )
      .all(threadId) as QueueItemRow[];

    return rows.map(toDto);
  }

  private scheduleThread(threadId: string): void {
    if (this.activeThreads.has(threadId)) {
      return;
    }

    this.activeThreads.add(threadId);
    queueMicrotask(() => {
      void this.drainThread(threadId);
    });
  }

  private async drainThread(threadId: string): Promise<void> {
    try {
      while (!this.hasActiveItem(threadId)) {
        const pending = this.nextPendingItem(threadId);

        if (pending === undefined) {
          return;
        }

        const running = this.updateItem(pending.id, {
          status: "running",
          result: null,
          error: null
        });

        try {
          const handler = this.handlers[running.kind];
          const output = handler === undefined ? undefined : await handler(running);
          const nextStatus = output?.status ?? "completed";

          this.updateItem(running.id, {
            status: nextStatus,
            result: output?.result ?? null,
            error: null
          });

          if (nextStatus === "waiting_approval") {
            return;
          }
        } catch (error) {
          this.updateItem(running.id, {
            status: "failed",
            result: null,
            error: errorMessage(error)
          });
        }
      }
    } finally {
      this.activeThreads.delete(threadId);
    }
  }

  private insertItem(input: {
    readonly appServerId: string;
    readonly threadId: string;
    readonly kind: QueueItemKind;
    readonly status: QueueItemStatus;
    readonly payload: unknown;
    readonly error: string | null;
  }): QueueItemDto {
    const now = Date.now();
    const id = randomUUID();

    this.database.sqlite
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
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `
      )
      .run(
        id,
        input.appServerId,
        input.threadId,
        input.kind,
        input.status,
        JSON.stringify(input.payload),
        input.error,
        now,
        now
      );

    const item = this.get(id);
    this.publishItemUpdated(item);
    return item;
  }

  private updateItem(
    id: string,
    input: {
      readonly status: QueueItemStatus;
      readonly result: unknown;
      readonly error: string | null;
    }
  ): QueueItemDto {
    const resultJson = input.result === null ? null : JSON.stringify(input.result);
    this.database.sqlite
      .prepare(
        `
          UPDATE queue_items
          SET status = ?, result_json = ?, error = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(input.status, resultJson, input.error, Date.now(), id);

    const item = this.get(id);
    this.publishItemUpdated(item);
    return item;
  }

  private hasActiveItem(threadId: string): boolean {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT 1
          FROM queue_items
          WHERE thread_id = ?
            AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})
          LIMIT 1
        `
      )
      .get(threadId, ...ACTIVE_STATUSES);

    return row !== undefined;
  }

  private nextPendingItem(threadId: string): QueueItemDto | undefined {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM queue_items
          WHERE thread_id = ? AND status = 'pending'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        `
      )
      .get(threadId) as QueueItemRow | undefined;

    return row === undefined ? undefined : toDto(row);
  }

  private findRow(id: string): QueueItemRow | undefined {
    return this.database.sqlite.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as
      | QueueItemRow
      | undefined;
  }

  private ensureThreadBelongsToAppServer(appServerId: string, threadId: string): void {
    const thread = this.database.sqlite
      .prepare("SELECT id, app_server_id FROM threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;

    if (thread === undefined) {
      throw new NotFoundError("Thread not found");
    }

    if (thread.app_server_id !== appServerId) {
      throw new RequestValidationError("Thread does not belong to app server");
    }
  }

  private ensureThreadExists(threadId: string): void {
    const thread = this.database.sqlite
      .prepare("SELECT id, app_server_id FROM threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;

    if (thread === undefined) {
      throw new NotFoundError("Thread not found");
    }
  }

  private isAppServerOnline(appServerId: string): boolean {
    const row = this.database.sqlite
      .prepare("SELECT id, status FROM app_servers WHERE id = ?")
      .get(appServerId) as AppServerRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row.status === "online";
  }

  private publishItemUpdated(item: QueueItemDto): void {
    this.events.publish({
      type: "queue.item_updated",
      appServerId: item.appServerId,
      threadId: item.threadId,
      payload: { item }
    });
  }
}

function toDto(row: QueueItemRow): QueueItemDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    kind: row.kind,
    status: row.status,
    payload: JSON.parse(row.payload_json) as unknown,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Queue item failed";
}
