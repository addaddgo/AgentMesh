<template>
  <section class="scheduled-messages-panel">
    <header class="scheduled-messages-header">
      <h2>Scheduled Messages</h2>
      <div class="scheduled-messages-header-actions">
        <el-button
          size="small"
          :icon="Refresh"
          :loading="store.loading || loadingThreads"
          circle
          title="Refresh scheduled messages"
          @click="load"
        />
        <el-button
          size="small"
          type="danger"
          plain
          :icon="CloseBold"
          circle
          title="Close"
          aria-label="Close"
          @click="$emit('close')"
        />
      </div>
    </header>

    <div class="scheduled-messages-body">
      <form class="scheduled-messages-form" @submit.prevent="createItem">
        <div class="scheduled-messages-form-grid">
          <el-select
            v-model="selectedAppServerId"
            class="scheduled-messages-field"
            placeholder="Workspace"
            filterable
          >
            <el-option
              v-for="server in appServers.appServers"
              :key="server.id"
              :label="serverLabel(server.id)"
              :value="server.id"
            />
          </el-select>
          <el-select
            v-model="selectedThreadId"
            class="scheduled-messages-field"
            placeholder="Thread"
            filterable
            :disabled="selectedAppServerId === null || currentThreads.length === 0"
          >
            <el-option
              v-for="thread in currentThreads"
              :key="thread.id"
              :label="thread.threadName"
              :value="thread.id"
            />
          </el-select>
          <el-input-number
            v-model="delayHours"
            class="scheduled-messages-field scheduled-delay-input"
            :min="0"
            :step="1"
            controls-position="right"
            placeholder="Hours"
          />
          <el-input-number
            v-model="delayMinutes"
            class="scheduled-messages-field scheduled-delay-input"
            :min="0"
            :max="59"
            :step="1"
            controls-position="right"
            placeholder="Minutes"
          />
        </div>
        <div
          class="scheduled-message-drop-zone"
          :class="{ 'is-drop-target': createDropTarget }"
          @dragenter.prevent="dragEnterDraft($event, 'create')"
          @dragover.prevent="dragOverDraft($event, 'create')"
          @dragleave="dragLeaveDraft('create')"
          @drop.prevent="dropIntoDraft($event, 'create')"
        >
          <ScheduledMessageComposer
            v-model="draftText"
            :app-server-id="selectedAppServerId"
            placeholder="Message to send later. Use $skill or @path."
          />
        </div>
        <div class="scheduled-messages-form-actions">
          <span class="scheduled-messages-help">Send as a user message after {{ delayLabel(createDelaySeconds) }}.</span>
          <el-button
            native-type="submit"
            size="small"
            type="primary"
            :icon="Clock"
            :loading="submitting"
            :disabled="selectedAppServerId === null || selectedThreadId === null || draftText.trim().length === 0"
          >
            Schedule
          </el-button>
        </div>
      </form>

      <div v-if="store.loading && store.items.length === 0" class="scheduled-messages-empty">Loading...</div>
      <div v-else-if="store.items.length === 0" class="scheduled-messages-empty">No scheduled messages yet.</div>
      <div v-else class="scheduled-message-list">
        <section
          v-for="group in groupedItems"
          :key="group.appServerId"
          class="scheduled-message-group"
        >
          <header
            class="scheduled-message-group-header"
            role="button"
            tabindex="0"
            @click="toggleGroup(group.appServerId)"
            @keydown.enter.prevent="toggleGroup(group.appServerId)"
            @keydown.space.prevent="toggleGroup(group.appServerId)"
          >
            <div class="scheduled-message-group-title">
              <span
                class="scheduled-message-group-caret"
                :class="{ 'is-collapsed': isGroupCollapsed(group.appServerId) }"
                aria-hidden="true"
              >
                ▾
              </span>
              <strong>{{ group.label }}</strong>
            </div>
            <span>{{ group.items.length }}</span>
          </header>
          <article
            v-for="item in group.items"
            v-show="!isGroupCollapsed(group.appServerId)"
            :key="item.id"
            class="scheduled-message-card"
          >
            <template v-if="editingId === item.id">
              <div class="scheduled-message-edit-grid">
                <el-select
                  v-model="editAppServerId"
                  class="scheduled-messages-field"
                  placeholder="Workspace"
                  filterable
                >
                  <el-option
                    v-for="server in appServers.appServers"
                    :key="server.id"
                    :label="serverLabel(server.id)"
                    :value="server.id"
                  />
                </el-select>
                <el-select
                  v-model="editThreadId"
                  class="scheduled-messages-field"
                  placeholder="Thread"
                  filterable
                  :disabled="editAppServerId === null || editThreads.length === 0"
                >
                  <el-option
                    v-for="thread in editThreads"
                    :key="thread.id"
                    :label="thread.threadName"
                    :value="thread.id"
                  />
                </el-select>
                <el-input-number
                  v-model="editDelayHours"
                  class="scheduled-messages-field scheduled-delay-input"
                  :min="0"
                  :step="1"
                  controls-position="right"
                  placeholder="Hours"
                />
                <el-input-number
                  v-model="editDelayMinutes"
                  class="scheduled-messages-field scheduled-delay-input"
                  :min="0"
                  :max="59"
                  :step="1"
                  controls-position="right"
                  placeholder="Minutes"
                />
              </div>
              <div
                class="scheduled-message-drop-zone"
                :class="{ 'is-drop-target': editDropTarget }"
                @dragenter.prevent="dragEnterDraft($event, 'edit')"
                @dragover.prevent="dragOverDraft($event, 'edit')"
                @dragleave="dragLeaveDraft('edit')"
                @drop.prevent="dropIntoDraft($event, 'edit')"
              >
                <ScheduledMessageComposer
                  v-model="editText"
                  :app-server-id="editAppServerId"
                  placeholder="Message to send later. Use $skill or @path."
                />
              </div>
              <div class="scheduled-message-actions">
                <span class="scheduled-message-meta">
                  Reschedule for {{ delayLabel(editDelaySecondsTotal) }} from now.
                </span>
                <div class="scheduled-message-action-buttons">
                  <el-button size="small" @click="cancelEdit">Cancel</el-button>
                  <el-button
                    size="small"
                    type="primary"
                    :loading="updatingId === item.id"
                    :disabled="editAppServerId === null || editThreadId === null || editText.trim().length === 0"
                    @click="saveEdit(item.id)"
                  >
                    Save
                  </el-button>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="scheduled-message-topline">
                <div class="scheduled-message-topline-main">
                  <button
                    type="button"
                    class="scheduled-message-drag-handle"
                    draggable="true"
                    title="Drag scheduled message"
                    aria-label="Drag scheduled message"
                    @dragstart="onDragStart($event, item)"
                  >
                    ⋮⋮
                  </button>
                  <strong>{{ threadLabel(item.threadId) }}</strong>
                </div>
                <span class="scheduled-message-status" :class="`is-${item.status}`">{{ item.status }}</span>
              </div>
              <div class="scheduled-message-subline">
                <span>{{ formatRunAt(item.runAt) }}</span>
              </div>
              <p class="scheduled-message-preview">{{ item.text }}</p>
              <p v-if="item.status === 'failed' && item.lastError !== null" class="scheduled-message-error">
                {{ item.lastError }}
              </p>
              <div class="scheduled-message-actions">
                <span class="scheduled-message-meta">
                  {{ statusSummary(item) }}
                </span>
                <div class="scheduled-message-action-buttons">
                  <el-button
                    v-if="item.status === 'sent'"
                    size="small"
                    type="success"
                    :loading="acknowledgingId === item.id"
                    @click="acknowledgeItem(item.id)"
                  >
                    OK
                  </el-button>
                  <el-button
                    v-if="editableStatuses.has(item.status)"
                    size="small"
                    @click="beginEdit(item)"
                  >
                    Edit
                  </el-button>
                  <el-button
                    v-if="item.status === 'scheduled' || item.status === 'failed'"
                    size="small"
                    type="danger"
                    plain
                    :loading="deletingId === item.id"
                    @click="deleteItem(item.id)"
                  >
                    Delete
                  </el-button>
                </div>
              </div>
            </template>
          </article>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineEmits<{
  close: [];
}>();

