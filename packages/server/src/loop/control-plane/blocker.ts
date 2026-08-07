/**
 * Blocker fingerprinting for control-plane decisions.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import { createHash } from "node:crypto";
import type { JudgmentReport } from "@yep-anywhere/shared";
import type { ApplyJudgmentInput } from "./types.js";

function normalizeBlockerParts(parts: string[]): string[] {
  return parts
    .map((part) => part.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((part) => part.length > 0)
    .sort();
}

export function blockerFingerprint(
  judgment: JudgmentReport | null,
  policyEscalation?: ApplyJudgmentInput["policyEscalation"],
): string | undefined {
  if (!judgment && !policyEscalation) {
    return undefined;
  }
  const payload = {
    next_action: judgment?.next_action ?? "none",
    risks: normalizeBlockerParts(judgment?.unresolved_risks ?? []),
    evidence: normalizeBlockerParts(judgment?.evidence ?? []),
    policy_action: policyEscalation?.action ?? null,
    policy_reason: policyEscalation?.reason
      ? normalizeBlockerParts([policyEscalation.reason])[0]
      : null,
  };
  return `blocker:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16)}`;
}
