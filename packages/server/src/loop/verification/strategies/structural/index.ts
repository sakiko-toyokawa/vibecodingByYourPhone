import type { VerifierIssue, VerifierReport } from "@yep-anywhere/shared";
import type {
  VerificationInput,
  VerificationStrategy,
} from "../../strategy.js";
import { SchemaChecker } from "./schema.js";
import { TypeScriptChecker } from "./typescript.js";

/**
 * StructuralStrategy — L3 結構檢查（layered-verifier 計畫 Phase 3）。
 *
 * 聚合各語言/格式的結構 checker：
 * - TypeScriptChecker：tsc --noEmit diagnostics + regex import graph 循環依賴
 * - SchemaChecker：<name>.schema.json ↔ <name>.json 最小子集驗證
 *
 * 誠實口徑：
 * - 沒有任何 checker 適用（非 TS 專案且無 schema 檔）→ inconclusive +
 *   escalate：宣告了 structural phase 卻無檢查可跑是配置/能力缺口，
 *   不 vacuous pass（與 RuleBasedStrategy 無規則時同口徑）。
 * - checker 自身無法完成（如 tsc 不存在）→ inconclusive，不裝成通過。
 * - error 級 issue → failed + retry；info issue 只記錄不阻塞。
 *
 * 快取口徑：tsc 每次 verify 至多執行一次（單次 runCommand），輸出落盤
 * 為 evidence；import graph 每輪重建（掃描成本遠低於 tsc，無需快取）。
 */
export class StructuralStrategy implements VerificationStrategy {
  readonly name = "structural";

  private readonly checkers: {
    typescript: TypeScriptChecker;
    schema: SchemaChecker;
  };

  constructor(
    checkers: {
      typescript?: TypeScriptChecker;
      schema?: SchemaChecker;
    } = {},
  ) {
    this.checkers = {
      typescript: checkers.typescript ?? new TypeScriptChecker(),
      schema: checkers.schema ?? new SchemaChecker(),
    };
  }

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const issues: VerifierIssue[] = [];
    const risks: string[] = [];
    const evidenceRefs: string[] = [];
    let anyApplicable = false;
    let anyInconclusive = false;

    const ts = await this.checkers.typescript.run({
      workspacePath: input.workspacePath,
      phase: input.phase,
      timeoutMs: input.timeoutMs,
    });
    if (ts.applicable) {
      anyApplicable = true;
      anyInconclusive ||= ts.inconclusive;
      issues.push(...ts.issues);
      risks.push(...ts.risks);
      if (ts.rawLog !== null) {
        evidenceRefs.push(
          await input.writeEvidence(
            `structural-tsc-turn${input.turn}.log`,
            ts.rawLog,
          ),
        );
      }
    }

    const schema = await this.checkers.schema.run({
      workspacePath: input.workspacePath,
      phase: input.phase,
    });
    if (schema.applicable) {
      anyApplicable = true;
      issues.push(...schema.issues);
      risks.push(...schema.risks);
    }

    if (!anyApplicable) {
      return {
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [],
        unresolved_risks: [
          "structural phase 已宣告但無適用 checker：Phase 3 MVP 僅支援 TypeScript 專案（tsconfig.json / *.ts）與 *.schema.json 配對驗證",
        ],
        recommendation: "escalate",
        confidence: 0.3,
        requires_human: false,
      };
    }

    const errorIssues = issues.filter(
      (issue) => issue.severity === "critical" || issue.severity === "major",
    );
    if (errorIssues.length > 0) {
      return {
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: evidenceRefs,
        unresolved_risks: risks,
        recommendation: "retry",
        confidence: 0.9,
        requires_human: false,
        issues,
      };
    }
    if (anyInconclusive) {
      return {
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: evidenceRefs,
        unresolved_risks: risks,
        recommendation: "escalate",
        confidence: 0.5,
        requires_human: false,
        issues,
      };
    }
    return {
      verifier_phase: input.phase,
      status: "passed",
      evidence_refs: evidenceRefs,
      unresolved_risks: [],
      recommendation: "stop",
      confidence: 0.9,
      requires_human: false,
      issues,
    };
  }
}
