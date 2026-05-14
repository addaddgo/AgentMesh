<template>
  <el-container
    class="app-shell"
    :class="[`theme-${theme.theme}`]"
    :data-theme="theme.theme"
  >
    <header class="top-navigation">
      <nav>
        <RouterLink to="/">Boards</RouterLink>
        <RouterLink to="/skills">Skills</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <div id="top-board-actions" class="top-board-actions" />
      <div class="theme-indicator" :title="`Current theme: ${theme.theme}`">
        <span class="theme-indicator-dot" />
        {{ theme.theme }}
      </div>

      <div class="connection" :class="uiLayout.sseState">
        <span />
        {{ uiLayout.sseState }}
      </div>
    </header>

    <el-container>
      <el-main>
        <RouterView />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { onMounted, watch } from "vue";
import { RouterLink, RouterView } from "vue-router";

import { requestBrowserNotificationPermission } from "./services/notifications";
import { useRealtimeStore } from "./stores/realtime";
import { useThemeStore } from "./stores/theme";
import { useTodoStore } from "./stores/todos";
import { useUiLayoutStore } from "./stores/uiLayout";

const realtime = useRealtimeStore();
const theme = useThemeStore();
const todos = useTodoStore();
const uiLayout = useUiLayoutStore();

theme.loadPersistedTheme();

watch(
  () => theme.theme,
  () => {
    theme.applyTheme();
  }
);

onMounted(() => {
  void uiLayout.loadPersistedState();
  void requestBrowserNotificationPermission();
  void todos.ensureDeadlineWatcher();
  realtime.start();
});
</script>
