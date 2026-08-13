import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard, RunState } from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  EXECUTOR_SUMMARY_BEGIN,
  EXECUTOR_SUMMARY_END,
} from "./assembly/runtime-input.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { MaintenanceTargetStore } from "./maintenance/index.js";
import {
  MAINTENANCE_REQUEST_BEGIN,
  MAINTENANCE_REQUEST_END,
} from "./maintenance/index.js";
import { LoopRunService } from "./run-service.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";

class FakeSupervisor {
  async startSession(_cwd: string): Promise<Process> {
    return {
      sessionId: "session-maintenance",
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => {
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: [
                "done",
                EXECUTOR_SUMMARY_BEGIN,
                "- 已完成：registered external maintenance target",
                "- 風險：none",
                "- 文件：none",
                EXECUTOR_SUMMARY_END,
                MAINTENANCE_REQUEST_BEGIN,
                JSON.stringify({
                  target_type: "generic_webhook",
                  external_ref: { source: "ops", subject_id: "deploy-42" },
                  wake_policy: {
                    trigger_types: ["deploy_ready"],
                    max_repairs: 3,
                  },
                  context_payload: { allowed_commands: ["npm test"] },
                }),
                MAINTENANCE_REQUEST_END,
              ].join("\n"),
              is_error: false,
            },
          });
        });
        return () => {};
      },
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
  }
}

function makeCard(): LoopCard {
  return {
    loop: {
      id: "loop-maintenance",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/loop-maintenance-ws" },
      verification: { required: [] },
      persistence: { state_file: "state/loop-maintenance.json" },
      stop_rules: { max_turns: 1, max_time_minutes: 10, max_retries: 0 },
    },
  };
}

async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 5000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = controlPlane.currentStateOf(runId);
    if (state && expected.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("run completion auto-registers a generic maintenance target", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-maintenance-run-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const maintenanceTargetStore = new MaintenanceTargetStore({ dataDir });
    await maintenanceTargetStore.initialize();
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    const card = makeCard();
    const loopCardStore = {
      getLoop: (id: string) =>
        id === card.loop.id
          ? {
              id: card.loop.id,
              card,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              archived: false,
            }
          : undefined,
    } as LoopCardStore;
    const service = new LoopRunService({
      supervisor: new FakeSupervisor() as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      maintenanceTargetStore,
      sleep: async () => {},
    });
    const summary = await service.startRun(card.loop.id, "manual");
    await waitForState(controlPlane, summary.run_id, ["complete"]);
    const deadline = Date.now() + 5000;
    while (service.isRunActive(card.loop.id)) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for run to settle");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const target = maintenanceTargetStore.findByExternalRef("ops", "deploy-42");
    assert.ok(target);
    assert.equal(target?.state, "waiting");
    assert.equal(target?.target_type, "generic_webhook");
    assert.deepEqual(target?.wake_policy.trigger_types, ["deploy_ready"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
