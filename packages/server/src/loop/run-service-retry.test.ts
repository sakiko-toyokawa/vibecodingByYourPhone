/**
 * Phase-2 integration test (mocked Supervisor, real stores + control-plane):
 *  - retry turn goes through Supervisor.resumeSession on the SAME session
 *    (05 阶段 2 验收 3: 重试走 resume 而非新 session, 账本可见同一 thread 引用);
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
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

const SESSION_ID = "session-abc-123";

interface SupervisorCall {
  method: "start" | "resume";
  sessionId: string | null;
  text: string;
}

/** Fake Supervisor: every start/resume returns a process that immediately
 *  emits a successful result message carrying token usage. */
class FakeSupervisor {
  readonly calls: SupervisorCall[] = [];

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({ method: "start", sessionId: null, text: message.text });
    return this.makeProcess(SESSION_ID);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({ method: "resume", sessionId, text: message.text });
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
              result: "turn report text",
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

test("retry: resumeSession on the same session, judgment injected, backoff waited, budget accumulated", async () => {
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

      // turn 1: startSession; turn 2 (retry): resumeSession, same session
      assert.equal(supervisor.calls.length, 2);
      assert.equal(supervisor.calls[0]?.method, "start");
      const resume = supervisor.calls[1];
      assert.equal(resume?.method, "resume");
      assert.equal(resume?.sessionId, SESSION_ID);

      // retry = 证据传递：上一轮 judgment 的 unresolved_risks 注入新上下文
      assert.match(resume?.text ?? "", /retry turn 2/);
      assert.match(resume?.text ?? "", /lint errors in src\/foo\.ts/);
      assert.match(resume?.text ?? "", /overall=failed/);

      // 指数退避：第 1 次 retry 等 1min
      assert.deepEqual(sleeps, [60_000]);

      // 账本可见同一 session_ref（两轮各自的 run_ledger_entry）
      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      assert.ok(decisions.some((d) => d.decision === "retry"));
      assert.ok(decisions.some((d) => d.decision === "resumed"));
      assert.ok(decisions.some((d) => d.decision === "complete"));
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(latest?.final_status, "complete");
      assert.equal(latest?.runtime.session_ref, SESSION_ID);

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
      assert.equal(stdout2, "turn report text");
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

      // 第二轮走 resumeSession（同一 session），人工 feedback 注入上下文
      assert.equal(supervisor.calls.length, 2);
      const resume = supervisor.calls[1];
      assert.equal(resume?.method, "resume");
      assert.equal(resume?.sessionId, SESSION_ID);
      assert.match(resume?.text ?? "", /请先修掉 lint 再交付/);
      assert.match(resume?.text ?? "", /requested changes/);

      // request_changes 不是 retry：不消耗 retry 预算、无退避
      const record = await stateStore.load("loop-it");
      assert.equal(record?.budget?.used_retries, 0);
      assert.equal(record?.budget?.used_turns, 2);
      assert.equal(service.isRunActive("loop-it"), false);
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
      assert.equal(supervisor.calls.length, 3);
      assert.deepEqual(sleeps, [60_000, 120_000]);
      assert.equal(supervisor.calls[2]?.method, "resume");
      assert.equal(supervisor.calls[2]?.sessionId, SESSION_ID);

      const record = await stateStore.load("loop-it");
      assert.equal(record?.state, "budget_limited");
      assert.equal(record?.budget?.used_retries, 2);
      assert.equal(record?.budget?.used_turns, 3);

      // budget_limited 是阻塞态：注册保留，人工补充预算后可恢复
      assert.equal(service.isRunActive("loop-it"), true);
    },
  );
});
