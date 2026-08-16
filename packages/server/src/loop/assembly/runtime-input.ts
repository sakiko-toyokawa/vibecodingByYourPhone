/**
 * Loop assembly (spec: docs/spec/01-架构.md loop/assembly).
 *
 * Projects a LoopCard + IntentContract into the native call parameters for
 * Supervisor.startSession: the prompt, the working directory, and the
 * permission settings for the run.
 *
 * Two permission shapes:
 *
 *  1. Legacy read-only (card without loop.policy — phase 0/1 behavior,
 *     unchanged):
 *      - permissionMode "plan" (read-only tools auto-approve);
 *      - explicit deny rules for file-mutating tools;
 *      - the run service auto-denies every approval request (unattended
 *        run: asking would hang the turn).
 *
 *  2. Policy projection (card declares loop.policy, 05 阶段 2):
 *      - permissionMode "bypassPermissions" — claude.ts maps this to
 *        "default" for the SDK so canUseTool fires for EVERY tool call,
 *        and the loop's policy hook (loop/policy/) is the rule source;
 *      - the policy profile (risk_rules / hard_gates / bypass 允许范围)
 *        is resolved here and carried on the RuntimeInput; run-service
 *        builds the per-turn approval hook from it;
 *      - acceptEdits is deliberately NOT used for this tier: at the SDK
 *        level acceptEdits auto-accepts Edit/Write inside the CLI harness
 *        WITHOUT consulting canUseTool (sdk.d.ts: "Auto-accept file edit
 *        operations"), so server-side audit would never see the writes.
 *        The policy arbiter implements the equivalent semantics (medium-
 *        risk workspace writes auto-allowed) with a decision-ledger audit
 *        entry per self-approval — 00 短板表的 acceptEdits 缺口在策略侧
 *        显式降级，偏差素材留 06。
 *      - approval_mode "manual" degrades to the legacy read-only shape
 *        (unattended run cannot wait for human confirmation).
 */

import path from "node:path";
import {
  type BudgetLimits,
  DEFAULT_PROVIDER,
  type ImprovementProposal,
  type IntentContract,
  type LoopCard,
  type PermissionMode,
  type PermissionRules,
  type PolicyProfile,
  type PolicyProjection,
  type ProviderName,
  type RunWorkingState,
  RunWorkingStateSchema,
  type SubTask,
  type TaskPlan,
} from "@yep-anywhere/shared";
import type { MaintenanceTarget } from "../maintenance/types.js";
import { resolvePolicyProfile } from "../policy/profiles.js";
import {
  RESTRICTION_RELEASE_BEGIN,
  RESTRICTION_RELEASE_END,
} from "../policy/restriction-release.js";
import {
  LOOP_PROPOSAL_BEGIN,
  LOOP_PROPOSAL_END,
} from "../proposal/loop-proposal.js";
import {
  ISSUE_PROPOSAL_BEGIN,
  ISSUE_PROPOSAL_END,
  PR_PUBLISH_BEGIN,
  PR_PUBLISH_END,
} from "../relation/pr-publish.js";
import type { RelationRecord } from "../relation/relation-store.js";
import { describeAdapter } from "./adapter-info.js";
import { resolveAdapterPolicy } from "./adapter-policy.js";
import { resolveProposalEffects } from "./proposal-effects.js";
import {
  type RuntimePermissionProjection,
  projectRuntimePermission,
} from "./runtime-permission.js";

/**
 * 执行者自述（02 §5 evidence_refs.executor_summary）的 prompt 契约：
 * 装配层要求 executor 收尾时产出包在这对标记里的结构化自述；run-service
 * 用同一对标记从 finalText 提取并落 executor-summary artifact。verifier
 * 只能拿它辅助理解，不能替代确定性证据。
 */
export const EXECUTOR_SUMMARY_BEGIN = "<<<EXECUTOR-SUMMARY>>>";
export const EXECUTOR_SUMMARY_END = "<<<END-EXECUTOR-SUMMARY>>>";
export const LOOP_STATE_BEGIN = "<<<LOOP-STATE>>>";
export const LOOP_STATE_END = "<<<END-LOOP-STATE>>>";

/**
 * Extract the structured executor self-summary from a turn's final text.
 * Returns null when the executor did not produce the marked block — never
 * fabricates a summary (a missing self-report is itself signal).
 */
