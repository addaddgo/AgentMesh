<template>
  <section class="board-page">
    <Teleport to="#top-board-actions">
      <div class="top-board-control">
        <el-button
          size="small"
          :icon="DataAnalysis"
          circle
          title="Workspace Stats"
          aria-label="Workspace Stats"
          @click="addStatsPane"
        />
        <el-button
          size="small"
          type="primary"
          :icon="Plus"
          circle
          title="Add thread"
          aria-label="Add thread"
          @click="addDialogOpen = true"
        />
        <el-button
          size="small"
          :icon="Refresh"
          :loading="appServers.loading"
          circle
          title="Refresh"
          aria-label="Refresh"
          @click="loadAll"
        />
      </div>
    </Teleport>

    <main class="thread-canvas">
      <div v-if="threadLeaves.length > 0 || todoPanelVisible" class="thread-card-flow">
        <TodoPanel v-if="todoPanelVisible" class="thread-card" @close="todoPanelVisible = false" />
        <article
          v-for="leaf in allLeaves"
          :key="leaf.id"
          class="thread-card"
          :class="{ focused: focusedThreadLeafId === leaf.id }"
          @mousedown="focusThreadPane(leaf.id)"
        >
          <WorkspaceStatsPanel
            v-if="leaf.kind === 'stats'"
            :focused="focusedThreadLeafId === leaf.id"
            @close="closeThreadPane(leaf.id)"
          />
          <ThreadPanel
            v-else
            :app-server="appServerForLeaf(leaf)"
            :thread="threadForLeaf(leaf)"
            :messages="messagesForLeaf(leaf)"
            :queue-items="queueItemsForLeaf(leaf)"
            :draft="draftForLeaf(leaf)"
            :focused="focusedThreadLeafId === leaf.id"
            :resuming="isResumingLeaf(leaf)"
            @draft="setDraftForLeaf(leaf, $event)"
            @save-draft="saveDraftForLeaf(leaf)"
            @send="sendDraftForLeaf(leaf, $event)"
            @dropped="dropIntoLeaf(leaf, $event)"
            @resume="resumeThreadForLeaf(leaf)"
            @switch-thread="switchLeafThread(leaf, $event)"
            @settings-updated="refreshThreadForLeaf(leaf)"
            @thread-updated="threads.upsertThread($event)"
            @close="closeThreadPane(leaf.id)"
          />
        </article>
        
      </div>

      <el-empty v-else description="Click + to add a thread or the chart icon for workspace stats." />
    </main>

    <el-dialog v-model="addDialogOpen" title="" width="860px">
      <el-tabs>
        <el-tab-pane label="Add Thread">
      <div class="dialog-toolbar">
        <el-button
          :icon="Refresh"
          :loading="appServers.loading"
          size="small"
          circle
          title="Refresh"
          aria-label="Refresh"
          @click="loadAll"
        />
      </div>
      <div class="add-thread-dialog">
        <section>
          <p class="dialog-label">App server</p>
          <div class="selection-list">
            <button
              v-for="server in appServers.appServers"
              :key="server.id"
              class="selection-card"
              :class="{ active: server.id === selectedAppServerId }"
              type="button"
              @click="selectAppServer(server.id)"
            >
              <span class="selection-card-title">
                <strong>{{ appServerLabel(server) }}</strong>
                <el-tag :type="statusTagType(server.status)" size="small">{{
                  server.status
                }}</el-tag>
              </span>
              <span class="dialog-actions">
                <el-button
                  size="small"
                  :icon="RefreshRight"
                  :disabled="server.status !== 'online'"
                  circle
                  title="Refresh threads"
                  aria-label="Refresh threads"
                  @click.stop="syncThreads(server.id)"
                />
                <el-button
                  v-if="server.status !== 'online'"
                  size="small"
                  type="primary"
                  :icon="VideoPlay"
                  circle
                  title="Start app-server"
                  aria-label="Start app-server"
                  @click.stop="appServers.start(server.id)"
                />
                <el-button
                  v-else
                  size="small"
                  type="warning"
                  :icon="VideoPause"
                  circle
                  title="Stop app-server"
                  aria-label="Stop app-server"
                  @click.stop="appServers.stop(server.id)"
                />
              </span>
            </button>
          </div>
        </section>
        <section>
          <p class="dialog-label">Thread</p>
          <form
            v-if="selectedAppServerId !== null"
            class="thread-create-form"
            @submit.prevent="createThread(selectedAppServerId)"
          >
            <el-input
              v-model="newThreadNameByAppServerId[selectedAppServerId]"
              size="small"
              placeholder="New thread"
              :disabled="selectedAppServer?.status !== 'online'"
            />
            <el-button
              size="small"
              type="primary"
              :icon="CirclePlus"
              circle
              native-type="submit"
              :loading="creatingThreadByAppServerId[selectedAppServerId] === true"
              :disabled="selectedAppServer?.status !== 'online'"
              title="Create thread"
              aria-label="Create thread"
            />
          </form>
          <div class="selection-list">
            <button
              v-for="thread in selectedAppServerThreads"
              :key="thread.id"
              class="selection-card"
              :class="{ active: selectedThreadId === thread.id }"
              type="button"
              @click="selectedThreadId = thread.id"
            >
              <span class="selection-card-title">
                <strong>{{ thread.threadName }}</strong>
                <el-tag v-if="thread.isGone" size="small" type="danger">gone</el-tag>
                <el-tag v-else size="small">{{ thread.status ?? "idle" }}</el-tag>
              </span>
            </button>
          </div>
        </section>
      </div>
      </el-tab-pane>
      <el-tab-pane label="Tools">
        <div class="tools-panel">
          <label class="tool-option">
            <el-checkbox v-model="todoPanelVisible" />
            <span>Todo</span>
          </label>
        </div>
      </el-tab-pane>
    </el-tabs>
      <template #footer>
        <div class="dialog-actions">
          <el-button
            :icon="Close"
            circle
            title="Cancel"
            aria-label="Cancel"
            @click="addDialogOpen = false"
          />
          <el-button
            type="primary"
            :icon="Select"
            :disabled="selectedThread === null"
            circle
            title="Add selected thread"
            aria-label="Add selected thread"
            @click="addSelectedThread"
          />
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {
  CirclePlus,
  Close,
  DataAnalysis,
  Plus,
  Refresh,
  RefreshRight,
  Select,
  VideoPause,
  VideoPlay
} from "@element-plus/icons-vue";
import type {
  AppServerDto,
  AppServerStatus,
  ChatMessage,
  QueueItemDto,
  SplitPaneTree,
  ThreadDto
} from "@agentmesh/shared";
import { computed, onMounted, ref, watch } from "vue";

