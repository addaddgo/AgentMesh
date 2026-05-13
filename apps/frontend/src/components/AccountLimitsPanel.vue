<template>
  <section class="account-limits-panel">
    <header class="account-limits-header">
      <h2>Account Limits</h2>
      <div class="account-limits-header-actions">
        <el-button
          size="small"
          :icon="Refresh"
          :loading="loading"
          circle
          title="Refresh account usage"
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

    <div v-if="loading" class="account-limits-empty">Loading...</div>
    <div v-else-if="usage.length === 0" class="account-limits-empty">No account usage data yet.</div>
    <div v-else class="account-limits-list">
      <article v-for="item in usage" :key="item.window" class="account-limit-card">
        <div class="account-limit-row">
          <strong>{{ windowLabel(item.window) }}</strong>
          <span>{{ formatTokens(item.usedTokens) }} used</span>
        </div>
        <div class="account-limit-row account-limit-meta">
          <span>{{ item.threadCount }} active thread{{ item.threadCount === 1 ? "" : "s" }}</span>
          <span>{{ formatLimit(item.limitTokens) }}</span>
        </div>
      </article>
      <p class="account-limits-note">
        Limit values are not exposed by the local Codex runtime, so this panel shows known local usage and marks limits as unavailable.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
defineEmits<{
  close: [];
}>();

import { CloseBold, Refresh } from "@element-plus/icons-vue";
import type { AccountUsageDto, AccountUsageWindow } from "@agentmesh/shared";
import { onMounted, ref } from "vue";

import { apiClient } from "../api/client";
import { notifyError } from "../stores/errors";

const loading = ref(false);
const usage = ref<readonly AccountUsageDto[]>([]);

onMounted(() => {
  void load();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    usage.value = await apiClient.getAccountUsage();
  } catch (error) {
    notifyError(error, "Failed to load account usage");
  } finally {
    loading.value = false;
  }
}

function windowLabel(window: AccountUsageWindow): string {
  return window === "5h" ? "5h Window" : "Weekly Window";
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatLimit(value: number | null): string {
  return value === null ? "Limit unavailable" : `${formatTokens(value)} limit`;
}
</script>

<style scoped>
.account-limits-panel {
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

.account-limits-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -0.75rem -0.75rem 0;
  padding: 0.62rem 0.75rem;
  border-bottom: 1px solid var(--line);
  border-radius: 1.15rem 1.15rem 0 0;
  background: var(--bg-tool-header);
}

.account-limits-header h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
}

.account-limits-header-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.account-limits-empty {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.account-limits-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.65rem;
  margin-top: 0.75rem;
}

.account-limit-card {
  display: grid;
  gap: 0.35rem;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--border-list);
  border-radius: 0.85rem;
  background: var(--bg-row-subtle);
}

.account-limit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.account-limit-meta {
  color: var(--el-text-color-secondary);
  font-size: 0.82rem;
}

.account-limits-note {
  margin: 0.1rem 0 0;
  color: var(--el-text-color-secondary);
  font-size: 0.78rem;
  line-height: 1.4;
}
</style>
