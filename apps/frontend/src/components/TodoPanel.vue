<template>
  <section
    class="todo-panel"
    :class="`theme-${theme.theme}`"
    :style="todoThemeVars"
    @drop.prevent="onDrop($event)"
    @dragover.prevent="onDragOver"
  >
    <header class="todo-header">
      <h2>Todo</h2>
      <el-button
        size="small"
        type="danger"
        plain
        :icon="CloseBold"
        circle
        title="Close"
        aria-label="Close"
        @click="emit('close')"
      />
    </header>

    <el-input
      v-model="searchQuery"
      size="small"
      placeholder="Search todos…"
      clearable
      class="todo-search"
    />

    <div class="todo-list">
      <template v-for="group in groupedItems" :key="group.key">
        <div
          class="todo-group-header"
          :class="{ collapsed: !expandedGroupNames.has(group.name) }"
          @dragover.prevent="onGroupDragOver($event)"
          @drop.prevent.stop="onGroupDrop($event, group)"
          @click="toggleGroup(group.name)"
        >
          <span class="todo-group-title">
            <span class="todo-group-arrow">{{ expandedGroupNames.has(group.name) ? '▼' : '▶' }}</span>
            <span>{{ group.name }}</span>
          </span>
          <span class="todo-group-stats">OK {{ group.doneCount }} · TODO {{ group.todoCount }}</span>
        </div>
        <template v-if="expandedGroupNames.has(group.name)">
        <article
          v-for="item in group.items"
          :key="item.id"
        class="todo-item"
        :class="{ done: item.done }"
        draggable="true"
        @dragstart="onDragStart($event, item)"
        @dragover.prevent="onItemDragOver($event, item)"
        @drop.prevent.stop="onItemDrop($event, item)"
      >
        <el-checkbox
          :model-value="item.done"
          size="large"
          @change="toggleDone(item)"
        />

        <div class="todo-body">
          <div
            v-if="editingId === item.id && editingField === 'name'"
            class="todo-edit-inline"
          >
            <el-input
              ref="editInput"
              v-model="editValue"
              size="small"
              autofocus
              @blur="commitEdit(item)"
              @keyup.enter="commitEdit(item)"
              @keyup.escape="cancelEdit"
            />
          </div>
          <strong
            v-else
            class="todo-name"
            :class="{ 'is-editable': !item.done }"
            @dblclick="startEdit(item, 'name')"
          >
            {{ item.name }}
          </strong>

          <div
            v-if="editingId === item.id && editingField === 'description'"
            class="todo-edit-inline"
          >
            <el-input
              ref="editInput"
              v-model="editValue"
              size="default"
              type="textarea"
              :rows="2"
              autofocus
              @blur="commitEdit(item)"
              @keyup.enter.ctrl="commitEdit(item)"
              @keyup.escape="cancelEdit"
            />
          </div>
          <div v-else class="todo-description-wrapper">
            <div class="todo-description-row">
              <span
                v-if="item.description"
                class="todo-description"
                :class="{ expanded: expandedIds.has(item.id), 'is-editable': !item.done }"
                @click.stop="toggleExpanded(item.id)"
                @dblclick.stop="startEdit(item, 'description')"
              >
                {{ item.description }}
              </span>
              <span v-else class="todo-description-placeholder" @click.stop="startEdit(item, 'description')">Add description…</span>
            </div>
          </div>
        </div>

        <div class="todo-meta">
          <el-autocomplete
            v-if="editingId === item.id && editingField === 'category'"
            v-model="editValue"
            size="small"
            class="todo-category-input todo-category-inline-input"
            placeholder="Category"
            :fetch-suggestions="fetchCategorySuggestions"
            :trigger-on-focus="true"
            clearable
            @select="commitEdit(item)"
            @blur="commitEdit(item)"
            @keyup.enter="commitEdit(item)"
            @keyup.escape="cancelEdit"
          />
          <el-tag
            v-else-if="item.category"
            size="small"
            class="todo-category-tag"
            @click.stop="startEdit(item, 'category')"
          >
            {{ item.category }}
          </el-tag>
          <button
            v-else
            type="button"
            class="todo-category-add"
            @click.stop="startEdit(item, 'category')"
          >
            Add category
          </button>
          <div class="todo-deadline-controls">
            <el-select
              v-model="deadlineModeValue[item.id]"
              size="small"
              class="todo-deadline-mode"
              :disabled="item.done"
              @change="setItemDeadlineMode(item, $event)"
            >
              <el-option label="No deadline" value="none" />
              <el-option label="Date" value="absolute" />
              <el-option label="Remaining" value="relative" />
            </el-select>
            <el-date-picker
              v-if="deadlineModeValue[item.id] === 'absolute'"
              v-model="datePickerValue[item.id]"
              type="datetime"
              size="small"
              placeholder="Deadline"
              value-format="timestamp"
              :disabled="item.done"
              class="todo-date-picker"
              @change="setDueDate(item, $event)"
            />
            <template v-else-if="deadlineModeValue[item.id] === 'relative'">
              <el-input-number
                v-model="relativeHoursValue[item.id]"
                size="small"
                :min="0"
                :max="999"
                :step="1"
                controls-position="right"
                class="todo-duration-input"
                :disabled="item.done"
                @change="setRelativeDeadline(item)"
              />
              <span class="todo-duration-label">h</span>
              <el-input-number
                v-model="relativeMinutesValue[item.id]"
                size="small"
                :min="0"
                :max="59"
                :step="5"
                controls-position="right"
                class="todo-duration-input todo-duration-input-minutes"
                :disabled="item.done"
                @change="setRelativeDeadline(item)"
              />
              <span class="todo-duration-label">m</span>
            </template>
          </div>

          <el-button
            size="small"
            type="danger"
            plain
            :icon="Delete"
            circle
            title="Delete"
            aria-label="Delete"
            @click="store.remove(item.id)"
          />
        </div>
      </article>
      </template>
      </template>

      <el-empty v-if="filteredItems.length === 0" description="No todos" />
    </div>

    <form class="todo-add-form" @submit.prevent="addTodo">
      <div class="todo-add-row">
        <el-input
          v-model="newName"
          size="small"
          placeholder="Add todo…"
        />
        <el-autocomplete
          v-model="newCategory"
          size="small"
          placeholder="Category (optional)"
          class="todo-category-input"
          :fetch-suggestions="fetchCategorySuggestions"
          :trigger-on-focus="true"
          clearable
        />
      </div>
      <div class="todo-add-row-desc">
        <el-input
          v-model="newDescription"
          size="small"
          placeholder="Description (optional)"
        />
      </div>
      <div class="todo-add-row-deadline">
        <el-select v-model="newDeadlineMode" size="small" class="todo-deadline-mode">
          <el-option label="No deadline" value="none" />
          <el-option label="Date" value="absolute" />
          <el-option label="Remaining" value="relative" />
        </el-select>
        <el-date-picker
          v-if="newDeadlineMode === 'absolute'"
          v-model="newDeadlineAt"
          type="datetime"
          size="small"
          placeholder="Deadline"
          value-format="timestamp"
          class="todo-date-picker"
        />
        <template v-else-if="newDeadlineMode === 'relative'">
          <el-input-number
            v-model="newRelativeHours"
            size="small"
            :min="0"
            :max="999"
            :step="1"
            controls-position="right"
            class="todo-duration-input"
          />
          <span class="todo-duration-label">h</span>
          <el-input-number
            v-model="newRelativeMinutes"
            size="small"
            :min="0"
            :max="59"
            :step="5"
            controls-position="right"
            class="todo-duration-input todo-duration-input-minutes"
          />
          <span class="todo-duration-label">m</span>
        </template>
        <el-button
          size="small"
          class="todo-add-button"
          :icon="Plus"
          circle
          native-type="submit"
          :disabled="!canAddTodo"
          title="Add"
          aria-label="Add"
        />
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { CloseBold, Delete, Plus } from "@element-plus/icons-vue";
import type { TodoDeadlineMode, TodoItemDto } from "@agentmesh/shared";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { useTodoStore } from "../stores/todos";
import { useThemeStore } from "../stores/theme";
import { writeMessageTextDrag } from "../utils/messageDragDrop";

