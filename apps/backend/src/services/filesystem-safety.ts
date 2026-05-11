import path from "node:path";

import { RequestValidationError } from "../errors.js";

export function assertPathInside(root: string, candidate: string, message: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return;
  }

  throw new RequestValidationError(message);
}

export function assertPosixPathInside(root: string, candidate: string, message: string): void {
  const resolvedRoot = path.posix.resolve(root);
  const resolvedCandidate = path.posix.resolve(candidate);
  const relative = path.posix.relative(resolvedRoot, resolvedCandidate);

  if (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.posix.isAbsolute(relative))
  ) {
    return;
  }

  throw new RequestValidationError(message);
}

export function assertSafePathSegment(
  value: string,
  pathName: string,
  message = `${pathName} is invalid`
): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new RequestValidationError(message, [
      { path: [pathName], message: `${pathName} must be a single safe path segment` }
    ]);
  }
}

export function normalizeWorkspacePath(workspace: string): string {
  const trimmed = workspace.trim();

  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new RequestValidationError("Workspace path is invalid", [
      { path: ["workspace"], message: "Workspace path is invalid" }
    ]);
  }

  if (!path.posix.isAbsolute(trimmed)) {
    throw new RequestValidationError("Workspace must be an absolute path", [
      { path: ["workspace"], message: "Workspace must be an absolute path" }
    ]);
  }

  if (trimmed.split("/").includes("..")) {
    throw new RequestValidationError("Workspace path must not contain traversal", [
      { path: ["workspace"], message: "Workspace path must not contain '..'" }
    ]);
  }

  const normalized = path.posix.normalize(trimmed);

  if (normalized === "/") {
    throw new RequestValidationError("Workspace path is invalid", [
      { path: ["workspace"], message: "Workspace cannot be filesystem root" }
    ]);
  }

  return normalized.replace(/\/+$/u, "");
}
