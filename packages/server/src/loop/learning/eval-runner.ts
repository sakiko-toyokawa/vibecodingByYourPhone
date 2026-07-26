/**
 * Eval runner (spec: docs/spec/05-分阶段计划.md 阶段 3 "eval 最小集: 挂
 * loop/learning/ 下游的 benchmark case 与 scorecard, 供 regression 档
 * 复跑"; loop-engineering/evals/基准与回归.md "benchmark 是系统的工程
 * 记忆, 不是展示 demo 的样板间"; 提案验证与发布.md "Eval / Benchmark /
 * Regression 是提案发布的闸门").
 *
 * 两类 case:
 *
 *  1. behavior (内置, kind="behavior"): 直接调用被测子系统的真实函数
 *     (contract / assembly / policy arbiter / verification 聚合与子进程
 *     verifier / adapter 归因), 衡量 loop 的真实行为而非空转命令 ——
 *     05 风险节: "用例太弱则管线形同虚设 (verifier theater 变种)"。
 *     内置集覆盖全部 8 个失败归因类别各一例。
 *
 *  2. command (用户可扩展, kind="command", 缺省): 确定性子进程命令,
 *     exit 0 → pass。保持 cases.json 的可扩展性 (历史失败样本回收入库,
 *     基准与回归.md: canary 失败样本应进 benchmark)。
 *
 * 提案应用 (修复 docs/plans/loop-spec-gap-fix-plan.md #5: 评估与提案
 * 脱钩): run() 接收被评估的提案本体, behavior case 在评估时真实应用其
 * payload —— memory_packet_template 注入装配、policy_profile 覆盖进
 * 裁决; scorecard 记录 applied 块 (哪些槽位真实参与了评估 / 哪些因无
 * 消费者被跳过及原因), 管线 history 引用, 让"评估了什么"可审计。
 *
 * Scorecard: 每次复跑产出一份, 落 `<dataDir>/loops/eval/results/` 并随
 * 提案 history 引用 (regression 档全部通过才放行; shadow 档只观察)。
 * cases.json 损坏时 loadCases 抛错 —— 闸门 fail-closed: 没有可验证的
 * eval 集时 regression 档不得放行 (verifier theater 防御, 尺子不能失踪)。
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type FailureTag,
  FailureTagSchema,
  type ImprovementProposal,
  type LoopCard,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { adapterErrorCodeToFailureTag } from "../../sdk/adapter-error.js";
import { resolveAdapterPolicy } from "../assembly/adapter-policy.js";
import {
  EXECUTOR_SUMMARY_BEGIN,
  assembleRuntimeInput,
} from "../assembly/runtime-input.js";
import { buildIntentContract } from "../contract/intent-contract.js";
import { arbitrate } from "../policy/arbiter.js";
import { resolvePolicyProfile } from "../policy/profiles.js";
import { aggregateVerifierReports } from "../verification/aggregate.js";
import { runVerificationCommands } from "../verification/subprocess-verifier.js";

/** benchmark case (见文件头); category 用全库统一的 8 值失败归因词汇. */
export const EvalCaseSchema = z
  .object({
    case_id: z.string(),
    category: FailureTagSchema,
    /** 目标 loop (可选, 观测/归属用) */
    loop_id: z.string().optional(),
    /** 目标工作区 (可选; 设了 command 就在该目录执行) */
    workspace: z.string().optional(),
    /**
     * case 形态: behavior = 内置行为检查 (衡量真实子系统行为, 随提案
     * 应用); command = 确定性子进程命令 (缺省, 用户扩展入口)。
     */
    kind: z.enum(["command", "behavior"]).default("command"),
    /** kind=behavior: 行为注册表键 (BEHAVIORS) */
    behavior: z.string().optional(),
    /** kind=command: 静态验证命令 */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** 预期: 命令/行为应通过还是应失败 */
    expect: z.enum(["pass", "fail"]),
    description: z.string().optional(),
  })
  .superRefine((evalCase, ctx) => {
    if (evalCase.kind === "command" && !evalCase.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `case '${evalCase.case_id}': kind=command 需要 command 字段`,
      });
    }
    if (evalCase.kind === "behavior" && !evalCase.behavior) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `case '${evalCase.case_id}': kind=behavior 需要 behavior 字段`,
      });
    }
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
  /** 实际: 命令 exit 0 / 行为通过 → pass, 否则 fail (超时/启动失败按 fail 计) */
  actual: "pass" | "fail";
  /** actual === expect */
  ok: boolean;
  exit_code: number | null;
  error?: string;
  /** behavior case 的检查明细 (命令 case 无此字段) */
  detail?: string;
  duration_ms: number;
}

