import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkspaceEntryDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, RequestValidationError, SshError } from "../errors.js";
import { assertPathInside, assertPosixPathInside } from "./filesystem-safety.js";

type AppServerRow = {
  readonly id: string;
  readonly host_kind: "local" | "ssh";
  readonly host: string;
  readonly ssh_user: string | null;
  readonly ssh_port: number | null;
  readonly workspace: string;
};

const EXCLUDED_NAMES = new Set([".git", "node_modules", ".agentmesh"]);
const MAX_ENTRIES = 80;
const MAX_SEARCH_RESULTS = 80;

export class WorkspaceFileService {
  public constructor(private readonly database: DatabaseHandle) {}

  public listEntries(appServerId: string, query = ""): WorkspaceEntryDto[] {
    const appServer = this.getAppServer(appServerId);
    const normalized = normalizeRelativeQuery(query);
    const directory = normalized.endsWith("/") ? normalized : path.posix.dirname(normalized);
    const prefix = normalized.endsWith("/") ? "" : path.posix.basename(normalized);
    const safeDirectory = directory === "." ? "" : directory;

    return appServer.host_kind === "local"
      ? this.listLocal(appServer.workspace, safeDirectory, prefix)
      : this.listRemote(appServer, safeDirectory, prefix);
  }

  public searchFiles(appServerId: string, query = ""): WorkspaceEntryDto[] {
    const appServer = this.getAppServer(appServerId);
    const normalized = normalizeSearchQuery(query);
    if (normalized.length === 0) {
      return [];
    }

    const files =
      appServer.host_kind === "local"
        ? this.searchLocalFiles(appServer.workspace, normalized)
        : this.searchRemoteFiles(appServer, normalized);

    return files.slice(0, MAX_SEARCH_RESULTS);
  }

  private listLocal(workspace: string, relativeDirectory: string, prefix: string): WorkspaceEntryDto[] {
    const targetDirectory = path.resolve(workspace, relativeDirectory);
    assertPathInside(workspace, targetDirectory, "Workspace file query must stay inside workspace");

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(targetDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => isVisibleMatch(entry.name, prefix))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => toEntry(relativeDirectory, entry.name, entry.isDirectory()))
      .sort(compareEntries)
      .slice(0, MAX_ENTRIES);
  }

  private listRemote(
    appServer: AppServerRow,
    relativeDirectory: string,
    prefix: string
  ): WorkspaceEntryDto[] {
    const targetDirectory = path.posix.join(appServer.workspace, relativeDirectory);
    assertPosixPathInside(
      appServer.workspace,
      targetDirectory,
      "Workspace file query must stay inside workspace"
    );

    const result = spawnSync("ssh", [
      ...(appServer.ssh_port === null ? [] : ["-p", String(appServer.ssh_port)]),
      sshTarget(appServer),
      `cd ${shellQuote(targetDirectory)} && find . -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`
    ], { encoding: "utf8" });

    if (result.status !== 0) {
      throw new SshError(result.stderr.trim() || "Failed to list remote workspace files");
    }

    return result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const [name, type] = line.split("\t");
        if (name === undefined || type === undefined || !isVisibleMatch(name, prefix)) {
          return [];
        }
        if (type !== "d" && type !== "f") {
          return [];
        }
        return [toEntry(relativeDirectory, name, type === "d")];
      })
      .sort(compareEntries)
      .slice(0, MAX_ENTRIES);
  }

  private searchLocalFiles(workspace: string, query: string): WorkspaceEntryDto[] {
    const results: WorkspaceEntryDto[] = [];
    const stack = [""];

    while (stack.length > 0) {
      const relativeDirectory = stack.pop() ?? "";
      const targetDirectory = path.resolve(workspace, relativeDirectory);
      assertPathInside(workspace, targetDirectory, "Workspace file query must stay inside workspace");

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(targetDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (EXCLUDED_NAMES.has(entry.name)) {
          continue;
        }

        const entryPath = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        if (!entry.isFile() || !matchesFileQuery(entryPath, query)) {
          continue;
        }

        results.push({ path: entryPath, name: entry.name, kind: "file" });
      }
    }

    return results.sort(compareSearchEntries);
  }

  private searchRemoteFiles(appServer: AppServerRow, query: string): WorkspaceEntryDto[] {
    const result = spawnSync(
      "ssh",
      [
        ...(appServer.ssh_port === null ? [] : ["-p", String(appServer.ssh_port)]),
        sshTarget(appServer),
        `cd ${shellQuote(appServer.workspace)} && find . \\( -name .git -o -name node_modules -o -name .agentmesh \\) -prune -o -type f -print`
      ],
      { encoding: "utf8" }
    );

    if (result.error !== undefined) {
      throw new SshError(result.error.message);
    }

    if (result.status !== 0) {
      throw new SshError(result.stderr.trim() || "Failed to search remote workspace files");
    }

    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\.\//u, ""))
      .filter((line) => line.length > 0 && matchesFileQuery(line, query))
      .map((entryPath) => ({
        path: entryPath,
        name: path.posix.basename(entryPath),
        kind: "file" as const
      }))
      .sort(compareSearchEntries);
  }

  private getAppServer(appServerId: string): AppServerRow {
    const row = this.database.sqlite
      .prepare("SELECT id, host_kind, host, ssh_user, ssh_port, workspace FROM app_servers WHERE id = ?")
      .get(appServerId) as AppServerRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row;
  }
}

function normalizeRelativeQuery(query: string): string {
  const trimmed = query.trim().replaceAll("\\", "/").replace(/^@/u, "");
  if (trimmed.includes("\0") || path.posix.isAbsolute(trimmed) || trimmed.split("/").includes("..")) {
    throw new RequestValidationError("Workspace file query is invalid", [
      { path: ["query"], message: "Use a relative workspace path without '..'" }
    ]);
  }

  return trimmed;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replaceAll("\\", "/").replace(/\0/gu, "");
}

function isVisibleMatch(name: string, prefix: string): boolean {
  return !EXCLUDED_NAMES.has(name) && name.toLowerCase().startsWith(prefix.toLowerCase());
}

function toEntry(relativeDirectory: string, name: string, isDirectory: boolean): WorkspaceEntryDto {
  const entryPath = path.posix.join(relativeDirectory, name);
  return {
    path: isDirectory ? `${entryPath}/` : entryPath,
    name,
    kind: isDirectory ? "directory" : "file"
  };
}

function compareEntries(left: WorkspaceEntryDto, right: WorkspaceEntryDto): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  return left.path.localeCompare(right.path);
}

function compareSearchEntries(left: WorkspaceEntryDto, right: WorkspaceEntryDto): number {
  return left.path.localeCompare(right.path);
}

function matchesFileQuery(candidatePath: string, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  const basename = path.posix.basename(candidatePath).toLowerCase();
  const fullPath = candidatePath.toLowerCase();
  return fuzzyIncludes(basename, normalizedQuery) || fuzzyIncludes(fullPath, normalizedQuery);
}

function fuzzyIncludes(candidate: string, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  let queryIndex = 0;
  for (const char of candidate) {
    if (char === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex >= query.length) {
        return true;
      }
    }
  }

  return false;
}

function sshTarget(appServer: AppServerRow): string {
  return appServer.ssh_user === null ? appServer.host : `${appServer.ssh_user}@${appServer.host}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
