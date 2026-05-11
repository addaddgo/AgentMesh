import type { ThreadDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type ThreadState = {
  byAppServerId: Record<string, ThreadDto[]>;
  loadingByAppServerId: Record<string, boolean>;
  openThreadIdsByAppServerId: Record<string, string[]>;
  focusedThreadIdByAppServerId: Record<string, string | null>;
};

export const useThreadStore = defineStore("threads", {
  state: (): ThreadState => ({
    byAppServerId: {},
    loadingByAppServerId: {},
    openThreadIdsByAppServerId: {},
    focusedThreadIdByAppServerId: {}
  }),

  getters: {
    threadById:
      (state) =>
      (threadId: string): ThreadDto | null => {
        for (const threads of Object.values(state.byAppServerId)) {
          const thread = threads.find((candidate) => candidate.id === threadId);
          if (thread !== undefined) {
            return thread;
          }
        }
        return null;
      }
  },

  actions: {
    async loadForAppServer(appServerId: string): Promise<void> {
      this.loadingByAppServerId[appServerId] = true;
      try {
        this.byAppServerId[appServerId] = [...(await apiClient.listThreads(appServerId))];
      } catch (error) {
        notifyError(error, "Failed to load threads");
      } finally {
        this.loadingByAppServerId[appServerId] = false;
      }
    },

    async sync(appServerId: string): Promise<void> {
      try {
        const response = await apiClient.syncThreads(appServerId);
        this.byAppServerId[appServerId] = [...response.threads];
      } catch (error) {
        notifyError(error, "Failed to sync threads");
      }
    },

    async createThread(appServerId: string, name: string): Promise<ThreadDto | null> {
      try {
        const thread = await apiClient.createThread(appServerId, { name });
        this.upsertThread(thread);
        this.focusThread(appServerId, thread.id);
        return thread;
      } catch (error) {
        notifyError(error, "Failed to create thread");
        return null;
      }
    },

    async resumeThread(thread: ThreadDto): Promise<ThreadDto | null> {
      try {
        const resumed = await apiClient.resumeThread(thread.appServerId, thread.id);
        this.upsertThread(resumed);
        this.focusThread(resumed.appServerId, resumed.id);
        return resumed;
      } catch (error) {
        notifyError(error, "Failed to resume thread");
        return null;
      }
    },

    async openThread(thread: ThreadDto): Promise<void> {
      this.rememberOpenThread(thread);

      try {
        const response = await apiClient.importThread(thread.id);
        this.upsertThread(response.thread);
      } catch (error) {
        notifyError(error, "Failed to import thread");
      }
    },

    rememberOpenThread(thread: ThreadDto): void {
      const openIds = this.openThreadIdsByAppServerId[thread.appServerId] ?? [];
      if (!openIds.includes(thread.id)) {
        this.openThreadIdsByAppServerId[thread.appServerId] = [...openIds, thread.id];
      }
      this.focusedThreadIdByAppServerId[thread.appServerId] = thread.id;
    },

    focusThread(appServerId: string, threadId: string | null): void {
      this.focusedThreadIdByAppServerId[appServerId] = threadId;
    },

    upsertThread(thread: ThreadDto): void {
      const threads = this.byAppServerId[thread.appServerId] ?? [];
      const index = threads.findIndex((existing) => existing.id === thread.id);
      this.byAppServerId[thread.appServerId] =
        index === -1
          ? [...threads, thread]
          : threads.map((existing) => (existing.id === thread.id ? thread : existing));
    }
  }
});
