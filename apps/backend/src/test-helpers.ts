import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import type { BackendConfig } from "./config.js";
import { buildServer } from "./server.js";

export type TestBackend = {
  readonly app: FastifyInstance;
  readonly config: BackendConfig;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
};

export async function createTestBackend(): Promise<TestBackend> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-backend-"));
  const config: BackendConfig = {
    dataDir: tempDir,
    sqlitePath: path.join(tempDir, "test.sqlite"),
    uploadDir: path.join(tempDir, "uploads"),
    skillsRoot: path.join(tempDir, "skills"),
    port: 0
  };

  const app = await buildServer({ config, logger: false });

  return {
    app,
    config,
    tempDir,
    cleanup: async () => {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}
