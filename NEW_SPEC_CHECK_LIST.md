# AgentMesh Implementation Tasks

This file uses the strict `markdown-check-list` task-block format.

Each task block is executable by the skill. Do not place example task fences before real tasks because the extractor returns the first matching block.

---
[x] Phase 0: Project reset and guardrails
Prepare the repository for the new pnpm + TypeScript + Vue 3 + SQLite implementation.

- Confirm the implementation name and package namespace.
- Decide whether the old `elixir/` implementation remains archived or is removed later.
- Add root `pnpm-workspace.yaml`.
- Add root `package.json` scripts for backend, frontend, lint, typecheck, test, and dev.
- Add shared TypeScript config files.
- Add root `.gitignore` entries for Node, SQLite data, uploads, and build output.
- Add `apps/backend`, `apps/frontend`, and `packages/shared`.
- Add formatting and linting baseline.
- Add backend config loading for data directory, SQLite path, upload directory, skills root, and server port.
- Ensure no new feature depends on Linear.
- Ensure no new feature treats Markdown files as the data source.
- Ensure no new feature creates Codex threads in the first version.
---

---
[x] Phase 1: Backend foundation
Create the Fastify backend foundation.

- Scaffold Fastify backend with TypeScript.
- Add Zod request validation pattern.
- Add typed config module.
- Add structured logging.
- Add health endpoint.
- Add SQLite connection using `better-sqlite3`.
- Add Drizzle ORM and migration runner.
- Initialize database on backend startup.
- Add shared API error format.
- Add common error classes for validation, not found, offline, protocol, SSH, and filesystem errors.
- Add backend unit and integration test setup with temporary SQLite databases.
---

---
[x] Phase 2: SQLite schema
Implement the database schema from `NEW_SPEC.md`.

- Create `app_servers`, `threads`, `thread_imports`, `turns`, `messages`, `attachments`, `message_attachments`, `approvals`, `queue_items`, `codex_events`, `ui_layouts`, and `thread_drafts`.
- Enforce unique app-server name.
- Store Codex `codex_thread_id`, `thread_name`, `is_current`, `is_gone`, and raw thread metadata.
- Store message `parts_json`.
- Store image metadata only, not binary blobs.
- Store raw approval request and response JSON.
- Scope queue items by thread.
- Add indexes for app-server/thread/message timeline queries.
- Add indexes for pending queue and pending approvals.
- Add migration tests.
---

---
[x] Phase 3: App-server configuration API
Implement app-server CRUD and validation.

- Generate app-server names from workspace basename plus incrementing integer.
- Validate duplicate names.
- Validate host + workspace identity.
- Support local app-server configuration.
- Support SSH app-server configuration.
- Default command to `codex app-server`.
- Implement `GET /api/app-servers`.
- Implement `POST /api/app-servers`.
- Implement `PATCH /api/app-servers/:id`.
- Implement `DELETE /api/app-servers/:id`.
- Persist status and last error fields.
- Add tests for name generation, duplicate handling, and local/SSH validation.
---

---
[x] Phase 4: Codex JSON-RPC transport
Implement stdio JSON-RPC transport for Codex app-server.

- Inspect or generate local Codex app-server JSON schema during development.
- Add TypeScript JSON-RPC request/response/error/notification types.
- Implement request id generation and pending request map.
- Parse line-delimited JSON from stdout.
- Write JSON-RPC requests to stdin.
- Route responses by request id.
- Route notifications to handlers.
- Store malformed output as protocol errors.
- Implement request timeout and graceful close.
- Implement local child-process stdio transport.
- Implement SSH command stdio transport.
- Ensure no Codex app-server HTTP port is exposed.
- Add tests with a fake Codex stdio process.
---

---
[x] Phase 5: App-server process lifecycle
Implement backend-owned local and remote process lifecycle.

- Add in-memory process registry keyed by `app_server_id`.
- Implement `POST /api/app-servers/:id/start`.
- Start local process with `cwd = workspace`.
- Start remote process via SSH with `cd <workspace> && <command>`.
- Send initialize after process start.
- Mark app-server `starting`, `online`, `offline`, or `error`.
- Persist status transitions and last error.
- Implement `POST /api/app-servers/:id/stop`.
- Implement `POST /api/app-servers/:id/restart`.
- Treat all app-servers as offline after backend restart.
- Do not auto-start app-servers on backend startup.
- Surface process exit in SQLite and SSE.
---

