import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { MaintenanceTargetStore } from "../loop/maintenance/index.js";
import { createMaintenanceRoutes } from "./maintenance.js";

test("Maintenance event route enqueues a wake event for a target", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-maintenance-routes-"));
  const enqueued: Array<{
    event_id: string;
    loop_id: string;
    payload: object;
  }> = [];
  let drained: string | undefined;
  try {
    const store = new MaintenanceTargetStore({ dataDir });
    await store.initialize();
    const now = new Date().toISOString();
    await store.upsert({
      target_id: "target-1",
      loop_id: "loop-1",
      target_type: "generic_webhook",
      external_ref: { source: "ops", subject_id: "deploy-42" },
      state: "waiting",
      feedback_cursor: {},
      feedback_count: 0,
      repair_count: 0,
      wake_policy: { trigger_types: ["deploy_ready"], max_repairs: 3 },
      context_payload: {},
      created_at: now,
      updated_at: now,
    });
    const app = new Hono().route(
      "/maintenance",
      createMaintenanceRoutes({
        targetStore: store,
        triggerQueueStore: {
          enqueue: async (input: (typeof enqueued)[number]) => {
            enqueued.push(input);
            return {
              ...input,
              state: "pending",
              source: "webhook",
              priority: "normal",
              attempts: 0,
              enqueued_at: now,
              updated_at: now,
            };
          },
        } as never,
        drainPendingTriggers: async (loopId?: string) => {
          drained = loopId;
        },
      }),
    );
    const response = await app.request("/maintenance/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "generic_webhook",
        target_id: "target-1",
        event_id: "event-1",
        payload: { status: "ready" },
      }),
    });
    assert.equal(response.status, 202);
    assert.equal(enqueued.length, 1);
    assert.equal(
      (enqueued[0]?.payload as { maintenance_id: string }).maintenance_id,
      "target-1",
    );
    assert.equal(drained, "loop-1");
    assert.equal(store.findById("target-1")?.state, "waking");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
