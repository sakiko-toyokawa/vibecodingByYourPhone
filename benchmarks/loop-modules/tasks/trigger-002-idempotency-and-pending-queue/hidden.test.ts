import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("pending queue deduplicates same loop (keeps earliest due trigger)", async () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("busy", "30,31,32 14 * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });

  await scheduler.tick(at(30));
  await scheduler.tick(at(31));
  await scheduler.tick(at(32));
  active = false;

  const drained = await scheduler.tick(at(33));
  assert.equal(drained.length, 1);
  assert.deepEqual(fired, ["busy"]);
});

test("pending queue drains in priority order when multiple loops become free", async () => {
  const fired: string[] = [];
  const active = new Set(["bg", "urg", "norm"]);
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([
      makeQueuedCard("bg", "* * * * *", "background"),
      makeQueuedCard("urg", "* * * * *", "urgent"),
      makeCard("norm", "* * * * *"),
    ]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: (loopId) => active.has(loopId),
  });

  await scheduler.tick(at(30)); // all three enter pending queue
  assert.deepEqual(fired, []);

  active.clear();
  await scheduler.tick(at(31));
  assert.deepEqual(fired, ["urg", "norm", "bg"]);
});

test("same-loop runs stay serial: active loop never receives overlapping trigger", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("serial", "* * * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => true,
  });

  for (let minute = 30; minute < 40; minute++) {
    assert.deepEqual(await scheduler.tick(at(minute)), []);
  }
  assert.deepEqual(fired, []);
});

test("fired keys persist across scheduler instances (restart-safe idempotency)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cron-fired-"));
  try {
    const fired: string[] = [];
    const store = fakeStore([makeCard("nightly", "* * * * *")]);
    const first = new CronScheduler({
      loopCardStore: store,
      onTrigger: (loopId) => fired.push(`first:${loopId}`),
      isRunActive: () => false,
      dataDir,
    });
    await first.tick(at(30));
    assert.deepEqual(fired, ["first:nightly"]);

    // Simulate process restart: new instance, same minute must not re-fire
    const second = new CronScheduler({
      loopCardStore: store,
      onTrigger: (loopId) => fired.push(`second:${loopId}`),
      isRunActive: () => false,
      dataDir,
    });
    assert.deepEqual(await second.tick(at(30)), []);
    assert.deepEqual(fired, ["first:nightly"]);

    // Next minute fires normally (persistence key is scoped to its minute)
    assert.equal((await second.tick(at(31))).length, 1);
    assert.deepEqual(fired, ["first:nightly", "second:nightly"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("drained pending trigger blocks new due trigger in the same tick", async () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("once", "* * * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });

  // :30 matches but loop is active, so it enters the pending queue.
  assert.deepEqual(await scheduler.tick(at(30)), []);

  // :31 loop is free. Pending drain fires the :30 trigger; the new :31 cron
  // match must not cause a second fire in the same tick.
  active = false;
  const drained = await scheduler.tick(at(31));
  assert.equal(drained.length, 1);
  assert.equal(fired.length, 1);
  assert.ok(
    drained[0]?.startsWith("once:"),
    "drained key should retain the loop id",
  );
});
