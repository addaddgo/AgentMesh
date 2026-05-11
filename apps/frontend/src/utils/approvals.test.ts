import type { ApprovalDto } from "@agentmesh/shared";
import { describe, expect, it } from "vitest";

import { approvalDetails, approvalStateText } from "./approvals";

describe("approval helpers", () => {
  it("summarizes important payload fields from JSON-RPC approval requests", () => {
    const approval = approvalDto({
      request: {
        jsonrpc: "2.0",
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "pnpm test",
          reason: "verify the change",
          threadId: "codex-thread-1"
        }
      }
    });

    expect(approvalDetails(approval)).toEqual(
      expect.arrayContaining([
        { label: "Kind", value: "item/commandExecution/requestApproval" },
        { label: "Command", value: "pnpm test" },
        { label: "Reason", value: "verify the change" },
        { label: "Thread Id", value: "codex-thread-1" }
      ])
    );
  });

  it("reports terminal approval states as no longer editable", () => {
    expect(approvalStateText(approvalDto({ status: "approved" }))).toContain("can no longer");
    expect(approvalStateText(approvalDto({ status: "expired" }))).toContain("Expired");
    expect(approvalStateText(approvalDto({ status: "failed", error: "transport closed" }))).toBe(
      "transport closed"
    );
  });
});

function approvalDto(overrides: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: "approval-id",
    appServerId: "app-server-id",
    threadId: "thread-id",
    turnId: null,
    codexRequestId: "approval-1",
    kind: "item/commandExecution/requestApproval",
    status: "pending",
    request: {},
    response: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}
