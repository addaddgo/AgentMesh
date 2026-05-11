import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureConfigDirectories, loadConfig, type BackendConfig } from "./config.js";

describe("backend config safety", () => {
  it("rejects SQLite paths outside the backend data directory", () => {
    expect(() =>
      loadConfig({
        AGENTMESH_DATA_DIR: "/tmp/agentmesh-data",
        AGENTMESH_SQLITE_PATH: "/tmp/escape.sqlite"
      })
    ).toThrow("SQLite path must be under backend data dir");
  });

  it("rejects upload directories outside the backend data directory", () => {
    const config: BackendConfig = {
      dataDir: "/tmp/agentmesh-data",
      sqlitePath: "/tmp/agentmesh-data/agentmesh.sqlite",
      uploadDir: "/tmp/agentmesh-uploads",
      skillsRoot: path.join("/tmp", "skills"),
      port: 0
    };

    expect(() => {
      ensureConfigDirectories(config);
    }).toThrow("Upload directory must be under backend data dir");
  });

  it("defaults the skill source root to apps/myskills", () => {
    expect(loadConfig({}).skillsRoot).toBe(path.resolve("..", "..", "apps", "myskills"));
  });
});
