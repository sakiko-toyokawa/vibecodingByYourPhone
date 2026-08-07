import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import type {
  LoopCardStore,
  StoredLoop,
} from "../../../../packages/server/src/loop/state/loop-card-store.js";
import {
  CronScheduler,
  cronDedupeKey,
} from "../../../../packages/server/src/loop/trigger/cron-scheduler.js";

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

function makeQueuedCard(
  id: string,
  cron: string,
  queue: "urgent" | "normal" | "background",
): LoopCard {
  const card = makeCard(id, cron);
  card.loop.schedule = { queue };
  return card;
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

test("matching loop fires exactly once per minute (idempotent tick)", async () => {
  const fired: Array<{ loopId: string; key: string }> = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("nightly", "* * * * *")]),
    onTrigger: (loopId, key) => fired.push({ loopId, key }),
    isRunActive: () => false,
  });

  const first = await scheduler.tick(at(30));
  assert.deepEqual(
    fired.map((f) => f.loopId),
    ["nightly"],
  );
  assert.equal(first[0], cronDedupeKey("nightly", at(30)));

  const second = await scheduler.tick(at(30));
  assert.deepEqual(second, []);
  assert.equal(fired.length, 1);

  const third = await scheduler.tick(at(31));
  assert.equal(third.length, 1);
  assert.equal(fired.length, 2);
  assert.notEqual(fired[0]?.key, fired[1]?.key);
});

test("firing order follows schedule.queue priority (urgent > normal > background)", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([
      makeQueuedCard("bg", "* * * * *", "background"),
      makeQueuedCard("urg", "* * * * *", "urgent"),
      makeCard("norm", "* * * * *"), // default = normal
    ]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  await scheduler.tick(at(30));
  assert.deepEqual(fired, ["urg", "norm", "bg"]);
});

test("busy loop is queued (not dropped) and fires when free", async () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    // cron only matches at :30 and :31; draining at :32 proves queueing
    loopCardStore: fakeStore([makeCard("busy", "30,31 14 * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });

  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(await scheduler.tick(at(31)), []);
  assert.deepEqual(fired, []);

  active = false;
  const drained = await scheduler.tick(at(32));
  assert.equal(drained.length, 1);
  assert.deepEqual(fired, ["busy"]);

  // queued trigger fires only once
  assert.deepEqual(await scheduler.tick(at(33)), []);
  assert.equal(fired.length, 1);
});
