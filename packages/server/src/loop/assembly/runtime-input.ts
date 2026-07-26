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
  DEFAULT_PROVIDER,
  type ImprovementProposal,
  type IntentContract,
  type LoopCard,
  type PermissionMode,
  type PermissionRules,
  type PolicyProfile,
  type PolicyProjection,
  type ProviderName,
} from "@yep-anywhere/shared";
import { resolvePolicyProfile } from "../policy/profiles.js";
import { resolveProposalEffects } from "./proposal-effects.js";

/**
 * 执行者自述（02 §5 evidence_refs.executor_summary）的 prompt 契约：
 * 装配层要求 executor 收尾时产出包在这对标记里的结构化自述；run-service
 * 用同一对标记从 finalText 提取并落 executor-summary artifact。verifier
 * 只能拿它辅助理解，不能替代确定性证据。
 */
export const EXECUTOR_SUMMARY_BEGIN = "<<<EXECUTOR-SUMMARY>>>";
export const EXECUTOR_SUMMARY_END = "<<<END-EXECUTOR-SUMMARY>>>";

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
   * 本次装配实际生效的提案 id（阶段 3 装配消费，审计/观测用）。
   */
  appliedProposals?: string[];
}

export interface RuntimeAssemblyContext {
  github?: {
    ghPath: string;
    token: string;
  };
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
    `You are running as an unattended loop task under policy profile '${profile.policy_profile}' (approval mode: ${profile.approval_mode}).`,
    "",
    "Policy rules (enforced by the runtime; violations are denied):",
    "- Local, reversible work — editing files inside the workspace, running tests/builds/lint — is auto-approved and every auto-approval is audited.",
    "- Hard-gate actions (merge, deploy, delete external resources, publish, bill, notify, close) are blocked and escalate the run to human review. Do NOT attempt them; note them in the report instead.",
    "- High-risk or out-of-workspace actions are denied or escalated. Stay inside the workspace.",
    "- Do NOT call ExitPlanMode or AskUserQuestion — the run is unattended; finish by writing the report as plain text.",
  ];
}

function isGitHubPromptLoop(card: LoopCard): boolean {
  return card.loop.discovery?.source === "github_prompt";
}

