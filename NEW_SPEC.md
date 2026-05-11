# AgentMesh Specification

## 1. Purpose

AgentMesh is a local control plane for multiple Codex app-server processes.

It provides one web UI and one backend service that can:

- configure and start local or remote Codex app-server processes;
- list each app-server's current Codex threads;
- render Codex thread conversations in the browser;
- send text and image messages to an existing Codex thread;
- persist observed thread messages and Codex events to local SQLite;
- handle Codex approval requests from the web UI;
- copy text from one thread composer to another by drag/drop;
- distribute local skills to app-server workspaces;
- expose a small MCP server so Codex agents can send text messages to other app-server threads.

AgentMesh is not a task scheduler. Codex app-server owns thread lifecycle and execution.

## 2. Non-Goals

AgentMesh MUST NOT implement the old Linear/task/orchestrator model.

AgentMesh MUST NOT:

- integrate with Linear;
- create issues or tasks;
- create Codex threads in the first version;
- manage Codex thread lifecycle;
- schedule work across threads;
- control how many threads a Codex app-server owns;
- control Codex app-server turn concurrency;
- expose Codex app-server HTTP ports;
- use Markdown files as the data source;
- use WebSocket for realtime updates;
- store SQLite databases inside Codex workspaces;
- treat drag/drop as workflow automation.

Codex app-server is the source of truth for which threads currently exist. AgentMesh observes, renders, records, and forwards messages.

## 3. Technology Stack

The implementation MUST replace the Elixir implementation with a pnpm + TypeScript stack.

Backend:

- Node.js
- TypeScript
- Fastify
- SQLite
- `better-sqlite3`
- Drizzle ORM
- Zod for request validation
- `execa` or Node child process APIs for local process management
- `ssh2` or equivalent SSH library for remote process startup and file copy
- `gray-matter` or equivalent for reading skill metadata
- `@modelcontextprotocol/sdk` for MCP

Frontend:

- Vue 3
- Vite
- TypeScript
- Pinia
- Vue Router
- Element Plus
- Split-pane layout library, such as `splitpanes`
- Virtual list library, such as `@tanstack/vue-virtual` or `vue-virtual-scroller`
- CodeMirror 6 for Markdown source editing
- `markdown-it` or equivalent for Markdown rendering

Realtime:

- Server-Sent Events (SSE) for backend-to-frontend notifications.
- REST APIs for all frontend actions.
- No WebSocket in the first version.

Package management:

- pnpm.

## 4. Core Domain Model

### 4.1 App Server

An app-server record represents one configured Codex app-server process.

An app-server is identified by a stable internal `app_server_id`, but user-facing routing and MCP use `app_server_name`.

An app-server has:

- a local or SSH host;
- a workspace path;
- a launch command;
- a generated unique name;
- a current runtime status.

Uniqueness:

- The real endpoint identity is `host + workspace`.
- `app_server_name` MUST be globally unique.
- The default generated name uses only the workspace basename plus an incrementing integer.
- Example: workspace `/home/qingren/projects/symphony` generates `symphony_1`.
- If `symphony_1` exists, generate `symphony_2`, then `symphony_3`, and so on.
- Users MAY edit `app_server_name`, but saving MUST reject duplicates.

Local app-server:

- Runs as a child process from the backend.
- Uses stdio JSON-RPC.
- Does not expose an HTTP port.

Remote app-server:

- Runs as a process started through SSH.
- Uses the SSH command's stdio as the JSON-RPC transport.
- Does not expose an HTTP port.
- Image and skill file transfer uses SSH/SFTP/SCP/rsync or an equivalent SSH file-copy mechanism.

### 4.2 Workspace

Each app-server has one workspace.

All threads owned by that app-server are assumed to use the same workspace. AgentMesh does not support per-thread workspace switching in the first version.

The workspace is the project directory Codex works in.

AgentMesh-owned files inside a Codex workspace:

```text
<workspace>/.agentmesh/
  images/
  logs/
  tmp/
  manifest.json
```

Codex skills are not stored under `.agentmesh`. Skills are copied directly to:

```text
<workspace>/.codex/skills/<skill-name>/
```

SQLite is stored under the AgentMesh backend data directory, not inside any Codex workspace.

### 4.3 Thread

A thread is owned by Codex app-server.

