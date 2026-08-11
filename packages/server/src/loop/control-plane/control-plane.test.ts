import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BudgetLimits, JudgmentReport } from "@yep-anywhere/shared";
import type { BusEvent, IEventBus } from "../../watcher/index.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import {
  ControlPlane,
  ControlPlaneError,
  type ResumeSignal,
} from "./control-plane.js";
import { RunStateStore } from "./run-state-store.js";
import { IllegalTransitionError } from "./state-machine.js";

class FakeEventBus implements IEventBus {
  readonly events: BusEvent[] = [];
  subscribe(): () => void {
    return () => {};
  }
  emit(event: BusEvent): void {
    this.events.push(event);
  }
  get subscriberCount(): number {
    return 0;
  }
  ofType<T extends BusEvent["type"]>(
    type: T,
  ): Extract<BusEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      BusEvent,
      { type: T }
    >[];
  }
}

/** Index into an array under noUncheckedIndexedAccess (fails loudly). */
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  assert.ok(value !== undefined, `expected element at index ${index}`);
  return value;
}

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

/** retryable failure — the judgment that drives the retry path. */
function retryableJudgment(
  overrides: Partial<JudgmentReport> = {},
): JudgmentReport {
  return makeJudgment({
    next_action: "retry",
    retryable: true,
    requires_human: false,
    ...overrides,
  });
}

const JUDGMENT_REF = "artifact://run-1/judgment-report.json";

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0, // untracked
  max_time_minutes: 30,
  max_turns: 3,
  max_retries: 2,
};

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
    bus: FakeEventBus;
    ledgerStore: RunLedgerStore;
    stateStore: RunStateStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-control-plane-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const bus = new FakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    await fn({ dataDir, controlPlane, bus, ledgerStore, stateStore });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("passed judgment → complete: state persisted, decision ledgered with budget snapshot, loop-state-changed emitted", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore, stateStore }) => {
    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    assert.equal(result.state, "complete");
    assert.equal(result.idempotent, false);

    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "complete");
    assert.equal(record?.run_id, "run-1");
    assert.equal(record?.last_judgment, JUDGMENT_REF);
    assert.equal(record?.pending_approval, null);
    // budget 快照写入 run_state（阶段 2）
    assert.equal(record?.budget?.used_turns, 1);
    assert.equal(record?.budget?.used_retries, 0);
    assert.equal(record?.budget?.max_turns, 3);

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(decisions.length, 1);
    assert.equal(at(decisions, 0).decision, "complete");
    assert.equal(at(decisions, 0).decision_id, "decision-run-1-t1-complete");
    assert.equal(at(decisions, 0).next_action, "none");
    // 账本可见逐轮消耗：决策条目携带预算快照
    assert.equal(at(decisions, 0).budget?.used_turns, 1);

    const changes = bus.ofType("loop-state-changed");
    assert.equal(changes.length, 1);
    assert.deepEqual(
      changes.map((e) => ({
        from: e.from_state,
        to: e.to_state,
        loop: e.loop_id,
        run: e.run_id,
        turn: e.turn,
      })),
      [
        {
          from: "active",
          to: "complete",
          loop: "loop-1",
          run: "run-1",
          turn: 1,
        },
      ],
    );
    assert.equal(bus.ofType("run-decision-required").length, 0);
  });
});

test("discardRun: needs_human → discarded with decision entry and resolved listener", async () => {
  await withFixture(async ({ controlPlane, ledgerStore, stateStore }) => {
    let resolved: string | null = null;
    controlPlane.onRunResolved((runId, state) => {
      if (state === "discarded") resolved = runId;
    });
    await controlPlane.applyJudgment(applyInput());

    const updated = await controlPlane.discardRun(
      "run-1",
      "user discarded the run",
    );
    assert.equal(updated.state, "discarded");
    assert.equal((await stateStore.load("loop-1"))?.state, "discarded");
    assert.equal(resolved, "run-1");

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const last = at(decisions, decisions.length - 1);
    assert.equal(last.decision, "discarded");
    assert.equal(last.reason, "user discarded the run");
  });
});

