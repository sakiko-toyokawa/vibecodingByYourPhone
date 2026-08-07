import { existsSync } from "node:fs";
import path from "node:path";
import type { VerifierReport } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";

/**
 * File existence verification strategy.
 *
 * Checks whether specified files exist in the workspace (where the executor
 * creates them), falling back to the run-ledger artifact map.
 */
export class FileExistenceStrategy implements VerificationStrategy {
  readonly name = "file_existence";

  constructor(private requiredFiles: string[]) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const missing: string[] = [];
    const evidenceRefs: string[] = [];

    for (const file of this.requiredFiles) {
      const workspaceFile = path.resolve(input.workspacePath, file);
      if (!existsSync(workspaceFile) && !(file in input.artifacts)) {
        missing.push(file);
      } else {
        evidenceRefs.push(`workspace://${input.workspacePath}/${file}`);
      }
    }

    if (missing.length > 0) {
      return {
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: evidenceRefs,
        unresolved_risks: [`required files missing: ${missing.join(", ")}`],
        recommendation: "retry",
        confidence: 0.9,
        requires_human: false,
      };
    }

    return {
      verifier_phase: input.phase,
      status: "passed",
      evidence_refs: evidenceRefs,
      unresolved_risks: [],
      recommendation: "stop",
      confidence: 0.95,
      requires_human: false,
    };
  }
}