AgentMesh MUST NOT create or delete threads in the first version.

AgentMesh obtains the current thread list by calling Codex app-server `thread/list`.

For each app-server:

- the Board thread sidebar shows only threads currently returned by `thread/list`;
- if a previously open thread disappears from `thread/list`, its panel remains visible as read-only history and is marked `gone`;
- disappeared threads cannot receive new messages.

Thread display name:

- First version uses the name/title returned by Codex app-server.
- AgentMesh does not maintain user aliases for threads.
- Fallback order: `thread.name`, then `thread.title`, then `thread.id`.

MCP routing uses `app_server_name + thread_name`.

If multiple threads under the same app-server have the same `thread_name`, MCP `send_message` MUST fail with an ambiguous-thread error instead of guessing.

### 4.4 Board

A Board represents one app-server in the frontend.

One app-server equals one Board.

The UI can open multiple Boards at once.

Each Board contains:

- a header with app-server name/status/workspace;
- a thread sidebar showing current threads from that app-server;
- a main split-pane region containing opened thread panels.

The Board does not own threads. It renders the app-server's current thread set.

### 4.5 Thread Panel

A thread panel is one chat UI bound to one Codex thread.

One thread panel equals one Codex thread.

Thread panels:

- render normalized messages from SQLite;
- provide a Markdown source editor composer;
- support up to 5 image attachments per user message;
- show approval requests and allow responding;
- support dragging message text into another composer;
- use virtual scrolling for message rendering.

## 5. Layout Model

The frontend uses split-pane tree layouts, not absolute-position free dragging.

Top-level layout:

- A split-pane tree whose leaves are Boards.
- Boards may be arranged horizontally or vertically.
- Opening a new Board splits the currently focused pane to the right by default.
- The UI MAY offer explicit `Split Right` and `Split Down`.

Board internal layout:

- Each Board has a thread sidebar.
- The Board main region is a split-pane tree whose leaves are thread panels.
- Opening a thread splits the currently focused thread area to the right by default.
- The UI MAY offer explicit `Split Right` and `Split Down`.

Persisted UI state is minimal:

- top-level Board split tree;
- per-Board thread split tree;
- focused Board/thread;
- composer drafts;
- pane sizes and collapse state.

AgentMesh does not need multi-user realtime layout synchronization.

## 6. Drag/Drop Text Copy

Drag/drop is a convenience for copying text, not an automation workflow.

Rules:

- Dragging a message copies only its plain/Markdown text.
- Images are not included in drag/drop.
- Source metadata is not included.
- No source/target forwarding record is required.
- Dropping onto a target thread composer appends the text to the existing draft.
- Dropped text MUST NOT automatically send.
- Append format SHOULD be `existingDraft + "\n\n" + draggedText`.

The user can edit the target composer before sending.

## 7. Message Model

Messages MUST use a multi-part model. Markdown is only one part type.

Recommended TypeScript shape:

```ts
type ChatMessage = {
  id: string
  appServerId: string
  threadId: string
  turnId?: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'event'
  status: 'pending' | 'queued' | 'sent' | 'streaming' | 'completed' | 'failed'
  parts: MessagePart[]
  rawEventIds: string[]
  createdAt: string
  updatedAt: string
}

type MessagePart =
  | { type: 'markdown'; text: string }
  | { type: 'image'; attachmentId: string; workspacePath?: string; url?: string }
  | { type: 'tool_call'; toolName: string; callId: string; input: unknown; status: string }
  | { type: 'tool_result'; callId: string; output: unknown; status: string }
  | { type: 'diff'; text: string }
  | { type: 'approval'; approvalId: string; kind: string; payload: unknown; status: string }
  | { type: 'error'; message: string; raw?: unknown }
  | { type: 'event'; eventType: string; raw?: unknown }
```

UI rendering:

- user Markdown;
- user images;
- assistant Markdown;
- errors;
- turn status;
- tool calls/results as expandable cards;
- diffs as expandable cards;
- approvals as interactive cards;
- raw JSON only in an optional debug view.

All supported Codex event categories MUST be preserved in storage, even if the first UI renders some categories as collapsed cards.

## 8. Turns and Thread Queues

Each thread has one logical message queue in AgentMesh.

AgentMesh uses a thread queue only to preserve send order for that specific thread. It does not schedule app-server-wide work.

