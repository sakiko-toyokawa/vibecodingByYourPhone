/**
 * Planner integration test: a run with a multi-subtask TaskPlan executes one
 * subtask per turn and does not complete until the final subtask finishes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport, LoopCard, TaskPlan } from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

let sessionCounter = 0;

class FakeSupervisor {
  readonly calls: {
    method: string;
    text: string;
    isCollector: boolean;
    sessionId: string;
  }[] = [];

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    const isCollector = message.text.startsWith("Collector input bundle:");
    const sessionId = `session-planner-${++sessionCounter}`;
    this.calls.push({
      method: "start",
      text: message.text,
      isCollector,
      sessionId,
    });
    return this.makeProcess(sessionId);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({
      method: "resume",
      text: message.text,
      isCollector: false,
      sessionId,
    });
    return this.makeProcess(sessionId);
  }

  private makeProcess(sessionId: string): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => {
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: "subtask done",
              is_error: false,
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          });
        });
        return () => {};
      },
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
  }
}

function makeCard(_plan: TaskPlan): LoopCard {
  return {
    loop: {
      id: "planner-loop",
      trigger: { type: "manual" },
      handoff: {
        task: "Create plan.md, implement src/main.js, and run tests",
      },
      workspace: { strategy: "direct", path: "/tmp/planner-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: "state/planner.json" },
      stop_rules: { max_turns: 5, max_time_minutes: 30, max_retries: 2 },
    },
  } as LoopCard;
}

function passedJudgment(): JudgmentReport {
  return {
    overall: "passed",
    next_action: "complete",
    retryable: false,
    requires_human: false,
    evidence: [],
    unresolved_risks: [],
  };
}

test("run with task plan advances through subtasks before completing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planner-run-test-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
    });

    const plan: TaskPlan = {
      plan_id: "plan-1",
      created_at: "2026-07-28T00:00:00.000Z",
      subtasks: [
        {
          id: "subtask-1",
          description: "Create plan.md",
          success_criteria: ["plan.md exists"],
          target_artifacts: ["plan.md"],
        },
        {
          id: "subtask-2",
          description: "Implement src/main.js",
          success_criteria: ["src/main.js exists"],
          target_artifacts: ["src/main.js"],
        },
        {
          id: "subtask-3",
          description: "Run tests",
          success_criteria: ["tests pass"],
          target_artifacts: [],
        },
      ],
    };

    const supervisor = new FakeSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as never,
      loopCardStore,
      runLedgerStore,
      controlPlane,
      planner: {
        planTask: async () => plan,
      } as never,
      verifyRunFn: async () =>
        ({
          judgment: passedJudgment(),
          refs: {
            verification_input: "artifact://run/verification-input.json",
            verifier_runtime: "artifact://run/verifier-report.json",
            verifier_report: "artifact://run/verifier-reports.json",
            judgment_report: "artifact://run/judgment-report.json",
          },
        }) as VerifyRunResult,
    });

    const card = makeCard(plan);
    await loopCardStore.createLoop(card);

    const run = await service.startRun(card.loop.id, "manual");
    const runId = run.run_id;

    // Wait for the run to finish.
    for (let i = 0; i < 100; i++) {
      const state = controlPlane.currentStateOf(runId);
      if (
        state &&
        ["complete", "failed", "budget_limited", "needs_human"].includes(state)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const contractJson = await runLedgerStore.readArtifact(
      runId,
      "intent-contract.json",
    );
    assert.ok(contractJson, "intent-contract.json should exist");
    const contract = JSON.parse(contractJson) as { plan?: TaskPlan };
    assert.ok(contract.plan, "contract should have a plan");
    assert.equal(contract.plan.subtasks.length, 3);

    const state = controlPlane.currentStateOf(runId);
    assert.equal(state, "complete");

    const runState = await controlPlane.getRunState(card.loop.id);
    assert.equal(runState?.turn, plan.subtasks.length);
    // 回归 (subtask_advance 修复): 推进轮不得记 phantom retry/失败归因,
    // 不得消耗 retry 预算 —— 此前实现把 judgment 篡改成 failed/retry
    // 借道 applyJudgment, 3 子任务白烧 2 次 retry 并记 verification_error。
    const decisions = await runLedgerStore.readDecisionEntries(runId);
    const advances = decisions.filter((d) => d.decision === "subtask_advance");
    assert.equal(
      advances.length,
      plan.subtasks.length - 1,
      "each non-final subtask records one truthful subtask_advance entry",
    );
    for (const entry of advances) {
      assert.equal(
        entry.failure_tags,
        undefined,
        "subtask advance carries no failure attribution (nothing failed)",
      );
    }
    assert.equal(
      decisions.filter((d) => d.decision === "retry").length,
      0,
      "no phantom retry decisions for passed subtasks",
    );
    assert.equal(
      runState?.budget?.used_retries,
      0,
      "subtask advance does not consume retry budget",
    );
    assert.equal(
      decisions.filter((d) => d.decision === "complete").length,
      1,
      "the final subtask completes the run",
    );

    // Each subtask turn should have written a ledger entry.
    const entries = await runLedgerStore.listRunIds();
    assert.equal(entries.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("subtask advance stops at max_turns (budget_limited, no overrun)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planner-budget-test-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
    });

    const plan: TaskPlan = {
      plan_id: "plan-budget",
      created_at: "2026-07-28T00:00:00.000Z",
      subtasks: [
        {
          id: "subtask-1",
          description: "Create plan.md",
          success_criteria: ["plan.md exists"],
          target_artifacts: ["plan.md"],
        },
        {
          id: "subtask-2",
          description: "Implement src/main.js",
          success_criteria: ["src/main.js exists"],
          target_artifacts: ["src/main.js"],
        },
        {
          id: "subtask-3",
          description: "Run tests",
          success_criteria: ["tests pass"],
          target_artifacts: [],
        },
      ],
    };

    const supervisor = new FakeSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as never,
      loopCardStore,
      runLedgerStore,
      controlPlane,
      planner: {
        planTask: async () => plan,
      } as never,
      verifyRunFn: async () =>
        ({
          judgment: passedJudgment(),
          refs: {
            verification_input: "artifact://run/verification-input.json",
            verifier_runtime: "artifact://run/verifier-report.json",
            verifier_report: "artifact://run/verifier-reports.json",
            judgment_report: "artifact://run/judgment-report.json",
          },
        }) as VerifyRunResult,
    });

    // max_turns=2 with 3 subtasks: the second advance (to turn 3) has no
    // turn headroom and must go budget_limited instead of overrunning.
    const card = makeCard(plan);
    card.loop.stop_rules = {
      max_turns: 2,
      max_time_minutes: 30,
      max_retries: 5,
    };
    await loopCardStore.createLoop(card);

    const run = await service.startRun(card.loop.id, "manual");
    const runId = run.run_id;

    for (let i = 0; i < 100; i++) {
      const state = controlPlane.currentStateOf(runId);
      if (
        state &&
        ["complete", "failed", "budget_limited", "needs_human"].includes(state)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(controlPlane.currentStateOf(runId), "budget_limited");
    const decisions = await runLedgerStore.readDecisionEntries(runId);
    assert.equal(
      decisions.filter((d) => d.decision === "subtask_advance").length,
      2,
      "both passed subtasks record a truthful advance entry — the " +
        "budget-guarded one too, because restart rebuild derives the " +
        "subtask index from this count",
    );
    const limited = decisions.find((d) => d.decision === "budget_limited");
    assert.ok(limited, "the second advance hits the turn-budget guard");
    assert.match(limited.reason, /max_turns/);
    assert.equal(
      limited.failure_tags,
      undefined,
      "budget guard on advance is not a failure attribution",
    );
    const runState = await controlPlane.getRunState(card.loop.id);
    assert.equal(runState?.budget?.used_retries, 0);
    assert.equal(
      runState?.budget?.used_turns,
      2,
      "used_turns counts completed turns only — the unstarted turn is not pre-recorded",
    );
    assert.equal(
      runState?.turn,
      2,
      "run state stays on the completed turn; the unstarted turn is not consumed",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function failedRetryableJudgment(): JudgmentReport {
  return {
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
    evidence: [],
    unresolved_risks: [],
  };
}

test("planner retry re-runs the same subtask instead of skipping ahead", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planner-retry-test-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
    });

    const plan: TaskPlan = {
      plan_id: "plan-retry",
      created_at: "2026-07-28T00:00:00.000Z",
      subtasks: [
        {
          id: "subtask-1",
          description: "Create plan.md",
          success_criteria: ["plan.md exists"],
          target_artifacts: ["plan.md"],
        },
        {
          id: "subtask-2",
          description: "Implement src/main.js",
          success_criteria: ["src/main.js exists"],
          target_artifacts: ["src/main.js"],
        },
      ],
    };

    const supervisor = new FakeSupervisor();
    let verifyCalls = 0;
    const service = new LoopRunService({
      supervisor: supervisor as never,
      loopCardStore,
      runLedgerStore,
      controlPlane,
      sleep: async () => {},
      planner: {
        planTask: async () => plan,
      } as never,
      verifyRunFn: async () => {
        verifyCalls += 1;
        return {
          // Turn 1 (subtask-1) fails retryable; every later turn passes.
          judgment:
            verifyCalls === 1 ? failedRetryableJudgment() : passedJudgment(),
          refs: {
            verification_input: "artifact://run/verification-input.json",
            verifier_runtime: "artifact://run/verifier-report.json",
            verifier_report: "artifact://run/verifier-reports.json",
            judgment_report: "artifact://run/judgment-report.json",
          },
        } as VerifyRunResult;
      },
    });

    const card = makeCard(plan);
    await loopCardStore.createLoop(card);

    const run = await service.startRun(card.loop.id, "manual");
    const runId = run.run_id;

    for (let i = 0; i < 100; i++) {
      const state = controlPlane.currentStateOf(runId);
      if (
        state &&
        ["complete", "failed", "budget_limited", "needs_human"].includes(state)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(controlPlane.currentStateOf(runId), "complete");

    // 回归 (turn↔subtask 解耦): retry 消耗轮次但不推进子任务 —— 重试轮
    // 必须重做 subtask-1 (轮首不再按 turn-1 同步索引, 否则 subtask-1 从未
    // 通过却被跳过, 账本还记它 passed)。collector 每轮另起 startSession,
    // executor 每轮也都开 fresh session。
    const executorCalls = supervisor.calls.filter((call) => !call.isCollector);
    assert.equal(executorCalls.length, 3, "start + retry + advance");
    const retryCall = executorCalls[1];
    const advanceCall = executorCalls[2];
    assert.ok(retryCall);
    assert.ok(advanceCall);
    assert.equal(retryCall.method, "start");
    assert.equal(advanceCall.method, "start");
    assert.notEqual(retryCall.sessionId, advanceCall.sessionId);
    assert.match(
      retryCall.text,
      /Current subtask \(subtask-1\)/,
      "the retry turn re-runs subtask-1 (retry context + subtask briefing)",
    );
    assert.match(
      advanceCall.text,
      /Current subtask \(subtask-2\)/,
      "only a passed subtask advances the plan",
    );

    const decisions = await runLedgerStore.readDecisionEntries(runId);
    assert.equal(
      decisions.filter((d) => d.decision === "retry").length,
      1,
      "the failed subtask records one real retry",
    );
    assert.equal(
      decisions.filter((d) => d.decision === "subtask_advance").length,
      1,
      "subtask-1 advances only after it actually passes",
    );
    assert.equal(decisions.filter((d) => d.decision === "complete").length, 1);
    const runState = await controlPlane.getRunState(card.loop.id);
    assert.equal(runState?.budget?.used_retries, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("requires_human judgment does not advance to the next subtask", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planner-human-test-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const runStateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore,
      runLedgerStore,
    });

    const plan: TaskPlan = {
      plan_id: "plan-human",
      created_at: "2026-07-28T00:00:00.000Z",
      subtasks: [
        {
          id: "subtask-1",
          description: "Create plan.md",
          success_criteria: ["plan.md exists"],
          target_artifacts: ["plan.md"],
        },
        {
          id: "subtask-2",
          description: "Implement src/main.js",
          success_criteria: ["src/main.js exists"],
          target_artifacts: ["src/main.js"],
        },
      ],
    };

    const supervisor = new FakeSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as never,
      loopCardStore,
      runLedgerStore,
      controlPlane,
      planner: {
        planTask: async () => plan,
      } as never,
      verifyRunFn: async () =>
        ({
          judgment: {
            ...passedJudgment(),
            // merge gate / 人工透传: passed 但要求人工复核 (02 §6 最高优先)。
            requires_human: true,
            next_action: "needs_human",
          },
          refs: {
            verification_input: "artifact://run/verification-input.json",
            verifier_runtime: "artifact://run/verifier-report.json",
            verifier_report: "artifact://run/verifier-reports.json",
            judgment_report: "artifact://run/judgment-report.json",
          },
        }) as VerifyRunResult,
    });

    const card = makeCard(plan);
    await loopCardStore.createLoop(card);

    const run = await service.startRun(card.loop.id, "manual");
    const runId = run.run_id;

    for (let i = 0; i < 100; i++) {
      const state = controlPlane.currentStateOf(runId);
      if (
        state &&
        ["complete", "failed", "budget_limited", "needs_human"].includes(state)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // 人工透传优先级最高: 中间子任务 requires_human 时必须升级等待,
    // 不得绕过人工批准直接推进下一子任务。
    assert.equal(controlPlane.currentStateOf(runId), "needs_human");
    const decisions = await runLedgerStore.readDecisionEntries(runId);
    assert.equal(
      decisions.filter((d) => d.decision === "subtask_advance").length,
      0,
      "no advance while human review is pending",
    );
    assert.equal(
      decisions.filter((d) => d.decision === "needs_human").length,
      1,
    );
    assert.equal(
      supervisor.calls.filter((c) => c.method === "resume").length,
      0,
      "the run stops at the first subtask until a human decides",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});
