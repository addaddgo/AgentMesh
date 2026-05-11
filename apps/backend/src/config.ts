import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { assertPathInside } from "./services/filesystem-safety.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

const envSchema = z.object({
  AGENTMESH_DATA_DIR: z.string().min(1).optional(),
  AGENTMESH_SQLITE_PATH: z.string().min(1).optional(),
  AGENTMESH_UPLOAD_DIR: z.string().min(1).optional(),
  AGENTMESH_SKILLS_ROOT: z.string().min(1).optional(),
  AGENTMESH_PORT: z.coerce.number().int().min(1).max(65535).default(3939)
});

export type BackendConfig = {
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly uploadDir: string;
  readonly skillsRoot: string;
  readonly port: number;
};

const resolveFromRepo = (value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(repoRoot, value);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  const dataDir = resolveFromRepo(parsed.AGENTMESH_DATA_DIR ?? "data");
  const sqlitePath = resolveFromRepo(
    parsed.AGENTMESH_SQLITE_PATH ?? path.join(dataDir, "agentmesh.sqlite")
  );
  const uploadDir = resolveFromRepo(parsed.AGENTMESH_UPLOAD_DIR ?? path.join(dataDir, "uploads"));

  validateBackendOwnedPath(dataDir, sqlitePath, "SQLite path must be under backend data dir");
  validateBackendOwnedPath(dataDir, uploadDir, "Upload directory must be under backend data dir");

  return {
    dataDir,
    sqlitePath,
    uploadDir,
    skillsRoot: resolveFromRepo(parsed.AGENTMESH_SKILLS_ROOT ?? path.join("apps", "myskills")),
    port: parsed.AGENTMESH_PORT
  };
}

export function ensureConfigDirectories(config: BackendConfig): void {
  validateBackendOwnedPath(
    config.dataDir,
    config.sqlitePath,
    "SQLite path must be under backend data dir"
  );
  validateBackendOwnedPath(
    config.dataDir,
    config.uploadDir,
    "Upload directory must be under backend data dir"
  );
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
}

function validateBackendOwnedPath(root: string, candidate: string, message: string): void {
  assertPathInside(root, candidate, message);
}
