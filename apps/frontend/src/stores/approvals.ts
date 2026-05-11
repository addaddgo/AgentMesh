import type { ApprovalDecision, ApprovalDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type ApprovalState = {
  approvals: ApprovalDto[];
  loading: boolean;
  respondingById: Record<string, boolean>;
};

export const useApprovalStore = defineStore("approvals", {
  state: (): ApprovalState => ({
    approvals: [],
    loading: false,
    respondingById: {}
  }),

  getters: {
    pending(state): ApprovalDto[] {
      return state.approvals.filter((approval) => approval.status === "pending");
    },
    byThreadId:
      (state) =>
      (threadId: string): ApprovalDto[] => {
        return state.approvals
          .filter((approval) => approval.threadId === threadId)
          .sort(compareApprovals);
      },
    isResponding:
      (state) =>
      (id: string): boolean => {
        return state.respondingById[id] === true;
      }
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.approvals = [...(await apiClient.listApprovals())].sort(compareApprovals);
      } catch (error) {
        notifyError(error, "Failed to load approvals");
      } finally {
        this.loading = false;
      }
    },

    async loadForThread(threadId: string): Promise<void> {
      this.loading = true;
      try {
        const approvals = await apiClient.listApprovals({ threadId });
        const otherApprovals = this.approvals.filter((approval) => approval.threadId !== threadId);
        this.approvals = [...otherApprovals, ...approvals].sort(compareApprovals);
      } catch (error) {
        notifyError(error, "Failed to load approvals");
      } finally {
        this.loading = false;
      }
    },

    async respond(id: string, decision: ApprovalDecision): Promise<void> {
      this.respondingById[id] = true;
      try {
        this.upsert(await apiClient.respondApproval(id, decision));
      } catch (error) {
        notifyError(error, "Failed to respond to approval");
      } finally {
        this.respondingById[id] = false;
      }
    },

    upsert(approval: ApprovalDto): void {
      const index = this.approvals.findIndex((existing) => existing.id === approval.id);
      if (index === -1) {
        this.approvals = [...this.approvals, approval].sort(compareApprovals);
      } else {
        this.approvals.splice(index, 1, approval);
        this.approvals.sort(compareApprovals);
      }
    }
  }
});

function compareApprovals(left: ApprovalDto, right: ApprovalDto): number {
  if (left.status === "pending" && right.status !== "pending") {
    return -1;
  }
  if (left.status !== "pending" && right.status === "pending") {
    return 1;
  }
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}
