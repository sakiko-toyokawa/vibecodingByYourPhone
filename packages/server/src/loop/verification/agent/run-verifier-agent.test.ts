import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../../contract/intent-contract.js";
import type { RunExecutionContext } from "../../run/types.js";
import { RunLedgerStore } from "../../state/run-ledger-store.js";
import { runVerifierAgent } from "./run-verifier-agent.js";

function makeCtx(workspacePath: string, runId: string): RunExecutionContext {
  const card = {
    loop: {
      id: "loop-agent",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["review"] },
      persistence: { state_file: "state/loop-agent.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  } as LoopCard;
  const contract = buildIntentContract(card, { runId, source: "manual" });
  return {
    active: {
      runId,
      loopId: "loop-agent",
      source: "manual",
      createdAt: new Date().toISOString(),
    },
    card,
    contract,
    contractJson: null,
    input: null,
    turn: 1,
    sessionRef: null,
    lastJudgment: null,
    lastJudgmentRef: null,
    pendingContext: null,
    policyEscalations: [],
    permissionEvents: [],
    taskPlan: null,
    currentSubtaskIndex: 0,
    recentTurnOutputHashes: [],
    recentTurnDiffStatHashes: [],
    recentBlockerFingerprints: [],
  };
}

test("runVerifierAgent: 無 assembled input 時回 inconclusive, 輸出落盤", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-agent-"));
  const workspace = await mkdtemp(join(tmpdir(), "yep-agent-ws-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    const runId = "run-agent-1";
    const report = await runVerifierAgent(
      {
        // 不會被叫到（ctx.input 為 null 提前短路）
        supervisor: {} as never,
        runLedgerStore: store,
        watchProcess: async () => ({ ok: false, finalText: "" }),
      },
      makeCtx(workspace, runId),
      {
        contract: makeCtx(workspace, runId).contract as never,
        runId,
        turn: 1,
        workspacePath: workspace,
        priorReports: [],
        evidenceRefs: {
          diff: null,
          stdout: null,
          runtime_events: null,
          executor_summary: null,
        },
      },
    );
    assert.equal(report.status, "inconclusive");
    assert.equal(report.recommendation, "escalate");
    // 輸入包與輸出都有落盤（可審計）
    assert.ok(
      (await store.readArtifact(runId, "verifier-agent-input.json")) !==
        undefined,
    );
    assert.ok(
      (await store.readArtifact(runId, "verifier-agent-output.log")) !==
        undefined,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("runVerifierAgent: 合法 JSON 輸出解析為 verdict", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-agent-"));
  const workspace = await mkdtemp(join(tmpdir(), "yep-agent-ws-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    const runId = "run-agent-2";
    const ctx = makeCtx(workspace, runId);
    // 模擬有 assembled input（最小欄位）
    ctx.input = {
      cwd: workspace,
      permissions: {},
      env: {},
      adapterPolicy: undefined,
      nativeInvocation: { timeout_seconds: null },
    } as never;
    const verdict = JSON.stringify({
      status: "passed",
      recommendation: "stop",
      confidence: 0.9,
    });
    const report = await runVerifierAgent(
      {
        supervisor: {
          startSession: async () => ({ fake: true }),
        } as never,
        runLedgerStore: store,
        watchProcess: async () => ({ ok: true, finalText: verdict }),
      },
      ctx,
      {
        contract: ctx.contract as never,
        runId,
        turn: 1,
        workspacePath: workspace,
        priorReports: [],
        evidenceRefs: {
          diff: null,
          stdout: null,
          runtime_events: null,
          executor_summary: null,
        },
      },
    );
    assert.equal(report.status, "passed");
    assert.equal(report.recommendation, "stop");
    assert.equal(report.verifier_phase, "review");
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});
