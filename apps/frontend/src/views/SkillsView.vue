<template>
  <section class="content-page skills-page">
    <header class="page-header">
      <div>
        <h1>Skills</h1>
      </div>
      <div class="actions">
        <el-button
          :icon="MagicStick"
          :loading="skills.loading"
          circle
          title="Refresh skills"
          aria-label="Refresh skills"
          @click="refreshSkills"
        />
        <el-button
          :icon="Refresh"
          :loading="appServers.loading"
          circle
          title="Refresh app-servers"
          aria-label="Refresh app-servers"
          @click="appServers.load()"
        />
      </div>
    </header>

    <div class="skills-layout">
      <section class="selection-panel">
        <div class="sidebar-title">
          <strong>Available skills</strong>
          <el-tag>{{ filteredSkills.length }} / {{ skills.skills.length }}</el-tag>
          <span class="viewing-target-name">{{ viewedAppServerName }}</span>
        </div>

        <el-input
          v-model="skillSearch"
          class="skill-search"
          size="small"
          clearable
          placeholder="Search skills"
        />

        <el-empty
          v-if="viewedAppServerId === null"
          description="Click a target app-server to load Codex skills"
        />
        <el-empty v-else-if="skills.skills.length === 0" description="No Codex skills found" />
        <div v-else-if="filteredSkills.length === 0" class="selection-list-scroll">
          <el-empty description="No matching skills" />
        </div>
        <div v-else class="selection-list selection-list-scroll">
          <button
            v-for="skill in filteredSkills"
            :key="skill.name"
            class="selection-card"
            :class="{ active: skills.selectedSkillNames.includes(skill.name) }"
            type="button"
            @click="toggleAvailableSkillDescription(skill.name)"
          >
            <span class="selection-card-title">
              <el-checkbox
                :model-value="skills.selectedSkillNames.includes(skill.name)"
                @click.stop
                @change="skills.toggleSkill(skill.name)"
              />
              <strong>{{ skill.name }}</strong>
            </span>
            <small v-if="expandedAvailableSkillNames.has(skill.name)">
              {{ skill.description || "No description" }}
            </small>
          </button>
        </div>
      </section>

      <div class="target-workspace-stack">
        <section class="selection-panel">
          <div class="sidebar-title">
            <strong>Target app-servers</strong>
            <el-tag>{{ skills.selectedAppServerIds.length }} selected</el-tag>
            <span class="target-actions">
              <el-button
                type="primary"
                :icon="Connection"
                :loading="skills.syncing"
                :disabled="!skills.canSync"
                circle
                title="Overwrite selected skills"
                aria-label="Overwrite selected skills"
                @click="skills.syncSelected()"
              />
              <el-button
                :icon="Refresh"
                :loading="targetSkillsLoading"
                circle
                title="Refresh target skills"
                aria-label="Refresh target skills"
                @click="loadTargetSkills"
              />
            </span>
          </div>

          <el-empty
            v-if="appServers.appServers.length === 0"
            description="No app servers configured"
          />
          <div v-else class="selection-list target-server-list">
            <button
              v-for="server in appServers.appServers"
              :key="server.id"
              class="selection-card"
              :class="{
                active: skills.selectedAppServerIds.includes(server.id),
                viewing: viewedAppServerId === server.id
              }"
              type="button"
              @click="viewTargetAppServer(server.id)"
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

        <section class="selection-panel target-skill-panel">
          <div class="sidebar-title">
            <strong>Workspace skill list</strong>
            <span class="viewing-target-name">{{ viewedAppServerName }}</span>
            <el-tag>{{ targetSkills.length }}</el-tag>
          </div>
          <div class="target-skill-list">
            <el-empty
              v-if="viewedAppServerId === null"
              description="Click a target app-server"
            />
            <el-empty v-else-if="targetSkills.length === 0" description="No target skills" />
            <button
              v-for="targetSkill in targetSkills"
              v-else
              :key="targetSkill.name"
              class="target-skill-row"
              :class="{ expanded: expandedTargetSkillNames.has(targetSkill.name) }"
              type="button"
              @click="toggleTargetSkillDescription(targetSkill.name)"
            >
              <span class="target-skill-content">
                <strong>{{ targetSkill.name }}</strong>
                <small v-if="expandedTargetSkillNames.has(targetSkill.name)">
                  {{ targetSkill.description || "No description" }}
                </small>
              </span>
              <el-button
                size="small"
                type="danger"
                :icon="Delete"
                circle
                title="Delete target skill"
                aria-label="Delete target skill"
                @click.stop="deleteTargetSkill(targetSkill)"
              />
            </button>
          </div>

          <div v-if="skills.syncResults.length > 0" class="sync-results compact-sync-results">
            <article
              v-for="result in skills.syncResults"
              :key="`${result.skillName}:${result.appServerId}`"
              class="sync-result-card"
              :class="result.status"
            >
              <strong>{{ result.skillName }}</strong>
              <el-tag :type="result.status === 'synced' ? 'success' : 'danger'">
                {{ result.status }}
              </el-tag>
            </article>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Connection, Delete, MagicStick, Refresh } from "@element-plus/icons-vue";