import ThreadPanel from "../components/ThreadPanel.vue";
import TodoPanel from "../components/TodoPanel.vue";
import { apiClient } from "../api/client";
import { useAppServerStore } from "../stores/appServers";
import { useMessageStore } from "../stores/messages";
import { useThreadStore } from "../stores/threads";
import {
  createLeaf,
  firstLeafId,
  leafPayloadIds,
  removeLeaf,
  useUiLayoutStore
} from "../stores/uiLayout";
import { appendDroppedText } from "../utils/messageDragDrop";

const BOARDS_OWNER_ID = "root";

type SplitPaneLeaf = Extract<SplitPaneTree, { readonly type: "leaf" }>;

const appServers = useAppServerStore();
const threads = useThreadStore();
const messages = useMessageStore();
const uiLayout = useUiLayoutStore();

const boardTree = ref<SplitPaneTree | null>(null);
const focusedThreadLeafId = ref<string | null>(null);
const selectedAppServerId = ref<string | null>(null);
const selectedThreadId = ref<string | null>(null);
const newThreadNameByAppServerId = ref<Record<string, string>>({});
const creatingThreadByAppServerId = ref<Record<string, boolean>>({});
const resumingThreadById = ref<Record<string, boolean>>({});
const addDialogOpen = ref(false);
const todoPanelVisible = ref(localStorage.getItem("todoPanelVisible") === "true");
watch(todoPanelVisible, (visible) => {
  localStorage.setItem("todoPanelVisible", String(visible));
});

