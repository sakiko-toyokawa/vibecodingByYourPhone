import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { LearningEventStore } from "../../../../packages/server/src/loop/state/learning-event-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import type { BudgetLimits } from "../../../../packages/shared/src/loop-schema/budget.js";
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

test("idempotent replay does not duplicate learning events", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    await controlPlane.applyJudgment(applyInput());
    const replay = await controlPlane.applyJudgment(applyInput());
    assert.equal(replay.idempotent, true);
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
  });
});

test("adapter hard error emits failed event with runtime failure tag", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({
        executionOk: false,
        adapterFailure: {
          code: "timeout",
          failureTag: "runtime_blackbox_error",
          message: "adapter timed out",
        },
      }),
    );
    assert.equal(result.state, "failed");
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, "failed");
    assert.deepEqual(events[0].failure_tags, ["runtime_blackbox_error"]);
  });
});

test("learning event store failure does not affect run progression", async () => {
  await withTempDataDir(async (dataDir) => {
    const brokenStore = {
      appendEvent: () => {
        const error = new Error(
          "EACCES: permission denied, open 'events.jsonl'",
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        return Promise.reject(error);
      },
    } as unknown as LearningEventStore;

    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: brokenStore,
    });

    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await controlPlane.applyJudgment(applyInput());
      assert.equal(result.state, "complete");
      await controlPlane.settleLearningEvents();

      const record = await controlPlane.getRunState("loop-1");
      assert.equal(record?.state, "complete");
      assert.equal(result.entry.decision, "complete");
    } finally {
      console.error = originalError;
    }
  });
});

test("needs_human with verification error then human reject emits two events", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    await controlPlane.applyJudgment(
      applyInput({
        judgment: { ...retryableJudgment(), requires_human: true },
      }),
    );
    await controlPlane.settleLearningEvents();
    const first = await eventStore.readEvents(0);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].decision, "needs_human");

    await controlPlane.submitDecision("run-1", "reject");
    await controlPlane.settleLearningEvents();
    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 2);
    assert.equal(events[1].decision, "failed");
  });
});

test("policy escalation emits policy_error failure tag in learning event", async () => {
  await withTempDataDir(async (dataDir) => {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });

    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: passingJudgment(),
        policyEscalation: {
          action: "merge",
          reason: "protected branch",
          policyRef: "policy://hard-gate/merge",
        },
      }),
    );
    assert.equal(result.state, "needs_human");
    await controlPlane.settleLearningEvents();

    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, "needs_human");
    assert.deepEqual(events[0].failure_tags, ["policy_error"]);
  });
});
