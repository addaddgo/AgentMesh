<template>
  <section
    class="priority-board-panel"
    :class="`theme-${theme.theme}`"
    :style="themeVars"
  >
    <header class="priority-board-header">
      <h2>TODO Priority</h2>
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

    <div class="priority-board-body">
      <div v-if="sections.every((section) => section.count === 0)" class="priority-board-empty">
        No open todos.
      </div>
      <section v-for="section in sections" :key="section.key" class="priority-board-section">
        <header
          class="priority-board-section-header"
          role="button"
          tabindex="0"
          @click="toggleSection(section.key)"
          @keydown.enter.prevent="toggleSection(section.key)"
          @keydown.space.prevent="toggleSection(section.key)"
        >
          <span class="priority-board-header-main">
            <span
              class="priority-board-caret"
              :class="{ 'is-collapsed': isSectionCollapsed(section.key) }"
            >
              ▾
            </span>
            <strong>{{ section.label }} {{ section.count }}</strong>
          </span>
        </header>
        <div v-if="!isSectionCollapsed(section.key) && section.count === 0" class="priority-board-section-empty">
          Nothing here.
        </div>
        <div v-else-if="!isSectionCollapsed(section.key)" class="priority-board-category-list">
          <section
            v-for="group in section.groups"
            :key="`${section.key}:${group.category}`"
            class="priority-board-category"
          >
            <header
              class="priority-board-category-header"
              role="button"
              tabindex="0"
              @click="toggleCategory(section.key, group.category)"
              @keydown.enter.prevent="toggleCategory(section.key, group.category)"
              @keydown.space.prevent="toggleCategory(section.key, group.category)"
            >
              <span class="priority-board-header-main">
                <span
                  class="priority-board-caret priority-board-caret-small"
                  :class="{ 'is-collapsed': isCategoryCollapsed(section.key, group.category) }"
                >
                  ▾
                </span>
                <span>{{ group.category }} · {{ group.items.length }}</span>
              </span>
            </header>
            <article
              v-for="item in group.items"
              v-show="!isCategoryCollapsed(section.key, group.category)"
              :key="item.id"
              class="priority-board-card"
            >
              <button
                type="button"
                class="priority-board-drag-handle"
                draggable="true"
                title="Drag todo"
                aria-label="Drag todo"
                @dragstart="onDragStart($event, item)"
              >
                ⋮⋮
              </button>
              <button
                type="button"
                class="priority-board-card-main"
                @click="focusTodo(item.id)"
              >
                <strong class="priority-board-card-title">{{ item.name }}</strong>
                <span class="priority-board-card-meta">
                  {{ cardMeta(item) }}
                </span>
              </button>
              <el-button
                size="small"
                type="success"
                plain
                class="priority-board-card-done"
                @click="markDone(item.id)"
              >
                Done
              </el-button>
            </article>
          </section>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { CloseBold } from "@element-plus/icons-vue";
import type { TodoItemDto } from "@agentmesh/shared";
import { computed, onMounted, ref } from "vue";

import { useTodoStore } from "../stores/todos";
import { useThemeStore } from "../stores/theme";
import { writeMessageTextDrag } from "../utils/messageDragDrop";

const emit = defineEmits<{
  close: [];
  ensureTodoPanel: [];
}>();

const store = useTodoStore();
const theme = useThemeStore();
const collapsedSections = ref<Record<string, boolean>>(loadCollapsedState("priorityBoard.sections"));
const collapsedCategories = ref<Record<string, boolean>>(loadCollapsedState("priorityBoard.categories"));

onMounted(() => {
  if (store.items.length === 0) {
    void store.load();
  }
});

const themeVars = computed<Record<string, string>>(() => {
  if (theme.theme === "dark") {
    return {
      "--priority-panel-bg": "#252c27",
      "--priority-header-bg": "#214130",
      "--priority-card-bg": "rgba(44, 53, 46, 0.92)",
      "--priority-section-bg": "rgba(35, 41, 37, 0.8)",
      "--priority-section-border": "rgba(116, 131, 119, 0.28)",
      "--priority-category-line": "rgba(124, 138, 127, 0.2)"
    };
  }

  return {
    "--priority-panel-bg": "#f4f2ea",
    "--priority-header-bg": "#d4edda",
    "--priority-card-bg": "rgba(255, 253, 244, 0.9)",
    "--priority-section-bg": "rgba(248, 245, 236, 0.96)",
    "--priority-section-border": "rgba(128, 110, 84, 0.16)",
    "--priority-category-line": "rgba(138, 120, 92, 0.16)"
  };
});

