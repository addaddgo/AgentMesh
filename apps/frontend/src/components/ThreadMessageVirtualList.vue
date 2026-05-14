<template>
  <div ref="scrollContainer" class="message-list" @scroll="handleScroll" @click="handleClick">
    <div class="message-virtual-spacer" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="row in visibleRows"
        :key="cacheKeyFor(row.message)"
        class="message-virtual-row"
        :class="row.message.role"
        :style="{ transform: `translateY(${row.top}px)` }"
      >
        <MessageCard
          :message="row.message"
          :previous-message-created-at="row.previousMessageCreatedAt"
          :render-markdown="renderMarkdown"
          @height-change="setMeasuredHeight(row.message, $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from "@agentmesh/shared";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from "vue";

import MessageCard from "./MessageCard.vue";

const WORKSPACE_LINK_PREFIX = "workspace:";
const ROW_GAP_PX = 10;
const OVERSCAN_PX = 600;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

const props = defineProps<{
  readonly messages: readonly ChatMessage[];
  readonly renderMarkdown: (markdown: string) => string;
  readonly showUserMessages: boolean;
}>();

const emit = defineEmits<{
  "open-workspace-path": [path: string];
}>();

const scrollContainer = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const isNearBottom = ref(true);
const heightByKey = ref<Record<string, number>>({});
const forceTailRender = ref(false);
let containerResizeObserver: ResizeObserver | null = null;
let settleBottomFrame: number | null = null;

const heights = computed(() =>
  props.messages.map(
    (message) =>
      heightByKey.value[cacheKeyFor(message)] ?? estimateMessageHeight(message, props.showUserMessages)
  )
);

const offsets = computed(() => {
  const next: number[] = [];
  let total = 0;
  for (const height of heights.value) {
    next.push(total);
    total += height;
  }
  return next;
});

const totalHeight = computed(() => {
  const lastOffset = offsets.value.at(-1) ?? 0;
  const lastHeight = heights.value.at(-1) ?? 0;
  return Math.max(lastOffset + lastHeight, viewportHeight.value);
});

const visibleRange = computed(() => {
  if (forceTailRender.value) {
    const end = props.messages.length;
    return {
      start: Math.max(0, end - 24),
      end
    };
  }

  const startOffset = Math.max(0, scrollTop.value - OVERSCAN_PX);
  const endOffset = scrollTop.value + viewportHeight.value + OVERSCAN_PX;
  const startIndex = findStartIndex(offsets.value, heights.value, startOffset);
  let endIndex = startIndex;

  while (endIndex < props.messages.length && (offsets.value[endIndex] ?? Number.POSITIVE_INFINITY) < endOffset) {
    endIndex += 1;
  }

  return {
    start: startIndex,
    end: Math.min(props.messages.length, endIndex + 1)
  };
});

const visibleRows = computed(() =>
  props.messages.slice(visibleRange.value.start, visibleRange.value.end).map((message, offset) => {
    const index = visibleRange.value.start + offset;
    return {
      message,
      top: offsets.value[index] ?? 0,
      previousMessageCreatedAt: props.messages[index - 1]?.createdAt ?? null
    };
  })
);

onMounted(() => {
  updateViewportMetrics();
  updateNearBottom();
  void nextTick(() => {
    scrollToBottom();
  });

  if (scrollContainer.value !== null && typeof ResizeObserver !== "undefined") {
    containerResizeObserver = new ResizeObserver(() => {
      updateViewportMetrics();
      if (isNearBottom.value) {
        void nextTick(() => {
          scrollToBottom();
        });
      }
    });
    containerResizeObserver.observe(scrollContainer.value);
  }
});

onBeforeUnmount(() => {
  containerResizeObserver?.disconnect();
  if (settleBottomFrame !== null) {
    cancelAnimationFrame(settleBottomFrame);
  }
});

defineExpose({
  scrollToBottom
});

watch(
  () => props.showUserMessages,
  () => {
    updateViewportMetrics();
    updateNearBottom();
  }
);

watch(
  () => props.messages.length,
  (nextLength, previousLength) => {
    if (nextLength > previousLength && isNearBottom.value) {
      void nextTick(() => {
        scrollToBottom();
      });
    }
  }
);

watch(totalHeight, (nextHeight, previousHeight) => {
  if (nextHeight > previousHeight && isNearBottom.value) {
    void nextTick(() => {
      scrollToBottom();
    });
  }
});

function cacheKeyFor(message: ChatMessage): string {
  return `${props.showUserMessages ? "with-user" : "assistant-only"}:${message.id}`;
}

function setMeasuredHeight(message: ChatMessage, height: number): void {
  const key = cacheKeyFor(message);
  const nextHeight = height + ROW_GAP_PX;
  if (heightByKey.value[key] === nextHeight) {
    return;
  }

  heightByKey.value = {
    ...heightByKey.value,
    [key]: nextHeight
  };
}

