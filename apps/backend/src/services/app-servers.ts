import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AppServerDto, AppServerHostKind, AppServerStatus } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, RequestValidationError } from "../errors.js";
import { normalizeWorkspacePath } from "./filesystem-safety.js";
import {
  buildResolvedObservationPrompt,
  normalizeObservationSkillNames
} from "./observation-stack.js";
import { validateLocalWorkspaceExists } from "./workspace-validation.js";

const DEFAULT_COMMAND = "codex app-server";
const LOCAL_HOST = "localhost";
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type CreateAppServerInput = {
  readonly name?: string | undefined;
  readonly hostKind: AppServerHostKind;
  readonly host?: string | undefined;
  readonly sshUser?: string | undefined;
  readonly sshPort?: number | undefined;
  readonly workspace: string;
  readonly command?: string | undefined;
  readonly environment?: Record<string, string> | undefined;
  readonly observationPrompt?: string | undefined;
  readonly activeObservationSkillNames?: readonly string[] | undefined;
};

export type PatchAppServerInput = Partial<CreateAppServerInput>;

type AppServerRow = {
  readonly id: string;
  readonly name: string;
  readonly host_kind: AppServerHostKind;
  readonly host: string;
  readonly ssh_user: string | null;
  readonly ssh_port: number | null;
  readonly workspace: string;
  readonly command: string;
  readonly environment_json: string;
  readonly observation_prompt: string | null;
  readonly active_observation_skills_json: string;
  readonly status: AppServerDto["status"];
  readonly last_started_at: number | null;
  readonly last_seen_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type NormalizedAppServerConfig = {
  readonly name: string;
  readonly hostKind: AppServerHostKind;
  readonly host: string;
  readonly sshUser: string | null;
  readonly sshPort: number | null;
  readonly workspace: string;
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly observationPrompt: string | null;
  readonly activeObservationSkillNames: readonly string[];
};

type UiLayoutRow = {
  readonly id: string;
  readonly tree_json: string;
};

export class AppServerService {
  public constructor(private readonly database: DatabaseHandle) {}

  public list(): AppServerDto[] {
    const rows = this.database.sqlite
      .prepare("SELECT * FROM app_servers ORDER BY created_at ASC, name ASC")
      .all() as AppServerRow[];

    return rows.map(toDto);
  }

  public create(input: CreateAppServerInput): AppServerDto {
    const withoutName = normalizeConfig(input);
    const name = input.name?.trim() ?? this.generateName(withoutName.workspace);
    validateName(name);
    const config = { ...withoutName, name };

    this.validateUniqueName(config.name);
    this.validateUniqueIdentity(config.host, config.workspace);

    const now = Date.now();
    const id = randomUUID();

    this.database.sqlite
      .prepare(
        `
          INSERT INTO app_servers (
            id,
            name,
            host_kind,
            host,
            ssh_user,
            ssh_port,
            workspace,
            command,
            environment_json,
            observation_prompt,
            active_observation_skills_json,
            status,
            last_error,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', NULL, ?, ?)
        `
      )
      .run(
        id,
        config.name,
        config.hostKind,
        config.host,
        config.sshUser,
        config.sshPort,
        config.workspace,
        config.command,
        JSON.stringify(config.environment),
        config.observationPrompt,
        JSON.stringify(config.activeObservationSkillNames),
        now,
        now
      );

    return this.get(id);
  }

  public update(id: string, input: PatchAppServerInput): AppServerDto {
    const existing = this.findRow(id);

    if (existing === undefined) {
      throw new NotFoundError("App server not found");
    }

    const nextHostKind = input.hostKind ?? existing.host_kind;
    const mergedInput: CreateAppServerInput = {
      name: input.name ?? existing.name,
      hostKind: nextHostKind,
      host: input.host ?? (nextHostKind === existing.host_kind ? existing.host : undefined),
      sshUser:
        nextHostKind === "ssh" ? (input.sshUser ?? existing.ssh_user ?? undefined) : undefined,
      sshPort:
        nextHostKind === "ssh" ? (input.sshPort ?? existing.ssh_port ?? undefined) : undefined,
      workspace: input.workspace ?? existing.workspace,
      command: input.command ?? existing.command,
      environment:
        input.environment ?? (JSON.parse(existing.environment_json) as Record<string, string>),
      observationPrompt: input.observationPrompt ?? existing.observation_prompt ?? undefined,
      activeObservationSkillNames:
        input.activeObservationSkillNames ??
        (JSON.parse(existing.active_observation_skills_json) as string[])
    };
    const config = normalizeConfig(mergedInput);

    validateName(config.name);
    this.validateUniqueName(config.name, id);
    this.validateUniqueIdentity(config.host, config.workspace, id);

    this.database.sqlite
      .prepare(
        `
          UPDATE app_servers
          SET
            name = ?,
            host_kind = ?,
            host = ?,
            ssh_user = ?,
            ssh_port = ?,
            workspace = ?,
            command = ?,
            environment_json = ?,
            observation_prompt = ?,
            active_observation_skills_json = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        config.name,
        config.hostKind,
        config.host,
        config.sshUser,
        config.sshPort,
        config.workspace,
        config.command,
        JSON.stringify(config.environment),
        config.observationPrompt,
        JSON.stringify(config.activeObservationSkillNames),
        Date.now(),
        id
      );

    return this.get(id);
  }

  public delete(id: string): void {
    const result = this.database.sqlite.prepare("DELETE FROM app_servers WHERE id = ?").run(id);

    if (result.changes === 0) {
      throw new NotFoundError("App server not found");
    }
  }

  public get(id: string): AppServerDto {
    const row = this.findRow(id);

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return toDto(row);
  }

  public deleteWorkspaceData(id: string): void {
    const transaction = this.database.sqlite.transaction((appServerId: string) => {
      const threadIds = this.database.sqlite
        .prepare("SELECT id FROM threads WHERE app_server_id = ?")
        .all(appServerId) as Array<{ readonly id: string }>;
      const staleThreadIds = new Set(threadIds.map((row) => row.id));

      if (staleThreadIds.size > 0) {
        const boardLayouts = this.database.sqlite
          .prepare("SELECT id, tree_json FROM ui_layouts WHERE kind = 'boards'")
          .all() as UiLayoutRow[];
        const updateBoardLayout = this.database.sqlite.prepare(
          "UPDATE ui_layouts SET tree_json = ?, updated_at = ? WHERE id = ?"
        );
        const now = Date.now();

        for (const layout of boardLayouts) {
          const prunedJson = pruneBoardLayoutJson(layout.tree_json, staleThreadIds);
          if (prunedJson !== layout.tree_json) {
            updateBoardLayout.run(prunedJson, now, layout.id);
          }
        }
      }

      this.database.sqlite
        .prepare("DELETE FROM ui_layouts WHERE owner_id = ?")
        .run(appServerId);

      const result = this.database.sqlite
        .prepare("DELETE FROM app_servers WHERE id = ?")
        .run(appServerId);

      if (result.changes === 0) {
        throw new NotFoundError("App server not found");
      }
    });

    transaction(id);
  }

  public markAllOfflineAfterBackendRestart(): void {
    this.database.sqlite
      .prepare(
        `
          UPDATE app_servers
          SET status = 'offline', updated_at = ?
          WHERE status != 'offline'
        `
      )
      .run(Date.now());
  }

  public setStatus(
    id: string,
    status: AppServerStatus,
    options: {
      readonly lastError?: string | null | undefined;
      readonly lastStartedAt?: number | null | undefined;
      readonly lastSeenAt?: number | null | undefined;
    } = {}
  ): AppServerDto {
    const existing = this.findRow(id);

    if (existing === undefined) {
      throw new NotFoundError("App server not found");
    }

    const now = Date.now();
    const lastStartedAt = options.lastStartedAt ?? existing.last_started_at;
    const lastSeenAt = options.lastSeenAt ?? existing.last_seen_at;
    const lastError = options.lastError === undefined ? existing.last_error : options.lastError;

    this.database.sqlite
      .prepare(
        `
          UPDATE app_servers
          SET
            status = ?,
            last_started_at = ?,
            last_seen_at = ?,
            last_error = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(status, lastStartedAt, lastSeenAt, lastError, now, id);

    return this.get(id);
  }

  private generateName(workspace: string): string {
    const base = workspaceBaseName(workspace);
    let suffix = 1;

    while (this.nameExists(`${base}_${suffix}`)) {
      suffix += 1;
    }

    return `${base}_${suffix}`;
  }

  private findRow(id: string): AppServerRow | undefined {
    return this.database.sqlite.prepare("SELECT * FROM app_servers WHERE id = ?").get(id) as
      | AppServerRow
      | undefined;
  }

  private nameExists(name: string, exceptId?: string): boolean {
    const row =
      exceptId === undefined
        ? this.database.sqlite.prepare("SELECT 1 FROM app_servers WHERE name = ? LIMIT 1").get(name)
        : this.database.sqlite
            .prepare("SELECT 1 FROM app_servers WHERE name = ? AND id != ? LIMIT 1")
            .get(name, exceptId);

    return row !== undefined;
  }

  private identityExists(host: string, workspace: string, exceptId?: string): boolean {
    const row =
      exceptId === undefined
        ? this.database.sqlite
            .prepare("SELECT 1 FROM app_servers WHERE host = ? AND workspace = ? LIMIT 1")
            .get(host, workspace)
        : this.database.sqlite
            .prepare(
              "SELECT 1 FROM app_servers WHERE host = ? AND workspace = ? AND id != ? LIMIT 1"
            )
            .get(host, workspace, exceptId);

    return row !== undefined;
  }

  private validateUniqueName(name: string, exceptId?: string): void {
    if (this.nameExists(name, exceptId)) {
      throw new RequestValidationError("App server name already exists", [
        { path: ["name"], message: "App server name must be unique" }
      ]);
    }
  }

  private validateUniqueIdentity(host: string, workspace: string, exceptId?: string): void {
    if (this.identityExists(host, workspace, exceptId)) {
      throw new RequestValidationError("App server host and workspace already exist", [
        {
          path: ["workspace"],
          message: "Host and workspace identity must be unique"
        }
      ]);
    }
  }
}

function pruneBoardLayoutJson(treeJson: string, staleThreadIds: ReadonlySet<string>): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(treeJson);
  } catch {
    return treeJson;
  }

  const pruned = pruneBoardLayoutTree(parsed, staleThreadIds);
  return JSON.stringify(pruned);
}