const emit = defineEmits<{
  close: [];
}>();

const store = useTodoStore();
const theme = useThemeStore();
const searchQuery = ref("");
const newName = ref("");
const newDescription = ref("");
const newCategory = ref("");
const newDeadlineMode = ref<TodoDeadlineMode | "none">("none");
const newDeadlineAt = ref<number | null>(null);
const newRelativeHours = ref(1);
const newRelativeMinutes = ref(0);
const editingId = ref<string | null>(null);
const editingField = ref<"name" | "description" | "category" | null>(null);
const editValue = ref("");
const expandedIds = ref(new Set<string>());
const expandedGroupNames = ref(new Set<string>(["Uncategorized"]));
let relativeDeadlineRefreshTimer: number | null = null;

function toggleGroup(name: string): void {
  const next = new Set(expandedGroupNames.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  expandedGroupNames.value = next;
}

function toggleExpanded(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedIds.value = next;
}

const dragItemId = ref<string | null>(null);
const datePickerValue = reactive<Record<string, number | null>>({});
const deadlineModeValue = reactive<Record<string, TodoDeadlineMode | "none">>({});
const relativeHoursValue = reactive<Record<string, number>>({});
const relativeMinutesValue = reactive<Record<string, number>>({});

const groupedItems = computed(() => {
  const groups = new Map<string, TodoItemDto[]>();
  const items = filteredItems.value;
  for (const item of items) {
    const key = item.category || "__uncategorized__";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(item);
  }
  const result: {
    key: string;
    name: string;
    category: string | null;
    items: TodoItemDto[];
    doneCount: number;
    todoCount: number;
  }[] = [];
  for (const [key, items] of groups) {
    const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done));
    result.push({
      key,
      name: key === "__uncategorized__" ? "Uncategorized" : key,
      category: key === "__uncategorized__" ? null : key,
      items: sorted,
      doneCount: sorted.filter((item) => item.done).length,
      todoCount: sorted.filter((item) => !item.done).length
    });
  }
  return result;
});

