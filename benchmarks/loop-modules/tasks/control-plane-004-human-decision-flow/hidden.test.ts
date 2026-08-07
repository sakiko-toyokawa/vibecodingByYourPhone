import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlPlane,
  ControlPlaneError,
} from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import type { ResumeSignal } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import type { BudgetLimits } from "../../../../packages/shared/src/loop-schema/budget.js";
import type { JudgmentReport } from "../../../../packages/shared/src/loop-schema/verification.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0,
  max_time_minutes: 30,
  max_turns: 3,
  max_retries: 2,
};

function makeJudgment(overrides: Partial<JudgmentReport> = {}): JudgmentReport {
  return {
    overall: "failed",
    next_action: "needs_human",
    retryable: false,
    requires_human: true,
    evidence: ["artifact://run-1/verifier-reports.json"],
    unresolved_risks: ["lint errors"],
    ...overrides,
  };
}

function applyInput(overrides: Record<string, unknown> = {}) {
  return {
    loopId: "loop-1",
    runId: "run-1",
    turn: 1,
    goalId: "intent-1",
    workspaceRef: "workspace://loop-1/run-1",
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment(),
    judgmentRef: "artifact://run-1/judgment-report.json",
    createdAt: new Date().toISOString(),
    budget: DEFAULT_BUDGET,
    usage: { tokens: null, timeMinutes: 1 },
    ...overrides,
  };
}

test("decision on non-needs_human run → invalid_state; unknown run → run_not_found", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );

    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );

    await assert.rejects(
      () => controlPlane.submitDecision("run-ghost", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "run_not_found",
    );
  });
});

test("pauseActive seeds a fresh run_state and transitions active → paused", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    const paused = await controlPlane.pauseActive("loop-1", {
      runId: "run-1",
      turn: 1,
      goalId: "intent-1",
      workspaceRef: "workspace://loop-1/run-1",
      budget: DEFAULT_BUDGET,
      createdAt: new Date().toISOString(),
    });

    assert.equal(paused.state, "paused");
    const record = await stateStore.load("loop-1");
    assert.equal(record?.run_id, "run-1");
    assert.equal(record?.state, "paused");

    const resumed = await controlPlane.resumePaused("loop-1");
    assert.equal(resumed.state, "active");
  });
});

test("submitDecision rejects approve when repeated blocker would repeat unchanged", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    const blocker = makeJudgment({
      evidence: ["artifact://run-1/collector-report.json"],
      unresolved_risks: ["GitHub auth missing: GH_TOKEN/GITHUB_TOKEN absent"],
    });

    await controlPlane.applyJudgment(applyInput({ judgment: blocker }));
    await controlPlane.submitDecision("run-1", "approve");
    await controlPlane.beginTurn("run-1", 2);
    await controlPlane.applyJudgment(
      applyInput({ turn: 2, judgment: blocker }),
    );

    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_decision",
    );
  });
});

test("waiting runs survive a control-plane restart via state-file scan", async () => {
  await withTempDataDir(async (dataDir) => {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const first = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    await first.applyJudgment(applyInput());

    const { bus } = createFakeEventBus();
    const second = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    second.onResumeRequested((signal) => resumes.push(signal));

    const runState = await second.submitDecision("run-1", "approve", "ok");
    assert.equal(runState.state, "active");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].cause, "human_approve");
  });
});

test("run-decision-required event options and action match API contract", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus, events } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    await controlPlane.applyJudgment(applyInput());

    const required = events.find((e) => e.type === "run-decision-required");
    assert.ok(required);
    assert.deepEqual((required as { options: string[] }).options, [
      "approve",
      "reject",
      "request_changes",
      "pause",
    ]);
    assert.equal(
      (required as { request_id: string }).request_id,
      "decision-run-1-t1-needs_human",
    );
  });
});