import { CloseBold, Clock, Refresh } from "@element-plus/icons-vue";
import type { ScheduledMessageDto, ThreadDto } from "@agentmesh/shared";
import { computed, onMounted, ref, watch } from "vue";

import ScheduledMessageComposer from "./ScheduledMessageComposer.vue";
import { useAppServerStore } from "../stores/appServers";
import { useScheduledMessageStore } from "../stores/scheduledMessages";
import { useThreadStore } from "../stores/threads";
import {
  appendDroppedText,
  canDropMessageText,
  readMessageTextDrop,
  writeMessageTextDrag
} from "../utils/messageDragDrop";

const GROUP_COLLAPSE_STORAGE_KEY = "scheduledMessages.collapsedGroups";

const appServers = useAppServerStore();
const threads = useThreadStore();
const store = useScheduledMessageStore();

const selectedAppServerId = ref<string | null>(null);
const selectedThreadId = ref<string | null>(null);
const delayHours = ref(0);
const delayMinutes = ref(5);
const draftText = ref("");
const submitting = ref(false);
const loadingThreads = ref(false);

const editingId = ref<string | null>(null);
const editAppServerId = ref<string | null>(null);
const editThreadId = ref<string | null>(null);
const editDelayHours = ref(0);
const editDelayMinutes = ref(5);
const editText = ref("");
const updatingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const acknowledgingId = ref<string | null>(null);
const createDropTarget = ref(false);
const editDropTarget = ref(false);
const collapsedGroups = ref<Record<string, boolean>>(loadCollapsedGroups());
const editableStatuses = new Set<ScheduledMessageDto["status"]>(["scheduled", "failed"]);

