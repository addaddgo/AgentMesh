import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexSshCommand,
  CodexJsonRpcRemoteError,
  CodexJsonRpcTimeoutError,
  CodexJsonRpcTransport,
  type JsonValue
} from "./codex-json-rpc.js";

describe("CodexJsonRpcTransport", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.useRealTimers();
  });

  it("writes JSON-RPC requests to stdin and routes line-delimited responses by id", async () => {
    const fake = createFakeStdioProcess((request) => {
      fake.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echoed: request.params } })}\n`
      );
    });
    const transport = new CodexJsonRpcTransport(fake);

    const result = await transport.request("thread/list", { cursor: null });

    expect(result).toEqual({ echoed: { cursor: null } });
    expect(fake.requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "thread/list",
        params: { cursor: null }
      }
    ]);
  });

  it("accepts Codex responses that omit the jsonrpc version field", async () => {
    const fake = createFakeStdioProcess((request) => {
      fake.stdout.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    });
    const transport = new CodexJsonRpcTransport(fake);

    await expect(transport.request("initialize")).resolves.toEqual({ ok: true });
  });

  it("routes notifications to matching handlers", async () => {
    const fake = createFakeStdioProcess();
    const transport = new CodexJsonRpcTransport(fake);
    const notifications: JsonValue[] = [];

    transport.onNotification("thread/event", (params) => {
      notifications.push(params ?? null);
    });

    fake.stdout.write('{"jsonrpc":"2.0","method":"thread/event","params":{"threadId":"t1"}}\n');
    await waitFor(() => notifications.length === 1);

    expect(notifications).toEqual([{ threadId: "t1" }]);
  });

  it("stores malformed output as protocol errors", async () => {
    const fake = createFakeStdioProcess();
    const transport = new CodexJsonRpcTransport(fake);
    const observed: string[] = [];

    transport.onProtocolError((error) => {
      observed.push(error.raw);
    });

    fake.stdout.write("not json\n");
    fake.stdout.write('{"jsonrpc":"2.0","id":999,"result":true}\n');
    await waitFor(() => transport.protocolErrors.length === 2);

    expect(observed).toEqual(["not json", '{"jsonrpc":"2.0","id":999,"result":true}']);
    expect(transport.protocolErrors[0]).toMatchObject({
      raw: "not json"
    });
    expect(transport.protocolErrors[1]?.message).toContain("unknown JSON-RPC request id");
  });

  it("rejects JSON-RPC error responses", async () => {
    const fake = createFakeStdioProcess((request) => {
      fake.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "Codex failed", data: { retry: false } }
        })}\n`
      );
    });
    const transport = new CodexJsonRpcTransport(fake);

    await expect(transport.request("turn/start")).rejects.toMatchObject({
      name: "CodexJsonRpcRemoteError",
      rpcError: { code: -32_000, message: "Codex failed", data: { retry: false } }
    } satisfies Partial<CodexJsonRpcRemoteError>);
  });

  it("times out pending requests", async () => {
    vi.useFakeTimers();
    const transport = new CodexJsonRpcTransport({
      ...createFakeStdioProcess(),
      requestTimeoutMs: 50
    });
    const request = transport.request("thread/list");
    const expectation = expect(request).rejects.toBeInstanceOf(CodexJsonRpcTimeoutError);

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
  });

  it("gracefully closes stdin and rejects pending requests", async () => {
    const fake = createFakeStdioProcess();
    const transport = new CodexJsonRpcTransport(fake);
    const request = transport.request("thread/list");
    const expectation = expect(request).rejects.toMatchObject({
      name: "CodexJsonRpcClosedError"
    });

    await transport.close();

    await expectation;
    expect(fake.stdin.writableEnded).toBe(true);
  });

  it("runs a local fake Codex stdio process without exposing an HTTP port", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-fake-codex-"));
    tempDirs.push(tempDir);
    const scriptPath = path.join(tempDir, "fake-codex.mjs");
    fs.writeFileSync(
      scriptPath,
      `
        import readline from "node:readline";

        const lines = readline.createInterface({ input: process.stdin });
        process.stdin.resume();
        for await (const line of lines) {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { method: request.method, cwd: process.cwd() }
          }) + "\\n");
        }
      `
    );

    const transport = CodexJsonRpcTransport.local({
      command: `${process.execPath} ${scriptPath}`,
      cwd: tempDir,
      requestTimeoutMs: 1_000
    });

    const result = await transport.request("initialize");
    await transport.close();

    expect(result).toEqual({ method: "initialize", cwd: tempDir });
  });

  it("builds SSH stdio commands without HTTP port arguments", () => {
    expect(
      buildCodexSshCommand({
        host: "remote.example.com",
        user: "codex",
        port: 2222,
        workspace: "/srv/project with spaces",
        command: "codex app-server"
      })
    ).toEqual({
      command: "ssh",
      args: [
        "-p",
        "2222",
        "codex@remote.example.com",
        "cd '/srv/project with spaces' && exec codex app-server"
      ]
    });
  });

  it("injects SSH app-server environment variables without relying on shell profiles", () => {
    expect(
      buildCodexSshCommand({
        host: "remote.example.com",
        workspace: "/srv/project",
        command: "codex app-server",
        env: {
          OPENAI_API_KEY: "sk-test value",
          HTTPS_PROXY: "http://127.0.0.1:7890"
        }
      }).args.at(-1)
    ).toBe(
      "cd '/srv/project' && exec env OPENAI_API_KEY='sk-test value' HTTPS_PROXY='http://127.0.0.1:7890' codex app-server"
    );
  });

  it("rejects incomplete SSH command configuration", () => {
    expect(() =>
      buildCodexSshCommand({
        host: " ",
        workspace: "/srv/project",
        command: "codex app-server"
      })
    ).toThrow("SSH app-server configuration is invalid");

    expect(() =>
      buildCodexSshCommand({
        host: "remote.example.com",
        workspace: "/srv/project",
        command: " "
      })
    ).toThrow("SSH app servers require an explicit launch command");
  });
});

type FakeStdioProcess = {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly requests: JsonValue[];
};

function createFakeStdioProcess(
  onRequest?: (request: Record<string, JsonValue>) => void
): FakeStdioProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: JsonValue[] = [];
  let buffer = "";

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    buffer += chunk;

    for (;;) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const request = JSON.parse(line) as Record<string, JsonValue>;
      requests.push(request);
      onRequest?.(request);
    }
  });

  return { stdin, stdout, requests };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }

  throw new Error("Timed out waiting for condition");
}
