import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_VERIFIER_INPUT_CHARS,
  buildVerifierAgentPrompt,
  buildVerifierAgentRecoveryPrompt,
} from "./prompt.js";

test("buildVerifierAgentPrompt truncates oversized evidence inline and keeps artifact refs", () => {
  const prompt = buildVerifierAgentPrompt({
    run_id: "run-1",
    turn: 1,
    requirement: {
      raw_goal: "fix",
      outcome: "fixed",
      success_criteria: ["ok"],
      constraints: [],
    },
    prior_reports: [
      {
        verifier_phase: "structural",
        status: "passed",
        evidence_refs: [],
        unresolved_risks: [],
        recommendation: "stop",
        confidence: 1,
        requires_human: false,
        issues: [
          {
            id: "test",
            severity: "info",
            layer: "structural",
            message: "x".repeat(MAX_VERIFIER_INPUT_CHARS),
          },
        ],
      },
    ],
    previous_judgment: null,
    evidence_refs: {
      diff: "artifact://run-1/diff.patch",
      stdout: null,
      runtime_events: null,
      executor_summary: null,
    },
    input_ref: "artifact://run-1/verifier-agent-input.json",
    workspace_path: "/tmp/ws",
  });
  assert.ok(prompt.includes('"truncated": true'));
  assert.ok(prompt.includes("完整內容已落盤"));
  assert.ok(prompt.includes("artifact://run-1/verifier-agent-input.json"));
});

test("buildVerifierAgentRecoveryPrompt keeps the original requirement and includes validation error", () => {
  const base = buildVerifierAgentPrompt({
    run_id: "run-1",
    turn: 1,
    requirement: {
      raw_goal: "fix",
      outcome: "fixed",
      success_criteria: ["ok"],
      constraints: [],
    },
    prior_reports: [],
    previous_judgment: null,
    evidence_refs: {
      diff: null,
      stdout: null,
      runtime_events: null,
      executor_summary: null,
    },
    input_ref: "artifact://run-1/verifier-agent-input.json",
    workspace_path: "/tmp/ws",
  });
  const prompt = buildVerifierAgentRecoveryPrompt({
    basePrompt: base,
    previousOutput: "```json\n{ broken\n```",
    validationError: "status: invalid enum value",
  });
  assert.ok(prompt.includes("Previous output was rejected"));
  assert.ok(prompt.includes("status: invalid enum value"));
  assert.ok(prompt.includes("artifact://run-1/verifier-agent-input.json"));
  assert.ok(prompt.includes("'''json"));
});
