import { randomUUID } from "node:crypto";

import type { ChatMessage, ChatMessageRole, MessagePart, ThreadDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, ProtocolError } from "../errors.js";
import type { JsonValue } from "./codex-json-rpc.js";
import type { EventService } from "./events.js";

type CodexRequester = {
  request<TResult extends JsonValue = JsonValue, TParams extends JsonValue = JsonValue>(
    method: string,
    params?: TParams
  ): Promise<TResult>;
};

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly codex_thread_id: string;
  readonly thread_name: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly cwd: string | null;
  readonly is_current: 0 | 1;
  readonly is_gone: 0 | 1;
  readonly imported_at: number | null;
  readonly last_seen_at: number | null;
  readonly raw_metadata_json: string;
  readonly created_at: number;
  readonly updated_at: number;
};

type MessageRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly role: ChatMessageRole;
  readonly status: ChatMessage["status"];
  readonly parts_json: string;
  readonly raw_event_ids_json: string;
  readonly created_at: number;
  readonly updated_at: number;
};

type ImportedTurn = {
  readonly codexTurnId: string | null;
  readonly messages: readonly ImportedMessage[];
  readonly createdAt: number;
};

type ImportedMessage = {
  readonly role: ChatMessageRole;
  readonly parts: readonly MessagePart[];
  readonly createdAt: number;
};

export class ThreadImportService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService
  ) {}

  public getThread(threadId: string): ThreadDto {
    return toThreadDto(this.findThread(threadId));
  }

  public listMessages(threadId: string): ChatMessage[] {
    this.findThread(threadId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM messages
          WHERE thread_id = ?
          ORDER BY created_at ASC, id ASC
        `
      )
      .all(threadId) as MessageRow[];

    return rows.map(toMessageDto);
  }

  public async importThread(
    threadId: string,
    requester: CodexRequester | undefined
  ): Promise<{
    readonly thread: ThreadDto;
    readonly imported: boolean;
    readonly messages: ChatMessage[];
  }> {
    const existing = this.findThread(threadId);

    if (existing.imported_at !== null) {
      return {
        thread: toThreadDto(existing),
        imported: false,
        messages: this.listMessages(threadId)
      };
    }

    if (requester === undefined) {
      throw new ProtocolError("Thread has not been imported and no Codex transport is available");
    }

    const raw = await requester.request("thread/read", { threadId: existing.codex_thread_id });
    const importedTurns = normalizeThreadRead(raw);
    const importId = randomUUID();
    const now = Date.now();

    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `
            INSERT INTO thread_imports (id, app_server_id, thread_id, raw_json, imported_at)
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(importId, existing.app_server_id, threadId, JSON.stringify(raw), now);

      for (const importedTurn of importedTurns) {
        const turnId = randomUUID();
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
              ) VALUES (?, ?, ?, ?, NULL, 'completed', ?, ?, NULL, ?, ?, ?)
            `
          )
          .run(
            turnId,
            existing.app_server_id,
            threadId,
            importedTurn.codexTurnId,
            importedTurn.createdAt,
            importedTurn.createdAt,
            importId,
            importedTurn.createdAt,
            now
          );

        for (const importedMessage of importedTurn.messages) {
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
                  imported_from_id,
                  created_at,
                  updated_at
                ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
              `
            )
            .run(
              randomUUID(),
              existing.app_server_id,
              threadId,
              turnId,
              importedMessage.role,
              JSON.stringify(importedMessage.parts),
              importId,
              importedMessage.createdAt,
              importedMessage.createdAt
            );
        }
      }

      this.database.sqlite
        .prepare("UPDATE threads SET imported_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, threadId);
    });

    transaction();

    const thread = this.getThread(threadId);
    const messages = this.listMessages(threadId);

    this.events.publish({
      type: "thread.imported",
      appServerId: thread.appServerId,
      threadId,
      payload: {
        thread,
        messageCount: messages.length
      }
    });

    return { thread, imported: true, messages };
  }

  private findThread(threadId: string): ThreadRow {
    const row = this.database.sqlite.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as
      | ThreadRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }

    return row;
  }
}

function normalizeThreadRead(raw: JsonValue): ImportedTurn[] {
  if (isRecord(raw)) {
    const turnItems = firstArray(raw.turns, raw.sessions);

    if (turnItems !== undefined) {
      return turnItems.map((turn, index) => normalizeTurnRecord(turn, index));
    }
  }

  const messageItems = extractMessageItems(raw);
  const messages = messageItems.map((message, index) => normalizeMessageRecord(message, index));

  if (messages.length === 0) {
    return [];
  }

  return [
    {
      codexTurnId: null,
      messages,
      createdAt: messages[0]?.createdAt ?? Date.now()
    }
  ];
}

function normalizeTurnRecord(value: JsonValue, index: number): ImportedTurn {
  if (!isRecord(value)) {
    throw new ProtocolError("Codex thread/read included an invalid turn record");
  }

  const messageItems = firstArray(value.messages, value.items, value.entries, value.events) ?? [];
  const messages = messageItems.map((message, messageIndex) =>
    normalizeMessageRecord(message, index * 1_000 + messageIndex)
  );
  const createdAt = firstTimestamp(
    value.startedAt,
    value.started_at,
    value.createdAt,
    value.created_at
  );

  return {
    codexTurnId: firstString(value.id, value.turnId, value.turn_id) ?? null,
    messages,
    createdAt: createdAt ?? messages[0]?.createdAt ?? Date.now() + index
  };
}

