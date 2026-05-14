<template>
  <section
    class="thread-panel"
    :class="{
      focused,
      missing: thread === null,
      'ready-pulse': readyPulseActive,
      'user-messages-hidden': !showUserMessages
    }"
  >
    <template v-if="thread !== null">
      <header class="thread-header">
        <div class="thread-header-main">
          <strong>{{ threadTitle }}</strong>
        </div>
        <div class="thread-header-status-row">
          <span
            class="thread-status-text"
            :class="{
              'thread-status-text-working': effectiveThreadStatus === 'working',
              'thread-status-text-not-loaded': effectiveThreadStatus === 'notLoaded',
              'thread-status-text-idle': effectiveThreadStatus !== 'working' && effectiveThreadStatus !== 'notLoaded'
            }"
          >
            {{ effectiveThreadStatus }}
          </span>
          <el-tag v-if="thread.isGone" size="small" type="danger">Gone</el-tag>
          <span class="thread-param">mode: {{ threadCollaborationMode }}</span>
          <span class="thread-param">model: {{ threadModel }}</span>
          <span class="thread-param">think: {{ threadReasoningEffort }}</span>
          <span class="thread-param">ctx: {{ threadContextRemaining }}</span>
          <span class="thread-param">perm: {{ threadPermissionMode }}</span>
        </div>
        <div class="thread-header-actions">
          <div class="thread-visibility-toggle">
            <span>user</span>
            <el-switch v-model="showUserMessages" size="small" />
          </div>
          <el-button
            v-if="canRenameThread"
            size="small"
            :icon="EditPen"
            circle
            title="Rename thread"
            aria-label="Rename thread"
            @click.stop="openRenameDialog"
          />
          <el-button
            v-if="showResumeAction"
            size="small"
            type="primary"
            :icon="SwitchButton"
            :loading="resuming"
            :disabled="resumeActionDisabled"
            circle
            :title="resumeActionLabel"
            :aria-label="resumeActionLabel"
            @click.stop="emit('resume')"
          />
          <el-button
            size="small"
            :icon="Document"
            :loading="rawEventsLoading"
            circle
            title="Raw JSON"
            aria-label="Raw JSON"
            @click="openDebugDrawer"
          />
          <el-button
            size="small"
            type="danger"
            plain
            :icon="CloseBold"
            circle
            title="Close thread"
            aria-label="Close thread"
            @click.stop="emit('close')"
          />
        </div>
      </header>

      <el-dialog
        v-model="approvalVisible"
        title="Approval Required"
        width="640px"
        :close-on-click-modal="false"
        :close-on-press-escape="false"
      >
        <ApprovalCard
          v-if="pendingApproval !== null"
          :key="pendingApproval.id"
          :approval="pendingApproval"
          :responding="approvals.isResponding(pendingApproval.id)"
          @respond="respondApproval"
        />
      </el-dialog>

      <div ref="scrollContainer" class="message-list" @click="handleMessageListClick">
        <article
          v-for="(message, index) in displayedMessages"
          :key="message.id"
          class="message-card"
          :class="message.role"
        >
          <div v-if="canDragMessage(message)" class="message-actions">
            <button
              class="message-drag-handle"
              type="button"
              draggable="true"
              title="Drag message text"
              aria-label="Drag message text"
              @dragstart="dragMessage($event, message)"
            >
              <el-icon><Rank /></el-icon>
            </button>
          </div>
          <div v-if="message.status !== 'completed'" class="message-meta">
            <el-tag size="small">{{ message.status }}</el-tag>
          </div>
          <template v-for="(part, partIndex) in message.parts" :key="`${message.id}-${partIndex}`">
            <div
              v-if="part.type === 'markdown'"
              class="markdown-part"
              v-html="renderMarkdown(part.text)"
            />
            <figure v-else-if="part.type === 'image'" class="image-part">
              <img
                v-if="part.url !== undefined"
                :src="part.url"
                :alt="part.attachmentId ?? 'Codex image attachment'"
                loading="lazy"
                decoding="async"
              />
              <figcaption>
                {{ part.workspacePath ?? part.attachmentId ?? "Image attachment" }}
              </figcaption>
            </figure>
            <el-alert
              v-else-if="part.type === 'error'"
              :title="part.message"
              type="error"
              :closable="false"
            >
              <pre v-if="part.raw !== undefined">{{ formatJson(part.raw) }}</pre>
            </el-alert>
            <details v-else-if="part.type === 'approval'" class="part-card approval-part" open>
              <summary>
                Approval · {{ part.kind }}
                <el-tag size="small">{{ approvalPartStatus(part.approvalId, part.status) }}</el-tag>
              </summary>
              <pre>{{ formatJson(part.payload) }}</pre>
              <div
                v-if="approvalPartStatus(part.approvalId, part.status) === 'pending'"
                class="part-actions"
              >
                <el-button
                  size="small"
                  type="primary"
                  :icon="Check"
                  :loading="approvals.isResponding(part.approvalId)"
                  :disabled="approvals.isResponding(part.approvalId)"
                  circle
                  title="Approve"
                  aria-label="Approve"
                  @click="respondApproval(part.approvalId, 'approve')"
                />
                <el-button
                  size="small"
                  type="danger"
                  :icon="CloseBold"
                  :loading="approvals.isResponding(part.approvalId)"
                  :disabled="approvals.isResponding(part.approvalId)"
                  circle
                  title="Deny"
                  aria-label="Deny"
                  @click="respondApproval(part.approvalId, 'deny')"
                />
              </div>
            </details>
            <details v-else-if="part.type === 'diff'" class="part-card">
              <summary>Diff</summary>
              <pre>{{ part.text }}</pre>
            </details>
            <details v-else-if="part.type === 'tool_call'" class="part-card">
              <summary>
                Tool call · {{ part.toolName }}
                <el-tag size="small">{{ part.status }}</el-tag>
              </summary>
              <pre>{{ formatJson(part.input) }}</pre>
            </details>
            <details v-else-if="part.type === 'tool_result'" class="part-card">
              <summary>
                Tool result · {{ part.callId }}
                <el-tag size="small">{{ part.status }}</el-tag>
              </summary>
              <pre>{{ formatJson(part.output) }}</pre>
            </details>
            <details v-else class="part-card">
              <summary>Event · {{ part.eventType }}</summary>
              <pre>{{ formatJson(part.raw) }}</pre>
            </details>
          </template>
          <footer v-if="message.role === 'assistant'" class="message-time">
            <span>{{ formatMessageTime(message.createdAt) }}</span>
            <span>{{
              formatMessageDelta(displayedMessages[index - 1]?.createdAt ?? null, message.createdAt)
            }}</span>
          </footer>
        </article>
      </div>

      <div
        class="composer"
        :class="{ 'drop-target': isDropTarget, 'search-open': fileSearchOpen }"
        @dragenter.prevent="dragEnterComposer($event)"
        @dragover.prevent="dragOverComposer($event)"
        @dragleave="dragLeaveComposer"
        @drop.prevent="dropIntoComposer($event)"
      >
        <div v-if="fileSearchOpen" class="workspace-search-overlay">
          <div class="workspace-search-panel">
            <div class="workspace-search-header">
              <span>Workspace File Search</span>
              <span>{{ props.appServer?.name ?? "workspace" }}</span>
            </div>
            <input
              ref="fileSearchInput"
              v-model="fileSearchQuery"
              class="workspace-search-input"
              type="text"
              placeholder="Search files in this workspace"
              spellcheck="false"
              autocomplete="off"
              @keydown="handleFileSearchKeydown"
            />
            <div class="workspace-search-results">
              <p v-if="fileSearchLoading" class="workspace-search-hint">Searching...</p>
              <p
                v-else-if="fileSearchResults.length === 0"
                class="workspace-search-hint workspace-search-empty"
              >
                {{ fileSearchEmptyState }}
              </p>
              <button
                v-for="(entry, index) in fileSearchResults"
                :key="entry.path"
                type="button"
                class="workspace-search-result"
                :class="{
                  selected: index === fileSearchSelectedIndex,
                  directory: entry.kind === 'directory'
                }"
                @mousedown.prevent
                @click="void openWorkspaceFileFromSearch(entry)"
              >
                <strong>{{ formatFileSearchEntryLabel(entry) }}</strong>
                <span>{{ entry.path }}</span>
              </button>
            </div>
          </div>
        </div>

        <div
          ref="editorHost"
          class="markdown-editor"
          :class="{ disabled: !canEdit }"
          @blur.capture="saveDraftNow"
        />

        <div v-if="isDropTarget" class="composer-drop-feedback">Drop to append text to draft</div>

        <div v-if="attachments.length > 0" class="attachment-list">
          <article v-for="item in attachments" :key="item.attachment.id" class="attachment-chip">
            <img :src="item.previewUrl" :alt="item.attachment.filename" />
            <el-button
              size="small"
              text
              type="danger"
              :icon="Delete"
              :disabled="!canEdit"
              circle
              title="Remove image"
              aria-label="Remove image"
              @click="removeAttachment(item.attachment.id)"
            />
          </article>
        </div>

        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          :disabled="!canEdit || attachments.length >= MAX_ATTACHMENTS"
          @change="pickImages"
        />

        <div class="composer-actions">
          <span>
            {{
              disabledReason ??
              `${attachments.length}/${MAX_ATTACHMENTS} images selected. Drop message text or images here.`
            }}
          </span>
          <div class="composer-button-group">
            <el-button
              :icon="ArrowUp"
              :disabled="!canBrowseHistoryUp"
              circle
              title="Previous input"
              aria-label="Previous input"
              @click="browseComposerHistory(-1)"
            />
            <el-button
              :icon="ArrowDown"
              :disabled="!canBrowseHistoryDown"
              circle
              title="Next input"
              aria-label="Next input"
              @click="browseComposerHistory(1)"
            />
            <el-button
              v-if="isWorking"
              class="thread-stop-button"
              :icon="VideoPause"
              :loading="stopping"
              :disabled="!canStop"
              circle
              title="Stop agent"
              aria-label="Stop agent"
              @click="void stopThreadWork()"
            />
            <el-button
              :disabled="!canEdit || attachments.length >= MAX_ATTACHMENTS"
              :loading="uploading"
              :icon="PictureFilled"
              circle
              title="Attach images"
              aria-label="Attach images"
              @click="fileInput?.click()"
            />
            <el-button
              class="thread-send-button"
              :icon="Promotion"
              :disabled="!canSend"
              circle
              title="Send"
              aria-label="Send"
              @click="sendComposer"
            />
          </div>
        </div>
      </div>

      <el-drawer v-model="debugDrawerOpen" title="Raw Codex JSON" size="50%">
        <el-empty v-if="rawEvents.length === 0" description="No realtime Codex events recorded" />
        <div v-else class="raw-event-list">
          <details v-for="event in rawEvents" :key="event.id" class="part-card">
            <summary>{{ event.eventType }} · {{ formatTimestamp(event.createdAt) }}</summary>
            <pre>{{ formatRawJson(event.rawJson) }}</pre>
          </details>
        </div>
      </el-drawer>

      <el-dialog v-model="renameDialogOpen" title="Rename Thread" width="420px">
        <el-input
          v-model="renameDraft"
          autofocus
          maxlength="120"
          show-word-limit
          placeholder="Thread name"
          @keyup.enter="renameThread"
        />
        <template #footer>
          <div class="dialog-actions">
            <el-button :disabled="renaming" @click="renameDialogOpen = false">Cancel</el-button>
            <el-button
              type="primary"
              :loading="renaming"
              :disabled="renameDraft.trim().length === 0"
              @click="renameThread"
            >
              Rename
            </el-button>
          </div>
        </template>
      </el-dialog>
    </template>

    <el-empty v-else description="Opened thread is missing from local history" />
  </section>
