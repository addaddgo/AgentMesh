import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import type { EventService } from "./events.js";
import type { ThreadStatusCache } from "./thread-status-cache.js";
import { MessageSendService } from "./message-send.js";

export type McpWorkspaceThread = {
  readonly app_workspace_name: string;
  readonly thread_name: string;
};

export type McpSendMessageResult =
  | {
      readonly status: "sent";
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly code?:
        | "app_server_not_found"
        | "app_server_offline"
        | "thread_not_found"
        | "ambiguous_thread_name";
    };

type AppServerRow = {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly workspace: string;
  readonly status: string;
};

type ThreadRow = {
  readonly id: string;
  readonly codex_thread_id: string;
  readonly thread_name: string;
  readonly status: string | null;
  readonly updated_at: number;
};

export class AgentMeshMcpService {
  private readonly sends: MessageSendService;

  public constructor(
    private readonly database: DatabaseHandle,
    config: BackendConfig,
    events: EventService,
    appServerLifecycle: AppServerLifecycleRegistry,
    private readonly statusCache: ThreadStatusCache
  ) {
    this.sends = new MessageSendService(database, config, events, appServerLifecycle, statusCache);
  }

  public listWorkspaceThreads(currentWorkspaceName?: string): { readonly threads: McpWorkspaceThread[] } {
    const appServers = this.database.sqlite
      .prepare(
        `
          SELECT id, name, host, workspace, status
          FROM app_servers
          WHERE status = 'online'
          ORDER BY name ASC
        `
      )
      .all() as AppServerRow[];

    const threads: McpWorkspaceThread[] = [];

    for (const appServer of appServers) {
      if (currentWorkspaceName !== undefined && appServer.name === currentWorkspaceName) {
        continue;
      }

      for (const row of this.currentThreadsForAppServer(appServer.id)) {
        const status = this.statusCache.get(row.id) ?? "notLoaded";
        if (status === "notLoaded") {
          continue;
        }

        threads.push({
          app_workspace_name: appServer.name,
          thread_name: row.thread_name
        });
      }
    }

    return { threads };
  }

  public async sendMessage(input: {
    readonly appWorkspaceName: string;
    readonly threadName: string;
    readonly text: string;
  }): Promise<McpSendMessageResult> {
    const appServer = this.findAppServerByName(input.appWorkspaceName);

    if (appServer === undefined) {
      return {
        status: "failed",
        code: "app_server_not_found",
        error: "App workspace not found"
      };
    }

    if (appServer.status !== "online") {
      return {
        status: "failed",
        code: "app_server_offline",
        error: "App workspace is offline"
      };
    }

    const matchingThreads = this.currentThreadsForAppServer(appServer.id).filter((thread) => {
      const status = this.statusCache.get(thread.id) ?? "notLoaded";
      return thread.thread_name === input.threadName && status !== "notLoaded";
    });

    if (matchingThreads.length === 0) {
      return {
        status: "failed",
        code: "thread_not_found",
        error: "Thread not found"
      };
    }

    if (matchingThreads.length > 1) {
      return {
        status: "failed",
        code: "ambiguous_thread_name",
        error: "Thread name is ambiguous"
      };
    }

    const thread = matchingThreads[0];
    if (thread === undefined) {
      return {
        status: "failed",
        code: "thread_not_found",
        error: "Thread not found"
      };
    }

    const response = this.sends.sendText(thread.id, input.text, []);
    return this.waitForSendResult(response.queueItem.id);
  }

  private findAppServerByName(name: string): AppServerRow | undefined {
    return this.database.sqlite
      .prepare(
        `
          SELECT id, name, host, workspace, status
          FROM app_servers
          WHERE name = ?
        `
      )
      .get(name) as AppServerRow | undefined;
  }

  private currentThreadsForAppServer(appServerId: string): ThreadRow[] {
    return this.database.sqlite
      .prepare(
        `
          SELECT id, codex_thread_id, thread_name, status, updated_at
          FROM threads
          WHERE app_server_id = ? AND is_current = 1 AND is_gone = 0
          ORDER BY thread_name ASC, created_at ASC
        `
      )
      .all(appServerId) as ThreadRow[];
  }

  private async waitForSendResult(queueItemId: string): Promise<McpSendMessageResult> {
    const deadline = Date.now() + SEND_POLL_TIMEOUT_MS;

    while (Date.now() <= deadline) {
      const row = this.database.sqlite
        .prepare("SELECT status, error FROM queue_items WHERE id = ?")
        .get(queueItemId) as QueueStatusRow | undefined;

      if (row === undefined) {
        return {
          status: "failed",
          error: "Queue item disappeared before completion"
        };
      }

      if (row.status === "completed") {
        return { status: "sent" };
      }

      if (row.status === "failed") {
        return {
          status: "failed",
          error: row.error ?? "Message send failed"
        };
      }

      if (row.status === "waiting_approval") {
        return {
          status: "failed",
          error: "Message send is waiting for approval"
        };
      }

      await sleep(SEND_POLL_INTERVAL_MS);
    }

    return {
      status: "failed",
      error: "Timed out waiting for message delivery"
    };
  }
}

const SEND_POLL_INTERVAL_MS = 150;
const SEND_POLL_TIMEOUT_MS = 30_000;

type QueueStatusRow = {
  readonly status: string;
  readonly error: string | null;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAgentMeshMcpServer(service: AgentMeshMcpService): McpServer {
  const server = new McpServer({
    name: "agentmesh",
    version: "0.0.0"
  });

  server.registerTool(
    "list_workspace_threads",
    {
      description: "List resumed threads for online AgentMesh workspaces.",
      inputSchema: {
        current_workspace_name: z.string().min(1).optional()
      }
    },
    ({ current_workspace_name }) => toolResult(service.listWorkspaceThreads(current_workspace_name))
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a text-only message to a resumed thread in an online workspace.",
      inputSchema: {
        app_workspace_name: z.string().min(1),
        thread_name: z.string().min(1),
        text: z.string().min(1)
      }
    },
    async ({ app_workspace_name, thread_name, text }) =>
      toolResult(
        await service.sendMessage({
          appWorkspaceName: app_workspace_name,
          threadName: thread_name,
          text
        })
      )
  );

  return server;
}

function toolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}
