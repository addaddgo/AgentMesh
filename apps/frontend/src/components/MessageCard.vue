<template>
  <article
    ref="root"
    class="message-card"
    :class="message.role"
  >
    <div v-if="canDrag" class="message-actions">
      <button
        class="message-drag-handle"
        type="button"
        draggable="true"
        title="Drag message text"
        aria-label="Drag message text"
        @dragstart="dragMessage"
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
          alt="Codex image attachment"
          loading="lazy"
          decoding="async"
          @load="emitMeasured"
        />
        <figcaption>
          {{ part.workspacePath ?? "Image attachment" }}
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
      <details
        v-else-if="part.type === 'approval'"
        class="part-card approval-part"
        open
        @toggle="emitMeasured"
      >
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
      <details v-else-if="part.type === 'diff'" class="part-card" @toggle="emitMeasured">
        <summary>Diff</summary>
        <pre>{{ part.text }}</pre>
      </details>
      <details v-else-if="part.type === 'tool_call'" class="part-card" @toggle="emitMeasured">
        <summary>
          Tool call · {{ part.toolName }}
          <el-tag size="small">{{ part.status }}</el-tag>
        </summary>
        <pre>{{ formatJson(part.input) }}</pre>
      </details>
      <details v-else-if="part.type === 'tool_result'" class="part-card" @toggle="emitMeasured">
        <summary>
          Tool result · {{ part.callId }}
          <el-tag size="small">{{ part.status }}</el-tag>
        </summary>
        <pre>{{ formatJson(part.output) }}</pre>
      </details>
      <details v-else class="part-card" @toggle="emitMeasured">
        <summary>Event · {{ part.eventType }}</summary>
        <pre>{{ formatJson(part.raw) }}</pre>
      </details>
    </template>
    <footer v-if="message.role === 'assistant'" class="message-time">
      <span>{{ formatMessageTime(message.createdAt) }}</span>
      <span>{{ formatMessageDelta(previousMessageCreatedAt, message.createdAt) }}</span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { Check, CloseBold, Rank } from "@element-plus/icons-vue";
import type { ApprovalDecision, ChatMessage } from "@agentmesh/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { useApprovalStore } from "../stores/approvals";
import { textForMessageDrag, writeMessageTextDrag } from "../utils/messageDragDrop";

const props = defineProps<{
  readonly message: ChatMessage;
  readonly previousMessageCreatedAt: number | null;
  readonly renderMarkdown: (markdown: string) => string;
}>();

const emit = defineEmits<{
  "height-change": [height: number];
}>();

const approvals = useApprovalStore();
const root = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

const canDrag = computed(() => textForMessageDrag(props.message).trim().length > 0);

onMounted(() => {
  emitMeasured();
  if (root.value === null || typeof ResizeObserver === "undefined") {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    emitMeasured();
  });
  resizeObserver.observe(root.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

function emitMeasured(): void {
  void nextTick(() => {
    if (root.value !== null) {
      emit("height-change", root.value.offsetHeight);
    }
  });
}

function dragMessage(event: DragEvent): void {
  const text = textForMessageDrag(props.message);
  if (event.dataTransfer === null || text.trim().length === 0) {
    event.preventDefault();
    return;
  }

  writeMessageTextDrag(event.dataTransfer, text);
}

async function respondApproval(id: string, decision: ApprovalDecision): Promise<void> {
  await approvals.respond(id, decision);
  emitMeasured();
}

function approvalPartStatus(approvalId: string, fallback: string): string {
  return approvals.approvals.find((approval) => approval.id === approvalId)?.status ?? fallback;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
