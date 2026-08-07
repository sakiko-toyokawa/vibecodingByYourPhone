import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function withTempDataDir<T>(
  fn: (dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cron-fault-"));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("invalid cron is warned only once per loop", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    const scheduler = new CronScheduler({
      loopCardStore: fakeStore([makeCard("broken", "not a cron")]),
      onTrigger: () => {},
      isRunActive: () => false,
    });
    await scheduler.tick(at(30));
    await scheduler.tick(at(31));
    await scheduler.tick(at(32));
    assert.equal(
      warnings.filter((w) => w.includes("broken") && w.includes("invalid cron"))
        .length,
      1,
      "expected exactly one warning for the broken loop",
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("corrupt fired-keys file is treated as empty and does not crash", async () => {
  await withTempDataDir(async (dataDir) => {
    const firedFile = join(dataDir, "loops", "trigger", "cron-fired.json");
    await mkdir(join(dataDir, "loops", "trigger"), { recursive: true });
    await writeFile(firedFile, "this is not json", "utf-8");

    const fired: string[] = [];
    const scheduler = new CronScheduler({
      loopCardStore: fakeStore([makeCard("good", "* * * * *")]),
      onTrigger: (loopId) => fired.push(loopId),
      isRunActive: () => false,
      dataDir,
    });

    assert.equal((await scheduler.tick(at(30))).length, 1);
    assert.deepEqual(fired, ["good"]);
  });
});

test("scheduler start and stop are idempotent", () => {
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([makeCard("ticker", "* * * * *")]),
    onTrigger: () => {},
    isRunActive: () => false,
    intervalMs: 10,
  });

  scheduler.start();
  scheduler.start(); // second start must be no-op
  scheduler.stop();
  scheduler.stop(); // second stop must be no-op

  // After stop, the scheduler should be restartable.
  scheduler.start();
  scheduler.stop();
  assert.ok(true, "start/stop cycles completed without error");
});

test("persistence write failure does not block firing", async () => {
  await withTempDataDir(async (dataDir) => {
    // Create the parent directory and place a file where saveFired expects
    // the trigger directory, so its mkdir(..., { recursive: true }) fails.
    await mkdir(join(dataDir, "loops"), { recursive: true });
    await writeFile(join(dataDir, "loops", "trigger"), "", "utf-8");

    const fired: string[] = [];
    const scheduler = new CronScheduler({
      loopCardStore: fakeStore([makeCard("good", "* * * * *")]),
      onTrigger: (loopId) => fired.push(loopId),
      isRunActive: () => false,
      dataDir,
    });

    // saveFired will fail trying to mkdir over a file, but fire() still runs.
    assert.equal((await scheduler.tick(at(30))).length, 1);
    assert.deepEqual(fired, ["good"]);
  });
});

test("loop with missing cron field is ignored", async () => {
  const card = makeCard("no-cron", "* * * * *");
  card.loop.trigger = { type: "schedule" }; // cron omitted
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    loopCardStore: fakeStore([card]),
    onTrigger: (loopId) => fired.push(loopId),
    isRunActive: () => false,
  });
  assert.deepEqual(await scheduler.tick(at(30)), []);
  assert.deepEqual(fired, []);
});
