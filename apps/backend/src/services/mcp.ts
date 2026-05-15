import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ScheduledMessageDto, SendMessageResponse } from "@agentmesh/shared";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import type { AppServerLifecycleRegistry } from "./app-server-lifecycle.js";
import type { EventService } from "./events.js";
import { isScheduledDispatchResponse, MessageDispatchService } from "./message-dispatch.js";
import { ScheduledMessageService } from "./scheduled-messages.js";
import type { ThreadStatusCache } from "./thread-status-cache.js";
import { MessageSendService } from "./message-send.js";

export type McpWorkspaceThread = {
  readonly app_workspace_name: string;
  readonly thread_name: string;
};

export type McpScheduledMessage = {
  readonly id: string;
  readonly app_workspace_name: string;
  readonly thread_name: string;
  readonly text: string;
  readonly run_at: number;
  readonly status: ScheduledMessageDto["status"];
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly last_attempt_at: number | null;
  readonly sent_message_id: string | null;
  readonly sent_turn_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

export type McpSendMessageResult =
  | {
      readonly status: "queued";
      readonly message_id: string;
      readonly turn_id: string;
      readonly queue_item_id: string;
    }
  | {
      readonly status: "scheduled";
      readonly scheduled_message_id: string;
      readonly run_at: number;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly code?:
        | "app_server_not_found"
        | "app_server_offline"
        | "thread_not_found"
        | "ambiguous_thread_name"
        | "scheduled_message_not_found";
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
  readonly app_server_id: string;
  readonly codex_thread_id: string;
  readonly thread_name: string;
  readonly status: string | null;
  readonly updated_at: number;
};

type ResolvedThread =
  | {
      readonly ok: true;
      readonly thread: ThreadRow;
    }
  | {
      readonly ok: false;
      readonly failure: McpSendMessageResult;
    };

export class AgentMeshMcpService {
  private readonly sends: MessageSendService;
  private readonly dispatch: MessageDispatchService;
  private readonly scheduledMessages: ScheduledMessageService;

  public constructor(
    private readonly database: DatabaseHandle,
    config: BackendConfig,
    events: EventService,
    appServerLifecycle: AppServerLifecycleRegistry,
    private readonly statusCache: ThreadStatusCache
  ) {
    this.sends = new MessageSendService(database, config, events, appServerLifecycle, statusCache);
    this.scheduledMessages = new ScheduledMessageService(
      database,
      events,
      this.sends.sendQueuedText.bind(this.sends)
    );
    this.dispatch = new MessageDispatchService(database, this.sends, this.scheduledMessages);
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

  public async sendMessage(input: {
    readonly appWorkspaceName: string;
    readonly threadName: string;
    readonly text: string;
    readonly delaySeconds?: number;
  }): Promise<McpSendMessageResult> {
    const resolved = this.resolveRunnableThread(input.appWorkspaceName, input.threadName);

    if (!resolved.ok) {
      return resolved.failure;
    }

    return toMcpSendMessageResult(
      this.dispatch.dispatch(
        resolved.thread.id,
        input.text,
        [],
        input.delaySeconds ?? 0
      )
    );
  }

  public listScheduledMessages(input: {
    readonly appWorkspaceName: string;
    readonly threadName: string;
  }): { readonly items: readonly McpScheduledMessage[] } | McpSendMessageResult {
    const resolved = this.resolveRunnableThread(input.appWorkspaceName, input.threadName);

    if (!resolved.ok) {
      return resolved.failure;
    }

    const items = this.scheduledMessages
      .list()
      .filter(
        (item) =>
          item.appServerId === resolved.thread.app_server_id && item.threadId === resolved.thread.id
      )
      .map((item) => this.toMcpScheduledMessage(item, input.appWorkspaceName, input.threadName));

    return { items };
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
          SELECT id, app_server_id, codex_thread_id, thread_name, status, updated_at
          FROM threads
          WHERE app_server_id = ? AND is_current = 1 AND is_gone = 0
          ORDER BY thread_name ASC, created_at ASC
        `
      )
      .all(appServerId) as ThreadRow[];
  }

  private resolveRunnableThread(
    appWorkspaceName: string,
    threadName: string
  ): ResolvedThread {
    const appServer = this.findAppServerByName(appWorkspaceName);

    if (appServer === undefined) {
      return {
        ok: false,
        failure: {
          status: "failed",
          code: "app_server_not_found",
          error: "App workspace not found"
        }
      };
    }

    if (appServer.status !== "online") {
      return {
        ok: false,
        failure: {
          status: "failed",
          code: "app_server_offline",
          error: "App workspace is offline"
        }
      };
    }

    const matchingThreads = this.currentThreadsForAppServer(appServer.id).filter((thread) => {
      const status = this.statusCache.get(thread.id) ?? "notLoaded";
      return thread.thread_name === threadName && status !== "notLoaded";
    });

    if (matchingThreads.length === 0) {
      return {
        ok: false,
        failure: {
          status: "failed",
          code: "thread_not_found",
          error: "Thread not found"
        }
      };
    }

    if (matchingThreads.length > 1) {
      return {
        ok: false,
        failure: {
          status: "failed",
          code: "ambiguous_thread_name",
          error: "Thread name is ambiguous"
        }
      };
    }

    return {
      ok: true,
      thread: matchingThreads[0] as ThreadRow
    };
  }

  private toMcpScheduledMessage(
    item: ScheduledMessageDto,
    appWorkspaceName: string,
    threadName: string
  ): McpScheduledMessage {
    return {
      id: item.id,
      app_workspace_name: appWorkspaceName,
      thread_name: threadName,
      text: item.text,
      run_at: item.runAt,
      status: item.status,
      attempt_count: item.attemptCount,
      last_error: item.lastError,
      last_attempt_at: item.lastAttemptAt,
      sent_message_id: item.sentMessageId,
      sent_turn_id: item.sentTurnId,
      created_at: item.createdAt,
      updated_at: item.updatedAt
    };
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
      description: "List resumed threads for online AgentMesh workspaces.",
      inputSchema: {}
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
        text: z.string().min(1),
        delay_seconds: z.number().int().min(0).optional()
      }
    },
    async ({ app_workspace_name, thread_name, text, delay_seconds }) =>
      toolResult(
        await service.sendMessage({
          appWorkspaceName: app_workspace_name,
          threadName: thread_name,
          text,
          ...(delay_seconds === undefined ? {} : { delaySeconds: delay_seconds })
        })
      )
  );

  server.registerTool(
    "list_scheduled_messages",
    {
      description: "List scheduled messages for a resumed thread in an online workspace.",
      inputSchema: {
        app_workspace_name: z.string().min(1),
        thread_name: z.string().min(1)
      }
    },
    ({ app_workspace_name, thread_name }) =>
      toolResult(
        service.listScheduledMessages({
          appWorkspaceName: app_workspace_name,
          threadName: thread_name
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

function toMcpSendMessageResult(response: SendMessageResponse): McpSendMessageResult {
  if (isScheduledDispatchResponse(response)) {
    return {
      status: "scheduled",
      scheduled_message_id: response.item.id,
      run_at: response.item.runAt
    };
  }

  return {
    status: "queued",
    message_id: response.message.id,
    turn_id: response.turn.id,
    queue_item_id: response.queueItem.id
  };
}
