import { randomUUID } from "node:crypto";

import type { SseEvent, SseEventType } from "@agentmesh/shared";

export type PublishEventInput = {
  readonly type: SseEventType;
  readonly appServerId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly payload: unknown;
};

export function formatSseEvent(event: SseEvent): string {
  return [
    `id: ${formatSseFieldValue(event.id)}`,
    `event: ${event.type}`,
    ...formatSseData(JSON.stringify(event)),
    "",
    ""
  ].join("\n");
}

export function formatSseComment(comment: string): string {
  return [...splitSseLines(comment).map((line) => `: ${line}`), "", ""].join("\n");
}

export class EventService {
  private readonly subscribers = new Set<(event: SseEvent) => void>();

  public publish(input: PublishEventInput): SseEvent {
    const event: SseEvent = {
      id: `evt_${randomUUID()}`,
      type: input.type,
      ...(input.appServerId === undefined ? {} : { app_server_id: input.appServerId }),
      ...(input.threadId === undefined ? {} : { thread_id: input.threadId }),
      payload: input.payload,
      created_at: Date.now()
    };

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }

    return event;
  }

  public subscribe(subscriber: (event: SseEvent) => void): () => void {
    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

function formatSseData(data: string): string[] {
  return splitSseLines(data).map((line) => `data: ${line}`);
}

function splitSseLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

function formatSseFieldValue(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}
