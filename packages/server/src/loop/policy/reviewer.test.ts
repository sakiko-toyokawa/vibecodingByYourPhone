import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPolicyReviewPrompt,
  parsePolicyReviewOutput,
} from "./reviewer.js";

test("parsePolicyReviewOutput: valid JSON verdict is accepted", () => {
  const result = parsePolicyReviewOutput(
    [
      "```json",
      JSON.stringify({
        decision: "allow",
        reason: "inside workspace and matches contract",
        confidence: 0.8,
        evidence: ["workspace/src/foo.ts"],
      }),
      "```",
    ].join("\n"),
    "artifact://run-1/policy-review-output.log",
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.evidenceRefs, [
    "artifact://run-1/policy-review-output.log",
    "workspace/src/foo.ts",
  ]);
});

test("parsePolicyReviewOutput: invalid or missing output fails closed", () => {
  for (const text of ["", "I think this is safe", "not json at all"]) {
    const result = parsePolicyReviewOutput(
      text,
      "artifact://run-1/policy-review-output.log",
    );
    assert.equal(result.decision, "hard_gate");
    assert.match(result.reason, /invalid output/);
  }
});

test("buildPolicyReviewPrompt redacts tokens and includes tool/contract", () => {
  const prompt = buildPolicyReviewPrompt(
    {
      runId: "run-1",
      loopId: "loop-1",
      turn: 1,
      toolName: "Bash",
      input: {
        command:
          "gh api --method POST -H 'Authorization: Bearer ghp_fake_token_123' repos/x/issues",
      },
      classification: {
        action: "execute",
        hardGate: null,
        risk: "high",
        locallyRollbackable: false,
        summary: "gh api write",
      },
      workspacePath: "/tmp/ws",
      contract: {
        raw_goal: "find a bug",
        outcome: "report",
        success_criteria: ["report"],
        constraints: ["workspace_bounded"],
        security_level: "workspace_write",
      } as unknown as Parameters<typeof buildPolicyReviewPrompt>[0]["contract"],
    },
    "artifact://run-1/policy-review-input.json",
  );
  assert.match(prompt, /Bash/);
  assert.match(prompt, /find a bug/);
  assert.ok(!prompt.includes("ghp_fake_token_123"));
  assert.ok(!prompt.includes("Authorization: Bearer ghp_fake"));
});
