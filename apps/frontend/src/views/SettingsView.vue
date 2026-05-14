<template>
  <section class="content-page app-server-page">
    <header class="page-header">
      <div>
        <h1>App Servers Configuration</h1>
      </div>
      <div class="settings-header-actions">
        <div class="theme-switcher">
          <span>Theme</span>
          <el-segmented v-model="selectedTheme" :options="themeOptions" />
        </div>
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

    <div class="app-server-layout">
      <aside class="server-list-panel">
        <div class="sidebar-title">
          <strong>Configured</strong>
          <el-button
            size="small"
            type="primary"
            :icon="Plus"
            circle
            title="New app-server"
            aria-label="New app-server"
            @click="newServer"
          />
        </div>

        <el-empty
          v-if="appServers.appServers.length === 0"
          description="No app servers configured"
        />
        <button
          v-for="server in appServers.appServers"
          v-else
          :key="server.id"
          class="server-card"
          :class="{ active: server.id === editingId }"
          type="button"
          @click="editServer(server)"
        >
          <span class="server-name">{{ appServerLabel(server) }}</span>
          <el-tag :type="statusTagType(server.status)" size="small">{{ server.status }}</el-tag>
          <small>{{ server.hostKind }}</small>
        </button>
      </aside>

      <main class="server-editor">
        <header class="editor-header">
          <div>
            <p class="eyebrow">{{ editingServer === null ? "Create" : "Edit" }}</p>
            <h2>{{ editingServer === null ? "New app server" : appServerLabel(editingServer) }}</h2>
          </div>
          <el-tag v-if="editingServer !== null" :type="statusTagType(editingServer.status)">
            {{ editingServer.status }}
          </el-tag>
        </header>
        <div class="server-editor-scroll">
          <el-alert
            v-if="editingServer?.lastError"
            class="last-error"
            :title="editingServer.lastError"
            type="error"
            show-icon
            :closable="false"
          />

          <div v-if="form.name.trim().length === 0" class="generated-name">
            <span>Generated app-server name</span>
            <strong>{{ generatedName }}</strong>
          </div>

          <el-form
            class="server-form detailed"
            label-position="top"
            :model="form"
            @submit.prevent="save"
          >
            <el-form-item label="Name" :error="fieldError('name')">
              <el-input v-model="form.name" placeholder="Leave empty to generate from workspace" />
            </el-form-item>

            <div class="form-grid">
              <el-form-item label="Host type">
                <el-segmented v-model="form.hostKind" :options="hostKindOptions" />
              </el-form-item>
              <el-form-item label="Command" :error="fieldError('command')">
                <el-input v-model="form.command" placeholder="codex app-server" />
              </el-form-item>
            </div>

            <el-form-item label="Workspace" :error="fieldError('workspace')">
              <el-input v-model="form.workspace" placeholder="/absolute/path/to/workspace" />
            </el-form-item>

            <el-form-item label="VS Code Path" :error="fieldError('vscodePath')">
              <el-input
                v-model="form.vscodePath"
                placeholder="Optional. Defaults to code"
              />
            </el-form-item>

            <el-form-item label="Environment" :error="fieldError('environment')">
              <el-input
                v-model="form.environmentText"
                type="textarea"
                :rows="5"
                placeholder="OPENAI_API_KEY=...\nHTTPS_PROXY=http://127.0.0.1:7890"
              />
            </el-form-item>

            <section class="observation-stack-settings">
              <div class="sidebar-title">
                <strong>Observation Stack</strong>
              </div>
              <p class="observation-intro">
                Define the first-message harness prompt and the skill stack Codex should treat as
                workspace observation infrastructure.
              </p>
              <el-form-item
                label="Observation Prompt"
                :error="fieldError('observationPrompt')"
              >
                <el-input
                  v-model="form.observationPrompt"
                  type="textarea"
                  :rows="6"
                  :placeholder="defaultObservationPrompt"
                />
              </el-form-item>
              <p class="settings-help">
                Leave this empty to use the default workspace observation-stack prompt.
              </p>
              <el-form-item
                label="Active Observation Skills"
                :error="fieldError('activeObservationSkillNames')"
              >
                <p v-if="availableSkillsLoading" class="observation-skill-loading">
                  Refreshing workspace skills…
                </p>
                <el-checkbox-group v-model="form.activeObservationSkillNames">
                  <div v-if="availableSkills.length > 0" class="observation-skill-flow">
                    <label
                      v-for="skill in availableSkills"
                      :key="skill.path"
                      class="observation-skill-card"
                    >
                      <el-checkbox :value="skill.name">
                        <span class="observation-skill-name">${{ skill.name }}</span>
                      </el-checkbox>
                      <small>{{ skill.description }}</small>
                    </label>
                  </div>
                  <div v-else class="observation-skill-empty">
                    No installed workspace skills found for this app-server yet.
                  </div>
                </el-checkbox-group>
              </el-form-item>
            </section>

            <div v-if="form.hostKind === 'ssh'" class="form-grid">
              <el-form-item label="SSH host" :error="fieldError('host')">
                <el-input v-model="form.host" placeholder="buildbox.example.com" />
              </el-form-item>
              <el-form-item label="SSH user" :error="fieldError('sshUser')">
                <el-input v-model="form.sshUser" placeholder="Optional user" />
              </el-form-item>
              <el-form-item label="SSH port" :error="fieldError('sshPort')">
                <el-input-number
                  v-model="form.sshPort"
                  :min="1"
                  :max="65535"
                  controls-position="right"
                />
              </el-form-item>
            </div>

            <el-alert
              v-if="formError !== null"
              :title="formError"
              type="error"
              show-icon
              :closable="false"
            />

            <div class="form-actions">
              <el-button
                type="primary"
                :icon="editingServer === null ? CirclePlus : Select"
                native-type="submit"
                :loading="saving"
                :disabled="form.workspace.trim().length === 0"
                circle
                :title="editingServer === null ? 'Create app-server' : 'Save changes'"
                :aria-label="editingServer === null ? 'Create app-server' : 'Save changes'"
              />
              <el-button
                :icon="RefreshLeft"
                circle
                title="Reset"
                aria-label="Reset"
                @click="resetForm"
              />
              <el-button
                v-if="editingServer !== null"
                type="danger"
                :disabled="saving || deleting"
                :loading="deleting"
                plain
                @click="deleteWorkspace"
              >
                Delete Workspace
              </el-button>
            </div>
          </el-form>

          <section v-if="editingServer !== null" class="lifecycle-panel">
            <div>
              <p class="eyebrow">Lifecycle</p>
              <h3>{{ appServerLabel(editingServer) }}</h3>
              <p>
                {{ editingServer.hostKind }} · {{ editingServer.command }}
              </p>
            </div>
            <div class="lifecycle-actions">
              <el-button
                type="success"
                :icon="VideoPlay"
                :loading="runningAction === 'start'"
                :disabled="isBusy(editingServer.status) || editingServer.status === 'online'"
                circle
                title="Start"
                aria-label="Start"
                @click="runLifecycle('start')"
              />
              <el-button
                type="warning"
                :icon="VideoPause"
                :loading="runningAction === 'stop'"
                :disabled="isBusy(editingServer.status) || editingServer.status === 'offline'"
                circle
                title="Stop"
                aria-label="Stop"
                @click="runLifecycle('stop')"
              />
              <el-button
                :icon="RefreshRight"
                :loading="runningAction === 'restart'"
                :disabled="isBusy(editingServer.status)"
                circle
                title="Restart"
                aria-label="Restart"
                @click="runLifecycle('restart')"
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ElMessageBox } from "element-plus";
import {
  CirclePlus,
  Plus,
  Refresh,
  RefreshLeft,
  RefreshRight,
  Select,
  VideoPause,
  VideoPlay
} from "@element-plus/icons-vue";
import type { ApiErrorDetail, AppServerDto, AppServerStatus, TargetSkillDto } from "@agentmesh/shared";
import { computed, onMounted, reactive, ref } from "vue";

