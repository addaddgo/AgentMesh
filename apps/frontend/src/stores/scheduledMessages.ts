import type {
  ScheduledMessageCreateRequest,
  ScheduledMessageDto,
  ScheduledMessageUpdateRequest
} from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type ScheduledMessageState = {
  items: ScheduledMessageDto[];
  loading: boolean;
};

export const useScheduledMessageStore = defineStore("scheduledMessages", {
  state: (): ScheduledMessageState => ({
    items: [],
    loading: false
  }),

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.items = [...(await apiClient.listScheduledMessages())];
      } catch (error) {
        notifyError(error, "Failed to load scheduled messages");
      } finally {
        this.loading = false;
      }
    },

    async create(payload: ScheduledMessageCreateRequest): Promise<ScheduledMessageDto | null> {
      try {
        const item = await apiClient.createScheduledMessage(payload);
        this.upsert(item);
        return item;
      } catch (error) {
        notifyError(error, "Failed to schedule message");
        return null;
      }
    },

    async update(
      id: string,
      payload: ScheduledMessageUpdateRequest
    ): Promise<ScheduledMessageDto | null> {
      try {
        const item = await apiClient.updateScheduledMessage(id, payload);
        this.upsert(item);
        return item;
      } catch (error) {
        notifyError(error, "Failed to update scheduled message");
        return null;
      }
    },

    async cancel(id: string): Promise<ScheduledMessageDto | null> {
      try {
        const item = await apiClient.cancelScheduledMessage(id);
        this.upsert(item);
        return item;
      } catch (error) {
        notifyError(error, "Failed to cancel scheduled message");
        return null;
      }
    },

    async remove(id: string): Promise<boolean> {
      try {
        await apiClient.deleteScheduledMessage(id);
        this.items = this.items.filter((existing) => existing.id !== id);
        return true;
      } catch (error) {
        notifyError(error, "Failed to delete scheduled message");
        return false;
      }
    },

    upsert(item: ScheduledMessageDto): void {
      const next = [...this.items];
      const index = next.findIndex((existing) => existing.id === item.id);
      if (index === -1) {
        next.push(item);
      } else {
        next.splice(index, 1, item);
      }
      this.items = sortScheduledMessages(next);
    },

    removeLocal(id: string): void {
      this.items = this.items.filter((existing) => existing.id !== id);
    }
  }
});

function sortScheduledMessages(items: readonly ScheduledMessageDto[]): ScheduledMessageDto[] {
  const statusOrder: Record<ScheduledMessageDto["status"], number> = {
    scheduled: 0,
    sending: 1,
    failed: 2,
    sent: 3,
    canceled: 4
  };

  return [...items].sort((left, right) => {
    const byStatus = statusOrder[left.status] - statusOrder[right.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    if (left.runAt !== right.runAt) {
      return left.runAt - right.runAt;
    }
    return right.createdAt - left.createdAt;
  });
}
