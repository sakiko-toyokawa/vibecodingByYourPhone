import type { VerifierReport } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";

/**
 * Fail-closed fallback for static/runtime phases when the project language
 * or toolchain is not recognized and no explicit verification command was
 * configured. Returns `unverified` instead of a vacuous pass.
 */
export class UnverifiedLanguageStrategy implements VerificationStrategy {
  readonly name = "unverified_language";

  constructor(private readonly projectType?: string) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const project = this.projectType ?? "unknown";
    return {
      verifier_phase: input.phase,
      status: "unverified",
      evidence_refs: [],
      unresolved_risks: [
        `project type '${project}' has no supported deterministic verifier for phase '${input.phase}'; language/toolchain is unverified`,
      ],
      recommendation: "escalate",
      confidence: 0.5,
      requires_human: false,
    };
  }
}