</template>

<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloseBold,
  Delete,
  Document,
  EditPen,
  PictureFilled,
  Promotion,
  Rank,
  SwitchButton,
  VideoPause
} from "@element-plus/icons-vue";
import type {
  AppServerDto,
  ApprovalDecision,
  ApprovalDto,
  ChatMessage,
  CodexCommandDto,
  CodexCommandOptionDto,
  CodexEventDto,
  ImageAttachmentDto,
  QueueItemDto,
  SkillDto,
  ThreadDto,
  WorkspaceEntryDto
} from "@agentmesh/shared";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  moveCompletionSelection,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import MarkdownIt from "markdown-it";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { apiClient } from "../api/client";
import ApprovalCard from "./ApprovalCard.vue";
import { useApprovalStore } from "../stores/approvals";
import { notifyError, notifyInfo } from "../stores/errors";
import {
  appendDroppedText,
  canDropMessageText,
  readMessageTextDrop,
  textForMessageDrag,
  writeMessageTextDrag
} from "../utils/messageDragDrop";

const MAX_ATTACHMENTS = 5;
const LOCAL_DRAFT_PROTECTION_MS = 5000;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WORKSPACE_LINK_PREFIX = "workspace:";
const WORKSPACE_PATH_PATTERN =
  /(^|[\s(>])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w./-]*[\w-]+\.[A-Za-z0-9._-]+)(?=$|[\s),.:;!?<])/gmu;
const markdownRenderer = new MarkdownIt({ html: false, linkify: true });
const defaultLinkOpen =
  markdownRenderer.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token === undefined) {
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  const href = token?.attrGet("href") ?? "";
  const workspacePath = workspacePathFromHref(href);
  if (workspacePath !== null) {
    token.attrSet("href", "#");
    token.attrSet("data-workspace-path", workspacePath);
    token.attrJoin("class", "workspace-inline-link");
  }

  return defaultLinkOpen(tokens, idx, options, env, self);
};

