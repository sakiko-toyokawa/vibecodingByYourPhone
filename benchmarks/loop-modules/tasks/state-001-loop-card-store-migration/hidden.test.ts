import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("rapid sequential saves are debounced into coherent on-disk state", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();

    // Fire many overlapping saves; none should throw or corrupt the file.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.createLoop(makeCard(`loop-${i.toString().padStart(2, "0")}`)),
      ),
    );

    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.version, 1);
    assert.equal(Object.keys(onDisk.loops).length, 20);
    for (let i = 0; i < 20; i++) {
      const id = `loop-${i.toString().padStart(2, "0")}`;
      assert.equal(onDisk.loops[id].card.loop.id, id);
    }
  });
});

test("archiveLoop and setPaused update timestamps and persist", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    await store.createLoop(makeCard("loop-a"));

    const before = store.getLoop("loop-a")?.updated_at;
    await new Promise((r) => setTimeout(r, 10));
    await store.setPaused("loop-a", true);
    assert.equal(store.getLoop("loop-a")?.paused, true);
    assert.notEqual(store.getLoop("loop-a")?.updated_at, before);

    await store.archiveLoop("loop-a");
    assert.equal(store.getLoop("loop-a")?.archived, true);
    assert.deepEqual(store.listLoops(), []);
    assert.equal(store.listLoops(true).length, 1);

    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.loops["loop-a"].paused, true);
    assert.equal(onDisk.loops["loop-a"].archived, true);
  });
});

test("loops.json is never a partial write after a crash", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    await store.createLoop(makeCard("loop-a"));

    const content = await readFile(store.getFilePath(), "utf-8");
    // Must be valid JSON and not contain the temp-file suffix on the final name.
    assert.doesNotThrow(() => JSON.parse(content));
    assert.ok(!content.includes("loops.json.tmp"));
  });
});