function pruneBoardLayoutTree(
  value: unknown,
  staleThreadIds: ReadonlySet<string>
): unknown | null {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const node = value as Record<string, unknown>;

  if (node.type === "leaf") {
    const threadId = typeof node.threadId === "string" ? node.threadId : undefined;
    if (threadId !== undefined && staleThreadIds.has(threadId)) {
      return null;
    }
    return node;
  }

  if (node.type !== "split") {
    return node;
  }

  const first = pruneBoardLayoutTree(node.first, staleThreadIds);
  const second = pruneBoardLayoutTree(node.second, staleThreadIds);

  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }

  return {
    ...node,
    first,
    second
  };
}

function normalizeConfig(input: CreateAppServerInput): NormalizedAppServerConfig {
  const hostKind = input.hostKind;
  const workspace = normalizeWorkspace(input.workspace);
  const command = input.command?.trim() || DEFAULT_COMMAND;
  const environment = normalizeEnvironment(input.environment ?? {});
  const name = input.name?.trim() ?? workspaceBaseName(workspace);

  validateName(name);

  if (hostKind === "local") {
    validateLocalHost(input.host);

    if (input.sshUser !== undefined || input.sshPort !== undefined) {
      throw new RequestValidationError("Local app servers cannot include SSH settings", [
        { path: ["sshUser"], message: "SSH user is only valid for SSH app servers" },
        { path: ["sshPort"], message: "SSH port is only valid for SSH app servers" }
      ]);
    }

    const config = {
      name,
      hostKind,
      host: LOCAL_HOST,
      sshUser: null,
      sshPort: null,
      workspace,
      command,
      environment,
      observationPrompt: normalizeNullableText(input.observationPrompt),
      activeObservationSkillNames: normalizeObservationSkillNames(input.activeObservationSkillNames)
    };

    validateLocalWorkspaceExists(config);
    return config;
  }

  const host = input.host?.trim();

  if (host === undefined || host.length === 0) {
    throw new RequestValidationError("SSH app servers require a host", [
      { path: ["host"], message: "SSH host is required" }
    ]);
  }

  const config = {
    name,
    hostKind,
    host,
    sshUser: normalizeNullableText(input.sshUser),
    sshPort: input.sshPort ?? null,
    workspace,
    command,
    environment,
    observationPrompt: normalizeNullableText(input.observationPrompt),
    activeObservationSkillNames: normalizeObservationSkillNames(input.activeObservationSkillNames)
  };

  validateLocalWorkspaceExists(config);
  return config;
}

