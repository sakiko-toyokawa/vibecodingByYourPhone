import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentContract, LoopCard } from "@yep-anywhere/shared";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import {
  buildLoopTurnStartPrompt,
  drainPolicyEscalation,
  resolveDirectWriteAllowlist,
} from "./turn-execution.js";
import type { RunExecutionContext } from "./types.js";

function makeContext(
  overrides: {
    turn?: number;
    pendingContext?: string | null;
    taskPlan?: RunExecutionContext["taskPlan"];
    currentSubtaskIndex?: number;
  } = {},
): RunExecutionContext {
  return {
    active: {
      runId: "run-1",
      loopId: "loop-1",
      source: "manual",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    card: {} as RunExecutionContext["card"],
    contract: null,
    contractJson: null,
    input: {
      prompt: "STANDING PROMPT",
      cwd: "/tmp/workspace",
      permissionMode: "plan",
      permissions: { deny: [] },
      executionContract: {
        goal: "do the task",
        scope: ["/tmp/workspace"],
        success_criteria: ["done"],
        constraints: [],
        required_output: ["summary"],
      },
      nativeInvocation: {
        adapter: "test",
        bridge: "test",
        surface: "test",
        mode: "test",
        cwd_ref: "workspace://loop-1",
        timeout_seconds: null,
        resume_ref: null,
      },
      observability: {
        capture_stdout: true,
        capture_stderr: false,
        capture_structured_output: true,
        capture_transcript: false,
        capture_diff: true,
        capture_exit_code: true,
        capture_test_output: true,
      },
    } as RunExecutionContext["input"],
    turn: overrides.turn ?? 2,
    sessionRef: "old-session",
    lastJudgment: null,
    lastJudgmentRef: null,
    pendingContext: overrides.pendingContext ?? "fix the lint",
    policyEscalations: [],
    permissionEvents: [],
    taskPlan: overrides.taskPlan ?? null,
    workingState: null,
    waivedPhases: [],
    currentSubtaskIndex: overrides.currentSubtaskIndex ?? 0,
    recentTurnOutputHashes: [],
    recentTurnDiffStatHashes: [],
    recentBlockerFingerprints: [],
  } as unknown as RunExecutionContext;
}

function makeStore(
  artifacts: Record<string, string | undefined>,
): RunLedgerStore {
  return {
    readArtifact: async (runId: string, name: string) =>
      runId === "run-1" ? artifacts[name] : undefined,
  } as unknown as RunLedgerStore;
}

const machineState = JSON.stringify({
  schema_version: 2,
  run_id: "run-1",
  loop_id: "loop-1",
  turn: 1,
  record: {
    version: 2,
    goal_id: "intent-1",
    run_id: "run-1",
    state: "active",
    turn: 1,
    intent_version: 1,
    workspace_ref: "workspace://loop-1/run-1",
    last_judgment: null,
    pending_approval: null,
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 3,
      max_retries: 2,
      used_tokens: 10,
      used_time_minutes: 0.2,
      used_turns: 1,
      used_retries: 0,
    },
    session_ref: "session-1",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  },
  checkpoint_event_id: "checkpoint-1",
  artifact_manifest_ref: "artifact://run-1/manifest.jsonl",
  workspace_snapshot: { head: "abc", status: "clean" },
  checksum: "not-validated-here",
  created_at: "2026-08-08T00:00:00.000Z",
});

