import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard, RunStateRecord } from "@yep-anywhere/shared";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";

function makeCard(loopId: string): LoopCard {
  return {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      workspace: {
        strategy: "direct",
        path: "C:\\Users\\alice\\repo",
      },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  } as LoopCard;
}

function makeState(runId: string): RunStateRecord {
  return {
    version: 2,
    goal_id: "g",
    run_id: runId,
    state: "active",
    turn: 2,
    intent_version: 1,
    workspace_ref: "workspace://loop-gate/run-gate",
    last_judgment: null,
    pending_approval: null,
    session_ref: null,
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 3,
      max_retries: 2,
      used_tokens: 0,
      used_time_minutes: 0,
      used_turns: 1,
      used_retries: 0,
    },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

test("restart recovery parks an active run without a checkpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-recovery-gate-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-gate"));
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    await runStateStore.save("loop-gate", makeState("run-gate"));
    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
    });
    const service = new LoopRunService({
      supervisor: {} as Supervisor,
      loopCardStore,
      runLedgerStore,
      runStateStore,
      controlPlane,
    });

    await service.resumeAfterRestart("loop-gate");

    const record = await runStateStore.load("loop-gate");
    assert.equal(record?.state, "needs_human");
    assert.ok(record?.pending_approval?.reason.includes("restart recovery"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