Rules:

- Same-thread sends are strictly ordered.
- At most one active queue item for a thread is processed by AgentMesh at a time.
- If a turn is waiting on approval, subsequent messages for that thread remain queued.
- Different threads are not globally scheduled by AgentMesh.
- AgentMesh does not enforce app-server-level concurrency limits.
- Codex app-server controls its own thread execution model.

Queue item kinds:

- `send_message`
- `approval_response`
- `read_thread`
- `sync_thread_list`

Queue item status:

- `pending`
- `running`
- `waiting_approval`
- `completed`
- `failed`

When the target app-server is offline:

- sending fails immediately;
- the frontend composer draft is preserved;
- a failed record MAY be written for the attempted send.

When a user sends a message to an online app-server:

1. Backend validates the target app-server and thread.
2. Backend writes a user message with `pending` or `queued` status.
3. Backend writes a queue item for the thread.
4. Backend copies images to the target workspace if present.
5. Backend sends `turn/start` to Codex app-server when the item reaches the queue head.
6. Backend writes Codex responses/notifications to SQLite.
7. Backend normalizes events into UI messages.
8. Backend emits SSE notifications for frontend refresh.

Failed sends MUST be visible as failed messages or failed queue items, not silently discarded.

## 9. Codex App-Server Protocol Usage

AgentMesh talks to Codex app-server using stdio JSON-RPC.

The implementation MUST generate or inspect the installed Codex app-server JSON schema during development and keep request payloads compatible with the targeted Codex version.

Required protocol usage:

- initialize the app-server connection;
- call `thread/list` for current thread metadata;
- call `thread/read` or equivalent when importing an opened thread's history;
- call `turn/start` to send user input to an existing thread;
- handle server notifications for messages, tool calls, diffs, approvals, status, and errors;
- respond to approval requests over the same JSON-RPC connection.

Known current schema capabilities:

- `turn/start.params.input` supports text input.
- `turn/start.params.input` supports image input via `image` URL or `localImage` path.
- `thread/list` supports pagination and filters.
- `thread/loaded/list` lists loaded thread ids.

AgentMesh should prefer `localImage` for uploaded images.

## 10. Thread Synchronization

Thread list synchronization:

- Backend periodically or on-demand calls `thread/list` for each online app-server.
- Board sidebar displays only the current `thread/list` result.
- The sync updates SQLite thread metadata.
- Thread list sync does not import full history for every thread.

Message history import:

- When the user first opens a thread, backend checks if that thread has been imported.
- If not imported, backend calls `thread/read` or equivalent.
- The historical thread response is converted into `turns` and `messages`.
- The raw historical response is stored separately as a thread import snapshot.
- Historical import MUST NOT create fake realtime `codex_events`.

After import:

- All future interactions routed through AgentMesh are recorded as they happen.
- SQLite becomes the local record of observed and proxied messages/events.

If a user never opens a thread, the system may only have metadata for that thread.

## 11. SQLite Storage

SQLite is the backend-owned persistence layer.

SQLite stores:

- app-server configuration;
- app-server last known status;
- current thread metadata;
- imported thread snapshots;
- turns;
- messages;
- attachments metadata;
- approvals;
- per-thread queue items;
- raw Codex events observed through AgentMesh;
- minimal UI layout/draft state.

SQLite does not store image binary blobs.

### 11.1 Suggested Tables

