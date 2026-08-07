import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { LearningEventStore } from "../../../../packages/server/src/loop/state/learning-event-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import type { BudgetLimits } from "../../../../packages/shared/src/loop-schema/budget.js";
import type { LearningEvent } from "../../../../packages/shared/src/loop-schema/learning.js";
import type { JudgmentReport } from "../../../../packages/shared/src/loop-schema/verification.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const JUDGMENT_REF = "artifact://run-1/judgment-report.json";

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0,
  max_time_minutes: 30,
  max_turns: 3,
  max_retries: 2,
};

function passingJudgment(): JudgmentReport {
  return {
    overall: "passed",
    next_action: "complete",
    retryable: false,
    requires_human: false,
    evidence: ["artifact://run-1/verifier-reports.json"],
    unresolved_risks: [],
  };
}

function retryableJudgment(): JudgmentReport {
  return {
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
    evidence: ["artifact://run-1/verifier-reports.json"],
    unresolved_risks: ["lint errors"],
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
    judgment: passingJudgment(),
    judgmentRef: JUDGMENT_REF,
    createdAt: new Date().toISOString(),
    budget: DEFAULT_BUDGET,
    usage: { tokens: null, timeMinutes: 1 },
    ...overrides,
  };
}

test("complete emits a learning_event", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    const result = await controlPlane.applyJudgment(applyInput());
    assert.equal(result.state, "complete");
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    const event = events[0] as LearningEvent;
    assert.equal(event.run_id, "run-1");
    assert.equal(event.loop_id, "loop-1");
    assert.equal(event.decision, "complete");
    assert.equal(event.judgment_ref, JUDGMENT_REF);
    assert.deepEqual(event.ledger_refs, [
      "ledger://run-1",
      "ledger://decision-run-1",
    ]);
    assert.deepEqual(event.failure_tags, []);
  });
});

test("retry with verification_error emits a learning_event", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({ judgment: retryableJudgment() }),
    );
    assert.equal(result.state, "retry");
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, "retry");
    assert.deepEqual(events[0].failure_tags, ["verification_error"]);
  });
});

test("budget_limited emits a learning_event", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_turns: 1, max_retries: 0 },
      }),
    );
    assert.equal(result.state, "budget_limited");
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, "budget_limited");
  });
});