---
[x] Phase 6: Thread list sync
Implement current thread discovery from Codex app-server.

- Call Codex `thread/list`.
- Support pagination if cursors are returned.
- Map Codex thread name/title/id to `thread_name`.
- Upsert `threads` rows from `thread/list`.
- Mark missing threads as `is_current = false` and `is_gone = true`.
- Preserve gone thread message history.
- Implement `GET /api/app-servers/:id/threads`.
- Implement `POST /api/app-servers/:id/threads/sync`.
- Trigger sync after app-server start.
- Emit `thread.list_changed` SSE event.
- Add tests for new, updated, disappeared, and duplicate-name threads.
---

---
[x] Phase 7: Thread history import
Import thread history when a thread is first opened.

- Call Codex `thread/read` or equivalent.
- Implement `POST /api/threads/:threadId/import`.
- Store raw response in `thread_imports`.
- Convert imported history into `turns`.
- Convert imported history into multi-part `messages`.
- Do not create fake realtime `codex_events` from imported history.
- Mark `threads.imported_at`.
- Make import idempotent.
- Implement `GET /api/threads/:threadId`.
- Implement `GET /api/threads/:threadId/messages`.
- Add tests for conversion and duplicate prevention.
---

---
[x] Phase 8: Message parts and normalization
Implement the shared multi-part message model.

- Define shared `ChatMessage` type.
- Define shared `MessagePart` union.
- Normalize Markdown, image, tool call, tool result, diff, approval, error, and generic event parts.
- Preserve unsupported event content as collapsed event parts.
- Store normalized messages in SQLite.
- Add tests using representative Codex JSON events.
---

---
[x] Phase 9: Per-thread queue
Implement queueing scoped to individual Codex threads.

- Add queue service scoped by thread.
- Ensure same-thread queue items execute strictly in order.
- Ensure at most one active queue item per thread.
- Do not implement app-server-wide scheduler.
- Do not limit different thread concurrency in AgentMesh.
- Implement `send_message`, `approval_response`, `read_thread`, and `sync_thread_list` queue item kinds as needed.
- Persist queue item status transitions.
- Emit `queue.item_updated` SSE events.
- Fail sends immediately if app-server is offline.
- Keep failed queue items visible.
- Add tests for same-thread ordering and no global serialization.
---

---
[x] Phase 10: Text message sending
Implement text sends to existing Codex threads.

- Implement `POST /api/messages/send` for text-only sends.
- Validate app-server online status.
- Validate target thread exists and is current.
- Reject sends to gone threads.
- Write user message with pending or queued status before sending.
- Create `turns` row for the send.
- Call Codex `turn/start` using existing `codex_thread_id`.
- Include `{ "type": "text", "text": "..." }` input.
- Update user message status through sent, streaming, completed, or failed.
- Store Codex responses and notifications.
- Emit message and turn SSE events.
- Preserve composer draft on send failure.
---

---
[x] Phase 11: Raw Codex event capture
Persist realtime Codex JSON observed by AgentMesh.

- Store every realtime Codex response/notification in `codex_events`.
- Link events to app-server, thread, and turn where identifiable.
- Keep raw JSON text.
- Normalize events into UI messages.
- Implement raw event query API for the debug drawer.
- Ensure imported `thread/read` snapshots are not inserted into `codex_events`.
- Add tests for event capture and normalization linkage.
---

---
[x] Phase 12: Approval handling
Implement web-driven Codex approval handling.

- Detect Codex approval request notifications.
- Create pending `approvals` rows.
- Create or update approval message parts.
- Emit `approval.created` SSE event.
- Implement `GET /api/approvals`.
- Implement `POST /api/approvals/:id/respond`.
- Support approve and deny.
- Send approval response over the original app-server JSON-RPC connection.
- Update approval status and response JSON.
- Emit `approval.updated` SSE event.
- Leave approval pending when no frontend is connected.
- Mark approval failed or expired if app-server exits.
---

---
[x] Phase 13: Image upload and send
Implement image attachments for user messages.

- Implement `POST /api/uploads/images`.
- Limit one message to at most 5 images.
- Validate image MIME type and file size.
- Store upload files under backend data directory.
- Store image metadata in `attachments`.
- Copy local images to `<workspace>/.agentmesh/images`.
- Create `.agentmesh/images` if missing.
- Copy remote images through SSH/SFTP/SCP/rsync or equivalent.
- Send images to Codex using `localImage` inputs.
- Keep images separate from Markdown text.
- Mark message failed if image copy fails.
- Add tests for the 5-image limit, invalid MIME, local copy, and copy failure.
---

