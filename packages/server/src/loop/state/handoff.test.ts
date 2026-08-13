import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type LoopCard,
  MachineStateSchema,
  type RunStateRecord,
} from "@yep-anywhere/shared";
import type { RunExecutionContext } from "../run/types.js";
import { writeDualTrackHandoff } from "./handoff.js";
import { RunLedgerStore } from "./run-ledger-store.js";

function makeRunState(): RunStateRecord {
  return {
    version: 2,
    goal_id: "g",
    run_id: "run-1",
    state: "retry",
    turn: 2,
    intent_version: 1,
    workspace_ref: "workspace://loop-1/run-1",
    last_judgment: "artifact://run-1/judgment-report.json",
    pending_approval: null,
    session_ref: "session-1",
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 3,
      max_retries: 2,
      used_tokens: 0,
      used_time_minutes: 0,
      used_turns: 2,
      used_retries: 1,
    },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

function makeCtx(): RunExecutionContext {
  const card = {
    loop: {
      id: "loop-1",
      trigger: { type: "manual" },
      workspace: {
        strategy: "direct",
        path: "C:\\Users\\alice\\repo",
      },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  } as LoopCard;
  return {
    active: {
      runId: "run-1",
      loopId: "loop-1",
      source: "manual",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    card,
    contract: {
      raw_goal: "scan repo for TODO",
      intent_id: "intent-1",
      source: "cli",
      task_type: {
        primary: "maintenance",
        confidence: 0.8,
        requires_clarification: false,
      },
      outcome: "report",
      success_criteria: ["report"],
      constraints: [],
      security_level: "read_only",
      budget: {
        max_tokens: 0,
        max_time_minutes: 30,
        max_turns: 3,
        max_retries: 2,
      },
    },
    contractJson: "{}",
    input: null,
    turn: 2,
    sessionRef: "session-1",
    lastJudgment: {
      overall: "inconclusive",
      next_action: "needs_human",
      retryable: false,
      requires_human: true,
      evidence: [],
      unresolved_risks: ["API_KEY=sk-abcdef1234567890"],
    },
    lastJudgmentRef: "artifact://run-1/judgment-report.json",
    pendingContext: null,
    policyEscalations: [],
    permissionEvents: [],
    memoryPacketJson: null,
    workspaceEvidence: null,
    taskPlan: null,
    workingState: null,
    currentSubtaskIndex: 0,
    recentTurnOutputHashes: [],
    recentTurnDiffStatHashes: [],
    recentBlockerFingerprints: [],
  };
}

async function withTempDir(
  fn: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-handoff-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("dual-track handoff writes AU2 eight sections and machine state", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const refs = await writeDualTrackHandoff(
      { runLedgerStore: store },
      makeCtx(),
      {
        runStateRecord: makeRunState(),
        checkpointEventId: "checkpoint-1",
        workspaceSnapshot: { head: "abc", status: "" },
        executionError: null,
      },
    );
    const human = await store.readArtifact("run-1", "human-report.md");
    assert.ok(human);
    for (const heading of [
      "## 1. 背景上下文",
      "## 2. 關鍵決策",
      "## 3. 工具使用記錄",
      "## 4. 用戶意圖演進",
      "## 5. 執行結果匯總",
      "## 6. 錯誤與解決",
      "## 7. 未解決問題",
      "## 8. 後續計劃",
    ]) {
      assert.ok(human.includes(heading), `missing ${heading}`);
    }
    assert.match(human, /- \*\*turn 2 \/ retry\*\*/);
    assert.ok(human.includes("artifact://run-1/judgment-report.json"));
    assert.ok(!human.includes("C:\\Users\\alice\\repo"));
    assert.ok(!human.includes("sk-abcdef1234567890"));

    const machineJson = await store.readArtifact("run-1", "machine-state.json");
    assert.ok(machineJson);
    const machine = MachineStateSchema.parse(JSON.parse(machineJson));
    assert.equal(machine.record.run_id, "run-1");
    assert.equal(machine.checkpoint_event_id, "checkpoint-1");
    assert.equal(machine.working_state_ref, null);
    assert.equal(refs.humanReportRef, "artifact://run-1/human-report.md");
    assert.equal(refs.machineStateRef, "artifact://run-1/machine-state.json");
  });
});

test("dual-track handoff references working-state.json when present", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const ctx = makeCtx();
    ctx.workingState = {
      schema_version: 1,
      run_id: "run-1",
      updated_at: "2026-08-13T00:00:00.000Z",
      turn: 2,
      selected_subject: {
        repository: "owner/repo",
        clone_path: "C:/data/repo",
      },
      subtask_status: [],
    };
    await writeDualTrackHandoff({ runLedgerStore: store }, ctx, {
      runStateRecord: makeRunState(),
      checkpointEventId: null,
      workspaceSnapshot: null,
      executionError: null,
    });
    const machineJson = await store.readArtifact("run-1", "machine-state.json");
    assert.ok(machineJson);
    const machine = MachineStateSchema.parse(JSON.parse(machineJson));
    assert.equal(
      machine.working_state_ref,
      "artifact://run-1/working-state.json",
    );
  });
});
