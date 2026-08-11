/**
 * Deterministic mapping from L3/L4 verifier signals to the existing
 * FailureTag vocabulary (Phase 7).
 *
 * The decision layer must be able to answer "which verifier layer failed and
 * how" without inventing new tags. This module keeps that mapping in one
 * place and is consumed by verify-run -> turn-loop -> control-plane.
 */

import type { FailureTag, VerifierReport } from "@yep-anywhere/shared";

export interface VerifierFailureContext {
  /** True when the verifier process itself crashed or timed out. */
  agentCrashed?: boolean;
}

/**
 * Map one verifier report to failure tags. Passed reports produce no tags.
 * Tags are returned in the fixed FailureTag enum order for stable output.
 */
export function mapVerifierFailureToTag(
  report: VerifierReport,
  context: VerifierFailureContext = {},
): FailureTag[] {
  if (report.status === "passed") {
    return [];
  }

  const tags = new Set<FailureTag>();

  if (context.agentCrashed) {
    tags.add("runtime_blackbox_error");
  }

  if (
    report.evidence_refs.some((ref) =>
      ref.startsWith("missing_required_artifact:"),
    )
  ) {
    tags.add("tool_error");
  }

  if (report.verifier_phase === "review") {
    if (
      report.status === "inconclusive" ||
      report.recommendation === "escalate"
    ) {
      tags.add("verification_error");
    }
  } else if (
    report.status === "failed" ||
    report.status === "inconclusive" ||
    report.status === "unverified"
  ) {
    tags.add("verification_error");
  }

  return [...tags];
}

/** Aggregate tags from all reports, preserving FailureTag enum order. */
export function failureTagsFromReports(
  reports: VerifierReport[],
): FailureTag[] {
  const order: FailureTag[] = [
    "intent_error",
    "runtime_blackbox_error",
    "context_error",
    "memory_packet_error",
    "tool_error",
    "policy_error",
    "verification_error",
    "eval_regression",
  ];
  const found = new Set<FailureTag>();
  for (const report of reports) {
    for (const tag of mapVerifierFailureToTag(report)) {
      found.add(tag);
    }
  }
  return order.filter((tag) => found.has(tag));
}