type SelectedAttachment = {
  readonly attachment: ImageAttachmentDto;
  readonly previewUrl: string;
};

type FileSearchResult = WorkspaceEntryDto;

const props = defineProps<{
  readonly appServer: AppServerDto | null;
  readonly thread: ThreadDto | null;
  readonly messages: readonly ChatMessage[];
  readonly queueItems: readonly QueueItemDto[];
  readonly draft: string;
  readonly focused: boolean;
  readonly resuming?: boolean;
  readonly readyPulseKey?: number;
}>();

const emit = defineEmits<{
  draft: [value: string];
  "save-draft": [];
  send: [
    payload: {
      readonly draftMarkdown: string;
      readonly attachmentIds: readonly string[];
      readonly onSuccess: () => void;
    }
  ];
  dropped: [value: string];
  resume: [];
  "switch-thread": [threadId: string];
  "settings-updated": [];
  "thread-updated": [thread: ThreadDto];
  close: [];
}>();

const approvals = useApprovalStore();
const scrollContainer = ref<HTMLElement | null>(null);
const editorHost = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const fileSearchInput = ref<HTMLInputElement | null>(null);
const debugDrawerOpen = ref(false);
const rawEvents = ref<readonly CodexEventDto[]>([]);
const rawEventsLoading = ref(false);
const attachments = ref<SelectedAttachment[]>([]);
const uploading = ref(false);
const stopping = ref(false);
const isDropTarget = ref(false);
const renameDialogOpen = ref(false);
const approvalVisible = ref(false);
const renameDraft = ref("");
const dismissedApprovalIds = ref(new Set<string>());
const renaming = ref(false);
const editorDraft = ref(props.draft);
const fileSearchOpen = ref(false);
const fileSearchQuery = ref("");
const fileSearchLoading = ref(false);
const fileSearchResults = ref<readonly FileSearchResult[]>([]);
const fileSearchSelectedIndex = ref(0);
const readyPulseActive = ref(false);
const historyBrowseIndex = ref(-1);
const showUserMessages = ref(false);
const editableCompartment = new Compartment();
let editorView: EditorView | null = null;
let saveDraftTimer: ReturnType<typeof setTimeout> | null = null;
let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
let readyPulseTimer: ReturnType<typeof setTimeout> | null = null;
let fileSearchRequestToken = 0;
let dragDepth = 0;
let activeEditorThreadId: string | null = props.thread?.id ?? null;
let lastLocalDraft = props.draft;
let lastLocalEditAt = 0;
let applyingExternalDraft = false;
let historyInsertionAnchor = -1;
let historyInsertedRange: { from: number; to: number } | null = null;
const commandCompletionCache = new Map<string, readonly CodexCommandDto[]>();
const skillCompletionCache = new Map<string, readonly SkillDto[]>();
const commandOptionCompletionCache = new Map<string, readonly CodexCommandOptionDto[]>();

const disabledReason = computed(() => {
  if (props.thread?.isGone === true) {
    return "This disappeared thread is read-only.";
  }
  if (props.appServer?.status !== "online") {
    return "The app-server is offline.";
  }
  if (effectiveThreadStatus.value === "notLoaded") {
    return "Resume this thread before sending.";
  }
  return null;
});

const canEdit = computed(() => disabledReason.value === null);
const canSend = computed(
  () =>
    canEdit.value &&
    !uploading.value &&
    (editorDraft.value.trim().length > 0 || attachments.value.length > 0)
);
const canStop = computed(() => props.thread !== null && isWorking.value && !stopping.value);
const composerHistory = computed(() =>
  [...props.messages]
    .filter((message) => message.role === "user")
    .map(userMessageHistoryText)
    .filter((text) => text.length > 0)
    .reverse()
);
const canBrowseHistoryUp = computed(
  () => canEdit.value && historyBrowseIndex.value < composerHistory.value.length - 1
);
const canBrowseHistoryDown = computed(() => canEdit.value && historyBrowseIndex.value >= 0);
const displayedMessages = computed(() =>
  showUserMessages.value
    ? props.messages
    : props.messages.filter((message) => message.role !== "user")
);
const pendingApproval = computed<ApprovalDto | null>(() => {
  if (props.thread === null) {
    return null;
  }

  return approvals.byThreadId(props.thread.id).filter(
    (a) => a.status === "pending"
  ).filter(
    (a) => !dismissedApprovalIds.value.has(a.id)
  )[0] ?? null;
});
watch(pendingApproval, (next) => {
  approvalVisible.value = next !== null;
});

const isWorking = computed(
  () =>
    props.messages.some((message) =>
      ["pending", "queued", "sent", "streaming"].includes(message.status)
    ) ||
    props.queueItems.some((item) =>
      ["pending", "running", "waiting_approval"].includes(item.status)
    )
);
const effectiveThreadStatus = computed(() => {
  if (props.thread === null) {
    return "notLoaded";
  }
  if (isWorking.value) {
    return "working";
  }
  return props.thread.status ?? "idle";
});
const threadModel = computed(() => {
  const runtimeModel = props.thread?.runtime?.model;
  if (runtimeModel !== undefined && runtimeModel !== null && runtimeModel.trim().length > 0) {
    return runtimeModel;
  }

  const raw = props.thread?.rawMetadata;
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const model = firstString(record.model, record.modelName, record.model_name);
    const provider = firstString(record.modelProvider, record.model_provider);
    if (model !== undefined && provider !== undefined) {
      return `${provider}/${model}`;
    }
    if (model !== undefined) {
      return model;
    }
    if (provider !== undefined) {
      return provider;
    }
  }

  return "default";
});
const threadSubagentName = computed(() => {
  return props.thread?.agentName ?? props.thread?.runtime?.agentName ?? "main agent";
});
const threadCollaborationMode = computed(
  () => props.thread?.runtime?.collaborationMode ?? "default"
);
const threadReasoningEffort = computed(() => props.thread?.runtime?.reasoningEffort ?? "default");
const threadContextRemaining = computed(() => {
  const percent = props.thread?.runtime?.contextRemainingPercent;
  return typeof percent === "number" ? `${percent}%` : "unknown";
});
const threadPermissionMode = computed(() => props.thread?.runtime?.permissionMode ?? "default");
const threadTitle = computed(() => {
  const workspaceName = props.appServer === null ? "missing" : props.appServer.name;
  const mainThreadName =
    props.thread?.runtime?.mainThreadName ?? props.thread?.threadName ?? "thread";
  return `${workspaceName}/${mainThreadName}/${threadSubagentName.value}`;
});
const showResumeAction = computed(
  () => props.thread !== null && !props.thread.isGone && effectiveThreadStatus.value === "notLoaded"
);
const canRenameThread = computed(
  () =>
    props.thread !== null &&
    props.thread.agentKind === "main" &&
    props.appServer?.status === "online"
);
const resumeActionDisabled = computed(
  () =>
    props.appServer === null ||
    props.appServer.status === "starting" ||
    props.appServer.status === "stopping"
);
const resumeActionLabel = computed(() =>
  props.appServer?.status === "online" ? "Resume thread" : "Start app-server and resume thread"
);
const fileSearchEmptyState = computed(() => {
  const query = fileSearchQuery.value.trim();
  if (query.length === 0) {
    return "No workspace entries";
  }
  if (query.endsWith("/")) {
    return "No entries in this directory";
  }
  return "No matching files";
});
const selectedFileSearchResult = computed<FileSearchResult | null>(
  () => fileSearchResults.value[fileSearchSelectedIndex.value] ?? null
);
watch(
  () => props.messages.length,
  async (nextLength, previousLength) => {
    if (nextLength <= previousLength) {
      return;
    }

    await nextTick();
    if (scrollContainer.value !== null) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
    }
  }
);

