import { randomUUID } from "node:crypto";

import type { ThreadDto, ThreadRuntimeDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, ProtocolError } from "../errors.js";
import { CodexJsonRpcRemoteError, type JsonRpcNotification, type JsonValue } from "./codex-json-rpc.js";
import type { EventService } from "./events.js";
import { ThreadStatusCache } from "./thread-status-cache.js";
import { buildThreadRuntime } from "./thread-runtime.js";

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
  readonly agent_kind: "main" | "subagent";
  readonly parent_thread_id: string | null;
  readonly parent_codex_thread_id: string | null;
  readonly agent_name: string | null;
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
  readonly agentKind: "main" | "subagent";
  readonly parentCodexThreadId: string | null;
  readonly agentName: string | null;
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
    private readonly events: EventService,
    private readonly statusCache: ThreadStatusCache
  ) {}

  public listCurrent(appServerId: string): ThreadDto[] {
    this.ensureAppServerExists(appServerId);

    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM threads
          WHERE app_server_id = ? AND is_current = 1 AND agent_kind = 'main'
          ORDER BY thread_name ASC, created_at ASC
        `
      )
      .all(appServerId) as ThreadRow[];

    return rows.map((row) => this.toDto(row));
  }

  public getById(threadId: string): ThreadDto {
    const row = this.database.sqlite.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as
      | ThreadRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }

    return this.toDto(row);
  }

  public findByCodexThreadId(appServerId: string, codexThreadId: string): ThreadDto | null {
    const row = this.findByCodexThreadIdRow(appServerId, codexThreadId);
    return row === undefined ? null : this.toDto(row);
  }

  public async materializeCodexThread(
    appServerId: string,
    requester: CodexRequester,
    codexThreadId: string
  ): Promise<ThreadDto | null> {
    const existing = this.findByCodexThreadId(appServerId, codexThreadId);
    if (existing !== null) {
      this.statusCache.set(existing.id, "idle");
      return this.findByCodexThreadId(appServerId, codexThreadId);
    }

    try {
      const result = await requester.request("thread/read", {
        threadId: codexThreadId,
        includeTurns: false
      });
      if (!isRecord(result) || result.thread === undefined) {
        return null;
      }

      this.upsertThreads(appServerId, [normalizeCodexThread(result.thread)]);
      const materialized = this.findByCodexThreadId(appServerId, codexThreadId);
      if (materialized !== null) {
        this.statusCache.set(materialized.id, "idle");
      }
      return materialized;
    } catch {
      return null;
    }
  }

  public async sync(appServerId: string, requester: CodexRequester): Promise<SyncResult> {
    const workspace = this.getAppServerWorkspace(appServerId);

    const codexThreads = await this.fetchCodexThreads(requester, workspace);
    const loadedThreadIds = await this.fetchLoadedThreadIds(requester);
    const before = this.currentFingerprint(appServerId);
    const seenCodexIds = this.upsertThreads(appServerId, codexThreads);
    this.markMissingGone(appServerId, seenCodexIds);
    this.syncStatusesFromCodexThreads(appServerId, codexThreads, loadedThreadIds);
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
    const thread = this.findByCodexThreadIdRow(appServerId, codexThreadId);

    if (thread === undefined) {
      throw new ProtocolError("Codex thread/start did not create a local thread record");
    }

    this.statusCache.set(thread.id, "idle");
    const dto = this.toDto(thread);
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

  public handleNotification(appServerId: string, notification: JsonRpcNotification): void {
    const statusChange = parseThreadStatusChanged(notification);
    if (statusChange === null) {
      return;
    }

    const row = this.findByCodexThreadIdRow(appServerId, statusChange.codexThreadId);
    if (row === undefined) {
      return;
    }

    this.statusCache.set(row.id, statusChange.status);
    this.events.publish({
      type: "thread.list_changed",
      appServerId,
      payload: {
        threads: this.listCurrent(appServerId),
        changed: true
      }
    });
  }

  public async resumeThread(
    appServerId: string,
    requester: CodexRequester,
    threadId: string
  ): Promise<ThreadDto> {
    const existing = this.findById(appServerId, threadId);
    if (existing === undefined) {
      throw new NotFoundError("Thread not found");
    }

    const result = await requester.request("thread/resume", { threadId: existing.codex_thread_id });
    const rawThread = extractResumedThread(result);
    this.upsertThreads(appServerId, [normalizeCodexThread(rawThread)]);
    const resumed = this.findByCodexThreadIdRow(appServerId, existing.codex_thread_id);

    if (resumed === undefined) {
      throw new ProtocolError("Codex thread/resume did not update the local thread record");
    }

    this.statusCache.set(resumed.id, "idle");
    const dto = this.toDto(resumed);
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

  private async fetchLoadedThreadIds(requester: CodexRequester): Promise<Set<string> | null> {
    try {
      const result = await requester.request("thread/loaded/list");
      return extractLoadedThreadIds(result);
    } catch (error) {
      if (error instanceof CodexJsonRpcRemoteError) {
        return null;
      }
      throw error;
    }
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
        const existing = this.findByCodexThreadIdRow(appServerId, thread.codexThreadId);
        const parentThreadId =
          thread.parentCodexThreadId === null
            ? null
            : (this.findByCodexThreadIdRow(appServerId, thread.parentCodexThreadId)?.id ?? null);

        if (existing === undefined) {
          const newId = randomUUID();
          this.database.sqlite
            .prepare(
              `
                INSERT INTO threads (
                  id,
                  app_server_id,
                  codex_thread_id,
                  thread_name,
                  agent_kind,
                  parent_thread_id,
                  parent_codex_thread_id,
                  agent_name,
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?)
              `
            )
            .run(
              newId,
              appServerId,
              thread.codexThreadId,
              thread.threadName,
              thread.agentKind,
              parentThreadId,
              thread.parentCodexThreadId,
              thread.agentName,
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
                agent_kind = ?,
                parent_thread_id = ?,
                parent_codex_thread_id = ?,
                agent_name = ?,
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
            thread.agentKind,
            parentThreadId,
            thread.parentCodexThreadId,
            thread.agentName,
            thread.title,
            thread.status,
            thread.cwd,
            now,
            JSON.stringify(thread.raw),
            now,
            existing.id
          );
      }

      this.resolveParentThreadIds(appServerId);
    });

    transaction();
    return seenCodexIds;
  }

  private resolveParentThreadIds(appServerId: string): void {
    this.database.sqlite
      .prepare(
        `
          UPDATE threads
          SET parent_thread_id = (
            SELECT parent.id
            FROM threads AS parent
            WHERE parent.app_server_id = threads.app_server_id
              AND parent.codex_thread_id = threads.parent_codex_thread_id
            LIMIT 1
          )
          WHERE app_server_id = ?
            AND parent_codex_thread_id IS NOT NULL
        `
      )
      .run(appServerId);
  }

  private markMissingGone(appServerId: string, seenCodexIds: ReadonlySet<string>): void {
    const now = Date.now();
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT id
          FROM threads
          WHERE app_server_id = ? AND is_current = 1
        `
      )
      .all(appServerId) as { readonly id: string }[];
    const activeIds = new Set(rows.map((row) => row.id));

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
      this.statusCache.markAllNotLoaded([...activeIds]);
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

    const goneRows = this.database.sqlite
      .prepare(
        `
          SELECT id
          FROM threads
          WHERE app_server_id = ?
            AND is_current = 0
            AND is_gone = 1
        `
      )
      .all(appServerId) as { readonly id: string }[];
    this.statusCache.markAllNotLoaded(goneRows.map((row) => row.id));
  }

  private syncStatusesFromCodexThreads(
    appServerId: string,
    codexThreads: readonly CodexThread[],
    loadedThreadIds: ReadonlySet<string> | null
  ): void {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT id, codex_thread_id
          FROM threads
          WHERE app_server_id = ? AND is_current = 1
        `
      )
      .all(appServerId) as {
      readonly id: string;
      readonly codex_thread_id: string;
    }[];
    const statusByCodexThreadId = new Map(
      codexThreads.map((thread) => [thread.codexThreadId, thread.status ?? "idle"] as const)
    );
    this.statusCache.setMany(
      rows.map((row) => {
        if (loadedThreadIds !== null && !loadedThreadIds.has(row.codex_thread_id)) {
          return [row.id, "notLoaded"] as const;
        }

        return [row.id, statusByCodexThreadId.get(row.codex_thread_id) ?? "idle"] as const;
      })
    );
  }

  private currentFingerprint(appServerId: string): string {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT codex_thread_id, thread_name, agent_kind, parent_codex_thread_id, agent_name, title, status, cwd
          FROM threads
          WHERE app_server_id = ? AND is_current = 1
          ORDER BY codex_thread_id ASC
        `
      )
      .all(appServerId);

    return JSON.stringify(rows);
  }

  private findByCodexThreadIdRow(
    appServerId: string,
    codexThreadId: string
  ): ThreadRow | undefined {
    return this.database.sqlite
      .prepare("SELECT * FROM threads WHERE app_server_id = ? AND codex_thread_id = ?")
      .get(appServerId, codexThreadId) as ThreadRow | undefined;
  }

  private findById(appServerId: string, threadId: string): ThreadRow | undefined {
    return this.database.sqlite
      .prepare("SELECT * FROM threads WHERE app_server_id = ? AND id = ?")
      .get(appServerId, threadId) as ThreadRow | undefined;
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

  private toDto(row: ThreadRow): ThreadDto {
    return toDto(row, buildThreadRuntime(this.database.sqlite, row), this.statusCache);
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
  const parentCodexThreadId = readParentCodexThreadId(value);
  const agentKind = parentCodexThreadId === null ? "main" : "subagent";

  return {
    codexThreadId,
    threadName,
    title: title ?? null,
    status: readThreadStatus(value),
    cwd: firstString(value.cwd, value.workspace) ?? null,
    agentKind,
    parentCodexThreadId,
    agentName: readAgentName(value, agentKind),
    raw: value
  };
}

function readParentCodexThreadId(value: Record<string, JsonValue>): string | null {
  return (
    firstString(
      readNestedString(value, ["source", "subAgent", "thread_spawn", "parent_thread_id"]),
      readNestedString(value, ["source", "sub_agent", "thread_spawn", "parent_thread_id"]),
      readNestedString(value, ["source", "subAgent", "threadSpawn", "parentThreadId"]),
      readNestedString(value, ["source", "sub_agent", "threadSpawn", "parentThreadId"])
    ) ?? null
  );
}

function readAgentName(
  value: Record<string, JsonValue>,
  agentKind: "main" | "subagent"
): string | null {
  if (agentKind === "main") {
    return "main agent";
  }

  return (
    firstString(
      value.agentNickname,
      value.agent_nickname,
      value.agentName,
      value.agent_name,
      value.agentRole,
      value.agent_role,
      readNestedString(value, ["source", "subAgent", "thread_spawn", "agent_nickname"]),
      readNestedString(value, ["source", "sub_agent", "thread_spawn", "agent_nickname"]),
      readNestedString(value, ["source", "subAgent", "threadSpawn", "agentNickname"]),
      readNestedString(value, ["source", "sub_agent", "threadSpawn", "agentNickname"]),
      readNestedString(value, ["source", "subAgent", "thread_spawn", "agent_role"]),
      readNestedString(value, ["source", "sub_agent", "thread_spawn", "agent_role"]),
      readNestedString(value, ["source", "subAgent", "threadSpawn", "agentRole"]),
      readNestedString(value, ["source", "sub_agent", "threadSpawn", "agentRole"])
    ) ?? "subagent"
  );
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let cursor = value;
  for (const key of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return typeof cursor === "string" && cursor.trim().length > 0 ? cursor.trim() : undefined;
}

function readThreadStatus(value: Record<string, JsonValue>): string | null {
  if (typeof value.status === "string") {
    return normalizeThreadStatus(value.status);
  }

  if (isRecord(value.status)) {
    return normalizeThreadStatus(firstString(value.status.type, value.status.status) ?? null);
  }

  return null;
}

function normalizeThreadStatus(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  switch (value) {
    case "active":
      return "working";
    case "idle":
    case "notLoaded":
    case "working":
    case "systemError":
      return value;
    default:
      return value;
  }
}

function extractLoadedThreadIds(result: JsonValue): Set<string> {
  if (!isRecord(result)) {
    throw new ProtocolError("Codex thread/loaded/list returned an invalid response");
  }

  const rawItems = result.data ?? result.threads ?? result.threadIds ?? result.thread_ids;
  if (!Array.isArray(rawItems)) {
    throw new ProtocolError("Codex thread/loaded/list did not include a thread id array");
  }

  const ids = new Set<string>();
  for (const item of rawItems) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ProtocolError("Codex thread/loaded/list returned an invalid thread id");
    }
    ids.add(item);
  }

  return ids;
}

