<template>
  <section class="workspace-stats-panel">
    <header class="stats-header">
      <h2>Workspace Usage</h2>
      <div class="stats-header-actions">
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
      </div>
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
            {{ bar.workspace }}
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
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 1.15rem;
  background: #f5f5f0;
  box-shadow:
    0 18px 46px var(--warm-shadow),
    0 1px 0 rgba(255, 255, 255, 0.85) inset;
  overflow: hidden;
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -0.75rem -0.75rem 0;
  padding: 0.62rem 0.75rem;
  border-bottom: 1px solid var(--line);
  border-radius: 1.15rem 1.15rem 0 0;
  background: #d4edda;
}

.stats-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
}

.stats-header-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.stats-chart {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0.5rem 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
  gap: 0.5rem;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid #c0c0c0;
  border-radius: 0.75rem;
  background: rgba(255, 253, 244, 0.72);
}

.bar-label {
  min-width: 80px;
  flex: 1;
  font-size: 0.85rem;
  color: var(--el-text-color-secondary);
  text-align: right;
  overflow: hidden;
  white-space: nowrap;
}

.bar-track {
  flex: 1;
  height: 16px;
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
  width: 70px;
  flex-shrink: 0;
  font-size: 0.8rem;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.stats-footer {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0.5rem 0;
  border-top: 1px solid var(--el-border-color-light);
  font-size: 0.85rem;
  color: var(--el-text-color-secondary);
}
</style>