onMounted(() => {
  if (editorHost.value === null) {
    return;
  }

  editorView = new EditorView({
    parent: editorHost.value,
    doc: props.draft,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: 220,
        defaultKeymap: false,
        icons: false,
        maxRenderedOptions: 12,
        override: [completeCommandOrSkill]
      }),
      Prec.high(
        keymap.of([
          {
            key: "Mod-f",
            run: () => {
              openFileSearch();
              return true;
            }
          },
          {
            key: "ArrowDown",
            run: (view) => moveCompletionSelection(true)(view) || browseComposerHistoryWithKeyboard(view, 1)
          },
          {
            key: "ArrowUp",
            run: (view) => moveCompletionSelection(false)(view) || browseComposerHistoryWithKeyboard(view, -1)
          },
          {
            key: "PageDown",
            run: moveCompletionSelection(true, "page")
          },
          {
            key: "PageUp",
            run: moveCompletionSelection(false, "page")
          },
          {
            key: "Escape",
            run: (view) => {
              if (fileSearchOpen.value) {
                closeFileSearch();
                return true;
              }
              if (closeCompletion(view)) {
                return true;
              }
              if (canStop.value) {
                void stopThreadWork();
                return true;
              }
              return false;
            }
          },
          {
            key: "Enter",
            run: (view) => {
              // Accept completion if active, otherwise send
              if (acceptCompletion(view)) {
                return true;
              }
              sendComposer();
              return true;
            }
          },
          {
            key: "Mod-Enter",
            run: (view) => {
              view.dispatch({ changes: { from: view.state.selection.main.head, insert: "\n" } });
              return true;
            }
          },
          {
            key: "Tab",
            run: (view) => acceptCompletion(view) || insertTabIndent(view)
          }
        ])
      ),
      editableCompartment.of(EditorView.editable.of(canEdit.value)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternalDraft) {
          return;
        }

        if (historyBrowseIndex.value !== -1) {
          historyBrowseIndex.value = -1;
          historyInsertionAnchor = -1;
          historyInsertedRange = null;
        }
        setLocalDraft(update.state.doc.toString(), true);
        scheduleDraftSave();
      })
    ]
  });
});

onBeforeUnmount(() => {
  if (saveDraftTimer !== null) {
    clearTimeout(saveDraftTimer);
  }
  if (fileSearchTimer !== null) {
    clearTimeout(fileSearchTimer);
  }
  if (readyPulseTimer !== null) {
    clearTimeout(readyPulseTimer);
  }
  for (const item of attachments.value) {
    URL.revokeObjectURL(item.previewUrl);
  }
  editorView?.destroy();
});

watch(
  () => [props.thread?.id ?? null, props.draft] as const,
  ([threadId, nextDraft]) => {
    if (editorView === null) {
      return;
    }

    const threadChanged = threadId !== activeEditorThreadId;
    activeEditorThreadId = threadId;

    if (threadChanged) {
      historyBrowseIndex.value = -1;
      historyInsertionAnchor = -1;
      historyInsertedRange = null;
      replaceEditorDraft(nextDraft);
      return;
    }

    if (nextDraft === lastLocalDraft || editorView.state.doc.toString() === nextDraft) {
      return;
    }

    // Stale async draft loads must not overwrite active typing.
    if (editorView.hasFocus || Date.now() - lastLocalEditAt < LOCAL_DRAFT_PROTECTION_MS) {
      return;
    }

    replaceEditorDraft(nextDraft);
  }
);

watch(canEdit, (editable) => {
  editorView?.dispatch({
    effects: editableCompartment.reconfigure(EditorView.editable.of(editable))
  });
});

watch(
  () => props.readyPulseKey ?? 0,
  (next, previous) => {
    if (next === 0 || next === previous) {
      return;
    }

    readyPulseActive.value = true;
    if (readyPulseTimer !== null) {
      clearTimeout(readyPulseTimer);
    }
    readyPulseTimer = setTimeout(() => {
      readyPulseActive.value = false;
      readyPulseTimer = null;
    }, 1800);
  }
);

watch(
  () => fileSearchResults.value.length,
  (length) => {
    if (length === 0) {
      fileSearchSelectedIndex.value = 0;
      return;
    }

    fileSearchSelectedIndex.value = Math.min(fileSearchSelectedIndex.value, length - 1);
  }
);

watch(
  () => [fileSearchOpen.value, fileSearchQuery.value, props.appServer?.id ?? null] as const,
  ([open, query, appServerId]) => {
    if (!open || appServerId === null) {
      cancelFileSearchRequest();
      fileSearchLoading.value = false;
      fileSearchResults.value = [];
      return;
    }

    if (fileSearchTimer !== null) {
      clearTimeout(fileSearchTimer);
    }

    fileSearchLoading.value = true;
    const requestToken = ++fileSearchRequestToken;
    const normalizedQuery = query.trim();
    fileSearchTimer = setTimeout(() => {
      const request =
        normalizedQuery.length === 0 || normalizedQuery.endsWith("/")
          ? apiClient.listWorkspaceEntries(appServerId, normalizedQuery)
          : apiClient.searchWorkspaceFiles(appServerId, normalizedQuery);

      void request
        .then((entries) => {
          if (requestToken !== fileSearchRequestToken) {
            return;
          }

          fileSearchResults.value =
            normalizedQuery.length === 0 || normalizedQuery.endsWith("/")
              ? entries
              : rankWorkspaceSearchResults(entries, normalizedQuery);
          fileSearchSelectedIndex.value = 0;
        })
        .catch((error: unknown) => {
          if (requestToken !== fileSearchRequestToken) {
            return;
          }

          fileSearchResults.value = [];
          notifyError(error, "Failed to search workspace files");
        })
        .finally(() => {
          if (requestToken === fileSearchRequestToken) {
            fileSearchLoading.value = false;
          }
        });
    }, 120);
  }
);