import type { AppServerDto, AppServerStatus, TargetSkillDto } from "@agentmesh/shared";
import { computed, onMounted, ref } from "vue";

import { apiClient } from "../api/client";
import { useAppServerStore } from "../stores/appServers";
import { notifyError } from "../stores/errors";
import { useSkillStore } from "../stores/skills";

const skills = useSkillStore();
const appServers = useAppServerStore();
const skillSearch = ref("");
const viewedAppServerId = ref<string | null>(null);
const targetSkills = ref<readonly TargetSkillDto[]>([]);
const targetSkillsLoading = ref(false);
const expandedAvailableSkillNames = ref(new Set<string>());
const expandedTargetSkillNames = ref(new Set<string>());
const viewedAppServerName = computed(() =>
  viewedAppServerId.value === null ? "No workspace selected" : appServerName(viewedAppServerId.value)
);
const filteredSkills = computed(() => {
  const query = skillSearch.value.trim().toLowerCase();
  if (query.length === 0) {
    return skills.skills;
  }

  return skills.skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query)
  );
});

onMounted(() => {
  void initializeSkillsPage();
});

async function refreshSkills(): Promise<void> {
  if (viewedAppServerId.value === null) {
    return;
  }

  await skills.loadCodexSkills(viewedAppServerId.value);
}

async function initializeSkillsPage(): Promise<void> {
  await appServers.load();
  const firstOnlineServer =
    appServers.appServers.find((server) => server.status === "online") ?? appServers.appServers[0];
  if (firstOnlineServer !== undefined) {
    viewTargetAppServer(firstOnlineServer.id);
  }
}

async function viewTargetAppServer(appServerId: string): Promise<void> {
  viewedAppServerId.value = appServerId;
  skills.showCachedCodexSkills(appServerId);
  skills.refreshCodexSkillsInBackground(appServerId);
  await loadTargetSkills();
}

async function loadTargetSkills(): Promise<void> {
  const appServerId = viewedAppServerId.value;
  if (appServerId === null) {
    targetSkills.value = [];
    return;
  }

  targetSkillsLoading.value = true;
  try {
    targetSkills.value = await apiClient.listTargetSkills(appServerId);
    const currentNames = new Set(targetSkills.value.map((skill) => skill.name));
    expandedTargetSkillNames.value = new Set(
      [...expandedTargetSkillNames.value].filter((name) => currentNames.has(name))
    );
  } catch (error) {
    notifyError(error, "Failed to load target skills");
  } finally {
    targetSkillsLoading.value = false;
  }
}

function toggleAvailableSkillDescription(skillName: string): void {
  expandedAvailableSkillNames.value = toggledSet(expandedAvailableSkillNames.value, skillName);
}

function toggleTargetSkillDescription(skillName: string): void {
  expandedTargetSkillNames.value = toggledSet(expandedTargetSkillNames.value, skillName);
}

function toggledSet(source: Set<string>, value: string): Set<string> {
  const next = new Set(source);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

async function deleteTargetSkill(skill: TargetSkillDto): Promise<void> {
  const appServerId = viewedAppServerId.value;
  if (appServerId === null) {
    return;
  }

  try {
    await apiClient.deleteTargetSkill(appServerId, skill.name);
    await loadTargetSkills();
  } catch (error) {
    notifyError(error, "Failed to delete target skill");
  }
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