const selectedAppServer = computed(() =>
  selectedAppServerId.value === null ? null : serverById(selectedAppServerId.value)
);
const selectedAppServerThreads = computed(() =>
  selectedAppServerId.value === null ? [] : currentThreadsFor(selectedAppServerId.value)
);
const selectedThread = computed(() =>
  selectedThreadId.value === null ? null : threads.threadById(selectedThreadId.value)
);
const threadLeaves = computed(() => collectThreadLeaves(boardTree.value));
const allLeaves = computed(() => collectAllLeaves(boardTree.value));

onMounted(() => {
  void loadAll();
});

async function loadAll(): Promise<void> {
  await Promise.all([appServers.load(), uiLayout.loadPersistedState()]);

  if (selectedAppServerId.value === null) {
    selectedAppServerId.value = appServers.appServers[0]?.id ?? null;
  }

  await Promise.all(appServers.appServers.map((server) => threads.loadForAppServer(server.id)));
  refreshSelectedThread();

  const persisted = uiLayout.getLayout("boards", BOARDS_OWNER_ID);
  boardTree.value = persisted !== null && collectAllLeaves(persisted).length > 0 ? persisted : null;
  focusedThreadLeafId.value = firstLeafId(boardTree.value);

  await Promise.all(
    leafPayloadIds(boardTree.value, "threadId").map((threadId) => restoreThread(threadId))
  );
  focusThreadPane(focusedThreadLeafId.value);
}

async function selectAppServer(appServerId: string): Promise<void> {
  selectedAppServerId.value = appServerId;
  appServers.select(appServerId);
  uiLayout.focusAppServer(appServerId);
  await threads.loadForAppServer(appServerId);
  refreshSelectedThread();
}

function refreshSelectedThread(): void {
  const currentThreads = selectedAppServerThreads.value;
  if (
    selectedThreadId.value === null ||
    currentThreads.every((thread) => thread.id !== selectedThreadId.value)
  ) {
    selectedThreadId.value = currentThreads[0]?.id ?? null;
  }
}

async function addSelectedThread(): Promise<void> {
  if (selectedThread.value !== null) {
    await addThreadPane(selectedThread.value);
    addDialogOpen.value = false;
  }
}

async function addThreadPane(thread: ThreadDto): Promise<void> {
  const existingLeaf = findLeafByPayload(boardTree.value, "threadId", thread.id);
  if (existingLeaf !== null) {
    focusThreadPane(existingLeaf.id);
    await openThreadData(thread);
    return;
  }

  const nextLeaf = createLeaf(crypto.randomUUID(), { threadId: thread.id }) as SplitPaneLeaf;
  const leaves = collectThreadLeaves(boardTree.value);
  const insertIndex = lastLeafIndexForAppServer(leaves, thread.appServerId);
  const nextLeaves =
    insertIndex === -1
      ? [...leaves, nextLeaf]
      : [...leaves.slice(0, insertIndex + 1), nextLeaf, ...leaves.slice(insertIndex + 1)];

  boardTree.value = buildLinearThreadTree(nextLeaves);
  focusedThreadLeafId.value = findLeafByPayload(boardTree.value, "threadId", thread.id)?.id ?? null;
  await persistBoardTree();
  await openThreadData(thread);
}

