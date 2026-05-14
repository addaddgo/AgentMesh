import { randomUUID } from "node:crypto";

import type { ChatMessage, ChatMessageRole, MessagePart } from "@agentmesh/shared";

export type NormalizedCodexEventMessage = {
  readonly eventType: string;
  readonly role: ChatMessageRole;
  readonly status: ChatMessage["status"];
  readonly parts: readonly MessagePart[];
  readonly codexTurnId: string | null;
  readonly createdAt: number;
};

export function normalizeCodexEventMessage(raw: unknown): NormalizedCodexEventMessage {
  const envelope = isRecord(raw) ? raw : {};
  const payload = extractPayload(envelope);
  const eventType = normalizeEventType(envelope, payload);
  const parts = normalizeMessageParts(payload, eventType);

  return {
    eventType,
    role: normalizeRole(firstString(payload.role, payload.author), eventType),
    status: normalizeStatus(payload, eventType),
    parts,
    codexTurnId:
      firstString(payload.turnId, payload.turn_id, payload.turn, envelope.turnId) ?? null,
    createdAt:
      firstTimestamp(payload.createdAt, payload.created_at, payload.timestamp, payload.time) ??
      Date.now()
  };
}

export function normalizeMessageParts(
  value: unknown,
  fallbackEventType = "event"
): readonly MessagePart[] {
  if (typeof value === "string") {
    return [{ type: "markdown", text: value }];
  }

  if (!isRecord(value)) {
    return [{ type: "event", eventType: "unsupported", raw: value }];
  }

  const rawParts = firstArray(value.parts, value.content);
  if (rawParts !== undefined) {
    const parts = rawParts.flatMap((part) => normalizePart(part));
    return parts.length === 0
      ? [{ type: "event", eventType: fallbackEventType, raw: value }]
      : parts;
  }

  const directPart = normalizeDirectPart(value);
  if (directPart !== undefined) {
    return [directPart];
  }

  const text = firstString(value.markdown, value.text, value.message, value.content, value.delta);
  if (text !== undefined) {
    return [{ type: "markdown", text }];
  }

  return [{ type: "event", eventType: fallbackEventType, raw: value }];
}

function normalizePart(value: unknown): MessagePart[] {
  if (typeof value === "string") {
    return [{ type: "markdown", text: value }];
  }

  if (!isRecord(value)) {
    return [{ type: "event", eventType: "unsupported_part", raw: value }];
  }

  const directPart = normalizeDirectPart(value);
  if (directPart !== undefined) {
    return [directPart];
  }

  const text = firstString(value.markdown, value.text, value.content);
  if (text !== undefined) {
    return [{ type: "markdown", text }];
  }

  return [{ type: "event", eventType: firstString(value.type, value.kind) ?? "part", raw: value }];
}

function normalizeDirectPart(value: Record<string, unknown>): MessagePart | undefined {
  const type = firstString(value.type, value.kind, value.eventType, value.event_type);
  const lowerType = type?.toLowerCase();
  const text = firstString(value.markdown, value.text, value.content, value.message, value.delta);

  if (lowerType === "markdown" || lowerType === "text" || lowerType === "agent_message") {
    return text === undefined ? undefined : { type: "markdown", text };
  }

  if (lowerType === "image" || hasAnyString(value, "url", "imageUrl", "image_url", "image")) {
    const workspacePath = firstString(value.workspacePath, value.workspace_path, value.localImage);
    const url = firstString(value.url, value.imageUrl, value.image_url, value.image);

    return {
      type: "image",
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(url === undefined ? {} : { url })
    };
  }

  if (
    lowerType === "tool_call" ||
    lowerType === "function_call" ||
    lowerType === "exec_command_begin" ||
    lowerType === "mcp_tool_call"
  ) {
    return {
      type: "tool_call",
      toolName: firstString(value.toolName, value.tool_name, value.name, value.command) ?? "tool",
      callId: firstString(value.callId, value.call_id, value.id, value.item_id) ?? randomUUID(),
      input: value.input ?? value.arguments ?? value.args ?? value.params ?? null,
      status: firstString(value.status) ?? "completed"
    };
  }

  if (
    lowerType === "tool_result" ||
    lowerType === "function_call_output" ||
    lowerType === "exec_command_end" ||
    lowerType === "mcp_tool_result"
  ) {
    return {
      type: "tool_result",
      callId: firstString(value.callId, value.call_id, value.id, value.item_id) ?? randomUUID(),
      output: value.output ?? value.result ?? value.content ?? null,
      status: firstString(value.status) ?? "completed"
    };
  }

  if (lowerType === "diff" || lowerType === "patch" || hasAnyString(value, "diff", "patch")) {
    return { type: "diff", text: firstString(value.diff, value.patch, text) ?? "" };
  }

  if (
    lowerType === "approval" ||
    lowerType === "approval_request" ||
    lowerType === "request_approval"
  ) {
    return {
      type: "approval",
      approvalId:
        firstString(value.approvalId, value.approval_id, value.id, value.request_id) ??
        randomUUID(),
      kind: firstString(value.kind, value.approvalType, value.approval_type) ?? "approval",
      payload: value.payload ?? value,
      status: firstString(value.status) ?? "pending"
    };
  }

  if (lowerType === "error" || value.error !== undefined) {
    const error = isRecord(value.error) ? value.error : {};
    return {
      type: "error",
      message: firstString(value.message, error.message, text) ?? "Codex error",
      raw: value
    };
  }

  return undefined;
}

function extractPayload(envelope: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(envelope.params) ? envelope.params : envelope;

  for (const key of ["event", "msg", "message", "item", "data"] as const) {
    const value = params[key];
    if (isRecord(value)) {
      return { ...value, ...(params.threadId === undefined ? {} : { threadId: params.threadId }) };
    }
  }

  return params;
}

function normalizeEventType(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>
): string {
  return (
    firstString(
      payload.eventType,
      payload.event_type,
      payload.type,
      payload.kind,
      envelope.method
    ) ?? "event"
  );
}

function normalizeRole(explicitRole: string | undefined, eventType: string): ChatMessageRole {
  switch (explicitRole) {
    case "user":
    case "assistant":
    case "tool":
    case "system":
    case "event":
      return explicitRole;
    case "function":
      return "tool";
    case "developer":
      return "system";
    default:
      break;
  }

  const lowerType = eventType.toLowerCase();
  if (lowerType.includes("tool") || lowerType.includes("function") || lowerType.includes("exec")) {
    return "tool";
  }

  if (lowerType.includes("error") || lowerType.includes("approval")) {
    return "event";
  }

  return "assistant";
}

function normalizeStatus(
  payload: Record<string, unknown>,
  eventType: string
): ChatMessage["status"] {
  const status = firstString(payload.status)?.toLowerCase();
  if (
    status === "pending" ||
    status === "queued" ||
    status === "sent" ||
    status === "streaming" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }

  const lowerType = eventType.toLowerCase();
  if (lowerType.includes("delta") || lowerType.includes("started")) {
    return "streaming";
  }

  if (lowerType.includes("error") || lowerType.includes("failed")) {
    return "failed";
  }

  return "completed";
}

function firstArray(...values: readonly unknown[]): readonly unknown[] | undefined {
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

function hasAnyString(record: Record<string, unknown>, ...keys: readonly string[]): boolean {
  return keys.some((key) => firstString(record[key]) !== undefined);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
