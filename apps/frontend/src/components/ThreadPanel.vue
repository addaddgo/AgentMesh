<template>
  <section class="thread-panel" :class="{ focused, missing: thread === null }">
    <template v-if="thread !== null">
      <header class="thread-header">
        <div class="thread-header-main">
          <strong>{{ threadTitle }}</strong>
          <el-tag size="small" :type="isWorking ? 'warning' : 'info'">
            {{ isWorking ? "working" : (thread.status ?? "idle") }}
          </el-tag>
          <span class="thread-param">model: {{ threadModel }}</span>
          <span class="thread-param">server: {{ appServer?.status ?? "missing" }}</span>
        </div>
        <div class="thread-header-actions">
          <el-tag v-if="thread.isGone" type="danger">Gone</el-tag>
          <el-tag v-else-if="appServer?.status !== 'online'" type="warning">Offline</el-tag>
          <el-button
            v-if="thread.status === 'notLoaded'"
            size="small"
            type="primary"
            :icon="SwitchButton"
            :loading="resuming"
            :disabled="appServer?.status !== 'online'"
            circle
            title="Resume thread"
            aria-label="Resume thread"
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

      <div ref="scrollContainer" class="message-list virtual-message-list" @scroll="onScroll">
        <div class="virtual-spacer" :style="{ height: `${virtualTotalHeight}px` }">
          <article
            v-for="item in virtualMessages"
            :key="item.message.id"
            class="message-card virtual-message-card"
            :class="item.message.role"
            :style="{ transform: `translateY(${item.top}px)` }"
            :draggable="canDragMessage(item.message)"
            @dragstart="dragMessage($event, item.message)"
          >
            <div class="message-meta">
              <strong>{{ item.message.role }}</strong>
              <div class="message-tags">
                <el-tag size="small">{{ item.message.status }}</el-tag>
                <el-tag v-if="item.message.turnId !== null" size="small" type="info"> turn </el-tag>
              </div>
            </div>
            <template
              v-for="(part, index) in item.message.parts"
              :key="`${item.message.id}-${index}`"
            >
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
                  <el-tag size="small">{{
                    approvalPartStatus(part.approvalId, part.status)
                  }}</el-tag>
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
          </article>
        </div>
      </div>

      <div
        class="composer"
        :class="{ 'drop-target': isDropTarget }"
        @dragenter.prevent="dragEnterComposer($event)"
        @dragover.prevent="dragOverComposer($event)"
        @dragleave="dragLeaveComposer"
        @drop.prevent="dropIntoComposer($event)"
      >
        <div class="composer-toolbar">
          <span>Markdown source</span>
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
            <div>
              <strong>{{ item.attachment.filename }}</strong>
              <small>{{ formatBytes(item.attachment.size) }}</small>
            </div>
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
              `${attachments.length}/${MAX_ATTACHMENTS} images selected. Drop message text here.`
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
  PictureFilled,
  Promotion,
  SwitchButton
} from "@element-plus/icons-vue";
import type {
  AppServerDto,
  ApprovalDecision,
  ApprovalDto,
  ChatMessage,
  CodexEventDto,
  ImageAttachmentDto,
  QueueItemDto,
  ThreadDto
} from "@agentmesh/shared";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import MarkdownIt from "markdown-it";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { apiClient } from "../api/client";
import ApprovalCard from "./ApprovalCard.vue";
import { useApprovalStore } from "../stores/approvals";
import { notifyError } from "../stores/errors";
import { useSkillStore } from "../stores/skills";
import {
  canDropMessageText,
  readMessageTextDrop,
  textForMessageDrag,
  writeMessageTextDrag
} from "../utils/messageDragDrop";

const MESSAGE_ROW_HEIGHT = 190;
const VIRTUAL_BUFFER = 6;
const MAX_ATTACHMENTS = 5;
const markdownRenderer = new MarkdownIt({ html: false, linkify: true });

const SLASH_COMMANDS: readonly Completion[] = [
  { label: "/help", type: "keyword", detail: "Show Codex commands", apply: "/help " },
  { label: "/model", type: "keyword", detail: "Change or inspect model", apply: "/model " },
  { label: "/approvals", type: "keyword", detail: "Configure approval mode", apply: "/approvals " },
  { label: "/status", type: "keyword", detail: "Show current thread status", apply: "/status " },
  { label: "/compact", type: "keyword", detail: "Compact conversation context", apply: "/compact " },
  { label: "/init", type: "keyword", detail: "Initialize project instructions", apply: "/init " },
  { label: "/review", type: "keyword", detail: "Ask for a code review", apply: "/review " },
  { label: "/clear", type: "keyword", detail: "Clear local prompt context", apply: "/clear " }
];

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
      readonly attachmentIds: readonly string[];
      readonly onSuccess: () => void;
    }
  ];
  dropped: [value: string];
  resume: [];
  close: [];
}>();

