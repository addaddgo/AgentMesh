import type Database from "better-sqlite3";
import type { ThreadRuntimeDto } from "@agentmesh/shared";

type RuntimeThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly codex_thread_id: string;
  readonly thread_name: string;
  readonly agent_kind: "main" | "subagent";
  readonly parent_thread_id: string | null;
  readonly parent_codex_thread_id: string | null;
  readonly agent_name: string | null;
  readonly raw_metadata_json: string;
};

type ThreadSettingsRow = {
  readonly model: string | null;
  readonly effort: string | null;
  readonly approval_policy_json: string | null;
  readonly sandbox_policy_json: string | null;
  readonly collaboration_mode_json: string | null;
};

type CodexEventRow = {
  readonly raw_json: string;
};

type MainThreadRow = {
  readonly thread_name: string;
};

const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export function buildThreadRuntime(
  sqlite: Database.Database,
  row: RuntimeThreadRow
): ThreadRuntimeDto {
  const rawMetadata = parseJsonObject(row.raw_metadata_json);
  const settings = sqlite
    .prepare(
      `
        SELECT model, effort, approval_policy_json, sandbox_policy_json, collaboration_mode_json
        FROM thread_settings
        WHERE thread_id = ?
      `
    )
    .get(row.id) as ThreadSettingsRow | undefined;

  const collaborationMode = parseJsonObject(settings?.collaboration_mode_json ?? null);
  const sandboxPolicy = parseJsonObject(settings?.sandbox_policy_json ?? null);
  const approvalPolicy = parseJsonValue(settings?.approval_policy_json ?? null);
  const mainCodexThreadId =
    row.parent_codex_thread_id ??
    findMainCodexThreadId(sqlite, row.app_server_id, row.codex_thread_id);
  const mainThreadName =
    mainCodexThreadId === null
      ? row.thread_name
      : (findThreadNameByCodexId(sqlite, row.app_server_id, mainCodexThreadId) ?? row.thread_name);

  return {
    mainThreadName,
    agentName:
      row.agent_name ??
      (mainCodexThreadId === null
        ? "main agent"
        : (readSubagentName(rawMetadata, collaborationMode) ?? "subagent")),
    collaborationMode:
      firstString(
        readNestedString(collaborationMode, ["mode"]),
        readNestedString(rawMetadata, ["mode"])
      ) ?? null,
    model:
      settings?.model ??
      firstString(
        readNestedString(collaborationMode, ["settings", "model"]),
        readNestedString(rawMetadata, ["model"]),
        readNestedString(rawMetadata, ["modelName"]),
        readNestedString(rawMetadata, ["model_name"]),
        readNestedString(rawMetadata, ["modelProvider"]),
        readNestedString(rawMetadata, ["model_provider"])
      ) ??
      null,
    reasoningEffort:
      settings?.effort ??
      firstString(
        readNestedString(collaborationMode, ["settings", "reasoning_effort"]),
        readNestedString(collaborationMode, ["settings", "reasoningEffort"]),
        readNestedString(rawMetadata, ["reasoningEffort"]),
        readNestedString(rawMetadata, ["reasoning_effort"])
      ) ??
      null,
    contextRemainingPercent:
      readContextRemainingPercent(rawMetadata) ?? readLatestContextRemainingPercent(sqlite, row.id),
    permissionMode: readPermissionMode(approvalPolicy, sandboxPolicy)
  };
}

function readSubagentName(
  rawMetadata: Record<string, unknown> | null,
  collaborationMode: Record<string, unknown> | null
): string | null {
  return (
    firstString(
      readNestedString(rawMetadata, ["agentNickname"]),
      readNestedString(rawMetadata, ["agent_nickname"]),
      readNestedString(rawMetadata, ["threadSource", "agentNickname"]),
      readNestedString(rawMetadata, ["threadSource", "agent_nickname"]),
      readNestedString(rawMetadata, ["agentName"]),
      readNestedString(rawMetadata, ["agent_name"]),
      readNestedString(rawMetadata, ["agentRole"]),
      readNestedString(rawMetadata, ["agent_role"]),
      readNestedString(rawMetadata, ["threadSource", "agentRole"]),
      readNestedString(rawMetadata, ["threadSource", "agent_role"]),
      readNestedString(collaborationMode, ["mode"])
    ) ?? null
  );
}