import { apiClient, ApiClientError, type CreateAppServerPayload } from "../api/client";
import { notifyError } from "../stores/errors";
import { useAppServerStore } from "../stores/appServers";
import { useThemeStore, type ThemeMode } from "../stores/theme";

type AppServerForm = {
  name: string;
  hostKind: "local" | "ssh";
  host: string;
  sshUser: string;
  sshPort: number | undefined;
  workspace: string;
  command: string;
  vscodePath: string;
  environmentText: string;
  observationPrompt: string;
  activeObservationSkillNames: string[];
};

const hostKindOptions = [
  { label: "Local", value: "local" },
  { label: "SSH", value: "ssh" }
] as const;
const themeOptions = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" }
] as const;

const appServers = useAppServerStore();
const theme = useThemeStore();
const editingId = ref<string | null>(null);
const saving = ref(false);
const deleting = ref(false);
const runningAction = ref<"start" | "stop" | "restart" | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const availableSkills = ref<readonly TargetSkillDto[]>([]);
const availableSkillsLoading = ref(false);
const form = reactive<AppServerForm>(emptyForm());

const editingServer = computed(
  () => appServers.appServers.find((server) => server.id === editingId.value) ?? null
);
const generatedName = computed(() => generateNamePreview(form.workspace, appServers.appServers));
const defaultObservationPrompt = computed(() =>
  buildDefaultObservationPrompt(form.activeObservationSkillNames)
);
const selectedTheme = computed<ThemeMode>({
  get: () => theme.theme,
  set: (value) => {
    theme.setTheme(value);
  }
});