async function createThread(appServerId: string): Promise<void> {
  const name = (newThreadNameByAppServerId.value[appServerId] ?? "").trim();
  if (name.length === 0 || creatingThreadByAppServerId.value[appServerId] === true) {
    return;
  }

  creatingThreadByAppServerId.value = {
    ...creatingThreadByAppServerId.value,
    [appServerId]: true
  };
  try {
    const thread = await threads.createThread(appServerId, name);
    if (thread !== null) {
      newThreadNameByAppServerId.value = {
        ...newThreadNameByAppServerId.value,
        [appServerId]: ""
      };
      selectedThreadId.value = thread.id;
      await addThreadPane(thread);
      addDialogOpen.value = false;
    }
  } finally {
    creatingThreadByAppServerId.value = {
      ...creatingThreadByAppServerId.value,
      [appServerId]: false
    };
  }
}

async function syncThreads(appServerId: string): Promise<void> {
  await threads.sync(appServerId);
  refreshSelectedThread();
}

async function openThreadData(thread: ThreadDto): Promise<void> {
  await threads.openThread(thread);
  await Promise.all([messages.load(thread.id), messages.loadQueue(thread.id)]);
  threads.focusThread(thread.appServerId, thread.id);
  uiLayout.focusThread(thread.appServerId, thread.id);
  appServers.select(thread.appServerId);
  uiLayout.focusAppServer(thread.appServerId);
}

async function closeThreadPane(leafId: string): Promise<void> {
  boardTree.value = removeLeaf(boardTree.value, leafId);
  focusedThreadLeafId.value = firstLeafId(boardTree.value);
  await persistBoardTree();
  focusThreadPane(focusedThreadLeafId.value);
}

async function addStatsPane(): Promise<void> {
  const existingStats = findLeafByKind(boardTree.value, "stats");
  if (existingStats !== null) {
    focusThreadPane(existingStats.id);
    return;
  }

  const statsLeaf: SplitPaneLeaf = {
    type: "leaf",
    kind: "stats",
    id: crypto.randomUUID()
  };
  const nextLeaves = [...allLeaves.value, statsLeaf];
  boardTree.value = buildLinearThreadTree(nextLeaves);
  focusedThreadLeafId.value = statsLeaf.id;
  await persistBoardTree();
  focusThreadPane(statsLeaf.id);
}

function focusThreadPane(leafId: string | null): void {
  focusedThreadLeafId.value = leafId;
  const leaf = findLeaf(boardTree.value, leafId);
  const thread = leaf === null ? null : threadForLeaf(leaf);

  if (thread !== null) {
    selectedAppServerId.value = thread.appServerId;
    selectedThreadId.value = thread.id;
    appServers.select(thread.appServerId);
    uiLayout.focusAppServer(thread.appServerId);
    threads.focusThread(thread.appServerId, thread.id);
    uiLayout.focusThread(thread.appServerId, thread.id);
  }
}

function threadForLeaf(leaf: SplitPaneTree): ThreadDto | null {
  if (leaf.type !== "leaf" || leaf.threadId === undefined) {
    return null;
  }

  return threads.threadById(leaf.threadId);
}

function appServerForLeaf(leaf: SplitPaneTree): AppServerDto | null {
  const thread = threadForLeaf(leaf);
  return thread === null ? null : serverById(thread.appServerId);
}

function messagesForLeaf(leaf: SplitPaneTree): readonly ChatMessage[] {
  const thread = threadForLeaf(leaf);
  return thread === null ? [] : (messages.byThreadId[thread.id] ?? []);
}

function queueItemsForLeaf(leaf: SplitPaneTree): QueueItemDto[] {
  const thread = threadForLeaf(leaf);
  if (thread === null) {
    return [];
  }

  return (messages.queueItemIdsByThreadId[thread.id] ?? [])
    .map((id) => messages.queueItemsById[id])
    .filter((item) => item !== undefined);
}

function draftForLeaf(leaf: SplitPaneTree): string {
  const thread = threadForLeaf(leaf);
  return thread === null ? "" : (uiLayout.draftsByThreadId[thread.id]?.draftMarkdown ?? "");
}

function isResumingLeaf(leaf: SplitPaneTree): boolean {
  const thread = threadForLeaf(leaf);
  return thread !== null && resumingThreadById.value[thread.id] === true;
}