test("discardRun: active run rejects without force and succeeds with force", async () => {
  await withFixture(async ({ controlPlane, ledgerStore, stateStore }) => {
    await controlPlane.applyJudgment(
      applyInput({ judgment: retryableJudgment() }),
    );
    await controlPlane.beginTurn("run-1", 2);
    assert.equal((await stateStore.load("loop-1"))?.state, "active");

    await assert.rejects(
      () => controlPlane.discardRun("run-1", "discard without force"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );

    const updated = await controlPlane.discardRun("run-1", "discard active", {
      force: true,
    });
    assert.equal(updated.state, "discarded");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, decisions.length - 1).decision, "discarded");
  });
});

test("retryable failure with budget headroom → retry; beginTurn drives retry → active; turn 2 completes", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore, stateStore }) => {
    const applied = await controlPlane.applyJudgment(
      applyInput({ judgment: retryableJudgment() }),
    );
    assert.equal(applied.state, "retry");
    // retry 消耗 retry 预算（不含首轮）
    assert.equal(applied.budget.used_retries, 1);
    assert.equal(applied.budget.used_turns, 1);

    const retryRecord = await stateStore.load("loop-1");
    assert.equal(retryRecord?.state, "retry");
    assert.equal(retryRecord?.budget?.used_retries, 1);

    // retry → active（退避结束后由 run service 调 beginTurn）
    const begin = await controlPlane.beginTurn("run-1", 2);
    assert.equal(begin.ok, true);
    assert.equal(begin.record.state, "active");
    assert.equal(begin.record.turn, 2);

    // retry → active 落账为 resumed
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(decisions.length, 2);
    assert.equal(at(decisions, 0).decision, "retry");
    assert.equal(at(decisions, 1).decision, "resumed");
    assert.match(at(decisions, 1).reason, /retry backoff elapsed/);

    // 第二轮判定通过 → complete，预算累计两轮
    const turn2 = await controlPlane.applyJudgment(
      applyInput({
        turn: 2,
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
        usage: { tokens: 500, timeMinutes: 2 },
      }),
    );
    assert.equal(turn2.state, "complete");
    assert.equal(turn2.budget.used_turns, 2);
    assert.equal(turn2.budget.used_retries, 1);
    assert.equal(turn2.budget.used_tokens, 500);
    assert.equal(turn2.budget.used_time_minutes, 3);

    const transitions = bus
      .ofType("loop-state-changed")
      .map((e) => `${e.from_state}->${e.to_state}`);
    assert.deepEqual(transitions, [
      "active->retry",
      "retry->active",
      "active->complete",
    ]);
  });
});

test("idempotent replay: the same turn judged twice is ledgered once", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore }) => {
    const first = await controlPlane.applyJudgment(applyInput());
    assert.equal(first.state, "needs_human");
    assert.equal(first.idempotent, false);

    const replay = await controlPlane.applyJudgment(applyInput());
    assert.equal(replay.state, "needs_human");
    assert.equal(replay.idempotent, true);
    assert.equal(replay.entry.decision_id, first.entry.decision_id);

    // 不重复落账、不重复广播
    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
    assert.equal(bus.ofType("loop-state-changed").length, 1);
    assert.equal(bus.ofType("run-decision-required").length, 1);
  });
});

test("budget: retries exhausted → budget_limited (先触者停), not retry", async () => {
  await withFixture(async ({ controlPlane, ledgerStore, stateStore }) => {
    const applied = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_retries: 0 },
      }),
    );
    assert.equal(applied.state, "budget_limited");
    assert.match(applied.entry.reason, /max_retries/);
    assert.equal(at([applied.entry], 0).decision, "budget_limited");

    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "budget_limited");
    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
  });
});