function normalizeWorkspace(workspace: string): string {
  return normalizeWorkspacePath(workspace);
}

function validateLocalHost(host: string | undefined): void {
  const normalized = host?.trim();

  if (
    normalized !== undefined &&
    normalized.length > 0 &&
    normalized !== LOCAL_HOST &&
    normalized !== "127.0.0.1" &&
    normalized !== "::1"
  ) {
    throw new RequestValidationError("Local app servers must use localhost", [
      { path: ["host"], message: "Local app servers must use localhost" }
    ]);
  }
}

function validateName(name: string): void {
  if (name.length === 0 || !NAME_PATTERN.test(name)) {
    throw new RequestValidationError("App server name is invalid", [
      {
        path: ["name"],
        message: "Name must contain only letters, numbers, dots, underscores, or hyphens"
      }
    ]);
  }
}

function workspaceBaseName(workspace: string): string {
  const basename = path.posix.basename(path.posix.normalize(workspace));
  const sanitized = basename.replaceAll(/[^A-Za-z0-9._-]/g, "_");

  return sanitized.length === 0 ? "app-server" : sanitized;
}

function normalizeNullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function normalizeEnvironment(value: Record<string, string>): Readonly<Record<string, string>> {
  const entries = Object.entries(value)
    .map(([key, rawValue]) => [key.trim(), String(rawValue)] as const)
    .filter(([key]) => key.length > 0);
  const normalized: Record<string, string> = {};

  for (const [key, envValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new RequestValidationError("App server environment is invalid", [
        {
          path: ["environment", key],
          message: "Environment variable names must match [A-Za-z_][A-Za-z0-9_]*"
        }
      ]);
    }

    if (key.includes("\0") || envValue.includes("\0")) {
      throw new RequestValidationError("App server environment is invalid", [
        { path: ["environment", key], message: "Environment cannot contain NUL bytes" }
      ]);
    }

    normalized[key] = envValue;
  }

  return normalized;
}

function parseEnvironmentJson(value: string): Readonly<Record<string, string>> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  return normalizeEnvironment(parsed as Record<string, string>);
}

function toDto(row: AppServerRow): AppServerDto {
  const activeObservationSkillNames = normalizeObservationSkillNames(
    JSON.parse(row.active_observation_skills_json) as string[]
  );
  return {
    id: row.id,
    name: row.name,
    hostKind: row.host_kind,
    host: row.host,
    sshUser: row.ssh_user,
    sshPort: row.ssh_port,
    workspace: row.workspace,
    command: row.command,
    environment: parseEnvironmentJson(row.environment_json),
    observationPrompt: row.observation_prompt,
    activeObservationSkillNames,
    resolvedObservationPrompt: buildResolvedObservationPrompt(
      row.observation_prompt,
      activeObservationSkillNames
    ),
    status: row.status,
    lastStartedAt: row.last_started_at,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
