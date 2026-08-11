import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerifierReport } from "@yep-anywhere/shared";
import {
  failureTagsFromReports,
  mapVerifierFailureToTag,
} from "./failure-tags.js";

function report(overrides: Partial<VerifierReport>): VerifierReport {
  return {
    verifier_phase: "structural",
    status: "failed",
    evidence_refs: [],
    unresolved_risks: [],
    recommendation: "retry",
    confidence: 0.8,
    requires_human: false,
    ...overrides,
  };
}

test("structural failure maps to verification_error", () => {
  assert.deepEqual(
    mapVerifierFailureToTag(report({ verifier_phase: "structural" })),
    ["verification_error"],
  );
});

test("review inconclusive + escalate maps to verification_error", () => {
  assert.deepEqual(
    mapVerifierFailureToTag(
      report({
        verifier_phase: "review",
        status: "inconclusive",
        recommendation: "escalate",
      }),
    ),
    ["verification_error"],
  );
});

test("unverified language maps to verification_error", () => {
  assert.deepEqual(
    mapVerifierFailureToTag(
      report({
        verifier_phase: "static",
        status: "unverified",
        recommendation: "escalate",
      }),
    ),
    ["verification_error"],
  );
});

test("missing required artifact maps to tool_error", () => {
  assert.deepEqual(
    mapVerifierFailureToTag(
      report({
        evidence_refs: ["missing_required_artifact:judgment-report.json"],
      }),
    ),
    ["tool_error", "verification_error"],
  );
});

test("agent crash maps to runtime_blackbox_error", () => {
  assert.deepEqual(
    mapVerifierFailureToTag(
      report({
        verifier_phase: "review",
        status: "inconclusive",
        recommendation: "escalate",
      }),
      { agentCrashed: true },
    ),
    ["runtime_blackbox_error", "verification_error"],
  );
});

test("passed reports produce no tags; aggregate deduplicates", () => {
  assert.deepEqual(mapVerifierFailureToTag(report({ status: "passed" })), []);
  assert.deepEqual(
    failureTagsFromReports([
      report({ verifier_phase: "structural" }),
      report({ verifier_phase: "review", status: "inconclusive" }),
    ]),
    ["verification_error"],
  );
});
