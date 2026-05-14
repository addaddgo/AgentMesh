import type {
  AppServerDto,
  ApprovalDto,
  ChatMessage,
  QueueItemDto,
  SseEvent,
  SseEventType,
  TurnDto
} from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { eventBus } from "../services/eventBus";
import { notifyApprovalRequired, notifyThreadReady } from "../services/notifications";
import { sseClient, type SseConnectionState } from "../services/sse";
import { useAppServerStore } from "./appServers";
import { useApprovalStore } from "./approvals";
import { notifyError, notifyErrorMessage, notifyInfo } from "./errors";
import { useMessageStore } from "./messages";
import { useThreadReadyStore } from "./threadReady";
import { useThreadStore } from "./threads";
import { useUiLayoutStore } from "./uiLayout";
import { useScheduledMessageStore } from "./scheduledMessages";
import { useTodoStore } from "./todos";

type RealtimeState = {
  connected: boolean;
  started: boolean;
  _unsubDispatchers: (() => void) | null;
  notifiedFailedTurnIds: Record<string, true>;
  notifiedFailedQueueItemIds: Record<string, true>;
  notifiedAppServerErrorKeys: Record<string, true>;
  notifiedApprovalIds: Record<string, true>;
};

export const useRealtimeStore = defineStore("realtime", {
  state: (): RealtimeState => ({
    connected: false,
    started: false,
    _unsubDispatchers: null,
    notifiedFailedTurnIds: {},
    notifiedFailedQueueItemIds: {},
    notifiedAppServerErrorKeys: {},
    notifiedApprovalIds: {}
  }),

  actions: {
    start(): void {
      if (this.started) {
        return;
      }

      this.started = true;
      let previousState: SseConnectionState = "closed";

      // Register all event dispatchers
      this._unsubDispatchers = this.registerDispatchers();

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
      this._unsubDispatchers?.();
      this._unsubDispatchers = null;
      this.started = false;
      this.connected = false;
    },

    async reloadOpenState(): Promise<void> {
      const appServers = useAppServerStore();
      const threads = useThreadStore();
      const messages = useMessageStore();
      const approvals = useApprovalStore();
      const threadReady = useThreadReadyStore();

      await appServers.load();
      await approvals.load();
      await Promise.all(
        Object.keys(threads.openThreadIdsByAppServerId).map(async (appServerId) => {
          await threads.loadForAppServer(appServerId);
          await Promise.all(
            (threads.openThreadIdsByAppServerId[appServerId] ?? []).map(async (threadId) => {
              await Promise.all([messages.load(threadId), messages.loadQueue(threadId)]);
              threadReady.prime(threadId);
            })
          );
        })
      );
    },

    registerDispatchers(): () => void {
      const unsubs: (() => void)[] = [];

      // --- AppServer ---
      unsubs.push(
        eventBus.on("app_server.status_changed", async (event) => {
          const appServer = readPayloadField<AppServerDto>(event.payload, "appServer");
          const appServers = useAppServerStore();
          const threads = useThreadStore();
          const approvals = useApprovalStore();

          if (appServer === null) {
            await appServers.load();
          } else {
            appServers.upsert(appServer);
          }

          // App-server state change cascades to threads and approvals
          const appServerId = appServer?.id ?? event.app_server_id;
          if (appServerId !== undefined) {
            await Promise.all([
              threads.loadForAppServer(appServerId),
              approvals.load()
            ]);
            if (appServer?.status === "error" && appServer.lastError !== null) {
              this.notifyAppServerError(appServer);
            }
            for (const threadId of threads.openThreadIdsByAppServerId[appServerId] ?? []) {
              this.evaluateReadyTransition(threadId);
            }
          }
        })
      );

      // --- Thread list ---
      unsubs.push(
        eventBus.on("thread.list_changed", async (event) => {
          if (event.app_server_id !== undefined) {
            const threads = useThreadStore();
            await threads.loadForAppServer(event.app_server_id);
          }
        })
      );

      // --- Thread imported / gone ---
      unsubs.push(
        eventBus.on(["thread.imported", "thread.gone"], async (event) => {
          if (event.thread_id !== undefined) {
            const threads = useThreadStore();
            const thread = await apiClient.getThread(event.thread_id);
            threads.upsertThread(thread);
          }
        })
      );

      // --- Messages ---
      unsubs.push(
        eventBus.on(["thread.message_added", "thread.message_updated"], async (event) => {
          const message = readPayloadField<ChatMessage>(event.payload, "message");
          const messages = useMessageStore();
          if (message !== null) {
            messages.upsertMessage(message);
            this.evaluateReadyTransition(message.threadId);
          } else if (event.thread_id !== undefined) {
            await messages.load(event.thread_id);
            this.evaluateReadyTransition(event.thread_id);
          }
        })
      );

      // --- Queue item ---
      unsubs.push(
        eventBus.on("queue.item_updated", async (event) => {
          const item = readPayloadField<QueueItemDto>(event.payload, "item");
          const messages = useMessageStore();
          if (item !== null) {
            messages.upsertQueueItem(item);
            if (item.status === "failed") {
              this.notifyQueueItemFailed(item);
            }
            this.evaluateReadyTransition(item.threadId);
          } else if (event.thread_id !== undefined) {
            await messages.loadQueue(event.thread_id);
            this.evaluateReadyTransition(event.thread_id);
          }
        })
      );

      // --- Turn status ---
      unsubs.push(
        eventBus.on("turn.status_changed", async (event) => {
          const turn = readPayloadField<TurnDto>(event.payload, "turn");
          const messages = useMessageStore();
          const threads = useThreadStore();
          if (turn !== null) {
            const previousStatus = messages.turnsById[turn.id]?.status ?? null;
            messages.upsertTurn(turn);
            if (turn.status === "failed" && previousStatus !== "failed") {
              this.notifyTurnFailed(turn);
            }
            // Completed/failed turns imply thread status may have changed
            if (["completed", "failed"].includes(turn.status)) {
              try {
                const thread = await apiClient.getThread(turn.threadId);
                threads.upsertThread(thread);
              } catch {
                // Thread may already be gone
              }
            }
            this.evaluateReadyTransition(turn.threadId);
          }
        })
      );

      // --- Approvals ---
      unsubs.push(
        eventBus.on(["approval.created", "approval.updated"], async (event) => {
          const approval = readPayloadField<ApprovalDto>(event.payload, "approval");
          const approvals = useApprovalStore();
          if (approval !== null) {
            approvals.upsert(approval);
            if (event.type === "approval.created") {
              this.notifyApprovalCreated(approval);
            }
            this.evaluateReadyTransition(approval.threadId);
          } else {
            await approvals.load();
            if (event.thread_id !== undefined) {
              this.evaluateReadyTransition(event.thread_id);
            }
          }
        })
      );

      // --- Todo ---
      unsubs.push(
        eventBus.on("todo.updated", async () => {
          const todoStore = useTodoStore();
          await todoStore.load();
        })
      );

      // --- Scheduled messages ---
      unsubs.push(
        eventBus.on("scheduled_message.updated", async () => {
          const scheduledMessages = useScheduledMessageStore();
          await scheduledMessages.load();
        })
      );

      // --- Error ---
      unsubs.push(
        eventBus.on("error", async (event) => {
          notifyErrorMessage(
            readPayloadField<string>(event.payload, "message") ?? "Backend event error",
            "Backend Error"
          );
        })
      );

      return () => {
        for (const unsub of unsubs) {
          unsub();
        }
      };
    },

    evaluateReadyTransition(threadId: string): void {
      const threadReady = useThreadReadyStore();
      const threads = useThreadStore();
      const transition = threadReady.evaluate(threadId);
      if (!transition.becameReady) {
        return;
      }

      const info = threadReady.threadInfo(threadId);
      if (info === null) {
        return;
      }

      const openThreadIds = threads.openThreadIdsByAppServerId[info.thread.appServerId] ?? [];
      const isOpen = openThreadIds.includes(threadId);
      const isFocused = threads.focusedThreadIdByAppServerId[info.thread.appServerId] === threadId;
      if (!isOpen || !isFocused) {
        return;
      }

      notifyThreadReady(info.thread, info.appServer);
    },

    notifyTurnFailed(turn: TurnDto): void {
      if (this.notifiedFailedTurnIds[turn.id] === true) {
        return;
      }

      this.notifiedFailedTurnIds[turn.id] = true;
      const threads = useThreadStore();
      const appServers = useAppServerStore();
      const thread = threads.threadById(turn.threadId);
      const appServer = appServers.appServers.find((candidate) => candidate.id === turn.appServerId);
      const threadLabel =
        thread === null
          ? "Thread failed"
          : `${appServer?.name ?? "AppServer"} / ${thread.threadName}${thread.agentName === null ? "" : ` / ${thread.agentName}`}`;

      notifyError(turn.error ?? "Codex turn failed.", threadLabel);
    },

    notifyApprovalCreated(approval: ApprovalDto): void {
      if (approval.status !== "pending" || this.notifiedApprovalIds[approval.id] === true) {
        return;
      }

      this.notifiedApprovalIds[approval.id] = true;
      const threads = useThreadStore();
      const appServers = useAppServerStore();
    notifyApprovalRequired(
      approval,
      threads.threadById(approval.threadId),
      appServers.appServers.find((candidate) => candidate.id === approval.appServerId) ?? null
      );
    },

    notifyQueueItemFailed(item: QueueItemDto): void {
      if (this.notifiedFailedQueueItemIds[item.id] === true) {
        return;
      }

      this.notifiedFailedQueueItemIds[item.id] = true;
      const threads = useThreadStore();
      const appServers = useAppServerStore();
      const thread = threads.threadById(item.threadId);
      const appServer = appServers.appServers.find((candidate) => candidate.id === item.appServerId);
      const title =
        thread === null
          ? "Workspace task failed"
          : `${appServer?.name ?? "Workspace"} / ${thread.threadName}`;
      notifyErrorMessage(item.error ?? "Workspace task failed.", title);
    },

    notifyAppServerError(appServer: AppServerDto): void {
      if (appServer.lastError === null) {
        return;
      }

      const key = `${appServer.id}:${appServer.lastError}`;
      if (this.notifiedAppServerErrorKeys[key] === true) {
        return;
      }

      this.notifiedAppServerErrorKeys[key] = true;
      notifyErrorMessage(appServer.lastError, `${appServer.name} failed`);
    }
  }
});

function readPayloadField<T>(payload: unknown, key: string): T | null {
  if (payload === null || typeof payload !== "object" || !(key in payload)) {
    return null;
  }

  return (payload as Record<string, unknown>)[key] as T;
}
