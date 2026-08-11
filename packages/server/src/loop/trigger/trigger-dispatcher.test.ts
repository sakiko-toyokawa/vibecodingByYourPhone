import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TriggerQueueStore } from "../state/trigger-queue-store.js";
import { drainPendingTriggers } from "./trigger-dispatcher.js";

test("drainPendingTriggers passes relation_id into startRun", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-trigger-"));
  try {
    const queueStore = new TriggerQueueStore({ dataDir });
    await queueStore.enqueue({
      event_id: "github-delivery-1",
      loop_id: "loop-maintainer",
      source: "webhook",
      payload: { relation_id: "rel-1" },
    });
    const calls: unknown[] = [];
    const runService = {
      isRunActive: () => false,
      startRun: async (
        loopId: string,
        source: string,
        _overrides: unknown,
        options: { relationId?: string },
      ) => {
        calls.push({ loopId, source, options });
        return { run_id: "run-1", loop_id: loopId, state: "active", source };
      },
    };
    await drainPendingTriggers({
      queueStore,
      runService: runService as never,
      controlPlane: {} as never,
    });
    assert.equal(calls.length, 1);
    const call = calls[0] as {
      loopId: string;
      source: string;
      options: { relationId?: string };
    };
    assert.equal(call.loopId, "loop-maintainer");
    assert.equal(call.source, "webhook");
    assert.equal(call.options.relationId, "rel-1");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
