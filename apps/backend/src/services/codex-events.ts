import { randomUUID } from "node:crypto";

import type { CodexEventDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError } from "../errors.js";

type CodexEventRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly event_type: string;
  readonly raw_json: string;
  readonly created_at: number;
};

export type StoreCodexEventInput = {
  readonly appServerId: string;
  readonly threadId?: string | null | undefined;
  readonly turnId?: string | null | undefined;
  readonly eventType: string;
  readonly raw: unknown;
  readonly rawJsonText?: string | undefined;
  readonly createdAt?: number | undefined;
};

export type ListCodexEventsInput = {
  readonly limit: number;
};

export class CodexEventService {
  public constructor(private readonly database: DatabaseHandle) {}

  public store(input: StoreCodexEventInput): CodexEventDto {
    const event: CodexEventDto = {
      id: randomUUID(),
      appServerId: input.appServerId,
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      eventType: input.eventType,
      rawJson: input.rawJsonText ?? JSON.stringify(input.raw),
      createdAt: input.createdAt ?? Date.now()
    };

    this.database.sqlite
      .prepare(
        `
          INSERT INTO codex_events (id, app_server_id, thread_id, turn_id, event_type, raw_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        event.id,
        event.appServerId,
        event.threadId,
        event.turnId,
        event.eventType,
        event.rawJson,
        event.createdAt
      );

    return event;
  }

  public listForAppServer(appServerId: string, input: ListCodexEventsInput): CodexEventDto[] {
    this.ensureAppServerExists(appServerId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM codex_events
          WHERE app_server_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `
      )
      .all(appServerId, input.limit) as CodexEventRow[];

    return rows.map(toDto);
  }

  public listForThread(threadId: string, input: ListCodexEventsInput): CodexEventDto[] {
    this.ensureThreadExists(threadId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM codex_events
          WHERE thread_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `
      )
      .all(threadId, input.limit) as CodexEventRow[];

    return rows.map(toDto);
  }

  private ensureAppServerExists(appServerId: string): void {
    const row = this.database.sqlite
      .prepare("SELECT 1 FROM app_servers WHERE id = ? LIMIT 1")
      .get(appServerId);

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }
  }

  private ensureThreadExists(threadId: string): void {
    const row = this.database.sqlite
      .prepare("SELECT 1 FROM threads WHERE id = ? LIMIT 1")
      .get(threadId);

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }
  }
}

function toDto(row: CodexEventRow): CodexEventDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    eventType: row.event_type,
    rawJson: row.raw_json,
    createdAt: row.created_at
  };
}