function setDraftForLeaf(leaf: SplitPaneTree, value: string): void {
  const thread = threadForLeaf(leaf);
  if (thread !== null) {
    uiLayout.setDraft(thread.appServerId, thread.id, value);
  }
}

async function saveDraftForLeaf(leaf: SplitPaneTree): Promise<void> {
  const thread = threadForLeaf(leaf);
  if (thread !== null) {
    await uiLayout.saveDraft(thread.appServerId, thread.id);
  }
}

async function sendDraftForLeaf(
  leaf: SplitPaneTree,
  payload: {
    readonly draftMarkdown: string;
    readonly attachmentIds: readonly string[];
    readonly onSuccess: () => void;
  }
): Promise<void> {
  const thread = threadForLeaf(leaf);
  if (thread === null) {
    return;
  }

  const draft = payload.draftMarkdown.trim();
  const appServer = serverById(thread.appServerId);
  if (
    (draft.length === 0 && payload.attachmentIds.length === 0) ||
    thread.isGone ||
    appServer?.status !== "online"
  ) {
    return;
  }

  const response = await messages.send(thread.id, draft, payload.attachmentIds);
  if (response === null) {
    return;
  }

  uiLayout.setDraft(thread.appServerId, thread.id, "");
  await uiLayout.saveDraft(thread.appServerId, thread.id);
  payload.onSuccess();
}

async function resumeThreadForLeaf(leaf: SplitPaneTree): Promise<void> {
  const thread = threadForLeaf(leaf);
  if (thread === null || resumingThreadById.value[thread.id] === true) {
    return;
  }

  resumingThreadById.value = {
    ...resumingThreadById.value,
    [thread.id]: true
  };
  try {
    const appServer = serverById(thread.appServerId);
    if (appServer === null) {
      return;
    }
    if (appServer.status !== "online") {
      await appServers.start(appServer.id);
      if (serverById(thread.appServerId)?.status !== "online") {
        return;
      }
    }

    const resumed = await threads.resumeThread(thread);
    if (resumed !== null) {
      await threads.openThread(resumed);
      await Promise.all([messages.load(resumed.id), messages.loadQueue(resumed.id)]);
    }
  } finally {
    resumingThreadById.value = {
      ...resumingThreadById.value,
      [thread.id]: false
    };
  }
}

function dropIntoLeaf(leaf: SplitPaneTree, text: string): void {
  const thread = threadForLeaf(leaf);
  if (thread === null) {
    return;
  }

  uiLayout.setDraft(thread.appServerId, thread.id, appendDroppedText(draftForLeaf(leaf), text));
}

async function restoreThread(threadId: string): Promise<void> {
  let thread = threads.threadById(threadId);
  if (thread === null) {
    try {
      thread = await apiClient.getThread(threadId);
      threads.upsertThread(thread);
    } catch {
      return;
    }
  }

  if (thread.importedAt === null) {
    await threads.openThread(thread);
  } else {
    threads.rememberOpenThread(thread);
  }
  await Promise.all([messages.load(thread.id), messages.loadQueue(thread.id)]);
}

async function switchLeafThread(leaf: SplitPaneTree, threadId: string): Promise<void> {
  if (leaf.type !== "leaf") {
    return;
  }
  const thread = threads.threadById(threadId) ?? (await apiClient.getThread(threadId));
  threads.upsertThread(thread);
  boardTree.value = replaceThreadLeaf(boardTree.value, leaf.id, thread.id);
  threads.rememberOpenThread(thread);
  await persistBoardTree();
  await restoreThread(thread.id);
  focusThreadPane(leaf.id);
}

async function refreshThreadForLeaf(leaf: SplitPaneTree): Promise<void> {
  const thread = threadForLeaf(leaf);
  if (thread === null) {
    return;
  }

  const refreshed = await apiClient.getThread(thread.id);
  threads.upsertThread(refreshed);
}