test("budget: max_turns exhausted at turn start → beginTurn stops with budget_limited", async () => {
  await withFixture(async ({ controlPlane, stateStore }) => {
    // max_turns=2, max_retries=1: turn 1 retries; turn 2 fails retryable
    // again → turns exhausted (2/2) → budget_limited at judgment time…
    const applied = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_turns: 2, max_retries: 1 },
      }),
    );
    assert.equal(applied.state, "retry");
    const begin = await controlPlane.beginTurn("run-1", 2);
    assert.equal(begin.ok, true);

    const turn2 = await controlPlane.applyJudgment(
      applyInput({ turn: 2, judgment: retryableJudgment() }),
    );
    // used_turns=2 ≥ max_turns=2 且 used_retries=1 ≥ max_retries=1，先触者停
    assert.equal(turn2.state, "budget_limited");
    assert.match(turn2.entry.reason, /max_turns/);

    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "budget_limited");
  });
});

test("budget: token limit crossed by turn usage → budget_limited; max_tokens=0 means untracked", async () => {
  await withFixture(async ({ controlPlane }) => {
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
  await withFixture(async ({ controlPlane }) => {
    // max_tokens=0 = 不跟踪：同样的 token 消耗不触发 budget_limited
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

test("budget: time limit crossed at turn end → budget_limited", async () => {
  await withFixture(async ({ controlPlane }) => {
    const applied = await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_time_minutes: 30 },
        usage: { tokens: null, timeMinutes: 45 },
      }),
    );
    assert.equal(applied.state, "budget_limited");
    assert.match(applied.entry.reason, /max_time_minutes/);
    assert.equal(applied.budget.used_time_minutes, 45);
  });
});

test("budget_limited → active via supplementBudget (人工补充预算并恢复)", async () => {
  await withFixture(async ({ controlPlane, stateStore, ledgerStore }) => {
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment(),
        budget: { ...DEFAULT_BUDGET, max_retries: 0 },
      }),
    );
    assert.equal(controlPlane.currentStateOf("run-1"), "budget_limited");

    // 06 #31: max_retries >= max_turns 合法 (先触者停, 轮次上限先触达)
    const resumed = await controlPlane.supplementBudget("loop-1", {
      max_retries: 5,
    });
    assert.equal(resumed.state, "active");
    assert.equal(resumed.budget?.max_retries, 5);
    // 消耗不清零，只抬上限
    assert.equal(resumed.budget?.used_turns, 1);

    // active 后重复补充 → 409 invalid_state
    await assert.rejects(
      () => controlPlane.supplementBudget("loop-1", { max_retries: 9 }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );

    assert.deepEqual(
      resumes.map((s) => [s.runId, s.cause]),
      [["run-1", "budget_supplemented"]],
    );
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, decisions.length - 1).decision, "resumed");

    // 非 budget_limited 状态拒绝补充（非法转移拒绝）
    await assert.rejects(
      () => controlPlane.supplementBudget("loop-1", { max_turns: 9 }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );
    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "active");
  });
});

test("budget: pre-turn check — approve resume with turns exhausted → beginTurn stops budget_limited", async () => {
  await withFixture(async ({ controlPlane, ledgerStore, stateStore }) => {
    // max_turns=1：首轮判定 needs_human 不消耗额外预算；人工 approve 恢复后
    // 已没有开新一轮的轮次预算 → beginTurn 先触者停。
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

    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "budget_limited");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const limited = at(decisions, decisions.length - 1);
    assert.equal(limited.decision, "budget_limited");
    assert.match(limited.reason, /max_turns/);
  });
});

