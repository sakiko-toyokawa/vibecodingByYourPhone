import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // Same minute again (e.g. a second tick landing in the same minute):
  // must NOT fire a second run.
  const second = await scheduler.tick(at(30));
  assert.deepEqual(second, []);
  assert.equal(fired.length, 1);

  // Next minute fires again.
  const third = await scheduler.tick(at(31));
  assert.equal(third.length, 1);
  assert.equal(fired.length, 2);
  assert.notEqual(fired[0]?.key, fired[1]?.key);
});

test("non-matching cron does not fire", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("at-02", "0 2 * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(fired, []);
  assert.equal((await scheduler.tick(at(0, 2))).length, 1);
});

test("invalid cron is skipped without throwing (warned once)", async () => {
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

test("a loop with an active run is skipped (serial runs)", async () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("busy", "* * * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });
  assert.deepEqual(await scheduler.tick(at(30)), []);
  active = false;
  // Same minute: not yet fired (skip did not consume the dedupe key),
  // so it fires now.
  assert.equal((await scheduler.tick(at(30))).length, 1);
  // And only once.
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(fired, ["busy"]);
});

test("multiple loops fire independently in one tick", async () => {
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
  await scheduler.tick(at(30));
  assert.deepEqual(fired.sort(), ["a", "b"]);
});

function makeQueuedCard(
  id: string,
  cron: string,
  queue: "urgent" | "normal" | "background",
): LoopCard {
  const card = makeCard(id, cron);
  card.loop.schedule = { queue };
  return card;
}

test("firing order follows schedule.queue priority (urgent > normal > background)", async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([
      makeQueuedCard("bg", "* * * * *", "background"),
      makeQueuedCard("urg", "* * * * *", "urgent"),
      makeCard("norm", "* * * * *"), // 缺省 = normal
    ]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  await scheduler.tick(at(30));
  assert.deepEqual(fired, ["urg", "norm", "bg"]);
});

test("busy loop is queued (not dropped) and fired when free, deduped", async () => {
  const fired: string[] = [];
  let active = true;
  const scheduler = new CronScheduler({
    // cron 只在 :30/:31 到期: :32 补点说明走的是队列而不是重新评估 cron
    loopCardStore: fakeStore([makeCard("busy", "30,31 14 * * *")]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => active,
  });

  // 忙: 两个到期分钟都进队列 (去重, 只留最早一条)
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(await scheduler.tick(at(31)), []);
  assert.deepEqual(fired, []);

  // 空闲后: 下一个 tick 补点 (cron 在 :32 已不匹配 —— 队列的意义就是
  // 忙时不丢触发)
  active = false;
  const drained = await scheduler.tick(at(32));
  assert.equal(drained.length, 1);
  assert.deepEqual(fired, ["busy"]);
  // 补点只发生一次
  assert.deepEqual(await scheduler.tick(at(33)), []);
  assert.equal(fired.length, 1);
});

test("pending queue drains in priority order", async () => {
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
  await scheduler.tick(at(30)); // 全部进队列
  assert.deepEqual(fired, []);

  active.clear();
  await scheduler.tick(at(31));
  assert.deepEqual(fired, ["urg", "norm", "bg"]);
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

    // 模拟进程重启: 新实例, 同一分钟 —— 持久化的点火键阻止重复点火
    const second = new CronScheduler({
      loopCardStore: store,
      onTrigger: (loopId) => fired.push(`second:${loopId}`),
      isRunActive: () => false,
      dataDir,
    });
    assert.deepEqual(await second.tick(at(30)), []);
    assert.deepEqual(fired, ["first:nightly"]);

    // 下一分钟正常点火 (持久化键只管它的分钟戳)
    assert.equal((await second.tick(at(31))).length, 1);
    assert.deepEqual(fired, ["first:nightly", "second:nightly"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
