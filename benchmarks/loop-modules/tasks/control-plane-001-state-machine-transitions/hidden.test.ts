import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { IllegalTransitionError } from "../../../../packages/server/src/loop/control-plane/state-machine.js";
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
    evidence: [],
    unresolved_risks: [],
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

test("ControlPlane rejects illegal transitions and does not mutate state or ledger", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    // Move run to a terminal state.
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );

    // Trying to apply another judgment for turn 2 must be rejected as illegal.
    await assert.rejects(
      () =>
        controlPlane.applyJudgment(
          applyInput({
            turn: 2,
            judgment: makeJudgment({
              overall: "passed",
              next_action: "complete",
              requires_human: false,
            }),
          }),
        ),
      (error: unknown) => error instanceof IllegalTransitionError,
    );

    // State must remain complete and only one decision entry must exist.
    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "complete");
    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
  });
});

test("ControlPlane enforces retry -> active -> ... sequence; cannot skip active", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    const retryable: JudgmentReport = {
      overall: "failed",
      next_action: "retry",
      retryable: true,
      requires_human: false,
      evidence: [],
      unresolved_risks: [],
    };

    await controlPlane.applyJudgment(applyInput({ judgment: retryable }));
    const recordAfterRetry = await stateStore.load("loop-1");
    assert.equal(recordAfterRetry?.state, "retry");

    // Cannot submit a human decision directly from retry state.
    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "approve"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error).message.includes("not waiting for a human decision"),
    );
  });
});

test("ControlPlane enforces needs_human -> paused -> active sequence legality", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    await controlPlane.applyJudgment(applyInput());

    const paused = await controlPlane.submitDecision("run-1", "pause");
    assert.equal(paused.state, "paused");

    const resumed = await controlPlane.resumePaused("loop-1");
    assert.equal(resumed.state, "active");

    // paused -> active already used; cannot pause again from active without going through needs_human.
    await assert.rejects(
      () => controlPlane.resumePaused("loop-1"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error).message.includes("not paused"),
    );
  });
});
