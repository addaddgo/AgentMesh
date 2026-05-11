import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { RequestValidationError } from "../errors.js";
import { normalizeWorkspacePath } from "./filesystem-safety.js";

export type JsonRpcId = number | string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRpcRequest<TParams extends JsonValue = JsonValue> = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
};

export type JsonRpcNotification<TParams extends JsonValue = JsonValue> = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
};

export type JsonRpcServerRequest<TParams extends JsonValue = JsonValue> = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
};

export type JsonRpcErrorObject = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

export type JsonRpcSuccessResponse<TResult extends JsonValue = JsonValue> = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: TResult;
};

export type JsonRpcErrorResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
};

export type JsonRpcResponse<TResult extends JsonValue = JsonValue> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export type CodexProtocolErrorRecord = {
  readonly message: string;
  readonly raw: string;
  readonly receivedAt: number;
};

export type CodexProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type CodexJsonRpcTransportOptions = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly closeProcess?: ((signal?: NodeJS.Signals) => void) | undefined;
  readonly onProcessClose?: ((handler: (exit: CodexProcessExit) => void) => void) | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly closeTimeoutMs?: number | undefined;
};

export type CodexLocalTransportOptions = {
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly requestTimeoutMs?: number | undefined;
};

export type CodexSshTransportOptions = {
  readonly host: string;
  readonly workspace: string;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly user?: string | null | undefined;
  readonly port?: number | null | undefined;
  readonly requestTimeoutMs?: number | undefined;
};

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  readonly onResponse?: ResponseObserver | undefined;
};

type NotificationHandler = (
  params: JsonValue | undefined,
  notification: JsonRpcNotification,
  rawLine: string
) => void;

type ServerRequestHandler = (request: JsonRpcServerRequest, rawLine: string) => void;

type ResponseObserver = (response: JsonRpcResponse, rawLine: string, method: string) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export class CodexJsonRpcRemoteError extends Error {
  public constructor(
    public readonly rpcError: JsonRpcErrorObject,
    public readonly response: JsonRpcErrorResponse
  ) {
    super(rpcError.message);
    this.name = "CodexJsonRpcRemoteError";
  }
}

export class CodexJsonRpcTimeoutError extends Error {
  public constructor(method: string, timeoutMs: number) {
    super(`Codex JSON-RPC request '${method}' timed out after ${timeoutMs}ms`);
    this.name = "CodexJsonRpcTimeoutError";
  }
}

export class CodexJsonRpcClosedError extends Error {
  public constructor(message = "Codex JSON-RPC transport is closed") {
    super(message);
    this.name = "CodexJsonRpcClosedError";
  }
}

export class CodexJsonRpcTransport {
  public readonly protocolErrors: CodexProtocolErrorRecord[] = [];

  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly closeProcess: ((signal?: NodeJS.Signals) => void) | undefined;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly anyNotificationHandlers = new Set<NotificationHandler>();
  private readonly anyServerRequestHandlers = new Set<ServerRequestHandler>();
  private readonly protocolErrorHandlers = new Set<(error: CodexProtocolErrorRecord) => void>();
  private readonly processCloseHandlers = new Set<(exit: CodexProcessExit) => void>();
  private readonly processClosed: Promise<void>;
  private nextRequestId = 0;
  private stdoutBuffer = "";
  private isClosed = false;
  private hasProcessClosed = false;

  public constructor(options: CodexJsonRpcTransportOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.closeProcess = options.closeProcess;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

    this.processClosed =
      options.onProcessClose === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            options.onProcessClose?.((exit) => {
              this.hasProcessClosed = true;
              this.rejectAllPending(new CodexJsonRpcClosedError("Codex JSON-RPC process closed"));
              for (const handler of this.processCloseHandlers) {
                handler(exit);
              }
              resolve();
            });
          });

    this.stdout.setEncoding("utf8");
    this.stdout.on("data", this.handleStdoutData);
  }

  public static local(options: CodexLocalTransportOptions): CodexJsonRpcTransport {
    return CodexJsonRpcTransport.fromChildProcess(
      spawnShellCommand(options.command, {
        cwd: options.cwd,
        env: options.env
      }),
      options.requestTimeoutMs
    );
  }

  public static ssh(options: CodexSshTransportOptions): CodexJsonRpcTransport {
    const sshCommand = buildCodexSshCommand(options);

    return CodexJsonRpcTransport.fromChildProcess(
      spawn(sshCommand.command, sshCommand.args, {
        stdio: "pipe"
      }),
      options.requestTimeoutMs
    );
  }

  public static fromChildProcess(
    child: ChildProcessWithoutNullStreams,
    requestTimeoutMs?: number
  ): CodexJsonRpcTransport {
    return new CodexJsonRpcTransport({
      stdin: child.stdin,
      stdout: child.stdout,
      closeProcess: (signal) => {
        child.kill(signal);
      },
      onProcessClose: (handler) => {
        child.once("close", (code, signal) => {
          handler({ code, signal });
        });
      },
      requestTimeoutMs
    });
  }

  public request<TResult extends JsonValue = JsonValue, TParams extends JsonValue = JsonValue>(
    method: string,
    params?: TParams,
    timeoutMs = this.requestTimeoutMs
  ): Promise<TResult> {
    return this.requestInternal(method, params, timeoutMs);
  }

  public requestObserved<
    TResult extends JsonValue = JsonValue,
    TParams extends JsonValue = JsonValue
  >(
    method: string,
    params: TParams | undefined,
    onResponse: ResponseObserver,
    timeoutMs = this.requestTimeoutMs
  ): Promise<TResult> {
    return this.requestInternal(method, params, timeoutMs, onResponse);
  }

  private requestInternal<
    TResult extends JsonValue = JsonValue,
    TParams extends JsonValue = JsonValue
  >(
    method: string,
    params: TParams | undefined,
    timeoutMs: number,
    onResponse?: ResponseObserver
  ): Promise<TResult> {
    if (this.isClosed) {
      return Promise.reject(new CodexJsonRpcClosedError());
    }

    const id = this.generateRequestId();
    const request = buildRequest(id, method, params);
    const line = `${JSON.stringify(request)}\n`;

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexJsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject,
        timeout,
        onResponse
      });

      this.stdin.write(line, "utf8", (error) => {
        if (error !== null && error !== undefined) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  public notify<TParams extends JsonValue = JsonValue>(method: string, params?: TParams): void {
    if (this.isClosed) {
      throw new CodexJsonRpcClosedError();
    }

    const notification = buildNotification(method, params);
    this.stdin.write(`${JSON.stringify(notification)}\n`, "utf8");
  }

  public respond<TResult extends JsonValue = JsonValue>(id: JsonRpcId, result: TResult): void {
    if (this.isClosed) {
      throw new CodexJsonRpcClosedError();
    }

    const response: JsonRpcSuccessResponse<TResult> = {
      jsonrpc: "2.0",
      id,
      result
    };
    this.stdin.write(`${JSON.stringify(response)}\n`, "utf8");
  }

  public onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  public onAnyNotification(handler: NotificationHandler): () => void {
    this.anyNotificationHandlers.add(handler);

    return () => {
      this.anyNotificationHandlers.delete(handler);
    };
  }

  public onAnyServerRequest(handler: ServerRequestHandler): () => void {
    this.anyServerRequestHandlers.add(handler);

    return () => {
      this.anyServerRequestHandlers.delete(handler);
    };
  }

  public onProtocolError(handler: (error: CodexProtocolErrorRecord) => void): () => void {
    this.protocolErrorHandlers.add(handler);

    return () => {
      this.protocolErrorHandlers.delete(handler);
    };
  }

  public onProcessClose(handler: (exit: CodexProcessExit) => void): () => void {
    this.processCloseHandlers.add(handler);

    return () => {
      this.processCloseHandlers.delete(handler);
    };
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.closeProcess?.(signal);
  }

  public async close(): Promise<void> {
    if (this.isClosed) {
      await this.processClosed;
      return;
    }

    this.isClosed = true;
    this.stdout.off("data", this.handleStdoutData);
    this.rejectAllPending(new CodexJsonRpcClosedError());

    await new Promise<void>((resolve) => {
      this.stdin.end(() => {
        resolve();
      });
    });

    await Promise.race([this.processClosed, sleep(this.closeTimeoutMs)]);

    if (!this.hasProcessClosed) {
      this.closeProcess?.("SIGTERM");
      await Promise.race([this.processClosed, sleep(250)]);
    }
  }

  private readonly handleStdoutData = (chunk: string | Buffer): void => {
    this.stdoutBuffer += chunk.toString();

    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (rawLine.trim().length === 0) {
        continue;
      }

      this.handleLine(rawLine);
    }
  };

  private handleLine(rawLine: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      this.storeProtocolError(
        `Malformed JSON from Codex app-server: ${error instanceof Error ? error.message : "parse failed"}`,
        rawLine
      );
      return;
    }

    if (!isRecord(parsed) || (parsed.jsonrpc !== undefined && parsed.jsonrpc !== "2.0")) {
      this.storeProtocolError("Invalid JSON-RPC message from Codex app-server", rawLine);
      return;
    }

    if (isJsonRpcResponse(parsed)) {
      this.routeResponse(parsed, rawLine);
      return;
    }

    if (isJsonRpcServerRequest(parsed)) {
      this.routeServerRequest(parsed, rawLine);
      return;
    }

    if (isJsonRpcNotification(parsed)) {
      this.routeNotification(parsed, rawLine);
      return;
    }

    this.storeProtocolError("Unsupported JSON-RPC message from Codex app-server", rawLine);
  }

  private routeResponse(response: JsonRpcResponse, rawLine: string): void {
    const pending = this.pending.get(response.id);

    if (pending === undefined) {
      this.storeProtocolError(
        `Response for unknown JSON-RPC request id '${String(response.id)}'`,
        rawLine
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    pending.onResponse?.(response, rawLine, pending.method);

    if ("error" in response) {
      pending.reject(new CodexJsonRpcRemoteError(response.error, response));
      return;
    }

    pending.resolve(response.result);
  }

  private routeNotification(notification: JsonRpcNotification, rawLine: string): void {
    for (const handler of this.anyNotificationHandlers) {
      handler(notification.params, notification, rawLine);
    }

    const handlers = this.notificationHandlers.get(notification.method);

    if (handlers === undefined) {
      return;
    }

    for (const handler of handlers) {
      handler(notification.params, notification, rawLine);
    }
  }

  private routeServerRequest(request: JsonRpcServerRequest, rawLine: string): void {
    for (const handler of this.anyServerRequestHandlers) {
      handler(request, rawLine);
    }
  }

  private storeProtocolError(message: string, raw: string): void {
    const error = {
      message,
      raw,
      receivedAt: Date.now()
    };

    this.protocolErrors.push(error);

    for (const handler of this.protocolErrorHandlers) {
      handler(error);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private generateRequestId(): JsonRpcId {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }
}

function spawnShellCommand(
  command: string,
  options: Pick<SpawnOptionsWithoutStdio, "cwd" | "env">
): ChildProcessWithoutNullStreams {
  return spawn(command, {
    ...options,
    shell: true,
    stdio: "pipe"
  });
}

export function buildCodexSshCommand(options: CodexSshTransportOptions): {
  readonly command: "ssh";
  readonly args: readonly string[];
} {
  const host = validateSshField(options.host, "host");
  const user =
    options.user === undefined || options.user === null || options.user.length === 0
      ? undefined
      : validateSshField(options.user, "sshUser");
  const workspace = normalizeWorkspacePath(options.workspace);
  const command = options.command.trim();

  if (command.length === 0 || command.includes("\0") || command.includes("\n")) {
    throw new RequestValidationError("SSH app servers require an explicit launch command", [
      { path: ["command"], message: "Command is required" }
    ]);
  }

  const target = user === undefined ? host : `${user}@${host}`;

  return {
    command: "ssh",
    args: [
      ...(options.port === undefined || options.port === null ? [] : ["-p", String(options.port)]),
      target,
      `cd ${shellQuote(workspace)} && exec ${buildEnvPrefix(options.env)}${command}`
    ]
  };
}

function buildEnvPrefix(env: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) {
    return "";
  }

  return `env ${entries
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} `;
}

function validateSshField(value: string, pathName: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.includes("\0") || trimmed.includes("\n")) {
    throw new RequestValidationError("SSH app-server configuration is invalid", [
      { path: [pathName], message: `${pathName} is required` }
    ]);
  }

  return trimmed;
}

function buildRequest<TParams extends JsonValue>(
  id: JsonRpcId,
  method: string,
  params: TParams | undefined
): JsonRpcRequest<TParams> {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

function buildNotification<TParams extends JsonValue>(
  method: string,
  params: TParams | undefined
): JsonRpcNotification<TParams> {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string" &&
    (value.data === undefined || isJsonValue(value.data))
  );
}

function isJsonRpcResponse(value: Record<string, unknown>): value is JsonRpcResponse {
  if (!isJsonRpcId(value.id)) {
    return false;
  }

  if ("result" in value) {
    return isJsonValue(value.result);
  }

  return isJsonRpcErrorObject(value.error);
}

function isJsonRpcServerRequest(value: Record<string, unknown>): value is JsonRpcServerRequest {
  return (
    isJsonRpcId(value.id) &&
    typeof value.method === "string" &&
    (value.params === undefined || isJsonValue(value.params))
  );
}

function isJsonRpcNotification(value: Record<string, unknown>): value is JsonRpcNotification {
  return (
    !("id" in value) &&
    typeof value.method === "string" &&
    (value.params === undefined || isJsonValue(value.params))
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
