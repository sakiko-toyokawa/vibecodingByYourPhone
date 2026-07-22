import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import type { LoopCardStore, StoredLoop } from "../state/loop-card-store.js";
import { CronScheduler, cronDedupeKey } from "./cron-scheduler.js";

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
  // Only listLoops() is used by the scheduler
  return { listLoops: () => loops } as unknown as LoopCardStore;
}

function at(minute: number, hour = 14): Date {
  return new Date(2026, 6, 22, hour, minute, 30, 0); // 2026-07-22 local
}

test("matching loop fires exactly once per minute (idempotent tick)", () => {
  const fired: Array<{ loopId: string; key: string }> = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("nightly", "* * * * *")]),
    onTrigger: (loopId, key) => fired.push({ loopId, key }),
    isRunActive: () => false,
  });

  const first = scheduler.tick(at(30));
  assert.deepEqual(
    fired.map((f) => f.loopId),
    ["nightly"],
  );
  assert.equal(first[0], cronDedupeKey("nightly", at(30)));

  // Same minute again (e.g. a second tick landing in the same minute):
  // must NOT fire a second run.
  const second = scheduler.tick(at(30));
  assert.deepEqual(second, []);
  assert.equal(fired.length, 1);

  // Next minute fires again.
  const third = scheduler.tick(at(31));
  assert.equal(third.length, 1);
  assert.equal(fired.length, 2);
  assert.notEqual(fired[0]?.key, fired[1]?.key);
});

test("non-matching cron does not fire", () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("at-02", "0 2 * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(scheduler.tick(at(30)), []);
  assert.deepEqual(fired, []);
  assert.equal(scheduler.tick(at(0, 2)).length, 1);
});

test("invalid cron is skipped without throwing (warned once)", () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("broken", "not a cron")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(scheduler.tick(at(30)), []);
  assert.deepEqual(scheduler.tick(at(31)), []);
  assert.deepEqual(fired, []);
});

test("manual-trigger loops are ignored by the cron scheduler", () => {
  const card = makeCard("manual-only", "* * * * *");
  card.loop.trigger = { type: "manual" };
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([card]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(scheduler.tick(at(30)), []);
  assert.deepEqual(fired, []);
});

test("a loop with an active run is skipped (serial runs)", () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("busy", "* * * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });
  assert.deepEqual(scheduler.tick(at(30)), []);
  active = false;
  // Same minute: not yet fired (skip did not consume the dedupe key),
  // so it fires now.
  assert.equal(scheduler.tick(at(30)).length, 1);
  // And only once.
  assert.deepEqual(scheduler.tick(at(30)), []);
  assert.deepEqual(fired, ["busy"]);
});

test("multiple loops fire independently in one tick", () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([
      makeCard("a", "* * * * *"),
      makeCard("b", "*/2 * * * *"),
      makeCard("c", "0 2 * * *"),
    ]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  scheduler.tick(at(30));
  assert.deepEqual(fired.sort(), ["a", "b"]);
});
