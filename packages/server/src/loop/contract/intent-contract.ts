/**
 * Intent contract construction (spec: docs/spec/02-schema契约.md §2,
 * 05-分阶段计划.md 阶段 2 "合约加停止规则与预算字段的完整校验").
 *
 * Builds a v1 IntentContract from a LoopCard. Budget validation (phase 2):
 * - stop_rules → budget 投影：max_turns / max_time_minutes / max_retries
 *   照抄 LoopCard.stop_rules（预算与停止规则.md: stop_rules 中的同名字段是
 *   budget 向执行侧的投影，不得另立数值）。contract 层用共享 BudgetSchema
 *   复核（缺省 / 非法值在 API 层已被 400 拒绝，这里是构造期兜底，违例抛
 *   ContractValidationError）。max_retries >= max_turns 合法（先触者停
 *   语义，06 偏差 #31——曾经的严格小于 refine 是私加约束，已移除）。
 * - max_turns 必须 >= 1（含首轮——首轮都跑不了的合约无意义）、
 *   max_retries 必须 >= 0、max_time_minutes 必须 > 0。
 * - max_tokens：LoopCard 没有 token 预算来源，写 0 = "不跟踪"（不参与
 *   停止判定）；这是明确默认值，不是缺省拒绝。
 *
 * Other phase-0 simplifications still in effect:
 * - no clarification / ambiguity flow (requires_clarification = false)
 * - the contract is validated against IntentContractSchema before use and
 *   snapshotted to the run's artifacts by the run service
 * - target.files（02 §2）由 handoff.task 自由文本启发式提取（见
 *   extractTargetFiles 的口径注释），提取为空时字段如实缺省
 */

import {
  type BudgetLimits,
  BudgetSchema,
  type IntentContract,
  IntentContractSchema,
  type LoopCard,
  type SecurityLevel,
  type TaskPlan,
} from "@yep-anywhere/shared";

export type ContractSource = "cron" | "manual";

/** stop_rules / budget 校验失败（构造期兜底；正常路径 API 层已 400）。 */
export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

/**
 * Project LoopCard.stop_rules into the contract's budget (数值权威来源是
 * budget, 02 §2) with full validation. Returns the validated budget limits.
 */
export function buildBudgetLimits(card: LoopCard): BudgetLimits {
  const rules = card.loop.stop_rules;
  if (rules.max_turns < 1) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_turns must be >= 1 (max_turns 含首轮——首轮必须能跑)`,
    );
  }
  if (rules.max_retries < 0) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_retries must be >= 0 (max_retries 不含首轮)`,
    );
  }
  if (rules.max_time_minutes <= 0) {
    throw new ContractValidationError(
      `Loop '${card.loop.id}' stop_rules.max_time_minutes must be > 0`,
    );
  }
  // used_* 缺省 0; max_retries >= max_turns 合法 (先触者停语义,
  // 06 偏差 #31 —— 不再有严格小于 refine)。
  // max_tokens = 0 = 不跟踪（LoopCard 无 token 预算来源，明确默认值）。
  const budget = BudgetSchema.parse({
    max_tokens: 0,
    max_time_minutes: rules.max_time_minutes,
    max_turns: rules.max_turns,
    max_retries: rules.max_retries,
  });
  return {
    max_tokens: budget.max_tokens,
    max_time_minutes: budget.max_time_minutes,
    max_turns: budget.max_turns,
    max_retries: budget.max_retries,
  };
}

/** target.files 提取上限（防止超长 task 文本灌入大量候选）。 */
const MAX_TARGET_FILES = 20;

/**
 * 从 handoff.task 自由文本启发式提取 target.files（02 §2 的收敛目标文件）。
 *
 * 口径与限制（诚实口径，注释钉死）：
 * - task 是自由任务描述文本，LoopCard 没有精确的文件/符号来源，只能做
 *   形态匹配：含 "/" 且以扩展名结尾的 token 视为相对路径候选（如
 *   packages/server/src/loop/run-service.ts、src/foo/bar.tsx）。
 * - 剥离 token 首尾的常见标点（引号、反引号、逗号、句号、括号等）后再
 *   判定；结果去重，最多保留 MAX_TARGET_FILES 个。
 * - 只认相对路径形态：以 "/" 开头（POSIX 绝对路径）、含 ":"（Windows
 *   盘符或 URL）、含 ".."（父目录逃逸）的候选一律丢弃。
 * - symbols 不填：自由文本里无法可靠区分符号名与普通单词，宁缺不伪造。
 * - 一个候选都提不到时返回空数组，调用方不设 target 字段（optional 字
 *   段如实缺省，不伪造）。
 */
