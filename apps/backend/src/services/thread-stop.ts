import type {
  ChatMessage,
  MessagePart,
  ThreadStopResponse,
  TurnDto
} from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import { ApprovalService } from "./approvals.js";
import { type JsonValue } from "./codex-json-rpc.js";
import type { EventService } from "./events.js";
import { ThreadQueueService } from "./thread-queue.js";

const STOPPED_BY_USER = "Stopped by user";
const TURN_STOP_METHODS = ["turn/cancel", "turn/stop", "turn/abort"] as const;

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly codex_thread_id: string;
};

type TurnRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly codex_turn_id: string | null;
  readonly trigger_message_id: string | null;
  readonly status: TurnDto["status"];
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type MessageRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly role: ChatMessage["role"];
  readonly status: ChatMessage["status"];
  readonly parts_json: string;
  readonly raw_event_ids_json: string;
  readonly created_at: number;
  readonly updated_at: number;
};

export class ThreadStopService {
  private readonly approvals: ApprovalService;
  private readonly queue: ThreadQueueService;

  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService,
    private readonly appServerLifecycle: AppServerLifecycleRegistry,
    queue?: ThreadQueueService
  ) {
    this.approvals = new ApprovalService(database, events);
    this.queue = queue ?? new ThreadQueueService(database, events);
  }

  public async stop(threadId: string): Promise<ThreadStopResponse> {
    const thread = this.getThread(threadId);
    const stoppedPendingItems = this.queue.failPendingForThread(threadId, STOPPED_BY_USER);

    for (const item of stoppedPendingItems) {
      this.failTurnAndMessageForQueueItem(item.payload, item.updatedAt);
    }

    this.approvals.markPendingForThreadFailed(threadId, STOPPED_BY_USER);

    const activeItem = this.queue.getActiveForThread(threadId);
    const activeTurn = this.findActiveTurn(threadId);
    let transportStopAttempted = false;
    let transportStopAccepted = false;

    if (activeItem?.status === "waiting_approval") {
      this.queue.failItem(activeItem.id, STOPPED_BY_USER);
      if (activeTurn !== null) {
        this.failTurn(activeTurn.id, activeTurn.codex_turn_id, STOPPED_BY_USER);
      }
    } else if (activeItem?.status === "running" && activeTurn !== null) {
      transportStopAttempted = true;
      transportStopAccepted = await this.attemptTurnStop(thread, activeTurn);
      if (transportStopAccepted) {
        this.queue.failItem(activeItem.id, STOPPED_BY_USER);
        this.failTurn(activeTurn.id, activeTurn.codex_turn_id, STOPPED_BY_USER);
      }
    }

    return {
      threadId,
      stoppedQueueItemIds: stoppedPendingItems.map((item) => item.id),
      runningQueueItemId: activeItem?.id ?? null,
      runningTurnId: activeTurn?.id ?? null,
      transportStopAttempted,
      transportStopAccepted
    };
  }

  private async attemptTurnStop(thread: ThreadRow, turn: TurnRow): Promise<boolean> {
    let transport: ReturnType<AppServerLifecycleRegistry["getTransport"]>;
    try {
      transport = this.appServerLifecycle.getTransport(thread.app_server_id);
    } catch {
      return false;
    }
    const params = withDefinedValues({
      threadId: thread.codex_thread_id,
      turnId: turn.codex_turn_id ?? undefined
    });

    for (const method of TURN_STOP_METHODS) {
      try {
        await transport.request(method, params, 1_500);
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private getThread(threadId: string): ThreadRow {
    const row = this.database.sqlite
      .prepare("SELECT id, app_server_id, codex_thread_id FROM threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }

    return row;
  }

  private findActiveTurn(threadId: string): TurnRow | null {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM turns
          WHERE thread_id = ?
            AND status IN ('queued', 'running', 'waiting_approval')
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `
      )
      .get(threadId) as TurnRow | undefined;

    return row ?? null;
  }

  private failTurnAndMessageForQueueItem(payload: unknown, completedAt: number): void {
    if (payload === null || typeof payload !== "object") {
      return;
    }

    const turnId = typeof (payload as { turnId?: unknown }).turnId === "string"
      ? (payload as { turnId: string }).turnId
      : null;
    const messageId = typeof (payload as { messageId?: unknown }).messageId === "string"
      ? (payload as { messageId: string }).messageId
      : null;

    if (turnId !== null) {
      this.failTurn(turnId, undefined, STOPPED_BY_USER, completedAt);
    }
    if (messageId !== null) {
      this.failMessage(messageId, completedAt);
    }
  }

  private failTurn(
    turnId: string,
    codexTurnId: string | null | undefined,
    error: string,
    completedAt = Date.now()
  ): void {
    const current = this.getTurn(turnId);
    this.database.sqlite
      .prepare(
        `
          UPDATE turns
          SET status = 'failed',
              codex_turn_id = ?,
              completed_at = ?,
              error = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        codexTurnId === undefined ? current.codexTurnId : codexTurnId,
        completedAt,
        error,
        completedAt,
        turnId
      );

    const updated = this.getTurn(turnId);
    this.events.publish({
      type: "turn.status_changed",
      appServerId: updated.appServerId,
      threadId: updated.threadId,
      payload: { turn: updated }
    });

    if (updated.triggerMessageId !== null) {
      this.failMessage(updated.triggerMessageId, completedAt);
    }
  }

  private failMessage(messageId: string, updatedAt = Date.now()): void {
    const current = this.getMessage(messageId);
    if (current.status === "completed" || current.status === "failed") {
      return;
    }

    this.database.sqlite
      .prepare("UPDATE messages SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(updatedAt, messageId);

    const updated = this.getMessage(messageId);
    this.events.publish({
      type: "thread.message_updated",
      appServerId: updated.appServerId,
      threadId: updated.threadId,
      payload: { message: updated }
    });
  }

  private getTurn(id: string): TurnDto {
    const row = this.database.sqlite.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | TurnRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Turn not found");
    }

    return toTurn(row);
  }

  private getMessage(id: string): ChatMessage {
    const row = this.database.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | MessageRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Message not found");
    }

    return toMessage(row);
  }
}

function toTurn(row: TurnRow): TurnDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    codexTurnId: row.codex_turn_id,
    triggerMessageId: row.trigger_message_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role,
    status: row.status,
    parts: JSON.parse(row.parts_json) as MessagePart[],
    rawEventIds: JSON.parse(row.raw_event_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function withDefinedValues(input: Record<string, JsonValue | undefined>): JsonValue {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
  );
}
