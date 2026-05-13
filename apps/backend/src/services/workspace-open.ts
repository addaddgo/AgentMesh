import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { WorkspaceOpenInVscodeResponse } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { InternalApiError, NotFoundError, RequestValidationError } from "../errors.js";
import { assertPathInside, assertPosixPathInside } from "./filesystem-safety.js";

type AppServerRow = {
  readonly id: string;
  readonly host_kind: "local" | "ssh";
  readonly host: string;
  readonly workspace: string;
};

type CodeCommandRunner = (args: readonly string[]) => void;

export class WorkspaceOpenService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly runCodeCommand: CodeCommandRunner = spawnCodeCommand
  ) {}

  public openInVscode(
    appServerId: string,
    relativePath: string
  ): WorkspaceOpenInVscodeResponse {
    const appServer = this.getAppServer(appServerId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);

    const args =
      appServer.host_kind === "local"
        ? localOpenArgs(appServer.workspace, normalizedPath)
        : remoteOpenArgs(appServer.host, appServer.workspace, normalizedPath);

    this.runCodeCommand(args);
    return { opened: true };
  }

  private getAppServer(appServerId: string): AppServerRow {
    const row = this.database.sqlite
      .prepare("SELECT id, host_kind, host, workspace FROM app_servers WHERE id = ?")
      .get(appServerId) as AppServerRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row;
  }
}

function localOpenArgs(workspace: string, relativePath: string): readonly string[] {
  const absoluteWorkspace = path.resolve(workspace);
  const absoluteFile = path.resolve(workspace, relativePath);
  assertPathInside(absoluteWorkspace, absoluteFile, "Workspace file path must stay inside workspace");
  return [
    "--folder-uri",
    pathToFileURL(absoluteWorkspace).href,
    "--file-uri",
    pathToFileURL(absoluteFile).href
  ];
}

function remoteOpenArgs(host: string, workspace: string, relativePath: string): readonly string[] {
  const absoluteWorkspace = path.posix.resolve(workspace);
  const absoluteFile = path.posix.resolve(workspace, relativePath);
  assertPosixPathInside(
    absoluteWorkspace,
    absoluteFile,
    "Workspace file path must stay inside workspace"
  );
  const authority = `ssh-remote+${host}`;
  return [
    "--folder-uri",
    `vscode-remote://${authority}${absoluteWorkspace}`,
    "--file-uri",
    `vscode-remote://${authority}${absoluteFile}`
  ];
}

function normalizeRelativeFilePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.endsWith("/") ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new RequestValidationError("Workspace file path is invalid", [
      {
        path: ["path"],
        message: "Use a relative file path inside the workspace"
      }
    ]);
  }
  return normalized;
}

function spawnCodeCommand(args: readonly string[]): void {
  const result = spawnSync("code", args, {
    encoding: "utf8",
    stdio: "ignore"
  });

  if (result.error !== undefined) {
    throw new InternalApiError(`Failed to launch VS Code: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new InternalApiError("Failed to launch VS Code");
  }
}
