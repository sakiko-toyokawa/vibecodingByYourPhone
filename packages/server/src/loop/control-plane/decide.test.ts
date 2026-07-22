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

// Phase-2 decision table (see decide.ts header):
// execution failed → failed; no verification → complete;
// requires_human → needs_human; passed → complete;
// failed && retryable && canRetry → retry;
// failed && retryable && !canRetry → budget_limited;
// everything else → needs_human.

test("execution failure is failed regardless of judgment", () => {
  assert.equal(
    decideControl({
      executionOk: false,
      verificationRan: false,
      judgment: null,
      canRetry: true,
    }).kind,
    "failed",
  );
  assert.equal(
    decideControl({
      executionOk: false,
      verificationRan: true,
      judgment: makeJudgment({ overall: "passed" }),
      canRetry: true,
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
      canRetry: true,
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
      canRetry: true,
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
    canRetry: true,
  });
  assert.equal(decision.kind, "needs_human");
  assert.match(decision.reason, /requires human/);
});

test("failed retryable judgment with budget headroom → retry (phase 2: automatic)", () => {
  const decision = decideControl({
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment({
      overall: "failed",
      next_action: "retry",
      retryable: true,
    }),
    canRetry: true,
  });
  assert.equal(decision.kind, "retry");
  assert.match(decision.reason, /retryable/);
});

test("failed retryable judgment with exhausted budget → budget_limited (先触者停)", () => {
  const decision = decideControl({
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment({
      overall: "failed",
      next_action: "retry",
      retryable: true,
    }),
    canRetry: false,
  });
  assert.equal(decision.kind, "budget_limited");
  assert.match(decision.reason, /budget.*exhausted|exhausted/);
});

test("failed judgment with escalate next_action goes needs_human", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({ overall: "failed", next_action: "escalate" }),
      canRetry: true,
    }).kind,
    "needs_human",
  );
});

test("failed non-retryable judgment goes needs_human (no automatic path)", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({
        overall: "failed",
        next_action: "stop",
        retryable: false,
      }),
      canRetry: true,
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
      canRetry: true,
    }).kind,
    "needs_human",
  );
});

test("failed judgment with requires_human goes needs_human (human outranks retry)", () => {
  assert.equal(
    decideControl({
      executionOk: true,
      verificationRan: true,
      judgment: makeJudgment({
        overall: "failed",
        requires_human: true,
        next_action: "needs_human",
        retryable: true,
      }),
      canRetry: true,
    }).kind,
    "needs_human",
  );
});
