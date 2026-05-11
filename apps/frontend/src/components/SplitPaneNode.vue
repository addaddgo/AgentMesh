<template>
  <div v-if="tree.type === 'split'" ref="splitRoot" class="split-node" :class="tree.direction">
    <div class="split-child" :style="firstStyle">
      <SplitPaneNode
        :tree="tree.first"
        @focus-leaf="$emit('focusLeaf', $event)"
        @update-tree="updateFirst"
      >
        <template #leaf="{ leaf: childLeaf }">
          <slot name="leaf" :leaf="childLeaf" />
        </template>
      </SplitPaneNode>
    </div>
    <div
      class="split-gutter"
      role="separator"
      :aria-orientation="tree.direction"
      @mousedown.prevent.stop="startResize"
    />
    <div class="split-child" :style="secondStyle">
      <SplitPaneNode
        :tree="tree.second"
        @focus-leaf="$emit('focusLeaf', $event)"
        @update-tree="updateSecond"
      >
        <template #leaf="{ leaf: childLeaf }">
          <slot name="leaf" :leaf="childLeaf" />
        </template>
      </SplitPaneNode>
    </div>
  </div>

  <div v-else class="split-leaf" @mousedown="$emit('focusLeaf', tree.id)">
    <slot name="leaf" :leaf="tree" />
  </div>
</template>

<script setup lang="ts">
import type { SplitPaneTree } from "@agentmesh/shared";
import { computed, ref } from "vue";

defineOptions({ name: "SplitPaneNode" });

const props = defineProps<{
  readonly tree: SplitPaneTree;
}>();

const emit = defineEmits<{
  focusLeaf: [leafId: string];
  updateTree: [tree: SplitPaneTree];
}>();

defineSlots<{
  leaf(props: { readonly leaf: SplitPaneTree }): unknown;
}>();

const firstStyle = computed(() => flexStyle(props.tree.type === "split" ? props.tree.ratio : 1));
const secondStyle = computed(() =>
  flexStyle(props.tree.type === "split" ? 1 - props.tree.ratio : 1)
);
const splitRoot = ref<HTMLElement | null>(null);

function updateFirst(first: SplitPaneTree): void {
  if (props.tree.type === "split") {
    emit("updateTree", { ...props.tree, first });
  }
}

function updateSecond(second: SplitPaneTree): void {
  if (props.tree.type === "split") {
    emit("updateTree", { ...props.tree, second });
  }
}

function startResize(): void {
  const element = splitRoot.value;
  if (props.tree.type !== "split" || element === null) {
    return;
  }

  const direction = props.tree.direction;
  const splitTree = props.tree;
  const onMouseMove = (event: MouseEvent): void => {
    const rect = element.getBoundingClientRect();
    const rawRatio =
      direction === "horizontal"
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    const ratio = Math.min(0.9, Math.max(0.1, rawRatio));
    emit("updateTree", { ...splitTree, ratio });
  };

  const onMouseUp = (): void => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    document.body.classList.remove("split-resizing");
  };

  document.body.classList.add("split-resizing");
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function flexStyle(ratio: number): { readonly flex: string } {
  return { flex: `${Math.max(ratio, 0.1)} 1 0` };
}
</script>
