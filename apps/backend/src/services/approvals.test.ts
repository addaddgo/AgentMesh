import { describe, expect, it } from "vitest";

import { createDatabase, initializeDatabase } from "../db/index.js";
import { ApprovalService } from "./approvals.js";
import { EventService } from "./events.js";

describe("ApprovalService", () => {
  it("creates a new pending approval when Codex reuses a completed request id", () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    seedAppServer(database);
    seedThreadAndTurn(database);

    const service = new ApprovalService(database, new EventService());
    const first = service.handleServerRequest(
      "app-1",
      {
        jsonrpc: "2.0",
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          command: "touch first.txt"
        }
      },
      JSON.stringify({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "codex-thread-1", turnId: "codex-turn-1" }
      })
    );
    expect(first?.status).toBe("pending");

    database.sqlite
      .prepare("UPDATE approvals SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(Date.now(), first?.id);

    const second = service.handleServerRequest(
      "app-1",
      {
        jsonrpc: "2.0",
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          command: "touch second.txt"
        }
      },
      JSON.stringify({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "codex-thread-1", turnId: "codex-turn-1" }
      })
    );

    expect(second?.status).toBe("pending");
    expect(second?.id).not.toBe(first?.id);
    const rows = database.sqlite
      .prepare("SELECT status FROM approvals WHERE app_server_id = ? AND codex_request_id = ?")
      .all("app-1", "0") as Array<{ readonly status: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual(["approved", "pending"]);

    database.close();
  });
});

function seedAppServer(database: ReturnType<typeof createDatabase>): void {
  const now = Date.now();
  database.sqlite
    .prepare(
      `
        INSERT INTO app_servers (
          id, name, host_kind, host, ssh_user, ssh_port, workspace, command,
          environment_json, observation_prompt, active_observation_skills_json,
          status, last_started_at, last_seen_at, last_error, created_at, updated_at
        ) VALUES (?, ?, 'local', 'localhost', NULL, NULL, ?, 'codex app-server', '{}', NULL, '[]', 'online', NULL, NULL, NULL, ?, ?)
      `
    )
    .run("app-1", "Local", "/workspace/demo", now, now);
}

function seedThreadAndTurn(database: ReturnType<typeof createDatabase>): void {
  const now = Date.now();
  database.sqlite
    .prepare(
      `
        INSERT INTO threads (
          id, app_server_id, codex_thread_id, thread_name, agent_kind, parent_thread_id,
          parent_codex_thread_id, agent_name, title, status, cwd, is_current, is_gone,
          imported_at, last_seen_at, raw_metadata_json, created_at, updated_at
        ) VALUES (?, 'app-1', 'codex-thread-1', 'Main Thread', 'main', NULL, NULL, 'main agent', NULL, 'idle', ?, 1, 0, NULL, NULL, '{}', ?, ?)
      `
    )
    .run("thread-1", "/workspace/demo", now, now);

  database.sqlite
    .prepare(
      `
        INSERT INTO turns (
          id, app_server_id, thread_id, codex_turn_id, trigger_message_id, status,
          started_at, completed_at, error, imported_from_id, created_at, updated_at
        ) VALUES (?, 'app-1', 'thread-1', 'codex-turn-1', NULL, 'running', ?, NULL, NULL, NULL, ?, ?)
      `
    )
    .run("turn-1", now, now, now);
}