function extractMessageItems(raw: JsonValue): readonly JsonValue[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isRecord(raw)) {
    throw new ProtocolError("Codex thread/read returned an invalid response");
  }

  return firstArray(raw.messages, raw.items, raw.entries, raw.history, raw.data) ?? [];
}

function normalizeMessageRecord(value: JsonValue, index: number): ImportedMessage {
  if (typeof value === "string") {
    return {
      role: "assistant",
      parts: [{ type: "markdown", text: value }],
      createdAt: Date.now() + index
    };
  }

  if (!isRecord(value)) {
    return {
      role: "event",
      parts: [{ type: "event", eventType: "unsupported", raw: value }],
      createdAt: Date.now() + index
    };
  }

  return {
    role: normalizeRole(firstString(value.role, value.author, value.type)),
    parts: normalizeParts(value),
    createdAt:
      firstTimestamp(value.createdAt, value.created_at, value.timestamp, value.time) ??
      Date.now() + index
  };
}

function normalizeParts(record: Record<string, JsonValue | undefined>): MessagePart[] {
  const rawParts = firstArray(record.parts);

  if (rawParts !== undefined) {
    return rawParts.flatMap((part) => normalizePart(part));
  }

  const content = record.content;

  if (Array.isArray(content)) {
    return content.flatMap((part) => normalizePart(part));
  }

  const text = firstString(record.markdown, record.text, record.message, content);

  if (text !== undefined) {
    return [{ type: "markdown", text }];
  }

  return [
    {
      type: "event",
      eventType:
        firstString(record.type, record.kind, record.eventType, record.event_type) ?? "message",
      raw: record
    }
  ];
}

function normalizePart(value: JsonValue): MessagePart[] {
  if (typeof value === "string") {
    return [{ type: "markdown", text: value }];
  }

  if (!isRecord(value)) {
    return [{ type: "event", eventType: "unsupported_part", raw: value }];
  }

  const type = firstString(value.type, value.kind);
  const text = firstString(value.markdown, value.text, value.content);

  if (type === "image" || firstString(value.url, value.imageUrl, value.image_url) !== undefined) {
    const attachmentId = firstString(value.attachmentId, value.attachment_id);
    const workspacePath = firstString(value.workspacePath, value.workspace_path, value.localImage);
    const url = firstString(value.url, value.imageUrl, value.image_url, value.image);

    return [
      {
        type: "image",
        ...(attachmentId === undefined ? {} : { attachmentId }),
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(url === undefined ? {} : { url })
      }
    ];
  }

  if (type === "tool_call") {
    return [
      {
        type: "tool_call",
        toolName: firstString(value.toolName, value.tool_name, value.name) ?? "tool",
        callId: firstString(value.callId, value.call_id, value.id) ?? randomUUID(),
        input: value.input ?? value.arguments ?? null,
        status: firstString(value.status) ?? "completed"
      }
    ];
  }

  if (type === "tool_result") {
    return [
      {
        type: "tool_result",
        callId: firstString(value.callId, value.call_id, value.id) ?? randomUUID(),
        output: value.output ?? value.result ?? value.content ?? null,
        status: firstString(value.status) ?? "completed"
      }
    ];
  }

  if (type === "diff" && text !== undefined) {
    return [{ type: "diff", text }];
  }

  if (type === "approval") {
    return [
      {
        type: "approval",
        approvalId: firstString(value.approvalId, value.approval_id, value.id) ?? randomUUID(),
        kind: firstString(value.kind) ?? "approval",
        payload: value.payload ?? value,
        status: firstString(value.status) ?? "pending"
      }
    ];
  }

  if (type === "error") {
    return [{ type: "error", message: text ?? "Codex error", raw: value }];
  }

  if (text !== undefined) {
    return [{ type: "markdown", text }];
  }

  return [{ type: "event", eventType: type ?? "part", raw: value }];
}

function toThreadDto(row: ThreadRow): ThreadDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    codexThreadId: row.codex_thread_id,
    threadName: row.thread_name,
    title: row.title,
    status: row.status,
    cwd: row.cwd,
    isCurrent: row.is_current === 1,
    isGone: row.is_gone === 1,
    importedAt: row.imported_at,
    lastSeenAt: row.last_seen_at,
    rawMetadata: JSON.parse(row.raw_metadata_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessageDto(row: MessageRow): ChatMessage {
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

function normalizeRole(value: string | undefined): ChatMessageRole {
  switch (value) {
    case "user":
    case "assistant":
    case "tool":
    case "system":
    case "event":
      return value;
    case "function":
      return "tool";
    case "developer":
      return "system";
    default:
      return "event";
  }
}

function firstArray(
  ...values: readonly (JsonValue | undefined)[]
): readonly JsonValue[] | undefined {
  return values.find(Array.isArray);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function firstTimestamp(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Date.parse(value);

      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