```text
app_servers
  id
  name
  host_kind        -- local | ssh
  host
  ssh_user
  ssh_port
  workspace
  command
  status          -- offline | starting | online | stopping | error
  last_started_at
  last_seen_at
  last_error
  created_at
  updated_at

threads
  id
  app_server_id
  codex_thread_id
  thread_name
  title
  status
  cwd
  is_current       -- true if present in latest thread/list
  is_gone
  imported_at
  last_seen_at
  raw_metadata_json
  created_at
  updated_at

thread_imports
  id
  app_server_id
  thread_id
  raw_json
  imported_at

turns
  id
  app_server_id
  thread_id
  codex_turn_id
  trigger_message_id
  status
  started_at
  completed_at
  error
  imported_from_id
  created_at
  updated_at

messages
  id
  app_server_id
  thread_id
  turn_id
  role
  status
  parts_json
  imported_from_id
  created_at
  updated_at

attachments
  id
  kind             -- image
  mime_type
  filename
  size
  local_path
  workspace_path
  created_at

message_attachments
  message_id
  attachment_id

approvals
  id
  app_server_id
  thread_id
  turn_id
  codex_request_id
  kind
  status           -- pending | approved | denied | expired | failed
  request_json
  response_json
  error
  created_at
  updated_at

queue_items
  id
  app_server_id
  thread_id
  kind
  status
  payload_json
  result_json
  error
  created_at
  updated_at

codex_events
  id
  app_server_id
  thread_id
  turn_id
  event_type
  raw_json
  created_at

ui_layouts
  id
  kind             -- boards | threads
  owner_id         -- global for boards, app_server_id for Board thread layout
  tree_json
  updated_at

thread_drafts
  app_server_id
  thread_id
  draft_markdown
  updated_at
```

## 12. Image Handling

The web composer supports image attachments.

Rules:

- A single user message supports at most 5 images.
- Images are attachments, not Markdown `![](...)` paths.
- Supported formats SHOULD include PNG, JPEG, WebP, and GIF.
- Backend MUST validate file type and size.
- SQLite stores metadata only.
- Files are stored on disk.

Storage:

- Backend upload cache: AgentMesh backend data directory.
- Target app-server workspace copy: `<workspace>/.agentmesh/images/<attachment-id>.<ext>`.

Local app-server:

- Backend writes/copies image files directly into the target workspace `.agentmesh/images`.

Remote app-server:

- Backend uploads image files through SSH/SFTP/SCP/rsync or equivalent.
- Backend creates `<workspace>/.agentmesh/images` if missing.

Sending to Codex:

```json
{
  "type": "localImage",
  "path": "/absolute/workspace/.agentmesh/images/<attachment-id>.png"
}
```

The `turn/start` input SHOULD include text first, followed by image items:

```json
[
  { "type": "text", "text": "markdown text" },
  { "type": "localImage", "path": "/workspace/.agentmesh/images/img1.png" }
]
```

If any image copy fails, the send should fail and the message should be marked failed.

## 13. Markdown Composer

Each thread panel has a Markdown source editor.

Requirements:

- Use CodeMirror-style source editing.
- Provide optional preview.
- Preserve code blocks and pasted logs.
- Keep image attachments separate from Markdown text.
- Support draft persistence in SQLite.
- Support appending dragged text to the current draft.
- Support resizing composer height.

The composer is not a WYSIWYG editor in the first version.

## 14. Approval Handling

Codex approval requests MUST be handled in the web UI.

Approval behavior:

- Backend receives approval request from Codex app-server.
- Backend writes an `approvals` row with `pending` status.
- Backend adds or updates a message part/card in the relevant thread.
- Backend emits SSE event.
- Frontend renders approval card with action buttons.
- User can approve or deny.
- Backend sends the approval response to Codex over the original app-server connection.
- Backend records the response and emits updates.

If no browser is open:

- Approval stays pending in the backend and Codex app-server remains pending.
- AgentMesh does not auto-approve.
- AgentMesh does not auto-deny.

If the app-server exits while an approval is pending:

- Approval should be marked failed or expired.
- The UI should show that the approval can no longer be answered.

## 15. Raw Event Storage

All realtime Codex JSON notifications and responses observed by AgentMesh SHOULD be stored in `codex_events`.

The UI should render normalized `messages` by default, not raw event JSON.

Raw events are for:

- debugging;
- protocol compatibility work;
- re-normalizing events later;
- inspecting failed turns.

Historical `thread/read` import responses are not realtime events. Store them in `thread_imports`, then convert their content into `turns` and `messages`.

## 16. Skills

AgentMesh provides simple skill list and sync.

Skill source:

- Backend has one configured local `skills_root`.
- The frontend requests the current list from the backend.
- Backend scans the directory on each request.
- No SQLite table is required for skill list state.
- No versioning, checksum, or persistent skill catalog is required in the first version.

Skill directory format:

```text
<skills_root>/
  skill-a/
    SKILL.md
  skill-b/
    SKILL.md
```

Skill list:

- `GET /api/skills` scans `skills_root`.
- Each immediate child directory containing `SKILL.md` is considered a skill.
- Backend parses `name` and `description` from `SKILL.md` front matter.
- If front matter is missing, fallback name is the directory name and description is empty.

