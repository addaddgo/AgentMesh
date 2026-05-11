import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  ApprovalDto,
  ApprovalStatus,
  ChatMessage,
  MessagePart
} from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, OfflineError, ProtocolError, RequestValidationError } from "../errors.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcServerRequest,
  JsonValue
} from "./codex-json-rpc.js";
import type { EventService } from "./events.js";

type ApprovalRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly turn_id: string | null;
  readonly codex_request_id: string;
  readonly kind: string;
  readonly status: ApprovalStatus;
  readonly request_json: string;
  readonly response_json: string | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly codex_thread_id: string;
};

type TurnRow = {
  readonly id: string;
};

type ApprovalRequestInput = {
  readonly appServerId: string;
  readonly kind: string;
  readonly codexRequestId: JsonRpcId;
  readonly params: unknown;
  readonly raw: unknown;
  readonly rawJsonText: string;
};

type ListApprovalsInput = {
  readonly threadId?: string | undefined;
  readonly status?: ApprovalStatus | undefined;
};

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "turn/approval_required"
]);

export class ApprovalService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService,
    private readonly appServerLifecycle?: AppServerLifecycleRegistry
  ) {}

  public static isApprovalMethod(method: string): boolean {
    return APPROVAL_METHODS.has(method) || method.toLowerCase().includes("approval");
  }

  public handleServerRequest(
    appServerId: string,
    request: JsonRpcServerRequest,
    rawLine: string
  ): ApprovalDto | null {
    if (!ApprovalService.isApprovalMethod(request.method)) {
      return null;
    }

    return this.createOrUpdatePending({
      appServerId,
      kind: request.method,
      codexRequestId: request.id,
      params: request.params,
      raw: request,
      rawJsonText: rawLine
    });
  }

  public handleNotification(
    appServerId: string,
    notification: JsonRpcNotification,
    rawLine: string
  ): ApprovalDto | null {
    if (!ApprovalService.isApprovalMethod(notification.method)) {
      return null;
    }

    const codexRequestId = firstString(notification.params, "id", "requestId", "request_id");
    if (codexRequestId === undefined) {
      return null;
    }

    return this.createOrUpdatePending({
      appServerId,
      kind: notification.method,
      codexRequestId,
      params: notification.params,
      raw: notification,
      rawJsonText: rawLine
    });
  }

  public list(input: ListApprovalsInput = {}): ApprovalDto[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.threadId !== undefined) {
      conditions.push("thread_id = ?");
      params.push(input.threadId);
    }

    if (input.status !== undefined) {
      conditions.push("status = ?");
      params.push(input.status);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM approvals
          ${where}
          ORDER BY created_at ASC, id ASC
        `
      )
      .all(...params) as ApprovalRow[];

    return rows.map(toDto);
  }

  public respond(id: string, decision: ApprovalDecision): ApprovalDto {
    if (this.appServerLifecycle === undefined) {
      throw new ProtocolError("Approval response transport is unavailable");
    }

    const approval = this.get(id);
    if (approval.status !== "pending") {
      throw new RequestValidationError("Approval is no longer pending");
    }

    const result = buildApprovalResult(approval.kind, decision);

    try {
      this.appServerLifecycle
        .getTransport(approval.appServerId)
        .respond(approval.codexRequestId, result);
    } catch (error) {
      const failed = this.updateStatus(approval.id, "failed", {
        response: {
          decision,
          result,
          sentAt: Date.now()
        },
        error: errorMessage(error)
      });
      this.publishUpdated(failed);
      throw error instanceof OfflineError ? error : new OfflineError();
    }

    const updated = this.updateStatus(approval.id, decision === "approve" ? "approved" : "denied", {
      response: {
        decision,
        result,
        sentAt: Date.now()
      },
      error: null
    });
    this.updateApprovalMessagePart(updated);
    this.publishUpdated(updated);
    return updated;
  }

  public markPendingForAppServerFailed(appServerId: string, error: string): ApprovalDto[] {
    const rows = this.database.sqlite
      .prepare("SELECT * FROM approvals WHERE app_server_id = ? AND status = 'pending'")
      .all(appServerId) as ApprovalRow[];

    return rows.map((row) => {
      const updated = this.updateStatus(row.id, "failed", {
        response: null,
        error
      });
      this.updateApprovalMessagePart(updated);
      this.publishUpdated(updated);
      return updated;
    });
  }

  public get(id: string): ApprovalDto {
    const row = this.database.sqlite.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("Approval not found");
    }

    return toDto(row);
  }

  private createOrUpdatePending(input: ApprovalRequestInput): ApprovalDto {
    const existing = this.database.sqlite
      .prepare("SELECT * FROM approvals WHERE app_server_id = ? AND codex_request_id = ?")
      .get(input.appServerId, String(input.codexRequestId)) as ApprovalRow | undefined;

    if (existing !== undefined) {
      const approval = toDto(existing);
      this.updateApprovalMessagePart(approval);
      return approval;
    }

    const thread = this.findThread(input.appServerId, input.params);
    const turnId = this.findActiveTurnId(thread.id);
    const approvalId = randomUUID();
    const messageId = randomUUID();
    const eventId = randomUUID();
    const now = Date.now();
    const request = parseRawJson(input.rawJsonText) ?? input.raw;
    const part: MessagePart = {
      type: "approval",
      approvalId,
      kind: input.kind,
      payload: input.params ?? input.raw,
      status: "pending"
    };

    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `
            INSERT INTO codex_events (id, app_server_id, thread_id, turn_id, event_type, raw_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(eventId, input.appServerId, thread.id, turnId, input.kind, input.rawJsonText, now);

      this.database.sqlite
        .prepare(
          `
            INSERT INTO approvals (
              id,
              app_server_id,
              thread_id,
              turn_id,
              codex_request_id,
              kind,
              status,
              request_json,
              response_json,
              error,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)
          `
        )
        .run(
          approvalId,
          input.appServerId,
          thread.id,
          turnId,
          String(input.codexRequestId),
          input.kind,
          JSON.stringify(request),
          now,
          now
        );

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
            ) VALUES (?, ?, ?, ?, 'event', 'completed', ?, ?, NULL, ?, ?)
          `
        )
        .run(
          messageId,
          input.appServerId,
          thread.id,
          turnId,
          JSON.stringify([part]),
          JSON.stringify([eventId]),
          now,
          now
        );

      if (turnId !== null) {
        this.database.sqlite
          .prepare("UPDATE turns SET status = 'waiting_approval', updated_at = ? WHERE id = ?")
          .run(now, turnId);
      }
    });

    transaction();

    const approval = this.get(approvalId);
    this.publishCreated(approval);
    this.publishMessage(this.getMessage(messageId), "thread.message_added");
    return approval;
  }

  private findThread(appServerId: string, params: unknown): ThreadRow {
    const codexThreadId = firstString(params, "threadId", "thread_id", "thread");

    if (codexThreadId !== undefined) {
      const exact = this.database.sqlite
        .prepare(
          "SELECT id, app_server_id, codex_thread_id FROM threads WHERE app_server_id = ? AND codex_thread_id = ?"
        )
        .get(appServerId, codexThreadId) as ThreadRow | undefined;

      if (exact !== undefined) {
        return exact;
      }
    }

    const rows = this.database.sqlite
      .prepare(
        "SELECT id, app_server_id, codex_thread_id FROM threads WHERE app_server_id = ? AND is_current = 1"
      )
      .all(appServerId) as ThreadRow[];

    if (rows.length === 1 && rows[0] !== undefined) {
      return rows[0];
    }

    throw new ProtocolError("Approval request did not identify a known thread");
  }

  private findActiveTurnId(threadId: string): string | null {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT id
          FROM turns
          WHERE thread_id = ? AND status IN ('queued', 'running', 'waiting_approval')
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(threadId) as TurnRow | undefined;

    return row?.id ?? null;
  }

  private updateStatus(
    id: string,
    status: ApprovalStatus,
    input: {
      readonly response: unknown;
      readonly error: string | null;
    }
  ): ApprovalDto {
    this.database.sqlite
      .prepare(
        `
          UPDATE approvals
          SET status = ?, response_json = ?, error = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        status,
        input.response === null ? null : JSON.stringify(input.response),
        input.error,
        Date.now(),
        id
      );

    return this.get(id);
  }

  private updateApprovalMessagePart(approval: ApprovalDto): void {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT id, app_server_id, thread_id, turn_id, role, status, parts_json, raw_event_ids_json, created_at, updated_at
          FROM messages
          WHERE thread_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(approval.threadId) as MessageRow[];

    for (const row of rows) {
      const parts = JSON.parse(row.parts_json) as MessagePart[];
      let changed = false;
      const updatedParts = parts.map((part) => {
        if (part.type !== "approval" || part.approvalId !== approval.id) {
          return part;
        }

        changed = true;
        return {
          ...part,
          status: approval.status,
          payload: approval.request
        };
      });

      if (!changed) {
        continue;
      }

      this.database.sqlite
        .prepare("UPDATE messages SET parts_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(updatedParts), Date.now(), row.id);
      this.publishMessage(this.getMessage(row.id), "thread.message_updated");
    }
  }

  private getMessage(id: string): ChatMessage {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, app_server_id, thread_id, turn_id, role, status, parts_json, raw_event_ids_json, created_at, updated_at FROM messages WHERE id = ?"
      )
      .get(id) as MessageRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("Message not found");
    }

    return toMessage(row);
  }

  private publishCreated(approval: ApprovalDto): void {
    this.events.publish({
      type: "approval.created",
      appServerId: approval.appServerId,
      threadId: approval.threadId,
      payload: { approval }
    });
  }

  private publishUpdated(approval: ApprovalDto): void {
    this.events.publish({
      type: "approval.updated",
      appServerId: approval.appServerId,
      threadId: approval.threadId,
      payload: { approval }
    });
  }

  private publishMessage(
    message: ChatMessage,
    type: "thread.message_added" | "thread.message_updated"
  ): void {
    this.events.publish({
      type,
      appServerId: message.appServerId,
      threadId: message.threadId,
      payload: { message }
    });
  }
}

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

function buildApprovalResult(kind: string, decision: ApprovalDecision): JsonValue {
  if (
    kind === "item/commandExecution/requestApproval" ||
    kind === "item/fileChange/requestApproval"
  ) {
    return { decision: decision === "approve" ? "acceptForSession" : "deny" };
  }

  if (kind === "execCommandApproval" || kind === "applyPatchApproval") {
    return { decision: decision === "approve" ? "approved_for_session" : "denied" };
  }

  return { decision };
}

function toDto(row: ApprovalRow): ApprovalDto {
  return {
    id: row.id,
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    codexRequestId: row.codex_request_id,
    kind: row.kind,
    status: row.status,
    request: JSON.parse(row.request_json) as unknown,
    response: row.response_json === null ? null : (JSON.parse(row.response_json) as unknown),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

function firstString(value: unknown, ...keys: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function parseRawJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Approval response failed";
}
