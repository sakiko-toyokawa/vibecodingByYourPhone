import { EventBus } from "./EventBus.js";
import type { IEventBus } from "./IEventBus.js";
import { RedisEventBus } from "./RedisEventBus.js";

export interface EventBusConfig {
  /** Redis URL. If set, use Redis Pub/Sub; otherwise use in-memory */
  redisUrl?: string;
  channelName?: string;
}

export function createEventBus(config: EventBusConfig = {}): IEventBus {
  if (config.redisUrl) {
    return new RedisEventBus({
      redisUrl: config.redisUrl,
      channelName: config.channelName,
    });
  }
  return new EventBus();
}
