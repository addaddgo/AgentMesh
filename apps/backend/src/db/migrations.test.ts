import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

type TableInfoRow = {
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly pk: number;
};

type IndexListRow = {
  readonly name: string;
  readonly unique: 0 | 1;
};

describe("database migrations", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("creates the AgentMesh SQLite tables", async () => {
    const { app } = await setup();

    const tables = app.database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "__agentmesh_migrations",
      "app_servers",
      "approvals",
      "attachments",
      "codex_events",
      "message_attachments",
      "messages",
      "queue_items",
      "thread_drafts",
      "thread_imports",
      "threads",
      "turns",
      "ui_layouts"
    ]);

    const migration = app.database.sqlite
      .prepare("SELECT id FROM __agentmesh_migrations WHERE id = ?")
      .get("0001_agentmesh_schema");

    expect(migration).toEqual({ id: "0001_agentmesh_schema" });
  });

  it("creates required JSON and thread metadata columns", async () => {
    const { app } = await setup();

    expect(
      columnNames(app.database.sqlite.pragma("table_info(threads)") as TableInfoRow[])
    ).toEqual(
      expect.arrayContaining([
        "codex_thread_id",
        "thread_name",
        "is_current",
        "is_gone",
        "raw_metadata_json"
      ])
    );
    expect(
      columnNames(app.database.sqlite.pragma("table_info(messages)") as TableInfoRow[])
    ).toContain("parts_json");
    expect(
      columnNames(app.database.sqlite.pragma("table_info(approvals)") as TableInfoRow[])
    ).toEqual(expect.arrayContaining(["request_json", "response_json"]));
    expect(
      columnNames(app.database.sqlite.pragma("table_info(queue_items)") as TableInfoRow[])
    ).toContain("thread_id");
    expect(
      columnNames(app.database.sqlite.pragma("table_info(codex_events)") as TableInfoRow[])
    ).toContain("raw_json");
  });

  it("stores image metadata without blob columns", async () => {
    const { app } = await setup();
    const attachmentColumns = app.database.sqlite.pragma(
      "table_info(attachments)"
    ) as TableInfoRow[];

    expect(columnNames(attachmentColumns)).toEqual([
      "id",
      "kind",
      "mime_type",
      "filename",
      "size",
      "local_path",
      "workspace_path",
      "created_at"
    ]);
    expect(attachmentColumns.map((column) => column.type.toUpperCase())).not.toContain("BLOB");
  });

  it("enforces unique app-server names", async () => {
    const { app } = await setup();
    const insert = app.database.sqlite.prepare(`
      INSERT INTO app_servers (
        id,
        name,
        host_kind,
        host,
        workspace,
        command,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, 'local', 'localhost', ?, 'codex app-server', 'offline', 1, 1)
    `);

    insert.run("server-1", "symphony_1", "/workspace/one");

    expect(() => {
      insert.run("server-2", "symphony_1", "/workspace/two");
    }).toThrow(/UNIQUE constraint failed: app_servers\.name/);
  });

  it("adds indexes for timeline, pending queue, and pending approval queries", async () => {
    const { app } = await setup();

    expect(indexNames(app.database.sqlite.pragma("index_list(threads)") as IndexListRow[])).toEqual(
      expect.arrayContaining([
        "threads_app_server_current_idx",
        "threads_thread_name_idx",
        "threads_app_server_codex_thread_unique"
      ])
    );
    expect(
      indexNames(app.database.sqlite.pragma("index_list(messages)") as IndexListRow[])
    ).toEqual(
      expect.arrayContaining([
        "messages_thread_timeline_idx",
        "messages_app_server_thread_timeline_idx"
      ])
    );
    expect(
      indexNames(app.database.sqlite.pragma("index_list(queue_items)") as IndexListRow[])
    ).toContain("queue_items_pending_idx");
    expect(
      indexNames(app.database.sqlite.pragma("index_list(approvals)") as IndexListRow[])
    ).toContain("approvals_pending_idx");
    expect(
      indexNames(app.database.sqlite.pragma("index_list(codex_events)") as IndexListRow[])
    ).toContain("codex_events_thread_timeline_idx");
  });
});

function columnNames(rows: readonly TableInfoRow[]): string[] {
  return rows.map((row) => row.name);
}

function indexNames(rows: readonly IndexListRow[]): string[] {
  return rows.map((row) => row.name);
}
