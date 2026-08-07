/**
 * routes-001-loop-crud-pause-resume hidden tests
 *
 * Additional edge cases for loop route behavior not covered by public tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard, RunState } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { LoopRunService } from "../../../../packages/server/src/loop/run-service.js";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import type { VerifyRunResult } from "../../../../packages/server/src/loop/verification/verify-run.js";
import { createLoopsRoutes } from "../../../../packages/server/src/routes/loops.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import {
  FakeSupervisor,
  asSupervisor,
} from "../../fixtures/fake-supervisor.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const SESSION_ID = "session-routes-001-hidden";

function makeCard(id: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/routes-001-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

const PASSED_JUDGMENT = {
  overall: "passed" as const,
  next_action: "complete" as const,
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: [],
};

async function fakeVerify(): Promise<VerifyRunResult> {
  return {
    reports: [],
    judgment: PASSED_JUDGMENT,
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  };
}

async function withFixture(
  fn: (ctx: {
    app: Hono;
    loopCardStore: LoopCardStore;
    controlPlane: ControlPlane;
    ledgerStore: RunLedgerStore;
  }) => Promise<void>,
  options: { autoSucceed?: boolean; cards?: string[] } = {},
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    for (const id of options.cards ?? ["loop-it"]) {
      await loopCardStore.createLoop(makeCard(id));
    }
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const { bus: eventBus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor = new FakeSupervisor({
      sessionId: SESSION_ID,
      autoSucceed: options.autoSucceed ?? false,
    });
    const service = new LoopRunService({
      supervisor: asSupervisor(supervisor),
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: fakeVerify as never,
    });
    const app = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
    });
    await fn({ app, loopCardStore, controlPlane, ledgerStore });
  });
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
    if (state && expected.includes(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("GET /api/loops hides archived loops by default", async () => {
  await withFixture(async ({ app, loopCardStore }) => {
    await loopCardStore.archiveLoop("loop-it");
    const res = await app.request("/");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { loops: { id: string }[] };
    assert.equal(body.loops.length, 0);
  });
});

test("PATCH pause with no active run only blocks future triggers", async () => {
  await withFixture(
    async ({ app, loopCardStore, controlPlane }) => {
      const pause = await app.request("/loop-it", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      });
      assert.equal(pause.status, 200);
      const body = (await pause.json()) as { current_run_state: string | null };
      assert.equal(body.current_run_state, null);
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, true);

      const blocked = await app.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(blocked.status, 409);
      assert.equal(
        ((await blocked.json()) as { error: string }).error,
        "loop_paused",
      );

      const resume = await app.request("/loop-it", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      assert.equal(resume.status, 200);
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, false);

      // Trigger works again and completes.
      const trigger = await app.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(trigger.status, 201);
      const { run } = (await trigger.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["complete"]);
    },
    { autoSucceed: true },
  );
});

test("PATCH resume on non-paused loop with no run returns 409 invalid_state", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("PATCH pause on needs_human run returns 409 invalid_state", async () => {
  await withFixture(async ({ app, controlPlane, ledgerStore }) => {
    // Seed a needs_human run by writing a ledger entry and applying judgment.
    const runId = "run-nh";
    await ledgerStore.appendEntry(runId, {
      loop_id: "loop-it",
      run_id: runId,
      runtime: {
        adapter: "claude",
        session_ref: "session-nh",
        mode: "plan",
        adapter_capability_snapshot: "realSdk;permissionMode=plan",
      },
      input_refs: {
        intent: "intent://loop-it",
        memory_packet: null,
        workspace: "workspace://loop-it/run-nh",
      },
      verification_refs: {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "artifact://run-nh/judgment-report.json",
      },
      learning_refs: {
        control_decision: "ledger://run-nh",
        human_feedback: [],
        external_feedback: [],
      },
      artifact_refs: [],
      final_status: "needs_human",
      created_at: new Date().toISOString(),
    });
    await controlPlane.applyJudgment({
      loopId: "loop-it",
      runId,
      turn: 1,
      goalId: "intent-1",
      workspaceRef: "workspace://loop-it/run-nh",
      executionOk: true,
      verificationRan: true,
      judgment: {
        overall: "failed",
        next_action: "needs_human",
        retryable: false,
        requires_human: true,
        evidence: ["artifact://run/verifier-reports.json"],
        unresolved_risks: ["needs a human call"],
      },
      judgmentRef: "artifact://run-nh/judgment-report.json",
      createdAt: new Date().toISOString(),
      budget: {
        max_tokens: 0,
        max_time_minutes: 30,
        max_turns: 3,
        max_retries: 2,
      },
      usage: { tokens: null, timeMinutes: 1 },
    });

    const res = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("POST /api/loops/:id/runs rejected when loop already has active run", async () => {
  await withFixture(async ({ app }) => {
    const first = await app.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 201);

    const second = await app.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 409);
    assert.equal(
      ((await second.json()) as { error: string }).error,
      "run_active",
    );
  });
});
