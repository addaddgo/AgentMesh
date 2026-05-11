import { randomUUID } from "node:crypto";

import type { ChatMessage, ChatMessageRole, MessagePart } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { CodexEventService } from "./codex-events.js";
import { normalizeCodexEventMessage } from "./message-normalization.js";

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

export type StoreCodexEventInput = {
  readonly appServerId: string;
  readonly threadId: string;
  readonly turnId?: string | null | undefined;
  readonly raw: unknown;
  readonly rawJsonText?: string | undefined;
  readonly eventType?: string | undefined;
};

export class MessageStorageService {
  private readonly codexEvents: CodexEventService;

  public constructor(private readonly database: DatabaseHandle) {
    this.codexEvents = new CodexEventService(database);
  }

  public storeCodexEventMessage(input: StoreCodexEventInput): ChatMessage {
    const normalized = normalizeCodexEventMessage(input.raw);
    const messageId = randomUUID();
    const createdAt = normalized.createdAt;
    const turnId = input.turnId ?? null;
    let eventId = "";

    const transaction = this.database.sqlite.transaction(() => {
      const event = this.codexEvents.store({
        appServerId: input.appServerId,
        threadId: input.threadId,
        turnId,
        eventType: input.eventType ?? normalized.eventType,
        raw: input.raw,
        rawJsonText: input.rawJsonText
      });
      eventId = event.id;

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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `
        )
        .run(
          messageId,
          input.appServerId,
          input.threadId,
          turnId,
          normalized.role,
          normalized.status,
          JSON.stringify(normalized.parts),
          JSON.stringify([event.id]),
          createdAt,
          createdAt
        );
    });

    transaction();

    return {
      id: messageId,
      appServerId: input.appServerId,
      threadId: input.threadId,
      turnId,
      role: normalized.role,
      status: normalized.status,
      parts: normalized.parts,
      rawEventIds: [eventId],
      createdAt,
      updatedAt: createdAt
    };
  }

  public listMessages(threadId: string): ChatMessage[] {
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