onMounted(() => {
  void appServers.load();
});

function emptyForm(): AppServerForm {
  return {
    name: "",
    hostKind: "local",
    host: "",
    sshUser: "",
    sshPort: undefined,
    workspace: "",
    command: "",
    vscodePath: "",
    environmentText: "",
    observationPrompt: "",
    activeObservationSkillNames: []
  };
}

function newServer(): void {
  editingId.value = null;
  availableSkills.value = [];
  availableSkillsLoading.value = false;
  resetForm();
}

function editServer(server: AppServerDto): void {
  editingId.value = server.id;
  fieldErrors.value = {};
  formError.value = null;
  form.name = server.name;
  form.hostKind = server.hostKind;
  form.host = server.hostKind === "ssh" ? server.host : "";
  form.sshUser = server.sshUser ?? "";
  form.sshPort = server.sshPort ?? undefined;
  form.workspace = server.workspace;
  form.command = server.command;
  form.vscodePath = server.vscodePath ?? "";
  form.environmentText = formatEnvironment(server.environment);
  form.observationPrompt = server.observationPrompt ?? "";
  form.activeObservationSkillNames = [...server.activeObservationSkillNames];
  void loadSkills(server.id);
}

function resetForm(): void {
  fieldErrors.value = {};
  formError.value = null;
  const source = editingServer.value;
  if (source === null) {
    Object.assign(form, emptyForm());
  } else {
    editServer(source);
  }
}

async function save(): Promise<void> {
  saving.value = true;
  fieldErrors.value = {};
  formError.value = null;

  try {
    const saved =
      editingServer.value === null
        ? await apiClient.createAppServer(toPayload())
        : await apiClient.updateAppServer(editingServer.value.id, toPayload());
    appServers.upsert(saved);
    editServer(saved);
  } catch (error) {
    captureFormError(error);
  } finally {
    saving.value = false;
  }
}

async function loadSkills(appServerId: string): Promise<void> {
  availableSkillsLoading.value = true;
  try {
    availableSkills.value = await apiClient.listTargetSkills(appServerId);
  } catch (error) {
    availableSkills.value = [];
    notifyError(error, "Failed to load workspace skills");
  } finally {
    availableSkillsLoading.value = false;
  }
}

