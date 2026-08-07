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

test("exponential backoff: 1min, 2min, 4min, then capped at 5min", () => {
  assert.equal(retryBackoffMs(1), 60_000);
  assert.equal(retryBackoffMs(2), 120_000);
  assert.equal(retryBackoffMs(3), 240_000);
  assert.equal(retryBackoffMs(4), 300_000);
  assert.equal(retryBackoffMs(5), 300_000);
  assert.equal(retryBackoffMs(10), 300_000);
});

test("constants: base 1min, cap 5min", () => {
  assert.equal(RETRY_BACKOFF_BASE_MS, 60_000);
  assert.equal(RETRY_BACKOFF_CAP_MS, 300_000);
});

test("defensive: retryNumber < 1 falls back to the base backoff", () => {
  assert.equal(retryBackoffMs(0), RETRY_BACKOFF_BASE_MS);
});

test("retry decision is recorded and beginTurn advances to next turn", async () => {
  await withTempDataDir(async (dataDir) => {
    const { bus } = createFakeEventBus();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });

    const result = await controlPlane.applyJudgment(makeApplyInput());

    assert.equal(result.state, "retry");

    const begin = await controlPlane.beginTurn("run-1", 2);
    assert.equal(begin.ok, true);
    assert.equal(begin.record.state, "active");
    assert.equal(begin.record.turn, 2);

    const ledger = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].decision, "retry");
    assert.equal(ledger[1].decision, "resumed");
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
