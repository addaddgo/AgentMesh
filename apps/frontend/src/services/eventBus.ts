import type { SseEvent, SseEventType } from "@agentmesh/shared";

type EventHandler = (event: SseEvent) => Promise<void>;
type Unsubscribe = () => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  public on(type: SseEventType | readonly SseEventType[], handler: EventHandler): Unsubscribe {
    const types = Array.isArray(type) ? type : [type];
    const unsubs = types.map((t) => this.subscribeOne(t, handler));
    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  public off(type: SseEventType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  public async emit(event: SseEvent): Promise<void> {
    const matched = this.handlers.get(event.type);
    if (matched === undefined) {
      return;
    }

    const promises: Promise<void>[] = [];
    for (const handler of matched) {
      promises.push(
        handler(event).catch((error: unknown) => {
          console.error(`[EventBus] handler failed for ${event.type}:`, error);
        })
      );
    }
    await Promise.all(promises);
  }

  private subscribeOne(type: SseEventType, handler: EventHandler): Unsubscribe {
    const existing = this.handlers.get(type) ?? new Set();
    existing.add(handler);
    this.handlers.set(type, existing);
    return () => {
      existing.delete(handler);
      if (existing.size === 0) {
        this.handlers.delete(type);
      }
    };
  }
}

export const eventBus = new EventBus();
