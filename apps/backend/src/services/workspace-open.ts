import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { WorkspaceOpenInVscodeResponse } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { InternalApiError, NotFoundError, RequestValidationError } from "../errors.js";
import { assertPathInside, assertPosixPathInside } from "./filesystem-safety.js";

const DEFAULT_VSCODE_PATH = "code";

type AppServerRow = {
  readonly id: string;
  readonly host_kind: "local" | "ssh";
  readonly host: string;
  readonly workspace: string;
  readonly vscode_path: string | null;
};

type CodeCommandRunner = (command: string, args: readonly string[]) => void;
type FocusUriRunner = (uri: string) => void;

type OpenTarget = {
  readonly args: readonly string[];
  readonly focusUri: string;
};

export class WorkspaceOpenService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly runCodeCommand: CodeCommandRunner = spawnCodeCommand,
    private readonly focusUri: FocusUriRunner = bestEffortFocusUri
  ) {}

  public openInVscode(
    appServerId: string,
    relativePath: string
  ): WorkspaceOpenInVscodeResponse {
    const appServer = this.getAppServer(appServerId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);

    const openTarget: OpenTarget =
      appServer.host_kind === "local"
        ? localOpenTarget(appServer.workspace, normalizedPath)
        : remoteOpenTarget(appServer.host, appServer.workspace, normalizedPath);

    const vscodePath = appServer.vscode_path?.trim() || DEFAULT_VSCODE_PATH;

    console.info(
      `[workspace-open] Launching VS Code for ${appServerId}: ${formatCommand(vscodePath, openTarget.args)}`
    );
    this.runCodeCommand(vscodePath, openTarget.args);
    this.focusUri(openTarget.focusUri);
    return { opened: true };
  }

  private getAppServer(appServerId: string): AppServerRow {
    const row = this.database.sqlite
      .prepare("SELECT id, host_kind, host, workspace, vscode_path FROM app_servers WHERE id = ?")
      .get(appServerId) as AppServerRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return row;
  }
}

function localOpenTarget(
  workspace: string,
  relativePath: string
): { readonly args: readonly string[]; readonly focusUri: string } {
  const absoluteWorkspace = path.resolve(workspace);
  const absoluteFile = path.resolve(workspace, relativePath);
  assertPathInside(absoluteWorkspace, absoluteFile, "Workspace file path must stay inside workspace");
  return {
    args: [absoluteWorkspace, "--goto", absoluteFile],
    focusUri: filePathFocusUri(absoluteFile)
  };
}

function remoteOpenTarget(
  host: string,
  workspace: string,
  relativePath: string
): OpenTarget {
  const absoluteWorkspace = path.posix.resolve(workspace);
  const absoluteFile = path.posix.resolve(workspace, relativePath);
  assertPosixPathInside(
    absoluteWorkspace,
    absoluteFile,
    "Workspace file path must stay inside workspace"
  );
  const remoteWorkspaceUri = vscodeRemoteUri(host, absoluteWorkspace);
  const remoteFileUri = vscodeRemoteUri(host, absoluteFile);
  return {
    args: ["--folder-uri", remoteWorkspaceUri, "--file-uri", remoteFileUri],
    // Inferred from VS Code remote URI format; used only as a best-effort focus hint.
    focusUri: `vscode://vscode-remote/ssh-remote+${encodeURIComponent(host)}${absoluteFile}`
  };
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

function spawnCodeCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.error !== undefined) {
    throw new InternalApiError(
      `Failed to launch VS Code: ${result.error.message}. Command: ${formatCommand(command, args)}`
    );
  }

  if (result.status !== 0) {
    const stderr = trimOutput(result.stderr);
    const stdout = trimOutput(result.stdout);
    const details = [
      `Command: ${formatCommand(command, args)}`,
      `Exit code: ${String(result.status)}`
    ];
    if (stderr.length > 0) {
      details.push(`stderr: ${stderr}`);
    }
    if (stdout.length > 0) {
      details.push(`stdout: ${stdout}`);
    }
    throw new InternalApiError(`Failed to launch VS Code. ${details.join(". ")}`);
  }
}

function filePathFocusUri(absoluteFile: string): string {
  return `vscode://file${pathToFileURL(absoluteFile).pathname}`;
}

function vscodeRemoteUri(host: string, absolutePath: string): string {
  const encodedSegments = absolutePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `vscode-remote://ssh-remote+${encodeURIComponent(host)}/${encodedSegments}`;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellToken).join(" ");
}

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_./:+-]+$/u.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function trimOutput(value: string | Buffer | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function bestEffortFocusUri(uri: string): void {
  const result = spawnSync("xdg-open", [uri], {
    encoding: "utf8",
    stdio: "ignore"
  });

  if (result.error !== undefined || result.status !== 0) {
    return;
  }
}
