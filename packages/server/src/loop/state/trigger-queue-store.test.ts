import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TriggerQueueStore } from "./trigger-queue-store.js";

test("trigger queue persists pending events and dedupes event_id", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "trigger-queue-"));
  try {
    const store = new TriggerQueueStore({ dataDir });
    const first = await store.enqueue({
      event_id: "evt-1",
      loop_id: "loop-a",
      source: "webhook",
      payload: { n: 1 },
    });
    const duplicate = await store.enqueue({
      event_id: "evt-1",
      loop_id: "loop-a",
      source: "webhook",
      payload: { n: 2 },
    });
    assert.equal(duplicate.event_id, first.event_id);
    assert.deepEqual(duplicate.payload, { n: 1 });

    const restored = new TriggerQueueStore({ dataDir });
    assert.deepEqual(
      (await restored.listPending()).map((e) => e.event_id),
      ["evt-1"],
    );

    await restored.mark("evt-1", "done");
    assert.equal((await restored.listPending()).length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