watch(
  () => props.thread?.id,
  (threadId) => {
    clearAttachments();
    closeFileSearch({ restoreFocus: false });
    if (threadId !== undefined) {
      void approvals.loadForThread(threadId);
    }
  },
  { immediate: true }
);

function dragMessage(event: DragEvent, message: ChatMessage): void {
  const text = textForMessageDrag(message);
  if (event.dataTransfer === null || text.trim().length === 0) {
    event.preventDefault();
    return;
  }

  writeMessageTextDrag(event.dataTransfer, text);
}

function canDragMessage(message: ChatMessage): boolean {
  return textForMessageDrag(message).trim().length > 0;
}

function completeCommandOrSkill(
  context: CompletionContext
): CompletionResult | Promise<CompletionResult | null> | null {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = line.text.slice(0, context.pos - line.from);

  const slashArgumentMatch =
    /^(\/(?:subagents|collab|model|permission|permissions))\s+([^\s]*)$/u.exec(beforeCursor);
  if (slashArgumentMatch !== null) {
    const command = slashArgumentMatch[1] ?? "";
    const token = slashArgumentMatch[2] ?? "";
    return completeSlashCommandOption(context.pos - token.length, command);
  }

  const slashCommandMatch = /^(\/[^\s]*)$/u.exec(beforeCursor);
  if (slashCommandMatch !== null) {
    const token = slashCommandMatch[1] ?? "";
    return completeSlashCommand(context.pos - token.length);
  }

  const inlineMatch = /(^|\s)([@$][^\s]*)$/u.exec(beforeCursor);
  if (inlineMatch === null) {
    return null;
  }

  const token = inlineMatch[2] ?? "";
  const from = context.pos - token.length;
  if (token.startsWith("@")) {
    return completeWorkspacePath(from, token);
  }

  return completeSkill(from);
}

async function completeWorkspacePath(
  from: number,
  token: string
): Promise<CompletionResult | null> {
  const appServerId = props.appServer?.id;
  if (appServerId === undefined) {
    return null;
  }

  const query = token.slice(1).trim();
  const entries =
    query.length === 0 || query.endsWith("/")
      ? await apiClient.listWorkspaceEntries(appServerId, query)
      : rankWorkspaceSearchResults(await apiClient.searchWorkspaceFiles(appServerId, query), query);
  return {
    from,
    options: entries.map(workspaceEntryCompletion),
    validFor: /^@[^\s]*$/u
  };
}

function workspaceEntryCompletion(entry: WorkspaceEntryDto): Completion {
  return {
    label: `@${entry.path}`,
    type: entry.kind === "directory" ? "folder" : "file",
    detail: entry.kind,
    apply: `@${entry.path}${entry.kind === "directory" ? "" : " "}`
  };
}

async function completeSkill(from: number): Promise<CompletionResult> {
  const appServerId = props.appServer?.id;
  const codexSkills =
    appServerId === undefined ? [] : await cachedCodexSkills(appServerId, { refreshInBackground: true });

  return {
    from,
    options: codexSkills.map(skillCompletion),
    validFor: /^\$[\w-]*$/u
  };
}

async function completeSlashCommand(from: number): Promise<CompletionResult> {
  const appServerId = props.appServer?.id;
  const commands = appServerId === undefined ? [] : await cachedCodexCommands(appServerId);

  return {
    from,
    options: commands.map(commandCompletion),
    validFor: /^\/[\w-]*$/u
  };
}

async function completeSlashCommandOption(
  from: number,
  command: string
): Promise<CompletionResult> {
  const appServerId = props.appServer?.id;
  const threadId = props.thread?.id;
  const options =
    appServerId === undefined
      ? []
      : await cachedCodexCommandOptions(appServerId, command, threadId);

  return {
    from,
    options: options.map((option) => commandOptionCompletion(command, option)),
    validFor: /^[^\s]*$/u
  };
}

async function cachedCodexCommands(appServerId: string): Promise<readonly CodexCommandDto[]> {
  const cached = commandCompletionCache.get(appServerId);
  if (cached !== undefined) {
    return cached;
  }

  const commands = await apiClient.listCodexCommands(appServerId);
  commandCompletionCache.set(appServerId, commands);
  return commands;
}

async function cachedCodexSkills(
  appServerId: string,
  options: { readonly refreshInBackground?: boolean } = {}
): Promise<readonly SkillDto[]> {
  const cached = skillCompletionCache.get(appServerId);
  if (cached !== undefined) {
    if (options.refreshInBackground === true) {
      void apiClient
        .listCodexSkills(appServerId)
        .then((skills) => {
          skillCompletionCache.set(appServerId, skills);
        })
        .catch((error: unknown) => {
          notifyError(error, "Failed to refresh Codex skills");
        });
    }
    return cached;
  }

  const skills = await apiClient.listCodexSkills(appServerId);
  skillCompletionCache.set(appServerId, skills);
  return skills;
}

async function cachedCodexCommandOptions(
  appServerId: string,
  command: string,
  threadId: string | undefined
): Promise<readonly CodexCommandOptionDto[]> {
  const key = `${appServerId}:${threadId ?? ""}:${normalizeSlashCommand(command)}`;
  const cached = commandOptionCompletionCache.get(key);
  if (normalizeSlashCommand(command) === "/subagents" && cached !== undefined) {
    void apiClient
      .listCodexCommandOptions(appServerId, command, threadId)
      .then((options) => {
        commandOptionCompletionCache.set(key, options);
      })
      .catch((error: unknown) => {
        notifyError(error, "Failed to refresh subagents");
      });
    return cached;
  }
  if (cached !== undefined) {
    return cached;
  }

  const options = await apiClient.listCodexCommandOptions(appServerId, command, threadId);
  commandOptionCompletionCache.set(key, options);
  return options;
}

function skillCompletion(skill: SkillDto): Completion {
  return {
    label: `$${skill.name}`,
    type: "variable",
    detail: compactCompletionDetail(skill.description),
    apply: `$${skill.name} `
  };
}

function commandCompletion(command: CodexCommandDto): Completion {
  return {
    label: command.name,
    type: "keyword",
    detail: compactCompletionDetail(command.description),
    apply:
      command.name === "/plan"
        ? applySlashCommandOption(command.name, "plan", "Plan")
        : command.hasOptions === true
          ? applySlashCommandAndOpenOptions(command.name)
          : `${command.name} `
  };
}

function commandOptionCompletion(command: string, option: CodexCommandOptionDto): Completion {
  return {
    label: option.label,
    type: "constant",
    detail: compactCompletionDetail(option.description),
    apply: applySlashCommandOption(command, option.value ?? option.label, option.label)
  };
}

function applySlashCommandAndOpenOptions(commandName: string): NonNullable<Completion["apply"]> {
  return (view, _completion, from, to) => {
    const insert = `${commandName} `;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length }
    });
    queueMicrotask(() => startCompletion(view));
  };
}

