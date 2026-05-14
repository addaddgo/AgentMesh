import type {
  ChatMessage,
  PendingImageUploadDto,
  QueueItemDto,
  SendMessageResponse,
  TurnDto
} from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type MessageState = {
  byThreadId: Record<string, ChatMessage[]>;
  loadingByThreadId: Record<string, boolean>;
  queueItemsById: Record<string, QueueItemDto>;
  queueItemIdsByThreadId: Record<string, string[]>;
  turnsById: Record<string, TurnDto>;
};

export const useMessageStore = defineStore("messages", {
  state: (): MessageState => ({
    byThreadId: {},
    loadingByThreadId: {},
    queueItemsById: {},
    queueItemIdsByThreadId: {},
    turnsById: {}
  }),

  actions: {
    async load(threadId: string): Promise<void> {
      this.loadingByThreadId[threadId] = true;
      try {
        this.byThreadId[threadId] = [...(await apiClient.listMessages(threadId))];
      } catch (error) {
        notifyError(error, "Failed to load messages");
      } finally {
        this.loadingByThreadId[threadId] = false;
      }
    },

    setThreadMessages(threadId: string, messages: readonly ChatMessage[]): void {
      this.byThreadId[threadId] = [...messages];
    },

    async loadQueue(threadId: string): Promise<void> {
      try {
        const response = await apiClient.listThreadQueue(threadId);
        const previousIds = new Set(this.queueItemIdsByThreadId[threadId] ?? []);
        const nextIds = response.items.map((item) => item.id);

        for (const item of response.items) {
          this.queueItemsById[item.id] = item;
          previousIds.delete(item.id);
        }

        for (const staleId of previousIds) {
          delete this.queueItemsById[staleId];
        }

        this.queueItemIdsByThreadId[threadId] = nextIds;
      } catch (error) {
        notifyError(error, "Failed to load queue status");
      }
    },

    async send(
      threadId: string,
      text: string,
      attachments: readonly PendingImageUploadDto[] = []
    ): Promise<SendMessageResponse | null> {
      try {
        const response = await apiClient.sendMessage({ threadId, text, attachments });
        this.upsertMessage(response.message);
        this.turnsById[response.turn.id] = response.turn;
        this.upsertQueueItem(response.queueItem);
        return response;
      } catch (error) {
        notifyError(error, "Failed to send message");
        return null;
      }
    },

    upsertMessage(message: ChatMessage): void {
      const messages = this.byThreadId[message.threadId] ?? [];
      const index = messages.findIndex((existing) => existing.id === message.id);
      this.byThreadId[message.threadId] =
        index === -1
          ? [...messages, message]
          : messages.map((existing) => (existing.id === message.id ? message : existing));
    },

    upsertQueueItem(item: QueueItemDto): void {
      this.queueItemsById[item.id] = item;
      const ids = this.queueItemIdsByThreadId[item.threadId] ?? [];
      if (!ids.includes(item.id)) {
        this.queueItemIdsByThreadId[item.threadId] = [...ids, item.id];
      }
    },

    upsertTurn(turn: TurnDto): void {
      this.turnsById[turn.id] = turn;
    },

    removeThreads(threadIds: readonly string[]): void {
      const staleThreadIds = new Set(threadIds);

      for (const threadId of staleThreadIds) {
        delete this.byThreadId[threadId];
        delete this.loadingByThreadId[threadId];

        const queueItemIds = this.queueItemIdsByThreadId[threadId] ?? [];
        for (const queueItemId of queueItemIds) {
          delete this.queueItemsById[queueItemId];
        }
        delete this.queueItemIdsByThreadId[threadId];
      }

      for (const [turnId, turn] of Object.entries(this.turnsById)) {
        if (staleThreadIds.has(turn.threadId)) {
          delete this.turnsById[turnId];
        }
      }
    }
  }
});
