import type {
  TodoCreateRequest,
  TodoItemDto,
  TodoReorderRequest,
  TodoTagImportance,
  TodoTagRuleDto,
  TodoUpdateRequest
} from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyTodoDeadline } from "../services/notifications";
import { notifyError } from "./errors";

type TodoState = {
  items: TodoItemDto[];
  categories: string[];
  tagRules: TodoTagRuleDto[];
  loading: boolean;
  deadlineWatcherStarted: boolean;
  notifiedDeadlineKeys: Record<string, true>;
  focusedTodoId: string | null;
  focusRequestKey: number;
};

const TODO_DEADLINE_NOTIFICATIONS_STORAGE_KEY = "todoDeadlineNotifications";
let deadlineWatcherTimer: number | null = null;

export const useTodoStore = defineStore("todos", {
  state: (): TodoState => ({
    items: [],
    categories: [],
    tagRules: [],
    loading: false,
    deadlineWatcherStarted: false,
    notifiedDeadlineKeys: {},
    focusedTodoId: null,
    focusRequestKey: 0
  }),

  actions: {
    async loadCategories(): Promise<void> {
      try {
        const [categories, tagRules] = await Promise.all([
          apiClient.listTodoCategories(),
          apiClient.listTodoTagRules()
        ]);
        this.categories = [...categories];
        this.tagRules = [...tagRules];
      } catch (error) {
        notifyError(error, "Failed to load todo categories");
      }
    },

    async load(): Promise<void> {
      this.loading = true;
      try {
        const [items, categories, tagRules] = await Promise.all([
          apiClient.listTodos(),
          apiClient.listTodoCategories(),
          apiClient.listTodoTagRules()
        ]);
        this.items = [...items];
        this.categories = [...categories];
        this.tagRules = [...tagRules];
        this.evaluateDeadlineNotifications();
      } catch (error) {
        notifyError(error, "Failed to load todos");
      } finally {
        this.loading = false;
      }
    },

    async create(payload: TodoCreateRequest): Promise<TodoItemDto> {
      const item = await apiClient.createTodo(payload);
      this.items = [...this.items, item];
      await this.loadCategories();
      this.evaluateDeadlineNotifications();
      return item;
    },

    async update(id: string, payload: TodoUpdateRequest): Promise<void> {
      const item = await apiClient.updateTodo(id, payload);
      this.items = this.items.map((existing) => (existing.id === id ? item : existing));
      await this.loadCategories();
      this.evaluateDeadlineNotifications();
    },

    async remove(id: string): Promise<void> {
      await apiClient.deleteTodo(id);
      this.items = this.items.filter((existing) => existing.id !== id);
      await this.loadCategories();
    },

    async upsertTagRule(name: string, importance: TodoTagImportance): Promise<void> {
      const rule = await apiClient.upsertTodoTagRule(name, { importance });
      const next = this.tagRules.filter((existing) => existing.name !== rule.name);
      next.push(rule);
      next.sort((left, right) => left.name.localeCompare(right.name));
      this.tagRules = next;
    },

    async removeTagRule(name: string): Promise<void> {
      await apiClient.deleteTodoTagRule(name);
      this.tagRules = this.tagRules.filter((rule) => rule.name !== name);
    },

    async renameTagRule(name: string, nextName: string): Promise<void> {
      const rule = await apiClient.renameTodoTagRule(name, { nextName });
      this.tagRules = this.tagRules
        .filter((existing) => existing.name !== name && existing.name !== rule.name)
        .concat(rule)
        .sort((left, right) => left.name.localeCompare(right.name));
      this.items = this.items.map((item) => ({
        ...item,
        tags: item.tags.map((tag) => (tag === name ? rule.name : tag))
      }));
    },

    requestFocus(id: string): void {
      this.focusedTodoId = id;
      this.focusRequestKey += 1;
    },

    async reorder(ids: readonly string[]): Promise<void> {
      const items = await apiClient.reorderTodos({ ids });
      this.items = [...items];
    },

    async ensureDeadlineWatcher(): Promise<void> {
      if (typeof window === "undefined" || this.deadlineWatcherStarted) {
        return;
      }

      this.deadlineWatcherStarted = true;
      this.notifiedDeadlineKeys = readNotifiedDeadlineKeys();
      await this.load();
      this.evaluateDeadlineNotifications();
      deadlineWatcherTimer = window.setInterval(() => {
        this.evaluateDeadlineNotifications();
      }, 30_000);
    },

    evaluateDeadlineNotifications(): void {
      if (typeof window === "undefined") {
        return;
      }

      const now = Date.now();
      for (const item of this.items) {
        if (item.done || item.dueAt === null || item.dueAt > now) {
          continue;
        }

        const key = deadlineNotificationKey(item);
        if (this.notifiedDeadlineKeys[key] === true) {
          continue;
        }

        notifyTodoDeadline(item);
        this.notifiedDeadlineKeys = {
          ...this.notifiedDeadlineKeys,
          [key]: true
        };
      }

      writeNotifiedDeadlineKeys(this.notifiedDeadlineKeys);
    },

    async moveTodo(
      id: string,
      options: {
        readonly category: string | null;
        readonly beforeId?: string | null;
      }
    ): Promise<void> {
      const source = this.items.find((item) => item.id === id);
      if (source === undefined) {
        return;
      }

      const targetCategory = options.category;
      if ((source.category ?? null) !== targetCategory) {
        await this.update(id, { category: targetCategory });
      }

      const ids = this.items.map((item) => item.id);
      const sourceIndex = ids.indexOf(id);
      if (sourceIndex === -1) {
        return;
      }

      ids.splice(sourceIndex, 1);

      const beforeId = options.beforeId ?? null;
      if (beforeId !== null) {
        const targetIndex = ids.indexOf(beforeId);
        if (targetIndex !== -1) {
          ids.splice(targetIndex, 0, id);
          await this.reorder(ids);
          return;
        }
      }

      const categoryItems = this.items.filter(
        (item) => item.id !== id && (item.category ?? null) === targetCategory
      );
      const lastCategoryItem = categoryItems.at(-1);
      if (lastCategoryItem === undefined) {
        ids.push(id);
        await this.reorder(ids);
        return;
      }

      const lastCategoryIndex = ids.indexOf(lastCategoryItem.id);
      ids.splice(lastCategoryIndex + 1, 0, id);
      await this.reorder(ids);
    }
  }
});

function deadlineNotificationKey(item: TodoItemDto): string {
  return `${item.id}:${item.dueAt ?? "none"}`;
}

function readNotifiedDeadlineKeys(): Record<string, true> {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(TODO_DEADLINE_NOTIFICATIONS_STORAGE_KEY);
  if (raw === null) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, true>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeNotifiedDeadlineKeys(keys: Record<string, true>): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(TODO_DEADLINE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(keys));
}