Skill sync:

- User selects one or more skills and one or more app-servers.
- Backend copies each selected skill directory to `<workspace>/.codex/skills/<skill-name>`.
- If the target skill directory exists, backend deletes it first.
- Sync result should equal the current backend skill directory content.
- Local sync uses filesystem copy.
- Remote sync uses SSH/SFTP/SCP/rsync or equivalent.

Skill sync status may be returned by the API response and shown in the UI, but persistent version tracking is not required.

## 17. MCP Server

AgentMesh exposes a minimal MCP server for Codex agents.

Purpose:

- Let one Codex app-server send a text message to a thread under another Codex app-server.
- Provide discoverability of current app-servers and threads.

MCP does not manage lifecycle or layout.

MCP tools:

```ts
list_app_servers(): Array<{
  app_server_name: string
  host: string
  workspace: string
  status: string
}>

list_threads(input: {
  app_server_name: string
}): Array<{
  thread_name: string
  thread_id: string
  status?: string
  updated_at?: string
}>

send_message(input: {
  app_server_name: string
  thread_name: string
  text: string
}): {
  status: 'queued' | 'sent' | 'failed'
  error?: string
}
```

MCP send rules:

- Text only.
- No image support in the first version.
- Uses `app_server_name + thread_name` externally.
- Backend resolves to internal `app_server_id + codex_thread_id`.
- If app-server is missing, return `app_server_not_found`.
- If app-server is offline, return `app_server_offline`.
- If thread is missing, return `thread_not_found`.
- If thread name is ambiguous under that app-server, return `ambiguous_thread_name`.
- If resolvable, send through the same backend thread queue and SQLite logging pipeline as web sends.

MCP MUST NOT bypass SQLite, queues, or message normalization.

## 18. Backend Process Management

The backend starts and manages app-server processes.

Lifecycle:

- User configures an app-server.
- User clicks Start.
- Backend starts the process.
- Backend initializes JSON-RPC.
- Backend calls `thread/list`.
- Backend marks app-server online.
- User can Stop or Restart.

Backend restart behavior:

- SQLite stores app-server config and last status.
- Process handles and stdio connections live only in backend memory.
- After backend restart, all app-servers are considered offline.
- The user manually starts app-servers again.
- No auto-restart is required in the first version.

Local launch:

```text
cwd = workspace
command = configured command, default "codex app-server"
transport = child process stdin/stdout
```

Remote launch:

```text
ssh user@host "cd <workspace> && <command>"
transport = SSH command stdin/stdout
```

The backend must parse stdout JSON-RPC messages and route responses by request id.

## 19. REST API

REST handles all frontend actions.

Suggested endpoints:

```text
GET    /api/app-servers
POST   /api/app-servers
PATCH  /api/app-servers/:id
DELETE /api/app-servers/:id
POST   /api/app-servers/:id/start
POST   /api/app-servers/:id/stop
POST   /api/app-servers/:id/restart

GET    /api/app-servers/:id/threads
POST   /api/app-servers/:id/threads/sync
GET    /api/threads/:threadId
GET    /api/threads/:threadId/messages
POST   /api/threads/:threadId/import

POST   /api/messages/send
POST   /api/uploads/images

GET    /api/approvals
POST   /api/approvals/:id/respond

GET    /api/skills
POST   /api/skills/sync

GET    /api/ui/layouts
PUT    /api/ui/layouts/:id
GET    /api/ui/drafts
PUT    /api/ui/drafts/:threadId
```

All request bodies MUST be validated with Zod or equivalent.

## 20. SSE API

SSE is the only realtime browser transport in the first version.

Endpoint:

```text
GET /api/events
```

The browser maintains one global SSE connection.

SSE event types:

```text
app_server.status_changed
thread.list_changed
thread.imported
thread.gone
thread.message_added
thread.message_updated
turn.status_changed
approval.created
approval.updated
queue.item_updated
skill.sync_completed
error
```

Event shape:

```json
{
  "id": "evt_123",
  "type": "thread.message_added",
  "app_server_id": "asrv_1",
  "thread_id": "thread_1",
  "payload": {}
}
```

SSE delivery is notification-only.

