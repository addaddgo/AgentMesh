/* global process */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const requestsPath = path.join(process.cwd(), "requests.ndjson");
const lines = readline.createInterface({ input: process.stdin });
let nextTurnNumber = 1;
let pendingApprovalTurnRequestId = null;

for await (const line of lines) {
  const request = JSON.parse(line);
  fs.appendFileSync(requestsPath, `${JSON.stringify(request)}\n`);

  if (request.method === "initialize") {
    write({ jsonrpc: "2.0", id: request.id, result: { ok: true, fixture: "fake-codex" } });
    continue;
  }

  if (request.method === "thread/list") {
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        threads: [
          {
            id: "codex-thread-1",
            name: "Main",
            title: "Main thread",
            status: "idle",
            cwd: process.cwd()
          }
        ]
      }
    });
    continue;
  }

  if (request.method === "thread/read") {
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        turns: [
          {
            id: "imported-turn-1",
            createdAt: 1_700_000_000_000,
            messages: [
              {
                role: "user",
                text: "Imported question",
                createdAt: 1_700_000_000_000
              },
              {
                role: "assistant",
                text: "Imported answer",
                createdAt: 1_700_000_000_001
              }
            ]
          }
        ]
      }
    });
    continue;
  }

  if (request.method === "turn/start") {
    const text = getInputText(request.params?.input);

    if (text.includes("approval")) {
      pendingApprovalTurnRequestId = request.id;
      write({
        jsonrpc: "2.0",
        id: "approval-req-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: request.params.threadId,
          command: "touch approved.txt"
        }
      });
      continue;
    }

    const turnId = `codex-turn-${nextTurnNumber}`;
    nextTurnNumber += 1;
    write({
      jsonrpc: "2.0",
      method: "thread/message",
      params: {
        threadId: request.params.threadId,
        role: "assistant",
        status: "completed",
        text: text.includes("MCP") ? "MCP response" : "Codex response"
      }
    });
    write({
      jsonrpc: "2.0",
      id: request.id,
      result: { turn: { id: turnId }, status: "completed" }
    });
    continue;
  }

  if (request.id === "approval-req-1" && pendingApprovalTurnRequestId !== null) {
    write({
      jsonrpc: "2.0",
      id: pendingApprovalTurnRequestId,
      result: { turn: { id: "codex-turn-approved" }, status: "completed" }
    });
    pendingApprovalTurnRequestId = null;
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function getInputText(input) {
  if (!Array.isArray(input)) {
    return "";
  }

  return input
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => part.text)
    .filter((text) => typeof text === "string")
    .join("\n");
}
