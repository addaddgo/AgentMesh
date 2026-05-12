<template>
  <section class="workspace-stats-panel">
    <header class="stats-header">
      <span class="stats-title">Workspace Usage</span>
      <el-button
        size="small"
        :icon="Refresh"
        :loading="loading"
        circle
        title="Refresh stats"
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
    </header>

    <div v-if="loading" class="stats-loading">Loading...</div>

    <div v-else-if="data.length === 0" class="stats-empty">No workspace usage data yet.</div>

    <div v-else class="stats-chart">
      <div class="bar-chart">
        <div
          v-for="(bar, index) in bars"
          :key="bar.appServerId"
          class="bar-row"
        >
          <div class="bar-label" :title="bar.workspace">
            {{ bar.shortName }}
          </div>
          <div class="bar-track">
            <div
              class="bar-fill"
              :style="{ width: bar.percent + '%', background: barColors[index % barColors.length] }"
            />
          </div>
          <div class="bar-value">{{ formatDuration(bar.totalDurationMs) }}</div>
        </div>
      </div>

      <div class="stats-footer">
        <span class="total-label">Total: {{ formatDuration(totalDurationMs) }}</span>
        <span class="turn-label">{{ totalTurns }} turns</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">

defineEmits<{
  close: [];
}>();

import { CloseBold, Refresh } from "@element-plus/icons-vue";
import type { WorkspaceUsageDto } from "@agentmesh/shared";
import { onMounted, ref, computed } from "vue";

import { apiClient } from "../api/client";
import { notifyError } from "../stores/errors";

const barColors = [
  "#4f46e5",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6"
];

const loading = ref(false);
const data = ref<readonly WorkspaceUsageDto[]>([]);

const maxDuration = computed(() =>
  Math.max(...data.value.map((d) => d.totalDurationMs), 1)
);

const totalDurationMs = computed(() =>
  data.value.reduce((sum, d) => sum + d.totalDurationMs, 0)
);

const totalTurns = computed(() =>
  data.value.reduce((sum, d) => sum + d.turnCount, 0)
);

const bars = computed(() =>
  data.value.map((d) => ({
    ...d,
    shortName: shortenWorkspace(d.workspace),
    percent: (d.totalDurationMs / maxDuration.value) * 100
  }))
);

onMounted(() => {
  void load();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await apiClient.getWorkspaceUsage();
  } catch (error) {
    notifyError(error, "Failed to load workspace usage stats");
  } finally {
    loading.value = false;
  }
}

function shortenWorkspace(workspace: string): string {
  const parts = workspace.replace(/\/+$/u, "").split("/");
  const base = parts.at(-1) ?? workspace;
  return base.length > 24 ? base.slice(0, 21) + "..." : base;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
</script>

<style scoped>
.workspace-stats-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  overflow: auto;
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.stats-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stats-loading,
.stats-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.bar-chart {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar-label {
  width: 100px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  flex: 1;
  height: 20px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
  min-width: 2px;
}

.bar-value {
  width: 80px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.stats-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-light);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