const todoThemeVars = computed<Record<string, string>>(() => {
  if (theme.theme === "dark") {
    return {
      "--todo-panel-bg": "#252c27",
      "--todo-header-bg": "#214130",
      "--todo-item-bg": "rgba(44, 53, 46, 0.92)",
      "--todo-sticky-bg": "#252c27",
      "--todo-input-bg": "rgba(49, 58, 51, 0.94)",
      "--todo-input-border": "rgba(135, 148, 138, 0.24)",
      "--todo-hover-bg": "color-mix(in srgb, var(--accent-primary) 12%, transparent)",
      "--todo-group-hover-bg": "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
      "--todo-shadow-inset": "color-mix(in srgb, var(--warm-white) 22%, transparent)"
    };
  }

  return {
    "--todo-panel-bg": "#f4f2ea",
    "--todo-header-bg": "#d4edda",
    "--todo-item-bg": "rgba(255, 253, 244, 0.9)",
    "--todo-sticky-bg": "#f4f2ea",
    "--todo-input-bg": "rgba(255, 255, 255, 0.82)",
    "--todo-input-border": "rgba(138, 110, 64, 0.18)",
    "--todo-hover-bg": "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
    "--todo-group-hover-bg": "color-mix(in srgb, var(--accent-primary) 8%, transparent)",
    "--todo-shadow-inset": "color-mix(in srgb, var(--warm-white) 85%, transparent)"
  };
});

const filteredItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (query.length === 0) {
    return store.items;
  }

  return store.items.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
  );
});

const canAddTodo = computed(() => {
  if (newName.value.trim().length === 0) {
    return false;
  }
  if (newDeadlineMode.value === "absolute") {
    return newDeadlineAt.value !== null;
  }
  return true;
});