const importantTags = computed(() => {
  return new Set(
    store.tagRules.filter((rule) => rule.importance === "important").map((rule) => rule.name)
  );
});

const optionalTags = computed(() => {
  return new Set(
    store.tagRules.filter((rule) => rule.importance === "optional").map((rule) => rule.name)
  );
});

const sections = computed(() => {
  const openItems = store.items.filter((item) => !item.done);
  return [
    buildSection(
      "due",
      "DUE",
      "",
      openItems.filter((item) => item.dueAt !== null).sort(compareDueItems)
    ),
    buildSection(
      "important",
      "IMPORTANT",
      "",
      openItems
        .filter((item) => item.dueAt === null && item.tags.some((tag) => importantTags.value.has(tag)))
        .sort(compareTaggedItems)
    ),
    buildSection(
      "normal",
      "NORMAL",
      "",
      openItems
        .filter(
          (item) =>
            item.dueAt === null &&
            item.tags.length > 0 &&
            !item.tags.some((tag) => importantTags.value.has(tag)) &&
            !item.tags.some((tag) => optionalTags.value.has(tag))
        )
        .sort(compareTaggedItems)
    ),
    buildSection(
      "optional",
      "OPTIONAL",
      "",
      openItems
        .filter(
          (item) =>
            item.dueAt === null &&
            item.tags.length > 0 &&
            !item.tags.some((tag) => importantTags.value.has(tag)) &&
            item.tags.some((tag) => optionalTags.value.has(tag))
        )
        .sort(compareTaggedItems)
    ),
    buildSection(
      "unclassified",
      "UNCLASSIFIED",
      "",
      openItems.filter((item) => item.dueAt === null && item.tags.length === 0).sort(compareTaggedItems)
    )
  ];
});

function buildSection(
  key: string,
  label: string,
  description: string,
  items: readonly TodoItemDto[]
): {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  readonly groups: ReadonlyArray<{ readonly category: string; readonly items: readonly TodoItemDto[] }>;
} {
  const groups = new Map<string, TodoItemDto[]>();
  for (const item of items) {
    const category = item.category ?? "Uncategorized";
    const existing = groups.get(category);
    if (existing === undefined) {
      groups.set(category, [item]);
    } else {
      existing.push(item);
    }
  }

  return {
    key,
    label,
    description,
    count: items.length,
    groups: [...groups.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([category, groupedItems]) => ({ category, items: groupedItems }))
  };
}

function compareDueItems(left: TodoItemDto, right: TodoItemDto): number {
  const dueDelta = (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER);
  if (dueDelta !== 0) {
    return dueDelta;
  }
  return compareTaggedItems(left, right);
}

function compareTaggedItems(left: TodoItemDto, right: TodoItemDto): number {
  const updatedDelta = left.updatedAt - right.updatedAt;
  if (updatedDelta !== 0) {
    return updatedDelta;
  }
  return left.createdAt - right.createdAt;
}

function cardMeta(item: TodoItemDto): string {
  const parts: string[] = [];
  parts.push(item.category ?? "Uncategorized");
  if (item.tags.length > 0) {
    parts.push(item.tags.join(", "));
  }
  if (item.dueAt !== null) {
    parts.push(`Due ${new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(item.dueAt)}`);
  }
  return parts.join(" · ");
}

function focusTodo(id: string): void {
  store.requestFocus(id);
  emit("ensureTodoPanel");
}

async function markDone(id: string): Promise<void> {
  await store.update(id, { done: true });
}

function onDragStart(event: DragEvent, item: TodoItemDto): void {
  if (event.dataTransfer === null) {
    return;
  }

  const text = `${item.name}\n\n${item.description}`;
  writeMessageTextDrag(event.dataTransfer, text);
}

function isSectionCollapsed(sectionKey: string): boolean {
  return collapsedSections.value[sectionKey] === true;
}

function toggleSection(sectionKey: string): void {
  collapsedSections.value = {
    ...collapsedSections.value,
    [sectionKey]: !isSectionCollapsed(sectionKey)
  };
  saveCollapsedState("priorityBoard.sections", collapsedSections.value);
}