---
[x] Phase 14: SSE realtime
Implement SSE as the only browser realtime transport.

- Implement `GET /api/events`.
- Maintain one global SSE stream per browser tab.
- Broadcast app-server status, thread list, thread import, message, turn, approval, queue, skill sync, and error events.
- Do not implement SSE event replay.
- On reconnect, frontend reloads current state from REST APIs.
- Add backend tests for SSE event formatting.
---

---
[x] Phase 15: Skill listing and sync
Implement simple stateless skill management.

- Add backend `skills_root` config.
- Implement `GET /api/skills`.
- Scan immediate child directories under `skills_root`.
- Treat child directories with `SKILL.md` as skills.
- Parse `name` and `description` from front matter.
- Fallback name to directory name.
- Do not persist skill list to SQLite.
- Do not implement skill versioning.
- Implement `POST /api/skills/sync`.
- Sync selected skills to selected app-servers.
- Delete existing target `.codex/skills/<skill-name>` before copy.
- Copy the full skill directory.
- Support local filesystem copy.
- Support remote SSH file copy.
- Return per-skill/per-app-server results.
- Emit `skill.sync_completed` SSE event.
---

---
[x] Phase 16: MCP server
Implement the minimal MCP server.

- Add MCP server process or backend-integrated MCP endpoint.
- Implement `list_app_servers`.
- Return `app_server_name`, host, workspace, and status.
- Implement `list_threads` by `app_server_name`.
- Return `thread_name`, `thread_id`, status, and updated time.
- Implement text-only `send_message`.
- Accept `app_server_name`, `thread_name`, and text.
- Resolve app-server name to internal app-server id.
- Resolve thread name to Codex thread id.
- Return `app_server_not_found`, `app_server_offline`, `thread_not_found`, or `ambiguous_thread_name` when appropriate.
- Route MCP sends through the same queue, SQLite, and normalization pipeline as web sends.
- Add MCP tool tests.
---

---
[x] Phase 17: Frontend foundation
Scaffold the Vue frontend.

- Add Vue 3 + Vite + TypeScript.
- Add Element Plus.
- Add Pinia.
- Add Vue Router.
- Add API client.
- Add SSE client with reconnect handling.
- Add app-server, thread, message, approval, and UI layout stores.
- Add global error notification handling.
- Add base layout and navigation.
---

---
[x] Phase 18: App-server UI
Build app-server configuration and lifecycle UI.

- Build app-server list page.
- Build create/edit app-server form.
- Support local and SSH configuration.
- Show generated app-server name.
- Allow editing app-server name.
- Show duplicate-name validation errors.
- Add Start, Stop, and Restart buttons.
- Show online/offline/starting/error status.
- Show last error.
- Refresh thread list after start.
---

---
[x] Phase 19: Board and split-pane UI
Build the multi-Board split-pane interface.

- Implement top-level split-pane tree for Boards.
- Represent one app-server as one Board.
- Support opening multiple Boards.
- Default new Board split to the right.
- Support split down action.
- Persist Board layout tree to SQLite through REST.
- Implement Board header.
- Implement Board thread sidebar.
- Show only current threads in the sidebar.
- Mark opened missing thread panels as gone.
- Implement per-Board thread split-pane tree.
- Default new thread panel split to the right.
- Persist per-Board thread layout tree.
- Restore layouts on page load.
---

---
[x] Phase 20: Thread panel UI
Build the Codex thread chat panel.

- Load/import thread on first open.
- Render messages from backend API.
- Add virtual scrolling for message list.
- Lazy-load image thumbnails.
- Render Markdown safely.
- Render user, assistant, image, error, and turn status parts.
- Render tool call/result, diff, and event parts as collapsed cards.
- Render raw JSON debug drawer.
- Disable send for gone threads.
- Disable send for offline app-servers.
---

---
[x] Phase 21: Composer UI
Build the Markdown composer.

- Add CodeMirror Markdown source editor.
- Add optional Markdown preview.
- Persist draft to backend.
- Restore draft on thread panel open.
- Add resizable composer height.
- Add image attachment picker.
- Show attachments below editor.
- Support removing selected attachments.
- Enforce 5-image UI limit.
- Send Markdown text plus attachments through REST.
- Preserve draft on failed send.
- Clear draft and attachments on successful queued/sent response.
---

