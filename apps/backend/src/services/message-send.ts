import { randomUUID } from "node:crypto";

import type {
  ChatMessage,
  ImageAttachmentDto,
  MessagePart,
  QueueItemDto,
  SendMessageResponse,
  TurnDto,
  TurnStatus
} from "@agentmesh/shared";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, OfflineError, RequestValidationError } from "../errors.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import type { JsonValue } from "./codex-json-rpc.js";
import type { EventService } from "./events.js";
import type { ThreadStatusCache } from "./thread-status-cache.js";
import {
  ImageUploadService,
  MAX_IMAGES_PER_MESSAGE,
  type WorkspaceCopyTarget
} from "./image-uploads.js";
import { CodexEventService } from "./codex-events.js";
import { MessageStorageService } from "./message-storage.js";
import { ThreadQueueService } from "./thread-queue.js";

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly codex_thread_id: string;
  readonly is_current: 0 | 1;
  readonly is_gone: 0 | 1;
  readonly app_server_status: string;
  readonly host_kind: "local" | "ssh";
  readonly host: string;
  readonly ssh_user: string | null;
  readonly ssh_port: number | null;
  readonly workspace: string;
  readonly thread_status: string | null;
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

type TurnRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly codex_turn_id: string | null;
  readonly trigger_message_id: string | null;
  readonly status: TurnStatus;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type ThreadSettingsRow = {
  readonly model: string | null;
  readonly effort: string | null;
  readonly approval_policy_json: string | null;
  readonly sandbox_policy_json: string | null;
  readonly collaboration_mode_json: string | null;
};

type SendPayload = {
  readonly messageId: string;
  readonly turnId: string;
  readonly codexThreadId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
};

type TurnCompletion = {
  readonly status: Extract<TurnStatus, "completed" | "failed">;
  readonly error: string | null;
};

export class MessageSendService {
  private readonly messages: MessageStorageService;
  private readonly codexEvents: CodexEventService;
  private readonly uploads: ImageUploadService;
  private readonly queue: ThreadQueueService;

  public constructor(
    private readonly database: DatabaseHandle,
    private readonly config: BackendConfig,
    private readonly events: EventService,
    private readonly appServerLifecycle: AppServerLifecycleRegistry,
    private readonly statusCache: ThreadStatusCache
  ) {
    this.messages = new MessageStorageService(database);
    this.codexEvents = new CodexEventService(database);
    this.uploads = new ImageUploadService(database, config);
    this.queue = new ThreadQueueService(database, events, {
      handlers: {
        send_message: (item) => this.executeSend(item)
      }
    });
  }

  public sendText(
    threadId: string,
    text: string,
    attachmentIds: readonly string[] = []
  ): SendMessageResponse {
    const normalizedText = text.trim();
    const uniqueAttachmentIds = [...new Set(attachmentIds)];

    if (attachmentIds.length > MAX_IMAGES_PER_MESSAGE) {
      throw new RequestValidationError("A message can include at most 5 images");
    }

    if (uniqueAttachmentIds.length !== attachmentIds.length) {
      throw new RequestValidationError("Duplicate image attachments are not allowed");
    }

    if (normalizedText.length === 0 && attachmentIds.length === 0) {
      throw new RequestValidationError("Message text or image attachment is required");
    }

    const thread = this.getSendableThread(threadId);
    const attachments = this.uploads.getMany(attachmentIds);

    if (thread.app_server_status !== "online") {
      const failed = this.createUserTurnAndMessage(
        thread,
        normalizedText,
        attachments,
        "failed",
        "failed"
      );
      this.updateTurn(failed.turn.id, {
        status: "failed",
        completedAt: Date.now(),
        error: "App server is offline"
      });
      this.publishMessage("thread.message_added", failed.message);
      this.publishTurn(this.getTurn(failed.turn.id));
      throw new OfflineError();
    }

    const created = this.createUserTurnAndMessage(
      thread,
      normalizedText,
      attachments,
      "queued",
      "queued"
    );
    this.publishMessage("thread.message_added", created.message);
    this.publishTurn(created.turn);

    const queueItem = this.queue.enqueue({
      appServerId: thread.app_server_id,
      threadId: thread.id,
      kind: "send_message",
      payload: {
        messageId: created.message.id,
        turnId: created.turn.id,
        codexThreadId: thread.codex_thread_id,
        text: normalizedText,
        attachmentIds: attachments.map((attachment) => attachment.id)
      } satisfies SendPayload
    });

    return {
      message: this.getMessage(created.message.id),
      turn: this.getTurn(created.turn.id),
      queueItem
    };
  }

