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
          <el-tag>{{ filteredSkills.length }} / {{ skills.sourceSkills.length }}</el-tag>
          <span class="viewing-target-name">{{ viewedAppServerName }}</span>
        </div>

        <el-input
          v-model="skillSearch"
          class="skill-search"
          size="small"
          clearable
          placeholder="Search skills"
        />

        <el-empty v-if="skills.sourceSkills.length === 0" description="No skills found" />
        <div v-else-if="filteredAvailableSkillRows.length === 0" class="selection-list-scroll">
          <el-empty description="No matching skills" />
        </div>
        <div v-else class="selection-list selection-list-scroll skill-tree-list">
          <button
            v-for="row in filteredAvailableSkillRows"
            :key="row.key"
            class="selection-card"
            :class="[
              `tree-depth-${row.depth}`,
              row.type === 'directory'
                ? ['tree-directory', { collapsed: row.collapsed }]
                : ['tree-skill', { active: skills.selectedSkillPaths.includes(row.skillKey) }]
            ]"
            type="button"
            @click="
              row.type === 'directory'
                ? toggleAvailableDirectory(row.key)
                : toggleAvailableSkillDescription(row.skillKey)
            "
          >
            <span class="selection-card-title" v-if="row.type === 'directory'">
              <strong>{{ row.collapsed ? '▸' : '▾' }} {{ row.label }}</strong>
            </span>
            <span class="selection-card-title" v-else>
              <el-checkbox
                :model-value="skills.selectedSkillPaths.includes(row.skillKey)"
                @click.stop
                @change="skills.toggleSkill(row.skillKey)"
              />
              <strong>{{ row.skill.name }}</strong>
            </span>
            <small v-if="row.type === 'skill'">{{ row.pathLabel }}</small>
            <small
              v-if="
                row.type === 'skill' &&
                expandedAvailableSkillKeys.has(row.skillKey)
              "
            >
              {{ row.skill.description || "No description" }}
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
import type { AppServerDto, AppServerStatus, SkillDto, TargetSkillDto } from "@agentmesh/shared";
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
const expandedAvailableSkillKeys = ref(new Set<string>());
const collapsedAvailableDirectoryKeys = ref(new Set<string>());
const expandedTargetSkillNames = ref(new Set<string>());
const viewedAppServerName = computed(() =>
  viewedAppServerId.value === null ? "No workspace selected" : appServerName(viewedAppServerId.value)
);
type AvailableDirectoryRow = {
  readonly type: "directory";
  readonly key: string;
  readonly label: string;
  readonly depth: number;
  readonly collapsed: boolean;
};

type AvailableSkillRow = {
  readonly type: "skill";
  readonly key: string;
  readonly skillKey: string;
  readonly skill: SkillDto;
  readonly depth: number;
  readonly pathLabel: string;
};

type AvailableSkillRowItem = AvailableDirectoryRow | AvailableSkillRow;

type AvailableDirectoryNode = {
  readonly key: string;
  readonly label: string;
  readonly directories: Map<string, AvailableDirectoryNode>;
  readonly skills: SkillDto[];
};

const filteredSkills = computed(() => {
  const query = skillSearch.value.trim().toLowerCase();
  if (query.length === 0) {
    return skills.sourceSkills;
  }

  return skills.sourceSkills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      (skill.path ?? skill.name).toLowerCase().includes(query)
  );
});
const filteredAvailableSkillRows = computed<readonly AvailableSkillRowItem[]>(() => {
  const query = skillSearch.value.trim();
  return flattenAvailableSkillTree(buildAvailableSkillTree(filteredSkills.value), {
    forceExpand: query.length > 0,
    collapsedKeys: collapsedAvailableDirectoryKeys.value
  });
});

onMounted(() => {
  void initializeSkillsPage();
});

async function refreshSkills(): Promise<void> {
  await skills.load();
}

async function initializeSkillsPage(): Promise<void> {
  await skills.load();
  await appServers.load();
  const firstOnlineServer =
    appServers.appServers.find((server) => server.status === "online") ?? appServers.appServers[0];
  if (firstOnlineServer !== undefined) {
    await viewTargetAppServer(firstOnlineServer.id);
  }
}

async function viewTargetAppServer(appServerId: string): Promise<void> {
  viewedAppServerId.value = appServerId;
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

function toggleAvailableSkillDescription(skillKey: string): void {
  expandedAvailableSkillKeys.value = toggledSet(expandedAvailableSkillKeys.value, skillKey);
}

function toggleAvailableDirectory(directoryKey: string): void {
  collapsedAvailableDirectoryKeys.value = toggledSet(
    collapsedAvailableDirectoryKeys.value,
    directoryKey
  );
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

function availableSkillKey(skill: SkillDto): string {
  return skill.path ?? skill.name;
}

function buildAvailableSkillTree(skillsList: readonly SkillDto[]): AvailableDirectoryNode {
  const root: AvailableDirectoryNode = {
    key: "",
    label: "",
    directories: new Map<string, AvailableDirectoryNode>(),
    skills: []
  };

  for (const skill of skillsList) {
    const skillPath = skill.path ?? skill.name;
    const segments = skillPath.split("/").filter((segment) => segment.length > 0);
    const directorySegments = segments.slice(0, -1);
    let current = root;
    let currentKey = "";

    for (const segment of directorySegments) {
      currentKey = currentKey.length === 0 ? segment : `${currentKey}/${segment}`;
      let next = current.directories.get(segment);
      if (next === undefined) {
        next = {
          key: currentKey,
          label: segment,
          directories: new Map<string, AvailableDirectoryNode>(),
          skills: []
        };
        current.directories.set(segment, next);
      }
      current = next;
    }

    current.skills.push(skill);
  }

  return root;
}

function flattenAvailableSkillTree(
  node: AvailableDirectoryNode,
  options: {
    readonly forceExpand: boolean;
    readonly collapsedKeys: ReadonlySet<string>;
  },
  depth = 0
): AvailableSkillRowItem[] {
  const rows: AvailableSkillRowItem[] = [];
  const directories = [...node.directories.values()].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  const skillsList = [...node.skills].sort((left, right) =>
    availableSkillKey(left).localeCompare(availableSkillKey(right))
  );

  for (const directory of directories) {
    const collapsed = !options.forceExpand && options.collapsedKeys.has(directory.key);
    rows.push({
      type: "directory",
      key: directory.key,
      label: directory.label,
      depth,
      collapsed
    });

    if (!collapsed || options.forceExpand) {
      rows.push(...flattenAvailableSkillTree(directory, options, depth + 1));
    }
  }

  for (const skill of skillsList) {
    const skillKey = availableSkillKey(skill);
    rows.push({
      type: "skill",
      key: skillKey,
      skillKey,
      skill,
      depth,
      pathLabel: skill.path ?? skill.name
    });
  }

  return rows;
}
</script>

<style scoped>
.skill-tree-list {
  gap: 8px;
}

.tree-directory {
  background: color-mix(in srgb, var(--bg-panel-elevated) 76%, var(--bg-panel-soft) 24%);
  border-color: var(--border-list);
}

.tree-directory.collapsed {
  opacity: 0.92;
}

.tree-skill small {
  color: var(--text-secondary);
}

.tree-depth-0 {
  margin-left: 0;
}

.tree-depth-1 {
  margin-left: 14px;
}

.tree-depth-2 {
  margin-left: 28px;
}

.tree-depth-3,
.tree-depth-4,
.tree-depth-5 {
  margin-left: 42px;
}
</style>
