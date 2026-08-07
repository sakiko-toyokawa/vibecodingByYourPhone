/**
 * Unit tests for blocker fingerprinting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentReport } from "@yep-anywhere/shared";
import { blockerFingerprint } from "./blocker.js";

const baseJudgment: JudgmentReport = {
  overall: "failed",
  next_action: "needs_human",
  retryable: false,
  requires_human: true,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: ["manual approval required"],
};

test("returns undefined when both judgment and policyEscalation are absent", () => {
  assert.equal(blockerFingerprint(null), undefined);
  assert.equal(blockerFingerprint(null, undefined), undefined);
});

test("returns a stable fingerprint for the same judgment", () => {
  const first = blockerFingerprint(baseJudgment);
  const second = blockerFingerprint(baseJudgment);
  assert.ok(first);
  assert.equal(first, second);
});

test("different next_action produces different fingerprints", () => {
  const needsHuman = blockerFingerprint(baseJudgment);
  const retry = blockerFingerprint({ ...baseJudgment, next_action: "retry" });
  assert.notEqual(needsHuman, retry);
});

test("different unresolved_risks produce different fingerprints", () => {
  const original = blockerFingerprint(baseJudgment);
  const differentRisk = blockerFingerprint({
    ...baseJudgment,
    unresolved_risks: ["static check failed"],
  });
  assert.notEqual(original, differentRisk);
});

test("different evidence produces different fingerprints", () => {
  const original = blockerFingerprint(baseJudgment);
  const differentEvidence = blockerFingerprint({
    ...baseJudgment,
    evidence: ["artifact://run/collector-report.json"],
  });
  assert.notEqual(original, differentEvidence);
});

test("evidence order is normalized", () => {
  const a = blockerFingerprint({
    ...baseJudgment,
    evidence: ["a", "b", "c"],
  });
  const b = blockerFingerprint({
    ...baseJudgment,
    evidence: ["c", "a", "b"],
  });
  assert.equal(a, b);
});

test("risk order is normalized", () => {
  const a = blockerFingerprint({
    ...baseJudgment,
    unresolved_risks: ["x", "y", "z"],
  });
  const b = blockerFingerprint({
    ...baseJudgment,
    unresolved_risks: ["z", "y", "x"],
  });
  assert.equal(a, b);
});

test("whitespace and case are normalized", () => {
  const a = blockerFingerprint({
    ...baseJudgment,
    unresolved_risks: ["  Manual   Approval Required  "],
  });
  const b = blockerFingerprint({
    ...baseJudgment,
    unresolved_risks: ["manual approval required"],
  });
  assert.equal(a, b);
});

test("policy escalation affects the fingerprint", () => {
  const withoutPolicy = blockerFingerprint(baseJudgment);
  const withPolicy = blockerFingerprint(baseJudgment, {
    action: "block",
    reason: "protected branch",
    policyRef: "policy://production_guarded",
  });
  assert.notEqual(withoutPolicy, withPolicy);
});

test("policy escalation with same action and reason produces the same fingerprint", () => {
  const a = blockerFingerprint(baseJudgment, {
    action: "block",
    reason: "Protected  Branch",
    policyRef: "policy://a",
  });
  const b = blockerFingerprint(baseJudgment, {
    action: "block",
    reason: "protected branch",
    policyRef: "policy://b",
  });
  assert.equal(a, b);
});

test("policy escalation reason is normalized", () => {
  const a = blockerFingerprint(null, {
    action: "block",
    reason: "  Protected   Branch  ",
    policyRef: "policy://production_guarded",
  });
  const b = blockerFingerprint(null, {
    action: "block",
    reason: "protected branch",
    policyRef: "policy://production_guarded",
  });
  assert.equal(a, b);
});

test("fingerprint includes prefix", () => {
  const fp = blockerFingerprint(baseJudgment);
  assert.ok(fp?.startsWith("blocker:"));
});