const currentThreads = computed<readonly ThreadDto[]>(() =>
  selectedAppServerId.value === null ? [] : threads.byAppServerId[selectedAppServerId.value] ?? []
);

const editThreads = computed<readonly ThreadDto[]>(() =>
  editAppServerId.value === null ? [] : threads.byAppServerId[editAppServerId.value] ?? []
);

const createDelaySeconds = computed(() => toDelaySeconds(delayHours.value, delayMinutes.value));
const editDelaySecondsTotal = computed(() =>
  toDelaySeconds(editDelayHours.value, editDelayMinutes.value)
);
const groupedItems = computed(() =>
  appServers.appServers
    .map((server) => ({
      appServerId: server.id,
      label: server.name,
      items: store.items.filter((item) => item.appServerId === server.id)
    }))
    .filter((group) => group.items.length > 0)
);

onMounted(() => {
  void load();
});

watch(selectedAppServerId, async (appServerId) => {
  await ensureThreadsLoaded(appServerId);
  const items = currentThreads.value;
  if (!items.some((thread) => thread.id === selectedThreadId.value)) {
    selectedThreadId.value = items[0]?.id ?? null;
  }
});

watch(editAppServerId, async (appServerId) => {
  await ensureThreadsLoaded(appServerId);
  const items = editThreads.value;
  if (!items.some((thread) => thread.id === editThreadId.value)) {
    editThreadId.value = items[0]?.id ?? null;
  }
});

async function load(): Promise<void> {
  await Promise.all([store.load(), ensureAppServersLoaded()]);
  if (selectedAppServerId.value === null) {
    selectedAppServerId.value = appServers.appServers[0]?.id ?? null;
  }
  await ensureThreadsLoaded(selectedAppServerId.value);
  if (selectedThreadId.value === null) {
    selectedThreadId.value = currentThreads.value[0]?.id ?? null;
  }
}

async function ensureAppServersLoaded(): Promise<void> {
  if (appServers.appServers.length === 0) {
    await appServers.load();
  }
}

async function ensureThreadsLoaded(appServerId: string | null): Promise<void> {
  if (appServerId === null) {
    return;
  }
  if ((threads.byAppServerId[appServerId] ?? []).length > 0 || threads.loadingByAppServerId[appServerId] === true) {
    return;
  }

  loadingThreads.value = true;
  try {
    await threads.loadForAppServer(appServerId);
  } finally {
    loadingThreads.value = false;
  }
}

async function createItem(): Promise<void> {
  if (selectedAppServerId.value === null || selectedThreadId.value === null || draftText.value.trim().length === 0) {
    return;
  }

  submitting.value = true;
  try {
    const created = await store.create({
      threadId: selectedThreadId.value,
      text: draftText.value,
      delaySeconds: createDelaySeconds.value
    });
    if (created !== null) {
      draftText.value = "";
      delayHours.value = 0;
      delayMinutes.value = 5;
    }
  } finally {
    submitting.value = false;
  }
}

function beginEdit(item: ScheduledMessageDto): void {
  editingId.value = item.id;
  editAppServerId.value = item.appServerId;
  editThreadId.value = item.threadId;
  const { hours, minutes } = splitDelaySeconds(
    Math.max(0, Math.ceil((item.runAt - Date.now()) / 1_000))
  );
  editDelayHours.value = hours;
  editDelayMinutes.value = minutes;
  editText.value = item.text;
}

