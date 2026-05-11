# AgentMesh Architecture and Operations

AgentMesh is a trusted local control plane for Codex app-server processes. It observes and forwards
messages to existing Codex threads; Codex app-server remains the source of truth for thread
lifecycle and execution.

## Architecture

The monorepo uses pnpm and TypeScript:

- `apps/backend`: Fastify API, SQLite persistence, app-server process management, SSE, uploads,
  skill sync, and MCP.
- `apps/frontend`: Vue 3, Vite, Pinia, Vue Router, Element Plus, split-pane board UI, Markdown
  composer, approvals, skills, and settings screens.
- `packages/shared`: shared TypeScript DTOs and event contracts.

Each configured app-server maps to one frontend Board. AgentMesh stores app-server configuration,
current thread metadata, imported thread snapshots, turns, messages, approvals, queue items, raw
Codex events, attachments metadata, and minimal UI state in backend-owned SQLite. Image binaries are
stored on disk, not in SQLite.

AgentMesh talks to Codex app-server through stdio JSON-RPC:

- Local app-server: backend starts the configured command in the workspace and uses child-process
  stdin/stdout.
- SSH app-server: backend runs `ssh [user@]host "cd <workspace> && exec <command>"` and uses that
  SSH command's stdin/stdout.

App-server identity is `host + workspace`. The public name is globally unique, defaults to the
workspace basename plus an incrementing suffix such as `symphony_1`, and is used by MCP routing.

Thread lists come from Codex `thread/list`. Opening a thread imports history with `thread/read` or
the compatible Codex API, then future messages and events are recorded as they pass through
AgentMesh. If a previously visible thread disappears from `thread/list`, open panels remain visible
as read-only `gone` history and cannot receive new messages.

Per-thread queues preserve send order for a single thread. They do not schedule app-server-wide
work, limit Codex concurrency, or coordinate work across threads.

## Local Development Setup

Install dependencies from the repository root:

```sh
pnpm install
```

Run both apps:

```sh
pnpm dev
```

Run individual apps:

```sh
pnpm backend
pnpm frontend
```

The backend binds to `127.0.0.1` on `AGENTMESH_PORT` or `3939` by default. The frontend runs through
Vite. Configure at least one app-server in the UI before starting Codex.

For local app-servers, the default launch command is:

```sh
codex app-server
```

The command runs with `cwd = workspace`, uses stdio JSON-RPC, and does not expose the Codex
app-server over HTTP.

## Backend Environment Variables

