import { existsSync } from "node:fs";
import path from "node:path";
import type { VerifierIssue } from "@yep-anywhere/shared";
import { runCommand } from "../../subprocess-verifier.js";
import { buildImportGraph, findCycles } from "./import-graph.js";

/**
 * TypeScript structural checker（Phase 3 MVP）。
 *
 * 兩個檢查：
 * 1. tsc --noEmit diagnostics（型別錯誤 / 未定義引用）：解析
 *    `file(line,col): error TSxxxx: message` 行為結構化 issue。
 * 2. 循環依賴：regex import graph + DFS（見 import-graph.ts 的誠實限制）。
 *
 * tsc 命令可注入（測試用）；預設 `npx --no-install tsc --noEmit` ——
 * 用 workspace 自己的 TypeScript，本包不新增依賴。workspace 無 tsconfig
 * 或 tsc 不存在（spawn_failed / 127）時記 inconclusive 證據而非假裝通過。
 */

export interface CheckerOutcome {
  issues: VerifierIssue[];
  /** 寫進 report.unresolved_risks 的人讀錯誤摘要。 */
  risks: string[];
  /** tsc 原始輸出（由 strategy 決定是否落盤為 evidence）。 */
  rawLog: string | null;
  /** checker 是否適用（workspace 無 TS 痕跡時 false）。 */
  applicable: boolean;
  /** checker 自身無法完成（如 tsc 不存在）時為 true。 */
  inconclusive: boolean;
}

const TSC_DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

export class TypeScriptChecker {
  readonly name = "typescript";

  constructor(
    private readonly tscCommand = "npx --no-install tsc --noEmit --pretty false",
  ) {}

  async run(input: {
    workspacePath: string;
    phase: VerifierIssue["layer"];
    timeoutMs?: number;
  }): Promise<CheckerOutcome> {
    const graph = await buildImportGraph(input.workspacePath);
    const hasTsconfig = existsSync(
      path.join(input.workspacePath, "tsconfig.json"),
    );
    if (graph.fileCount === 0 && !hasTsconfig) {
      return {
        issues: [],
        risks: [],
        rawLog: null,
        applicable: false,
        inconclusive: false,
      };
    }

    const issues: VerifierIssue[] = [];
    const risks: string[] = [];
    let rawLog: string | null = null;
    let inconclusive = false;

    // 1. tsc diagnostics（僅有 tsconfig 時；無 tsconfig 的散裝 TS 檔不跑，
    //    tsc 無 config 時的行為不可預期）。
    if (hasTsconfig) {
      const outcome = await runCommand(this.tscCommand, {
        cwd: input.workspacePath,
        timeoutMs: input.timeoutMs,
      });
      rawLog = `$ ${this.tscCommand}\noutcome: ${outcome.kind}${
        outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""
      } in ${outcome.durationMs}ms\n\n${outcome.output}`;
      if (outcome.kind === "exit" && outcome.exitCode !== 0) {
        for (const line of outcome.output.split("\n")) {
          const diag = line.trim().match(TSC_DIAGNOSTIC_RE);
          if (diag) {
            const [, file, lineNo, col, code, message] = diag;
            issues.push({
              id: `${code}@${file}:${lineNo}`,
              severity: "major",
              layer: input.phase,
              location: {
                file: file ?? "",
                line: Number(lineNo),
                column: Number(col),
              },
              message: `${code}: ${message}`,
            });
          }
        }
        risks.push(
          issues.length > 0
            ? `tsc --noEmit 報 ${issues.length} 個型別錯誤（詳見 issues / evidence log）`
            : `tsc --noEmit 退出碼 ${outcome.exitCode}（輸出無法解析為 diagnostics，見 evidence log）`,
        );
      } else if (outcome.kind !== "exit") {
        inconclusive = true;
        risks.push(
          outcome.kind === "timeout"
            ? `tsc --noEmit 逾時（${input.timeoutMs ?? "default"}ms）`
            : "tsc 在此 workspace 不可執行（spawn_failed）——無法取得型別診斷",
        );
      }
    }

    // 2. 循環依賴
    const cycles = findCycles(graph);
    for (const cycle of cycles) {
      issues.push({
        id: `circular-dependency@${cycle[0]}`,
        severity: "major",
        layer: input.phase,
        location: { file: cycle[0] ?? "" },
        message: `循環依賴: ${cycle.join(" -> ")}`,
        suggestion: "抽出共用模組或改用依賴注入打開循環",
      });
      risks.push(`循環依賴: ${cycle.join(" -> ")}`);
    }

    return {
      issues,
      risks,
      rawLog,
      applicable: true,
      inconclusive,
    };
  }
}
