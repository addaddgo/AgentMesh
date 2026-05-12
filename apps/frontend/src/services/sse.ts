import { SSE_EVENT_TYPES, type SseEvent } from "@agentmesh/shared";

import { eventBus } from "./eventBus";

type Listener = (event: SseEvent) => void;
type StateListener = (state: SseConnectionState) => void;

export type SseConnectionState = "closed" | "connecting" | "open" | "reconnecting";

const reconnectDelaysMs = [500, 1_000, 2_000, 5_000, 10_000] as const;

export class SseClient {
  private eventSource: EventSource | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private state: SseConnectionState = "closed";
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<StateListener>();

  public constructor(private readonly url = "/api/events") {}

  public connect(): void {
    if (this.eventSource !== null) {
      return;
    }

    this.manuallyClosed = false;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const source = new EventSource(this.url);
    this.eventSource = source;

    source.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("open");
    };

    source.onerror = () => {
      source.close();
      if (this.eventSource === source) {
        this.eventSource = null;
      }

      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };

    // Generic message handler for unnamed events
    source.onmessage = (message) => {
      this.dispatch(message.data);
    };

    // Named event handlers for each known event type
    for (const eventType of SSE_EVENT_TYPES) {
      source.addEventListener(eventType, (message) => {
        this.dispatch((message as MessageEvent<string>).data);
      });
    }
  }

  public close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.setState("closed");
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(data: string): void {
    let event: SseEvent;
    try {
      event = JSON.parse(data) as SseEvent;
    } catch {
      event = {
        id: `client_parse_error_${Date.now()}`,
        type: "error",
        payload: { message: "Failed to parse server event" },
        created_at: Date.now()
      };
    }

    // Push to event bus
    void eventBus.emit(event);

    // Also notify legacy subscribers
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private setState(state: SseConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

export const sseClient = new SseClient();
