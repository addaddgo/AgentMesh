# AgentMesh

AgentMesh is a workspace-oriented UI and backend for operating Codex app-servers. It lets you
configure local or SSH workspaces, open multiple Codex threads side by side on a board, sync
reusable skills into those workspaces, and use lightweight tool panels such as Todo and Scheduled
Messages from one place. Codex still owns thread execution; AgentMesh provides the workspace-level
control surface around it.

## What You Can Do

- Configure and launch Codex app-servers for local or remote workspaces.
- Open multiple Codex threads on a single board and work across them in parallel.
- Send messages, review approvals, inspect queue state, and stop running agents.
- Sync reusable Codex skills into one or more workspaces.
- Use built-in board tools such as Todo, Scheduled Messages, Workspace Stats, and Account Limits.

## Core Concepts

### Workspace (app-server)

A workspace is the top-level unit you operate in AgentMesh. It defines where Codex runs, how the
app-server is launched, and which observation prompt or observation skills are attached to that
environment. In the implementation this maps to an `app-server` record, but users should think of
it as a runnable project workspace rather than just a process entry.

### Board

The board is the main working surface. It combines thread panels and tool panels in one place so
you can keep multiple conversations and supporting utilities visible at the same time. It is meant
for parallel workspace-level work, not as a single-thread chat view.

### Thread

A thread is a mirrored Codex conversation shown inside AgentMesh. Thread lists come from the
workspace app-server, history is imported from Codex, and future messages, approvals, queue items,
and runtime state continue to flow through the board. AgentMesh does not invent a new thread model;
it gives you a control panel around an existing Codex thread.

### Skill

A skill is a reusable Codex capability package that can be synced into one or more workspaces. The
Skills view shows both available source skills and the skill set currently installed in a target
workspace. Skills also surface in composers through `$skill` completion.

### Tool Panels

Tool panels are board-native utilities you can add alongside threads. In AgentMesh, “tool” refers
to these board panels, not to Codex tool protocol calls. Current built-in tool panels are Todo,
Scheduled Messages, Workspace Stats, and Account Limits.

### Approvals and Permissions

Approvals and permissions are related but different. An approval is a runtime request from an agent
to execute a command, change files, or perform another privileged action, and the user can approve
or deny it. Permissions are thread-level run settings such as sandbox mode and approval policy that
affect future turns.

## Built-In Surfaces

### Board

The board is where day-to-day work happens. You can add threads, switch focus between panels, keep
assistant output open while you work elsewhere, and combine threads with tool panels on the same
canvas.

### Settings

Settings is where you create, edit, start, stop, restart, and delete workspaces. It also exposes
observation stack settings such as workspace prompts and active observation skills.

### Skills

The Skills view manages the reusable capability layer. You can browse available skills, inspect the
skills installed in a workspace, sync selected skills into one or more targets, and remove target
skills from a workspace.

### Tool Panels

- `Todo`: a lightweight workspace task panel with categories, deadlines, reminders, and drag-and-drop.
- `Scheduled Messages`: schedule a future user message for a specific workspace and thread.
- `Workspace Stats`: inspect workspace-level usage and counts.
- `Account Limits`: inspect account-level 5h and weekly limits.

## Quick Start

Install dependencies from the repository root:

```sh
pnpm install
```

Run both frontend and backend in development:

```sh
pnpm dev
```

Then:

1. Open the frontend in your browser.
2. Create a workspace in **Settings**.
3. Start the workspace app-server.
4. Open the **Board** and add a thread.
5. Start sending messages or add supporting tool panels.

Useful scripts:

```sh
pnpm backend
pnpm frontend
pnpm typecheck
pnpm test
```

## How It Works at a High Level

- The backend manages persisted state, app-server lifecycle, realtime events, and workspace-facing
  operations.
- Codex app-server remains the source of truth for thread execution and thread history.
- The frontend subscribes to realtime updates and projects backend state into the board UI.
- Skills are synced into workspace-local Codex skill directories so the target workspace can use
  them directly.

## Repository Structure

- `apps/backend`: Fastify backend, SQLite persistence, app-server lifecycle, approvals, skill sync,
  scheduled messages, and realtime events.
- `apps/frontend`: Vue 3 board UI, thread panels, settings, skills, and built-in tool panels.
- `packages/shared`: shared DTOs, event contracts, and cross-app types.
- `docs`: architecture and operations documentation.

## Further Reading

- [docs/agentmesh.md](docs/agentmesh.md): architecture, operations, lifecycle model, storage, and
  protocol details.
