import type { AppServerDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient, type CreateAppServerPayload, type PatchAppServerPayload } from "../api/client";
import { notifyError } from "./errors";
import { useThreadStore } from "./threads";

type AppServerState = {
  appServers: AppServerDto[];
  loading: boolean;
  selectedAppServerId: string | null;
};

export const useAppServerStore = defineStore("appServers", {
  state: (): AppServerState => ({
    appServers: [],
    loading: false,
    selectedAppServerId: null
  }),

  getters: {
    selectedAppServer(state): AppServerDto | null {
      return state.appServers.find((server) => server.id === state.selectedAppServerId) ?? null;
    }
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.appServers = [...(await apiClient.listAppServers())];
        if (
          this.selectedAppServerId === null ||
          !this.appServers.some((server) => server.id === this.selectedAppServerId)
        ) {
          this.selectedAppServerId = this.appServers[0]?.id ?? null;
        }
      } catch (error) {
        notifyError(error, "Failed to load app servers");
      } finally {
        this.loading = false;
      }
    },

    async create(payload: CreateAppServerPayload): Promise<AppServerDto | null> {
      try {
        const created = await apiClient.createAppServer(payload);
        this.upsert(created);
        this.selectedAppServerId = created.id;
        return created;
      } catch (error) {
        notifyError(error, "Failed to create app server");
        return null;
      }
    },

    async update(id: string, payload: PatchAppServerPayload): Promise<AppServerDto | null> {
      try {
        const updated = await apiClient.updateAppServer(id, payload);
        this.upsert(updated);
        return updated;
      } catch (error) {
        notifyError(error, "Failed to update app server");
        return null;
      }
    },

    async start(id: string): Promise<void> {
      await this.runLifecycleAction(
        id,
        () => apiClient.startAppServer(id),
        "Failed to start app server",
        { refreshThreads: true }
      );
    },

    async stop(id: string): Promise<void> {
      await this.runLifecycleAction(
        id,
        () => apiClient.stopAppServer(id),
        "Failed to stop app server"
      );
    },

    async restart(id: string): Promise<void> {
      await this.runLifecycleAction(
        id,
        () => apiClient.restartAppServer(id),
        "Failed to restart app server",
        { refreshThreads: true }
      );
    },

    select(id: string | null): void {
      this.selectedAppServerId = id;
    },

    upsert(appServer: AppServerDto): void {
      const index = this.appServers.findIndex((existing) => existing.id === appServer.id);
      if (index === -1) {
        this.appServers.push(appServer);
      } else {
        this.appServers.splice(index, 1, appServer);
      }
    },

    async runLifecycleAction(
      _id: string,
      action: () => Promise<AppServerDto>,
      errorTitle: string,
      options: { readonly refreshThreads?: boolean } = {}
    ): Promise<void> {
      try {
        const appServer = await action();
        this.upsert(appServer);
        if (options.refreshThreads === true) {
          await useThreadStore().loadForAppServer(appServer.id);
        }
      } catch (error) {
        notifyError(error, errorTitle);
      }
    }
  }
});
