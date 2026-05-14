import { randomUUID } from "node:crypto";

import type {
  PendingImageUploadDto,
  ScheduledMessageCreateRequest,
  ScheduledMessageDto,
  ScheduledMessageStatus,
  ScheduledMessageUpdateRequest,
  SendMessageResponse
} from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, OfflineError, RequestValidationError } from "../errors.js";
import type { EventService } from "./events.js";

type ScheduledMessageRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly run_at: number;
  readonly status: ScheduledMessageStatus;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly last_attempt_at: number | null;
  readonly sent_message_id: string | null;
  readonly sent_turn_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type ThreadLookupRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_name: string;
  readonly is_gone: number;
};

type AppServerLookupRow = {
  readonly id: string;
  readonly status: string;
};

type SendTextFn = (
  threadId: string,
  text: string,
  attachments?: readonly PendingImageUploadDto[]
) => SendMessageResponse;

const BACKEND_RESTART_ERROR = "Backend restarted before scheduled send completed";
const EDITABLE_STATUSES: readonly ScheduledMessageStatus[] = ["scheduled", "failed", "canceled"];

export class ScheduledMessageService {
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService,
    private readonly sendText: SendTextFn,
    private readonly pollIntervalMs = 1_000
  ) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollDueTasks().catch((error: unknown) => {
        console.error("[scheduled-messages] Failed to poll due tasks", error);
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public markInFlightFailedAfterBackendRestart(): number {
    const now = Date.now();
    const result = this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'failed',
              last_error = ?,
              updated_at = ?
          WHERE status = 'sending'
        `
      )
      .run(BACKEND_RESTART_ERROR, now);

    if (result.changes > 0) {
      for (const item of this.list()) {
        if (item.status === "failed" && item.lastError === BACKEND_RESTART_ERROR) {
          this.publishUpdated("failed", item);
        }
      }
    }

    return result.changes;
  }

  public list(): readonly ScheduledMessageDto[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM scheduled_messages
          WHERE status != 'acknowledged'
          ORDER BY
            CASE status
              WHEN 'scheduled' THEN 0
              WHEN 'sending' THEN 1
              WHEN 'failed' THEN 2
              WHEN 'sent' THEN 3
              WHEN 'canceled' THEN 4
              ELSE 5
            END ASC,
            run_at ASC,
            created_at DESC
        `
      )
      .all() as ScheduledMessageRow[];

    return rows.map(toScheduledMessageDto);
  }

  public get(id: string): ScheduledMessageDto {
    return toScheduledMessageDto(this.getRow(id));
  }

  public create(input: ScheduledMessageCreateRequest): ScheduledMessageDto {
    const thread = this.requireThread(input.threadId, input.appServerId);
    if (thread.is_gone === 1) {
      throw new RequestValidationError("Thread is gone and cannot receive scheduled messages");
    }

    const now = Date.now();
    const id = `sched_${randomUUID()}`;
    const text = input.text.trim();
    if (text.length === 0) {
      throw new RequestValidationError("Scheduled message text is required");
    }

    const runAt = now + input.delaySeconds * 1_000;

    this.database.sqlite
      .prepare(
        `
          INSERT INTO scheduled_messages (
            id,
            app_server_id,
            thread_id,
            text,
            run_at,
            status,
            attempt_count,
            last_error,
            last_attempt_at,
            sent_message_id,
            sent_turn_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'scheduled', 0, NULL, NULL, NULL, NULL, ?, ?)
        `
      )
      .run(id, input.appServerId, input.threadId, text, runAt, now, now);

    const item = this.get(id);
    this.publishUpdated("created", item);
    return item;
  }

  public update(id: string, input: ScheduledMessageUpdateRequest): ScheduledMessageDto {
    const existing = this.getRow(id);
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      throw new RequestValidationError(`Scheduled message cannot be edited while ${existing.status}`);
    }

    const nextAppServerId = input.appServerId ?? existing.app_server_id;
    const nextThreadId = input.threadId ?? existing.thread_id;
    const thread = this.requireThread(nextThreadId, nextAppServerId);
    if (thread.is_gone === 1) {
      throw new RequestValidationError("Thread is gone and cannot receive scheduled messages");
    }

    const nextText = (input.text ?? existing.text).trim();
    if (nextText.length === 0) {
      throw new RequestValidationError("Scheduled message text is required");
    }

    const delaySeconds =
      input.delaySeconds ??
      Math.max(0, Math.ceil((existing.run_at - Date.now()) / 1_000));
    const now = Date.now();
    const runAt = now + delaySeconds * 1_000;

    this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET app_server_id = ?,
              thread_id = ?,
              text = ?,
              run_at = ?,
              status = 'scheduled',
              last_error = NULL,
              sent_message_id = NULL,
              sent_turn_id = NULL,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(nextAppServerId, nextThreadId, nextText, runAt, now, id);

    const item = this.get(id);
    this.publishUpdated("updated", item);
    return item;
  }

  public cancel(id: string): ScheduledMessageDto {
    const existing = this.getRow(id);
    if (existing.status !== "scheduled") {
      throw new RequestValidationError("Only scheduled messages can be canceled");
    }

    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'canceled',
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(now, id);

    const item = this.get(id);
    this.publishUpdated("canceled", item);
    return item;
  }

  public acknowledge(id: string): ScheduledMessageDto {
    const existing = this.getRow(id);
    if (existing.status !== "sent") {
      throw new RequestValidationError("Only sent messages can be acknowledged");
    }

    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'acknowledged',
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(now, id);

    const item = this.get(id);
    this.publishUpdated("acknowledged", item);
    return item;
  }

  public delete(id: string): void {
    const existing = this.getRow(id);
    if (existing.status === "sending") {
      throw new RequestValidationError("Scheduled message cannot be deleted while sending");
    }

    this.database.sqlite.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(id);
    this.events.publish({
      type: "scheduled_message.updated",
      payload: {
        action: "deleted",
        id
      }
    });
  }

  public async pollDueTasks(now = Date.now()): Promise<void> {
    const dueRows = this.database.sqlite
      .prepare(
        `
          SELECT id
          FROM scheduled_messages
          WHERE status = 'scheduled'
            AND run_at <= ?
          ORDER BY run_at ASC, created_at ASC
        `
      )
      .all(now) as Array<{ readonly id: string }>;

    for (const row of dueRows) {
      await this.runDueTask(row.id);
    }
  }

  public async runDueTask(id: string): Promise<ScheduledMessageDto> {
    const claimTime = Date.now();
    const claim = this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              last_attempt_at = ?,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
            AND status = 'scheduled'
        `
      )
      .run(claimTime, claimTime, id);

    const current = this.getRow(id);
    if (claim.changes === 0) {
      return toScheduledMessageDto(current);
    }

    this.publishUpdated("sending", toScheduledMessageDto(current));

    try {
      const thread = this.requireThread(current.thread_id, current.app_server_id);
      if (thread.is_gone === 1) {
        throw new RequestValidationError("Thread is gone");
      }

      const appServer = this.getAppServer(current.app_server_id);
      if (appServer.status !== "online") {
        throw new OfflineError("App server is offline");
      }

      const response = this.sendText(current.thread_id, current.text, []);
      return this.markSent(id, response);
    } catch (error) {
      return this.markFailed(id, toErrorMessage(error));
    }
  }

  private markSent(id: string, response: SendMessageResponse): ScheduledMessageDto {
    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'sent',
              sent_message_id = ?,
              sent_turn_id = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(response.message.id, response.turn.id, now, id);

    const item = this.get(id);
    this.publishUpdated("sent", item);
    return item;
  }

  private markFailed(id: string, lastError: string): ScheduledMessageDto {
    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          UPDATE scheduled_messages
          SET status = 'failed',
              last_error = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(lastError, now, id);

    const item = this.get(id);
    this.publishUpdated("failed", item);
    return item;
  }

  private publishUpdated(action: string, item: ScheduledMessageDto): void {
    this.events.publish({
      type: "scheduled_message.updated",
      appServerId: item.appServerId,
      threadId: item.threadId,
      payload: { action, item }
    });
  }

  private getRow(id: string): ScheduledMessageRow {
    const row = this.database.sqlite
      .prepare("SELECT * FROM scheduled_messages WHERE id = ?")
      .get(id) as ScheduledMessageRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("Scheduled message not found");
    }

    return row;
  }

  private requireThread(threadId: string, appServerId: string): ThreadLookupRow {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT id, app_server_id, thread_name, is_gone
          FROM threads
          WHERE id = ?
        `
      )
      .get(threadId) as ThreadLookupRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }
    if (row.app_server_id !== appServerId) {
      throw new RequestValidationError("Thread does not belong to the selected app server");
    }

    return row;
  }

  private getAppServer(appServerId: string): AppServerLookupRow {
    const row = this.database.sqlite
      .prepare("SELECT id, status FROM app_servers WHERE id = ?")
      .get(appServerId) as AppServerLookupRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row;
  }
}

function toScheduledMessageDto(row: ScheduledMessageRow): ScheduledMessageDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    text: row.text,
    runAt: row.run_at,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    sentMessageId: row.sent_message_id,
    sentTurnId: row.sent_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Scheduled send failed";
}
