import type { TodoItemDto, TodoCreateRequest, TodoUpdateRequest, TodoReorderRequest } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type TodoState = {
  items: TodoItemDto[];
  loading: boolean;
};

export const useTodoStore = defineStore("todos", {
  state: (): TodoState => ({
    items: [],
    loading: false
  }),

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.items = [...(await apiClient.listTodos())];
      } catch (error) {
        notifyError(error, "Failed to load todos");
      } finally {
        this.loading = false;
      }
    },

    async create(payload: TodoCreateRequest): Promise<TodoItemDto> {
      const item = await apiClient.createTodo(payload);
      this.items = [...this.items, item];
      return item;
    },

    async update(id: string, payload: TodoUpdateRequest): Promise<void> {
      const item = await apiClient.updateTodo(id, payload);
      this.items = this.items.map((existing) => (existing.id === id ? item : existing));
    },

    async remove(id: string): Promise<void> {
      await apiClient.deleteTodo(id);
      this.items = this.items.filter((existing) => existing.id !== id);
    },

    async reorder(ids: readonly string[]): Promise<void> {
      const items = await apiClient.reorderTodos({ ids });
      this.items = [...items];
    }
  }
});