function replaceThreadLeaf(
  tree: SplitPaneTree | null,
  leafId: string,
  threadId: string
): SplitPaneTree | null {
  if (tree === null) {
    return null;
  }
  if (tree.type === "leaf") {
    return tree.id === leafId ? { ...tree, threadId } : tree;
  }
  return {
    ...tree,
    first: replaceThreadLeaf(tree.first, leafId, threadId) ?? tree.first,
    second: replaceThreadLeaf(tree.second, leafId, threadId) ?? tree.second
  };
}

async function persistBoardTree(): Promise<void> {
  await uiLayout.persistTree("boards", BOARDS_OWNER_ID, boardTree.value);
}

function currentThreadsFor(appServerId: string): readonly ThreadDto[] {
  return (threads.byAppServerId[appServerId] ?? []).filter((thread) => thread.isCurrent);
}

function serverById(appServerId: string): AppServerDto | null {
  return appServers.appServers.find((server) => server.id === appServerId) ?? null;
}

function appServerLabel(server: AppServerDto): string {
  return `${server.host} / ${server.name}`;
}

function statusTagType(status: AppServerStatus): "success" | "warning" | "danger" | "info" {
  if (status === "online") {
    return "success";
  }
  if (status === "starting" || status === "stopping") {
    return "warning";
  }
  if (status === "error") {
    return "danger";
  }
  return "info";
}

function findLeaf(tree: SplitPaneTree | null, id: string | null): SplitPaneLeaf | null {
  if (tree === null || id === null) {
    return null;
  }

  if (tree.type === "leaf") {
    return tree.id === id ? tree : null;
  }

  return findLeaf(tree.first, id) ?? findLeaf(tree.second, id);
}

function findLeafByKind(
  tree: SplitPaneTree | null,
  kind: "thread" | "stats"
): SplitPaneLeaf | null {
  if (tree === null) return null;
  if (tree.type === "leaf" && tree.kind === kind) return tree;
  if (tree.type === "split") return findLeafByKind(tree.first, kind) ?? findLeafByKind(tree.second, kind);
  return null;
}

function findLeafByPayload(
  tree: SplitPaneTree | null,
  key: "appServerId" | "threadId",
  value: string
): SplitPaneLeaf | null {
  if (tree === null) {
    return null;
  }

  if (tree.type === "leaf") {
    return tree[key] === value ? tree : null;
  }

  return findLeafByPayload(tree.first, key, value) ?? findLeafByPayload(tree.second, key, value);
}

function collectThreadLeaves(tree: SplitPaneTree | null): SplitPaneLeaf[] {
  if (tree === null) {
    return [];
  }

  if (tree.type === "leaf") {
    return tree.threadId === undefined ? [] : [tree];
  }

  return [...collectThreadLeaves(tree.first), ...collectThreadLeaves(tree.second)];
}

function collectAllLeaves(tree: SplitPaneTree | null): SplitPaneLeaf[] {
  if (tree === null) {
    return [];
  }

  if (tree.type === "leaf") {
    return (tree.threadId !== undefined || tree.kind === "stats") ? [tree as SplitPaneLeaf] : [];
  }

  return [...collectAllLeaves(tree.first), ...collectAllLeaves(tree.second)];
}

function lastLeafIndexForAppServer(leaves: readonly SplitPaneLeaf[], appServerId: string): number {
  for (let index = leaves.length - 1; index >= 0; index -= 1) {
    const threadId = leaves[index]?.threadId;
    if (threadId !== undefined && threads.threadById(threadId)?.appServerId === appServerId) {
      return index;
    }
  }

  return -1;
}

function buildLinearThreadTree(leaves: readonly SplitPaneLeaf[]): SplitPaneTree | null {
  return leaves.reduce<SplitPaneTree | null>((tree, leaf) => {
    if (tree === null) {
      return leaf;
    }

    return {
      type: "split",
      id: crypto.randomUUID(),
      direction: "horizontal",
      first: tree,
      second: leaf,
      ratio: 0.5
    };
  }, null);
}
</script>
