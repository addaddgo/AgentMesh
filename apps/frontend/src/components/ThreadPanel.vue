<template>
  <section class="thread-panel" :class="{ focused, missing: thread === null }">
    <template v-if="thread !== null">
      <header class="thread-header">
        <div class="thread-header-main">
          <strong>{{ threadTitle }}</strong>
        </div>
        <div class="thread-header-status-row">
          <el-tag size="small" :type="threadStatusTagType">
            {{ effectiveThreadStatus }}
          </el-tag>
          <el-tag v-if="thread.isGone" size="small" type="danger">Gone</el-tag>
          <span class="thread-param">mode: {{ threadCollaborationMode }}</span>
          <span class="thread-param">model: {{ threadModel }}</span>
          <span class="thread-param">think: {{ threadReasoningEffort }}</span>
          <span class="thread-param">ctx: {{ threadContextRemaining }}</span>
          <span class="thread-param">perm: {{ threadPermissionMode }}</span>
        </div>
        <div class="thread-header-actions">
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

      <section v-if="threadApprovals.length > 0" class="thread-approval-stack">
        <ApprovalCard
          v-for="approval in threadApprovals"
          :key="approval.id"
          :approval="approval"
          :responding="approvals.isResponding(approval.id)"
          @respond="respondApproval"
        />
      </section>

      <div ref="scrollContainer" class="message-list">
        <article
          v-for="(message, index) in messages"
          :key="message.id"
          class="message-card"
          :class="message.role"
          :draggable="canDragMessage(message)"
          @dragstart="dragMessage($event, message)"
        >
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
              formatMessageDelta(messages[index - 1]?.createdAt ?? null, message.createdAt)
            }}</span>
          </footer>
        </article>
      </div>

      <div
        class="composer"
        :class="{ 'drop-target': isDropTarget }"
        @dragenter.prevent="dragEnterComposer($event)"
        @dragover.prevent="dragOverComposer($event)"
        @dragleave="dragLeaveComposer"
        @drop.prevent="dropIntoComposer($event)"
      >
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
              :disabled="!canEdit || attachments.length >= MAX_ATTACHMENTS"
              :loading="uploading"
              :icon="PictureFilled"
              circle
              title="Attach images"
              aria-label="Attach images"
              @click="fileInput?.click()"
            />
            <el-button
              type="primary"
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
  Check,
  CloseBold,
  Delete,
  Document,
  EditPen,
  PictureFilled,
  Promotion,
  SwitchButton
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
const markdownRenderer = new MarkdownIt({ html: false, linkify: true });

type SelectedAttachment = {
  readonly attachment: ImageAttachmentDto;
  readonly previewUrl: string;
};

const props = defineProps<{
  readonly appServer: AppServerDto | null;
  readonly thread: ThreadDto | null;
  readonly messages: readonly ChatMessage[];
  readonly queueItems: readonly QueueItemDto[];
  readonly draft: string;
  readonly focused: boolean;
  readonly resuming?: boolean;
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
const debugDrawerOpen = ref(false);
const rawEvents = ref<readonly CodexEventDto[]>([]);
const rawEventsLoading = ref(false);
const attachments = ref<SelectedAttachment[]>([]);
const uploading = ref(false);
const isDropTarget = ref(false);
const renameDialogOpen = ref(false);
const renameDraft = ref("");
const renaming = ref(false);
const editorDraft = ref(props.draft);
const editableCompartment = new Compartment();
let editorView: EditorView | null = null;
let saveDraftTimer: ReturnType<typeof setTimeout> | null = null;
let dragDepth = 0;
let activeEditorThreadId: string | null = props.thread?.id ?? null;
let lastLocalDraft = props.draft;
let lastLocalEditAt = 0;
let applyingExternalDraft = false;
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
const threadApprovals = computed<readonly ApprovalDto[]>(() => {
  if (props.thread === null) {
    return [];
  }

  return approvals.byThreadId(props.thread.id);
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
const threadStatusTagType = computed(() => {
  if (effectiveThreadStatus.value === "working") {
    return "warning";
  }
  if (effectiveThreadStatus.value === "notLoaded") {
    return "info";
  }
  return "success";
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
watch(
  () => props.messages.length,
  async () => {
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
            key: "ArrowDown",
            run: moveCompletionSelection(true)
          },
          {
            key: "ArrowUp",
            run: moveCompletionSelection(false)
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
            run: closeCompletion
          },
          {
            key: "Enter",
            run: acceptCompletion
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
  () => props.thread?.id,
  (threadId) => {
    clearAttachments();
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

  const entries = await apiClient.listWorkspaceEntries(appServerId, token.slice(1));
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
  emit("send", {
    draftMarkdown: currentEditorText(),
    attachmentIds: attachments.value.map((item) => item.attachment.id),
    onSuccess: () => {
      replaceEditorDraft("");
      clearAttachments();
    }
  });
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

function approvalPartStatus(approvalId: string, fallback: string): string {
  return approvals.approvals.find((approval) => approval.id === approvalId)?.status ?? fallback;
}

function renderMarkdown(markdown: string): string {
  return markdownRenderer.render(markdown);
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
</script>
