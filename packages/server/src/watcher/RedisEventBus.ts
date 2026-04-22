import Redis from "ioredis";
import type { IEventBus } from "./IEventBus.js";
import type { BusEvent, EventHandler } from "./EventBus.js";

export interface RedisEventBusOptions {
  redisUrl: string;
  channelName?: string;
}

export class RedisEventBus implements IEventBus {
  private publisher: Redis;
  private subscriber: Redis;
  private localSubscribers: Set<EventHandler> = new Set();
  private channelName: string;

  constructor(options: RedisEventBusOptions) {
    this.channelName = options.channelName ?? "yepanywhere:events";
    this.publisher = new Redis(options.redisUrl);
    this.subscriber = new Redis(options.redisUrl);

    this.subscriber.subscribe(this.channelName);
    this.subscriber.on("message", (_channel, message) => {
      const event = JSON.parse(message) as BusEvent;
      for (const handler of this.localSubscribers) {
        try {
          handler(event);
        } catch (error) {
          console.error("[RedisEventBus] Handler error:", error);
        }
      }
    });
  }

  subscribe(handler: EventHandler): () => void {
    this.localSubscribers.add(handler);
    return () => {
      this.localSubscribers.delete(handler);
    };
  }

  emit(event: BusEvent): void {
    this.publisher.publish(this.channelName, JSON.stringify(event));
    for (const handler of this.localSubscribers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[RedisEventBus] Handler error:", error);
      }
    }
  }

  get subscriberCount(): number {
    return this.localSubscribers.size;
  }

  async destroy(): Promise<void> {
    await this.subscriber.unsubscribe(this.channelName);
    this.subscriber.disconnect();
    this.publisher.disconnect();
    this.localSubscribers.clear();
  }
}
