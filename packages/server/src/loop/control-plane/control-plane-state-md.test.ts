import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  BudgetLimits,
  JudgmentReport,
  LoopCard,
} from "@yep-anywhere/shared";
import { LoopCardStore } from "../state/loop-card-store.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import { ControlPlane } from "./control-plane.js";
import { RunStateStore } from "./run-state-store.js";

const DEFAULT_BUDGET: BudgetLimits = {
  max_tokens: 0,
  max_time_minutes: 30,
  max_turns: 3,
  max_retries: 2,
};

function makeCard(id: string, workspacePath: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run-1/verifier-reports.json"],
  unresolved_risks: [],
};

test("接线: applyJudgment 迁移后原 workspace 的 .loop/STATE.md 被整体重写", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cp-state-md-data-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "yep-cp-state-md-ws-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-1", workspacePath));
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      loopCardStore,
    });

    const result = await controlPlane.applyJudgment({
      loopId: "loop-1",
      runId: "run-1",
      turn: 1,
      goalId: "intent-1",
      workspaceRef: "workspace://loop-1/run-1",
      executionOk: true,
      verificationRan: true,
      judgment: PASSED_JUDGMENT,
      judgmentRef: "artifact://run-1/judgment-report.json",
      createdAt: new Date().toISOString(),
      budget: DEFAULT_BUDGET,
      usage: { tokens: null, timeMinutes: 1 },
    });
    assert.equal(result.state, "complete");
    // 投影是 fire-and-forget (只发不等), 测试经 settle hook 等它落盘
    await controlPlane.settleStateMdProjections();

    const content = await readFile(
      join(workspacePath, ".loop", "STATE.md"),
      "utf-8",
    );
    assert.match(content, /\*\*loop_id\*\*: loop-1/);
    assert.match(content, /\*\*run_id\*\*: run-1/);
    assert.match(content, /\*\*state\*\*: complete/);
    assert.match(content, /\*\*turn\*\*: 1/);
    assert.match(content, /\| turns \| 1 \| 3 \|/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("接线: pauseActive 迁移同样触发投影 (transition 统一出口)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cp-state-md-data-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "yep-cp-state-md-ws-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-1", workspacePath));
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
      loopCardStore,
    });

    await controlPlane.pauseActive("loop-1", {
      runId: "run-1",
      turn: 1,
      goalId: "intent-1",
      workspaceRef: "workspace://loop-1/run-1",
      budget: DEFAULT_BUDGET,
      createdAt: new Date().toISOString(),
      sessionRef: "session-xyz",
    });
    await controlPlane.settleStateMdProjections();

    const content = await readFile(
      join(workspacePath, ".loop", "STATE.md"),
      "utf-8",
    );
    assert.match(content, /\*\*state\*\*: paused/);
    assert.match(content, /session-xyz/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  }
});
