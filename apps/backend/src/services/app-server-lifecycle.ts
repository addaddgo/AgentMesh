import { randomUUID } from "node:crypto";

import type { AppServerDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { OfflineError, ProtocolError, RequestValidationError, SshError } from "../errors.js";
import { AppServerService } from "./app-servers.js";
import { ApprovalService } from "./approvals.js";
import { CodexJsonRpcTransport, type CodexProcessExit, type JsonValue } from "./codex-json-rpc.js";
import type { EventService } from "./events.js";
import { ThreadSyncService } from "./thread-sync.js";

type RegistryEntry = {
  readonly appServerId: string;
  readonly transport: CodexJsonRpcTransport;
  expectedStop: boolean;
  exitHandled: boolean;
};

export class AppServerLifecycleRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly appServers: AppServerService;
  private readonly threadSync: ThreadSyncService;
  private readonly approvals: ApprovalService;

  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService
  ) {
    this.appServers = new AppServerService(database);
    this.threadSync = new ThreadSyncService(database, events);
    this.approvals = new ApprovalService(database, events);
  }

  public async start(id: string): Promise<AppServerDto> {
    if (this.entries.has(id)) {
      throw new RequestValidationError("App server is already running");
    }

    const appServer = this.appServers.get(id);
    const startedAt = Date.now();
    this.publishStatus(
      this.appServers.setStatus(id, "starting", {
        lastStartedAt: startedAt,
        lastError: null
      })
    );

    const transport =
      appServer.hostKind === "local"
        ? CodexJsonRpcTransport.local({
            command: appServer.command,
            cwd: appServer.workspace
          })
        : CodexJsonRpcTransport.ssh({
            host: appServer.host,
            user: appServer.sshUser,
            port: appServer.sshPort,
            workspace: appServer.workspace,
            command: appServer.command
          });

    const entry: RegistryEntry = {
      appServerId: id,
      transport,
      expectedStop: false,
      exitHandled: false
    };

    this.entries.set(id, entry);
    transport.onProcessClose((exit) => {
      this.handleProcessExit(entry, exit);
    });
    transport.onAnyServerRequest((request, rawLine) => {
      try {
        this.approvals.handleServerRequest(id, request, rawLine);
      } catch (error) {
        this.recordApprovalHandlingError(id, error);
      }
    });
    transport.onAnyNotification((_params, notification, rawLine) => {
      try {
        this.approvals.handleNotification(id, notification, rawLine);
      } catch (error) {
        this.recordApprovalHandlingError(id, error);
      }
    });

    try {
      await transport.request("initialize", {
        clientInfo: {
          name: "AgentMesh",
          version: "0.0.0"
        },
        capabilities: {}
      });
    } catch (error) {
      const message = errorMessage(error);
      this.publishStatus(this.appServers.setStatus(id, "error", { lastError: message }));
      entry.expectedStop = true;
      transport.kill("SIGTERM");
      void transport.close();
      this.entries.delete(id);

      if (appServer.hostKind === "ssh") {
        throw new SshError(message);
      }

      throw new ProtocolError(message);
    }

    const online = this.appServers.setStatus(id, "online", {
      lastSeenAt: Date.now(),
      lastError: null
    });
    this.publishStatus(online);
    const syncResult = await this.threadSync.sync(id, transport);
    if (syncResult.threads.length === 0) {
      await this.threadSync.createThread(id, transport, "main");
    }
    return online;
  }

  public async stop(id: string): Promise<AppServerDto> {
    const appServer = this.appServers.get(id);
    const entry = this.entries.get(id);

    if (entry === undefined) {
      if (appServer.status === "offline") {
        return appServer;
      }

      const offline = this.appServers.setStatus(id, "offline", { lastError: null });
      this.publishStatus(offline);
      return offline;
    }

    entry.expectedStop = true;
    this.publishStatus(this.appServers.setStatus(id, "stopping"));
    entry.transport.kill("SIGTERM");
    await entry.transport.close();
    this.entries.delete(id);

    const offline = this.appServers.setStatus(id, "offline", { lastError: null });
    this.publishStatus(offline);
    return offline;
  }

  public async restart(id: string): Promise<AppServerDto> {
    await this.stop(id);
    return this.start(id);
  }

  public getTransport(id: string): CodexJsonRpcTransport {
    const entry = this.entries.get(id);

    if (entry === undefined) {
      throw new OfflineError();
    }

    return entry.transport;
  }

  public async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();

    await Promise.all(
      entries.map(async (entry) => {
        entry.expectedStop = true;
        entry.transport.kill("SIGTERM");
        await entry.transport.close();
      })
    );
  }

  private handleProcessExit(entry: RegistryEntry, exit: CodexProcessExit): void {
    if (entry.exitHandled) {
      return;
    }

    entry.exitHandled = true;
    this.entries.delete(entry.appServerId);
    this.recordProcessExit(entry.appServerId, exit);
    this.approvals.markPendingForAppServerFailed(
      entry.appServerId,
      `Codex app-server exited${formatExit(exit)}`
    );

    const current = this.appServers.get(entry.appServerId);

    if (current.status === "error") {
      return;
    }

    const exitedCleanly = exit.code === 0 && exit.signal === null;
    const status = entry.expectedStop || exitedCleanly ? "offline" : "error";
    const lastError =
      status === "error" ? `Codex app-server exited unexpectedly${formatExit(exit)}` : null;

    this.publishStatus(
      this.appServers.setStatus(entry.appServerId, status, {
        lastError,
        lastSeenAt: Date.now()
      })
    );
  }

  private recordProcessExit(appServerId: string, exit: CodexProcessExit): void {
    this.database.sqlite
      .prepare(
        `
          INSERT INTO codex_events (id, app_server_id, thread_id, turn_id, event_type, raw_json, created_at)
          VALUES (?, ?, NULL, NULL, 'process.exited', ?, ?)
        `
      )
      .run(
        randomUUID(),
        appServerId,
        JSON.stringify({
          code: exit.code,
          signal: exit.signal
        } satisfies JsonValue),
        Date.now()
      );

    this.events.publish({
      type: "app_server.status_changed",
      appServerId,
      payload: {
        processExit: {
          code: exit.code,
          signal: exit.signal
        }
      }
    });
  }

  private recordApprovalHandlingError(appServerId: string, error: unknown): void {
    this.database.sqlite
      .prepare(
        `
          INSERT INTO codex_events (id, app_server_id, thread_id, turn_id, event_type, raw_json, created_at)
          VALUES (?, ?, NULL, NULL, 'approval.error', ?, ?)
        `
      )
      .run(
        randomUUID(),
        appServerId,
        JSON.stringify({
          error: errorMessage(error)
        } satisfies JsonValue),
        Date.now()
      );

    this.events.publish({
      type: "error",
      appServerId,
      payload: {
        message: errorMessage(error)
      }
    });
  }

  private publishStatus(appServer: AppServerDto): void {
    this.events.publish({
      type: "app_server.status_changed",
      appServerId: appServer.id,
      payload: { appServer }
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex app-server operation failed";
}

function formatExit(exit: CodexProcessExit): string {
  const details = [
    exit.code === null ? undefined : `code ${exit.code}`,
    exit.signal === null ? undefined : `signal ${exit.signal}`
  ].filter((value): value is string => value !== undefined);

  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}
