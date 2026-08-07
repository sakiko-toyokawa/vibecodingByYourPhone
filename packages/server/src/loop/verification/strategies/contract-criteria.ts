import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VerifierReport } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";

/**
 * Contract criteria verification strategy.
 *
 * Verifies the turn's outcome against the intent contract's success criteria.
 * This is the core improvement: instead of assuming test commands, we verify
 * based on what the contract says the task should achieve.
 *
 * File-based criteria (exists / contains) check the WORKSPACE — that is where
 * the executor creates files. 教训: 此前拿 workspace 文件名去 run 账本
 * artifacts (stdout.log / intent-contract.json …) 里找, 恒 missing → 恒
 * failed → 白烧 retry 预算直到 budget_limited。
 */
export class ContractCriteriaStrategy implements VerificationStrategy {
  readonly name = "contract_criteria";

  constructor(private criteria: string[]) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const results: Array<{
      criterion: string;
      passed: boolean;
      evidence: string | null;
      risk: string | null;
    }> = [];

    for (const criterion of this.criteria) {
      const result = await this.verifyCriterion(criterion, input);
      results.push(result);
    }

    const failures = results.filter((r) => !r.passed);
    const evidenceRefs = results
      .filter((r) => r.evidence)
      .map((r) => r.evidence as string);
    const unresolvedRisks = failures
      .filter((r) => r.risk)
      .map((r) => r.risk as string);

