import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import type {
  LoopCardStore,
  StoredLoop,
} from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { CronScheduler } from "../../../../packages/server/src/loop/trigger/cron-scheduler.js";

function makeCard(id: string, cron: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "schedule", cron },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: `.loop/state/${id}/STATE.md` },
      stop_rules: { max_turns: 5, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

function fakeStore(cards: LoopCard[]): LoopCardStore {
  const loops: StoredLoop[] = cards.map((card) => ({
    id: card.loop.id,
    card,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived: false,
  }));
  return { listLoops: () => loops } as unknown as LoopCardStore;
}

function at(minute: number, hour = 14): Date {
  return new Date(2026, 6, 22, hour, minute, 30, 0); // 2026-07-22 local
}

test("invalid cron is skipped without throwing", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("broken", "not a cron")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(await scheduler.tick(at(31)), []);
  assert.deepEqual(fired, []);
});

test("manual-trigger loops are ignored by the cron scheduler", async () => {
  const card = makeCard("manual-only", "* * * * *");
  card.loop.trigger = { type: "manual" };
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([card]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(fired, []);
});

test("valid loops still fire when mixed with invalid-cron loops", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([
      makeCard("broken", "invalid cron"),
      makeCard("good", "* * * * *"),
      makeCard("also-broken", "1- * * * *"),
    ]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  const result = await scheduler.tick(at(30));
  assert.equal(result.length, 1);
  assert.ok(result[0]?.startsWith("good:"));
  assert.deepEqual(fired, ["good"]);
});