function applySlashCommandOption(
  command: string,
  option: string,
  label: string
): NonNullable<Completion["apply"]> {
  return (view, _completion, from, to) => {
    const threadId = props.thread?.id;
    if (threadId === undefined) {
      return;
    }

    if (normalizeSlashCommand(command) === "/subagents") {
      replaceEditorDraft("");
      emit("switch-thread", option);
      return;
    }

    void apiClient
      .applyCodexCommandSelection(threadId, { command, option })
      .then(() => {
        replaceEditorDraft("");
        emit("settings-updated");
        notifyInfo(`${command} set to ${label}`, "Thread settings updated");
      })
      .catch((error: unknown) => {
        notifyError(error, "Failed to apply Codex command");
        view.dispatch({
          changes: { from, to, insert: option },
          selection: { anchor: from + option.length }
        });
      });
  };
}

function normalizeSlashCommand(command: string): string {
  const normalized = command.trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function insertTabIndent(view: EditorView): boolean {
  view.dispatch(view.state.replaceSelection("  "));
  return true;
}

function compactCompletionDetail(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function dragEnterComposer(event: DragEvent): void {
  dragDepth += 1;
  updateComposerDropFeedback(event);
}

function dragOverComposer(event: DragEvent): void {
  updateComposerDropFeedback(event);
}

function dragLeaveComposer(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    isDropTarget.value = false;
  }
}

function dropIntoComposer(event: DragEvent): void {
  dragDepth = 0;
  isDropTarget.value = false;

  if (props.thread === null || !canEdit.value) {
    return;
  }

  const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
  if (imageFiles.length > 0) {
    void uploadImageFiles(imageFiles);
    return;
  }

  const text = readMessageTextDrop(event.dataTransfer);
  if (text.trim().length === 0) {
    return;
  }

  const currentDraft = currentEditorText();
  replaceEditorDraft(appendDroppedText(currentDraft, text), true);
  scheduleDraftSave();
}

function updateComposerDropFeedback(event: DragEvent): void {
  const canDrop =
    canEdit.value &&
    (canDropMessageText(event.dataTransfer) || hasImageFileData(event.dataTransfer));
  isDropTarget.value = canDrop;
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
  }
}

async function pickImages(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";

  if (files.length === 0) {
    return;
  }

  await uploadImageFiles(files);
}

function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (dataTransfer === null) {
    return [];
  }

  return [...dataTransfer.files].filter(isSupportedImageFile);
}

function hasImageFileData(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) {
    return false;
  }

  if (dataTransfer.files.length > 0) {
    return imageFilesFromDataTransfer(dataTransfer).length > 0;
  }

  return [...dataTransfer.items].some(
    (item) => item.kind === "file" && IMAGE_MIME_TYPES.has(item.type)
  );
}

function isSupportedImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
}

async function uploadImageFiles(files: readonly File[]): Promise<void> {
  const imageFiles = files.filter(isSupportedImageFile);
  if (imageFiles.length === 0) {
    return;
  }

  const remaining = MAX_ATTACHMENTS - attachments.value.length;
  if (imageFiles.length > remaining) {
    notifyError(
      new Error(`A message can include at most ${MAX_ATTACHMENTS} images`),
      "Too many images"
    );
    return;
  }

  uploading.value = true;
  try {
    for (const file of imageFiles) {
      const response = await apiClient.uploadImage(file);
      attachments.value = [
        ...attachments.value,
        {
          attachment: response.attachment,
          previewUrl: URL.createObjectURL(file)
        }
      ];
    }
  } catch (error) {
    notifyError(error, "Failed to upload image");
  } finally {
    uploading.value = false;
  }
}

function removeAttachment(id: string): void {
  const item = attachments.value.find((candidate) => candidate.attachment.id === id);
  if (item !== undefined) {
    URL.revokeObjectURL(item.previewUrl);
  }
  attachments.value = attachments.value.filter((candidate) => candidate.attachment.id !== id);
}

function sendComposer(): void {
  if (fileSearchOpen.value) {
    return;
  }

  emit("send", {
    draftMarkdown: currentEditorText(),
    attachmentIds: attachments.value.map((item) => item.attachment.id),
    onSuccess: () => {
      replaceEditorDraft("");
      historyBrowseIndex.value = -1;
      historyInsertionAnchor = -1;
      historyInsertedRange = null;
      clearAttachments();
    }
  });
}

function browseComposerHistory(direction: -1 | 1): void {
  if (editorView === null) {
    return;
  }

  browseComposerHistoryInternal(editorView, direction);
}

function browseComposerHistoryWithKeyboard(view: EditorView, direction: -1 | 1): boolean {
  if (!view.state.selection.main.empty) {
    return false;
  }

  return browseComposerHistoryInternal(view, direction);
}

function browseComposerHistoryInternal(view: EditorView, direction: -1 | 1): boolean {
  const history = composerHistory.value;
  if (history.length === 0) {
    return false;
  }

  if (direction === -1) {
    if (historyBrowseIndex.value >= history.length - 1) {
      return false;
    }
    if (historyBrowseIndex.value === -1) {
      historyInsertionAnchor = view.state.selection.main.head;
      historyInsertedRange = {
        from: historyInsertionAnchor,
        to: historyInsertionAnchor
      };
    }
    historyBrowseIndex.value += 1;
    applyHistoryInsertion(view, history[historyBrowseIndex.value] ?? "");
    return true;
  }

  if (historyBrowseIndex.value === -1) {
    return false;
  }
  if (historyBrowseIndex.value === 0) {
    historyBrowseIndex.value = -1;
    applyHistoryInsertion(view, "");
    historyInsertionAnchor = -1;
    historyInsertedRange = null;
    return true;
  }

  historyBrowseIndex.value -= 1;
  applyHistoryInsertion(view, history[historyBrowseIndex.value] ?? "");
  return true;
}

function applyHistoryInsertion(view: EditorView, text: string): void {
  if (historyInsertionAnchor < 0) {
    return;
  }

  const range = historyInsertedRange ?? {
    from: historyInsertionAnchor,
    to: historyInsertionAnchor
  };
  const insert = text.length === 0 ? "" : `${text}\n`;
  const nextHead = range.from + insert.length;

  applyingExternalDraft = true;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: nextHead }
  });
  applyingExternalDraft = false;

  historyInsertedRange = {
    from: range.from,
    to: range.from + insert.length
  };
  setLocalDraft(view.state.doc.toString());
  scheduleDraftSave();
  void nextTick(() => view.focus());
}

function replaceEditorDraft(nextDraft: string, markUserEdit = false): void {
  setLocalDraft(nextDraft, markUserEdit);
  if (editorView === null || editorView.state.doc.toString() === nextDraft) {
    return;
  }

  applyingExternalDraft = true;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: nextDraft },
    selection: { anchor: nextDraft.length }
  });
  applyingExternalDraft = false;
}