const approvals = useApprovalStore();
const skills = useSkillStore();
const scrollContainer = ref<HTMLElement | null>(null);
const editorHost = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(420);
const debugDrawerOpen = ref(false);
const rawEvents = ref<readonly CodexEventDto[]>([]);
const rawEventsLoading = ref(false);
const attachments = ref<SelectedAttachment[]>([]);
const uploading = ref(false);
const isDropTarget = ref(false);
const editableCompartment = new Compartment();
let editorView: EditorView | null = null;
let saveDraftTimer: ReturnType<typeof setTimeout> | null = null;
let dragDepth = 0;

const disabledReason = computed(() => {
  if (props.thread?.isGone === true) {
    return "This disappeared thread is read-only.";
  }
  if (props.appServer?.status !== "online") {
    return "The app-server is offline.";
  }
  if (props.thread?.status === "notLoaded") {
    return "Resume this thread before sending.";
  }
  return null;
});

const canEdit = computed(() => disabledReason.value === null);
const canSend = computed(
  () =>
    canEdit.value &&
    !uploading.value &&
    (props.draft.trim().length > 0 || attachments.value.length > 0)
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
const threadModel = computed(() => {
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
const threadTitle = computed(() => {
  const appServerName = props.appServer === null ? "missing" : props.appServer.name;
  return `${appServerName} / ${props.thread?.threadName ?? "thread"}`;
});
const virtualTotalHeight = computed(() => props.messages.length * MESSAGE_ROW_HEIGHT);
const virtualMessages = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / MESSAGE_ROW_HEIGHT) - VIRTUAL_BUFFER);
  const visibleCount = Math.ceil(viewportHeight.value / MESSAGE_ROW_HEIGHT) + VIRTUAL_BUFFER * 2;
  return props.messages.slice(start, start + visibleCount).map((message, index) => ({
    message,
    top: (start + index) * MESSAGE_ROW_HEIGHT
  }));
});

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
        icons: false,
        maxRenderedOptions: 12,
        override: [completeCommandOrSkill]
      }),
      editableCompartment.of(EditorView.editable.of(canEdit.value)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }

        emit("draft", update.state.doc.toString());
        scheduleDraftSave();
      })
    ]
  });

  if (skills.skills.length === 0 && !skills.loading) {
    void skills.load();
  }
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
  () => props.draft,
  (nextDraft) => {
    if (editorView === null || editorView.state.doc.toString() === nextDraft) {
      return;
    }

    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: nextDraft }
    });
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

function completeCommandOrSkill(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = line.text.slice(0, context.pos - line.from);
  const match = /(^|\s)([/$][\w-]*)$/u.exec(beforeCursor);
  if (match === null) {
    return null;
  }

  const token = match[2] ?? "";
  const from = context.pos - token.length;
  if (token.startsWith("/")) {
    return {
      from,
      options: SLASH_COMMANDS,
      validFor: /^\/[\w-]*$/u
    };
  }

  return {
    from,
    options: skills.skills.map((skill) => ({
      label: `$${skill.name}`,
      type: "variable",
      detail: compactCompletionDetail(skill.description),
      apply: `$${skill.name} `
    })),
    validFor: /^\$[\w-]*$/u
  };
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

  const text = readMessageTextDrop(event.dataTransfer);
  if (props.thread === null || !canEdit.value || text.trim().length === 0) {
    return;
  }

  emit("dropped", text);
}

function updateComposerDropFeedback(event: DragEvent): void {
  const canDrop = canEdit.value && canDropMessageText(event.dataTransfer);
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

  const remaining = MAX_ATTACHMENTS - attachments.value.length;
  if (files.length > remaining) {
    notifyError(
      new Error(`A message can include at most ${MAX_ATTACHMENTS} images`),
      "Too many images"
    );
    return;
  }

  uploading.value = true;
  try {
    for (const file of files) {
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
    attachmentIds: attachments.value.map((item) => item.attachment.id),
    onSuccess: clearAttachments
  });
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

function onScroll(): void {
  if (scrollContainer.value === null) {
    return;
  }

  scrollTop.value = scrollContainer.value.scrollTop;
  viewportHeight.value = scrollContainer.value.clientHeight;
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
</script>