function cancelEdit(): void {
  editingId.value = null;
  editAppServerId.value = null;
  editThreadId.value = null;
  editDelayHours.value = 0;
  editDelayMinutes.value = 5;
  editText.value = "";
}

async function saveEdit(id: string): Promise<void> {
  if (editAppServerId.value === null || editThreadId.value === null || editText.value.trim().length === 0) {
    return;
  }

  updatingId.value = id;
  try {
    const updated = await store.update(id, {
      appServerId: editAppServerId.value,
      threadId: editThreadId.value,
      text: editText.value,
      delaySeconds: editDelaySecondsTotal.value
    });
    if (updated !== null) {
      cancelEdit();
    }
  } finally {
    updatingId.value = null;
  }
}

async function deleteItem(id: string): Promise<void> {
  deletingId.value = id;
  try {
    await store.remove(id);
  } finally {
    deletingId.value = null;
  }
}

async function acknowledgeItem(id: string): Promise<void> {
  acknowledgingId.value = id;
  try {
    await store.acknowledge(id);
  } finally {
    acknowledgingId.value = null;
  }
}

function serverLabel(appServerId: string): string {
  return appServers.appServers.find((server) => server.id === appServerId)?.name ?? appServerId;
}

function threadLabel(threadId: string): string {
  return threads.threadById(threadId)?.threadName ?? threadId;
}

function scheduledTargetLabel(appServerId: string, threadId: string): string {
  return `${serverLabel(appServerId)} / ${threadLabel(threadId)}`;
}

function formatRunAt(runAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(runAt);
}

function delayLabel(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(safeSeconds / 86_400);
  const hours = Math.floor((safeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainderSeconds = safeSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (remainderSeconds > 0 || parts.length === 0) {
    parts.push(`${remainderSeconds}s`);
  }

  return parts.slice(0, 2).join(" ");
}

function toDelaySeconds(hours: number, minutes: number): number {
  const safeHours = Math.max(0, Math.floor(hours));
  const safeMinutes = Math.max(0, Math.min(59, Math.floor(minutes)));
  return safeHours * 3_600 + safeMinutes * 60;
}

function splitDelaySeconds(seconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60
  };
}

function statusSummary(item: ScheduledMessageDto): string {
  switch (item.status) {
    case "scheduled":
      return `Runs in ${delayLabel(Math.max(0, Math.ceil((item.runAt - Date.now()) / 1_000)))}`;
    case "sending":
      return "Submitting user message now";
    case "sent":
      return item.lastAttemptAt === null ? "Message submitted" : `Submitted after ${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`;
    case "failed":
      return item.lastError === null
        ? `Failed after ${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`
        : `Failed after ${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}: ${item.lastError}`;
    case "acknowledged":
      return "Acknowledged";
    default:
      return item.status;
  }
}

function onDragStart(event: DragEvent, item: ScheduledMessageDto): void {
  if (event.dataTransfer === null) {
    return;
  }

  writeMessageTextDrag(event.dataTransfer, scheduledMessageDragText(item));
}

function dragEnterDraft(event: DragEvent, target: "create" | "edit"): void {
  updateDraftDropTarget(event, target);
}

function dragOverDraft(event: DragEvent, target: "create" | "edit"): void {
  updateDraftDropTarget(event, target);
}

function dragLeaveDraft(target: "create" | "edit"): void {
  setDraftDropTarget(target, false);
}

function dropIntoDraft(event: DragEvent, target: "create" | "edit"): void {
  const droppedText = readMessageTextDrop(event.dataTransfer);
  setDraftDropTarget(target, false);
  if (droppedText.trim().length === 0) {
    return;
  }

  if (target === "create") {
    draftText.value = appendDroppedText(draftText.value, droppedText);
    return;
  }

  editText.value = appendDroppedText(editText.value, droppedText);
}

function updateDraftDropTarget(event: DragEvent, target: "create" | "edit"): void {
  const allowed = canDropMessageText(event.dataTransfer);
  setDraftDropTarget(target, allowed);
  if (allowed && event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "copy";
  }
}

function setDraftDropTarget(target: "create" | "edit", active: boolean): void {
  if (target === "create") {
    createDropTarget.value = active;
    return;
  }

  editDropTarget.value = active;
}

function isGroupCollapsed(appServerId: string): boolean {
  return collapsedGroups.value[appServerId] === true;
}

function toggleGroup(appServerId: string): void {
  collapsedGroups.value = {
    ...collapsedGroups.value,
    [appServerId]: !isGroupCollapsed(appServerId)
  };
  saveCollapsedGroups(collapsedGroups.value);
}

function loadCollapsedGroups(): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(GROUP_COLLAPSE_STORAGE_KEY);
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

function saveCollapsedGroups(groups: Record<string, boolean>): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(groups));
}