  private async executeSend(item: QueueItemDto): Promise<{ readonly result: unknown }> {
    const payload = parseSendPayload(item.payload);
    const message = this.getMessage(payload.messageId);
    const turn = this.getTurn(payload.turnId);
    const startedAt = Date.now();

    this.updateTurn(turn.id, { status: "running", startedAt, error: null });
    this.updateMessage(message.id, "sent");

    let input: readonly JsonValue[];
    try {
      input = this.buildCodexInput(payload);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Image copy failed";
      this.updateTurn(turn.id, {
        status: "failed",
        completedAt: Date.now(),
        error: messageText
      });
      this.updateMessage(message.id, "failed");
      throw error;
    }

    const transport = this.appServerLifecycle.getTransport(item.appServerId);
    let codexTurnId: string | null = null;
    let finishTurn: ((result: TurnCompletion) => void) | null = null;
    const turnCompleted = new Promise<TurnCompletion>((resolve) => {
      finishTurn = resolve;
    });
    const unsubscribe = transport.onAnyNotification((_params, notification, rawLine) => {
      if (!notificationMatchesTurn(notification, payload.codexThreadId, codexTurnId)) {
        return;
      }

      this.updateMessage(message.id, "streaming");
      if (shouldRenderNotification(notification)) {
        this.storeCodexObservedJson(item, turn.id, notification, rawLine);
      } else {
        this.storeCodexObservedEvent(item, turn.id, notification, rawLine, notification.method);
      }

      const completion = extractTurnCompletion(notification);
      if (completion !== null) {
        finishTurn?.(completion);
      }
    });

    try {
      const result = await this.startTurnWithLoadedThread(transport, item, turn.id, payload, input);
      codexTurnId = extractCodexTurnId(result);

      this.updateTurn(turn.id, {
        status: "running",
        codexTurnId,
        error: null
      });
      this.updateMessage(message.id, "streaming");

      const completion = isCompletedTurnStartResult(result)
        ? ({ status: "completed", error: null } satisfies TurnCompletion)
        : await withTimeout(turnCompleted, 20 * 60_000);

      unsubscribe();

      this.updateTurn(turn.id, {
        status: completion.status,
        codexTurnId,
        completedAt: Date.now(),
        error: completion.error
      });
      this.updateMessage(message.id, completion.status === "failed" ? "failed" : "completed");

      return { result };
    } catch (error) {
      unsubscribe();
      const messageText = error instanceof Error ? error.message : "Message send failed";
      this.updateTurn(turn.id, {
        status: "failed",
        completedAt: Date.now(),
        error: messageText
      });
      this.updateMessage(message.id, "failed");
      throw error;
    }
  }

  private getSendableThread(threadId: string): ThreadRow {
    const thread = this.database.sqlite
      .prepare(
        `
          SELECT
            threads.id,
            threads.app_server_id,
            threads.codex_thread_id,
            threads.is_current,
            threads.is_gone,
            threads.status AS thread_status,
            app_servers.status AS app_server_status,
            app_servers.host_kind,
            app_servers.host,
            app_servers.ssh_user,
            app_servers.ssh_port,
            app_servers.workspace
          FROM threads
          INNER JOIN app_servers ON app_servers.id = threads.app_server_id
          WHERE threads.id = ?
        `
      )
      .get(threadId) as ThreadRow | undefined;

    if (thread === undefined) {
      throw new NotFoundError("Thread not found");
    }

    if (thread.is_gone === 1) {
      throw new RequestValidationError("Cannot send to a gone thread");
    }

    if (thread.is_current !== 1) {
      throw new RequestValidationError("Cannot send to a non-current thread");
    }

    if (thread.thread_status === "notLoaded") {
      throw new RequestValidationError("Thread is not loaded. Resume it before sending.");
    }

    return thread;
  }