All paths may be absolute or relative to the repository root unless noted.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTMESH_PORT` | `3939` | Backend HTTP port on `127.0.0.1`. |
| `AGENTMESH_DATA_DIR` | `data` | Backend-owned data directory. |
| `AGENTMESH_SQLITE_PATH` | `$AGENTMESH_DATA_DIR/agentmesh.sqlite` | SQLite database path. Must stay under the data directory. |
| `AGENTMESH_UPLOAD_DIR` | `$AGENTMESH_DATA_DIR/uploads` | Upload cache path. Must stay under the data directory. |
| `AGENTMESH_SKILLS_ROOT` | `apps/myskills` | Local source directory scanned for skills. |

SQLite and upload directories are created on backend startup. SQLite must not be stored inside a
Codex workspace.

Example:

```sh
AGENTMESH_PORT=3939 \
AGENTMESH_DATA_DIR=.agentmesh-data \
AGENTMESH_SKILLS_ROOT=apps/myskills \
pnpm backend
```

## App-Server Configuration

An app-server record contains:

- `name`: globally unique public name, containing only letters, numbers, dots, underscores, or
  hyphens.
- `hostKind`: `local` or `ssh`.
- `host`: `localhost` for local app-servers, or the SSH host for remote app-servers.
- `sshUser` and `sshPort`: optional for SSH app-servers.
- `workspace`: absolute project directory where Codex works.
- `command`: launch command, defaulting to `codex app-server`.

Lifecycle controls are Start, Stop, and Restart. On backend restart, saved app-server configuration
remains in SQLite, but in-memory process handles are gone and all app-servers are marked offline.
Users start them again manually.

AgentMesh does not expose Codex app-server HTTP ports. The backend owns all frontend actions through
REST and app-server communication through stdio JSON-RPC.

## SSH Setup

SSH app-servers require non-interactive SSH from the backend machine to the target host. Configure
keys and host trust before starting the app-server.

Expected manual checks:

```sh
ssh user@host 'cd /absolute/workspace && codex app-server --help'
scp -r /path/to/test-skill user@host:/absolute/workspace/.codex/skills/test-skill
```

For SSH launch, AgentMesh runs:

```text
ssh [-p port] [user@]host "cd <workspace> && exec <command>"
```

Remote skill sync uses SSH file copy and overwrites
`<workspace>/.codex/skills/<skill-name>`. Remote image transfer is specified as SSH/SFTP/SCP/rsync
or equivalent and must create `<workspace>/.agentmesh/images` before sending images as
`localImage` paths.

## Image Storage Behavior

The web composer supports up to five image attachments per user message. Images are separate
message parts, not Markdown `![](...)` links.

Supported MIME types are PNG, JPEG, WebP, and GIF. The backend validates MIME type, size, and safe
filenames.

Storage model:

- Upload cache: `$AGENTMESH_UPLOAD_DIR/images/<attachment-id>.<ext>`.
- SQLite: attachment metadata only.
- Target workspace copy: `<workspace>/.agentmesh/images/<attachment-id>.<ext>`.

Sending to Codex should use text first, followed by `localImage` items:

```json
[
  { "type": "text", "text": "markdown text" },
  { "type": "localImage", "path": "/absolute/workspace/.agentmesh/images/img1.png" }
]
```

If any image copy fails, the send fails and the message or queue item must show failure instead of
disappearing.

## Skill Root and Skill Sync

The backend scans one local `skills_root`, defaulting to `apps/myskills` and optionally configured
by `AGENTMESH_SKILLS_ROOT`. The first version does not keep a persistent skill catalog, version
table, or checksum state.

Skill directory format:

```text
<skills_root>/
  skill-a/
    SKILL.md
  skill-b/
    SKILL.md
```

`GET /api/skills` scans immediate child directories on each request. A child directory containing
`SKILL.md` is a skill. Front matter `name` and `description` are used when present; otherwise the
directory name and an empty description are used.

Sync copies selected skills to selected app-servers:

```text
<workspace>/.codex/skills/<skill-name>/
```

If the target skill directory already exists, AgentMesh deletes it first so the result matches the
current backend skill directory content. Skill names must be safe path segments.

## MCP Tools

AgentMesh exposes a Streamable HTTP MCP endpoint at:

```text
/mcp
```

The MCP server is intentionally small:

- `list_app_servers()`: returns app-server names, hosts, workspaces, and status.
- `list_threads({ app_server_name })`: returns current thread names and IDs for one app-server.
- `send_message({ app_server_name, thread_name, text })`: queues a text-only message to an existing
  thread.

MCP routing uses `app_server_name + thread_name`. If the app-server is missing, offline, the thread
is missing, or the thread name is ambiguous under that app-server, the tool returns an explicit
error. MCP sends must use the same SQLite, per-thread queue, and message-normalization pipeline as
web sends.

MCP does not manage app-server lifecycle, create threads, send images, or control layout.

## SSE Reconnect Semantics

The browser uses one global SSE connection:

```text
GET /api/events
```

SSE event types include app-server status changes, thread list changes, imports, gone threads,
message updates, turn status changes, approvals, queue updates, skill sync completion, and errors.

SSE is notification-only. No event replay is required. SQLite is the source of truth. After
reconnect, the frontend reloads the app-server list, open Board thread lists, open thread messages,
approvals, and queue status.

The frontend reconnects with backoff. A reconnect must not assume missed SSE events can be replayed.

## Explicit Non-Goals

AgentMesh is not the old Linear/task/orchestrator model. It must not:

- integrate with Linear;
- create issues or tasks;
- create, delete, schedule, or otherwise manage Codex threads in the first version;
- control how many threads an app-server owns;
- control app-server turn concurrency;
- expose Codex app-server HTTP ports;
- use Markdown files as the data source;
- use WebSocket for realtime updates;
- store SQLite databases inside Codex workspaces;
- treat drag/drop as workflow automation.

Drag/drop only copies plain Markdown text into another composer. It does not include images,
metadata, forwarding records, or automatic sending.