function categoryCollapseKey(sectionKey: string, category: string): string {
  return `${sectionKey}:${category}`;
}

function isCategoryCollapsed(sectionKey: string, category: string): boolean {
  return collapsedCategories.value[categoryCollapseKey(sectionKey, category)] === true;
}

function toggleCategory(sectionKey: string, category: string): void {
  const key = categoryCollapseKey(sectionKey, category);
  collapsedCategories.value = {
    ...collapsedCategories.value,
    [key]: !isCategoryCollapsed(sectionKey, category)
  };
  saveCollapsedState("priorityBoard.categories", collapsedCategories.value);
}

function loadCollapsedState(storageKey: string): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }
  const raw = window.localStorage.getItem(storageKey);
  if (raw === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, boolean>;
    }
  } catch {
    return {};
  }
  return {};
}

function saveCollapsedState(storageKey: string, value: Record<string, boolean>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(value));
}
</script>

<style scoped>
.priority-board-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 1.15rem;
  background: var(--priority-panel-bg, var(--bg-panel-soft));
  box-shadow:
    0 18px 46px var(--warm-shadow),
    0 1px 0 color-mix(in srgb, var(--warm-white) 85%, transparent) inset;
  overflow: hidden;
}

.priority-board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -0.75rem -0.75rem 0;
  padding: 0.62rem 0.75rem;
  border-bottom: 1px solid var(--line);
  border-radius: 1.15rem 1.15rem 0 0;
  background: var(--priority-header-bg, var(--bg-tool-header));
}

.priority-board-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
}

.priority-board-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.8rem;
  min-height: 0;
  margin-top: 0.75rem;
  overflow: auto;
}

.priority-board-empty,
.priority-board-section-empty {
  color: var(--text-secondary);
  font-size: 0.84rem;
}

.priority-board-section {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding: 0.9rem 0.95rem 0.95rem;
  border: 1px solid var(--priority-section-border);
  border-radius: 1rem;
  background: var(--priority-section-bg);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--warm-white) 60%, transparent) inset,
    0 10px 22px color-mix(in srgb, var(--warm-shadow) 32%, transparent);
}

.priority-board-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-primary);
  font-size: 0.95rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
  user-select: none;
}

.priority-board-category-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.priority-board-category {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.6rem;
  padding: 0;
  --flow-card-min: 230px;
}

.priority-board-category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.1rem;
  border-top: 1px solid var(--priority-category-line);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  cursor: pointer;
  user-select: none;
}

.priority-board-category-header {
  grid-column: 1 / -1;
}

.priority-board-category > .priority-board-card {
  min-width: 0;
}

@media (min-width: 720px) {
  .priority-board-category {
    grid-template-columns: repeat(auto-fit, minmax(var(--flow-card-min), 1fr));
  }
}

.priority-board-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.65rem;
  padding: 0.7rem 0.78rem 0.7rem 0.82rem;
  border: 1px solid var(--border-list);
  border-radius: 0.85rem;
  background: var(--priority-card-bg, var(--bg-row-subtle));
  box-shadow: 0 1px 0 color-mix(in srgb, var(--warm-white) 50%, transparent) inset;
}

.priority-board-drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.15rem;
  padding: 0.18rem 0 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.9rem;
  line-height: 1;
  letter-spacing: -0.08em;
  cursor: grab;
  user-select: none;
}

.priority-board-drag-handle:active {
  cursor: grabbing;
}

.priority-board-drag-handle:hover {
  color: var(--text-primary);
}

.priority-board-card:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 42%, var(--border-list));
}

.priority-board-card-main {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.priority-board-card-title {
  font-size: 0.95rem;
  line-height: 1.35;
}

.priority-board-card-meta {
  color: var(--text-secondary);
  font-size: 0.77rem;
  line-height: 1.35;
  word-break: break-word;
}

.priority-board-card-done {
  flex: 0 0 auto;
  margin-top: 0.05rem;
}

.priority-board-header-main {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.priority-board-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.9rem;
  transition: transform 140ms ease;
}

.priority-board-caret-small {
  width: 0.8rem;
  font-size: 0.78rem;
}

.priority-board-caret.is-collapsed {
  transform: rotate(-90deg);
}
</style>
