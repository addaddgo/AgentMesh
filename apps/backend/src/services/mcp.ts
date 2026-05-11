import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import type { EventService } from "./events.js";
import { MessageSendService } from "./message-send.js";

export type McpAppServer = {
  readonly app_server_name: string;
  readonly host: string;
  readonly workspace: string;
  readonly status: string;
};

export type McpThread = {
  readonly thread_name: string;
  readonly thread_id: string;
  readonly status: string | null;
  readonly updated_time: string;
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
    appServerLifecycle: AppServerLifecycleRegistry
  ) {
    this.sends = new MessageSendService(database, config, events, appServerLifecycle);
  }

  public listAppServers(): McpAppServer[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT name, host, workspace, status
          FROM app_servers
          ORDER BY name ASC
        `
      )
      .all() as Pick<AppServerRow, "name" | "host" | "workspace" | "status">[];

    return rows.map((row) => ({
      app_server_name: row.name,
      host: row.host,
      workspace: row.workspace,
      status: row.status
    }));
  }

  public listThreads(
    appServerName: string
  ): { readonly threads: McpThread[] } | McpSendMessageResult {
    const appServer = this.findAppServerByName(appServerName);

    if (appServer === undefined) {
      return { status: "error", error: "app_server_not_found" };
    }

    const rows = this.currentThreadsForAppServer(appServer.id);
    return {
      threads: rows.map((row) => ({
        thread_name: row.thread_name,
        thread_id: row.codex_thread_id,
        status: row.status,
        updated_time: new Date(row.updated_at).toISOString()
      }))
    };
  }

  public sendMessage(input: {
    readonly appServerName: string;
    readonly threadName: string;
    readonly text: string;
  }): McpSendMessageResult {
    const appServer = this.findAppServerByName(input.appServerName);

    if (appServer === undefined) {
      return { status: "error", error: "app_server_not_found" };
    }

    if (appServer.status !== "online") {
      return { status: "error", error: "app_server_offline" };
    }

    const matchingThreads = this.currentThreadsForAppServer(appServer.id).filter(
      (thread) => thread.thread_name === input.threadName
    );

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
    "list_app_servers",
    {
      description: "List configured AgentMesh Codex app-servers."
    },
    () => toolResult({ app_servers: service.listAppServers() })
  );

  server.registerTool(
    "list_threads",
    {
      description: "List current Codex threads for an app-server name.",
      inputSchema: {
        app_server_name: z.string().min(1)
      }
    },
    ({ app_server_name }) => toolResult(service.listThreads(app_server_name))
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a text-only message to an existing Codex thread.",
      inputSchema: {
        app_server_name: z.string().min(1),
        thread_name: z.string().min(1),
        text: z.string().min(1)
      }
    },
    ({ app_server_name, thread_name, text }) =>
      toolResult(
        service.sendMessage({
          appServerName: app_server_name,
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
