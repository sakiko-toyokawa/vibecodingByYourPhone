/**
 * Eval 最小集 runner (spec: docs/spec/05-分阶段计划.md 阶段 3 "eval 最小集:
 * 挂 loop/learning/ 下游的 benchmark case 与 scorecard, 供 regression 档
 * 复跑"; loop-engineering/loop-state-and-learning/提案验证与发布.md
 * "Eval / Benchmark / Regression 是提案发布的闸门").
 *
 * Benchmark case 格式: `<dataDir>/loops/eval/cases.json`
 * (~/.yep-anywhere/loops/eval/cases.json):
 *
 * ```json
 * {
 *   "version": 1,
 *   "cases": [
 *     {
 *       "case_id": "builtin-tool_error",
 *       "category": "tool_error",          // 覆盖的失败归因类别 (8 值词汇)
 *       "loop_id": "loop_ci_fix",          // 目标 loop (可选, 观测用)
 *       "workspace": "E:/repo",            // 目标工作区 (可选, 命令 cwd)
 *       "command": "node",                  // 静态验证命令 (确定性子进程)
 *       "args": ["-e", "process.exit(0)"],
 *       "expect": "pass"                    // 预期: 命令应通过 / 应失败
 *     }
 *   ]
 * }
 * ```
 *
 * 文件缺失时写入内置初始集并返回 —— 内置集覆盖全部 8 个失败归因类别
 * 各一例 (05 风险节: "至少覆盖各失败归因类别一例"), 全部用确定性命令
 * 构造 ("static 命令应通过" exit 0 / "应失败" exit 1), 不依赖被测工作区。
 *
 * Scorecard: 每次复跑产出一份, 落 `<dataDir>/loops/eval/results/` 并随
 * 提案 history 引用 (regression 档全部通过才放行; shadow 档只观察)。
 * cases.json 损坏时 loadCases 抛错 —— 闸门 fail-closed: 没有可验证的
 * eval 集时 regression 档不得放行 (verifier theater 防御, 尺子不能失踪)。
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FailureTagSchema } from "@yep-anywhere/shared";
import { z } from "zod";

/** benchmark case (见文件头); category 用全库统一的 8 值失败归因词汇. */
export const EvalCaseSchema = z.object({
  case_id: z.string(),
  category: FailureTagSchema,
  /** 目标 loop (可选, 观测/归属用) */
  loop_id: z.string().optional(),
  /** 目标工作区 (可选; 设了 command 就在该目录执行) */
  workspace: z.string().optional(),
  /** 静态验证命令 */
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** 预期: 命令应通过 (exit 0) 还是应失败 (非 0) */
  expect: z.enum(["pass", "fail"]),
  description: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const EvalCasesFileSchema = z.object({
  version: z.number(),
  cases: z.array(EvalCaseSchema),
});

export interface EvalCaseResult {
  case_id: string;
  category: EvalCase["category"];
  expect: EvalCase["expect"];
  /** 实际: 命令 exit 0 → pass, 否则 fail (超时/启动失败按 fail 计) */
  actual: "pass" | "fail";
  /** actual === expect */
  ok: boolean;
  exit_code: number | null;
  error?: string;
  duration_ms: number;
}

export interface EvalScorecard {
  scorecard_id: string;
  /** regression = 发布闸门 (全过才放行); shadow = 旁路观察记录 */
  mode: "shadow" | "regression";
  /** 复跑所属的提案 (regression/shadow 档记提案 history 时引用) */
  proposal_id?: string;
  ran_at: string;
  total: number;
  passed: number;
  failed: number;
  /** 全部 case 符合预期 */
  ok: boolean;
  results: EvalCaseResult[];
}

export class EvalRunnerError extends Error {
  constructor(
    readonly code: "invalid_cases",
    message: string,
  ) {
    super(message);
    this.name = "EvalRunnerError";
  }
}

export interface EvalRunnerOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/eval/ under it */
  dataDir?: string;
  /** 单条命令超时 (默认 30s) */
  timeoutMs?: number;
  /** 时钟注入 (测试用) */
  now?: () => Date;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

/**
 * 内置初始集: 8 个失败归因类别各一例, 确定性命令 ("应通过" exit 0 /
 * "应失败" exit 1)。用 process.execPath (node) 保证任何装了 server 的
 * 机器上可复跑, 不依赖被测工作区。
 */
function builtinCases(): EvalCase[] {
  const node = process.execPath;
  const passArgs = ["-e", "process.exit(0)"];
  const failArgs = ["-e", "process.exit(1)"];
  return FailureTagSchema.options.map((category) => ({
    case_id: `builtin-${category}`,
    category,
    command: node,
    args: category === "eval_regression" ? failArgs : passArgs,
    expect:
      category === "eval_regression" ? ("fail" as const) : ("pass" as const),
    description:
      category === "eval_regression"
        ? `内置 case (${category}): static 命令应失败 — exit 1 符合预期`
        : `内置 case (${category}): static 命令应通过 — exit 0 符合预期`,
  }));
}

export class EvalRunner {
  private readonly evalDir: string;
  private readonly resultsDir: string;
  private readonly casesFile: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: EvalRunnerOptions = {}) {
    this.evalDir = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "eval",
    );
    this.resultsDir = path.join(this.evalDir, "results");
    this.casesFile = path.join(this.evalDir, "cases.json");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Load benchmark cases. Missing file → seed the built-in initial set
   * (覆盖各失败归因类别一例) and return it. Corrupt / schema-invalid →
   * EvalRunnerError (fail-closed: regression 档不得在无有效 eval 集时放行).
   */
  async loadCases(): Promise<EvalCase[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.casesFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const cases = builtinCases();
        await fs.mkdir(this.evalDir, { recursive: true });
        await fs.writeFile(
          this.casesFile,
          JSON.stringify({ version: 1, cases }, null, 2),
          "utf-8",
        );
        return cases;
      }
      throw error;
    }
    try {
      return EvalCasesFileSchema.parse(JSON.parse(raw)).cases;
    } catch (error) {
      throw new EvalRunnerError(
        "invalid_cases",
        `eval cases file ${this.casesFile} is corrupt or schema-invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 复跑整个 eval 集并持久化 scorecard 到 eval/results/。regression 档的
   * 放行判据是返回值的 ok (全部 case 符合预期)。
   */
  async run(options: {
    mode: "shadow" | "regression";
    proposalId?: string;
  }): Promise<EvalScorecard> {
    const cases = await this.loadCases();
    const results: EvalCaseResult[] = [];
    for (const evalCase of cases) {
      results.push(await this.runCase(evalCase));
    }
    const failed = results.filter((r) => !r.ok).length;
    const ranAt = this.now();
    const scorecard: EvalScorecard = {
      scorecard_id: this.scorecardId(options.mode, options.proposalId, ranAt),
      mode: options.mode,
      proposal_id: options.proposalId,
      ran_at: ranAt.toISOString(),
      total: results.length,
      passed: results.length - failed,
      failed,
      ok: failed === 0 && results.length > 0,
      results,
    };
    await fs.mkdir(this.resultsDir, { recursive: true });
    await fs.writeFile(
      path.join(this.resultsDir, `${scorecard.scorecard_id}.json`),
      JSON.stringify(scorecard, null, 2),
      "utf-8",
    );
    return scorecard;
  }

  /** 执行单条 case: exit 0 → pass, 非 0 / 超时 / 启动失败 → fail. */
  private runCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      execFile(
        evalCase.command,
        evalCase.args,
        {
          cwd: evalCase.workspace,
          timeout: this.timeoutMs,
          // 子进程输出不进 scorecard (闸门只看退出码); 限制缓冲防爆内存
          maxBuffer: 256 * 1024,
          windowsHide: true,
        },
        (error, _stdout, _stderr) => {
          // execFile: error 为 null 即 exit 0; 否则 code 是退出码
          // (被杀/启动失败时可能不是数字, 统一按 fail 计)。
          const exitCode = error
            ? typeof error.code === "number"
              ? error.code
              : 1
            : 0;
          const actual: "pass" | "fail" = error ? "fail" : "pass";
          resolve({
            case_id: evalCase.case_id,
            category: evalCase.category,
            expect: evalCase.expect,
            actual,
            ok: actual === evalCase.expect,
            exit_code: exitCode,
            error: error
              ? error.killed
                ? `timeout after ${this.timeoutMs}ms`
                : error.message
              : undefined,
            duration_ms: Date.now() - startedAt,
          });
        },
      );
    });
  }

  /** scorecard 文件名安全 id (Windows 文件名不能有冒号). */
  private scorecardId(
    mode: string,
    proposalId: string | undefined,
    at: Date,
  ): string {
    const stamp = at.toISOString().replace(/[:.]/g, "-");
    const scope = (proposalId ?? "suite").replace(/[^A-Za-z0-9._-]/g, "_");
    return `${mode}-${scope}-${stamp}`;
  }
}
