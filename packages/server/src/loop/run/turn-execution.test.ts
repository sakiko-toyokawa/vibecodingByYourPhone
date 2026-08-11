import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentContract, LoopCard } from "@yep-anywhere/shared";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import {
  buildLoopTurnStartPrompt,
  resolveDirectWriteAllowlist,
} from "./turn-execution.js";
import type { RunExecutionContext } from "./types.js";

function makeContext(
  overrides: {
    turn?: number;
    pendingContext?: string | null;
    taskPlan?: RunExecutionContext["taskPlan"];
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
    currentSubtaskIndex: 0,
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
