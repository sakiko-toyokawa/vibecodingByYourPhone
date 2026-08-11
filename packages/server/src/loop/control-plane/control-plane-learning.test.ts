import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  BudgetLimits,
  JudgmentReport,
  LearningEvent,
} from "@yep-anywhere/shared";
import { LearningEventStore } from "../state/learning-event-store.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import { ControlPlane } from "./control-plane.js";
import { RunStateStore } from "./run-state-store.js";

const JUDGMENT_REF = "artifact://run-1/judgment-report.json";

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0, // untracked
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

async function withFixture(
  fn: (ctx: {
    dataDir: string;
    controlPlane: ControlPlane;
    eventStore: LearningEventStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cp-learning-"));
  try {
    const eventStore = new LearningEventStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      learningEventStore: eventStore,
    });
    await fn({ dataDir, controlPlane, eventStore });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("终态 complete 发射 learning_event（只发不等，落 events.jsonl）", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
    const result = await controlPlane.applyJudgment(applyInput());
    assert.equal(result.state, "complete");
    // 发射是 fire-and-forget：用测试钩子等待落盘
    await controlPlane.settleLearningEvents();

    const { events, nextOffset } = await eventStore.readEvents(0);
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
    assert.equal(nextOffset, 1);
  });
});

test("retry 决策带 verification_error 归因 → 发射 learning_event (#21)", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
    const result = await controlPlane.applyJudgment(
      applyInput({ judgment: retryableJudgment() }),
    );
    assert.equal(result.state, "retry");
    await controlPlane.settleLearningEvents();
    const { events } = await eventStore.readEvents(0);
    // 验证失败是真实学习信号: retry 决策带 verification_error 归因,
    // 按"终态或带 failure_tags 的决策"条件发射 (worker 按 run 去重,
    // 同一 run 的重试失败只计一次发作)
    assert.equal(events.length, 1);
    assert.equal(events[0]?.decision, "retry");
    assert.deepEqual(events[0]?.failure_tags, ["verification_error"]);
  });
});

test("needs_human 带验证失败归因发射; 人工 reject → failed 后再发射", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
    const applied = await controlPlane.applyJudgment(
      applyInput({
        judgment: { ...retryableJudgment(), requires_human: true },
      }),
    );
    assert.equal(applied.state, "needs_human");
    await controlPlane.settleLearningEvents();
    const first = await eventStore.readEvents(0);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]?.decision, "needs_human");
    assert.deepEqual(first.events[0]?.failure_tags, ["verification_error"]);

    await controlPlane.submitDecision("run-1", "reject");
    await controlPlane.settleLearningEvents();
    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.decision, "failed");
  });
});

test("budget_limited 发射 learning_event", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
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
    assert.equal(events[0]?.decision, "budget_limited");
  });
});

test("adapter 硬错误终止：failed 事件携带 failure_tags 归因词汇", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
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
    assert.equal(events[0]?.decision, "failed");
    assert.deepEqual(events[0]?.failure_tags, ["runtime_blackbox_error"]);
  });
});

test("幂等重放不重复发射", async () => {
  await withFixture(async ({ controlPlane, eventStore }) => {
    await controlPlane.applyJudgment(applyInput());
    const replay = await controlPlane.applyJudgment(applyInput());
    assert.equal(replay.idempotent, true);
    await controlPlane.settleLearningEvents();
    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
  });
});

test("发射失败（EACCES）不影响 run 推进：决策照常落账、状态照常迁移", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cp-learning-"));
  try {
    // 模拟 events.jsonl 写入被拒：appendEvent 以 EACCES 拒绝
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

    // console.error 会被打一条发射失败日志；吞掉以免污染测试输出
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await controlPlane.applyJudgment(applyInput());
      assert.equal(result.state, "complete");
      await controlPlane.settleLearningEvents(); // 不抛

      // run 推进无损：run_state 已落终态，决策条目已落账
      const record = await controlPlane.getRunState("loop-1");
      assert.equal(record?.state, "complete");
      assert.equal(result.entry.decision, "complete");
    } finally {
      console.error = originalError;
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("失败归因: adapter/策略拦截/验证失败信号同时挂载且去重 (#21)", async () => {
  await withFixture(async ({ controlPlane }) => {
    const result = await controlPlane.applyJudgment(
      applyInput({
        executionOk: false,
        judgment: retryableJudgment(),
        adapterFailure: {
          code: "permission_denied",
          failureTag: "policy_error",
          message: "permission denied by runtime",
        },
        policyEscalation: {
          action: "merge",
          reason: "hard gate 'merge' intercepted",
          policyRef: "policy://loop_bypass",
        },
      }),
    );
    assert.equal(result.state, "failed");
    // policy_error 来自两处 (adapter permission_denied + 硬闸门拦截) 去重;
    // 验证失败 overall=failed → verification_error
    assert.deepEqual(result.entry.failure_tags, [
      "policy_error",
      "verification_error",
    ]);
  });
});

test("失败归因: review_or_policy 高風險升級不自動掛 policy_error", async () => {
  await withFixture(async ({ controlPlane }) => {
    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: passingJudgment(),
        policyEscalation: {
          action: "execute",
          reason: "high risk review_or_policy",
          policyRef: "policy://github_issue_local_fix",
          reviewable: true,
        },
      }),
    );
    assert.equal(result.state, "needs_human");
    assert.equal(result.entry.failure_tags, undefined);
  });
});

test("失败归因: passed judgment 且无其他信号 → 无 failure_tags (#21)", async () => {
  await withFixture(async ({ controlPlane }) => {
    const result = await controlPlane.applyJudgment(applyInput());
    assert.equal(result.state, "complete");
    assert.equal(result.entry.failure_tags, undefined);
  });
});
