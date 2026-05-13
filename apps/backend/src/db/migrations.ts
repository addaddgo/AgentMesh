import type { Database } from "better-sqlite3";

export type Migration = {
  readonly id: string;
  readonly sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0000_backend_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS __agentmesh_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `
  },
  {
    id: "0001_agentmesh_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS app_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        host_kind TEXT NOT NULL CHECK (host_kind IN ('local', 'ssh')),
        host TEXT NOT NULL,
        ssh_user TEXT,
        ssh_port INTEGER,
        workspace TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('offline', 'starting', 'online', 'stopping', 'error')),
        last_started_at INTEGER,
        last_seen_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS app_servers_name_unique
        ON app_servers (name);
      CREATE UNIQUE INDEX IF NOT EXISTS app_servers_host_workspace_unique
        ON app_servers (host, workspace);
      CREATE INDEX IF NOT EXISTS app_servers_status_idx
        ON app_servers (status);

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        codex_thread_id TEXT NOT NULL,
        thread_name TEXT NOT NULL,
        title TEXT,
        status TEXT,
        cwd TEXT,
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        is_gone INTEGER NOT NULL CHECK (is_gone IN (0, 1)),
        imported_at INTEGER,
        last_seen_at INTEGER,
        raw_metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS threads_app_server_codex_thread_unique
        ON threads (app_server_id, codex_thread_id);
      CREATE INDEX IF NOT EXISTS threads_app_server_current_idx
        ON threads (app_server_id, is_current, thread_name);
      CREATE INDEX IF NOT EXISTS threads_app_server_gone_idx
        ON threads (app_server_id, is_gone);
      CREATE INDEX IF NOT EXISTS threads_thread_name_idx
        ON threads (app_server_id, thread_name);

      CREATE TABLE IF NOT EXISTS thread_imports (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        raw_json TEXT NOT NULL,
        imported_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS thread_imports_thread_idx
        ON thread_imports (thread_id, imported_at);
      CREATE INDEX IF NOT EXISTS thread_imports_app_server_idx
        ON thread_imports (app_server_id, imported_at);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        codex_turn_id TEXT,
        trigger_message_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        imported_from_id TEXT REFERENCES thread_imports(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS turns_thread_timeline_idx
        ON turns (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS turns_app_server_thread_idx
        ON turns (app_server_id, thread_id);
      CREATE INDEX IF NOT EXISTS turns_codex_turn_idx
        ON turns (codex_turn_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system', 'event')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'sent', 'streaming', 'completed', 'failed')),
        parts_json TEXT NOT NULL,
        raw_event_ids_json TEXT NOT NULL DEFAULT '[]',
        imported_from_id TEXT REFERENCES thread_imports(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_thread_timeline_idx
        ON messages (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_app_server_thread_timeline_idx
        ON messages (app_server_id, thread_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_turn_idx
        ON messages (turn_id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image')),
        mime_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        local_path TEXT NOT NULL,
        workspace_path TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_kind_idx
        ON attachments (kind);

      CREATE TABLE IF NOT EXISTS message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, attachment_id)
      );

      CREATE INDEX IF NOT EXISTS message_attachments_attachment_idx
        ON message_attachments (attachment_id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        codex_request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'failed')),
        request_json TEXT NOT NULL,
        response_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS approvals_thread_status_idx
        ON approvals (thread_id, status, created_at);
      CREATE INDEX IF NOT EXISTS approvals_pending_idx
        ON approvals (status, created_at);
      CREATE INDEX IF NOT EXISTS approvals_codex_request_idx
        ON approvals (app_server_id, codex_request_id);

      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('send_message', 'approval_response', 'read_thread', 'sync_thread_list')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed')),
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS queue_items_thread_status_idx
        ON queue_items (thread_id, status, created_at);
      CREATE INDEX IF NOT EXISTS queue_items_pending_idx
        ON queue_items (status, created_at);
      CREATE INDEX IF NOT EXISTS queue_items_app_server_thread_idx
        ON queue_items (app_server_id, thread_id);

      CREATE TABLE IF NOT EXISTS codex_events (
        id TEXT PRIMARY KEY NOT NULL,
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS codex_events_thread_timeline_idx
        ON codex_events (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS codex_events_app_server_timeline_idx
        ON codex_events (app_server_id, created_at);
      CREATE INDEX IF NOT EXISTS codex_events_turn_idx
        ON codex_events (turn_id);

      CREATE TABLE IF NOT EXISTS ui_layouts (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('boards', 'threads')),
        owner_id TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ui_layouts_kind_owner_unique
        ON ui_layouts (kind, owner_id);

      CREATE TABLE IF NOT EXISTS thread_drafts (
        app_server_id TEXT NOT NULL REFERENCES app_servers(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        draft_markdown TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (app_server_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS thread_drafts_thread_idx
        ON thread_drafts (thread_id);
    `
  },
  {
    id: "0002_app_server_environment",
    sql: `
      ALTER TABLE app_servers
        ADD COLUMN environment_json TEXT NOT NULL DEFAULT '{}';
    `
  },
  {
    id: "0003_thread_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS thread_settings (
        thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        model TEXT,
        effort TEXT,
        approval_policy_json TEXT,
        sandbox_policy_json TEXT,
        collaboration_mode_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    id: "0004_thread_agent_relationships",
    sql: `
      ALTER TABLE threads
        ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'main' CHECK (agent_kind IN ('main', 'subagent'));

      ALTER TABLE threads
        ADD COLUMN parent_thread_id TEXT;

      ALTER TABLE threads
        ADD COLUMN parent_codex_thread_id TEXT;

      ALTER TABLE threads
        ADD COLUMN agent_name TEXT;

      CREATE INDEX IF NOT EXISTS threads_agent_family_idx
        ON threads (app_server_id, agent_kind, parent_thread_id);

      CREATE INDEX IF NOT EXISTS threads_parent_codex_idx
        ON threads (app_server_id, parent_codex_thread_id);

      UPDATE threads
      SET
        parent_codex_thread_id = COALESCE(
          json_extract(raw_metadata_json, '$.source.subAgent.thread_spawn.parent_thread_id'),
          json_extract(raw_metadata_json, '$.source.sub_agent.thread_spawn.parent_thread_id'),
          json_extract(raw_metadata_json, '$.source.subAgent.threadSpawn.parentThreadId'),
          json_extract(raw_metadata_json, '$.source.sub_agent.threadSpawn.parentThreadId')
        ),
        agent_name = COALESCE(
          json_extract(raw_metadata_json, '$.agentNickname'),
          json_extract(raw_metadata_json, '$.agent_nickname'),
          json_extract(raw_metadata_json, '$.agentName'),
          json_extract(raw_metadata_json, '$.agent_name'),
          json_extract(raw_metadata_json, '$.agentRole'),
          json_extract(raw_metadata_json, '$.agent_role'),
          json_extract(raw_metadata_json, '$.source.subAgent.thread_spawn.agent_nickname'),
          json_extract(raw_metadata_json, '$.source.sub_agent.thread_spawn.agent_nickname'),
          json_extract(raw_metadata_json, '$.source.subAgent.threadSpawn.agentNickname'),
          json_extract(raw_metadata_json, '$.source.sub_agent.threadSpawn.agentNickname'),
          json_extract(raw_metadata_json, '$.source.subAgent.thread_spawn.agent_role'),
          json_extract(raw_metadata_json, '$.source.sub_agent.thread_spawn.agent_role'),
          json_extract(raw_metadata_json, '$.source.subAgent.threadSpawn.agentRole'),
          json_extract(raw_metadata_json, '$.source.sub_agent.threadSpawn.agentRole')
        );

      UPDATE threads
      SET
        agent_kind = CASE
          WHEN parent_codex_thread_id IS NULL THEN 'main'
          ELSE 'subagent'
        END,
        agent_name = CASE
          WHEN parent_codex_thread_id IS NULL THEN COALESCE(agent_name, 'main agent')
          ELSE COALESCE(agent_name, 'subagent')
        END;

      UPDATE threads
      SET parent_thread_id = (
        SELECT parent.id
        FROM threads AS parent
        WHERE parent.app_server_id = threads.app_server_id
          AND parent.codex_thread_id = threads.parent_codex_thread_id
        LIMIT 1
      )
      WHERE parent_codex_thread_id IS NOT NULL;
    `
  },
  {
    id: "0005_todos",
    sql: `
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_index INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER,
        done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS todos_sort_index_idx
        ON todos (sort_index);
    `
  },
  {
    id: "0006_todos_category",
    sql: `
      ALTER TABLE todos
        ADD COLUMN category TEXT;
    `
  },
  {
    id: "0007_observation_stack_settings",
    sql: `
      ALTER TABLE app_servers
        ADD COLUMN observation_prompt TEXT;

      ALTER TABLE app_servers
        ADD COLUMN active_observation_skills_json TEXT NOT NULL DEFAULT '[]';
    `
  },

];

export function runMigrations(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __agentmesh_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const hasMigration = sqlite.prepare("SELECT 1 FROM __agentmesh_migrations WHERE id = ? LIMIT 1");
  const recordMigration = sqlite.prepare(
    "INSERT INTO __agentmesh_migrations (id, applied_at) VALUES (?, ?)"
  );

  const apply = sqlite.transaction((migration: Migration) => {
    sqlite.exec(migration.sql);
    recordMigration.run(migration.id, Date.now());
  });

  for (const migration of MIGRATIONS) {
    if (hasMigration.get(migration.id) === undefined) {
      apply(migration);
    }
  }
}