onMounted(() => {
  void store.load();
  syncTodoDeadlineState();
  relativeDeadlineRefreshTimer = window.setInterval(() => {
    refreshRelativeDeadlineDrafts();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (relativeDeadlineRefreshTimer !== null) {
    window.clearInterval(relativeDeadlineRefreshTimer);
    relativeDeadlineRefreshTimer = null;
  }
});

store.$subscribe((_mutation, _state) => {
  syncTodoDeadlineState();
});

function normalizeCategory(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fetchCategorySuggestions(
  queryString: string,
  callback: (results: Array<{ value: string }>) => void
): void {
  const query = queryString.trim().toLowerCase();
  const results = store.categories
    .filter((category) => query.length === 0 || category.toLowerCase().includes(query))
    .map((category) => ({ value: category }));
  callback(results);
}

function startEdit(item: TodoItemDto, field: "name" | "description" | "category"): void {
  if (item.done) {
    return;
  }

  editingId.value = item.id;
  editingField.value = field;
  if (field === "name") {
    editValue.value = item.name;
    return;
  }
  if (field === "description") {
    editValue.value = item.description;
    return;
  }
  editValue.value = item.category ?? "";
}

function commitEdit(item: TodoItemDto): void {
  if (editingId.value !== item.id || editingField.value === null) {
    return;
  }

  if (editingField.value === "category") {
    const nextCategory = normalizeCategory(editValue.value);
    if (nextCategory !== (item.category ?? null)) {
      void store.update(item.id, { category: nextCategory });
    }
    cancelEdit();
    return;
  }

  const trimmed = editValue.value.trim();
  const currentValue = editingField.value === "name" ? item.name : item.description;
  if (trimmed.length > 0 && trimmed !== currentValue) {
    void store.update(item.id, { [editingField.value]: trimmed });
  }

  cancelEdit();
}

function cancelEdit(): void {
  editingId.value = null;
  editingField.value = null;
  editValue.value = "";
}

async function toggleDone(item: TodoItemDto): Promise<void> {
  await store.update(item.id, { done: !item.done });
}

async function setDueDate(item: TodoItemDto, value: number | null): Promise<void> {
  datePickerValue[item.id] = value;
  await store.update(item.id, {
    dueAt: value,
    deadlineMode: value === null ? null : "absolute",
    relativeDurationMinutes: null
  });
}

async function setItemDeadlineMode(
  item: TodoItemDto,
  mode: TodoDeadlineMode | "none"
): Promise<void> {
  deadlineModeValue[item.id] = mode;
  if (mode === "none") {
    datePickerValue[item.id] = null;
    await store.update(item.id, {
      dueAt: null,
      deadlineMode: null,
      relativeDurationMinutes: null
    });
    return;
  }

  if (mode === "absolute") {
    const dueAt = item.dueAt ?? Date.now() + 60 * 60 * 1000;
    datePickerValue[item.id] = dueAt;
    await store.update(item.id, {
      dueAt,
      deadlineMode: "absolute",
      relativeDurationMinutes: null
    });
    return;
  }

  const duration =
    item.relativeDurationMinutes ?? Math.max(1, Math.ceil(((item.dueAt ?? Date.now()) - Date.now()) / 60_000));
  applyRelativeDraft(item.id, duration);
  const dueAt = Date.now() + duration * 60_000;
  await store.update(item.id, {
    dueAt,
    deadlineMode: "relative",
    relativeDurationMinutes: duration
  });
}

async function setRelativeDeadline(item: TodoItemDto): Promise<void> {
  const hours = normalizeDurationHours(relativeHoursValue[item.id]);
  const minutes = normalizeDurationMinutes(relativeMinutesValue[item.id]);
  relativeHoursValue[item.id] = hours;
  relativeMinutesValue[item.id] = minutes;
  const duration = hours * 60 + minutes;
  const dueAt = Date.now() + duration * 60_000;
  await store.update(item.id, {
    dueAt,
    deadlineMode: "relative",
    relativeDurationMinutes: duration
  });
}

async function addTodo(): Promise<void> {
  const name = newName.value.trim();
  if (name.length === 0) {
    return;
  }

  const description = newDescription.value.trim() || null;
  const category = normalizeCategory(newCategory.value);
  await store.create({
    name,
    description: description || undefined,
    category,
    ...buildNewTodoDeadlinePayload()
  });
  newName.value = "";
  newDescription.value = "";
  newCategory.value = "";
  newDeadlineMode.value = "none";
  newDeadlineAt.value = null;
  newRelativeHours.value = 1;
  newRelativeMinutes.value = 0;
}

function onDragStart(event: DragEvent, item: TodoItemDto): void {
  if (event.dataTransfer === null) {
    return;
  }

  dragItemId.value = item.id;
  const text = `${item.name}\n\n${item.description}`;
  writeMessageTextDrag(event.dataTransfer, text);
}

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "copy";
  }
}

function onItemDragOver(event: DragEvent, item: TodoItemDto): void {
  if (dragItemId.value === null || dragItemId.value === item.id) {
    return;
  }

  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "move";
  }
}

async function onItemDrop(event: DragEvent, target: TodoItemDto): Promise<void> {
  const sourceId = dragItemId.value;
  dragItemId.value = null;

  if (sourceId === null || sourceId === target.id) {
    return;
  }

  await store.moveTodo(sourceId, {
    category: target.category ?? null,
    beforeId: target.id
  });
}

function onGroupDragOver(event: DragEvent): void {
  if (dragItemId.value === null) {
    return;
  }

  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "move";
  }
}

