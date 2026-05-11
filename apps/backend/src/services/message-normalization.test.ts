import { describe, expect, it } from "vitest";

import { createTestBackend } from "../test-helpers.js";
import { MessageStorageService } from "./message-storage.js";
import { normalizeCodexEventMessage } from "./message-normalization.js";

describe("Codex message normalization", () => {
  it("normalizes representative Codex JSON event parts", () => {
    const cases = [
      {
        raw: {
          jsonrpc: "2.0",
          method: "thread/event",
          params: { event: { type: "agent_message", message: "Hello" } }
        },
        part: { type: "markdown", text: "Hello" }
      },
      {
        raw: { type: "image", image_url: "file:///tmp/capture.png" },
        part: { type: "image", url: "file:///tmp/capture.png" }
      },
      {
        raw: { type: "tool_call", name: "shell", call_id: "call-1", input: { cmd: "pwd" } },
        part: { type: "tool_call", toolName: "shell", callId: "call-1", input: { cmd: "pwd" } }
      },
      {
        raw: { type: "tool_result", call_id: "call-1", output: "ok" },
        part: { type: "tool_result", callId: "call-1", output: "ok" }
      },
      {
        raw: { type: "diff", diff: "+changed" },
        part: { type: "diff", text: "+changed" }
      },
      {
        raw: {
          type: "approval_request",
          id: "approval-1",
          kind: "exec",
          payload: { cmd: "rm -rf build" }
        },
        part: { type: "approval", approvalId: "approval-1", kind: "exec", status: "pending" }
      },
      {
        raw: { type: "error", message: "boom" },
        part: { type: "error", message: "boom" }
      }
    ];

    for (const { raw, part } of cases) {
      expect(normalizeCodexEventMessage(raw).parts[0]).toMatchObject(part);
    }
  });

  it("preserves unsupported event content as collapsed event parts", () => {
    expect(normalizeCodexEventMessage({ type: "turn_status", phase: "thinking" })).toMatchObject({
      eventType: "turn_status",
      parts: [
        { type: "event", eventType: "turn_status", raw: { type: "turn_status", phase: "thinking" } }
      ]
    });
  });

  it("stores raw Codex events and normalized messages in SQLite", async () => {
    const backend = await createTestBackend();

    try {
      backend.app.database.sqlite
        .prepare(
          `
            INSERT INTO app_servers (
              id,
              name,
              host_kind,
              host,
              workspace,
              command,
              status,
              created_at,
              updated_at
            ) VALUES ('server-1', 'symphony_1', 'local', 'localhost', '/workspace', 'codex app-server', 'online', 1, 1)
          `
        )
        .run();
      backend.app.database.sqlite
        .prepare(
          `
            INSERT INTO threads (
              id,
              app_server_id,
              codex_thread_id,
              thread_name,
              is_current,
              is_gone,
              raw_metadata_json,
              created_at,
              updated_at
            ) VALUES ('thread-1', 'server-1', 'codex-thread-1', 'main', 1, 0, '{}', 1, 1)
          `
        )
        .run();

      const storage = new MessageStorageService(backend.app.database);
      const message = storage.storeCodexEventMessage({
        appServerId: "server-1",
        threadId: "thread-1",
        raw: {
          jsonrpc: "2.0",
          method: "thread/event",
          params: {
            event: {
              type: "tool_call",
              name: "shell",
              call_id: "call-1",
              input: { cmd: "pwd" },
              created_at: 1_000
            }
          }
        }
      });

      expect(message).toMatchObject({
        appServerId: "server-1",
        threadId: "thread-1",
        role: "tool",
        parts: [{ type: "tool_call", toolName: "shell", callId: "call-1" }],
        rawEventIds: [expect.any(String)]
      });
      expect(storage.listMessages("thread-1")).toEqual([message]);
      expect(
        backend.app.database.sqlite.prepare("SELECT event_type FROM codex_events").all()
      ).toEqual([{ event_type: "tool_call" }]);
    } finally {
      await backend.cleanup();
    }
  });
});
