import type {
  AppServerDto,
  ApprovalDto,
  ChatMessage,
  QueueItemDto,
  SseEvent,
  TurnDto
} from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { sseClient, type SseConnectionState } from "../services/sse";
import { useAppServerStore } from "./appServers";
import { useApprovalStore } from "./approvals";
import { notifyError, notifyInfo } from "./errors";
import { useMessageStore } from "./messages";
import { useThreadStore } from "./threads";
import { useUiLayoutStore } from "./uiLayout";
import { useTodoStore } from "./todos";

type RealtimeState = {
  connected: boolean;
  started: boolean;
};

export const useRealtimeStore = defineStore("realtime", {
  state: (): RealtimeState => ({
    connected: false,
    started: false
  }),

  actions: {
    start(): void {
      if (this.started) {
        return;
      }

      this.started = true;
      let previousState: SseConnectionState = "closed";

      sseClient.subscribe((event) => {
        void this.handleEvent(event);
      });

      sseClient.subscribeState((state) => {
        const uiLayout = useUiLayoutStore();
        uiLayout.setSseState(state);
        this.connected = state === "open";

        if (state === "open" && previousState === "reconnecting") {
          void this.reloadOpenState();
          notifyInfo("Reconnected to realtime events.");
        }

        previousState = state;
      });

      sseClient.connect();
    },

    stop(): void {
      sseClient.close();
      this.started = false;
      this.connected = false;
    },

    async reloadOpenState(): Promise<void> {
      const appServers = useAppServerStore();
      const threads = useThreadStore();
      const messages = useMessageStore();
      const approvals = useApprovalStore();

      await appServers.load();
      await approvals.load();
      await Promise.all(
        Object.keys(threads.openThreadIdsByAppServerId).map(async (appServerId) => {
          await threads.loadForAppServer(appServerId);
          await Promise.all(
            (threads.openThreadIdsByAppServerId[appServerId] ?? []).map(async (threadId) => {
              await Promise.all([messages.load(threadId), messages.loadQueue(threadId)]);
            })
          );
        })
      );
    },

    async handleEvent(event: SseEvent): Promise<void> {
      const appServers = useAppServerStore();
      const threads = useThreadStore();
      const messages = useMessageStore();
      const approvals = useApprovalStore();

      try {
        switch (event.type) {
          case "app_server.status_changed": {
            const appServer = readPayloadField<AppServerDto>(event.payload, "appServer");
            if (appServer === null) {
              await appServers.load();
            } else {
              appServers.upsert(appServer);
            }
            break;
          }
          case "thread.list_changed": {
            if (event.app_server_id !== undefined) {
              await threads.loadForAppServer(event.app_server_id);
            }
            break;
          }
          case "thread.imported":
          case "thread.gone": {
            if (event.thread_id !== undefined) {
              const thread = await apiClient.getThread(event.thread_id);
              threads.upsertThread(thread);
            }
            break;
          }
          case "thread.message_added":
          case "thread.message_updated": {
            const message = readPayloadField<ChatMessage>(event.payload, "message");
            if (message !== null) {
              messages.upsertMessage(message);
            } else if (event.thread_id !== undefined) {
              await messages.load(event.thread_id);
            }
            break;
          }
          case "turn.status_changed": {
            const turn = readPayloadField<TurnDto>(event.payload, "turn");
            if (turn !== null) {
              messages.upsertTurn(turn);
              if (["completed", "failed"].includes(turn.status)) {
                const thread = await apiClient.getThread(turn.threadId);
                threads.upsertThread(thread);
              }
            }
            break;
          }
          case "approval.created":
          case "approval.updated": {
            const approval = readPayloadField<ApprovalDto>(event.payload, "approval");
            if (approval !== null) {
              approvals.upsert(approval);
            } else {
              await approvals.load();
            }
            break;
          }
          case "queue.item_updated": {
            const item = readPayloadField<QueueItemDto>(event.payload, "item");
            if (item !== null) {
              messages.upsertQueueItem(item);
            } else if (event.thread_id !== undefined) {
              await messages.loadQueue(event.thread_id);
            }
            break;
          }
          case "error": {
            notifyError(
              readPayloadField<string>(event.payload, "message") ?? "Backend event error"
            );
            break;
          }
          case "skill.sync_completed":
            break;
          case "todo.updated": {
            const todoStore = useTodoStore();
            await todoStore.load();
            break;
          }
        }
      } catch (error) {
        notifyError(error, "Failed to process realtime event");
      }
    }
  }
});

function readPayloadField<T>(payload: unknown, key: string): T | null {
  if (payload === null || typeof payload !== "object" || !(key in payload)) {
    return null;
  }

  return (payload as Record<string, unknown>)[key] as T;
}