export function extractExecutorSummary(finalText: string): string | null {
  const start = finalText.indexOf(EXECUTOR_SUMMARY_BEGIN);
  const end = finalText.indexOf(EXECUTOR_SUMMARY_END);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const summary = finalText
    .slice(start + EXECUTOR_SUMMARY_BEGIN.length, end)
    .trim();
  return summary.length > 0 ? summary : null;
}

/**
 * Extract run-level structured working state from a turn's final text.
 * Returns null on missing/invalid blocks. This channel is fail-open: a
 * missing block must not affect judgment or retry behavior.
 */
export function extractLoopState(finalText: string): RunWorkingState | null {
  const start = finalText.indexOf(LOOP_STATE_BEGIN);
  const end = finalText.indexOf(
    LOOP_STATE_END,
    start === -1 ? 0 : start + LOOP_STATE_BEGIN.length,
  );
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const raw = finalText.slice(start + LOOP_STATE_BEGIN.length, end).trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = RunWorkingStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RuntimeInput {
  prompt: string;
  /** Absolute path of the target project (card.loop.workspace.path). */
  cwd: string;
  permissionMode: PermissionMode;
  permissions: PermissionRules;
  /** Extra env vars for the spawned agent process. */
  env?: Record<string, string>;
  /**
   * Resolved policy profile (loop/policy/). Present only when the card
   * declares loop.policy with a non-manual approval_mode; run-service
   * wires the canUseTool policy hook from it.
   */
  policyProfile?: PolicyProfile;
  /**
   * 02-schema契约.md §3 policy_projection 段（审计/观测用；turn 1 落
   * artifact）。仅在策略投影模式下存在。
   */
  policyProjection?: PolicyProjection;
  /**
   * adapter 调用策略覆盖（阶段 3：来自 published / canary 的
   * runtime_adapter_proposal 的 payload.adapter_policy，原样透传）。
   */
  adapterPolicy?: Record<string, unknown>;
  /**
   * Contract security level projected into the runtime's native permission,
   * sandbox, and approval policy. Used by policy projection and available to
   * session wiring without re-deriving the contract mapping.
   */
  runtimePermission?: RuntimePermissionProjection;
  /**
   * 本次装配实际生效的提案 id（阶段 3 装配消费，审计/观测用）。
   */
  appliedProposals?: string[];
  /**
   * 02 §3 execution_contract 段：结构化的"完成什么"。prompt 是它的
   * 文本投影 (constraints / required_output 都进 prompt, 不再丢失)。
   */
  executionContract: ExecutionContract;
  /**
   * 02 §3 native_invocation 段：adapter/bridge/surface/mode 真实投影
   * (describeAdapter); timeout_seconds 仅在 adapter_policy 提供时非
   * null (06 偏差 #35: 无默认轮次超时, resume_ref 恒 null —— 本 bundle
   * 是首轮装配快照)。
   */
  nativeInvocation: NativeInvocation;
  /**
   * 02 §3 observability 段：本轮必须采集的证据通道声明 (如实反映实现:
   * stderr / transcript 通道不存在, 记 false)。
   */
  observability: ObservabilityDeclaration;
  /** 02 §3 budget_remaining: 本轮开始时的剩余预算 (run-service 经
   *  RuntimeAssemblyContext 传入; 首轮即合约全量)。 */
  budgetRemaining?: BudgetLimits;
  /** Planner 分解的当前轮次要完成的子任务（无 plan 时缺省）。 */
  currentSubtask?: SubTask;
  /** Planner 生成的完整任务计划（无 plan 时缺省）。 */
  taskPlan?: TaskPlan;
}

/** 02 §3 execution_contract (结构化五字段)。 */
export interface ExecutionContract {
  goal: string;
  scope: string[];
  success_criteria: string[];
  constraints: string[];
  /** 执行后必须留下的证据类型 (summary / changed_files / commands_run /
   *  test_results / known_risks 的子集)。 */
  required_output: string[];
}

/** 02 §3 native_invocation (bridge 与原生 mode 两层不混用)。 */
export interface NativeInvocation {
  adapter: string;
  bridge: string;
  surface: string;
  mode: string;
  cwd_ref: string;
  timeout_seconds: number | null;
  resume_ref: string | null;
}

/** 02 §3 observability 采集声明。 */
export interface ObservabilityDeclaration {
  capture_stdout: boolean;
  capture_stderr: boolean;
  capture_structured_output: boolean;
  capture_transcript: boolean;
  capture_diff: boolean;
  capture_exit_code: boolean;
  capture_test_output: boolean;
}

export interface RuntimeAssemblyContext {
  github?: {
    ghPath: string;
    token: string;
  };
  /** 02 §3 memory packet: 失败模式账本 open 模式的确定性摘要 (run-service
   *  构建, 注入 prompt; 与提案模板注入是两条独立路径)。 */
  memoryPacket?: string;
  /** 02 §3 budget_remaining: 本轮开始时的剩余预算 (run-service 从
   *  control-plane 快照计算; 首轮为合约全量)。 */
  budgetRemaining?: BudgetLimits;
  /** Durable external relationship this run is maintaining. */
  relation?: RelationRecord;
  /** Generic external-driven maintenance target this run is serving. */
  maintenanceTarget?: MaintenanceTarget | null;
}

/** File-mutating tools denied outright in legacy read-only runs. */
const READ_ONLY_DENY: string[] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

/** 策略投影模式下注入执行合约的策略说明（裁决仍由 hook 强制执行）。 */
function policyPromptLines(profile: PolicyProfile): string[] {
  return [
    `你正在以无人值守循环任务运行，策略档：'${profile.policy_profile}'（审批模式：${profile.approval_mode}）。`,
    "",
    "策略规则（由运行时强制执行；违规将被拒绝）：",
    "- 本地、可逆的工作空间内操作 —— 编辑工作区文件、运行测试/构建/lint —— 自动通过，且每次自动通过都会被审计。",
    "- 硬闸门动作（merge、deploy、删除外部资源、publish、bill、notify、close）会被拦截并升级为人工复核。不要尝试执行；请在报告中记录。",
    `- 如果某个被拦截的硬闸门动作确实必要，请勿重试；在最终报告中输出 ${RESTRICTION_RELEASE_BEGIN} JSON（包含 tool、input、reason）${RESTRICTION_RELEASE_END}。人类批准后，下一轮只能执行完全相同的 tool call 一次。`,
    "- 高风险或超出工作区的动作会被拒绝或升级。请始终待在工作区内。",
    "- 不要调用 ExitPlanMode 或 AskUserQuestion —— 本轮无人值守；以纯文本报告结束任务。",
  ];
}

function isGitHubPromptLoop(card: LoopCard): boolean {
  return card.loop.discovery?.source === "github_prompt";
}

function isGitHubManagedLoop(card: LoopCard): boolean {
  return isGitHubPromptLoop(card);
}

function githubLoopStateLines(): string[] {
  return [
    "- 每輪結束時輸出 LOOP-STATE JSON 塊，承載供下一輪使用的領域狀態：",
    LOOP_STATE_BEGIN,
    '{ "run_id": "<run id>", "updated_at": "<ISO timestamp>", "turn": <turn>, "selected_subject": { "repository": "<owner/repo>", "issue_url": "<issue url>", "issue_number": <issue number>, "clone_path": "<absolute clone repo root>", "branch": "<branch>", "base_sha": "<base sha>" }, "subtask_status": [{ "id": "<subtask id>", "status": "done", "outputs": "<one-line summary>" }] }',
    LOOP_STATE_END,
    "- 選定 issue 後 selected_subject 必填；clone_path 必須是實際 clone 出來的 repo 根絕對路徑。",
  ];
}

function githubPromptLines(
  github: RuntimeAssemblyContext["github"],
  publishMode: "pr" | "issue" = "pr",
): string[] {
  const ghPath = github?.ghPath ?? "gh";
  if (publishMode === "issue") {
    return [
      "GitHub issue 调研循环（publish_mode=issue）",
      "",
      "使用 GitHub CLI 进行发现与仓库阅读。",
      `- GitHub CLI 路径：${ghPath}`,
      "- 任务目标是调研 / 复现一个 bug 并产出高质量 issue 提案，不是提交代码修复。",
      "- 把目标仓库克隆到当前工作区的子目录；需要复现时在本地构建 / 运行，但不要 fork、push、创建 PR、评论或直接创建 issue。",
      "- 先读仓库的贡献指南（CONTRIBUTING、docs/contributing 等），issue 内容遵循其规范——邀请制仓库（如 openai/codex）要的是带分析的 issue，不是外部 PR。",
      "- 复现尽力而为：间歇性 bug 复现不出时，产出复现脚本 + 源码根因分析 + 疑似位置同样有价值。",
      "- issue 正文必须包含：环境（版本 / OS）、复现步骤、期望行为、实际行为、根因假设（附源码 文件:行号 证据）、已排除的可能性。",
      "- 结束前检查目标仓库是否已有相同问题的 open issue；有则不要提案，改在报告中说明并等待人工决定。",
      "- 结束时报告：做了什么、复现结果、分析结论、残留不确定性。",
      "- 必须在报告末尾输出 issue 提案交接块，供人工批准后由 server 发布：",
      ISSUE_PROPOSAL_BEGIN,
      '{ "repository": "<owner/repo>", "title": "<issue title>", "body": "<issue body markdown>" }',
      ISSUE_PROPOSAL_END,
      "- 不要输出第二个提案块；不要输出 PR-PUBLISH。",
      ...githubLoopStateLines(),
    ];
  }
  return [
    "GitHub issue 修复循环",
    "",
    "使用 GitHub CLI 进行发现与仓库操作。",
    `- GitHub CLI 路径：${ghPath}`,
    "- 除非用户提示缩小了范围，否则搜索全 GitHub 公开仓库。",
    "- 自行将用户的自然语言请求转换为 GitHub 搜索；用户不需要懂搜索语法。",
    "- 每次最多选择 1 个 issue。",
    "- 优先选择容易合并的 issue：维护者近期活跃、复现步骤清晰、带有 bug/help wanted/good first issue 标签、影响面小、有可见的贡献或 PR 规范，并且你能在本地运行测试。",
    "- 编辑前阅读 issue、仓库 README、贡献指南以及 PR 规范（如果有的话）。",
    "- 选定 issue 前，先检查 open PR、remote branches 与 issue comments，确认没有同范围的已有修复；若已存在重复 PR，改选其他 issue。",
    "- 将当前工作目录视为服务端管理的主工作区；把选中的仓库克隆到它的子目录中。",
    "- 在工作区内克隆选中仓库，创建分支，做出最小合理修复，运行相关检查，并创建本地 git 提交。",
    "- 提交时必须使用 clone 内已配置的 verified git identity；不要用 `-c user.name` / `-c user.email` 或 `git config` 覆盖，也不要在 PR-PUBLISH 中填写 author_name/author_email。",
    "- 不要 fork、push、创建 pull request、评论、关闭 issue、release、deploy 或删除外部资源。",
    "- 结束时提供：选中的仓库和 issue URL、分支、本地提交哈希、验证命令与结果、重複 PR 检查结果、残留风险，以及 PR 标题和正文草稿。",
    "- 如果已完成本地修复并提交，必须在报告末尾输出 PR 发布交接块，供人工批准后由 server 发布：",
    PR_PUBLISH_BEGIN,
    '{ "repository": "<owner/repo>", "branch": "<local branch>", "title": "<PR title>", "body": "<PR body>", "cwd": "<absolute clone repo path>" }',
    PR_PUBLISH_END,
    "- cwd 必须是实际 clone 出来、包含本地提交的仓库绝对路径；不要使用 managed workspace 根目录。",
    "- 输出 PR-PUBLISH 前，再次检查 open PR、remote branches 与 issue comments；若已出现同范围重复 PR，不要输出 PR-PUBLISH，改在报告中标明并等待人工决定。",
    "- 不要输出第二个 PR 发布块；没有可发布的本地提交时不要输出该块。",
    ...githubLoopStateLines(),
  ];
}

function relationPromptLines(relation: RelationRecord): string[] {
  const lines = [
    "外部關係維護模式",
    `- relation_id: ${relation.relation_id}`,
    `- state: ${relation.state}`,
    "- 只處理這個 relation 的目標與回饋，不要重新搜尋新 issue。",
    "- 這個 relation 對應的 open PR 是本次維護目標，不是重複 PR；不要把它當成 duplicate。",
    "- 維護模式不輸出 PR-PUBLISH 或 ISSUE-PROPOSAL；不要建立、更新或替換 PR / issue。",
    "- 先判斷 comments / reviews / CI 是否需要修復；不需要時回報 idle 並結束。",
  ];
  if (relation.subject.type === "github_issue") {
    lines.push(
      `- repository: ${relation.subject.repository}`,
      ...(relation.subject.issue_number
        ? [`- issue_number: ${relation.subject.issue_number}`]
        : []),
      "- 這個 relation 對應的是已發布的 issue；跟踪維護者的回應，需要回覆或補充信息時在報告中給出建議文本，等待人工發送。",
    );
  }
  if (relation.subject.type === "github_pr") {
    lines.push(
      `- repository: ${relation.subject.repository}`,
      ...(relation.subject.issue_number
        ? [`- issue_number: ${relation.subject.issue_number}`]
        : []),
      ...(relation.subject.pr_number
        ? [`- pr_number: ${relation.subject.pr_number}`]
        : []),
      `- branch: ${relation.subject.branch}`,
      ...(relation.subject.base_sha
        ? [`- base_sha: ${relation.subject.base_sha}`]
        : []),
      "- 先讀取最新 comments / reviews / CI status，再判斷 idle、修復或 needs_human。",
    );
  }
  return lines;
}

/**
 * LOOP-PROPOSAL 閘門教學（P1-7）：仅对卡上显式授权 can_propose_loops 的
 * loop 注入提案块格式说明（默认不教——提不了案是默认态）。
 */
function loopProposalPromptLines(): string[] {
  return [
    "Loop 提案通道（本 loop 已获 can_propose_loops 授权）",
    "",
    "- 当你发现值得长期专项跟进、但超出本 loop 任务范围的问题时，可以提议创建一个新 loop；不要自行扩大本 loop 的任务范围。",
    "- 你只能提议，不能创建：提案经人工批准后才会落地；未批准前不要按提案内容行动。",
    "- 提案卡的约束（钳制层强制，违规即丢弃）：trigger.type 只能是 schedule(cron) 或 manual；workspace 由 server 管理（不要填本地路径）；approval_mode 不得宽于本 loop；stop_rules 有全局封顶。",
    "- 每个 run 最多输出一个提案块；没有值得提案的事项时不要输出。",
    "- 在报告末尾输出提案块：",
    LOOP_PROPOSAL_BEGIN,
    '{ "card": { "loop": { "id": "<kebab-case id>", "trigger": { "type": "schedule", "cron": "<cron expr>" }, "workspace": { "strategy": "direct" }, "verification": { "required": ["static"] }, "persistence": { "state_file": ".loop/STATE.md" }, "stop_rules": { "max_turns": <n>, "max_time_minutes": <n>, "max_retries": <n> }, "handoff": { "task": "<任务描述>" } } }, "reason": "<为什么需要这个 loop>" }',
    LOOP_PROPOSAL_END,
  ];
}

function maintenanceTargetPromptLines(target: MaintenanceTarget): string[] {
  return [
    "外部維護模式",
    `- target_id: ${target.target_id}`,
    `- target_type: ${target.target_type}`,
    `- state: ${target.state}`,
    `- trigger_types: ${target.wake_policy.trigger_types.join(", ")}`,
    "- 只處理這個維護目標的上下文與回饋，不要重新開始新任務。",
    "- 目標已存在是維護模式的正常狀態，不是重複；不要因此 needs_human。",
    "- 維護模式不輸出 PR-PUBLISH；不需要修復時回報 idle。",
    `- context_payload: ${JSON.stringify(target.context_payload)}`,
  ];
}

export function assembleRuntimeInput(
  card: LoopCard,
  contract: IntentContract,
  /**
   * 阶段 3 装配消费：published / canary 提案（proposalStore.listProposals()
   * 原样传入即可，生效范围与槽位选择由 proposal-effects 按 loop_id 解析）。
   * 缺省为空 —— 无提案时装配行为与阶段 2 完全一致。
   */
  proposals: ImprovementProposal[] = [],
  context: RuntimeAssemblyContext = {},
  /** Current turn number (1-based); used to select the active subtask from contract.plan. */
  turn = 1,
): RuntimeInput {
  const loop = card.loop;
  const cwd = loop.workspace.path;
  if (!cwd) {
    throw new AssemblyError(
      `Loop '${loop.id}' has no workspace.path — a target project path is required to start a run`,
    );
  }

  const discovery = loop.discovery ?? {};
  const handoff = loop.handoff ?? {};
  const maxItems = handoff.max_items_per_run;

  // 阶段 3：消费 published / canary 提案（published 全量生效；canary 只
  // 对打了标记的 loop 生效）。rolled_back 的最新版本被过滤后旧 published
  // 版本自动回补（回滚即回到旧行为，版本记录不删）。
  const effects = resolveProposalEffects(loop.id, proposals);

  const profile = resolvePolicyProfile(card, effects.policyProfileOverride);
  // policy_profile_proposal 的策略档名覆盖只在策略投影模式下生效（card
  // 未声明 policy 时不为单个提案开启整条策略管线）；覆盖经注册表解析
  // 出真实规则差异 (profiles.ts NAMED_PROFILES), 不只是换标签。
  // manual 无人值守 = 只读兜底（无法等待人工确认），走 legacy 形状。
  const policyActive = profile !== null && profile.approval_mode !== "manual";

  // Fail-closed 守卫（06 偏差 #24/#39）：策略钩子的已验证规则来源是
  // Claude 桥的 canUseTool（agent_sdk）与 Codex 桥的策略投影映射
  // （policyHookWired → approvalPolicy on-request + sandbox read-only,
  // 一切变更都发审批反向请求到钩子, codex.ts）。其余 provider 的审批
  // 路径未经同样验证。未知 = 不安全：policy run 落在未接线桥上直接
  // 拒绝装配，不静默退化为无策略执行。
  const provider =
    (card.loop as { runtime?: { provider?: string } }).runtime?.provider ??
    DEFAULT_PROVIDER;
  if (policyActive && profile) {
    const POLICY_CAPABLE_PROVIDERS = new Set([
      "claude",
      "claude-ollama",
      "codex",
      "codex-oss",
    ]);
    if (!POLICY_CAPABLE_PROVIDERS.has(provider)) {
      throw new AssemblyError(
        `Loop '${loop.id}' declares a policy (approval_mode=${profile.approval_mode}) but provider '${provider}' cannot enforce it: the policy hook is only a verified rule source on the Claude bridge (agent_sdk canUseTool) and the Codex bridge (policyHookWired maps approvals to on-request/read-only). Use provider 'claude' or 'codex', or drop loop.policy.`,
      );
    }
  }

  // 02 §3 execution_contract: 结构化五字段 —— prompt 是它的文本投影
  // (constraints 与 required_output 随之进 prompt, 不再丢失)。
  const requiredOutput = [
    "summary",
    "known_risks",
    ...(policyActive ? ["changed_files", "commands_run"] : []),
    ...(loop.verification.required.some(
      (p) => p === "static" || p === "runtime",
    )
      ? ["test_results"]
      : []),
  ];
  const executionContract: ExecutionContract = {
    goal: contract.raw_goal,
    scope: [cwd],
    success_criteria: [...contract.success_criteria],
    constraints: [...contract.constraints],
    required_output: requiredOutput,
  };

  // 02 §3 native_invocation: provider → adapter/bridge/surface/mode 真实
  // 投影 (describeAdapter); timeout_seconds 仅在 adapter_policy 提供时
  // 非 null (06 偏差 #35: 无默认轮次超时)。
  const adapterInfo = describeAdapter(provider);
  const policyTimeoutMs = resolveAdapterPolicy(effects.adapterPolicy).timeoutMs;
  const nativeInvocation: NativeInvocation = {
    adapter: adapterInfo.adapter,
    bridge: adapterInfo.bridge,
    surface: adapterInfo.surface,
    mode: adapterInfo.mode,
    cwd_ref: `workspace://${loop.id}`,
    timeout_seconds: policyTimeoutMs ? policyTimeoutMs / 1000 : null,
    // 本 bundle 是首轮装配快照; 后续轮会开 fresh session, 但沿用这份
    // standing prompt 作为任务契约, 再叠加 AU2 handoff 交接上下文。
    resume_ref: null,
  };

  // 02 §3 observability: 如实声明采集通道 (stderr / transcript 通道在
  // ProcessEvent 层不存在, 记 false —— 不伪造采集能力)。
  // P1 评估结论: ProcessEvent (supervisor/types.ts) 只有 message /
  // state-change 等归一事件, 无原始 stderr / transcript 通道; 打通需在
  // 各 provider bridge 层截获子进程 stderr, 属 supervisor 改造, 不在
  // verifier P1 范围 —— 保持 false, 待独立任务排期。
  const observability: ObservabilityDeclaration = {
    capture_stdout: true,
    capture_stderr: false,
    capture_structured_output: true,
    capture_transcript: false,
    capture_diff: true,
    capture_exit_code: true,
    capture_test_output: true,
  };

  const taskPlan = contract.plan;
  const currentSubtask =
    taskPlan && taskPlan.subtasks.length > 0
      ? taskPlan.subtasks[Math.min(turn, taskPlan.subtasks.length) - 1]
      : undefined;

  const bundleExtras = {
    executionContract,
    nativeInvocation,
    observability,
    ...(context.budgetRemaining
      ? { budgetRemaining: context.budgetRemaining }
      : {}),
    ...(taskPlan ? { taskPlan } : {}),
    ...(currentSubtask ? { currentSubtask } : {}),
  };

  const prompt = [
    ...(isGitHubPromptLoop(card)
      ? [
          ...githubPromptLines(context.github, card.loop.handoff?.publish_mode),
          "",
        ]
      : []),
    ...(context.relation ? [...relationPromptLines(context.relation), ""] : []),
    ...(context.maintenanceTarget
      ? [...maintenanceTargetPromptLines(context.maintenanceTarget), ""]
      : []),
    // P1-7: 提案教学仅对显式授权 can_propose_loops 的 loop 注入
    ...(card.loop.can_propose_loops === true
      ? [...loopProposalPromptLines(), ""]
      : []),
    ...(policyActive && profile
      ? policyPromptLines(profile)
      : [
          "你正在以无人值守、只读循环任务运行（权限模式：plan）。",
          "",
          "硬性规则（违规将被自动拒绝）：",
          "- 只能扫描、读取和报告。不要创建、修改或删除任何文件。不要运行变更性命令。",
          "- 不要调用 ExitPlanMode 或 AskUserQuestion —— 所有审批请求都会被自动拒绝；以纯文本报告结束任务。",
          "- 只使用只读工具（Read、Glob、Grep 等）。",
        ]),
    // published / canary 的 memory packet 模板注入 prompt（装配消费的
    // 主落点，05 阶段 3 验收 5：新 run 装配确实使用新提案内容）。
    ...(effects.memoryPacketTemplate
      ? ["", "Memory packet（已发布改进提案）：", effects.memoryPacketTemplate]
      : []),
    // 02 §3 memory packet: 失败模式账本的 open 模式摘要 (另一条独立路
    // 径 —— 提案模板是"怎么改", 账本摘要是"哪些坑已知")。
    ...(context.memoryPacket
      ? [
          "",
          "已知失败模式（失败模式账本 —— 不要重复这些）：",
          context.memoryPacket,
        ]
      : []),
    "",
    "任务：",
    `- 任务类型：${contract.task_type.primary}`,
    `- 目标：${contract.raw_goal}`,
    discovery.source ? `- 发现来源：${discovery.source}` : null,
    discovery.query ? `- 发现查询：${discovery.query}` : null,
    maxItems !== undefined ? `- 最多报告 ${maxItems} 项。` : null,
    ...(taskPlan
      ? [
          "",
          "任务分解（多轮执行）：",
          `- 总子任务数：${taskPlan.subtasks.length}`,
          ...taskPlan.subtasks.map((s) => `  - ${s.id}: ${s.description}`),
        ]
      : []),
    "",
    "成功标准：",
    ...contract.success_criteria.map((c) => `- ${c}`),
    ...(executionContract.constraints.length > 0
      ? ["", "约束：", ...executionContract.constraints.map((c) => `- ${c}`)]
      : []),
    // 02 §2 target.files 的最小消费：作为"重点范围"进 prompt，提示
    // executor 优先关注这些文件。这只是注意力提示，不是访问控制 —— 不缩
    // 权限、不做强制约束（权限边界仍由 permission/policy 层裁决），也
    // 不禁止读取其他文件。
    ...(contract.target?.files?.length
      ? [
          "",
          "重点范围（注意力提示，非访问控制 —— 优先关注以下文件，但不限制读取其他文件）：",
          ...contract.target.files.map((f) => `- ${f}`),
        ]
      : []),
    "",
    "必须留下的输出证据：",
    ...requiredOutput.map((o) => `- ${o}`),
    "",
    "报告格式（纯文本，按以下顺序）：",
    "1. 扫描范围",
    "2. 发现项（逐条列出）",
    "3. 建议人工复核的后续事项",
    "",
    "每輪結束時輸出 LOOP-STATE JSON 塊，承載可供下一輪使用的領域狀態；若本輪沒有可交接狀態則省略：",
    LOOP_STATE_BEGIN,
    '{ "run_id": "<run id>", "updated_at": "<ISO timestamp>", "turn": <turn>, "selected_subject": null, "subtask_status": [] }',
    LOOP_STATE_END,
    "",
    "执行者摘要（必填；校验者会把它作为你的自述来辅助理解 —— 它只帮助理解，不能替代确定性证据）：",
    "在报告末尾用以下标记精确包裹结构化自述：",
    EXECUTOR_SUMMARY_BEGIN,
    "- 已完成：你实际做了什么（不是你计划做什么）",
    "- 未完成：你没做什么，以及原因",
    ...(taskPlan ? ["- 子任务：当前完成的子任务 ID，以及剩余子任务"] : []),
    "- 风险：校验者应复核的开放问题",
    "- 文件：触及或检查的关键文件",
    EXECUTOR_SUMMARY_END,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // Contract security level is the source of truth. The policy hook adds
  // "untrusted" so every file/command action reaches the loop arbiter; the
  // native sandbox still comes from the contract (see runtime-permission.ts).
  const runtimePermission = projectRuntimePermission(contract.security_level, {
    policyHookWired: policyActive,
    bridge: adapterInfo.bridge,
  });
  const permissionMode = runtimePermission.permissionMode;

  if (!policyActive || !profile) {
    return {
      prompt,
      cwd,
      permissionMode,
      runtimePermission,
      permissions: { deny: [...READ_ONLY_DENY] },
      ...bundleExtras,
      // GitHub managed loop 的 legacy (无 policy) 分支同样注入 GH_TOKEN/gh PATH —
      // 此前 env 只在策略分支返回, 无 policy 的 github 卡拿到 gh 指令却拿
      // 不到 token (修复计划留档项)。
      ...(isGitHubManagedLoop(card) && context.github
        ? {
            env: {
              GH_TOKEN: context.github.token,
              GITHUB_TOKEN: context.github.token,
              PATH: `${path.dirname(context.github.ghPath)}${path.delimiter}${process.env.PATH ?? ""}`,
            },
          }
        : {}),
      ...(effects.adapterPolicy
        ? { adapterPolicy: effects.adapterPolicy }
        : {}),
      ...(effects.applied.length > 0
        ? { appliedProposals: effects.applied.map((a) => a.proposal_id) }
        : {}),
    };
  }

  return {
    prompt,
    cwd,
    permissionMode,
    runtimePermission,
    // 显式规则留空：裁决全部走策略钩子（钩子对任何调用都会给出结论）。
    permissions: {},
    ...bundleExtras,
    ...(isGitHubManagedLoop(card) && context.github
      ? {
          env: {
            GH_TOKEN: context.github.token,
            GITHUB_TOKEN: context.github.token,
            PATH: `${path.dirname(context.github.ghPath)}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        }
      : {}),
    policyProfile: profile,
    policyProjection: {
      policy_intent_ref: `policy://${profile.policy_profile}`,
      sandbox: runtimePermission.sandbox,
      approval_or_permission_mode: `${runtimePermission.approvalPolicy}+${runtimePermission.permissionMode}`,
      // 显式 allow/deny 清单为空是设计使然: 一切工具调用都经策略钩子
      // 裁决 (钩子即规则来源), 不是"未配置"。
      allowed_tools: [],
      disallowed_tools: [],
      hard_gates: [...profile.hard_gates],
    },
    ...(effects.adapterPolicy ? { adapterPolicy: effects.adapterPolicy } : {}),
    ...(effects.applied.length > 0
      ? { appliedProposals: effects.applied.map((a) => a.proposal_id) }
      : {}),
  };
}