test("needs_human bridging: decision-required event; approve → active with override + resume signal", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore, stateStore }) => {
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));
    const resolved: [string, string][] = [];
    controlPlane.onRunResolved((runId, state) => resolved.push([runId, state]));

    const applied = await controlPlane.applyJudgment(applyInput());
    assert.equal(applied.state, "needs_human");
    assert.equal(controlPlane.currentStateOf("run-1"), "needs_human");

    // run blocks: state file carries the pending approval
    const waiting = await stateStore.load("loop-1");
    assert.equal(waiting?.state, "needs_human");
    assert.equal(
      waiting?.pending_approval?.request_id,
      "decision-run-1-t1-needs_human",
    );

    // run-decision-required payload shape (03 WS 事件契约)
    const required = bus.ofType("run-decision-required");
    assert.equal(required.length, 1);
    const payload = at(required, 0);
    assert.equal(payload.loop_id, "loop-1");
    assert.equal(payload.run_id, "run-1");
    assert.equal(payload.request_id, "decision-run-1-t1-needs_human");
    assert.equal(payload.action, "needs_human"); // judgment's next_action
    assert.equal(payload.risk, "unrated");
    assert.deepEqual(payload.evidence_refs, [
      "artifact://run-1/verifier-reports.json",
    ]);
    assert.deepEqual(payload.options, [
      "approve",
      "reject",
      "request_changes",
      "pause",
    ]);

    // Phase-2 完整迁移表：approve → active（携带人工响应恢复，feedback 进账本）
    const runState = await controlPlane.submitDecision(
      "run-1",
      "approve",
      "人工确认 lint 报错可接受",
    );
    assert.equal(runState.state, "active");
    assert.equal(runState.pending_approval, null);

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(decisions.length, 2);
    const human = at(decisions, 1);
    assert.equal(human.decision, "resumed");
    assert.equal(human.next_action, "resume_next_turn");
    assert.equal(human.feedback, "人工确认 lint 报错可接受");
    assert.deepEqual(human.override, {
      original_judgment_ref: JUDGMENT_REF,
      reason:
        "human approved; run resumes with the human response carried back (03: needs_human → active)",
      feedback: "人工确认 lint 报错可接受",
    });

    const changes = bus.ofType("loop-state-changed");
    assert.equal(changes.length, 2);
    assert.equal(at(changes, 1).from_state, "needs_human");
    assert.equal(at(changes, 1).to_state, "active");

    // approve 恢复执行：触发 resume signal（run service 续跑），不释放注册
    assert.deepEqual(
      resumes.map((s) => [s.runId, s.cause, s.feedback]),
      [["run-1", "human_approve", "人工确认 lint 报错可接受"]],
    );
    assert.deepEqual(resolved, []);
  });
});

test("run-decision-required: recommended 按 next_action 映射, diff_summary 透传", async () => {
  // complete → approve; diff_summary 透传
  await withFixture(async ({ controlPlane, bus }) => {
    const stat = " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+)";
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: true,
        }),
        diffSummary: stat,
      }),
    );
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.recommended, "approve");
    assert.equal(payload.diff_summary, stat);
  });

  // retry → request_changes
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(
      applyInput({
        judgment: retryableJudgment({ requires_human: true }),
      }),
    );
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.recommended, "request_changes");
  });

  // stop → reject (next_action 枚举无 failed, stop 承载判停推荐)
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({ next_action: "stop" }),
      }),
    );
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.recommended, "reject");
  });

  // needs_human / escalate → manual_review; 无 diffSummary 则字段缺省
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(applyInput());
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.recommended, "manual_review");
    assert.equal(payload.diff_summary, undefined);
  });
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({ next_action: "escalate" }),
      }),
    );
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.recommended, "manual_review");
  });

  // 硬闸门升级是人工裁决场景: 不发 recommended (不给误导性默认动作)
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
        policyEscalation: {
          action: "merge",
          reason: "protected branch",
          policyRef: "policy://hard-gate/merge",
        },
        diffSummary: " src/a.ts | 2 +-",
      }),
    );
    const payload = at(bus.ofType("run-decision-required"), 0);
    assert.equal(payload.action, "merge");
    assert.equal(payload.recommended, undefined);
    // diff_summary 与 recommended 解耦: 有摘要仍透传
    assert.equal(payload.diff_summary, " src/a.ts | 2 +-");
  });
});