function toPayload(): CreateAppServerPayload {
  const payload: CreateAppServerPayload = {
    hostKind: form.hostKind,
    workspace: form.workspace,
    ...(form.name.trim().length > 0 ? { name: form.name } : {}),
    ...(form.command.trim().length > 0 ? { command: form.command } : {}),
    ...(form.vscodePath.trim().length > 0 ? { vscodePath: form.vscodePath } : {}),
    environment: parseEnvironmentText(form.environmentText),
    ...(form.observationPrompt.trim().length > 0
      ? { observationPrompt: form.observationPrompt }
      : {}),
    activeObservationSkillNames: [...form.activeObservationSkillNames]
  };

  if (form.hostKind === "ssh") {
    return {
      ...payload,
      host: form.host,
      ...(form.sshUser.trim().length > 0 ? { sshUser: form.sshUser } : {}),
      ...(form.sshPort !== undefined ? { sshPort: form.sshPort } : {})
    };
  }

  return payload;
}

function parseEnvironmentText(value: string): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [index, rawLine] of value.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new ApiClientError(`Invalid environment line ${index + 1}`, 400, {
        error: {
          code: "validation_error",
          message: "Environment variables must use KEY=value lines",
          details: [{ path: ["environment"], message: `Line ${index + 1} is not KEY=value` }]
        }
      });
    }

    const key = line.slice(0, separatorIndex).trim();
    const envValue = line.slice(separatorIndex + 1);
    environment[key] = envValue;
  }

  return environment;
}