    if (failures.length > 0) {
      return {
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: evidenceRefs,
        unresolved_risks: unresolvedRisks,
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

  /** 提取引號內的期望內容（中英文引號）；無引號返回 null。 */
  private extractQuoted(criterion: string): string | null {
    const match = criterion.match(/["'「『“‘](.+?)["'」』”’]/);
    const quoted = match?.[1]?.trim();
    return quoted && quoted.length > 0 ? quoted : null;
  }

  /** 否定訴求（不得包含 / must not contain 等）。 */
  private isNegated(criterion: string): boolean {
    return /(?:不得|不能|不應|不应|不含|禁止|勿|must not|should not|do not)/.test(
      criterion,
    );
  }

  /** 數量訴求：at least N / 至少 N / 不少於 N。 */
  private extractAtLeast(criterion: string): number | null {
    const match = criterion.match(/(?:at least|至少|不少於|不少于)\s*(\d+)/i);
    return match ? Number.parseInt(match[1] ?? "", 10) : null;
  }

  private countOccurrences(content: string, needle: string): number {
    if (needle.length === 0) {
      return 0;
    }
    let count = 0;
    let index = content.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = content.indexOf(needle, index + needle.length);
    }
    return count;
  }

  private async verifyCriterion(
    criterion: string,
    input: VerificationInput,
  ): Promise<{
    criterion: string;
    passed: boolean;
    evidence: string | null;
    risk: string | null;
  }> {
    const lower = criterion.toLowerCase();

    // Content criteria (e.g., "contains 3 candidate issues", "includes repository URL")
    if (
      lower.includes("contain") ||
      lower.includes("包含") ||
      lower.includes("include") ||
      lower.includes("至少") ||
      lower.includes("at least")
    ) {
      return this.verifyFileContent(criterion, input);
    }

    // Search/result criteria (e.g., "found 3 candidate issues", "selected one issue")
    if (
      lower.includes("found") ||
      lower.includes("找到") ||
      lower.includes("selected") ||
      lower.includes("选择")
    ) {
      return this.verifySearchResults(criterion, input);
    }

    // File existence criteria (e.g., "create search-results.md", "PLAN.md exists")
    if (
      lower.includes("file") ||
      lower.includes("文件") ||
      lower.includes(".md") ||
      lower.includes(".ts") ||
      lower.includes(".js")
    ) {
      return this.verifyFileExistence(criterion, input);
    }

    // Default: check executor output for the criterion
    return this.verifyExecutorOutput(criterion, input);
  }

  /** 读文件内容: 优先 workspace (执行器产物所在), 回落 run 账本 artifacts。 */
  private async readTargetFile(
    file: string,
    input: VerificationInput,
  ): Promise<{ content: string; ref: string } | null> {
    const workspaceFile = path.resolve(input.workspacePath, file);
    if (existsSync(workspaceFile)) {
      try {
        const content = await readFile(workspaceFile, "utf8");
        return { content, ref: `workspace://${input.workspacePath}/${file}` };
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

  private async verifyFileExistence(
    criterion: string,
    input: VerificationInput,
  ): Promise<{
    criterion: string;
    passed: boolean;
    evidence: string | null;
    risk: string | null;
  }> {
    // Extract file names from the criterion
    const filePattern = /[\w\-./]+\.(md|ts|js|json|txt|py|rs|go|java)/gi;
    const matches = criterion.match(filePattern);

    if (!matches || matches.length === 0) {
      return {
        criterion,
        passed: true, // Cannot determine, assume passed
        evidence: null,
        risk: null,
      };
    }

    const missing = matches.filter((file) => {
      const workspaceFile = path.resolve(input.workspacePath, file);
      return !existsSync(workspaceFile) && !(file in input.artifacts);
    });

    if (missing.length > 0) {
      return {
        criterion,
        passed: false,
        evidence: null,
        risk: `required files missing: ${missing.join(", ")}`,
      };
    }

    return {
      criterion,
      passed: true,
      evidence: `workspace://${input.workspacePath}/${matches[0]}`,
      risk: null,
    };
  }

  private async verifyFileContent(
    criterion: string,
    input: VerificationInput,
  ): Promise<{
    criterion: string;
    passed: boolean;
    evidence: string | null;
    risk: string | null;
  }> {
    // Extract file names from the criterion
    const filePattern = /[\w\-./]+\.(md|ts|js|json|txt|py|rs|go|java)/gi;
    const matches = criterion.match(filePattern);

    if (!matches || matches.length === 0) {
      return {
        criterion,
        passed: true, // Cannot determine, assume passed
        evidence: null,
        risk: null,
      };
    }

    const file = matches[0];
    const target = await this.readTargetFile(file, input);

    if (target === null) {
      return {
        criterion,
        passed: false,
        evidence: null,
        risk: `file not found: ${file}`,
      };
    }

    // P1: 引號內的期望內容優先（精確子串比對）；支持否定訴求與
    // "at least N / 至少 N" 次數訴求。無引號時回落舊的 candidate 啟發式。
    const quoted = this.extractQuoted(criterion);
    if (quoted !== null) {
      const negated = this.isNegated(criterion);
      const atLeast = this.extractAtLeast(criterion);
      if (atLeast !== null && !negated) {
        const occurrences = this.countOccurrences(target.content, quoted);
        if (occurrences < atLeast) {
          return {
            criterion,
            passed: false,
            evidence: null,
            risk: `file ${file} contains ${occurrences} occurrence(s) of "${quoted}", expected at least ${atLeast}`,
          };
        }
      } else {
        const has = target.content.includes(quoted);
        if (negated ? has : !has) {
          return {
            criterion,
            passed: false,
            evidence: null,
            risk: negated
              ? `file ${file} must not contain "${quoted}"`
              : `file ${file} does not contain expected content "${quoted}"`,
          };
        }
      }
      return {
        criterion,
        passed: true,
        evidence: target.ref,
        risk: null,
      };
    }

    // Extract expected content from the criterion
    // For example, "contains 3 candidate issues" -> check for "candidate" or "candidate issues"
    if (criterion.toLowerCase().includes("candidate")) {
      const hasCandidate = /candidate/i.test(target.content);
      if (!hasCandidate) {
        return {
          criterion,
          passed: false,
          evidence: null,
          risk: `file ${file} does not contain expected content (candidate)`,
        };
      }
    }

    return {
      criterion,
      passed: true,
      evidence: target.ref,
      risk: null,
    };
  }

  private async verifySearchResults(
    criterion: string,
    input: VerificationInput,
  ): Promise<{
    criterion: string;
    passed: boolean;
    evidence: string | null;
    risk: string | null;
  }> {
    // Check if search results file exists and contains expected content
    const searchFile = "search-results.md";
    const target = await this.readTargetFile(searchFile, input);

    if (target === null) {
      return {
        criterion,
        passed: false,
        evidence: null,
        risk: `search results file not found: ${searchFile}`,
      };
    }

    // Check for specific patterns based on criterion
    if (
      criterion.toLowerCase().includes("candidate") ||
      criterion.toLowerCase().includes("issue")
    ) {
      const hasCandidate = /candidate|issue/i.test(target.content);
      if (!hasCandidate) {
        return {
          criterion,
          passed: false,
          evidence: null,
          risk: "search results file does not contain candidate issues",
        };
      }
    }

    return {
      criterion,
      passed: true,
      evidence: target.ref,
      risk: null,
    };
  }

  private verifyExecutorOutput(
    criterion: string,
    input: VerificationInput,
  ): {
    criterion: string;
    passed: boolean;
    evidence: string | null;
    risk: string | null;
  } {
    // Check if executor's stdout contains evidence of the criterion
    const stdout = input.artifacts["stdout.log"];

    if (stdout === undefined) {
      return {
        criterion,
        passed: true, // Cannot determine, assume passed
        evidence: null,
        risk: null,
      };
    }

    // For now, assume the criterion is met if the task was executed successfully
    // In a more sophisticated implementation, we would parse the criterion and
    // check for specific evidence in the stdout
    if (input.exitStatus === 0) {
      return {
        criterion,
        passed: true,
        evidence: `artifact://${input.contract.intent_id}/stdout.log`,
        risk: null,
      };
    }

    return {
      criterion,
      passed: false,
      evidence: null,
      risk: `executor failed with exit status ${input.exitStatus}`,
    };
  }
}
