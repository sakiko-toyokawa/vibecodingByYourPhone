import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import {
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  retryBackoffMs,
} from "../../../../packages/server/src/loop/control-plane/retry-backoff.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import type { BudgetLimits } from "../../../../packages/shared/src/loop-schema/budget.js";
import type { JudgmentReport } from "../../../../packages/shared/src/loop-schema/verification.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

test("backoff never exceeds cap even for very large retry numbers", () => {
  assert.equal(retryBackoffMs(100), RETRY_BACKOFF_CAP_MS);
  assert.equal(retryBackoffMs(1_000_000), RETRY_BACKOFF_CAP_MS);
});

test("backoff values exactly match formula below cap", () => {
  assert.equal(retryBackoffMs(1), RETRY_BACKOFF_BASE_MS * 2 ** 0);
  assert.equal(retryBackoffMs(2), RETRY_BACKOFF_BASE_MS * 2 ** 1);
  assert.equal(retryBackoffMs(3), RETRY_BACKOFF_BASE_MS * 2 ** 2);
  // 4th retry would be 8min, but cap applies.
  assert.equal(retryBackoffMs(4), RETRY_BACKOFF_CAP_MS);
});

test("beginTurn is idempotent: same turn replay does not duplicate ledger entries", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    await controlPlane.applyJudgment(makeApplyInput());

    await controlPlane.beginTurn("run-1", 2);
    await controlPlane.beginTurn("run-1", 2);
    await controlPlane.beginTurn("run-1", 2);

    const ledger = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(ledger.length, 2);
    assert.equal(ledger.filter((e) => e.decision === "resumed").length, 1);
  });
});

test("multiple retries accumulate used_retries and transition through retry -> active -> retry", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    await controlPlane.applyJudgment(makeApplyInput({ turn: 1 }));
    await controlPlane.beginTurn("run-1", 2);
    const turn2 = await controlPlane.applyJudgment(makeApplyInput({ turn: 2 }));
    assert.equal(turn2.state, "retry");
    assert.equal(turn2.budget.used_retries, 2);

    await controlPlane.beginTurn("run-1", 3);
    const turn3 = await controlPlane.applyJudgment(
      makeApplyInput({
        turn: 3,
        judgment: {
          overall: "passed",
          next_action: "complete",
          retryable: false,
          requires_human: false,
          evidence: [],
          unresolved_risks: [],
        },
      }),
    );
    assert.equal(turn3.state, "complete");
    assert.equal(turn3.budget.used_retries, 2);
  });
});

test("retry -> active -> budget_limited if no retries remain", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    const result = await controlPlane.applyJudgment(
      makeApplyInput({
        budget: { ...DEFAULT_BUDGET, max_retries: 1, max_turns: 5 },
      }),
    );
    assert.equal(result.state, "retry");

    await controlPlane.beginTurn("run-1", 2);

    const turn2 = await controlPlane.applyJudgment(
      makeApplyInput({
        turn: 2,
        budget: { ...DEFAULT_BUDGET, max_retries: 1, max_turns: 5 },
      }),
    );
    assert.equal(turn2.state, "budget_limited");
  });
});

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0,
  max_time_minutes: 30,
  max_turns: 5,
  max_retries: 3,
};

function retryableJudgment(): JudgmentReport {
  return {
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
    evidence: [],
    unresolved_risks: ["lint error"],
  };
}

function makeApplyInput(overrides: Record<string, unknown> = {}) {
  return {
    loopId: "loop-1",
    runId: "run-1",
    turn: 1,
    goalId: "intent-1",
    workspaceRef: "workspace://loop-1/run-1",
    executionOk: true,
    verificationRan: true,
    judgment: retryableJudgment(),
    judgmentRef: "artifact://run-1/judgment-report.json",
    createdAt: new Date().toISOString(),
    budget: DEFAULT_BUDGET,
    usage: { tokens: null, timeMinutes: 1 },
    ...overrides,
  };
}
