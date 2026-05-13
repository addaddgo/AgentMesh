import { describe, expect, it, vi } from "vitest";

import { createDatabase, initializeDatabase } from "../db/index.js";
import { WorkspaceOpenService } from "./workspace-open.js";

describe("WorkspaceOpenService", () => {
  it("opens local workspaces with file URIs", () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    database.sqlite
      .prepare(
        `
          INSERT INTO app_servers (
            id, name, host_kind, host, ssh_user, ssh_port, workspace, command,
            environment_json, status, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'codex app-server', '{}', 'offline', NULL, ?, ?)
        `
      )
      .run("local-1", "local", "local", "localhost", "/workspace/demo", Date.now(), Date.now());

    const runCodeCommand = vi.fn();
    const service = new WorkspaceOpenService(database, runCodeCommand);
    const result = service.openInVscode("local-1", "src/app.ts");

    expect(result).toEqual({ opened: true });
    expect(runCodeCommand).toHaveBeenCalledWith([
      "--folder-uri",
      "file:///workspace/demo",
      "--file-uri",
      "file:///workspace/demo/src/app.ts"
    ]);
    database.close();
  });

  it("opens ssh workspaces with vscode remote URIs", () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    database.sqlite
      .prepare(
        `
          INSERT INTO app_servers (
            id, name, host_kind, host, ssh_user, ssh_port, workspace, command,
            environment_json, status, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'codex app-server', '{}', 'offline', NULL, ?, ?)
        `
      )
      .run("ssh-1", "remote", "ssh", "ultra", "hxb", 22, "/home/hxb/project", Date.now(), Date.now());

    const runCodeCommand = vi.fn();
    const service = new WorkspaceOpenService(database, runCodeCommand);
    service.openInVscode("ssh-1", "src/main.ts");

    expect(runCodeCommand).toHaveBeenCalledWith([
      "--folder-uri",
      "vscode-remote://ssh-remote+ultra/home/hxb/project",
      "--file-uri",
      "vscode-remote://ssh-remote+ultra/home/hxb/project/src/main.ts"
    ]);
    database.close();
  });

  it("rejects traversal paths", () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    database.sqlite
      .prepare(
        `
          INSERT INTO app_servers (
            id, name, host_kind, host, ssh_user, ssh_port, workspace, command,
            environment_json, status, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'codex app-server', '{}', 'offline', NULL, ?, ?)
        `
      )
      .run("local-1", "local", "local", "localhost", "/workspace/demo", Date.now(), Date.now());

    const service = new WorkspaceOpenService(database, vi.fn());
    expect(() => service.openInVscode("local-1", "../secret.txt")).toThrow(
      "Workspace file path is invalid"
    );
    database.close();
  });
});
