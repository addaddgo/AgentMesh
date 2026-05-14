import type { ChatMessage } from "@agentmesh/shared";
import { describe, expect, it } from "vitest";

import {
  MESSAGE_TEXT_DRAG_MIME,
  appendDroppedText,
  canDropMessageText,
  readMessageTextDrop,
  textForMessageDrag
} from "./messageDragDrop";

describe("message drag/drop text copy", () => {
  it("extracts only Markdown text from messages", () => {
    const message = makeMessage({
      parts: [
        { type: "markdown", text: "first **markdown**" },
        { type: "image", workspacePath: "/workspace/image.png" },
        { type: "diff", text: "diff --git a/secret b/secret" },
        {
          type: "tool_call",
          toolName: "read",
          callId: "call_1",
          input: { path: "source-metadata.json" },
          status: "completed"
        },
        { type: "markdown", text: "second paragraph" }
      ]
    });

    expect(textForMessageDrag(message)).toBe("first **markdown**\n\nsecond paragraph");
  });

  it("accepts only internal text drags without files", () => {
    const validDrop = makeDataTransfer({
      [MESSAGE_TEXT_DRAG_MIME]: "dragged text",
      "text/plain": "dragged text"
    });
    const externalPlainText = makeDataTransfer({ "text/plain": "external text" });
    const fileDrop = makeDataTransfer(
      {
        [MESSAGE_TEXT_DRAG_MIME]: "dragged text"
      },
      1
    );

    expect(canDropMessageText(validDrop)).toBe(true);
    expect(readMessageTextDrop(validDrop)).toBe("dragged text");
    expect(canDropMessageText(externalPlainText)).toBe(false);
    expect(readMessageTextDrop(fileDrop)).toBe("");
  });

  it("appends dropped text after existing drafts with a blank line separator", () => {
    expect(appendDroppedText("", "new text")).toBe("new text");
    expect(appendDroppedText("existing draft", "new text")).toBe("existing draft\n\nnew text");
  });
});

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg_1",
    appServerId: "app_1",
    threadId: "thread_1",
    turnId: null,
    role: "assistant",
    status: "completed",
    parts: [],
    rawEventIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function makeDataTransfer(
  values: Record<string, string>,
  fileCount = 0
): {
  readonly files: { readonly length: number };
  readonly types: readonly string[];
  getData(type: string): string;
} {
  return {
    getData: (type: string) => values[type] ?? "",
    types: Object.keys(values),
    files: { length: fileCount }
  };
}
