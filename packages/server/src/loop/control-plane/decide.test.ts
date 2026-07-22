import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentReport } from "@yep-anywhere/shared";
import { decideControl } from "./decide.js";

function makeJudgment(overrides: Partial<JudgmentReport> = {}): JudgmentReport {
  return {
    overall: "passed",
    next_action: "complete",
    retryable: false,
    requires_human: false,
    evidence: [],
    unresolved_risks: [],
    ...overrides,
  };
}

// Phase-1 decision table (see decide.ts header):
// execution failed → failed; no verification → complete;
// passed && !requires_human → complete; everything else → needs_human.

test("execution failure is failed regardless of judgment", () => {
  assert.equal(
    decideControl({
      executionOk: false,
      verificationRan: false,
      judgment: null,
    }).kind,
    "failed",
  );
  assert.equal(
    decideControl({
      executionOk: false,
      verificationRan: true,
      judgment: makeJudgment({ overall: "passed" }),
    }).kind,
    "failed",
  );
});

test("no verification required: successful execution completes", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: false,
      judgment: null,
    }).kind,
    "complete",
  );
});

test("passed judgment without requires_human completes", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({ overall: "passed" }),
    }).kind,
    "complete",
  );
});

test("passed judgment with requires_human escalates (human outranks verdict)", () => {
  const decision = decideControl({
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment({
      overall: "passed",
      requires_human: true,
      next_action: "needs_human",
    }),
  });
  assert.equal(decision.kind, "needs_human");
  assert.match(decision.reason, /requires human/);
});

test("failed judgment with retry recommendation still goes needs_human (phase 1: no auto retry)", () => {
  const decision = decideControl({
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment({
      overall: "failed",
      next_action: "retry",
      retryable: true,
    }),
  });
  assert.equal(decision.kind, "needs_human");
  assert.match(decision.reason, /no automatic retry/);
});

test("failed judgment with escalate next_action goes needs_human", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({ overall: "failed", next_action: "escalate" }),
    }).kind,
    "needs_human",
  );
});

test("inconclusive judgment goes needs_human", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({ overall: "inconclusive", next_action: "stop" }),
    }).kind,
    "needs_human",
  );
});

test("failed judgment with requires_human goes needs_human", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({
        overall: "failed",
        requires_human: true,
        next_action: "needs_human",
      }),
    }).kind,
    "needs_human",
  );
});
