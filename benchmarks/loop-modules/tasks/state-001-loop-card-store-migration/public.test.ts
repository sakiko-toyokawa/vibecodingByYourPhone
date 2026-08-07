import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import type { LoopCard } from "../../../../packages/shared/src/index.ts";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

function makeCard(id: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: `.loop/state/${id}/STATE.md` },
      stop_rules: { max_turns: 5, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

function makeStoredLoop(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    card: makeCard(id),
    created_at: now,
    updated_at: now,
    archived: false,
  };
}

test("missing loops.json initializes an empty registry", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    assert.equal(store.getLoop("any"), undefined);
    assert.deepEqual(store.listLoops(), []);
  });
});

test("createLoop persists the registry with the current version", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    const stored = await store.createLoop(makeCard("loop-a"));
    assert.equal(stored.id, "loop-a");

    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.loops["loop-a"].card.loop.id, "loop-a");
  });
});

test("registry survives a reload from disk", async () => {
  await withTempDataDir(async (dataDir) => {
    const first = new LoopCardStore({ dataDir });
    await first.initialize();
    await first.createLoop(makeCard("loop-a"));

    const second = new LoopCardStore({ dataDir });
    await second.initialize();
    assert.equal(second.getLoop("loop-a")?.card.loop.id, "loop-a");
    assert.equal(second.listLoops().length, 1);
  });
});

test("legacy version 0 registry is migrated to current version and saved", async () => {
  await withTempDataDir(async (dataDir) => {
    const seed = new LoopCardStore({ dataDir });
    await seed.initialize();
    const legacy = {
      version: 0,
      loops: { "loop-a": makeStoredLoop("loop-a") },
    };
    await writeFile(seed.getFilePath(), JSON.stringify(legacy), "utf-8");

    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    assert.equal(store.getLoop("loop-a")?.id, "loop-a");

    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.version, 1);
  });
});

test("corrupt loops.json is backed up and registry starts fresh", async () => {
  await withTempDataDir(async (dataDir) => {
    const first = new LoopCardStore({ dataDir });
    await first.initialize();
    await first.createLoop(makeCard("loop-a"));
    await writeFile(first.getFilePath(), "{ not valid json !!!", "utf-8");

    const second = new LoopCardStore({ dataDir });
    await second.initialize();
    assert.deepEqual(second.listLoops(), []);

    const files = await readdir(join(dataDir, "loops"));
    assert.ok(
      files.some((f) => f.startsWith("loops.json.corrupt-")),
      `expected corrupt backup, got: ${files.join(", ")}`,
    );
  });
});