---
[x] Phase 22: Drag/drop text copy UI
Implement simple text-copy drag/drop between thread composers.

- Make message text draggable.
- Drag only Markdown/plain text content.
- Exclude images from drag payload.
- Exclude source metadata from drag payload.
- Allow drop onto another thread composer.
- Append dropped text to the existing draft with a blank line separator.
- Do not auto-send after drop.
- Add visual drop target feedback.
- Add tests for append behavior.
---

---
[x] Phase 23: Approval UI
Render and resolve approval requests.

- Render pending approval cards.
- Show approval kind and important payload details.
- Provide Approve action.
- Provide Deny action.
- Disable actions after approval resolves.
- Show failed or expired approval state.
- Update approval cards from SSE.
- Ensure approvals remain visible when the page opens after a request was created.
---

---
[x] Phase 24: Skill management UI
Build the frontend for skill listing and sync.

- Build skill list page or panel.
- Call `GET /api/skills`.
- Show skill name and description.
- Allow selecting multiple skills.
- Allow selecting multiple app-servers.
- Trigger `POST /api/skills/sync`.
- Show per-target sync result.
- Show sync errors.
- Refresh list on demand.
---

---
[x] Phase 25: Frontend reconnect and state reload
Reload state after SSE reconnect.

- Reload app-server list.
- Reload open Board thread lists.
- Reload open thread messages.
- Reload pending approvals.
- Reload queue status for open threads.
- Avoid duplicate messages after reload.
- Keep local drafts during reload.
---

---
[x] Phase 26: Security and filesystem safety
Add safety checks around filesystem and process operations.

- Validate workspace paths.
- Reject path traversal in skill names.
- Reject path traversal in uploaded filenames.
- Restrict skill sync to configured `skills_root`.
- Ensure skill sync copies only selected child directories.
- Ensure images write only under backend data dir and target `.agentmesh/images`.
- Ensure SQLite path is backend-owned.
- Avoid logging secrets from SSH config or environment.
- Require explicit app-server configuration before launching remote commands.
- Add tests for unsafe path rejection.
---

---
[x] Phase 27: Integration and smoke tests
Add deterministic and optional real integration checks.

- Add fake Codex app-server fixture.
- Test local process start and initialize.
- Test `thread/list` sync.
- Test `thread/read` import.
- Test text `turn/start`.
- Test image `localImage` turn input.
- Test approval request/response.
- Test raw event persistence.
- Test SSE notifications.
- Test MCP list and send tools.
- Add optional real local `codex app-server` smoke test.
- Add optional SSH smoke test guarded by environment variables.
---

---
[x] Phase 28: Documentation
Document the new AgentMesh system.

- Document architecture.
- Document local development setup.
- Document backend environment variables.
- Document app-server configuration.
- Document SSH setup.
- Document image storage behavior.
- Document skill root and skill sync behavior.
- Document MCP tools.
- Document SSE reconnect semantics.
- Document explicit non-goals.
---

---
[x] Final acceptance
Verify the complete product against `NEW_SPEC.md`.

- Backend runs with pnpm.
- Frontend runs with pnpm.
- SQLite is created and migrated.
- Local and remote app-servers can be configured and started through stdio.
- App-server does not expose an HTTP port.
- Each app-server renders as one Board.
- Board sidebar shows current `thread/list` threads.
- Gone threads disappear from sidebar while opened panels become read-only.
- Clicking a thread imports history once.
- Messages render from SQLite-backed APIs with virtual scrolling.
- Markdown composer uses source editing and optional preview.
- Sending text writes SQLite and forwards to Codex.
- Sending up to 5 images copies files to `.agentmesh/images` and sends `localImage`.
- Failed sends are visible.
- Realtime Codex events are stored in `codex_events`.
- Historical imports are stored in `thread_imports`.
- Approvals can be approved or denied from the web UI.
- Approvals stay pending when no browser is open.
- Drag/drop copies only text into another composer and does not auto-send.
- Skill list scans backend `skills_root`.
- Skill sync overwrites target `.codex/skills/<skill-name>`.
- MCP lists app-servers and threads, then sends text by `app_server_name + thread_name`.
- MCP sends use the same backend queue and SQLite pipeline as web sends.
- SSE uses one global browser connection and does not replay missed events.
- Frontend reloads state after SSE reconnect.
- No Linear behavior remains.
- No task scheduler behavior is introduced.
---
