import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerifierReport } from "@yep-anywhere/shared";
import { type AggregatePolicy, aggregateVerifierReports } from "./aggregate.js";

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

test("single passed report → passed / complete / not retryable", () => {
  const judgment = aggregateVerifierReports([makeReport()], RETRY_POLICY);
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "complete");
  assert.equal(judgment.retryable, false);
  assert.equal(judgment.requires_human, false);
});

test("multiple reports → worst status wins (failed > unverified > inconclusive > passed)", () => {
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

test("unverified status fails closed and is not retryable", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport(),
      makeReport({
        verifier_phase: "runtime",
        status: "unverified",
        recommendation: "escalate",
      }),
    ],
    RETRY_POLICY,
  );
  assert.equal(judgment.overall, "unverified");
  assert.equal(judgment.next_action, "escalate");
  assert.equal(judgment.retryable, false);
});

test("requires_human passthrough: top priority, never overridden by passes", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport(),
      makeReport({ verifier_phase: "review", requires_human: true }),
    ],
    RETRY_POLICY,
  );
  assert.equal(judgment.requires_human, true);
  assert.equal(judgment.next_action, "needs_human");
  // overall 仍按 status 取最差级，不受 requires_human 影响
  assert.equal(judgment.overall, "passed");
});

test("failed + retry allowed + budget ok → next_action retry, retryable true", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    RETRY_POLICY,
  );
  assert.equal(judgment.next_action, "retry");
  assert.equal(judgment.retryable, true);
});

test("failed but retry not allowed → stop, not retryable", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    { allowRetry: false, budgetExhausted: false },
  );
  assert.equal(judgment.next_action, "stop");
  assert.equal(judgment.retryable, false);
});

test("failed but budget exhausted → stop, not retryable", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ status: "failed", recommendation: "retry" })],
    { allowRetry: true, budgetExhausted: true },
  );
  assert.equal(judgment.next_action, "stop");
  assert.equal(judgment.retryable, false);
});

test("any escalate recommendation → next_action escalate", () => {
  const judgment = aggregateVerifierReports(
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
  assert.equal(judgment.next_action, "escalate");
  // inconclusive ≠ passed → 可重试性只看 overall/policy
  assert.equal(judgment.retryable, true);
});

test("escalate recommendation beats complete even when all passed", () => {
  const judgment = aggregateVerifierReports(
    [makeReport({ recommendation: "escalate" })],
    RETRY_POLICY,
  );
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "escalate");
  assert.equal(judgment.retryable, false);
});

test("evidence and unresolved_risks are flattened across reports", () => {
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

test("human_reasons are merged across reports", () => {
  const judgment = aggregateVerifierReports(
    [
      makeReport({
        human_reasons: [
          {
            code: "duplicate_pr",
            message: "Open PR #123 already covers this fix.",
          },
        ],
      }),
      makeReport({
        verifier_phase: "review",
        requires_human: true,
        human_reasons: [
          {
            code: "scope_unconfirmed",
            message: "Maintainer has not confirmed the narrowed scope.",
          },
        ],
      }),
    ],
    RETRY_POLICY,
  );
  assert.deepEqual(judgment.human_reasons, [
    {
      code: "duplicate_pr",
      message: "Open PR #123 already covers this fix.",
    },
    {
      code: "scope_unconfirmed",
      message: "Maintainer has not confirmed the narrowed scope.",
    },
  ]);
});

test("empty chain → passed / complete (no failure evidence to judge)", () => {
  const judgment = aggregateVerifierReports([], RETRY_POLICY);
  assert.equal(judgment.overall, "passed");
  assert.equal(judgment.next_action, "complete");
  assert.equal(judgment.retryable, false);
});
