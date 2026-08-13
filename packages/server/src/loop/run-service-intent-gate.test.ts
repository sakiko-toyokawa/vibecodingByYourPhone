/**
 * P5 意圖閘門集成測試：card 開啟 intent_understanding.use_agent 時,
 * 意圖理解 Agent 產生的合約草案必須先過人工確認 —— run 在首輪執行前
 * 泊入 needs_human (turn 0 閘門), approve 視為確認並以 turn 1 起步續跑,
 * 合約快照的 confirmed_by_human 隨之翻轉。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  JudgmentReport,
  LoopCard,
  PermissionMode,
  RunState,
} from "@yep-anywhere/shared";
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
import type {
  VerifyRunInput,
  VerifyRunResult,
} from "./verification/verify-run.js";

const WS = "/tmp/loop-intent-gate-ws";

const INTENT_JSON = JSON.stringify({
  understanding_summary: "掃描並報告 TODO",
  outcome: "產出 TODO 掃描報告",
  success_criteria: ["報告產出", "工作區無改動"],
  constraints: [],
  task_type: { primary: "read_only_report", confidence: 0.9 },
  target_files: [],
  assumptions: [],
  clarification_questions: [],
});

const TURN_REPORT = [
  "1. Done",
  "2. Report written",
  EXECUTOR_SUMMARY_BEGIN,
  "- 已完成：turn completed",
  "- 風險：none",
  "- 文件：none",
  EXECUTOR_SUMMARY_END,
].join("\n");

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: [],
  unresolved_risks: [],
};

/** 依 prompt 內容分身的假 supervisor：意圖理解 prompt 回合約 JSON,
 *  其餘 (executor/collector) 回通用報告。 */
class IntentGateSupervisor {
  readonly prompts: string[] = [];

  async startSession(
    _cwd: string,
    message: { text: string },
    _mode?: PermissionMode,
  ): Promise<Process> {
    this.prompts.push(message.text);
    const isIntent = message.text.includes("意圖理解 Agent");
    return this.makeProcess(isIntent ? INTENT_JSON : TURN_REPORT);
  }

  async resumeSession(sessionId: string): Promise<Process> {
    return this.makeProcess(TURN_REPORT, sessionId);
  }

  private makeProcess(text: string, sessionId = "session-intent-1"): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => {
          listener({
            type: "message",
            message: { type: "assistant", message: { content: [] } },
          });
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: text,
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

function makeCard(): LoopCard {
  return {
    loop: {
      id: "loop-intent-gate",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      handoff: { task: "掃描 workspace 裡的 TODO 並報告" },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-intent-gate.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      intent_understanding: { use_agent: true },
    },
  } as LoopCard;
}

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

test("P5: agent 合約未確認 → 首輪前泊 needs_human; approve 後以 turn 1 續跑並翻轉確認旗標", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-intent-gate-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
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
    const supervisor = new IntentGateSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: (async (_input: VerifyRunInput) => ({
        reports: [],
        judgment: PASSED_JUDGMENT,
        refs: {
          verification_input: "artifact://run/verification-input.json",
          verifier_runtime: "verifier-runtime://subprocess:static",
          verifier_report: "artifact://run/verifier-reports.json",
          judgment_report: "artifact://run/judgment-report.json",
        },
      })) as never,
      dataDir,
    });

    const summary = await service.startRun("loop-intent-gate", "manual");

    // 首輪執行前就泊入 needs_human (turn 0 閘門)
    const state = await waitForState(controlPlane, summary.run_id, [
      "needs_human",
    ]);
    assert.equal(state, "needs_human");

    // 只有意圖理解 Agent 的 session 被啟動, executor 還沒跑
    assert.equal(supervisor.prompts.length, 1);
    assert.match(supervisor.prompts[0] ?? "", /意圖理解 Agent/);

    // 合約快照落盤且未確認
    const contractJson = await ledgerStore.readArtifact(
      summary.run_id,
      "intent-contract.json",
    );
    assert.ok(contractJson, "contract snapshot written");
    const contract = JSON.parse(contractJson);
    assert.equal(contract.intent_understanding.generated_by, "agent");
    assert.equal(contract.intent_understanding.confirmed_by_human, false);
    assert.equal(contract.outcome, "產出 TODO 掃描報告");

    // run_state 是閘門輪 (turn 0)
    const runState = await controlPlane.getRunState("loop-intent-gate");
    assert.equal(runState?.turn, 0);
    assert.equal(runState?.state, "needs_human");
    assert.ok(runState?.pending_approval);

    // 人工 approve = 確認合約 → run 以 turn 1 起步續跑直至完成
    await controlPlane.submitDecision(summary.run_id, "approve");
    const finalState = await waitForState(controlPlane, summary.run_id, [
      "complete",
    ]);
    assert.equal(finalState, "complete");

    // executor session 在 approve 後才啟動
    assert.ok(
      supervisor.prompts.some((text) => !text.includes("意圖理解 Agent")),
      "executor session started after approval",
    );

    // 確認旗標已翻轉並回寫快照
    const confirmed = JSON.parse(
      (await ledgerStore.readArtifact(
        summary.run_id,
        "intent-contract.json",
      )) ?? "",
    );
    assert.equal(confirmed.intent_understanding.confirmed_by_human, true);

    // 決策賬本: 閘門 needs_human + 人工 resumed
    const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
    assert.ok(decisions.some((d) => d.decision === "needs_human"));
    assert.ok(decisions.some((d) => d.decision === "resumed"));
  } finally {
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
