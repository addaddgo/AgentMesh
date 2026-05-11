<template>
  <el-container class="app-shell">
    <header class="top-navigation">
      <nav>
        <RouterLink to="/">Boards</RouterLink>
        <RouterLink to="/skills">Skills</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <div id="top-board-actions" class="top-board-actions" />

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
import { onMounted } from "vue";
import { RouterLink, RouterView } from "vue-router";

import { useRealtimeStore } from "./stores/realtime";
import { useUiLayoutStore } from "./stores/uiLayout";

const realtime = useRealtimeStore();
const uiLayout = useUiLayoutStore();

onMounted(() => {
  void uiLayout.loadPersistedState();
  realtime.start();
});
</script>
