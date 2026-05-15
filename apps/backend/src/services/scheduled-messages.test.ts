import type { SendMessageResponse } from "@agentmesh/shared";
import { describe, expect, it, vi } from "vitest";

import { createDatabase, initializeDatabase } from "../db/index.js";
import { EventService } from "./events.js";
import { ScheduledMessageService } from "./scheduled-messages.js";

describe("ScheduledMessageService", () => {
  it("marks due tasks sent after submiting the user message", async () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    seedAppServer(database, { status: "online" });
    seedThread(database);

    const sendText = vi.fn((): Extract<SendMessageResponse, { readonly status: "queued" }> => {
      const now = Date.now();
      database.sqlite
        .prepare(
          `
            INSERT INTO turns (
              id, app_server_id, thread_id, codex_turn_id, trigger_message_id, status,
              started_at, completed_at, error, imported_from_id, created_at, updated_at
            ) VALUES (?, 'app-1', 'thread-1', NULL, 'msg-1', 'queued', NULL, NULL, NULL, NULL, ?, ?)
          `
        )
        .run("turn-1", now, now);
      database.sqlite
        .prepare(
          `
            INSERT INTO messages (
              id, app_server_id, thread_id, turn_id, role, status, parts_json,
              raw_event_ids_json, imported_from_id, created_at, updated_at
            ) VALUES (?, 'app-1', 'thread-1', 'turn-1', 'user', 'queued', ?, '[]', NULL, ?, ?)
          `
        )
        .run("msg-1", JSON.stringify([{ type: "markdown", text: "hello later" }]), now, now);

      return {
        status: "queued",
        message: {
          id: "msg-1",
          appServerId: "app-1",
          threadId: "thread-1",
          turnId: "turn-1",
          role: "user",
          status: "queued",
          parts: [{ type: "markdown", text: "hello later" }],
          rawEventIds: [],
          createdAt: now,
          updatedAt: now
        },
        turn: {
          id: "turn-1",
          appServerId: "app-1",
          threadId: "thread-1",
          codexTurnId: null,
          triggerMessageId: "msg-1",
          status: "queued",
          startedAt: null,
          completedAt: null,
          error: null,
          createdAt: now,
          updatedAt: now
        },
        queueItem: {
          id: "queue-1",
          appServerId: "app-1",
          threadId: "thread-1",
          kind: "send_message",
          status: "pending",
          payload: {},
          result: null,
          error: null,
          createdAt: now,
          updatedAt: now
        }
      };
    });

    const service = new ScheduledMessageService(database, new EventService(), sendText);
    const created = service.create({
      appServerId: "app-1",
      threadId: "thread-1",
      text: "hello later",
      delaySeconds: 0
    });

    await service.runDueTask(created.id);

    const updated = service.get(created.id);
    expect(updated.status).toBe("sent");
    expect(updated.sentMessageId).toBe("msg-1");
    expect(updated.sentTurnId).toBe("turn-1");
    expect(updated.attemptCount).toBe(1);
    expect(sendText).toHaveBeenCalledWith("thread-1", "hello later", []);
    database.close();
  });

  it("marks due tasks failed when the app server is offline", async () => {
    const database = createDatabase({
      dataDir: "/tmp",
      sqlitePath: ":memory:",
      uploadDir: "/tmp/uploads",
      skillsRoot: "/tmp/skills",
      port: 0
    });
    initializeDatabase(database);
    seedAppServer(database, { status: "offline" });
    seedThread(database);

    const sendText = vi.fn();
    const service = new ScheduledMessageService(database, new EventService(), sendText);
    const created = service.create({
      appServerId: "app-1",
      threadId: "thread-1",
      text: "hello later",
      delaySeconds: 0
    });

    await service.runDueTask(created.id);

    const updated = service.get(created.id);
    expect(updated.status).toBe("failed");
    expect(updated.lastError).toBe("App server is offline");
    expect(updated.attemptCount).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
    database.close();
  });
});

function seedAppServer(
  database: ReturnType<typeof createDatabase>,
  options: { readonly status: "online" | "offline" }
): void {
  const now = Date.now();
  database.sqlite
    .prepare(
      `
        INSERT INTO app_servers (
          id, name, host_kind, host, ssh_user, ssh_port, workspace, command,
          environment_json, observation_prompt, active_observation_skills_json,
          status, last_started_at, last_seen_at, last_error, created_at, updated_at
        ) VALUES (?, ?, 'local', 'localhost', NULL, NULL, ?, 'codex app-server', '{}', NULL, '[]', ?, NULL, NULL, NULL, ?, ?)
      `
    )
    .run("app-1", "Local", "/workspace/demo", options.status, now, now);
}

function seedThread(database: ReturnType<typeof createDatabase>): void {
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
}