function githubPromptLines(github: RuntimeAssemblyContext["github"]): string[] {
  const ghPath = github?.ghPath ?? "gh";
  return [
    "GitHub issue repair loop",
    "",
    "Use GitHub CLI for discovery and repository work.",
    `- Use GitHub CLI: ${ghPath}`,
    "- Search across 全 GitHub 公开仓库 unless the user's prompt narrows the scope.",
    "- Translate the user's natural-language request into GitHub searches yourself; the user should not need search syntax.",
    "- 每次最多选择 1 个 issue.",
    "- Prefer issues that are likely to merge: recent maintainer activity, clear reproduction, bug/help wanted/good first issue labels, small surface area, visible contribution or PR guidelines, and tests you can run locally.",
    "- Before editing, read the issue, repository README, contributing guide, and PR conventions when present.",
    "- Treat the current working directory as a server-managed parent workspace; clone the selected repository into a subdirectory of it.",
    "- Clone the selected repository inside this workspace, create a branch, make the smallest reasonable fix, run relevant checks, and create a local git commit.",
    "- Do NOT fork, push, create a pull request, comment, close issues, release, deploy, or delete external resources.",
    "- Finish with: selected repo and issue URL, branch, local commit hash, verification commands and results, residual risk, and PR title and body draft.",
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

  let profile = resolvePolicyProfile(card);
  // policy_profile_proposal 的策略档名覆盖只在策略投影模式下生效（card
  // 未声明 policy 时不为单个提案开启整条策略管线）。
  if (profile && effects.policyProfileOverride) {
    profile = { ...profile, policy_profile: effects.policyProfileOverride };
  }
  // manual 无人值守 = 只读兜底（无法等待人工确认），走 legacy 形状。
  const policyActive = profile !== null && profile.approval_mode !== "manual";

  // Fail-closed 守卫（06 偏差 #24）：策略钩子的唯一已验证规则来源是
  // Claude 桥的 canUseTool（agent_sdk，claude.ts 逐调用触发）。Codex 桥
  // 把 bypassPermissions 映射为 approvalPolicy "never" + danger-full-
  // access（codex.ts mapPermissionModeToThreadPolicy），app-server 不发
  // 审批反向请求——硬闸门、bypass 审计整段失效；其余 provider 的审批
  // 路径未经同样验证。未知 = 不安全：policy run 落在非 Claude 桥上直接
  // 拒绝装配，不静默退化为无策略执行。
  if (policyActive && profile) {
    const provider =
      (card.loop as { runtime?: { provider?: string } }).runtime?.provider ??
      DEFAULT_PROVIDER;
    if (provider !== "claude" && provider !== "claude-ollama") {
      throw new AssemblyError(
        `Loop '${loop.id}' declares a policy (approval_mode=${profile.approval_mode}) but provider '${provider}' cannot enforce it: the policy hook is only a verified rule source on the Claude bridge (agent_sdk canUseTool fires per tool call). On '${provider}' the runtime would bypass approvals (codex maps bypassPermissions to approvalPolicy "never"), so hard gates and bypass auditing would silently not apply. Use provider 'claude' or drop loop.policy.`,
      );
    }
  }

  const prompt = [
    ...(isGitHubPromptLoop(card)
      ? [...githubPromptLines(context.github), ""]
      : []),
    ...(policyActive && profile
      ? policyPromptLines(profile)
      : [
          "You are running as an unattended, READ-ONLY loop task (permission mode: plan).",
          "",
          "Hard rules (violations are auto-denied):",
          "- Only scan, read, and report. Do NOT create, modify, or delete any file. Do NOT run mutating commands.",
          "- Do NOT call ExitPlanMode or AskUserQuestion — every approval request is auto-denied; finish by writing the report as plain text.",
          "- Use only read-only tools (Read, Glob, Grep, etc.).",
        ]),
    // published / canary 的 memory packet 模板注入 prompt（装配消费的
    // 主落点，05 阶段 3 验收 5：新 run 装配确实使用新提案内容）。
    ...(effects.memoryPacketTemplate
      ? [
          "",
          "Memory packet (published improvement proposal):",
          effects.memoryPacketTemplate,
        ]
      : []),
    "",
    "Task:",
    `- Task type: ${contract.task_type.primary}`,
    `- Goal: ${contract.raw_goal}`,
    discovery.source ? `- Discovery source: ${discovery.source}` : null,
    discovery.query ? `- Discovery query: ${discovery.query}` : null,
    maxItems !== undefined ? `- Report at most ${maxItems} items.` : null,
    "",
    "Success criteria:",
    ...contract.success_criteria.map((c) => `- ${c}`),
    "",
    "Report format (plain text, in this order):",
    "1. Scope scanned",
    "2. Findings (itemized)",
    "3. Suggested follow-ups for human review",
    "",
    "Executor summary (required; the verifier reads this as your self-report — it aids understanding but does not replace deterministic evidence):",
    "End your report with a structured self-summary wrapped exactly in these markers:",
    EXECUTOR_SUMMARY_BEGIN,
    "- Done: what you actually did (not what you planned)",
    "- Not done: what you did not do, and why",
    "- Risks: open issues the verifier should double-check",
    "- Files: key files touched or inspected",
    EXECUTOR_SUMMARY_END,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (!policyActive || !profile) {
    return {
      prompt,
      cwd,
      permissionMode: "plan",
      permissions: { deny: [...READ_ONLY_DENY] },
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
    // bypassPermissions → claude.ts 传 SDK 的是 "default"，canUseTool 对
    // 每个工具调用都触发，策略钩子是唯一规则来源。
    permissionMode: "bypassPermissions",
    // 显式规则留空：裁决全部走策略钩子（钩子对任何调用都会给出结论）。
    permissions: {},
    ...(isGitHubPromptLoop(card) && context.github
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
      // 06 #24 守卫后策略 run 只落在 Claude 桥 (agent_sdk): 该桥没有
      // OS 级沙盒, 写边界由策略钩子逐调用强制 —— 如实记 "none", 不再
      // 写死 "workspace-write" (与实际执行面不符的假记录)。
      sandbox: "none",
      approval_or_permission_mode: "bypass_self_approve_with_audit",
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
