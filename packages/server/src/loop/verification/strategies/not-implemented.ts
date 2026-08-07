import type { VerifierReport } from "@yep-anywhere/shared";
import type {
  ExecutableVerificationPhase,
  VerificationInput,
  VerificationStrategy,
} from "../strategy.js";

/**
 * Phase-not-implemented fallback strategy (P0 掛載點).
 *
 * rule / structural phase 已進入 VerificationPhaseSchema 與 verify-run 的
 * 策略短路管線, 但真正的 RuleBasedStrategy (Phase 2) 與 StructuralStrategy
 * (Phase 3) 尚未實作。此兜底策略給出誠實的 inconclusive + escalate ——
 * 讓宣告了這些 phase 的 card 立刻暴露"策略未實作"這一事實, 而不是
 * 像 placeholder 那樣被靜默排除 (not_applicable), 也不是 vacuous pass。
 */
export class PhaseNotImplementedStrategy implements VerificationStrategy {
  readonly name: string;

  constructor(private readonly targetPhase: ExecutableVerificationPhase) {
    this.name = `not_implemented:${targetPhase}`;
  }

  async verify(input: VerificationInput): Promise<VerifierReport> {
    return {
      verifier_phase: this.targetPhase,
      status: "inconclusive",
      evidence_refs: [],
      unresolved_risks: [
        `verification phase '${this.targetPhase}' is declared in the card's verifier chain but its strategy is not implemented yet (P0 掛載點; RuleBasedStrategy=Phase 2, StructuralStrategy=Phase 3)`,
      ],
      recommendation: "escalate",
      confidence: 0.1,
      requires_human: false,
    };
  }
}
