import type { AppServerDto, ThreadDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { useAppServerStore } from "./appServers";
import { useApprovalStore } from "./approvals";
import { useMessageStore } from "./messages";
import { useThreadStore } from "./threads";

type ThreadReadyState = {
  readyByThreadId: Record<string, boolean>;
  pulseKeyByThreadId: Record<string, number>;
  observedThreadIds: Record<string, boolean>;
};

export const useThreadReadyStore = defineStore("threadReady", {
  state: (): ThreadReadyState => ({
    readyByThreadId: {},
    pulseKeyByThreadId: {},
    observedThreadIds: {}
  }),

  actions: {
    prime(threadId: string): void {
      this.readyByThreadId[threadId] = this.computeReady(threadId);
      this.observedThreadIds[threadId] = true;
    },

    evaluate(threadId: string): { readonly becameReady: boolean; readonly ready: boolean } {
      const ready = this.computeReady(threadId);
      const observed = this.observedThreadIds[threadId] === true;
      const previousReady = this.readyByThreadId[threadId];

      this.readyByThreadId[threadId] = ready;
      this.observedThreadIds[threadId] = true;

      if (!observed) {
        return { becameReady: false, ready };
      }

      const becameReady = previousReady === false && ready === true;
      if (becameReady) {
        this.pulseKeyByThreadId[threadId] = (this.pulseKeyByThreadId[threadId] ?? 0) + 1;
      }

      return { becameReady, ready };
    },

    threadInfo(
      threadId: string
    ): { readonly thread: ThreadDto; readonly appServer: AppServerDto } | null {
      const threads = useThreadStore();
      const appServers = useAppServerStore();
      const thread = threads.threadById(threadId);
      if (thread === null) {
        return null;
      }

      const appServer = appServers.appServers.find((candidate) => candidate.id === thread.appServerId);
      if (appServer === undefined) {
        return null;
      }

      return { thread, appServer };
    },

    computeReady(threadId: string): boolean {
      const threads = useThreadStore();
      const messages = useMessageStore();
      const approvals = useApprovalStore();
      const appServers = useAppServerStore();

      const thread = threads.threadById(threadId);
      if (thread === null || thread.isGone || thread.status === "notLoaded") {
        return false;
      }

      const appServer = appServers.appServers.find((candidate) => candidate.id === thread.appServerId);
      if (appServer === undefined || appServer.status !== "online") {
        return false;
      }

      const hasActiveMessage = (messages.byThreadId[threadId] ?? []).some((message) =>
        ["pending", "queued", "sent", "streaming"].includes(message.status)
      );
      if (hasActiveMessage) {
        return false;
      }

      const hasActiveQueueItem = (messages.queueItemIdsByThreadId[threadId] ?? [])
        .map((id) => messages.queueItemsById[id])
        .some(
          (item) => item !== undefined && ["pending", "running", "waiting_approval"].includes(item.status)
        );
      if (hasActiveQueueItem) {
        return false;
      }

      const hasPendingApproval = approvals.byThreadId(threadId).some(
        (approval) => approval.status === "pending"
      );
      return !hasPendingApproval;
    }
  }
});
