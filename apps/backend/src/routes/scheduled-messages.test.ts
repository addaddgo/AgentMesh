import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("scheduled message routes", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    seedAppServerAndThread(backend);
    return backend;
  }

  it("creates and lists scheduled messages", async () => {
    const { app } = await setup();

    const create = await app.inject({
      method: "POST",
      url: "/api/scheduled-messages",
      payload: {
        appServerId: "app-1",
        threadId: "thread-1",
        text: "Follow up in five minutes",
        delaySeconds: 300
      }
    });

    expect(create.statusCode).toBe(200);
    expect(create.json()).toMatchObject({
      item: {
        appServerId: "app-1",
        threadId: "thread-1",
        text: "Follow up in five minutes",
        status: "scheduled"
      }
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/scheduled-messages"
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [
        {
          appServerId: "app-1",
          threadId: "thread-1",
          text: "Follow up in five minutes",
          status: "scheduled"
        }
      ]
    });
  });

  it("updates failed or scheduled messages and cancels scheduled ones", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-messages",
      payload: {
        appServerId: "app-1",
        threadId: "thread-1",
        text: "First draft",
        delaySeconds: 60
      }
    });
    const itemId = created.json().item.id as string;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/scheduled-messages/${itemId}`,
      payload: {
        text: "Updated draft",
        delaySeconds: 120
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      item: {
        id: itemId,
        text: "Updated draft",
        status: "scheduled"
      }
    });

    const canceled = await app.inject({
      method: "POST",
      url: `/api/scheduled-messages/${itemId}/cancel`
    });

    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({
      item: {
        id: itemId,
        status: "canceled"
      }
    });
  });

  it("deletes scheduled or failed messages", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-messages",
      payload: {
        appServerId: "app-1",
        threadId: "thread-1",
        text: "Delete me",
        delaySeconds: 60
      }
    });
    const itemId = created.json().item.id as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scheduled-messages/${itemId}`
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    const list = await app.inject({
      method: "GET",
      url: "/api/scheduled-messages"
    });

    expect(list.json()).toEqual({ items: [] });
  });
});

function seedAppServerAndThread(backend: TestBackend): void {
  const now = Date.now();
  backend.app.database.sqlite
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

  backend.app.database.sqlite
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
