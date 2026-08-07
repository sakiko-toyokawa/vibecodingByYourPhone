import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlPlane,
  ControlPlaneError,
} from "../../../../packages/server/src/loop/control-plane/control-plane.js";
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
    evidence: [],
    unresolved_risks: [],
    ...overrides,
  };
}

function retryableJudgment(): JudgmentReport {
  return makeJudgment({
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
  });
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

test("beginTurn stops with budget_limited when turns are exhausted before next turn", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus, events } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    await controlPlane.applyJudgment(
      applyInput({
        budget: { ...DEFAULT_BUDGET, max_turns: 1, max_retries: 0 },
      }),
    );

    const approved = await controlPlane.submitDecision("run-1", "approve");
    assert.equal(approved.state, "active");

    const begin = await controlPlane.beginTurn("run-1", 2);
    assert.equal(begin.ok, false);
    assert.equal(begin.state, "budget_limited");

    const record = await controlPlane.getRunState("loop-1");
    assert.equal(record?.state, "budget_limited");
  });
});

test("loop-budget-warning is emitted once per run per field when crossing 80%", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus, events } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    // Below threshold: 1/3 turns, no warning.
    await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-w1",
        runId: "run-w1",
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );

    const belowThreshold = events.filter(
      (e) => e.type === "loop-budget-warning",
    );
    assert.equal(belowThreshold.length, 0);

    // Cross threshold: 2/2 turns.
    await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-w2",
        runId: "run-w2",
        turn: 2,
        budget: { ...DEFAULT_BUDGET, max_turns: 2, max_retries: 1 },
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );

    const warnings = events.filter((e) => e.type === "loop-budget-warning");
    assert.equal(warnings.length, 1);
    const warning = warnings[0] as {
      near_limit: string;
      turns_used: number;
      max_turns: number;
    };
    assert.equal(warning.near_limit, "max_turns");
    assert.equal(warning.turns_used, 2);
    assert.equal(warning.max_turns, 2);
  });
});

test("supplementBudget is rejected from non-budget_limited states", async () => {
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
      () => controlPlane.supplementBudget("loop-1", { max_turns: 9 }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );
  });
});

test("retry consumes retry budget immediately; used_retries persists across turns", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    const first = await controlPlane.applyJudgment(
      applyInput({ judgment: retryableJudgment() }),
    );
    assert.equal(first.state, "retry");
    assert.equal(first.budget.used_retries, 1);

    await controlPlane.beginTurn("run-1", 2);

    const second = await controlPlane.applyJudgment(
      applyInput({
        turn: 2,
        judgment: retryableJudgment(),
      }),
    );
    assert.equal(second.state, "retry");
    assert.equal(second.budget.used_retries, 2);
  });
});
