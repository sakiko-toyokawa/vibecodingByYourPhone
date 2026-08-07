import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerifierReport } from "@yep-anywhere/shared";
import {
  type AggregatePolicy,
  aggregateVerifierReports,
} from "../../../../packages/server/src/loop/verification/aggregate.js";

function makeReport(overrides: Partial<VerifierReport> = {}): VerifierReport {
  return {
    verifier_phase: "static",
    status: "passed",
    evidence_refs: ["artifact://run/a.log"],
    unresolved_risks: [],
    recommendation: "stop",
    confidence: 0.95,
    requires_human: false,
    ...overrides,
  };
}

const RETRY_POLICY: AggregatePolicy = {
  allowRetry: true,
  budgetExhausted: false,
};

test("requires_human + failed + retry 允许时仍为 needs_human", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport({ status: "failed", recommendation: "retry" }),
      makeReport({
        verifier_phase: "review",
        status: "inconclusive",
        recommendation: "escalate",
        requires_human: true,
      }),
    ],
    RETRY_POLICY,
  );
  assert.equal(judgment.requires_human, true);
  assert.equal(judgment.next_action, "needs_human");
});

test("escalate recommendation 优先级高于 complete", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ recommendation: "escalate" })],
    RETRY_POLICY,
  );
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "escalate");
  assert.equal(judgment.retryable, false);
});

test("空报告链 → passed / complete", () => {
  const judgment = aggregateVerifierReports([], RETRY_POLICY);
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "complete");
  assert.equal(judgment.retryable, false);
});

test("evidence 与 unresolved_risks 跨报告平铺", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport({
        evidence_refs: ["artifact://run/lint.log"],
        unresolved_risks: ["risk-a"],
      }),
      makeReport({
        verifier_phase: "runtime",
        status: "failed",
        recommendation: "retry",
        evidence_refs: ["artifact://run/test.log", "artifact://run/t2.log"],
        unresolved_risks: ["risk-b"],
      }),
    ],
    RETRY_POLICY,
  );
  assert.deepEqual(judgment.evidence, [
    "artifact://run/lint.log",
    "artifact://run/test.log",
    "artifact://run/t2.log",
  ]);
  assert.deepEqual(judgment.unresolved_risks, ["risk-a", "risk-b"]);
});
