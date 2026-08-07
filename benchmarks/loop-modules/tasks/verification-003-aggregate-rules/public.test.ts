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

test("单份 passed 报告 → passed / complete / 不可重试", () => {
  const judgment = aggregateVerifierReports([makeReport()], RETRY_POLICY);
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "complete");
  assert.equal(judgment.retryable, false);
  assert.equal(judgment.requires_human, false);
});

test("多份报告 worst status 生效", () => {
  const inconclusive = aggregateVerifierReports(
    [
      makeReport(),
      makeReport({
        verifier_phase: "runtime",
        status: "inconclusive",
        recommendation: "escalate",
      }),
    ],
    RETRY_POLICY,
  );
  assert.equal(inconclusive.overall, "inconclusive");

  const failed = aggregateVerifierReports(
    [
      makeReport({ status: "inconclusive", recommendation: "escalate" }),
      makeReport({
        verifier_phase: "runtime",
        status: "failed",
        recommendation: "retry",
      }),
    ],
    RETRY_POLICY,
  );
  assert.equal(failed.overall, "failed");
});

test("requires_human 透传且不被 passed 覆盖", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport(),
      makeReport({ verifier_phase: "review", requires_human: true }),
    ],
    RETRY_POLICY,
  );
  assert.equal(judgment.requires_human, true);
  assert.equal(judgment.next_action, "needs_human");
  assert.equal(judgment.overall, "passed");
});

test("failed + allowRetry + budget ok → retry / retryable true", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    RETRY_POLICY,
  );
  assert.equal(judgment.next_action, "retry");
  assert.equal(judgment.retryable, true);
});

test("retry 不允许或预算耗尽 → stop / retryable false", () => {
  const noRetry = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    { allowRetry: false, budgetExhausted: false },
  );
  assert.equal(noRetry.next_action, "stop");
  assert.equal(noRetry.retryable, false);

  const budgetExhausted = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    { allowRetry: true, budgetExhausted: true },
  );
  assert.equal(budgetExhausted.next_action, "stop");
  assert.equal(budgetExhausted.retryable, false);
});