async function onGroupDrop(
  event: DragEvent,
  group: { readonly category: string | null }
): Promise<void> {
  const sourceId = dragItemId.value;
  dragItemId.value = null;

  if (sourceId === null) {
    return;
  }

  await store.moveTodo(sourceId, {
    category: group.category
  });
}

async function onDrop(event: DragEvent): Promise<void> {
  if (event.dataTransfer === null) {
    return;
  }

  // Ignore drops from internal todo drag (handled by onItemDrop)
  if (dragItemId.value !== null) {
    dragItemId.value = null;
    return;
  }

  const text = event.dataTransfer.getData("text/plain");
  if (text.trim().length === 0) {
    return;
  }

  const lines = text.split("\n");
  const name = lines[0]?.trim() ?? "";
  const description = lines.slice(2).join("\n").trim();

  if (name.length === 0) {
    return;
  }

  await store.create({ name, description: description.length > 0 ? description : undefined });
}

function syncTodoDeadlineState(): void {
  const activeIds = new Set<string>();
  for (const item of store.items) {
    activeIds.add(item.id);
    datePickerValue[item.id] = item.dueAt;
    deadlineModeValue[item.id] = normalizeDeadlineMode(item);
    applyRelativeDraft(item.id, relativeMinutesForItem(item));
  }

  for (const id of Object.keys(datePickerValue)) {
    if (!activeIds.has(id)) {
      delete datePickerValue[id];
      delete deadlineModeValue[id];
      delete relativeHoursValue[id];
      delete relativeMinutesValue[id];
    }
  }

  refreshRelativeDeadlineDrafts();
}

function normalizeDeadlineMode(item: TodoItemDto): TodoDeadlineMode | "none" {
  if (item.deadlineMode !== null) {
    return item.deadlineMode;
  }
  return item.dueAt === null ? "none" : "absolute";
}

function relativeMinutesForItem(item: TodoItemDto): number {
  if (normalizeDeadlineMode(item) === "relative" && item.dueAt !== null) {
    return Math.max(0, Math.ceil((item.dueAt - Date.now()) / 60_000));
  }
  if (item.relativeDurationMinutes !== null) {
    return item.relativeDurationMinutes;
  }
  if (item.dueAt === null) {
    return 60;
  }
  return Math.max(0, Math.ceil((item.dueAt - Date.now()) / 60_000));
}

function applyRelativeDraft(id: string, totalMinutes: number): void {
  const normalized = Math.max(0, totalMinutes);
  relativeHoursValue[id] = Math.floor(normalized / 60);
  relativeMinutesValue[id] = normalized % 60;
}

function refreshRelativeDeadlineDrafts(): void {
  for (const item of store.items) {
    if (normalizeDeadlineMode(item) !== "relative") {
      continue;
    }
    applyRelativeDraft(item.id, relativeMinutesForItem(item));
  }
}

function normalizeDurationHours(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeDurationMinutes(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(59, Math.max(0, Math.floor(value)));
}

function buildNewTodoDeadlinePayload(): {
  dueAt?: number | null;
  deadlineMode?: TodoDeadlineMode | null;
  relativeDurationMinutes?: number | null;
} {
  if (newDeadlineMode.value === "absolute") {
    return {
      dueAt: newDeadlineAt.value,
      deadlineMode: newDeadlineAt.value === null ? null : "absolute",
      relativeDurationMinutes: null
    };
  }

  if (newDeadlineMode.value === "relative") {
    const hours = normalizeDurationHours(newRelativeHours.value);
    const minutes = normalizeDurationMinutes(newRelativeMinutes.value);
    const duration = hours * 60 + minutes;
    return {
      dueAt: Date.now() + duration * 60_000,
      deadlineMode: "relative",
      relativeDurationMinutes: duration
    };
  }

  return {
    dueAt: null,
    deadlineMode: null,
    relativeDurationMinutes: null
  };
}
</script>

<style scoped>
.todo-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 1.15rem;
  background: var(--todo-panel-bg, var(--bg-panel-soft));
  color: var(--text-primary);
  box-shadow:
    0 18px 46px var(--warm-shadow),
    0 1px 0 var(--todo-shadow-inset, color-mix(in srgb, var(--warm-white) 85%, transparent)) inset;
  overflow: hidden;
}

.todo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -0.75rem -0.75rem 0;
  padding: 0.62rem 0.75rem;
  border-bottom: 1px solid var(--line);
  border-radius: 1.15rem 1.15rem 0 0;
  background: var(--todo-header-bg, var(--bg-tool-header));
}