test("repeated blocker: second unchanged approve is rejected unless human adds new direction", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    const blocker = makeJudgment({
      evidence: ["artifact://run-1/collector-report.json"],
      unresolved_risks: ["GitHub auth missing: GH_TOKEN/GITHUB_TOKEN absent"],
    });

    const first = await controlPlane.applyJudgment(
      applyInput({ judgment: blocker }),
    );
    assert.equal(first.state, "needs_human");
    assert.ok(first.entry.blocker_fingerprint);
    assert.equal(first.entry.repeated_blocker_count, 1);

    const approved = await controlPlane.submitDecision("run-1", "approve");
    assert.equal(approved.state, "active");
    assert.equal(resumes.length, 1);

    const begin = await controlPlane.beginTurn("run-1", 2);
    assert.equal(begin.ok, true);

    const second = await controlPlane.applyJudgment(
      applyInput({
        turn: 2,
        judgment: blocker,
      }),
    );
    assert.equal(second.state, "needs_human");
    assert.equal(
      second.entry.blocker_fingerprint,
      first.entry.blocker_fingerprint,
    );
    assert.equal(second.entry.repeated_blocker_count, 2);

    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_decision",
    );

    const changed = await controlPlane.submitDecision(
      "run-1",
      "request_changes",
      "I added GH_TOKEN in the server environment; retry with gh auth status first.",
    );
    assert.equal(changed.state, "active");

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const secondNeedsHuman = decisions.find(
      (entry) => entry.decision_id === "decision-run-1-t2-needs_human",
    );
    assert.equal(secondNeedsHuman?.repeated_blocker_count, 2);
    assert.match(secondNeedsHuman?.reason ?? "", /repeated blocker/i);
  });
});

test("request_changes → active with feedback injected; feedback required", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
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
    // 阶段 2：request_changes → active（feedback 注入下一轮上下文）
    assert.equal(runState.state, "active");

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const human = at(decisions, 1);
    assert.equal(human.decision, "resumed");
    assert.equal(human.feedback, "请先修掉 lint 再交付");
    assert.equal(human.override?.original_judgment_ref, JUDGMENT_REF);

    assert.deepEqual(
      resumes.map((s) => [s.cause, s.feedback]),
      [["human_request_changes", "请先修掉 lint 再交付"]],
    );
  });
});

test("human reject → failed with override; resolved listeners fire (release)", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    const resolved: [string, string][] = [];
    controlPlane.onRunResolved((runId, state) => resolved.push([runId, state]));
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(applyInput());
    const runState = await controlPlane.submitDecision("run-1", "reject");
    assert.equal(runState.state, "failed");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, 1).decision, "failed");
    assert.equal(
      at(decisions, 1).override?.original_judgment_ref,
      JUDGMENT_REF,
    );
    assert.deepEqual(resolved, [["run-1", "failed"]]);
    assert.deepEqual(resumes, []);
  });
});

test("human pause → paused; resumePaused → active with resume signal (恢复只需信号)", async () => {
  await withFixture(async ({ controlPlane, ledgerStore, stateStore }) => {
    const resumes: ResumeSignal[] = [];
    controlPlane.onResumeRequested((signal) => resumes.push(signal));

    await controlPlane.applyJudgment(applyInput());
    const pausedState = await controlPlane.submitDecision(
      "run-1",
      "pause",
      "明天再看",
    );
    assert.equal(pausedState.state, "paused");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, 1).decision, "paused");
    assert.equal(at(decisions, 1).next_action, "wait_for_resume_signal");
    assert.equal(at(decisions, 1).override, undefined);
    // pause 不触发 resume / resolve
    assert.equal(resumes.length, 0);

    // paused → active（恢复信号，不携带人工响应）
    const resumed = await controlPlane.resumePaused("loop-1");
    assert.equal(resumed.state, "active");
    assert.deepEqual(
      resumes.map((s) => [s.runId, s.cause]),
      [["run-1", "resume_signal"]],
    );
    assert.equal(
      at(await ledgerStore.readDecisionEntries("run-1"), 2).decision,
      "resumed",
    );

    // 非 paused 状态 resume → invalid_state（非法转移拒绝）
    await assert.rejects(
      () => controlPlane.resumePaused("loop-1"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );
    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "active");
  });
});