function formatEnvironment(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

async function runLifecycle(action: "start" | "stop" | "restart"): Promise<void> {
  const server = editingServer.value;
  if (server === null) {
    return;
  }

  runningAction.value = action;
  try {
    if (action === "start") {
      await appServers.start(server.id);
    } else if (action === "stop") {
      await appServers.stop(server.id);
    } else {
      await appServers.restart(server.id);
    }
  } finally {
    runningAction.value = null;
  }
}

async function deleteWorkspace(): Promise<void> {
  const server = editingServer.value;
  if (server === null || deleting.value) {
    return;
  }

  try {
    await ElMessageBox.confirm(
      `Delete workspace ${appServerLabel(server)} from AgentMesh? This removes its app-server config and related thread data, but does not delete any files in ${server.workspace}.`,
      "Delete Workspace",
      {
        type: "warning",
        confirmButtonText: "Delete",
        cancelButtonText: "Cancel",
        confirmButtonClass: "el-button--danger"
      }
    );
  } catch {
    return;
  }

  deleting.value = true;
  try {
    const deleted = await appServers.delete(server.id);
    if (deleted) {
      newServer();
    }
  } finally {
    deleting.value = false;
  }
}

function captureFormError(error: unknown): void {
  if (error instanceof ApiClientError) {
    const details = readErrorDetails(error.body);
    fieldErrors.value = Object.fromEntries(
      details
        .map((detail) => [String(detail.path?.[0] ?? ""), detail.message] as const)
        .filter(([path]) => path.length > 0)
    );
    formError.value = error.message;
    return;
  }

  notifyError(error, "Failed to save app server");
}

function readErrorDetails(body: unknown): readonly ApiErrorDetail[] {
  if (body === null || typeof body !== "object") {
    return [];
  }

  const details = (body as { error?: { details?: unknown } }).error?.details;
  return Array.isArray(details) ? (details as ApiErrorDetail[]) : [];
}

function fieldError(field: string): string | undefined {
  return fieldErrors.value[field];
}

function appServerLabel(server: AppServerDto): string {
  return `${server.host} / ${displayWorkspaceBaseName(server.workspace)}`;
}

function generateNamePreview(workspace: string, servers: readonly AppServerDto[]): string {
  const base = workspaceBaseName(workspace);
  let suffix = 1;
  const existingNames = new Set(servers.map((server) => server.name));

  while (existingNames.has(`${base}_${suffix}`)) {
    suffix += 1;
  }

  return `${base}_${suffix}`;
}

function workspaceBaseName(workspace: string): string {
  const normalized = workspace.trim().replace(/\/+$/u, "");
  const basename = normalized.length === 0 ? "" : (normalized.split("/").pop() ?? "");
  const sanitized = basename.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length === 0 ? "app-server" : sanitized;
}

function displayWorkspaceBaseName(workspace: string): string {
  const normalized = workspace.trim().replace(/[\\/]+$/u, "");
  const basename = normalized.split(/[\\/]/u).pop();
  return basename !== undefined && basename.length > 0 ? basename : workspace;
}

function sshLabel(server: Pick<AppServerDto, "host" | "sshUser" | "sshPort">): string {
  const user = server.sshUser === null ? "" : `${server.sshUser}@`;
  const port = server.sshPort === null ? "" : `:${server.sshPort}`;
  return `${user}${server.host}${port}`;
}

function isBusy(status: AppServerStatus): boolean {
  return status === "starting" || status === "stopping";
}

function statusTagType(status: AppServerStatus): "success" | "warning" | "danger" | "info" {
  if (status === "online") {
    return "success";
  }
  if (status === "starting" || status === "stopping") {
    return "warning";
  }
  if (status === "error") {
    return "danger";
  }
  return "info";
}

function buildDefaultObservationPrompt(activeObservationSkillNames: readonly string[]): string {
  const skillsSummary =
    activeObservationSkillNames.length === 0
      ? "No active observation skills are configured for this workspace yet."
      : `Active observation skills: ${activeObservationSkillNames.map((name) => `$${name}`).join(", ")}.`;

  return [
    "This workspace has an active observation stack.",
    "Treat the listed observation skills as the default harness observation infrastructure for this workspace.",
    "Before doing ad hoc inspection, use these observation skills first unless they are clearly insufficient for the task.",
    "Use gradual disclosure: start with the cheapest relevant observation capability, deepen only when needed, and ground decisions in observations from this stack.",
    skillsSummary
  ].join("\n\n");
}
</script>

<style scoped>
.server-editor {
  display: grid;
  align-content: start;
}

.server-editor-scroll {
  display: grid;
  gap: 0.9rem;
  overflow: visible;
}

.observation-stack-settings {
  display: grid;
  gap: 0.9rem;
  padding: 1rem;
  border: 1px solid #485260;
  border-radius: 1rem;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--bg-panel-elevated) 86%, #ffffff 14%), var(--bg-panel-soft)),
    radial-gradient(circle at top right, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 15rem);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.observation-intro {
  margin: -0.15rem 0 0;
  color: var(--text-secondary);
  font-size: 0.88rem;
  line-height: 1.55;
}

.settings-help {
  margin: -0.35rem 0 0;
  color: var(--el-text-color-secondary);
  font-size: 0.82rem;
}

.observation-skill-loading {
  margin-bottom: 0.55rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.observation-skill-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
}

.observation-skill-empty {
  padding: 0.8rem 0.95rem;
  border: 1px dashed color-mix(in srgb, var(--border-strong) 56%, #485260);
  border-radius: 0.8rem;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-panel-elevated) 56%, transparent);
}

.observation-skill-card {
  display: grid;
  flex: 0 1 320px;
  gap: 0.24rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid #485260;
  border-radius: 0.8rem;
  background: color-mix(in srgb, var(--bg-panel-elevated) 74%, transparent);
  transition:
    transform 140ms ease,
    border-color 140ms ease,
    box-shadow 140ms ease;
}

.observation-skill-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-primary) 38%, #485260);
  box-shadow: 0 10px 22px color-mix(in srgb, var(--shadow-panel) 74%, transparent);
}

.observation-skill-name {
  font-weight: 700;
}
</style>