.todo-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
}

.todo-search {
  margin-top: 0.5rem;
}

.todo-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0.5rem 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.todo-search :deep(.el-input__wrapper),
.todo-add-form :deep(.el-input__wrapper),
.todo-date-picker :deep(.el-input__wrapper),
.todo-edit-inline :deep(.el-input__wrapper) {
  background: var(--todo-input-bg);
  box-shadow: 0 0 0 1px var(--todo-input-border) inset;
}

.todo-edit-inline :deep(.el-textarea__inner) {
  background: var(--todo-input-bg);
  color: var(--text-primary);
  box-shadow: 0 0 0 1px var(--todo-input-border) inset;
}

.todo-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 0.5rem;
  row-gap: 0.4rem;
  align-items: flex-start;
  padding: 0.5rem;
  border: 1px solid var(--border-list);
  border-radius: 0.75rem;
  background: var(--todo-item-bg, var(--bg-row-subtle));
  cursor: grab;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.todo-item:active {
  cursor: grabbing;
}

.todo-item.done {
  opacity: 0.62;
}

.todo-body {
  grid-column: 2;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.todo-name {
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-name.is-editable {
  cursor: pointer;
}

.todo-name.is-editable:hover {
  background: var(--todo-hover-bg);
  border-radius: 0.3rem;
}

.todo-description-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.todo-description {
  font-size: 0.95rem;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
  line-height: 1.35;
}

.todo-description.expanded {
  -webkit-line-clamp: unset;
  overflow: visible;
}

.todo-description-wrapper {
  cursor: text;
}

.todo-description-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.todo-description:hover {
  background: var(--todo-hover-bg);
  border-radius: 0.3rem;
}

.todo-description-placeholder {
  font-size: 0.95rem;
  color: var(--text-placeholder);
  font-style: italic;
}

.todo-expand-btn {
  font-size: 0.8rem;
  color: var(--ink-soft);
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 2px;
  align-self: flex-start;
}

.todo-edit-inline {
  width: 100%;
}

.todo-meta {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.todo-date-picker {
  width: 188px;
}

.todo-date-picker :deep(.el-input__wrapper) {
  font-size: 0.9rem;
}

.todo-deadline-controls,
.todo-add-row-deadline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.todo-deadline-mode {
  width: 124px;
}

.todo-duration-input {
  width: 88px;
}

.todo-duration-input-minutes {
  width: 82px;
}

.todo-duration-label {
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 700;
}

.todo-add-form :deep(.el-input__wrapper) {
  font-size: 0.9rem;
}

.todo-add-form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  flex: 0 0 auto;
}

.todo-add-row {
  display: flex;
  gap: 0.35rem;
  flex: 1 1 auto;
}

.todo-add-row-desc {
  display: flex;
  gap: 0.35rem;
}

.todo-category-input {
  width: 130px;
  flex-shrink: 0;
}

.todo-category-inline-input {
  width: 116px;
}

.todo-description-input {
  flex-shrink: 0;
}

.todo-category-tag {
  cursor: pointer;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.85rem;
  border-color: color-mix(in srgb, var(--accent-primary) 28%, var(--line));
  background: color-mix(in srgb, var(--accent-primary) 10%, var(--todo-item-bg, var(--bg-row-subtle)));
  color: var(--text-secondary);
}

.todo-category-add {
  border: none;
  background: none;
  padding: 0;
  color: var(--ink-soft);
  font-size: 0.82rem;
  cursor: pointer;
}

.todo-category-add:hover {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.todo-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem;
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--ink-soft);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.35rem 0.25rem;
  margin-top: 0.15rem;
  border-bottom: 1px solid var(--line-subtle);
  position: sticky;
  top: 0;
  background: var(--todo-sticky-bg, var(--bg-panel-soft));
  z-index: 1;
  cursor: pointer;
  user-select: none;
}

.todo-group-title {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.todo-group-header:hover {
  background: var(--todo-group-hover-bg);
}

.todo-group-arrow {
  font-size: 0.7rem;
}

.todo-group-stats {
  color: var(--text-secondary);
  font-size: 0.77rem;
  white-space: nowrap;
}

.todo-add-button {
  border-color: color-mix(in srgb, var(--accent-primary) 26%, var(--line)) !important;
  background: color-mix(in srgb, var(--accent-primary) 14%, var(--todo-input-bg)) !important;
  color: var(--text-primary) !important;
}

</style>
