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
      readonly status: "queued";
      readonly message_id: string;
      readonly turn_id: string;
      readonly queue_item_id: string;
    }
  | {
      readonly status: "error";
      readonly error:
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

  public listWorkspaceThreads(): { readonly threads: McpWorkspaceThread[] } {
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

  public sendMessage(input: {
    readonly appWorkspaceName: string;
    readonly threadName: string;
    readonly text: string;
  }): McpSendMessageResult {
    const appServer = this.findAppServerByName(input.appWorkspaceName);

    if (appServer === undefined) {
      return { status: "error", error: "app_server_not_found" };
    }

    if (appServer.status !== "online") {
      return { status: "error", error: "app_server_offline" };
    }

    const matchingThreads = this.currentThreadsForAppServer(appServer.id).filter((thread) => {
      const status = this.statusCache.get(thread.id) ?? "notLoaded";
      return thread.thread_name === input.threadName && status !== "notLoaded";
    });

    if (matchingThreads.length === 0) {
      return { status: "error", error: "thread_not_found" };
    }

    if (matchingThreads.length > 1) {
      return { status: "error", error: "ambiguous_thread_name" };
    }

    const thread = matchingThreads[0];
    if (thread === undefined) {
      return { status: "error", error: "thread_not_found" };
    }

    const response = this.sends.sendText(thread.id, input.text, []);

    return {
      status: "queued",
      message_id: response.message.id,
      turn_id: response.turn.id,
      queue_item_id: response.queueItem.id
    };
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
}

export function createAgentMeshMcpServer(service: AgentMeshMcpService): McpServer {
  const server = new McpServer({
    name: "agentmesh",
    version: "0.0.0"
  });

  server.registerTool(
    "list_workspace_threads",
    {
      description: "List resumed threads for online AgentMesh workspaces."
    },
    () => toolResult(service.listWorkspaceThreads())
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
    ({ app_workspace_name, thread_name, text }) =>
      toolResult(
        service.sendMessage({
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