test("illegal transition via applyJudgment on a terminal run is rejected", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    // complete 是终态：turn 2 的判定无处可去 → IllegalTransitionError
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
    // 非法转移不落账
    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
  });
});

test("decision on a non-waiting run → invalid_state; unknown run → run_not_found", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    // A run that completed (not needs_human)
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

    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
  });
});

test("waiting runs survive a control-plane restart (state-file scan fallback)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-control-plane-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const first = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    await first.applyJudgment(applyInput());

    // New instance (fresh memory) over the same files
    const bus = new FakeEventBus();
    const second = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const resumes: ResumeSignal[] = [];
    second.onResumeRequested((signal) => resumes.push(signal));
    // 阶段 2：approve → active（恢复执行），不再直接 complete
    const runState = await second.submitDecision("run-1", "approve", "ok");
    assert.equal(runState.state, "active");
    assert.equal(bus.ofType("loop-state-changed").length, 1);
    assert.deepEqual(
      resumes.map((s) => [s.runId, s.cause]),
      [["run-1", "human_approve"]],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("beginTurn on an unknown run → run_not_found", async () => {
  await withFixture(async ({ controlPlane }) => {
    await assert.rejects(
      () => controlPlane.beginTurn("run-ghost", 2),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "run_not_found",
    );
  });
});

test("run-state store tolerates a corrupt state file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-state-"));
  try {
    const stateStore = new RunStateStore({ dataDir });
    const stateDir = join(dataDir, "loops", "state");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(stateDir, { recursive: true }),
    );
    await writeFile(join(stateDir, "bad-loop.json"), "{{{not json\n");
    assert.equal(await stateStore.load("bad-loop"), null);
    assert.deepEqual(await stateStore.list(), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loop-budget-warning: budget 消耗越过 80% 阈值广播, 一次/run/字段 (03)", async () => {
  await withFixture(async ({ controlPlane, bus }) => {
    // 阈值之下: turn 1/3 = 33%, 不告警
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
    assert.equal(bus.ofType("loop-budget-warning").length, 0);

    // 越过阈值: turn 2/2 = 100% → max_turns 告警
    await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-w2",
        runId: "run-w2",
        turn: 2,
        budget: {
          max_tokens: 0,
          max_time_minutes: 30,
          max_turns: 2,
          max_retries: 1,
        },
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    const warnings = bus.ofType("loop-budget-warning");
    assert.equal(warnings.length, 1);
    assert.equal(at(warnings, 0).near_limit, "max_turns");
    assert.equal(at(warnings, 0).turns_used, 2);
    assert.equal(at(warnings, 0).max_turns, 2);
    assert.equal(at(warnings, 0).run_id, "run-w2");

    // retry 判定消耗 retry 预算: used_retries 1/1 = 100% → max_retries 告警
    await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-w3",
        runId: "run-w3",
        turn: 1,
        budget: {
          max_tokens: 0,
          max_time_minutes: 30,
          max_turns: 5,
          max_retries: 1,
        },
        judgment: retryableJudgment(),
      }),
    );
    const retryWarnings = bus.ofType("loop-budget-warning");
    assert.equal(retryWarnings.length, 2);
    assert.equal(at(retryWarnings, 1).near_limit, "max_retries");
    assert.equal(at(retryWarnings, 1).retries_used, 1);
  });
});

