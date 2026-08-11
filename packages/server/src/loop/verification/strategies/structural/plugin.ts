import type { VerifierIssue } from "@yep-anywhere/shared";

export interface StructuralPluginOutcome {
  issues: VerifierIssue[];
  risks: string[];
  applicable: boolean;
  inconclusive?: boolean;
  /** Raw command output to persist as evidence, when available. */
  rawLog?: string | null;
}

/**
 * L3 structural plugin contract. Python / Rust / OpenAPI checkers can be
 * implemented later without changing the strategy or control plane.
 */
export interface StructuralPlugin {
  name: string;
  run(input: {
    workspacePath: string;
    phase: VerifierIssue["layer"];
    timeoutMs?: number;
  }): Promise<StructuralPluginOutcome>;
}