function findMainCodexThreadId(
  sqlite: Database.Database,
  appServerId: string,
  receiverCodexThreadId: string
): string | null {
  const rows = sqlite
    .prepare(
      `
        SELECT raw_json
        FROM codex_events
        WHERE app_server_id = ?
          AND raw_json LIKE '%receiverThreadIds%'
        ORDER BY created_at DESC
      `
    )
    .all(appServerId) as CodexEventRow[];

  for (const row of rows) {
    const value = parseJsonValue(row.raw_json);
    const item = readNestedRecord(value, ["params", "item"]);
    if (item === null || readNestedString(item, ["type"]) !== "collabAgentToolCall") {
      continue;
    }

    const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    const isReceiver = receiverThreadIds.some(
      (candidate) => typeof candidate === "string" && candidate === receiverCodexThreadId
    );
    if (isReceiver) {
      return readNestedString(item, ["senderThreadId"]) ?? null;
    }
  }

  return null;
}

function findThreadNameByCodexId(
  sqlite: Database.Database,
  appServerId: string,
  codexThreadId: string
): string | null {
  const row = sqlite
    .prepare(
      `
        SELECT thread_name
        FROM threads
        WHERE app_server_id = ? AND codex_thread_id = ?
        LIMIT 1
      `
    )
    .get(appServerId, codexThreadId) as MainThreadRow | undefined;

  return row?.thread_name ?? null;
}

function readPermissionMode(
  approvalPolicy: unknown,
  sandboxPolicy: Record<string, unknown> | null
): string | null {
  const sandboxType = firstString(
    readNestedString(sandboxPolicy, ["type"]),
    readNestedString(sandboxPolicy, ["mode"])
  );
  const approval = typeof approvalPolicy === "string" ? approvalPolicy : null;

  if (sandboxType === "dangerFullAccess") {
    return "Full Access";
  }
  if (sandboxType === "readOnly") {
    return "Read Only";
  }
  if (sandboxType === "workspaceWrite" && approval === "on-request") {
    return "Default";
  }
  if (sandboxType !== undefined && approval !== null) {
    return `${approval} / ${sandboxType}`;
  }
  return sandboxType ?? approval;
}

function readLatestContextRemainingPercent(
  sqlite: Database.Database,
  threadId: string
): number | null {
  const rows = sqlite
    .prepare(
      `
        SELECT raw_json
        FROM codex_events
        WHERE thread_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `
    )
    .all(threadId) as CodexEventRow[];

  for (const row of rows) {
    const value = readContextRemainingPercent(parseJsonValue(row.raw_json));
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function readContextRemainingPercent(value: unknown): number | null {
  const remaining = firstNumberByKey(value, [
    "contextRemainingPercent",
    "context_remaining_percent",
    "remainingContextPercent",
    "remaining_context_percent",
    "contextWindowRemainingPercent",
    "context_window_remaining_percent"
  ]);
  if (remaining !== null) {
    return clampPercent(remaining);
  }

  const lastTokens = firstNumberByPath(value, [
    ["params", "tokenUsage", "last", "totalTokens"],
    ["tokenUsage", "last", "totalTokens"],
    ["last", "totalTokens"],
    ["params", "token_usage", "last", "total_tokens"],
    ["token_usage", "last", "total_tokens"],
    ["last", "total_tokens"]
  ]);
  const contextWindow = firstNumberByPath(value, [
    ["params", "tokenUsage", "modelContextWindow"],
    ["tokenUsage", "modelContextWindow"],
    ["modelContextWindow"],
    ["params", "token_usage", "model_context_window"],
    ["token_usage", "model_context_window"],
    ["model_context_window"]
  ]);
  if (lastTokens !== null && contextWindow !== null) {
    return codexContextRemainingPercent(lastTokens, contextWindow);
  }

  const used = firstNumberByKey(value, [
    "contextWindowUsedPercent",
    "context_window_used_percent",
    "effectiveContextWindowPercent",
    "effective_context_window_percent"
  ]);
  return used === null ? null : clampPercent(100 - used);
}

function codexContextRemainingPercent(lastTokens: number, contextWindow: number): number {
  if (contextWindow <= CODEX_CONTEXT_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = contextWindow - CODEX_CONTEXT_BASELINE_TOKENS;
  const used = Math.max(0, lastTokens - CODEX_CONTEXT_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  return clampPercent((remaining / effectiveWindow) * 100);
}

function firstNumberByPath(value: unknown, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const found = readNestedNumber(value, path);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function readNestedNumber(value: unknown, path: readonly string[]): number | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function firstNumberByKey(value: unknown, keys: readonly string[]): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNumberByKey(item, keys);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  for (const nested of Object.values(value)) {
    const found = firstNumberByKey(nested, keys);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : undefined;
}

function readNestedRecord(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : null;
}

function parseJsonValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