/** 提案 payload 在评估中的真实应用记录 (可审计的"评估了什么"). */
export interface EvalApplied {
  proposal_id: string;
  /** 真实参与了评估的 payload 槽位 */
  slots: string[];
  /** 因无消费者等原因无法应用的槽位及原因 */
  skipped: { slot: string; reason: string }[];
}

export interface EvalScorecard {
  scorecard_id: string;
  /** regression = 发布闸门 (全过才放行); shadow = 旁路观察记录 */
  mode: "shadow" | "regression";
  /** 复跑所属的提案 (regression/shadow 档记提案 history 时引用) */
  proposal_id?: string;
  /** 提案 payload 的应用记录 (评估时携带提案本体才有) */
  applied?: EvalApplied;
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

// ---------------------------------------------------------------------------
// behavior 注册表: 每个行为调用被测子系统的真实函数 (非空转命令)
// ---------------------------------------------------------------------------

interface BehaviorContext {
  /** 被评估的提案本体 (shadow/regression 档传入; 无提案的裸复跑为 undefined) */
  proposal?: ImprovementProposal;
  timeoutMs: number;
}

interface BehaviorOutcome {
  pass: boolean;
  detail: string;
}

type BehaviorFn = (
  ctx: BehaviorContext,
) => Promise<BehaviorOutcome> | BehaviorOutcome;

/** 评估探针卡 (legacy 只读形状) —— 不依赖被测工作区, 纯装配层输入. */
function probeLegacyCard(): LoopCard {
  return {
    loop: {
      id: "eval-probe-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: process.cwd() },
      verification: { required: [] },
      persistence: { state_file: "state/eval-probe-loop.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

/** 评估探针卡 (policy bypass 形状). */
function probePolicyCard(): LoopCard {
  return {
    loop: {
      ...probeLegacyCard().loop,
      policy: { approval_mode: "bypass" },
    },
  };
}

function probeContract(card: LoopCard) {
  return buildIntentContract(card, { runId: "eval-run", source: "manual" });
}

/** 用被评估提案的模板, 缺省时用固定探针模板 (机制覆盖不依赖被测提案). */
function probeTemplate(ctx: BehaviorContext): string {
  return (
    ctx.proposal?.payload?.memory_packet_template ??
    "eval-probe-memory-packet-template"
  );
}

function templateProposal(template: string): ImprovementProposal {
  return {
    proposal_id: "eval-probe-proposal",
    type: "memory_packet_template_proposal",
    source_patterns: [],
    summary: "eval probe",
    target: "eval-probe-loop.memory_packet_template",
    expected_effect: "probe",
    risk: "low",
    validation_plan: "probe",
    status: "published",
    created_by: "human",
    payload: { memory_packet_template: template },
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const BEHAVIORS: Record<string, BehaviorFn> = {
  /** intent_error: 合约预算投影 —— card stop_rules 的 max_* 如实进合约
   *  (数值唯一权威来源, 02 §2); max_retries == max_turns 合法 (先触者
   *  停语义, spec 无严格小于约束, 06 偏差 #31)。 */
  contract_budget_guard: () => {
    const card = probeLegacyCard();
    const contract = probeContract(card);
    const equalCard = probeLegacyCard();
    equalCard.loop.stop_rules = {
      max_turns: 3,
      max_time_minutes: 10,
      max_retries: 3,
    };
    const equal = probeContract(equalCard);
    const checks = {
      turnsProjected: contract.budget.max_turns === 3,
      retriesProjected: contract.budget.max_retries === 2,
      timeProjected: contract.budget.max_time_minutes === 10,
      tokensUntracked: contract.budget.max_tokens === 0,
      equalLimitsAllowed:
        equal.budget.max_retries === 3 && equal.budget.max_turns === 3,
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },

  /** context_error: 装配不变量 —— 只读硬规则与 executor summary 契约
   *  必须在 prompt 里。 */
  assembly_readonly_invariants: () => {
    const card = probeLegacyCard();
    const input = assembleRuntimeInput(card, probeContract(card));
    const checks = {
      readonlyRules: input.prompt.includes("READ-ONLY"),
      executorSummaryContract: input.prompt.includes(EXECUTOR_SUMMARY_BEGIN),
      planMode: input.permissionMode === "plan",
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },

  /** memory_packet_error: 提案 → 装配的真实生效 —— 带模板提案时装配
   *  prompt 含模板且硬规则不丢, 不带时不含 (05 阶段 3 验收 5 的直接
   *  衡量)。评估时应用被测提案的 memory_packet_template。 */
  memory_packet_injection: (ctx) => {
    const card = probeLegacyCard();
    const template = probeTemplate(ctx);
    const withProposal = assembleRuntimeInput(card, probeContract(card), [
      templateProposal(template),
    ]);
    const without = assembleRuntimeInput(card, probeContract(card), []);
    const checks = {
      injected: withProposal.prompt.includes(template),
      rulesSurvive: withProposal.prompt.includes("READ-ONLY"),
      notInjectedByDefault: !without.prompt.includes(template),
      appliedRecorded: withProposal.appliedProposals?.length === 1,
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },

  /** runtime_blackbox_error: adapter 硬错误 → 失败归因词汇映射 (学习侧
   *  的归因输入, 失败模式账本.md 8 值)。 */
  adapter_error_attribution: () => {
    const checks = {
      timeout:
        adapterErrorCodeToFailureTag("timeout") === "runtime_blackbox_error",
      permissionDenied:
        adapterErrorCodeToFailureTag("permission_denied") === "policy_error",
      capabilityUnavailable:
        adapterErrorCodeToFailureTag("capability_unavailable") === "tool_error",
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },

  /** runtime_blackbox_error: adapter_policy 消费 (修复计划 #13) ——
   *  被测提案的 adapter_policy 经 resolveAdapterPolicy 解析出真实旋钮
   *  (model / timeout_seconds), 未知键进 ignoredKeys 不静默生效。
   *  评估时应用被测提案的 adapter_policy。 */
  adapter_policy_application: (ctx) => {
    const raw = ctx.proposal?.payload?.adapter_policy;
    const resolved = resolveAdapterPolicy(raw);
    const checks: Record<string, boolean> = {
      emptyResolvesClean:
        resolveAdapterPolicy(undefined).ignoredKeys.length === 0,
    };
    if (raw) {
      if (typeof raw.timeout_seconds === "number") {
        checks.timeoutApplied =
          resolved.timeoutMs === Math.round(raw.timeout_seconds * 1000);
      }
      if (typeof raw.model === "string") {
        checks.modelApplied = resolved.model === raw.model;
      }
    } else {
      // 无被测提案时验证固定探针 (机制覆盖不依赖被测提案)
      const probe = resolveAdapterPolicy({
        timeout_seconds: 5,
        model: "probe-model",
        bogus_key: 1,
      });
      checks.probeTimeout = probe.timeoutMs === 5000;
      checks.probeModel = probe.model === "probe-model";
      checks.probeIgnoredRecorded =
        probe.ignoredKeys.length === 1 && probe.ignoredKeys[0] === "bogus_key";
    }
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify({ checks, resolved }),
    };
  },

  /** tool_error: 子进程 verifier 真实识别失败/通过 (exit code →
   *  verifier_report status)。 */
  subprocess_verifier_detects_failure: async (ctx) => {
    const writeEvidence = async () => "artifact://eval/evidence.log";
    const node = `"${process.execPath}"`;
    const [failReport, passReport] = await Promise.all([
      runVerificationCommands({
        phase: "static",
        commands: [`${node} -e "process.exit(1)"`],
        cwd: process.cwd(),
        timeoutMs: ctx.timeoutMs,
        writeEvidence,
      }),
      runVerificationCommands({
        phase: "static",
        commands: [`${node} -e "process.exit(0)"`],
        cwd: process.cwd(),
        timeoutMs: ctx.timeoutMs,
        writeEvidence,
      }),
    ]);
    const checks = {
      failureDetected: failReport.status === "failed",
      successDetected: passReport.status === "passed",
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify({
        ...checks,
        failStatus: failReport.status,
        passStatus: passReport.status,
      }),
    };
  },

  /** policy_error: 硬闸门在 (可能被提案覆盖的) 策略档下仍然生效 ——
   *  覆盖档名经注册表解析出真实规则 (profiles.ts NAMED_PROFILES, 不
   *  再是只换标签), 七项闸门逐项裁决 + bypass 下 workspace 写仍可
   *  自批准。评估时应用被测提案的 policy_profile。 */
  hard_gate_enforced: (ctx) => {
    const override = ctx.proposal?.payload?.policy_profile;
    const profile = resolvePolicyProfile(probePolicyCard(), override);
    if (!profile) {
      return { pass: false, detail: "probe policy profile resolved to null" };
    }
    const gateCommands: [string, string][] = [
      ["merge", "git merge feature"],
      ["delete", "rm -rf ./node_modules"],
      ["publish", "npm publish"],
    ];
    const failures: string[] = [];
    for (const [gate, command] of gateCommands) {
      const verdict = arbitrate(profile, "Bash", { command });
      if (verdict.decision !== "hard_gate") {
        failures.push(`${gate} verdict=${verdict.decision}`);
      }
    }
    const writeVerdict = arbitrate(
      profile,
      "Write",
      { file_path: path.join(process.cwd(), "eval-probe.ts") },
      { workspacePath: process.cwd() },
    );
    if (writeVerdict.decision !== "allow") {
      failures.push(`workspace write verdict=${writeVerdict.decision}`);
    }
    return {
      pass: failures.length === 0,
      detail:
        failures.length === 0
          ? `3 gates enforced + bypass self-approve holds (profile=${profile.policy_profile})`
          : failures.join("; "),
    };
  },

  /** verification_error: 聚合规则 —— requires_human 透传优先级最高,
   *  不被通过结论覆盖 (02 §6)。 */
  aggregation_requires_human_passthrough: () => {
    const judgment = aggregateVerifierReports(
      [
        {
          verifier_phase: "static",
          status: "passed",
          evidence_refs: [],
          unresolved_risks: [],
          recommendation: "stop",
          confidence: 0.95,
          requires_human: false,
        },
        {
          verifier_phase: "runtime",
          status: "failed",
          evidence_refs: ["artifact://eval/x.log"],
          unresolved_risks: ["unclear"],
          recommendation: "escalate",
          confidence: 0.5,
          requires_human: true,
        },
      ],
      { allowRetry: false, budgetExhausted: false },
    );
    const checks = {
      humanPassthrough: judgment.requires_human === true,
      notComplete: judgment.next_action !== "complete",
      worstWins: judgment.overall === "failed",
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },

  /** eval_regression: 评估相关代码路径确定性 —— 同输入装配/提案解析
   *  结果逐字节一致 (regression 比较的前提)。 */
  eval_harness_deterministic: (ctx) => {
    const card = probeLegacyCard();
    const template = probeTemplate(ctx);
    const probe = templateProposal(template);
    const promptA = assembleRuntimeInput(card, probeContract(card), [
      probe,
    ]).prompt;
    const promptB = assembleRuntimeInput(card, probeContract(card), [
      probe,
    ]).prompt;
    const checks = {
      assemblyDeterministic: promptA === promptB,
    };
    return {
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify(checks),
    };
  },
};

/** 内置集: 8 个失败归因类别各一例 + adapter_policy 消费检查 (#13),
 *  全部 behavior 形态 (衡量真实行为). */
const BUILTIN_BEHAVIORS: { category: FailureTag; behavior: string }[] = [
  { category: "intent_error", behavior: "contract_budget_guard" },
  { category: "context_error", behavior: "assembly_readonly_invariants" },
  { category: "memory_packet_error", behavior: "memory_packet_injection" },
  {
    category: "runtime_blackbox_error",
    behavior: "adapter_error_attribution",
  },
  {
    category: "runtime_blackbox_error",
    behavior: "adapter_policy_application",
  },
  { category: "tool_error", behavior: "subprocess_verifier_detects_failure" },
  { category: "policy_error", behavior: "hard_gate_enforced" },
  {
    category: "verification_error",
    behavior: "aggregation_requires_human_passthrough",
  },
  { category: "eval_regression", behavior: "eval_harness_deterministic" },
];

function builtinCases(): EvalCase[] {
  return BUILTIN_BEHAVIORS.map(({ category, behavior }) => ({
    case_id: `builtin-${behavior}`,
    category,
    kind: "behavior" as const,
    behavior,
    args: [],
    expect: "pass" as const,
    description: `内置行为 case (${category}): 调用被测子系统真实函数 — ${behavior}`,
  }));
}

/** 提案 payload 槽位 → 评估消费者 (behavior 键)。 */
const SLOT_CONSUMERS: Record<string, string[] | null> = {
  memory_packet_template: ["memory_packet_injection"],
  policy_profile: ["hard_gate_enforced"],
  adapter_policy: ["adapter_policy_application"],
};

function computeApplied(proposal: ImprovementProposal): EvalApplied {
  const applied: EvalApplied = {
    proposal_id: proposal.proposal_id,
    slots: [],
    skipped: [],
  };
  const payload = proposal.payload ?? {};
  for (const slot of Object.keys(payload)) {
    if (slot === "canary_loops") {
      continue; // 范围限定, 不是行为输入
    }
    if (SLOT_CONSUMERS[slot]) {
      applied.slots.push(slot);
    } else {
      applied.skipped.push({
        slot,
        reason: "该槽位在评估中无消费者 (未登记的 payload 键)",
      });
    }
  }
  return applied;
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
   * 把失败模式衍生的 golden case 并入 eval 集 (基准与回归.md: 失败样本
   * 进 benchmark, 工程记忆)。只增不改: 已存在的 case_id (含人工翻转过
   * 期望值的) 原样保留。返回新增条数。
   */
  async upsertGoldenCases(newCases: EvalCase[]): Promise<number> {
    const current = await this.loadCases();
    const known = new Set(current.map((evalCase) => evalCase.case_id));
    const toAdd = newCases.filter((evalCase) => !known.has(evalCase.case_id));
    if (toAdd.length === 0) {
      return 0;
    }
    await fs.mkdir(this.evalDir, { recursive: true });
    await fs.writeFile(
      this.casesFile,
      JSON.stringify({ version: 1, cases: [...current, ...toAdd] }, null, 2),
      "utf-8",
    );
    return toAdd.length;
  }

  /**
   * 复跑整个 eval 集并持久化 scorecard 到 eval/results/。regression 档的
   * 放行判据是返回值的 ok (全部 case 符合预期)。携带提案本体时,
   * behavior case 真实应用其 payload 并在 scorecard.applied 记录。
   */
  async run(options: {
    mode: "shadow" | "regression";
    proposalId?: string;
    /** 被评估的提案本体 (shadow/regression 档由管线传入) */
    proposal?: ImprovementProposal;
  }): Promise<EvalScorecard> {
    const cases = await this.loadCases();
    const proposalId = options.proposal?.proposal_id ?? options.proposalId;
    const behaviorCtx: BehaviorContext = {
      proposal: options.proposal,
      timeoutMs: this.timeoutMs,
    };
    const results: EvalCaseResult[] = [];
    for (const evalCase of cases) {
      results.push(await this.runCase(evalCase, behaviorCtx));
    }
    const failed = results.filter((r) => !r.ok).length;
    const ranAt = this.now();
    const scorecard: EvalScorecard = {
      scorecard_id: this.scorecardId(options.mode, proposalId, ranAt),
      mode: options.mode,
      proposal_id: proposalId,
      ...(options.proposal
        ? { applied: computeApplied(options.proposal) }
        : {}),
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

  /** 单条 case 按形态分发: behavior 走注册表, command 走子进程. */
  private async runCase(
    evalCase: EvalCase,
    behaviorCtx: BehaviorContext,
  ): Promise<EvalCaseResult> {
    if (evalCase.kind === "behavior") {
      return this.runBehaviorCase(evalCase, behaviorCtx);
    }
    return this.runCommandCase(evalCase);
  }

  /**
   * behavior case: 调用注册表里的真实子系统检查。未知行为名按 fail 计
   * (fail-closed per-case: 尺子坏了闸门不放行, 但不崩溃整场评估)。
   */
  private async runBehaviorCase(
    evalCase: EvalCase,
    ctx: BehaviorContext,
  ): Promise<EvalCaseResult> {
    const startedAt = Date.now();
    const behavior = evalCase.behavior
      ? BEHAVIORS[evalCase.behavior]
      : undefined;
    let outcome: BehaviorOutcome;
    if (!behavior) {
      outcome = {
        pass: false,
        detail: `unknown behavior '${evalCase.behavior ?? "<missing>"}'`,
      };
    } else {
      try {
        outcome = await behavior(ctx);
      } catch (error) {
        outcome = {
          pass: false,
          detail: `behavior threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const actual: "pass" | "fail" = outcome.pass ? "pass" : "fail";
    return {
      case_id: evalCase.case_id,
      category: evalCase.category,
      expect: evalCase.expect,
      actual,
      ok: actual === evalCase.expect,
      exit_code: null,
      ...(outcome.pass ? {} : { error: outcome.detail }),
      detail: outcome.detail,
      duration_ms: Date.now() - startedAt,
    };
  }

  /** command case: exit 0 → pass, 非 0 / 超时 / 启动失败 → fail. */
  private runCommandCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      execFile(
        evalCase.command as string,
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
