<template>
  <section class="content-page app-server-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">Configuration</p>
        <h1>App Servers</h1>
        <p>Configure local and SSH Codex app-server processes, then manage their lifecycle.</p>
      </div>
      <el-button :loading="appServers.loading" @click="appServers.load()">Refresh</el-button>
    </header>

    <div class="app-server-layout">
      <aside class="server-list-panel">
        <div class="sidebar-title">
          <strong>Configured</strong>
          <el-button size="small" type="primary" @click="newServer">New</el-button>
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
              native-type="submit"
              :loading="saving"
              :disabled="form.workspace.trim().length === 0"
            >
              {{ editingServer === null ? "Create app server" : "Save changes" }}
            </el-button>
            <el-button @click="resetForm">Reset</el-button>
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
              :loading="runningAction === 'start'"
              :disabled="isBusy(editingServer.status) || editingServer.status === 'online'"
              @click="runLifecycle('start')"
            >
              Start
            </el-button>
            <el-button
              type="warning"
              :loading="runningAction === 'stop'"
              :disabled="isBusy(editingServer.status) || editingServer.status === 'offline'"
              @click="runLifecycle('stop')"
            >
              Stop
            </el-button>
            <el-button
              :loading="runningAction === 'restart'"
              :disabled="isBusy(editingServer.status)"
              @click="runLifecycle('restart')"
            >
              Restart
            </el-button>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ApiErrorDetail, AppServerDto, AppServerStatus } from "@agentmesh/shared";
import { computed, onMounted, reactive, ref } from "vue";

import { apiClient, ApiClientError, type CreateAppServerPayload } from "../api/client";
import { notifyError } from "../stores/errors";
import { useAppServerStore } from "../stores/appServers";

type AppServerForm = {
  name: string;
  hostKind: "local" | "ssh";
  host: string;
  sshUser: string;
  sshPort: number | undefined;
  workspace: string;
  command: string;
};

const hostKindOptions = [
  { label: "Local", value: "local" },
  { label: "SSH", value: "ssh" }
] as const;

const appServers = useAppServerStore();
const editingId = ref<string | null>(null);
const saving = ref(false);
const runningAction = ref<"start" | "stop" | "restart" | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const form = reactive<AppServerForm>(emptyForm());

const editingServer = computed(
  () => appServers.appServers.find((server) => server.id === editingId.value) ?? null
);
const generatedName = computed(() => generateNamePreview(form.workspace, appServers.appServers));

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
    command: ""
  };
}

function newServer(): void {
  editingId.value = null;
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

function toPayload(): CreateAppServerPayload {
  const payload: CreateAppServerPayload = {
    hostKind: form.hostKind,
    workspace: form.workspace,
    ...(form.name.trim().length > 0 ? { name: form.name } : {}),
    ...(form.command.trim().length > 0 ? { command: form.command } : {})
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
</script>
