import type { IEventBus } from "../../packages/server/src/watcher/index.js";

export function createFakeEventBus(): {
  bus: IEventBus;
  events: { type: string; data?: unknown }[];
} {
  const events: { type: string; data?: unknown }[] = [];
  const bus = {
    emit: (event: { type: string; data?: unknown }) => {
      events.push(event);
    },
  } as unknown as IEventBus;
  return { bus, events };
}