Reconnect behavior:

- No event replay is required.
- SQLite is the source of truth.
- After reconnect, the frontend reloads app-server list, open Board thread lists, open thread messages, approvals, and queue status.

## 21. Frontend Requirements

The web app is the primary UI.

Required screens/components:

- app-server configuration list;
- Start/Stop/Restart controls;
- multi-Board split-pane view;
- Board header and thread sidebar;
- thread panel chat view;
- virtualized message list;
- Markdown source composer;
- image attachment picker and preview list;
- approval cards;
- skill list and sync UI;
- MCP status/help page or settings section;
- raw event/debug drawer.

Board behavior:

- A Board corresponds to one app-server.
- Board sidebar updates from current `thread/list` data.
- Clicking a thread opens it in the Board main split-pane region.
- If the thread has no local import, opening triggers import.
- Open panels render from SQLite-backed API data.

Thread panel behavior:

- Use virtual scrolling for messages.
- Lazy-load image thumbnails.
- Render Markdown safely.
- Tool/diff/approval/event parts are supported.
- Tool/diff/event parts may be collapsed by default.
- Approval parts must be actionable when pending.

Performance:

- Only render visible messages.
- Only render opened Boards and opened thread panels.
- Do not mount raw JSON event views unless expanded.
- Cache Markdown render results in frontend memory where practical.

## 22. Error Handling

Errors must be explicit in UI and storage.

Examples:

- app-server offline;
- SSH connection failed;
- process exited;
- JSON-RPC request timed out;
- thread not found;
- thread disappeared;
- ambiguous thread name for MCP;
- image upload failed;
- image copy failed;
- skill sync failed;
- approval response failed;
- Codex turn failed or cancelled.

Failed sends should produce failed message/queue state rather than disappearing.

## 23. Security and Safety

AgentMesh can start local and remote processes and copy files. The first version is intended as a trusted local control plane.

Required safeguards:

- validate workspace paths;
- do not allow path traversal in skill names or uploaded filenames;
- copy only selected skill directories under configured `skills_root`;
- restrict uploads to allowed image MIME types and size limits;
- never write SQLite inside app-server workspace;
- avoid exposing app-server stdio over HTTP;
- avoid logging secrets where practical;
- require explicit app-server configuration before launching SSH commands.

## 24. Implementation Order

Recommended first implementation order:

1. Scaffold pnpm monorepo with `backend` and `frontend`.
2. Add Fastify, SQLite, Drizzle schema, and migrations.
3. Implement app-server CRUD.
4. Implement local process stdio JSON-RPC.
5. Implement `thread/list` sync and Board sidebar.
6. Implement `thread/read` import into turns/messages.
7. Implement thread panel rendering with virtual list.
8. Implement text send through per-thread queue.
9. Implement raw event capture and message normalization.
10. Implement approval handling.
11. Implement image upload/copy/send with `localImage`.
12. Implement SSE global event stream.
13. Implement split-pane Board/thread layouts and draft persistence.
14. Implement SSH remote process and remote file copy.
15. Implement skill list and overwrite sync.
16. Implement MCP tools.
17. Add integration smoke tests against local `codex app-server`.

## 25. Acceptance Criteria

The project is acceptable when:

- the backend starts with pnpm;
- the frontend starts with pnpm;
- SQLite is created and migrations run;
- a local app-server can be configured and started;
- a remote app-server can be configured and started over SSH;
- app-server status is visible in the UI;
- each app-server appears as one Board;
- Board sidebars show current threads from `thread/list`;
- clicking a thread imports history and opens a thread panel;
- thread messages render from SQLite-backed APIs;
- sending Markdown text writes SQLite state and forwards to Codex;
- sending up to 5 images copies them to `.agentmesh/images` and sends `localImage` input;
- Codex responses/events are stored and normalized into messages;
- raw Codex events are stored for realtime interactions;
- approvals can be approved/denied from the web UI;
- missing browser sessions leave approvals pending;
- drag/drop copies text into another composer without auto-sending;
- skill list scans backend `skills_root`;
- skill sync overwrites target `.codex/skills/<skill-name>`;
- MCP can list app-servers, list threads, and send text to a target thread;
- SSE updates the UI and reconnect reloads current state;
- no Linear integration or task scheduler behavior remains in the new implementation.