function parseThreadStatusChanged(
  notification: JsonRpcNotification
): { readonly codexThreadId: string; readonly status: string } | null {
  if (notification.method !== "thread/status/changed" || !isRecord(notification.params)) {
    return null;
  }

  const codexThreadId = firstString(notification.params.threadId, notification.params.thread_id);
  const status = readThreadStatus(notification.params);
  if (codexThreadId === undefined || status === null) {
    return null;
  }

  return { codexThreadId, status };
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

function extractResumedThread(result: JsonValue): JsonValue {
  if (!isRecord(result)) {
    throw new ProtocolError("Codex thread/resume returned an invalid response");
  }

  if (result.thread === undefined) {
    throw new ProtocolError("Codex thread/resume response did not include a thread");
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

function toDto(row: ThreadRow, runtime: ThreadRuntimeDto, statusCache?: ThreadStatusCache): ThreadDto {
  const cachedStatus = statusCache?.get(row.id);
  return {
    id: row.id,
    appServerId: row.app_server_id,
    codexThreadId: row.codex_thread_id,
    threadName: row.thread_name,
    agentKind: row.agent_kind,
    parentThreadId: row.parent_thread_id,
    parentCodexThreadId: row.parent_codex_thread_id,
    agentName: row.agent_name,
    title: row.title,
    status: cachedStatus ?? "notLoaded",
    cwd: row.cwd,
    isCurrent: row.is_current === 1,
    isGone: row.is_gone === 1,
    importedAt: row.imported_at,
    lastSeenAt: row.last_seen_at,
    rawMetadata: JSON.parse(row.raw_metadata_json) as unknown,
    runtime,
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