function setLocalDraft(nextDraft: string, markUserEdit = false): void {
  lastLocalDraft = nextDraft;
  editorDraft.value = nextDraft;
  if (markUserEdit) {
    lastLocalEditAt = Date.now();
  }
  emit("draft", nextDraft);
}

function currentEditorText(): string {
  return editorView?.state.doc.toString() ?? editorDraft.value;
}

function clearAttachments(): void {
  for (const item of attachments.value) {
    URL.revokeObjectURL(item.previewUrl);
  }
  attachments.value = [];
}

function scheduleDraftSave(): void {
  if (saveDraftTimer !== null) {
    clearTimeout(saveDraftTimer);
  }

  saveDraftTimer = setTimeout(() => {
    emit("save-draft");
    saveDraftTimer = null;
  }, 600);
}

function saveDraftNow(): void {
  if (saveDraftTimer !== null) {
    clearTimeout(saveDraftTimer);
    saveDraftTimer = null;
  }
  emit("save-draft");
}

function openFileSearch(): void {
  if (props.appServer === null) {
    notifyInfo("Open a thread with a workspace before searching files", "Workspace unavailable");
    return;
  }

  if (fileSearchOpen.value) {
    focusFileSearchInput(true);
    return;
  }

  fileSearchOpen.value = true;
  fileSearchLoading.value = false;
  fileSearchResults.value = [];
  fileSearchSelectedIndex.value = 0;
  void nextTick(() => focusFileSearchInput(fileSearchQuery.value.length > 0));
}

function closeFileSearch(options: { readonly restoreFocus?: boolean } = {}): void {
  cancelFileSearchRequest();
  fileSearchOpen.value = false;
  fileSearchLoading.value = false;
  fileSearchQuery.value = "";
  fileSearchResults.value = [];
  fileSearchSelectedIndex.value = 0;

  if (options.restoreFocus !== false) {
    void nextTick(() => {
      editorView?.focus();
    });
  }
}

function cancelFileSearchRequest(): void {
  fileSearchRequestToken += 1;
  if (fileSearchTimer !== null) {
    clearTimeout(fileSearchTimer);
    fileSearchTimer = null;
  }
}

function focusFileSearchInput(selectAll: boolean): void {
  const input = fileSearchInput.value;
  if (input === null) {
    return;
  }

  input.focus();
  if (selectAll) {
    input.setSelectionRange(0, input.value.length);
  }
}

function handleFileSearchKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusFileSearchInput(true);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeFileSearch();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveFileSearchSelection(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveFileSearchSelection(-1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const entry = selectedFileSearchResult.value;
    if (entry !== null) {
      void openWorkspaceFileFromSearch(entry);
    }
  }
}

function moveFileSearchSelection(delta: number): void {
  if (fileSearchResults.value.length === 0) {
    return;
  }

  const nextIndex =
    (fileSearchSelectedIndex.value + delta + fileSearchResults.value.length) %
    fileSearchResults.value.length;
  fileSearchSelectedIndex.value = nextIndex;
}

async function openWorkspaceFileFromSearch(entry: FileSearchResult): Promise<void> {
  if (entry.kind === "directory") {
    fileSearchQuery.value = entry.path;
    fileSearchSelectedIndex.value = 0;
    void nextTick(() => focusFileSearchInput(false));
    return;
  }

  const appServerId = props.appServer?.id;
  if (appServerId === undefined) {
    return;
  }

  try {
    await apiClient.openWorkspaceFileInVscode(appServerId, { path: entry.path });
    closeFileSearch();
  } catch (error) {
    notifyError(error, "Failed to open file in VS Code");
  }
}

async function openDebugDrawer(): Promise<void> {
  debugDrawerOpen.value = true;
  if (props.thread === null) {
    return;
  }

  rawEventsLoading.value = true;
  try {
    rawEvents.value = await apiClient.listThreadCodexEvents(props.thread.id, 100);
  } catch (error) {
    notifyError(error, "Failed to load raw Codex events");
  } finally {
    rawEventsLoading.value = false;
  }
}

async function respondApproval(id: string, decision: ApprovalDecision): Promise<void> {
  await approvals.respond(id, decision);
  dismissedApprovalIds.value = new Set([...dismissedApprovalIds.value, id]);
  approvalVisible.value = false;
}

function openRenameDialog(): void {
  if (!canRenameThread.value || props.thread === null) {
    return;
  }

  renameDraft.value = props.thread.threadName;
  renameDialogOpen.value = true;
}

async function renameThread(): Promise<void> {
  if (props.thread === null || !canRenameThread.value) {
    return;
  }

  const name = renameDraft.value.trim();
  if (name.length === 0 || name === props.thread.threadName) {
    renameDialogOpen.value = false;
    return;
  }

  renaming.value = true;
  try {
    const thread = await apiClient.renameThread(props.thread.id, name);
    emit("thread-updated", thread);
    renameDialogOpen.value = false;
  } catch (error) {
    notifyError(error, "Failed to rename thread");
  } finally {
    renaming.value = false;
  }
}

async function stopThreadWork(): Promise<void> {
  if (!canStop.value || props.thread === null) {
    return;
  }

  stopping.value = true;
  try {
    const result = await apiClient.stopThread(props.thread.id);
    if (
      result.transportStopAttempted &&
      !result.transportStopAccepted &&
      result.runningQueueItemId !== null
    ) {
      notifyInfo(
        "Queued work was stopped, but the running agent did not confirm interruption.",
        "Stop requested"
      );
      return;
    }

    notifyInfo("Thread agent stop requested.", "Stop requested");
  } catch (error) {
    notifyError(error, "Failed to stop thread agent");
  } finally {
    stopping.value = false;
  }
}

function approvalPartStatus(approvalId: string, fallback: string): string {
  return approvals.approvals.find((approval) => approval.id === approvalId)?.status ?? fallback;
}

function renderMarkdown(markdown: string): string {
  return markdownRenderer.render(withWorkspaceLinks(markdown));
}

function withWorkspaceLinks(markdown: string): string {
  return markdown.replace(WORKSPACE_PATH_PATTERN, (match, prefix: string, rawPath: string) => {
    const relativePath = toWorkspaceRelativePath(rawPath);
    if (relativePath === null) {
      return match;
    }

    return `${prefix}[${rawPath}](${WORKSPACE_LINK_PREFIX}${encodeURIComponent(relativePath)})`;
  });
}

function toWorkspaceRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.endsWith("/")) {
    return null;
  }

  const normalized = trimmed.replaceAll("\\", "/");
  const workspace = props.appServer?.workspace.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (workspace !== undefined && normalized.startsWith(`${workspace}/`)) {
    return normalized.slice(workspace.length + 1);
  }

  if (normalized.startsWith("/")) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.includes("..")) {
    return null;
  }

  return normalized.replace(/^\.\//u, "");
}

