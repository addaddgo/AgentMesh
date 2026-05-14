import fs from "node:fs";
import { spawnSync } from "node:child_process";

import type { AppServerHostKind } from "@agentmesh/shared";

import { RequestValidationError, SshError } from "../errors.js";

type WorkspaceValidationInput = {
  readonly hostKind: AppServerHostKind;
  readonly host: string;
  readonly sshUser: string | null;
  readonly sshPort: number | null;
  readonly workspace: string;
};

export function validateWorkspaceExists(input: WorkspaceValidationInput): void {
  if (input.hostKind === "local") {
    validateLocalWorkspace(input.workspace);
    return;
  }

  validateRemoteWorkspace(input);
}

export function validateLocalWorkspaceExists(input: WorkspaceValidationInput): void {
  if (input.hostKind === "local") {
    validateLocalWorkspace(input.workspace);
  }
}

function validateLocalWorkspace(workspace: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspace);
  } catch {
    throw new RequestValidationError("Workspace path does not exist", [
      { path: ["workspace"], message: `Workspace path does not exist: ${workspace}` }
    ]);
  }

  if (!stat.isDirectory()) {
    throw new RequestValidationError("Workspace path must be a directory", [
      { path: ["workspace"], message: `Workspace path is not a directory: ${workspace}` }
    ]);
  }
}

function validateRemoteWorkspace(input: WorkspaceValidationInput): void {
  const result = spawnSync(
    "ssh",
    [
      ...(input.sshPort === null ? [] : ["-p", String(input.sshPort)]),
      sshTarget(input),
      `if [ -d ${shellQuote(input.workspace)} ]; then exit 0; else exit 3; fi`
    ],
    { encoding: "utf8" }
  );

  if (result.error !== undefined) {
    throw new SshError(result.error.message);
  }

  if (result.status === 0) {
    return;
  }

  if (result.status === 3) {
    throw new RequestValidationError("Workspace path does not exist", [
      { path: ["workspace"], message: `Workspace path does not exist: ${input.workspace}` }
    ]);
  }

  throw new SshError(result.stderr.trim() || "Failed to validate remote workspace path");
}

function sshTarget(input: Pick<WorkspaceValidationInput, "host" | "sshUser">): string {
  return input.sshUser === null ? input.host : `${input.sshUser}@${input.host}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
