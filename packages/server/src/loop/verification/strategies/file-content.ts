import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VerifierReport } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";

/**
 * File content verification strategy.
 *
 * Checks whether specified files contain expected patterns or content.
 * Used for tasks that need to verify file contents (e.g., search-results.md
 * contains 3 candidate issues).
 *
 * P1: 讀取順序與 ContractCriteriaStrategy 對齊 —— 優先 workspace（執行器
 * 產物所在）, 回落 run 賬本 artifacts; verifier_phase 以輸入 phase 為準,
 * 不再硬編碼 "static"。
 */
export class FileContentStrategy implements VerificationStrategy {
  readonly name = "file_content";

  constructor(
    private checks: Array<{
      file: string;
      pattern: string | RegExp;
      description?: string;
    }>,
  ) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const failures: string[] = [];
    const evidenceRefs: string[] = [];

    for (const check of this.checks) {
      const target = await this.readTarget(check.file, input);
      if (target === null) {
        failures.push(`file not found: ${check.file}`);
        continue;
      }

      const pattern =
        typeof check.pattern === "string"
          ? new RegExp(check.pattern, "i")
          : check.pattern;
      if (!pattern.test(target.content)) {
        failures.push(
          `file ${check.file} does not match pattern: ${pattern.source}`,
        );
      } else {
        evidenceRefs.push(target.ref);
      }
    }

    if (failures.length > 0) {
      return {
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: evidenceRefs,
        unresolved_risks: failures,
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

  /** 優先 workspace, 回落 artifacts (與 ContractCriteriaStrategy 同口徑)。 */
  private async readTarget(
    file: string,
    input: VerificationInput,
  ): Promise<{ content: string; ref: string } | null> {
    const workspaceFile = path.resolve(input.workspacePath, file);
    if (existsSync(workspaceFile)) {
      try {
        const content = await readFile(workspaceFile, "utf-8");
        return {
          content,
          ref: `workspace://${input.workspacePath}/${file}`,
        };
      } catch {
        // fall through to the artifact map
      }
    }
    const artifact = input.artifacts[file];
    if (artifact !== undefined) {
      return {
        content: artifact,
        ref: `artifact://${input.contract.intent_id}/${file}`,
      };
    }
    return null;
  }
}