function workspacePathFromHref(href: string): string | null {
  if (href.startsWith(WORKSPACE_LINK_PREFIX)) {
    return decodeURIComponent(href.slice(WORKSPACE_LINK_PREFIX.length));
  }

  // Leave normal web links alone.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href)) {
    return null;
  }

  return toWorkspaceRelativePath(href);
}

async function handleMessageListClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const link = target.closest("a");
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }

  const workspacePath = link.dataset.workspacePath ?? workspacePathFromHref(link.getAttribute("href") ?? "");
  if (workspacePath === null || workspacePath.length === 0) {
    return;
  }

  event.preventDefault();
  const appServerId = props.appServer?.id;
  if (appServerId === undefined) {
    return;
  }

  try {
    await apiClient.openWorkspaceFileInVscode(appServerId, { path: workspacePath });
  } catch (error) {
    notifyError(error, "Failed to open file in VS Code");
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function formatRawJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatMessageTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatMessageDelta(previous: number | null, current: number): string {
  if (previous === null) {
    return "first reply";
  }

  const seconds = Math.max(0, Math.round((current - previous) / 1000));
  if (seconds < 60) {
    return `+${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `+${minutes}m` : `+${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `+${hours}h` : `+${hours}h ${remainingMinutes}m`;
}

function rankWorkspaceSearchResults(
  entries: readonly WorkspaceEntryDto[],
  query: string
): readonly FileSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const compactQuery = compactSearchToken(normalizedQuery);

  return [...entries]
    .filter((entry) => entry.kind === "file")
    .sort((left, right) => {
      const scoreDifference =
        workspaceSearchScore(right, normalizedQuery, compactQuery) -
        workspaceSearchScore(left, normalizedQuery, compactQuery);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return left.path.localeCompare(right.path);
    });
}

function workspaceSearchScore(
  entry: WorkspaceEntryDto,
  normalizedQuery: string,
  compactQuery: string
): number {
  const name = entry.name.toLowerCase();
  const fullPath = entry.path.toLowerCase();
  const compactName = compactSearchToken(name);
  const compactPath = compactSearchToken(fullPath);
  let score = 0;

  if (name === normalizedQuery) {
    score += 2000;
  } else if (name.startsWith(normalizedQuery)) {
    score += 1400;
  } else if (name.includes(normalizedQuery)) {
    score += 1000;
  }

  if (fullPath.startsWith(normalizedQuery)) {
    score += 520;
  } else if (fullPath.includes(normalizedQuery)) {
    score += 360;
  }

  if (compactQuery.length > 0) {
    if (compactName.startsWith(compactQuery)) {
      score += 760;
    } else if (fuzzyIncludes(compactName, compactQuery)) {
      score += 520;
    }

    if (compactPath.startsWith(compactQuery)) {
      score += 260;
    } else if (fuzzyIncludes(compactPath, compactQuery)) {
      score += 180;
    }
  }

  return score - entry.path.length;
}

function formatFileSearchEntryLabel(entry: WorkspaceEntryDto): string {
  return entry.kind === "directory" ? `${entry.name}/` : entry.name;
}

function compactSearchToken(value: string): string {
  return value.replace(/[\s/._-]+/gu, "");
}

function userMessageHistoryText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "markdown" ? [part.text] : []))
    .join("\n")
    .trim();
}

function fuzzyIncludes(candidate: string, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  let index = 0;
  for (const char of candidate) {
    if (char === query[index]) {
      index += 1;
      if (index >= query.length) {
        return true;
      }
    }
  }

  return false;
}
</script>

<style scoped>
.composer {
  position: relative;
}

.composer.search-open {
  padding-top: 280px;
}

.workspace-search-overlay {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  z-index: 5;
}

.workspace-search-panel {
  border: 1px solid var(--border-list);
  border-radius: 12px;
  background: var(--bg-panel-soft);
  box-shadow: 0 18px 40px var(--shadow-panel);
  overflow: hidden;
}

.workspace-search-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: linear-gradient(135deg, var(--accent-success), color-mix(in srgb, var(--accent-success) 68%, var(--accent-primary) 32%));
  color: var(--warm-white);
  font-size: 12px;
  letter-spacing: 0.02em;
}

.workspace-search-input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border-list);
  padding: 12px 14px;
  background: var(--bg-panel-elevated);
  color: var(--text-primary);
  font: inherit;
  outline: none;
}

.workspace-search-results {
  max-height: 180px;
  overflow-y: auto;
  padding: 8px;
  background: color-mix(in srgb, var(--bg-panel-soft) 80%, var(--bg-panel-elevated) 20%);
}

.workspace-search-hint {
  margin: 0;
  padding: 12px 10px;
  color: var(--text-secondary);
  font-size: 13px;
}

.workspace-search-empty {
  color: var(--text-danger);
}

.workspace-search-result {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 10px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.workspace-search-result strong {
  font-size: 13px;
  font-weight: 700;
}

.workspace-search-result span {
  color: var(--text-secondary);
  font-size: 12px;
}

.workspace-search-result.directory strong {
  color: var(--accent-success);
}

.thread-panel.ready-pulse .thread-header,
.thread-panel.ready-pulse .composer {
  animation: thread-ready-pulse 1.8s ease;
}

.workspace-search-result:hover,
.workspace-search-result.selected {
  border-color: var(--border-list);
  background: var(--bg-panel-elevated);
}

.thread-status-text {
  display: inline-flex;
  align-items: center;
  min-height: 1.35rem;
  color: var(--ink-soft);
  font-size: 0.74rem;
  font-weight: 700;
  line-height: 1;
}

.thread-status-text-not-loaded {
  color: color-mix(in srgb, var(--ink-soft) 92%, var(--text-muted) 8%);
}

.thread-status-text-working {
  color: color-mix(in srgb, var(--accent-warning) 74%, var(--text-primary) 26%);
}

.thread-status-text-idle {
  color: color-mix(in srgb, var(--accent-success) 62%, var(--text-primary) 38%);
}

.thread-send-button {
  border-color: color-mix(in srgb, var(--accent-primary) 24%, var(--line)) !important;
  background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-panel-elevated)) !important;
  color: var(--text-primary) !important;
}

.thread-stop-button {
  border-color: color-mix(in srgb, var(--accent-warning) 28%, var(--line)) !important;
  background: color-mix(in srgb, var(--accent-warning) 12%, var(--bg-panel-elevated)) !important;
  color: var(--text-primary) !important;
}

@keyframes thread-ready-pulse {
  0% {
    box-shadow: 0 0 0 0 var(--glow-success-0);
    transform: translateY(0);
  }

  20% {
    box-shadow: 0 0 0 4px var(--glow-success-1);
    transform: translateY(-1px);
  }

  55% {
    box-shadow: 0 0 0 10px var(--glow-success-2);
    transform: translateY(0);
  }

  100% {
    box-shadow: 0 0 0 0 var(--glow-success-0);
    transform: translateY(0);
  }
}

</style>
