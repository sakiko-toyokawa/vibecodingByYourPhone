import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
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

test("max_retries exhausted first: retryable failure becomes budget_limited", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_retries: 0 },
      }),
    );

    assert.equal(result.state, "budget_limited");
    assert.match(result.entry.reason, /max_retries/);
    assert.equal(result.budget.used_retries, 0);
  });
});

test("max_turns exhausted at judgment time: retryable failure becomes budget_limited", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_turns: 2, max_retries: 1 },
      }),
    );

    await controlPlane.beginTurn("run-1", 2);

    const result = await controlPlane.applyJudgment(
      applyInput({
        turn: 2,
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_turns: 2, max_retries: 1 },
      }),
    );

    assert.equal(result.state, "budget_limited");
    assert.match(result.entry.reason, /max_turns/);
  });
});

test("token limit crossed by usage → budget_limited; max_tokens=0 means untracked", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    const limited = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_tokens: 100 },
        usage: { tokens: 150, timeMinutes: 1 },
      }),
    );
    assert.equal(limited.state, "budget_limited");
    assert.match(limited.entry.reason, /max_tokens/);
    assert.equal(limited.budget.used_tokens, 150);
  });

  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    const untracked = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_tokens: 0 },
        usage: { tokens: 150, timeMinutes: 1 },
      }),
    );
    assert.equal(untracked.state, "retry");
    assert.equal(untracked.budget.used_tokens, 150);
  });
});

test("time limit crossed at turn end → budget_limited", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_time_minutes: 30 },
        usage: { tokens: null, timeMinutes: 45 },
      }),
    );

    assert.equal(result.state, "budget_limited");
    assert.match(result.entry.reason, /max_time_minutes/);
    assert.equal(result.budget.used_time_minutes, 45);
  });
});

test("supplementBudget raises limits and resumes budget_limited run", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      eventBus: bus,
    });

    await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_retries: 0 },
      }),
    );

    const resumed = await controlPlane.supplementBudget("loop-1", {
      max_retries: 5,
    });

    assert.equal(resumed.state, "active");
    assert.equal(resumed.budget?.max_retries, 5);
    // Consumption is not reset; only the ceiling is raised.
    assert.equal(resumed.budget?.used_turns, 1);
  });
});
