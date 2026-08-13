/**
 * Phase-2 integration test (mocked Supervisor, real stores + control-plane):
 *  - retry turn opens a fresh session via Supervisor.startSession
 *    (Loop Engineering: 每轮新 session + AU2 handoff);
 *  - the previous turn's judgment (unresolved_risks / evidence) is injected
 *    into the retry turn's context (retry = 证据传递);
 *  - the exponential backoff is waited between turns (sleep injected);
 *  - budget consumption accumulates per turn in run_state;
 *  - needs_human → request_changes resumes the run via the decision
 *    endpoint path (approve/request_changes → active, 阶段 2 完整迁移表).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport, LoopCard, RunState } from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  EXECUTOR_SUMMARY_BEGIN,
  EXECUTOR_SUMMARY_END,
} from "./assembly/runtime-input.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

interface SupervisorCall {
  method: "start" | "resume";
  role: "executor" | "collector";
  sessionId: string | null;
  text: string;
}

let sessionCounter = 0;

/** Fake Supervisor: every start/resume returns a process that immediately
 *  emits a successful result message carrying token usage. */
class FakeSupervisor {
  readonly calls: SupervisorCall[] = [];

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    const sessionId = `session-abc-${++sessionCounter}`;
    this.calls.push({
      method: "start",
      role: message.text.includes("Collector input bundle")
        ? "collector"
        : "executor",
      sessionId,
      text: message.text,
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
      role: "executor",
      sessionId,
      text: message.text,
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
              result: [
                "turn report text",
                EXECUTOR_SUMMARY_BEGIN,
                "- 已完成：turn completed",
                "- 風險：none",
                "- 文件：none",
                EXECUTOR_SUMMARY_END,
              ].join("\n"),
              is_error: false,
              // Claude SDK result message usage (02 §4)
              usage: { input_tokens: 100, output_tokens: 50 },
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

function makeCard(): LoopCard {
  return {
    loop: {
      id: "loop-it",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/loop-it-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-it.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

function judgment(overrides: Partial<JudgmentReport>): JudgmentReport {
  return {
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
    evidence: ["artifact://run/verifier-reports.json"],
    unresolved_risks: ["lint errors in src/foo.ts"],
    ...overrides,
  };
}

const RETRYABLE_JUDGMENT = judgment({});
const PASSED_JUDGMENT = judgment({
  overall: "passed",
  next_action: "complete",
  retryable: false,
  unresolved_risks: [],
});
const HUMAN_JUDGMENT = judgment({
  next_action: "needs_human",
  retryable: false,
  requires_human: true,
});

function makeVerify(judgments: JudgmentReport[]) {
  let call = 0;
  return async (): Promise<VerifyRunResult> => {
    const current = judgments[Math.min(call, judgments.length - 1)];
    call += 1;
    assert.ok(current, "verify judgments exhausted");
    return {
      reports: [],
      judgment: current,
      refs: {
        verification_input: "artifact://run/verification-input.json",
        verifier_runtime: "verifier-runtime://subprocess:static",
        verifier_report: "artifact://run/verifier-reports.json",
        judgment_report: "artifact://run/judgment-report.json",
      },
    };
  };
}

async function withFixture(
  judgments: JudgmentReport[],
  fn: (ctx: {
    service: LoopRunService;
    controlPlane: ControlPlane;
    supervisor: FakeSupervisor;
    ledgerStore: RunLedgerStore;
    stateStore: RunStateStore;
    sleeps: number[];
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-retry-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    const supervisor = new FakeSupervisor();
    const card = makeCard();
    const loopCardStore = {
      getLoop: (id: string) =>
        id === card.loop.id
          ? {
              id: card.loop.id,
              card,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              archived: false,
            }
          : undefined,
    } as LoopCardStore;
    const sleeps: number[] = [];
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      verifyRunFn: makeVerify(judgments) as never,
      loopWatchdog: {
        turnIdleTimeoutMs: 10 * 60 * 1000,
        turnIdleCheckIntervalMs: 30 * 1000,
        // Disable stagnation / idle / repeated-blocker detection so existing
        // retry budget tests are not affected by the new loop guards.
        stagnationSimilarTurnsThreshold: 100,
        idleNoProgressTurnsThreshold: 100,
        repeatedBlockerThreshold: 100,
      },
    });
    await fn({
      service,
      controlPlane,
      supervisor,
      ledgerStore,
      stateStore,
      sleeps,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Poll until the run reaches one of the expected states (or time out). */
async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 5000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = controlPlane.currentStateOf(runId);
    if (state && expected.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 等 run-service 收尾：终态在 applyJudgment 里可见，但本轮的账本 entry
 * 落账 / 注册清理在其之后（learning_refs 回填又加了一次 IO），断言账本
 * 或注册状态前必须等 executeRun 返回（终态会注销 active 注册位）。
 */
async function waitForRunSettled(
  service: LoopRunService,
  loopId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!service.isRunActive(loopId)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for run on '${loopId}' to settle`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("retry: fresh session with AU2 handoff, judgment injected, backoff waited, budget accumulated", async () => {
  await withFixture(
    [RETRYABLE_JUDGMENT, PASSED_JUDGMENT],
    async ({
      service,
      controlPlane,
      supervisor,
      ledgerStore,
      stateStore,
      sleeps,
    }) => {
      const summary = await service.startRun("loop-it", "manual");
      const finalState = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(finalState, "complete");

      // turn 1 and turn 2 (retry) both open fresh sessions.
      const executorCalls = supervisor.calls.filter(
        (call) => call.role === "executor",
      );
      assert.equal(executorCalls.length, 2);
      assert.equal(executorCalls[0]?.method, "start");
      const retry = executorCalls[1];
      assert.equal(retry?.method, "start");
      assert.ok(retry?.sessionId);
      assert.notEqual(retry?.sessionId, executorCalls[0]?.sessionId);

      // retry = 证据传递：上一轮 judgment 的 unresolved_risks 注入新上下文
      assert.match(retry?.text ?? "", /retry turn 2/);
      assert.match(retry?.text ?? "", /lint errors in src\/foo\.ts/);
      assert.match(retry?.text ?? "", /overall=failed/);
      // fresh session prompt carries the AU2 handoff from turn 1.
      assert.match(retry?.text ?? "", /## Loop turn handoff \(fresh session\)/);
      assert.match(retry?.text ?? "", /### AU2 human report/);
      assert.match(
        retry?.text ?? "",
        new RegExp(`artifact://${summary.run_id}/human-report\\.md`),
      );

      // 指数退避：第 1 次 retry 等 1min
      assert.deepEqual(sleeps, [60_000]);

      // 账本可见每轮各自的 fresh session_ref。
      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      assert.ok(decisions.some((d) => d.decision === "retry"));
      assert.ok(decisions.some((d) => d.decision === "resumed"));
      assert.ok(decisions.some((d) => d.decision === "complete"));
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(latest?.final_status, "complete");
      assert.equal(latest?.runtime.session_ref, retry?.sessionId);

      // budget 快照：两轮、一次 retry、token 来自 usage（100+50）× 2
      const record = await stateStore.load("loop-it");
      assert.equal(record?.state, "complete");
      assert.equal(record?.budget?.used_turns, 2);
      assert.equal(record?.budget?.used_retries, 1);
      assert.equal(record?.budget?.used_tokens, 300);
      assert.ok(
        (record?.budget?.used_time_minutes ?? 1) >= 0,
        "time budget tracked",
      );

      // 第二轮 stdout 独立成文
      const stdout2 = await ledgerStore.readArtifact(
        summary.run_id,
        "stdout-turn2.log",
      );
      assert.match(stdout2 ?? "", /turn report text/);
    },
  );
});

test("needs_human → request_changes resumes the run (active) with feedback injected into the next turn", async () => {
  await withFixture(
    [HUMAN_JUDGMENT, PASSED_JUDGMENT],
    async ({ service, controlPlane, supervisor, stateStore }) => {
      const summary = await service.startRun("loop-it", "manual");
      await waitForState(controlPlane, summary.run_id, ["needs_human"]);
      // 阻塞等待期间 run 仍占注册位（同 loop 串行）
      assert.equal(service.isRunActive("loop-it"), true);

      const resumed = await controlPlane.submitDecision(
        summary.run_id,
        "request_changes",
        "请先修掉 lint 再交付",
      );
      assert.equal(resumed.state, "active");

      const finalState = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(finalState, "complete");

      // 第二轮走 fresh session，人工 feedback 注入上下文
      const executorCalls = supervisor.calls.filter(
        (call) => call.role === "executor",
      );
      assert.equal(executorCalls.length, 2);
      const resume = executorCalls[1];
      assert.equal(resume?.method, "start");
      assert.ok(resume?.sessionId);
      assert.notEqual(resume?.sessionId, executorCalls[0]?.sessionId);
      assert.match(resume?.text ?? "", /请先修掉 lint 再交付/);
      assert.match(resume?.text ?? "", /requested changes/);
      assert.match(
        resume?.text ?? "",
        /## Loop turn handoff \(fresh session\)/,
      );

      // request_changes 不是 retry：不消耗 retry 预算、无退避
      const record = await stateStore.load("loop-it");
      assert.equal(record?.budget?.used_retries, 0);
      assert.equal(record?.budget?.used_turns, 2);
      assert.equal(service.isRunActive("loop-it"), false);
    },
  );
});

test("learning_refs.human_feedback: entries with human feedback reference the aggregated artifact (02 §8.1)", async () => {
  await withFixture(
    [HUMAN_JUDGMENT, PASSED_JUDGMENT],
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-it", "manual");
      await waitForState(controlPlane, summary.run_id, ["needs_human"]);

      // 人工反馈前的首轮 entry：尚无人工反馈，如实 [] 且不落文件。
      // needs_human 在 applyJudgment 里可见，首轮 entry 落账在其后，
      // 先等 entry 出现再断言。
      const readRunEntries = async () =>
        ((await ledgerStore.readUri(`ledger://${summary.run_id}`)) ?? "")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.type === "run_ledger_entry");
      let before: Array<Record<string, unknown>> = [];
      {
        const deadline = Date.now() + 5000;
        for (;;) {
          before = await readRunEntries();
          if (before.length >= 1) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for the turn-1 ledger entry");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(before.length, 1);
      assert.deepEqual(
        (before[0]?.learning_refs as { human_feedback: string[] })
          .human_feedback,
        [],
      );
      assert.equal(
        await ledgerStore.readArtifact(summary.run_id, "human-feedback.json"),
        undefined,
      );

      // 人工 request_changes（feedback 必填）后 run 恢复并完成
      await controlPlane.submitDecision(
        summary.run_id,
        "request_changes",
        "请先修掉 lint 再交付",
      );
      await waitForState(controlPlane, summary.run_id, ["complete"]);
      await waitForRunSettled(service, "loop-it");

      // 次轮 entry 带上 artifact 引用；首轮 entry 保持当时的如实快照 []
      const after = await readRunEntries();
      assert.equal(after.length, 2);
      assert.deepEqual(
        (after[0]?.learning_refs as { human_feedback: string[] })
          .human_feedback,
        [],
      );
      assert.deepEqual(
        (after[1]?.learning_refs as { human_feedback: string[] })
          .human_feedback,
        [`artifact://${summary.run_id}/human-feedback.json`],
      );
      assert.deepEqual(
        (after[1]?.learning_refs as { external_feedback: string[] })
          .external_feedback,
        [],
      );

      // artifact 存在，内容聚合了带 feedback / override 的决策条目
      const artifactJson = await ledgerStore.readArtifact(
        summary.run_id,
        "human-feedback.json",
      );
      assert.ok(artifactJson, "human-feedback.json artifact exists");
      const artifact = JSON.parse(artifactJson) as {
        run_id: string;
        entries: Array<{
          decision: string;
          feedback: string | null;
          override: { reason: string; feedback?: string } | null;
        }>;
      };
      assert.equal(artifact.run_id, summary.run_id);
      assert.equal(artifact.entries.length, 1);
      assert.equal(artifact.entries[0]?.feedback, "请先修掉 lint 再交付");
      assert.ok(
        artifact.entries[0]?.override,
        "override recorded for the human decision",
      );
    },
  );
});

test("retry budget exhaustion ends the run as budget_limited (no infinite repair loop)", async () => {
  await withFixture(
    // max_retries=2 用完 → 第三轮判定 retryable 但预算尽 → budget_limited
    [RETRYABLE_JUDGMENT, RETRYABLE_JUDGMENT, RETRYABLE_JUDGMENT],
    async ({ service, controlPlane, supervisor, stateStore, sleeps }) => {
      const summary = await service.startRun("loop-it", "manual");
      const finalState = await waitForState(controlPlane, summary.run_id, [
        "budget_limited",
      ]);
      assert.equal(finalState, "budget_limited");

      // 3 轮执行（首轮 + 2 次 retry），退避 1min → 2min
      const executorCalls = supervisor.calls.filter(
        (call) => call.role === "executor",
      );
      assert.equal(executorCalls.length, 3);
      assert.deepEqual(sleeps, [60_000, 120_000]);
      assert.equal(executorCalls[2]?.method, "start");
      assert.ok(executorCalls[2]?.sessionId);
      assert.notEqual(executorCalls[2]?.sessionId, executorCalls[1]?.sessionId);

      const record = await stateStore.load("loop-it");
      assert.equal(record?.state, "budget_limited");
      assert.equal(record?.budget?.used_retries, 2);
      assert.equal(record?.budget?.used_turns, 3);

      // budget_limited 是阻塞态：注册保留，人工补充预算后可恢复
      assert.equal(service.isRunActive("loop-it"), true);
    },
  );
});
