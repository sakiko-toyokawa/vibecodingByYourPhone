/**
 * routes-002-run-trigger-and-decision hidden tests
 *
 * Additional edge cases for run trigger, decision, and budget endpoints.
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
import { TriggerQueueStore } from "../../../../packages/server/src/loop/state/trigger-queue-store.js";
import { drainPendingTriggers } from "../../../../packages/server/src/loop/trigger/trigger-dispatcher.js";
import type { VerifyRunResult } from "../../../../packages/server/src/loop/verification/verify-run.js";
import { createLoopsRoutes } from "../../../../packages/server/src/routes/loops.js";
import { createRunsRoutes } from "../../../../packages/server/src/routes/runs.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import {
  FakeSupervisor,
  asSupervisor,
} from "../../fixtures/fake-supervisor.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const SESSION_ID = "session-routes-002-hidden";

function makeCard(id: string, maxTurns = 3): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/routes-002-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
      stop_rules: { max_turns: maxTurns, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

function makeJudgment(nextAction: "complete" | "retry" | "needs_human") {
  return {
    overall:
      nextAction === "complete" ? ("passed" as const) : ("failed" as const),
    next_action: nextAction,
    retryable: nextAction === "retry",
    requires_human: nextAction === "needs_human",
    evidence: ["artifact://run/verifier-reports.json"],
    unresolved_risks:
      nextAction === "needs_human" ? ["needs a human call"] : [],
  };
}

interface Fixture {
  loopsApp: Hono;
  runsApp: Hono;
  controlPlane: ControlPlane;
  supervisor: FakeSupervisor;
  setVerifyAction: (action: "complete" | "retry" | "needs_human") => void;
}

async function withFixture(
  fn: (ctx: Fixture) => Promise<void>,
  options: {
    autoSucceed?: boolean;
    maxTurns?: number;
    verifyAction?: "complete" | "retry" | "needs_human";
  } = {},
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-it", options.maxTurns ?? 3));
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
    let currentVerifyAction = options.verifyAction ?? "complete";
    const service = new LoopRunService({
      supervisor: asSupervisor(supervisor),
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: (async () => ({
        reports: [],
        judgment: makeJudgment(currentVerifyAction),
        refs: {
          verification_input: "artifact://run/verification-input.json",
          verifier_runtime: "verifier-runtime://subprocess:static",
          verifier_report: "artifact://run/verifier-reports.json",
          judgment_report: "artifact://run/judgment-report.json",
        },
      })) as never,
    });
    const triggerQueueStore = new TriggerQueueStore({ dataDir });
    const loopsApp = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
      triggerQueueStore,
      drainPendingTriggers: (loopId, options) =>
        drainPendingTriggers(
          {
            queueStore: triggerQueueStore,
            runService: service,
            controlPlane,
          },
          loopId,
          options,
        ),
    });
    const runsApp = createRunsRoutes({
      runService: service,
      controlPlane,
    });
    await fn({
      loopsApp,
      runsApp,
      controlPlane,
      supervisor,
      setVerifyAction: (action) => {
        currentVerifyAction = action;
      },
    });
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

test("POST /api/runs/:id/decision reject fails the run", async () => {
  await withFixture(
    async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
      supervisor.autoSucceed = true;
      const create = await loopsApp.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { run } = (await create.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["needs_human"]);

      const res = await runsApp.request(`/${run.run_id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject", feedback: "no go" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { run_state: { state: string } };
      assert.equal(body.run_state.state, "failed");

      const detail = await runsApp.request(`/${run.run_id}`);
      const detailBody = (await detail.json()) as { run: { state: string } };
      assert.equal(detailBody.run.state, "failed");
    },
    { verifyAction: "needs_human" },
  );
});

test("POST /api/runs/:id/decision pause pauses the run", async () => {
  await withFixture(
    async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
      supervisor.autoSucceed = true;
      const create = await loopsApp.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { run } = (await create.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["needs_human"]);

      const res = await runsApp.request(`/${run.run_id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "pause" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { run_state: { state: string } };
      assert.equal(body.run_state.state, "paused");

      const record = await controlPlane.getRunState("loop-it");
      assert.equal(record?.state, "paused");
    },
    { verifyAction: "needs_human" },
  );
});

test("POST /api/runs/:id/budget on non-budget_limited run returns 409 invalid_state", async () => {
  await withFixture(async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
    supervisor.autoSucceed = true;
    const create = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run } = (await create.json()) as { run: { run_id: string } };
    await waitForState(controlPlane, run.run_id, ["complete"]);

    const res = await runsApp.request(`/${run.run_id}/budget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_turns: 5 }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("POST /api/runs/:id/budget with no budget fields returns 400 invalid_decision", async () => {
  await withFixture(
    async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
      supervisor.autoSucceed = true;
      const create = await loopsApp.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { run } = (await create.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["budget_limited"]);

      const res = await runsApp.request(`/${run.run_id}/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        "invalid_decision",
      );
    },
    { verifyAction: "retry", maxTurns: 1 },
  );
});

test("GET /api/runs/:id returns run_state and ledger_summary after completion", async () => {
  await withFixture(async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
    supervisor.autoSucceed = true;
    const create = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run } = (await create.json()) as { run: { run_id: string } };
    await waitForState(controlPlane, run.run_id, ["complete"]);

    const detail = await runsApp.request(`/${run.run_id}`);
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      run: { run_id: string; state: string };
      run_state: { run_id: string; state: string };
      ledger_summary: {
        turns_used: number;
        max_turns: number;
        decision_refs: string[];
      };
    };
    assert.equal(body.run.run_id, run.run_id);
    assert.equal(body.run.state, "complete");
    assert.equal(body.run_state.state, "complete");
    assert.equal(body.ledger_summary.turns_used, 1);
    assert.equal(body.ledger_summary.max_turns, 3);
    assert.equal(body.ledger_summary.decision_refs.length, 1);
  });
});
