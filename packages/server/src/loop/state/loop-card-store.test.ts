import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { LoopCardStore, type StoredLoop } from "./loop-card-store.js";

function makeCard(id: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/state/test-loop/STATE.md" },
      stop_rules: { max_turns: 5, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

function makeStoredLoop(id: string): StoredLoop {
  const now = new Date().toISOString();
  return {
    id,
    card: makeCard(id),
    created_at: now,
    updated_at: now,
    archived: false,
  };
}

async function withTempDir(
  fn: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-store-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("initialize on missing file starts with an empty registry", async () => {
  await withTempDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();

    assert.equal(store.getLoop("test-loop"), undefined);
    assert.deepEqual(store.listLoops(), []);
  });
});

test("createLoop persists and list/get read it back", async () => {
  await withTempDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();

    const stored = await store.createLoop(makeCard("test-loop"));
    assert.equal(stored.id, "test-loop");
    assert.equal(stored.archived, false);
    assert.ok(stored.created_at);
    assert.equal(stored.created_at, stored.updated_at);

    assert.equal(store.getLoop("test-loop")?.id, "test-loop");
    assert.equal(store.listLoops().length, 1);

    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.loops["test-loop"].id, "test-loop");
    assert.equal(onDisk.loops["test-loop"].card.loop.id, "test-loop");
  });
});

test("state survives a reload from disk", async () => {
  await withTempDir(async (dataDir) => {
    const first = new LoopCardStore({ dataDir });
    await first.initialize();
    await first.createLoop(makeCard("test-loop"));

    const second = new LoopCardStore({ dataDir });
    await second.initialize();
    const loaded = second.getLoop("test-loop");
    assert.ok(loaded);
    assert.equal(loaded.card.loop.stop_rules.max_turns, 5);
    assert.equal(second.listLoops().length, 1);
  });
});

test("corrupt loops.json is backed up and the registry starts fresh", async () => {
  await withTempDir(async (dataDir) => {
    const first = new LoopCardStore({ dataDir });
    await first.initialize();
    await first.createLoop(makeCard("test-loop"));

    await writeFile(first.getFilePath(), "{ not valid json !!!", "utf-8");

    const second = new LoopCardStore({ dataDir });
    await second.initialize();

    // Fault-tolerant load: no throw, empty registry
    assert.deepEqual(second.listLoops(), []);

    // The bad file was preserved next to the original, not overwritten
    const files = await readdir(join(dataDir, "loops"));
    assert.ok(
      files.some((f) => f.startsWith("loops.json.corrupt-")),
      `expected a corrupt backup file, got: ${files.join(", ")}`,
    );
  });
});

test("older version is migrated to the current version and written back", async () => {
  await withTempDir(async (dataDir) => {
    const seed = new LoopCardStore({ dataDir });
    await seed.initialize();

    // Simulate a legacy registry file (version 0) written by an older build
    const legacy = {
      version: 0,
      loops: { "test-loop": makeStoredLoop("test-loop") },
    };
    await writeFile(seed.getFilePath(), JSON.stringify(legacy), "utf-8");

    const store = new LoopCardStore({ dataDir });
    await store.initialize();

    // Migration keeps the loops and stamps the current version
    assert.equal(store.getLoop("test-loop")?.id, "test-loop");
    const onDisk = JSON.parse(await readFile(store.getFilePath(), "utf-8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.loops["test-loop"].id, "test-loop");
  });
});

test("listLoops hides archived loops unless includeArchived is set", async () => {
  await withTempDir(async (dataDir) => {
    const store = new LoopCardStore({ dataDir });
    await store.initialize();
    await store.createLoop(makeCard("old-loop"));

    // Flip the flag directly (archive endpoint lands in a later phase)
    const stored = store.getLoop("old-loop");
    assert.ok(stored);
    stored.archived = true;

    assert.deepEqual(store.listLoops(), []);
    assert.equal(store.listLoops(true).length, 1);
  });
});