function scheduledMessageDragText(item: ScheduledMessageDto): string {
  return `to_workspace: ${serverLabel(item.appServerId)}; to_thread: ${threadLabel(item.threadId)}; messages: ${item.text};`;
}
</script>

<style scoped>
.scheduled-messages-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 1.15rem;
  background: var(--bg-panel-soft);
  box-shadow:
    0 18px 46px var(--warm-shadow),
    0 1px 0 color-mix(in srgb, var(--warm-white) 85%, transparent) inset;
  overflow: hidden;
}

.scheduled-messages-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -0.75rem -0.75rem 0;
  padding: 0.62rem 0.75rem;
  border-bottom: 1px solid var(--line);
  border-radius: 1.15rem 1.15rem 0 0;
  background: var(--bg-tool-header);
}

.scheduled-messages-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
}

.scheduled-messages-header-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.scheduled-messages-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.9rem;
  margin-top: 0.75rem;
  min-height: 0;
}

.scheduled-messages-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--border-list);
  border-radius: 0.95rem;
  background: var(--bg-row-subtle);
}

.scheduled-message-drop-zone {
  border-radius: 0.95rem;
  transition:
    background 120ms ease,
    box-shadow 120ms ease,
    border-color 120ms ease;
}

.scheduled-message-drop-zone.is-drop-target {
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent-primary) 26%, transparent);
}

.scheduled-messages-form-grid,
.scheduled-message-edit-grid {
  display: grid;
  grid-template-columns: 1.1fr 1.2fr 108px 108px;
  gap: 0.65rem;
}

.scheduled-messages-field,
.scheduled-delay-input {
  width: 100%;
}

.scheduled-messages-form-actions,
.scheduled-message-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.scheduled-messages-help,
.scheduled-message-meta {
  color: var(--el-text-color-secondary);
  font-size: 0.79rem;
  line-height: 1.4;
}

.scheduled-messages-empty {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.scheduled-message-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.9rem;
  min-height: 0;
  overflow: auto;
}

.scheduled-message-group {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.scheduled-message-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.15rem 0.15rem 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
  user-select: none;
}

.scheduled-message-group-title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.scheduled-message-group-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.9rem;
  font-size: 0.82rem;
  transition: transform 140ms ease;
}

.scheduled-message-group-caret.is-collapsed {
  transform: rotate(-90deg);
}

.scheduled-message-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.85rem;
  border: 1px solid var(--border-list);
  border-radius: 0.95rem;
  background: var(--bg-card);
}

.scheduled-message-topline,
.scheduled-message-subline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
}

.scheduled-message-topline-main {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.scheduled-message-subline {
  color: var(--el-text-color-secondary);
  font-size: 0.8rem;
}

.scheduled-message-status {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: lowercase;
}

.scheduled-message-status.is-scheduled {
  color: var(--el-color-primary-dark-2);
}

.scheduled-message-status.is-sending {
  color: var(--el-color-warning-dark-2);
}

.scheduled-message-status.is-sent {
  color: var(--el-color-success-dark-2);
}

.scheduled-message-status.is-failed {
  color: var(--el-color-danger-dark-2);
}

.scheduled-message-status.is-canceled {
  color: var(--el-text-color-secondary);
}

.scheduled-message-drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.1rem;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.9rem;
  line-height: 1;
  letter-spacing: -0.08em;
  cursor: grab;
  user-select: none;
}

.scheduled-message-drag-handle:active {
  cursor: grabbing;
}

.scheduled-message-drag-handle:hover {
  color: var(--text-primary);
}

.scheduled-message-preview {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.scheduled-message-error {
  margin: 0;
  color: var(--el-color-danger-dark-2);
  font-size: 0.82rem;
  line-height: 1.45;
}

.scheduled-message-action-buttons {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
</style>