function handleScroll(): void {
  if (scrollContainer.value === null) {
    return;
  }

  scrollTop.value = scrollContainer.value.scrollTop;
  viewportHeight.value = scrollContainer.value.clientHeight;
  updateNearBottom();
}

function updateViewportMetrics(): void {
  if (scrollContainer.value === null) {
    return;
  }

  scrollTop.value = scrollContainer.value.scrollTop;
  viewportHeight.value = scrollContainer.value.clientHeight;
}

function updateNearBottom(): void {
  if (scrollContainer.value === null) {
    isNearBottom.value = true;
    return;
  }

  const distanceToBottom =
    totalHeight.value - (scrollContainer.value.scrollTop + scrollContainer.value.clientHeight);
  isNearBottom.value = distanceToBottom <= NEAR_BOTTOM_THRESHOLD_PX;
}

function scrollToBottom(): void {
  if (scrollContainer.value === null) {
    return;
  }

  forceTailRender.value = true;
  applyBottomScrollPosition();
  settleBottomScroll(0);
}

function applyBottomScrollPosition(): void {
  if (scrollContainer.value === null) {
    return;
  }

  scrollContainer.value.scrollTop = Math.max(0, totalHeight.value - scrollContainer.value.clientHeight);
  updateViewportMetrics();
  updateNearBottom();
}

function settleBottomScroll(attempt: number): void {
  if (settleBottomFrame !== null) {
    cancelAnimationFrame(settleBottomFrame);
  }

  settleBottomFrame = requestAnimationFrame(() => {
    settleBottomFrame = null;
    void nextTick(() => {
      applyBottomScrollPosition();

      if (attempt >= 4 || lastMessageMeasured()) {
        forceTailRender.value = false;
        return;
      }

      settleBottomScroll(attempt + 1);
    });
  });
}

function lastMessageMeasured(): boolean {
  const lastMessage = props.messages.at(-1);
  if (lastMessage === undefined) {
    return true;
  }

  return cacheKeyFor(lastMessage) in heightByKey.value;
}

function handleClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const link = target.closest("a");
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }

  const href = link.getAttribute("href") ?? "";
  const workspacePath = link.dataset.workspacePath ?? workspacePathFromHref(href);
  if (workspacePath === null || workspacePath.length === 0) {
    return;
  }

  event.preventDefault();
  emit("open-workspace-path", workspacePath);
}

function workspacePathFromHref(href: string): string | null {
  if (!href.startsWith(WORKSPACE_LINK_PREFIX)) {
    return null;
  }

  return decodeURIComponent(href.slice(WORKSPACE_LINK_PREFIX.length));
}

function findStartIndex(
  rowOffsets: readonly number[],
  rowHeights: readonly number[],
  targetOffset: number
): number {
  let low = 0;
  let high = rowOffsets.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const rowEnd = (rowOffsets[mid] ?? 0) + (rowHeights[mid] ?? 0);
    if (rowEnd > targetOffset) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
      answer = low;
    }
  }

  return Math.max(0, Math.min(answer, rowOffsets.length));
}

function estimateMessageHeight(message: ChatMessage, showUserMessages: boolean): number {
  let height = 56;

  for (const part of message.parts) {
    if (part.type === "markdown") {
      height += estimateMarkdownHeight(part.text, message.role, showUserMessages);
      continue;
    }

    if (part.type === "image") {
      height += 220;
      continue;
    }

    if (part.type === "error") {
      height += 120;
      continue;
    }

    if (
      part.type === "approval" ||
      part.type === "diff" ||
      part.type === "tool_call" ||
      part.type === "tool_result" ||
      part.type === "event"
    ) {
      height += 96;
      continue;
    }
  }

  if (message.role === "assistant") {
    height += 24;
  }

  return height + ROW_GAP_PX;
}

function estimateMarkdownHeight(
  markdown: string,
  role: ChatMessage["role"],
  showUserMessages: boolean
): number {
  const maxWidthChars =
    role === "assistant" && !showUserMessages
      ? 110
      : role === "tool" || role === "event" || role === "system"
        ? 92
        : 78;

  const lines = markdown.split("\n");
  let visualLines = 0;

  for (const line of lines) {
    const lineLength = Math.max(1, line.length);
    visualLines += Math.max(1, Math.ceil(lineLength / maxWidthChars));
  }

  const codeFenceMatches = markdown.match(/```/g);
  const codeFenceCount = codeFenceMatches === null ? 0 : Math.floor(codeFenceMatches.length / 2);
  const bulletCount = (markdown.match(/^\s*[-*+] /gm) ?? []).length;
  const headingCount = (markdown.match(/^\s*#{1,6}\s/gm) ?? []).length;

  return 18 + visualLines * 22 + codeFenceCount * 42 + bulletCount * 8 + headingCount * 10;
}
</script>
