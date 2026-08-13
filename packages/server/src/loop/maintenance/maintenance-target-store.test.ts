import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MaintenanceTargetStore } from "./maintenance-target-store.js";
import type { MaintenanceTarget } from "./types.js";

function makeTarget(
  overrides: Partial<MaintenanceTarget> = {},
): MaintenanceTarget {
  const now = new Date().toISOString();
  return {
    target_id: "target-1",
    loop_id: "loop-1",
    target_type: "generic_webhook",
    external_ref: { source: "ops", subject_id: "deploy-42" },
    state: "waiting",
    feedback_cursor: {},
    feedback_count: 0,
    repair_count: 0,
    wake_policy: { trigger_types: ["deploy_ready"], max_repairs: 3 },
    context_payload: { allowed_commands: ["npm test"] },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test("MaintenanceTargetStore persists, finds, and lists targets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-maintenance-"));
  try {
    const store = new MaintenanceTargetStore({ dataDir });
    await store.initialize();
    await store.upsert(makeTarget());
    assert.ok(store.findById("target-1"));
    assert.equal(
      store.findByExternalRef("ops", "deploy-42")?.target_id,
      "target-1",
    );
    assert.equal(store.list("loop-1").length, 1);

    const reloaded = new MaintenanceTargetStore({ dataDir });
    await reloaded.initialize();
    assert.equal(reloaded.findById("target-1")?.state, "waiting");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("MaintenanceTargetStore updates state and repair count", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-maintenance-"));
  try {
    const store = new MaintenanceTargetStore({ dataDir });
    await store.initialize();
    await store.upsert(makeTarget());
    const updated = await store.updateState("target-1", "fixing", {
      repair_count: 2,
    });
    assert.equal(updated?.state, "fixing");
    assert.equal(updated?.repair_count, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
