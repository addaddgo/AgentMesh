import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../server.js";
import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("app-server configuration API", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("generates names from the workspace basename plus an incrementing integer", async () => {
    const { app } = await setup();

    const first = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: "/home/qingren/projects/symphony"
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "ssh",
        host: "remote.example.com",
        workspace: "/srv/symphony/"
      }
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      name: "symphony_1",
      hostKind: "local",
      host: "localhost",
      workspace: "/home/qingren/projects/symphony",
      command: "codex app-server",
      status: "offline",
      lastError: null
    });
    expect(second.json()).toMatchObject({
      name: "symphony_2",
      hostKind: "ssh",
      host: "remote.example.com",
      workspace: "/srv/symphony"
    });
  });

  it("rejects duplicate names", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace-one");
    fs.mkdirSync(workspace, { recursive: true });

    const first = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "primary",
        hostKind: "local",
        workspace
      }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "primary",
        hostKind: "ssh",
        host: "host.example.com",
        workspace: "/workspace/two"
      }
    });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "App server name already exists"
      }
    });
  });

  it("rejects duplicate host and workspace identities", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace-project");
    fs.mkdirSync(workspace, { recursive: true });

    await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "first",
        hostKind: "local",
        workspace
      }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "second",
        hostKind: "local",
        host: "127.0.0.1",
        workspace: `${workspace}/`
      }
    });

    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "App server host and workspace already exist"
      }
    });
  });

  it("validates local and SSH configuration", async () => {
    const { app, tempDir } = await setup();
    const localWorkspace = path.join(tempDir, "workspace-local");
    fs.mkdirSync(localWorkspace, { recursive: true });

    const localWithSshFields = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: localWorkspace,
        sshUser: "codex"
      }
    });
    const sshWithoutHost = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "ssh",
        workspace: "/workspace/remote"
      }
    });
    const ssh = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "remote",
        hostKind: "ssh",
        host: "remote.example.com",
        sshUser: "codex",
        sshPort: 2222,
        workspace: "/workspace/remote",
        command: "codex app-server --log-level debug"
      }
    });

    expect(localWithSshFields.statusCode).toBe(400);
    expect(sshWithoutHost.statusCode).toBe(400);
    expect(ssh.statusCode).toBe(201);
    expect(ssh.json()).toMatchObject({
      name: "remote",
      hostKind: "ssh",
      host: "remote.example.com",
      sshUser: "codex",
      sshPort: 2222,
      workspace: "/workspace/remote",
      command: "codex app-server --log-level debug"
    });
  });

  it("stores observation stack settings on the app server", async () => {
    const { app, config, tempDir } = await setup();
    const skillDir = path.join(config.skillsRoot, "observe-logs");
    const workspace = path.join(tempDir, "workspace-project");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: observe-logs\ndescription: inspect logs\n---\nbody"
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        observationPrompt: "Use the workspace observation stack first.",
        activeObservationSkillNames: ["observe-logs"]
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      observationPrompt: "Use the workspace observation stack first.",
      activeObservationSkillNames: ["observe-logs"],
      resolvedObservationPrompt: expect.stringContaining("$observe-logs")
    });
  });

  it("rejects unsafe workspace paths", async () => {
    const { app } = await setup();

    const traversal = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: "/workspace/../escape"
      }
    });
    const root = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: "/"
      }
    });

    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Workspace path must not contain traversal"
      }
    });
    expect(root.statusCode).toBe(400);
    expect(root.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Workspace path is invalid"
      }
    });
  });

  it("rejects local workspaces that do not exist during create", async () => {
    const { app, tempDir } = await setup();
    const missingWorkspace = path.join(tempDir, "missing-workspace");

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: missingWorkspace
      }
    });

    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Workspace path does not exist"
      }
    });
  });

  it("lists, patches, and deletes app servers", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace-project");
    const renamedWorkspace = path.join(tempDir, "workspace-renamed");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(renamedWorkspace, { recursive: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace
      }
    });
    const id = created.json<{ id: string }>().id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/app-servers/${id}`,
      payload: {
        name: "renamed",
        workspace: renamedWorkspace
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/app-servers"
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/app-servers/${id}`
    });
    const listedAfterDelete = await app.inject({
      method: "GET",
      url: "/api/app-servers"
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id,
      name: "renamed",
      workspace: renamedWorkspace,
      status: "offline",
      lastError: null
    });
    expect(listed.json()).toMatchObject({
      appServers: [expect.objectContaining({ id, name: "renamed" })]
    });
    expect(deleted.statusCode).toBe(204);
    expect(listedAfterDelete.json()).toEqual({ appServers: [] });
  });

  it("deletes workspace-related database rows and prunes board layouts", async () => {
    const { app, tempDir } = await setup();
    const now = Date.now();
    const workspace = path.join(tempDir, "workspace-project");
    fs.mkdirSync(workspace, { recursive: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace
      }
    });
    const appServerId = created.json<{ id: string }>().id;
    const threadId = "thread-1";
    const turnId = "turn-1";
    const messageId = "message-1";

    app.database.sqlite
      .prepare(
        `
          INSERT INTO threads (
            id, app_server_id, codex_thread_id, thread_name, agent_kind, parent_thread_id,
            parent_codex_thread_id, agent_name, title, status, cwd, is_current, is_gone,
            imported_at, last_seen_at, raw_metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'main', NULL, NULL, NULL, NULL, 'idle', ?, 1, 0, ?, ?, '{}', ?, ?)
        `
      )
      .run(threadId, appServerId, "codex-thread-1", "main", workspace, now, now, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO thread_settings (thread_id, model, effort, approval_policy_json, sandbox_policy_json, collaboration_mode_json, updated_at) VALUES (?, NULL, NULL, NULL, NULL, NULL, ?)"
      )
      .run(threadId, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO turns (id, app_server_id, thread_id, codex_turn_id, trigger_message_id, status, started_at, completed_at, error, imported_from_id, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, 'completed', ?, ?, NULL, NULL, ?, ?)"
      )
      .run(turnId, appServerId, threadId, now, now, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO messages (id, app_server_id, thread_id, turn_id, role, status, parts_json, raw_event_ids_json, imported_from_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'completed', '[]', '[]', NULL, ?, ?)"
      )
      .run(messageId, appServerId, threadId, turnId, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO approvals (id, app_server_id, thread_id, turn_id, codex_request_id, kind, status, request_json, response_json, error, created_at, updated_at) VALUES ('approval-1', ?, ?, ?, 'req-1', 'exec', 'failed', '{}', NULL, 'x', ?, ?)"
      )
      .run(appServerId, threadId, turnId, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO queue_items (id, app_server_id, thread_id, kind, status, payload_json, result_json, error, created_at, updated_at) VALUES ('queue-1', ?, ?, 'send_message', 'failed', '{}', NULL, 'x', ?, ?)"
      )
      .run(appServerId, threadId, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO codex_events (id, app_server_id, thread_id, turn_id, event_type, raw_json, created_at) VALUES ('event-1', ?, ?, ?, 'test', '{}', ?)"
      )
      .run(appServerId, threadId, turnId, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO thread_drafts (app_server_id, thread_id, draft_markdown, updated_at) VALUES (?, ?, 'draft', ?)"
      )
      .run(appServerId, threadId, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO scheduled_messages (id, app_server_id, thread_id, text, run_at, status, attempt_count, last_error, last_attempt_at, sent_message_id, sent_turn_id, created_at, updated_at) VALUES ('scheduled-1', ?, ?, 'hello', ?, 'scheduled', 0, NULL, NULL, NULL, NULL, ?, ?)"
      )
      .run(appServerId, threadId, now + 60_000, now, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO ui_layouts (id, kind, owner_id, tree_json, updated_at) VALUES ('threads-layout', 'threads', ?, '{\"type\":\"leaf\",\"id\":\"leaf-thread\",\"threadId\":\"thread-1\"}', ?)"
      )
      .run(appServerId, now);
    app.database.sqlite
      .prepare(
        "INSERT INTO ui_layouts (id, kind, owner_id, tree_json, updated_at) VALUES ('boards:root', 'boards', 'root', ?, ?)"
      )
      .run(
        JSON.stringify({
          type: "split",
          id: "split-1",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", id: "leaf-thread", threadId },
          second: { type: "leaf", id: "leaf-keep", threadId: "keep-thread" }
        }),
        now
      );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/app-servers/${appServerId}`
    });

    expect(deleted.statusCode).toBe(204);
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM app_servers").get()).toEqual({
      count: 0
    });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({
      count: 0
    });
    expect(
      app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM thread_settings").get()
    ).toEqual({ count: 0 });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
      count: 0
    });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({
      count: 0
    });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM approvals").get()).toEqual({
      count: 0
    });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM queue_items").get()).toEqual({
      count: 0
    });
    expect(app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_events").get()).toEqual({
      count: 0
    });
    expect(
      app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM thread_drafts").get()
    ).toEqual({ count: 0 });
    expect(
      app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_messages").get()
    ).toEqual({ count: 0 });
    expect(
      app.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM ui_layouts WHERE kind = 'threads' AND owner_id = ?")
        .get(appServerId)
    ).toEqual({ count: 0 });
    expect(
      app.database.sqlite.prepare("SELECT tree_json FROM ui_layouts WHERE id = 'boards:root'").get()
    ).toEqual({
      tree_json: JSON.stringify({ type: "leaf", id: "leaf-keep", threadId: "keep-thread" })
    });
  });

  it("stops a running app server before deleting the workspace", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${appServerId}/start`
        })
      ).statusCode
    ).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/app-servers/${appServerId}`
    });

    expect(deleted.statusCode).toBe(204);
    expect(
      await app.inject({
        method: "POST",
        url: `/api/app-servers/${appServerId}/stop`
      })
    ).toMatchObject({ statusCode: 404 });
  });

  it("starts and stops a local app-server process from the configured workspace", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/start`
    });
    const stopped = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/stop`
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      id,
      status: "online",
      lastError: null
    });
    expect(JSON.parse(fs.readFileSync(path.join(workspace, "initialize.json"), "utf8"))).toEqual({
      method: "initialize",
      cwd: workspace
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      id,
      status: "offline",
      lastError: null
    });
  });

  it("rechecks that a local workspace still exists before start", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace
      }
    });
    const id = created.json<{ id: string }>().id;

    fs.rmSync(workspace, { recursive: true, force: true });

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/start`
    });

    expect(started.statusCode).toBe(400);
    expect(started.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Workspace path does not exist"
      }
    });
  });

  it("restarts an app-server by stopping and starting the process again", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir);
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${id}/start`
        })
      ).statusCode
    ).toBe(200);

    const restarted = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/restart`
    });

    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({
      id,
      status: "online"
    });
    expect(Number(fs.readFileSync(path.join(workspace, "initialize-count.txt"), "utf8"))).toBe(2);
  });

  it("treats app-servers as offline after backend restart without auto-starting", async () => {
    const first = await setup();
    const workspace = path.join(first.tempDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const created = await first.app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace
      }
    });
    const id = created.json<{ id: string }>().id;

    first.app.database.sqlite
      .prepare("UPDATE app_servers SET status = 'online', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);

    await first.app.close();
    const restartedApp = await buildServer({ config: first.config, logger: false });
    backend = {
      ...first,
      app: restartedApp,
      cleanup: async () => {
        await restartedApp.close();
        fs.rmSync(first.tempDir, { recursive: true, force: true });
      }
    };

    const listed = await restartedApp.inject({
      method: "GET",
      url: "/api/app-servers"
    });

    expect(listed.json()).toMatchObject({
      appServers: [expect.objectContaining({ id, status: "offline" })]
    });
  });

  it("persists unexpected process exits and publishes app-server status events", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, { exitAfterInitialize: true });
    const events: unknown[] = [];
    fs.mkdirSync(workspace);
    app.events.subscribe((event) => {
      events.push(event);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/start`
    });
    expect(started.statusCode).toBe(200);

    await waitFor(() => {
      const row = app.database.sqlite
        .prepare("SELECT status FROM app_servers WHERE id = ?")
        .get(id) as { status: string } | undefined;
      return row?.status === "error";
    });

    const appServer = app.database.sqlite
      .prepare("SELECT status, last_error FROM app_servers WHERE id = ?")
      .get(id) as {
      status: string;
      last_error: string;
    };
    const codexEvent = app.database.sqlite
      .prepare("SELECT event_type, raw_json FROM codex_events WHERE app_server_id = ?")
      .get(id) as { event_type: string; raw_json: string } | undefined;

    expect(appServer.status).toBe("error");
    expect(appServer.last_error).toContain("exited unexpectedly");
    expect(codexEvent).toMatchObject({ event_type: "process.exited" });
    expect(JSON.parse(codexEvent?.raw_json ?? "{}")).toEqual({ code: 23, signal: null });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "app_server.status_changed",
          app_server_id: id
        })
      ])
    );
  });

  it("syncs new threads from paginated Codex thread/list responses after start", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [
        {
          threads: [
            { id: "thread-1", name: "Alpha", title: "Ignored title", status: "running" },
            { id: "thread-2", title: "Beta", cwd: "/workspace/project" }
          ],
          nextCursor: "page_2"
        },
        {
          threads: [{ id: "thread-3" }]
        }
      ]
    });
    const events: unknown[] = [];
    fs.mkdirSync(workspace);
    app.events.subscribe((event) => {
      events.push(event);
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/start`
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${id}/threads`
    });

    expect(started.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      threads: [
        {
          appServerId: id,
          codexThreadId: "thread-1",
          threadName: "Alpha",
          title: "Ignored title",
          isCurrent: true,
          isGone: false
        },
        {
          appServerId: id,
          codexThreadId: "thread-2",
          threadName: "Beta",
          cwd: "/workspace/project",
          isCurrent: true
        },
        {
          appServerId: id,
          codexThreadId: "thread-3",
          threadName: "thread-3",
          isCurrent: true
        }
      ]
    });
    expect(readJsonLines(path.join(workspace, "requests.ndjson"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/list", params: { cwd: workspace } }),
        expect.objectContaining({
          method: "thread/list",
          params: { cwd: workspace, cursor: "page_2" }
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.list_changed",
          app_server_id: id
        })
      ])
    );
  });

  it("keeps thread status stable across app-server stop and restart", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [
        {
          threads: [
            {
              id: "thread-1",
              name: "main",
              status: "idle",
              cwd: workspace
            }
          ]
        }
      ]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${id}/start`
        })
      ).statusCode
    ).toBe(200);

    const onlineThreads = await app.inject({
      method: "GET",
      url: `/api/app-servers/${id}/threads`
    });
    expect(onlineThreads.json()).toMatchObject({
      threads: [{ threadName: "main", status: "idle" }]
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${id}/stop`
        })
      ).statusCode
    ).toBe(200);

    const offlineThreads = await app.inject({
      method: "GET",
      url: `/api/app-servers/${id}/threads`
    });
    expect(offlineThreads.json()).toMatchObject({
      threads: [{ threadName: "main", status: "notLoaded" }]
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${id}/start`
        })
      ).statusCode
    ).toBe(200);

    const restartedThreads = await app.inject({
      method: "GET",
      url: `/api/app-servers/${id}/threads`
    });
    expect(restartedThreads.json()).toMatchObject({
      threads: [{ threadName: "main", status: "idle" }]
    });
  });

  it("creates a main thread automatically when an app server starts with no workspace threads", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [{ threads: [] }]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;

    const started = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/start`
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${id}/threads`
    });

    expect(started.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      threads: [
        {
          appServerId: id,
          codexThreadId: "started-thread",
          threadName: "main",
          cwd: workspace,
          isCurrent: true,
          isGone: false
        }
      ]
    });
    expect(readJsonLines(path.join(workspace, "requests.ndjson"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/list", params: { cwd: workspace } }),
        expect.objectContaining({ method: "thread/start", params: { cwd: workspace } }),
        expect.objectContaining({
          method: "thread/name/set",
          params: { threadId: "started-thread", name: "main" }
        })
      ])
    );
  });

  it("creates named threads through the app-server thread API", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [{ threads: [{ id: "existing-thread", name: "Existing", cwd: workspace }] }]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const id = created.json<{ id: string }>().id;
    await app.inject({ method: "POST", url: `/api/app-servers/${id}/start` });

    const response = await app.inject({
      method: "POST",
      url: `/api/app-servers/${id}/threads`,
      payload: { name: "Feature work" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      thread: {
        appServerId: id,
        codexThreadId: "started-thread",
        threadName: "Feature work",
        cwd: workspace,
        isCurrent: true
      }
    });
    expect(readJsonLines(path.join(workspace, "requests.ndjson"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "thread/start", params: { cwd: workspace } }),
        expect.objectContaining({
          method: "thread/name/set",
          params: { threadId: "started-thread", name: "Feature work" }
        })
      ])
    );
  });

  it("updates existing threads and marks disappeared threads gone without deleting history", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [
        {
          threads: [
            { id: "thread-1", name: "Alpha" },
            { id: "thread-2", name: "Beta" }
          ]
        }
      ]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/app-servers/${appServerId}/start`
        })
      ).statusCode
    ).toBe(200);

    const disappearedThread = app.database.sqlite
      .prepare("SELECT id FROM threads WHERE app_server_id = ? AND codex_thread_id = 'thread-2'")
      .get(appServerId) as { id: string };
    app.database.sqlite
      .prepare(
        `
          INSERT INTO messages (
            id,
            app_server_id,
            thread_id,
            turn_id,
            role,
            status,
            parts_json,
            imported_from_id,
            created_at,
            updated_at
          ) VALUES ('message-1', ?, ?, NULL, 'assistant', 'completed', '[]', NULL, ?, ?)
        `
      )
      .run(appServerId, disappearedThread.id, Date.now(), Date.now());

    fs.writeFileSync(
      path.join(workspace, "thread-list-pages.json"),
      JSON.stringify([
        {
          threads: [{ id: "thread-1", name: "Alpha renamed", title: "Updated title" }]
        }
      ])
    );

    const synced = await app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/threads/sync`
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });
    const gone = app.database.sqlite
      .prepare(
        `
          SELECT is_current, is_gone
          FROM threads
          WHERE app_server_id = ? AND codex_thread_id = 'thread-2'
        `
      )
      .get(appServerId) as { is_current: 0 | 1; is_gone: 0 | 1 };
    const historyCount = app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?")
      .get(disappearedThread.id) as { count: number };

    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({
      changed: true,
      threads: [
        {
          codexThreadId: "thread-1",
          threadName: "Alpha renamed",
          title: "Updated title",
          isCurrent: true,
          isGone: false
        }
      ]
    });
    expect(listed.json()).toMatchObject({
      threads: [expect.objectContaining({ codexThreadId: "thread-1", threadName: "Alpha renamed" })]
    });
    expect(gone).toEqual({ is_current: 0, is_gone: 1 });
    expect(historyCount.count).toBe(1);
  });

  it("keeps duplicate thread names as distinct current threads", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    const scriptPath = createFakeCodexScript(tempDir, {
      threadListPages: [
        {
          threads: [
            { id: "thread-a", name: "Same name" },
            { id: "thread-b", name: "Same name" }
          ]
        }
      ]
    });
    fs.mkdirSync(workspace);

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace,
        command: `${process.execPath} ${scriptPath}`
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    await app.inject({
      method: "POST",
      url: `/api/app-servers/${appServerId}/start`
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/threads`
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      threads: [
        { codexThreadId: "thread-a", threadName: "Same name" },
        { codexThreadId: "thread-b", threadName: "Same name" }
      ]
    });
  });

  it("searches workspace files for fuzzy file open", async () => {
    const { app, tempDir } = await setup();
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "ThreadPanel.vue"), "<template />");
    fs.writeFileSync(path.join(workspace, "notes", "todo.md"), "- item");
    fs.writeFileSync(path.join(workspace, "node_modules", "ignored.js"), "ignored");

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace
      }
    });
    const appServerId = created.json<{ id: string }>().id;

    const searched = await app.inject({
      method: "GET",
      url: `/api/app-servers/${appServerId}/workspace/search-files?query=tpvue`
    });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toEqual({
      entries: [{ path: "src/ThreadPanel.vue", name: "ThreadPanel.vue", kind: "file" }]
    });
  });
});

function createFakeCodexScript(
  tempDir: string,
  options: {
    readonly exitAfterInitialize?: boolean;
    readonly threadListPages?: readonly unknown[];
  } = {}
): string {
  const scriptPath = path.join(tempDir, `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(
    scriptPath,
    `
      import fs from "node:fs";
      import path from "node:path";
      import readline from "node:readline";

      const lines = readline.createInterface({ input: process.stdin });
      const countPath = path.join(process.cwd(), "initialize-count.txt");
      const requestsPath = path.join(process.cwd(), "requests.ndjson");
      const defaultThreadListPages = ${JSON.stringify(options.threadListPages ?? [{ threads: [] }])};

      function threadListPages() {
        const dynamicPath = path.join(process.cwd(), "thread-list-pages.json");
        if (fs.existsSync(dynamicPath)) {
          return JSON.parse(fs.readFileSync(dynamicPath, "utf8"));
        }

        return defaultThreadListPages;
      }

      for await (const line of lines) {
        const request = JSON.parse(line);
        fs.appendFileSync(requestsPath, JSON.stringify(request) + "\\n");

        if (request.method === "initialize") {
          const count = fs.existsSync(countPath)
            ? Number(fs.readFileSync(countPath, "utf8"))
            : 0;
          fs.writeFileSync(countPath, String(count + 1));
          fs.writeFileSync(
            path.join(process.cwd(), "initialize.json"),
            JSON.stringify({ method: request.method, cwd: process.cwd() })
          );
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { ok: true }
          }) + "\\n");

          if (${options.exitAfterInitialize === true ? "true" : "false"}) {
            setTimeout(() => process.exit(23), 5);
          }
        } else if (request.method === "thread/list") {
          const pages = threadListPages();
          const cursor = request.params?.cursor;
          const pageIndex =
            typeof cursor === "string" && cursor.startsWith("page_")
              ? Number(cursor.slice("page_".length)) - 1
              : 0;
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: pages[pageIndex] ?? { threads: [] }
          }) + "\\n");
        } else if (request.method === "thread/start") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              thread: {
                id: "started-thread",
                name: null,
                preview: "",
                status: "idle",
                cwd: request.params?.cwd ?? process.cwd()
              },
              cwd: request.params?.cwd ?? process.cwd(),
              model: "gpt-test",
              modelProvider: "openai",
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: "danger-full-access"
            }
          }) + "\\n");
        } else if (request.method === "thread/name/set") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {}
          }) + "\\n");
        }
      }
    `
  );
  return scriptPath;
}

function readJsonLines(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error("Timed out waiting for condition");
}
