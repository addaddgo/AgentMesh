import { randomUUID } from "node:crypto";

import type { ThreadDto } from "@agentmesh/shared";

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

type AppServerWorkspaceRow = {
  readonly workspace: string;
};

type CodexThread = {
  readonly codexThreadId: string;
  readonly threadName: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly cwd: string | null;
  readonly raw: JsonValue;
};

type SyncResult = {
  readonly threads: readonly ThreadDto[];
  readonly changed: boolean;
};

const MAX_THREAD_LIST_PAGES = 100;

export class ThreadSyncService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService
  ) {}

  public listCurrent(appServerId: string): ThreadDto[] {
    this.ensureAppServerExists(appServerId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM threads
          WHERE app_server_id = ? AND is_current = 1
          ORDER BY thread_name ASC, created_at ASC
        `
      )
      .all(appServerId) as ThreadRow[];

    return rows.map(toDto);
  }

  public async sync(appServerId: string, requester: CodexRequester): Promise<SyncResult> {
    const workspace = this.getAppServerWorkspace(appServerId);

    const codexThreads = await this.fetchCodexThreads(requester, workspace);
    const before = this.currentFingerprint(appServerId);
    const seenCodexIds = this.upsertThreads(appServerId, codexThreads);
    this.markMissingGone(appServerId, seenCodexIds);
    const threads = this.listCurrent(appServerId);
    const changed = before !== this.currentFingerprint(appServerId);

    this.events.publish({
      type: "thread.list_changed",
      appServerId,
      payload: {
        threads,
        changed
      }
    });

    return { threads, changed };
  }

  public async createThread(
    appServerId: string,
    requester: CodexRequester,
    name: string
  ): Promise<ThreadDto> {
    const workspace = this.getAppServerWorkspace(appServerId);
    const result = await requester.request("thread/start", { cwd: workspace });
    const rawThread = extractStartedThread(result);
    const codexThreadId = extractThreadId(rawThread);

    await requester.request("thread/name/set", { threadId: codexThreadId, name });

    const namedThread = withThreadName(rawThread, name);
    this.upsertThreads(appServerId, [normalizeCodexThread(namedThread)]);
    const thread = this.findByCodexThreadId(appServerId, codexThreadId);

    if (thread === undefined) {
      throw new ProtocolError("Codex thread/start did not create a local thread record");
    }

    const dto = toDto(thread);
    this.events.publish({
      type: "thread.list_changed",
      appServerId,
      payload: {
        threads: this.listCurrent(appServerId),
        changed: true
      }
    });

    return dto;
  }

  private async fetchCodexThreads(
    requester: CodexRequester,
    workspace: string
  ): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    let cursor: string | null | undefined;

    for (let page = 0; page < MAX_THREAD_LIST_PAGES; page += 1) {
      const result =
        cursor === undefined
          ? await requester.request("thread/list", { cwd: workspace })
          : await requester.request("thread/list", { cwd: workspace, cursor });
      const pageThreads = extractThreadItems(result);

      for (const item of pageThreads) {
        threads.push(normalizeCodexThread(item));
      }

      cursor = extractNextCursor(result);

      if (cursor === null || cursor === undefined || cursor.length === 0) {
        return threads;
      }
    }

    throw new ProtocolError("Codex thread/list pagination exceeded the page limit");
  }

  private upsertThreads(appServerId: string, codexThreads: readonly CodexThread[]): Set<string> {
    const now = Date.now();
    const seenCodexIds = new Set<string>();
    const transaction = this.database.sqlite.transaction(() => {
      for (const thread of codexThreads) {
        if (seenCodexIds.has(thread.codexThreadId)) {
          continue;
        }

        seenCodexIds.add(thread.codexThreadId);
        const existing = this.findByCodexThreadId(appServerId, thread.codexThreadId);

        if (existing === undefined) {
          this.database.sqlite
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?)
              `
            )
            .run(
              randomUUID(),
              appServerId,
              thread.codexThreadId,
              thread.threadName,
              thread.title,
              thread.status,
              thread.cwd,
              now,
              JSON.stringify(thread.raw),
              now,
              now
            );
          continue;
        }

        this.database.sqlite
          .prepare(
            `
              UPDATE threads
              SET
                thread_name = ?,
                title = ?,
                status = ?,
                cwd = ?,
                is_current = 1,
                is_gone = 0,
                last_seen_at = ?,
                raw_metadata_json = ?,
                updated_at = ?
              WHERE id = ?
            `
          )
          .run(
            thread.threadName,
            thread.title,
            thread.status,
            thread.cwd,
            now,
            JSON.stringify(thread.raw),
            now,
            existing.id
          );
      }
    });

    transaction();
    return seenCodexIds;
  }

  private markMissingGone(appServerId: string, seenCodexIds: ReadonlySet<string>): void {
    const now = Date.now();

    if (seenCodexIds.size === 0) {
      this.database.sqlite
        .prepare(
          `
            UPDATE threads
            SET is_current = 0, is_gone = 1, updated_at = ?
            WHERE app_server_id = ? AND is_current = 1
          `
        )
        .run(now, appServerId);
      return;
    }

    const placeholders = [...seenCodexIds].map(() => "?").join(", ");
    this.database.sqlite
      .prepare(
        `
          UPDATE threads
          SET is_current = 0, is_gone = 1, updated_at = ?
          WHERE app_server_id = ?
            AND is_current = 1
            AND codex_thread_id NOT IN (${placeholders})
        `
      )
      .run(now, appServerId, ...seenCodexIds);
  }

  private currentFingerprint(appServerId: string): string {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT codex_thread_id, thread_name, title, status, cwd
          FROM threads
          WHERE app_server_id = ? AND is_current = 1
          ORDER BY codex_thread_id ASC
        `
      )
      .all(appServerId);

    return JSON.stringify(rows);
  }

  private findByCodexThreadId(appServerId: string, codexThreadId: string): ThreadRow | undefined {
    return this.database.sqlite
      .prepare("SELECT * FROM threads WHERE app_server_id = ? AND codex_thread_id = ?")
      .get(appServerId, codexThreadId) as ThreadRow | undefined;
  }

  private ensureAppServerExists(appServerId: string): void {
    this.getAppServerWorkspace(appServerId);
  }

  private getAppServerWorkspace(appServerId: string): string {
    const row = this.database.sqlite
      .prepare("SELECT workspace FROM app_servers WHERE id = ? LIMIT 1")
      .get(appServerId) as AppServerWorkspaceRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row.workspace;
  }
}

function extractThreadItems(result: JsonValue): readonly JsonValue[] {
  if (Array.isArray(result)) {
    return result;
  }

  if (!isRecord(result)) {
    throw new ProtocolError("Codex thread/list returned an invalid response");
  }

  const candidates = [result.threads, result.items, result.data];
  const items = candidates.find(Array.isArray);

  if (items === undefined) {
    throw new ProtocolError("Codex thread/list response did not include a thread array");
  }

  return items;
}

function extractNextCursor(result: JsonValue): string | null | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const cursor = result.nextCursor ?? result.next_cursor ?? result.cursor;

  if (cursor === null || cursor === undefined) {
    return cursor;
  }

  if (typeof cursor !== "string") {
    throw new ProtocolError("Codex thread/list returned an invalid pagination cursor");
  }

  return cursor;
}

function normalizeCodexThread(value: JsonValue): CodexThread {
  if (!isRecord(value)) {
    throw new ProtocolError("Codex thread/list included an invalid thread record");
  }

  const codexThreadId = firstString(value.id, value.threadId, value.thread_id);

  if (codexThreadId === undefined) {
    throw new ProtocolError("Codex thread/list thread record did not include an id");
  }

  const title = firstString(value.title);
  const threadName = firstString(value.name, title, codexThreadId) ?? codexThreadId;

  return {
    codexThreadId,
    threadName,
    title: title ?? null,
    status: firstString(value.status) ?? null,
    cwd: firstString(value.cwd, value.workspace) ?? null,
    raw: value
  };
}

function extractStartedThread(result: JsonValue): JsonValue {
  if (!isRecord(result)) {
    throw new ProtocolError("Codex thread/start returned an invalid response");
  }

  if (result.thread === undefined) {
    throw new ProtocolError("Codex thread/start response did not include a thread");
  }

  return result.thread;
}

function extractThreadId(value: JsonValue): string {
  if (!isRecord(value)) {
    throw new ProtocolError("Codex thread/start response included an invalid thread");
  }

  const codexThreadId = firstString(value.id, value.threadId, value.thread_id);

  if (codexThreadId === undefined) {
    throw new ProtocolError("Codex thread/start thread did not include an id");
  }

  return codexThreadId;
}

function withThreadName(value: JsonValue, name: string): JsonValue {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    name
  };
}

function toDto(row: ThreadRow): ThreadDto {
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

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
