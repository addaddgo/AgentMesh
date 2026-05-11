<template>
  <section class="content-page skills-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">Skill Distribution</p>
        <h1>Skills</h1>
        <p>
          Scan the backend skills root, select skills, and sync them into app-server workspaces.
        </p>
      </div>
      <div class="actions">
        <el-button :loading="skills.loading" @click="refreshSkills">Refresh Skills</el-button>
        <el-button :loading="appServers.loading" @click="appServers.load()">
          Refresh App Servers
        </el-button>
      </div>
    </header>

    <div class="skills-layout">
      <section class="selection-panel">
        <div class="sidebar-title">
          <strong>Available skills</strong>
          <el-tag>{{ skills.selectedSkillNames.length }} selected</el-tag>
        </div>

        <el-empty v-if="skills.skills.length === 0" description="No skills found" />
        <div v-else class="selection-list">
          <button
            v-for="skill in skills.skills"
            :key="skill.name"
            class="selection-card"
            :class="{ active: skills.selectedSkillNames.includes(skill.name) }"
            type="button"
            @click="skills.toggleSkill(skill.name)"
          >
            <span class="selection-card-title">
              <el-checkbox
                :model-value="skills.selectedSkillNames.includes(skill.name)"
                @click.stop
                @change="skills.toggleSkill(skill.name)"
              />
              <strong>{{ skill.name }}</strong>
            </span>
            <small>{{ skill.description || "No description" }}</small>
          </button>
        </div>
      </section>

      <section class="selection-panel">
        <div class="sidebar-title">
          <strong>Target app-servers</strong>
          <el-tag>{{ skills.selectedAppServerIds.length }} selected</el-tag>
        </div>

        <el-empty
          v-if="appServers.appServers.length === 0"
          description="No app servers configured"
        />
        <div v-else class="selection-list">
          <button
            v-for="server in appServers.appServers"
            :key="server.id"
            class="selection-card"
            :class="{ active: skills.selectedAppServerIds.includes(server.id) }"
            type="button"
            @click="skills.toggleAppServer(server.id)"
          >
            <span class="selection-card-title">
              <el-checkbox
                :model-value="skills.selectedAppServerIds.includes(server.id)"
                @click.stop
                @change="skills.toggleAppServer(server.id)"
              />
              <strong>{{ appServerLabel(server) }}</strong>
              <el-tag :type="statusTagType(server.status)" size="small">{{ server.status }}</el-tag>
            </span>
            <small>{{ server.hostKind }}</small>
          </button>
        </div>
      </section>

      <section class="sync-panel">
        <header class="sync-header">
          <div>
            <p class="eyebrow">Sync</p>
            <h2>Overwrite target skills</h2>
            <p>
              Backend copies each selected skill to
              <code>&lt;workspace&gt;/.codex/skills/&lt;skill-name&gt;</code>.
            </p>
          </div>
          <el-button
            type="primary"
            :loading="skills.syncing"
            :disabled="!skills.canSync"
            @click="skills.syncSelected()"
          >
            Sync Selected
          </el-button>
        </header>

        <el-alert
          v-if="!skills.canSync && !skills.syncing"
          title="Select at least one skill and one app-server."
          type="info"
          show-icon
          :closable="false"
        />

        <div v-if="skills.syncResults.length > 0" class="sync-results">
          <article
            v-for="result in skills.syncResults"
            :key="`${result.skillName}:${result.appServerId}`"
            class="sync-result-card"
            :class="result.status"
          >
            <div>
              <strong>{{ result.skillName }}</strong>
              <span>to {{ appServerName(result.appServerId) }}</span>
            </div>
            <el-tag :type="result.status === 'synced' ? 'success' : 'danger'">
              {{ result.status }}
            </el-tag>
            <small>{{ result.targetPath ?? "No target path returned" }}</small>
            <el-alert
              v-if="result.error !== null"
              :title="result.error"
              type="error"
              show-icon
              :closable="false"
            />
          </article>
        </div>
        <el-empty v-else description="Sync results will appear here" />
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AppServerDto, AppServerStatus } from "@agentmesh/shared";
import { onMounted } from "vue";

import { useAppServerStore } from "../stores/appServers";
import { useSkillStore } from "../stores/skills";

const skills = useSkillStore();
const appServers = useAppServerStore();

onMounted(() => {
  void Promise.all([skills.load(), appServers.load()]);
});

async function refreshSkills(): Promise<void> {
  await skills.load();
}

function appServerName(id: string): string {
  const server = appServers.appServers.find((candidate) => candidate.id === id);
  return server === undefined ? id : appServerLabel(server);
}

function appServerLabel(server: AppServerDto): string {
  return `${server.host} / ${workspaceBasename(server.workspace)}`;
}

function workspaceBasename(workspace: string): string {
  const normalized = workspace.trim().replace(/[\\/]+$/u, "");
  const basename = normalized.split(/[\\/]/u).pop();
  return basename !== undefined && basename.length > 0 ? basename : workspace;
}

function statusTagType(status: AppServerStatus): "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "online":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "error":
      return "danger";
    case "offline":
      return "info";
  }
}
</script>