test("buildLoopTurnStartPrompt injects the AU2 handoff for turn 2", async () => {
  const store = makeStore({
    "human-report.md":
      "# Loop Handoff: loop-1 / run run-1\n\n## 8. 後續計劃\n- continue",
    "machine-state.json": machineState,
    "turn-handoff.json": JSON.stringify({
      turn: 1,
      judgment_ref: "artifact://run-1/judgment-report.json",
    }),
    "executor-summary.md": "- 已完成：scanned workspace",
  });
  const prompt = await buildLoopTurnStartPrompt(makeContext(), store);

  assert.match(prompt, /STANDING PROMPT/);
  assert.match(prompt, /## Loop turn handoff \(fresh session\)/);
  assert.match(prompt, /handoff_available: true/);
  assert.match(prompt, /### AU2 human report/);
  assert.match(prompt, /# Loop Handoff: loop-1 \/ run run-1/);
  assert.match(prompt, /artifact:\/\/run-1\/human-report\.md/);
  assert.match(prompt, /state=active/);
  assert.match(prompt, /used_turns":1/);
  assert.match(prompt, /### Previous executor summary/);
  assert.match(prompt, /scanned workspace/);
  assert.match(prompt, /fix the lint/);
});

test("buildLoopTurnStartPrompt marks missing handoff artifacts explicitly", async () => {
  const prompt = await buildLoopTurnStartPrompt(
    makeContext({ pendingContext: "resume after pause" }),
    makeStore({}),
  );

  assert.match(prompt, /handoff_available: false/);
  assert.match(prompt, /\(previous AU2 human report not available\)/);
  assert.match(prompt, /resume after pause/);
});

test("buildLoopTurnStartPrompt injects one current subtask for plan turns", async () => {
  const plan = {
    plan_id: "plan-1",
    created_at: "2026-08-08T00:00:00.000Z",
    subtasks: [
      {
        id: "subtask-1",
        description: "Discover the target",
        success_criteria: ["target selected"],
        target_artifacts: [],
      },
      {
        id: "subtask-2",
        description: "Implement the fix",
        success_criteria: ["fix applied"],
        target_artifacts: [],
      },
    ],
  } as RunExecutionContext["taskPlan"];

  const turn1 = await buildLoopTurnStartPrompt(
    makeContext({
      turn: 1,
      taskPlan: plan,
      currentSubtaskIndex: 0,
    }),
    makeStore({}),
  );
  assert.equal(turn1.match(/Current subtask \(subtask-\d\):/g)?.length ?? 0, 1);
  assert.match(turn1, /Current subtask \(subtask-1\):/);

  const turn2 = await buildLoopTurnStartPrompt(
    makeContext({
      turn: 2,
      taskPlan: plan,
      currentSubtaskIndex: 1,
    }),
    makeStore({}),
  );
  assert.equal(turn2.match(/Current subtask \(subtask-\d\):/g)?.length ?? 0, 1);
  assert.match(turn2, /Current subtask \(subtask-2\):/);
});

test("buildLoopTurnStartPrompt injects authoritative working state", async () => {
  const store = makeStore({
    "working-state.json": JSON.stringify({
      schema_version: 1,
      run_id: "run-1",
      updated_at: "2026-08-13T00:00:00.000Z",
      turn: 1,
      selected_subject: {
        repository: "owner/repo",
        clone_path: "E:/data/repo",
      },
      subtask_status: [],
    }),
  });
  const prompt = await buildLoopTurnStartPrompt(makeContext(), store);
  assert.match(prompt, /### Authoritative working state \(machine\)/);
  assert.match(prompt, /"repository":"owner\/repo"/);
  assert.match(
    prompt,
    /working_state: artifact:\/\/run-1\/working-state\.json/,
  );
});

test("github prompt with selected subject forbids re-searching issues", async () => {
  const ctx = makeContext();
  ctx.card = {
    loop: {
      id: "github-loop",
      discovery: { source: "github_prompt" },
      workspace: { strategy: "direct", path: "/tmp/github" },
    },
  } as unknown as RunExecutionContext["card"];
  const store = makeStore({
    "working-state.json": JSON.stringify({
      schema_version: 1,
      run_id: "run-1",
      updated_at: "2026-08-13T00:00:00.000Z",
      turn: 1,
      selected_subject: {
        repository: "owner/repo",
        clone_path: "E:/data/repo",
      },
      subtask_status: [],
    }),
  });
  const prompt = await buildLoopTurnStartPrompt(ctx, store);
  assert.match(prompt, /禁止重新搜尋新 issue/);
  assert.match(prompt, /從 clone_path 繼續/);
});

test("drainPolicyEscalation carries release only when exact blocked call matches", () => {
  const ctx = makeContext();
  ctx.policyEscalations = [
    {
      action: "close",
      reason: "hard gate 'close' hit",
      summary: "gh issue close 12",
      toolName: "Bash",
      input: { command: "gh issue close 12 --repo owner/repo" },
      policyRef: "policy://loop_bypass",
    },
  ];

  const matching = {
    tool: "Bash",
    input: { command: "gh issue close 12 --repo owner/repo" },
  };
  assert.deepEqual(drainPolicyEscalation(ctx, matching)?.toolCall, matching);

  const modified = {
    tool: "Bash",
    input: { command: "gh issue close 13 --repo owner/repo" },
  };
  assert.equal(drainPolicyEscalation(ctx, modified)?.toolCall, undefined);
});

test("resolveDirectWriteAllowlist: GitHub prompt loop owns the whole managed workspace", () => {
  const card = {
    loop: {
      id: "github-prompt-loop",
      discovery: { source: "github_prompt" },
      workspace: { strategy: "direct" },
    },
  } as unknown as LoopCard;
  assert.deepEqual(resolveDirectWriteAllowlist(card, null), ["."]);
});

test("resolveDirectWriteAllowlist: normal direct loop uses IntentContract.target.files", () => {
  const card = {
    loop: {
      id: "loop-direct",
      discovery: { source: "manual" },
      workspace: { strategy: "direct" },
    },
  } as unknown as LoopCard;
  const contract = {
    target: { files: ["src/a.ts"] },
  } as unknown as IntentContract;
  assert.deepEqual(resolveDirectWriteAllowlist(card, contract), ["src/a.ts"]);
});
