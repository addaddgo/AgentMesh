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
    const { app } = await setup();

    const first = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "primary",
        hostKind: "local",
        workspace: "/workspace/one"
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
    const { app } = await setup();

    await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "first",
        hostKind: "local",
        workspace: "/workspace/project"
      }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        name: "second",
        hostKind: "local",
        host: "127.0.0.1",
        workspace: "/workspace/project/"
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
    const { app } = await setup();

    const localWithSshFields = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: "/workspace/local",
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

  it("lists, patches, and deletes app servers", async () => {
    const { app } = await setup();

    const created = await app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: "/workspace/project"
      }
    });
    const id = created.json<{ id: string }>().id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/app-servers/${id}`,
      payload: {
        name: "renamed",
        workspace: "/workspace/renamed"
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
      workspace: "/workspace/renamed",
      status: "offline",
      lastError: null
    });
    expect(listed.json()).toMatchObject({
      appServers: [expect.objectContaining({ id, name: "renamed" })]
    });
    expect(deleted.statusCode).toBe(204);
    expect(listedAfterDelete.json()).toEqual({ appServers: [] });
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
    const created = await first.app.inject({
      method: "POST",
      url: "/api/app-servers",
      payload: {
        hostKind: "local",
        workspace: path.join(first.tempDir, "workspace")
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