export function extractTargetFiles(task: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const raw of task.split(/\s+/)) {
    // 剥离首尾标点（含常见中文标点）；路径内部字符（/ . - _ 字母数字）
    // 不受影响。
    const token = raw.replace(
      /^[\\"'`([{<（【《“”‘’]+|[\\"'`)\]}>,.;:!?。，、；：？！”’）】》]+$/g,
      "",
    );
    if (!token.includes("/")) continue;
    if (!/\.[A-Za-z0-9]{1,10}$/.test(token)) continue;
    if (token.startsWith("/") || token.includes(":") || token.includes("..")) {
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    files.push(token);
    if (files.length >= MAX_TARGET_FILES) break;
  }
  return files;
}

export function buildIntentContract(
  card: LoopCard,
  options: {
    runId: string;
    source: ContractSource;
    plan?: TaskPlan;
  },
): IntentContract {
  const loop = card.loop;
  const discovery = loop.discovery ?? {};
  const handoff = loop.handoff ?? {};

  // 策略模式（非 manual approval_mode）生成可写合约：约束从"只读"变为
  // "工作区边界内"，outcome 允许有边界的修改。manual / 无 policy 块保持
  // 阶段 0/1 的只读形状。裁决依据是 card 原始字段，不引入 policy 模块依赖。
  const approvalMode = loop.policy?.approval_mode;
  const writeCapable = approvalMode !== undefined && approvalMode !== "manual";

  // 安全等级：由 approval_mode / policy 确定，决定执行器使用哪种权限模式。
  // GitHub prompt 模式需要 full_access（gh 命令涉及网络访问）；无 policy 的
  // legacy GitHub prompt 保持 read_only（与阶段 0/1 行为一致）。
  const isGitHubPrompt = discovery.source === "github_prompt";
  const securityLevel: SecurityLevel = isGitHubPrompt
    ? writeCapable
      ? "full_access"
      : "read_only"
    : writeCapable
      ? "workspace_write"
      : "read_only";

  const rawGoal =
    handoff.task ??
    [
      writeCapable
        ? `Loop '${loop.id}' task`
        : `Loop '${loop.id}' read-only scan`,
      discovery.source ? `source=${discovery.source}` : null,
      discovery.query ? `query=${discovery.query}` : null,
    ]
      .filter(Boolean)
      .join("; ");

  const constraints: string[] = [
    writeCapable ? "workspace_bounded" : "read_only",
  ];
  if (handoff.max_items_per_run !== undefined) {
    constraints.push(`max_items_per_run=${handoff.max_items_per_run}`);
  }

  // 02 §2 target.files：从 handoff.task 自由文本启发式提取相对路径形态
  // 的候选（见 extractTargetFiles 的口径注释）。无 task 或提取为空时不设
  // target（optional 字段如实缺省）；symbols 无从可靠识别，不填。
  const targetFiles = handoff.task ? extractTargetFiles(handoff.task) : [];

  return IntentContractSchema.parse({
    intent_id: `intent-${options.runId}`,
    source: options.source === "cron" ? "cron" : "ui",
    raw_goal: rawGoal,
    task_type: {
      primary:
        handoff.default_task_type ??
        (writeCapable ? "maintenance" : "read_only_report"),
      confidence: 1,
      requires_clarification: false,
    },
    outcome: writeCapable
      ? "完成任务目标并产出结果报告：允许在工作区内做有边界的修改；merge/deploy/delete/publish/bill/notify/close 等硬闸门动作禁止，发现需要时在报告中注明"
      : "一份只读扫描报告：列出发现与建议，不对工作区做任何修改（报告即结果，无验证层）",
    success_criteria: writeCapable
      ? [
          "任务目标完成并产出报告文本",
          "修改不超出工作区边界",
          "未尝试硬闸门动作",
        ]
      : ["只读扫描完成并产出报告文本", "工作区未产生任何写改动"],
    constraints,
    budget: buildBudgetLimits(card),
    ...(targetFiles.length > 0 ? { target: { files: targetFiles } } : {}),
    ...(options.plan ? { plan: options.plan } : {}),
    // 02 §2 stop_rules 投影: card 的 stop_on_repeated_failure →
    // repetition.max_same_failure (control-plane 按同一阻断指纹计数消费;
    // safety/ambiguity 段机制未建, 不投影)。
    ...(card.loop.stop_rules.stop_on_repeated_failure !== undefined
      ? {
          stop_rules: {
            repetition: {
              max_same_failure: card.loop.stop_rules.stop_on_repeated_failure,
            },
          },
        }
      : {}),
    security_level: securityLevel,
  });
}
