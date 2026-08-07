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

test("approve → active with feedback and resume signal", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(applyInput());
    const runState = await controlPlane.submitDecision(
      "run-1",
      "approve",
      "人工确认 lint 报错可接受",
    );

    assert.equal(runState.state, "active");
    assert.equal(runState.pending_approval, null);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].cause, "human_approve");
    assert.equal(resumes[0].feedback, "人工确认 lint 报错可接受");

    const ledger = await ledgerStore.readDecisionEntries("run-1");
    const human = ledger[1];
    assert.equal(human.decision, "resumed");
    assert.equal(human.next_action, "resume_next_turn");
    assert.equal(human.feedback, "人工确认 lint 报错可接受");
  });
});

test("request_changes requires feedback and resumes with feedback", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(applyInput());

    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "request_changes"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_decision",
    );

    const runState = await controlPlane.submitDecision(
      "run-1",
      "request_changes",
      "请先修掉 lint 再交付",
    );
    assert.equal(runState.state, "active");
    assert.equal(resumes[0].cause, "human_request_changes");
    assert.equal(resumes[0].feedback, "请先修掉 lint 再交付");
  });
});

test("reject → failed and fires resolved listener", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resolved: [string, string][] = [];
    controlPlane.onRunResolved((runId, state) => resolved.push([runId, state]));

    await controlPlane.applyJudgment(applyInput());
    const runState = await controlPlane.submitDecision("run-1", "reject");

    assert.equal(runState.state, "failed");
    assert.deepEqual(resolved, [["run-1", "failed"]]);
  });
});

test("pause → paused and resumePaused → active with resume signal", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(applyInput());
    const paused = await controlPlane.submitDecision("run-1", "pause");
    assert.equal(paused.state, "paused");
    assert.equal(resumes.length, 0);

    const resumed = await controlPlane.resumePaused("loop-1");
    assert.equal(resumed.state, "active");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].cause, "resume_signal");
  });
});
