import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const migrations = sqliteTable("__agentmesh_migrations", {
  id: text("id").primaryKey(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull()
});

export const appServers = sqliteTable(
  "app_servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hostKind: text("host_kind", { enum: ["local", "ssh"] }).notNull(),
    host: text("host").notNull(),
    sshUser: text("ssh_user"),
    sshPort: integer("ssh_port"),
    workspace: text("workspace").notNull(),
    command: text("command").notNull(),
    environmentJson: text("environment_json").notNull().default("{}"),
    observationPrompt: text("observation_prompt"),
    activeObservationSkillsJson: text("active_observation_skills_json").notNull().default("[]"),
    status: text("status", {
      enum: ["offline", "starting", "online", "stopping", "error"]
    }).notNull(),
    lastStartedAt: integer("last_started_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("app_servers_name_unique").on(table.name),
    uniqueIndex("app_servers_host_workspace_unique").on(table.host, table.workspace),
    index("app_servers_status_idx").on(table.status)
  ]
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id").notNull(),
    threadName: text("thread_name").notNull(),
    agentKind: text("agent_kind", { enum: ["main", "subagent"] })
      .notNull()
      .default("main"),
    parentThreadId: text("parent_thread_id"),
    parentCodexThreadId: text("parent_codex_thread_id"),
    agentName: text("agent_name"),
    title: text("title"),
    status: text("status"),
    cwd: text("cwd"),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull(),
    isGone: integer("is_gone", { mode: "boolean" }).notNull(),
    importedAt: integer("imported_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    rawMetadataJson: text("raw_metadata_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    uniqueIndex("threads_app_server_codex_thread_unique").on(
      table.appServerId,
      table.codexThreadId
    ),
    index("threads_app_server_current_idx").on(
      table.appServerId,
      table.isCurrent,
      table.threadName
    ),
    index("threads_app_server_gone_idx").on(table.appServerId, table.isGone),
    index("threads_thread_name_idx").on(table.appServerId, table.threadName),
    index("threads_agent_family_idx").on(table.appServerId, table.agentKind, table.parentThreadId),
    index("threads_parent_codex_idx").on(table.appServerId, table.parentCodexThreadId)
  ]
);

export const threadImports = sqliteTable(
  "thread_imports",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    rawJson: text("raw_json").notNull(),
    importedAt: integer("imported_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("thread_imports_thread_idx").on(table.threadId, table.importedAt),
    index("thread_imports_app_server_idx").on(table.appServerId, table.importedAt)
  ]
);

export const threadSettings = sqliteTable("thread_settings", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  model: text("model"),
  effort: text("effort"),
  approvalPolicyJson: text("approval_policy_json"),
  sandboxPolicyJson: text("sandbox_policy_json"),
  collaborationModeJson: text("collaboration_mode_json"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    codexTurnId: text("codex_turn_id"),
    triggerMessageId: text("trigger_message_id"),
    status: text("status").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    error: text("error"),
    importedFromId: text("imported_from_id").references(() => threadImports.id, {
      onDelete: "set null"
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("turns_thread_timeline_idx").on(table.threadId, table.createdAt),
    index("turns_app_server_thread_idx").on(table.appServerId, table.threadId),
    index("turns_codex_turn_idx").on(table.codexTurnId)
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    role: text("role", { enum: ["user", "assistant", "tool", "system", "event"] }).notNull(),
    status: text("status", {
      enum: ["pending", "queued", "sent", "streaming", "completed", "failed"]
    }).notNull(),
    partsJson: text("parts_json").notNull(),
    rawEventIdsJson: text("raw_event_ids_json").notNull().default("[]"),
    importedFromId: text("imported_from_id").references(() => threadImports.id, {
      onDelete: "set null"
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("messages_thread_timeline_idx").on(table.threadId, table.createdAt),
    index("messages_app_server_thread_timeline_idx").on(
      table.appServerId,
      table.threadId,
      table.createdAt
    ),
    index("messages_turn_idx").on(table.turnId)
  ]
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["image"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    localPath: text("local_path").notNull(),
    workspacePath: text("workspace_path"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [index("attachments_kind_idx").on(table.kind)]
);

export const messageAttachments = sqliteTable(
  "message_attachments",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.attachmentId] }),
    index("message_attachments_attachment_idx").on(table.attachmentId)
  ]
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    codexRequestId: text("codex_request_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "expired", "failed"]
    }).notNull(),
    requestJson: text("request_json").notNull(),
    responseJson: text("response_json"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("approvals_thread_status_idx").on(table.threadId, table.status, table.createdAt),
    index("approvals_pending_idx").on(table.status, table.createdAt),
    index("approvals_codex_request_idx").on(table.appServerId, table.codexRequestId)
  ]
);

export const queueItems = sqliteTable(
  "queue_items",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["send_message", "approval_response", "read_thread", "sync_thread_list"]
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "waiting_approval", "completed", "failed"]
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("queue_items_thread_status_idx").on(table.threadId, table.status, table.createdAt),
    index("queue_items_pending_idx").on(table.status, table.createdAt),
    index("queue_items_app_server_thread_idx").on(table.appServerId, table.threadId)
  ]
);

export const codexEvents = sqliteTable(
  "codex_events",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    rawJson: text("raw_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("codex_events_thread_timeline_idx").on(table.threadId, table.createdAt),
    index("codex_events_app_server_timeline_idx").on(table.appServerId, table.createdAt),
    index("codex_events_turn_idx").on(table.turnId)
  ]
);

export const uiLayouts = sqliteTable(
  "ui_layouts",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["boards", "threads"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    treeJson: text("tree_json").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [uniqueIndex("ui_layouts_kind_owner_unique").on(table.kind, table.ownerId)]
);

export const threadDrafts = sqliteTable(
  "thread_drafts",
  {
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    draftMarkdown: text("draft_markdown").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.appServerId, table.threadId] }),
    index("thread_drafts_thread_idx").on(table.threadId)
  ]
);

export const todos = sqliteTable(
  "todos",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category"),
    sortIndex: integer("sort_index").notNull().default(0),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("todos_sort_index_idx").on(table.sortIndex)
  ]
);

export const scheduledMessages = sqliteTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey(),
    appServerId: text("app_server_id")
      .notNull()
      .references(() => appServers.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", {
      enum: ["scheduled", "sending", "sent", "failed", "canceled"]
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    sentMessageId: text("sent_message_id").references(() => messages.id, { onDelete: "set null" }),
    sentTurnId: text("sent_turn_id").references(() => turns.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => [
    index("scheduled_messages_status_run_at_idx").on(table.status, table.runAt),
    index("scheduled_messages_thread_idx").on(table.threadId, table.createdAt),
    index("scheduled_messages_app_server_idx").on(table.appServerId, table.createdAt)
  ]
);