  private createUserTurnAndMessage(
    thread: ThreadRow,
    text: string,
    attachments: readonly ImageAttachmentDto[],
    messageStatus: ChatMessage["status"],
    turnStatus: TurnStatus
  ): { readonly message: ChatMessage; readonly turn: TurnDto } {
    const now = Date.now();
    const messageId = randomUUID();
    const turnId = randomUUID();
    const parts: MessagePart[] = [];

    if (text.length > 0) {
      parts.push({ type: "markdown", text });
    }

    parts.push(
      ...attachments.map((attachment) => ({
        type: "image" as const,
        attachmentId: attachment.id,
        workspacePath: pathForAttachment(thread.workspace, attachment.filename)
      }))
    );

    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
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
            ) VALUES (?, ?, ?, NULL, 'user', ?, ?, '[]', NULL, ?, ?)
          `
        )
        .run(
          messageId,
          thread.app_server_id,
          thread.id,
          messageStatus,
          JSON.stringify(parts),
          now,
          now
        );

      this.database.sqlite
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
            ) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
          `
        )
        .run(turnId, thread.app_server_id, thread.id, messageId, turnStatus, now, now);

      this.database.sqlite
        .prepare("UPDATE messages SET turn_id = ?, updated_at = ? WHERE id = ?")
        .run(turnId, now, messageId);

      const insertMessageAttachment = this.database.sqlite.prepare(
        "INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)"
      );

      for (const attachment of attachments) {
        insertMessageAttachment.run(messageId, attachment.id);
      }
    });

    transaction();

    return { message: this.getMessage(messageId), turn: this.getTurn(turnId) };
  }

  private storeCodexObservedJson(
    item: QueueItemDto,
    turnId: string,
    raw: unknown,
    rawJsonText: string,
    eventType?: string
  ): void {
    const message = this.messages.storeCodexEventMessage({
      appServerId: item.appServerId,
      threadId: item.threadId,
      turnId,
      raw,
      rawJsonText,
      eventType
    });
    this.publishMessage("thread.message_added", message);
  }

  private storeCodexObservedEvent(
    item: QueueItemDto,
    turnId: string,
    raw: unknown,
    rawJsonText: string,
    eventType: string
  ): void {
    this.codexEvents.store({
      appServerId: item.appServerId,
      threadId: item.threadId,
      turnId,
      raw,
      rawJsonText,
      eventType
    });
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

  private getTurn(id: string): TurnDto {
    const row = this.database.sqlite.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      | TurnRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Turn not found");
    }

    return toTurn(row);
  }

  private updateMessage(id: string, status: ChatMessage["status"]): ChatMessage {
    this.database.sqlite
      .prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);

    const message = this.getMessage(id);
    this.publishMessage("thread.message_updated", message);
    return message;
  }

  private updateTurn(
    id: string,
    input: {
      readonly status: TurnStatus;
      readonly codexTurnId?: string | null | undefined;
      readonly startedAt?: number | null | undefined;
      readonly completedAt?: number | null | undefined;
      readonly error?: string | null | undefined;
    }
  ): TurnDto {
    const current = this.getTurn(id);
    this.database.sqlite
      .prepare(
        `
          UPDATE turns
          SET
            status = ?,
            codex_turn_id = ?,
            started_at = ?,
            completed_at = ?,
            error = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.status,
        input.codexTurnId === undefined ? current.codexTurnId : input.codexTurnId,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.completedAt === undefined ? current.completedAt : input.completedAt,
        input.error === undefined ? current.error : input.error,
        Date.now(),
        id
      );

    const turn = this.getTurn(id);
    this.publishTurn(turn);
    return turn;
  }

  private publishMessage(
    type: "thread.message_added" | "thread.message_updated",
    message: ChatMessage
  ): void {
    this.events.publish({
      type,
      appServerId: message.appServerId,
      threadId: message.threadId,
      payload: { message }
    });
  }

  private publishTurn(turn: TurnDto): void {
    this.events.publish({
      type: "turn.status_changed",
      appServerId: turn.appServerId,
      threadId: turn.threadId,
      payload: { turn }
    });
  }

  private buildCodexInput(payload: SendPayload): readonly JsonValue[] {
    const thread = this.getSendableThread(this.getMessage(payload.messageId).threadId);
    const target: WorkspaceCopyTarget = {
      hostKind: thread.host_kind,
      host: thread.host,
      sshUser: thread.ssh_user,
      sshPort: thread.ssh_port,
      workspace: thread.workspace
    };
    const input: JsonValue[] = [];

    if (payload.text.length > 0) {
      input.push({ type: "text", text: payload.text });
    }

    for (const attachment of this.uploads.getMany(payload.attachmentIds)) {
      const copied = this.uploads.copyToWorkspace(attachment, target);
      input.push({ type: "localImage", path: copied.workspacePath });
    }

    return input;
  }

  private async startTurnWithLoadedThread(
    transport: ReturnType<AppServerLifecycleRegistry["getTransport"]>,
    item: QueueItemDto,
    turnId: string,
    payload: SendPayload,
    input: readonly JsonValue[]
  ): Promise<JsonValue> {
    return transport.requestObserved(
      "turn/start",
      withDefinedValues({
        threadId: payload.codexThreadId,
        input,
        ...this.getThreadSettings(item.threadId)
      }) satisfies JsonValue,
      (response, rawLine, method) => {
        this.storeCodexObservedEvent(item, turnId, response, rawLine, `${method}.response`);
      }
    );
  }

  private getThreadSettings(threadId: string): Record<string, JsonValue | undefined> {
    const row = this.database.sqlite
      .prepare("SELECT * FROM thread_settings WHERE thread_id = ?")
      .get(threadId) as ThreadSettingsRow | undefined;

    if (row === undefined) {
      return {};
    }

    return {
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      approvalPolicy: parseJsonValue(row.approval_policy_json),
      sandboxPolicy: parseJsonValue(row.sandbox_policy_json),
      collaborationMode: parseJsonValue(row.collaboration_mode_json)
    };
  }
}

function withDefinedValues(input: Record<string, JsonValue | undefined>): JsonValue {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
  );
}

function parseJsonValue(value: string | null): JsonValue | undefined {
  return value === null ? undefined : (JSON.parse(value) as JsonValue);
}

function notificationMatchesTurn(
  notification: unknown,
  codexThreadId: string,
  codexTurnId: string | null
): boolean {
  if (!isRecord(notification)) {
    return false;
  }

  const params = isRecord(notification.params) ? notification.params : {};
  const threadId = firstString(params.threadId, params.thread_id);
  const turnId = firstString(params.turnId, params.turn_id);

  if (threadId !== undefined && threadId !== codexThreadId) {
    return false;
  }

  return codexTurnId === null || turnId === undefined || turnId === codexTurnId;
}

function shouldRenderNotification(notification: unknown): boolean {
  if (!isRecord(notification)) {
    return false;
  }

  const method = firstString(notification.method)?.toLowerCase() ?? "";
  const params = isRecord(notification.params) ? notification.params : {};
  const item = params.item;
  const itemType = isRecord(item) ? firstString(item.type)?.toLowerCase() : undefined;

  if (method === "thread/message") {
    return true;
  }

  if (method.includes("item") && method.includes("completed")) {
    return itemType === "agentmessage" || itemType === "plan" || itemType?.includes("tool") === true;
  }

  if (method.includes("rawresponseitem") && method.includes("completed")) {
    return true;
  }

  return false;
}

function extractTurnCompletion(notification: unknown): TurnCompletion | null {
  if (!isRecord(notification)) {
    return null;
  }

  const method = firstString(notification.method)?.toLowerCase() ?? "";
  const params = isRecord(notification.params) ? notification.params : {};
  const turn = isRecord(params.turn) ? params.turn : {};
  const status = firstString(turn.status, params.status)?.toLowerCase();
  const error = turn.error ?? params.error;

  if (method === "error" && isTerminalCodexError(params)) {
    return {
      status: "failed",
      error: stringifyError(error ?? "Codex turn failed")
    };
  }

  if (
    method.includes("turn") &&
    (method.includes("completed") || status === "completed" || status === "failed")
  ) {
    return {
      status: status === "failed" || error != null ? "failed" : "completed",
      error: error == null ? null : stringifyError(error)
    };
  }

  return null;
}

function isTerminalCodexError(params: Record<string, unknown>): boolean {
  if (params.willRetry === false) {
    return true;
  }

  const error = isRecord(params.error) ? params.error : {};
  const message = firstString(error.message, params.message)?.toLowerCase();
  if (message === undefined) {
    return false;
  }

  const reconnecting = /reconnecting\.\.\.\s*(\d+)\/(\d+)/u.exec(message);
  return reconnecting !== null && reconnecting[1] === reconnecting[2];
}

function isCompletedTurnStartResult(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }

  const turn = isRecord(result.turn) ? result.turn : {};
  const status = firstString(result.status, turn.status)?.toLowerCase();
  return status === "completed" || status === "failed";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Codex turn did not complete within ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function parseSendPayload(payload: unknown): SendPayload {
  if (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as SendPayload).messageId === "string" &&
    typeof (payload as SendPayload).turnId === "string" &&
    typeof (payload as SendPayload).codexThreadId === "string" &&
    typeof (payload as SendPayload).text === "string" &&
    Array.isArray((payload as SendPayload).attachmentIds) &&
    (payload as SendPayload).attachmentIds.every((id) => typeof id === "string")
  ) {
    return payload as SendPayload;
  }

  throw new RequestValidationError("Invalid send queue payload");
}

function stringifyError(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return JSON.stringify(value);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathForAttachment(workspace: string, filename: string): string {
  return `${workspace.replace(/\/+$/, "")}/.agentmesh/images/${filename}`;
}

function extractCodexTurnId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const turn = record.turn;
  if (typeof record.id === "string") {
    return record.id;
  }

  if (typeof record.turnId === "string") {
    return record.turnId;
  }

  if (typeof record.turn_id === "string") {
    return record.turn_id;
  }

  if (
    typeof turn === "object" &&
    turn !== null &&
    typeof (turn as { id?: unknown }).id === "string"
  ) {
    return (turn as { id: string }).id;
  }

  return null;
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