test("loop-budget-warning: token usage crossing LOOP_TOKEN_ALERT_RATIO emits max_tokens warning", async () => {
  await withFixture(async ({ controlPlane, bus }) => {
    await controlPlane.applyJudgment(
      applyInput({
        budget: { ...DEFAULT_BUDGET, max_tokens: 10 },
        usage: { tokens: 9, timeMinutes: 1 },
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    const warnings = bus.ofType("loop-budget-warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.near_limit, "max_tokens");
    assert.equal(warnings[0]?.tokens_used, 9);
    assert.equal(warnings[0]?.max_tokens, 10);
  });
});

test("stop_rules.repetition.max_same_failure: 同一阻断重复超过上限即停 (02 §2)", async () => {
  await withFixture(async ({ controlPlane }) => {
    const stopRules = { repetition: { max_same_failure: 2 } };
    const sameFailure = makeJudgment(); // 同一指纹 (unresolved_risks 相同)

    // 第 1 次阻断: needs_human (count=1)
    const t1 = await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-stop",
        runId: "run-stop",
        turn: 1,
        judgment: sameFailure,
        stopRules,
      }),
    );
    assert.equal(t1.state, "needs_human");
    await controlPlane.submitDecision(
      "run-stop",
      "request_changes",
      "try a different fix",
    );

    // 第 2 次同一阻断: 仍 needs_human (count=2, 未超上限)
    const t2 = await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-stop",
        runId: "run-stop",
        turn: 2,
        judgment: sameFailure,
        stopRules,
      }),
    );
    assert.equal(t2.state, "needs_human");
    await controlPlane.submitDecision(
      "run-stop",
      "request_changes",
      "try a different fix",
    );

    // 第 3 次同一阻断: count=3 > max_same_failure=2 → 打断循环, 终态 failed
    const t3 = await controlPlane.applyJudgment(
      applyInput({
        loopId: "loop-stop",
        runId: "run-stop",
        turn: 3,
        judgment: sameFailure,
        stopRules,
      }),
    );
    assert.equal(t3.state, "failed");
    assert.match(t3.entry.reason, /max_same_failure=2/);
    assert.match(t3.entry.reason, /recurred 3 times/);

    // 无 stopRules 的 run: 同一阻断第 3 次仍走 needs_human (行为对照)
    const u1 = await controlPlane.applyJudgment(
      applyInput({ loopId: "loop-nostop", runId: "run-nostop", turn: 1 }),
    );
    assert.equal(u1.state, "needs_human");
    await controlPlane.submitDecision(
      "run-nostop",
      "request_changes",
      "try a different fix",
    );
    await controlPlane.applyJudgment(
      applyInput({ loopId: "loop-nostop", runId: "run-nostop", turn: 2 }),
    );
    await controlPlane.submitDecision(
      "run-nostop",
      "request_changes",
      "try a different fix",
    );
    const u3 = await controlPlane.applyJudgment(
      applyInput({ loopId: "loop-nostop", runId: "run-nostop", turn: 3 }),
    );
    assert.equal(u3.state, "needs_human");
  });
});

test("same loop, next run: stale terminal record does not poison the new run (smoke finding)", async () => {
  await withFixture(async ({ controlPlane, stateStore }) => {
    // 第一个 run 完成 → run_state 留下终态记录
    const first = await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    assert.equal(first.state, "complete");

    // 同一 loop 的第二个 run: 不得因上个 run 的 complete 记录而
    // complete -> complete 非法转移; 预算消耗不泄漏
    const second = await controlPlane.applyJudgment(
      applyInput({
        runId: "run-2",
        turn: 1,
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
          requires_human: false,
        }),
      }),
    );
    assert.equal(second.state, "complete");
    const record = await stateStore.load("loop-1");
    assert.equal(record?.run_id, "run-2");
    assert.equal(record?.budget?.used_turns, 1);
    assert.equal(record?.budget?.used_time_minutes, 1);
  });
});
