import type { ApprovalDto, ApprovalStatus } from "@agentmesh/shared";

export type ApprovalDetail = {
  readonly label: string;
  readonly value: string;
};

const DETAIL_KEYS = [
  "command",
  "cmd",
  "path",
  "file",
  "filename",
  "operation",
  "reason",
  "summary",
  "description",
  "threadId",
  "thread_id"
] as const;

export function approvalStatusType(
  status: ApprovalStatus
): "success" | "warning" | "danger" | "info" {
  if (status === "approved") {
    return "success";
  }
  if (status === "pending") {
    return "warning";
  }
  if (status === "denied" || status === "failed" || status === "expired") {
    return "danger";
  }
  return "info";
}

export function approvalStateText(approval: ApprovalDto): string {
  if (approval.status === "pending") {
    return "Waiting for a decision.";
  }
  if (approval.status === "approved") {
    return "Approved. This request can no longer be changed.";
  }
  if (approval.status === "denied") {
    return "Denied. This request can no longer be changed.";
  }
  if (approval.status === "expired") {
    return "Expired before a decision was sent.";
  }
  return approval.error ?? "Failed before a decision was sent.";
}

export function approvalPayload(approval: ApprovalDto): unknown {
  if (isRecord(approval.request) && "params" in approval.request) {
    return approval.request.params;
  }

  return approval.request;
}

export function approvalDetails(approval: ApprovalDto): readonly ApprovalDetail[] {
  const payload = approvalPayload(approval);
  const details: ApprovalDetail[] = [
    { label: "Kind", value: approval.kind },
    { label: "Request", value: approval.codexRequestId }
  ];

  for (const detail of detailsFromValue(payload)) {
    if (details.length >= 8) {
      break;
    }
    if (
      !details.some(
        (existing) => existing.label === detail.label && existing.value === detail.value
      )
    ) {
      details.push(detail);
    }
  }

  return details;
}

export function formatApprovalJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function detailsFromValue(value: unknown): ApprovalDetail[] {
  if (!isRecord(value)) {
    return [];
  }

  const details: ApprovalDetail[] = [];
  for (const key of DETAIL_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined) {
      details.push({ label: labelForKey(key), value: summarizeValue(candidate) });
    }
  }

  const changes = value.changes;
  if (Array.isArray(changes)) {
    details.push({
      label: "Changes",
      value: `${changes.length} file change${changes.length === 1 ? "" : "s"}`
    });
    for (const change of changes.slice(0, 3)) {
      if (isRecord(change)) {
        const path = firstString(change.path, change.file, change.filename);
        const operation = firstString(change.operation, change.type);
        if (path !== null) {
          details.push({
            label: "File",
            value: operation === null ? path : `${operation}: ${path}`
          });
        }
      }
    }
  }

  return details;
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return value.join(" ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function labelForKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
