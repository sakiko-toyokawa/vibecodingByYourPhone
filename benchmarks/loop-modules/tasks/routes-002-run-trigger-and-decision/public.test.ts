/**
 * routes-002-run-trigger-and-decision public tests
 *
 * Verify HTTP route behavior for manual run trigger, run query, human
 * decision, and budget supplement endpoints.
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
import { createRunsRoutes } from "../../../../packages/server/src/routes/runs.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import {
  FakeSupervisor,
  asSupervisor,
} from "../../fixtures/fake-supervisor.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const SESSION_ID = "session-routes-002";

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
      nextAction === "complete"
        ? ("passed" as const)
        : nextAction === "retry"
          ? ("failed" as const)
          : ("failed" as const),
    next_action: nextAction,
    retryable: nextAction === "retry",
    requires_human: nextAction === "needs_human",
    evidence: ["artifact://run/verifier-reports.json"],
    unresolved_risks:
      nextAction === "needs_human" ? ["needs a human call"] : [],
  };
}

function makeVerify(nextAction: "complete" | "retry" | "needs_human") {
  return async (): Promise<VerifyRunResult> => ({
    reports: [],
    judgment: makeJudgment(nextAction),
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  });
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
      verifyRunFn: (() => makeVerify(currentVerifyAction)()) as never,
    });
    const loopsApp = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
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

test("POST /api/loops/:id/runs creates a run and GET /api/runs/:id returns details", async () => {
  await withFixture(async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
    supervisor.autoSucceed = true;
    const create = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(create.status, 201);
    const createBody = (await create.json()) as {
      run: { run_id: string; loop_id: string; state: string };
    };
    assert.equal(createBody.run.loop_id, "loop-it");
    assert.equal(createBody.run.state, "active");

    // Active in-flight run has no run_state record yet; run summary is present.
    const detail = await runsApp.request(`/${createBody.run.run_id}`);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      run: { run_id: string; state: string };
      run_state: { run_id: string; state: string } | null;
      ledger_summary: { max_turns: number | null };
    };
    assert.equal(detailBody.run.run_id, createBody.run.run_id);
    assert.equal(detailBody.run.state, "active");
    assert.equal(detailBody.run_state, null);

    // After completion the run_state record is present and matches the run.
    await waitForState(controlPlane, createBody.run.run_id, ["complete"]);
    const after = await runsApp.request(`/${createBody.run.run_id}`);
    const afterBody = (await after.json()) as {
      run: { state: string };
      run_state: { run_id: string; state: string } | null;
    };
    assert.equal(afterBody.run.state, "complete");
    assert.equal(afterBody.run_state?.run_id, createBody.run.run_id);
    assert.equal(afterBody.run_state?.state, "complete");
  });
});

test("POST /api/loops/:id/runs returns 404 for unknown loop", async () => {
  await withFixture(async ({ loopsApp, runsApp }) => {
    const res = await loopsApp.request("/loop-ghost/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "loop_not_found",
    );
  });
});

test("POST /api/loops/:id/runs returns 409 run_active when loop already has active run", async () => {
  await withFixture(async ({ loopsApp, controlPlane, supervisor }) => {
    supervisor.autoSucceed = true;
    const first = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 201);
    const { run } = (await first.json()) as { run: { run_id: string } };

    const second = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 409);
    assert.equal(
      ((await second.json()) as { error: string }).error,
      "run_active",
    );

    // Wait for the background run to finish before cleanup.
    await waitForState(controlPlane, run.run_id, ["complete"]);
  });
});

test("GET /api/runs/:id returns 404 for unknown run", async () => {
  await withFixture(async ({ loopsApp, runsApp }) => {
    const res = await runsApp.request("/run-ghost");
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "run_not_found",
    );
  });
});

test("POST /api/runs/:id/decision approve resumes needs_human run to complete", async () => {
  await withFixture(
    async ({
      loopsApp,
      runsApp,
      controlPlane,
      supervisor,
      setVerifyAction,
    }) => {
      supervisor.autoSucceed = true;
      const create = await loopsApp.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(create.status, 201);
      const { run } = (await create.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["needs_human"]);

      const decision = await runsApp.request(`/${run.run_id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", feedback: "looks good" }),
      });
      assert.equal(decision.status, 200);
      const decisionBody = (await decision.json()) as {
        run_state: { state: string };
      };
      assert.equal(decisionBody.run_state.state, "active");

      // After approval the run resumes; make the next turn complete.
      setVerifyAction("complete");
      await waitForState(controlPlane, run.run_id, ["complete"]);

      const detail = await runsApp.request(`/${run.run_id}`);
      const detailBody = (await detail.json()) as {
        run: { state: string };
        ledger_summary: { last_decision: { decision: string } | null };
      };
      assert.equal(detailBody.run.state, "complete");
      assert.equal(
        detailBody.ledger_summary.last_decision?.decision,
        "complete",
      );
    },
    { verifyAction: "needs_human" },
  );
});

test("POST /api/runs/:id/decision request_changes without feedback returns 400", async () => {
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
        body: JSON.stringify({ decision: "request_changes" }),
      });
      assert.equal(res.status, 400);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        "invalid_decision",
      );
    },
    { verifyAction: "needs_human" },
  );
});

test("POST /api/runs/:id/decision on non-needs_human run returns 409 invalid_state", async () => {
  await withFixture(async ({ loopsApp, runsApp, controlPlane, supervisor }) => {
    supervisor.autoSucceed = true;
    const create = await loopsApp.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run } = (await create.json()) as { run: { run_id: string } };
    await waitForState(controlPlane, run.run_id, ["complete"]);

    const res = await runsApp.request(`/${run.run_id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("POST /api/runs/:id/budget supplements budget_limited run and resumes to complete", async () => {
  await withFixture(
    async ({
      loopsApp,
      runsApp,
      controlPlane,
      supervisor,
      setVerifyAction,
    }) => {
      supervisor.autoSucceed = true;
      const create = await loopsApp.request("/loop-it/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(create.status, 201);
      const { run } = (await create.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["budget_limited"]);

      const supplement = await runsApp.request(`/${run.run_id}/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ max_turns: 5 }),
      });
      assert.equal(supplement.status, 200);
      const supplementBody = (await supplement.json()) as {
        run_state: { state: string };
      };
      assert.equal(supplementBody.run_state.state, "active");

      // After budget is supplemented the run resumes; switch judgment to
      // complete so the next turn finishes.
      setVerifyAction("complete");
      await waitForState(controlPlane, run.run_id, ["complete"]);

      const detail = await runsApp.request(`/${run.run_id}`);
      const detailBody = (await detail.json()) as {
        run: { state: string };
        run_state: { budget: { max_turns: number } } | null;
      };
      assert.equal(detailBody.run.state, "complete");
      assert.equal(detailBody.run_state?.budget.max_turns, 5);
    },
    { verifyAction: "retry", maxTurns: 1 },
  );
});
