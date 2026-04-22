import type { BusEvent, EventHandler } from "./EventBus.js";

export interface IEventBus {
  subscribe(handler: EventHandler): () => void;
  emit(event: BusEvent): void;
  get subscriberCount(): number;
  /** Graceful shutdown — unsubscribe from Redis, drain pending */
  destroy?(): Promise<void>;
}
