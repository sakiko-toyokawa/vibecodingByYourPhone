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

import type {
  IntentContract,
  LoopCard,
  PermissionMode,
  PermissionRules,
  PolicyProfile,
  PolicyProjection,
} from "@yep-anywhere/shared";
import { resolvePolicyProfile } from "../policy/profiles.js";

export interface RuntimeInput {
  prompt: string;
  /** Absolute path of the target project (card.loop.workspace.path). */
  cwd: string;
  permissionMode: PermissionMode;
  permissions: PermissionRules;
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

export function assembleRuntimeInput(
  card: LoopCard,
  contract: IntentContract,
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

  const profile = resolvePolicyProfile(card);
  // manual 无人值守 = 只读兜底（无法等待人工确认），走 legacy 形状。
  const policyActive = profile !== null && profile.approval_mode !== "manual";

  const prompt = [
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
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (!policyActive || !profile) {
    return {
      prompt,
      cwd,
      permissionMode: "plan",
      permissions: { deny: [...READ_ONLY_DENY] },
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
    policyProfile: profile,
    policyProjection: {
      policy_intent_ref: `policy://${profile.policy_profile}`,
      sandbox: "workspace-write",
      approval_or_permission_mode: "bypass_self_approve_with_audit",
      allowed_tools: [],
      disallowed_tools: [],
      hard_gates: [...profile.hard_gates],
    },
  };
}
