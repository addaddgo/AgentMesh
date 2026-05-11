import { describe, expect, it, vi } from "vitest";

import type { SseEvent } from "@agentmesh/shared";

import { EventService, formatSseComment, formatSseEvent } from "./events.js";

describe("SSE events", () => {
  it("formats named SSE events with id, event type, JSON data, and a blank terminator", () => {
    const event: SseEvent = {
      id: "evt_test",
      type: "thread.message_added",
      app_server_id: "asrv_1",
      thread_id: "thread_1",
      payload: {
        message: "hello\nworld"
      },
      created_at: 123
    };

    expect(formatSseEvent(event)).toBe(
      [
        "id: evt_test",
        "event: thread.message_added",
        'data: {"id":"evt_test","type":"thread.message_added","app_server_id":"asrv_1","thread_id":"thread_1","payload":{"message":"hello\\nworld"},"created_at":123}',
        "",
        ""
      ].join("\n")
    );
  });

  it("formats SSE comments for connection handshakes", () => {
    expect(formatSseComment("connected")).toBe(": connected\n\n");
  });

  it("publishes only future events to subscribers without replay", () => {
    vi.spyOn(Date, "now").mockReturnValue(456);
    const events = new EventService();
    const received: SseEvent[] = [];

    events.publish({
      type: "app_server.status_changed",
      appServerId: "asrv_1",
      payload: { status: "offline" }
    });

    const unsubscribe = events.subscribe((event) => {
      received.push(event);
    });

    const published = events.publish({
      type: "skill.sync_completed",
      appServerId: "asrv_1",
      payload: { synced: 2 }
    });
    unsubscribe();
    events.publish({
      type: "error",
      payload: { message: "ignored after unsubscribe" }
    });

    expect(received).toEqual([published]);
    expect(published).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      type: "skill.sync_completed",
      app_server_id: "asrv_1",
      payload: { synced: 2 },
      created_at: 456
    });
  });
});
