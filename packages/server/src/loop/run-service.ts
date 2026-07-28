/**
 * Phase-2 run orchestration (spec: docs/spec/05-分阶段计划.md 阶段 2).
 *
 * Wires trigger → contract → assembly → Supervisor → verification →
 * control-plane into the unattended loop. Phase 2 upgrades the run from
 * phase 1's single turn to a multi-turn execution driven by the full state
 * machine:
 *
 *  - Turn loop: each turn executes, verifies, and lands its judgment in the
 *    control-plane. A `retry` decision waits out the exponential backoff
 *    (1min × 2^(n-1), capped at 5min — retry-backoff.ts) and starts the
 *    next turn on the SAME session via Supervisor.resumeSession (05 阶段 2:
 *    "retry = 新一轮 resumeSession"), so the ledger shows one session_ref
 *    across all turns of a run.
 *
 *  - Retry is evidence passing: the next turn's prompt injects the previous
 *    turn's judgment_report (overall / next_action / evidence /
 *    unresolved_risks) — the session keeps its own context, the injection
 *    tells it exactly what failed verification.
 *
 *  - needs_human / budget_limited / paused are blocking wait states: the
 *    run keeps its active registration (same-loop runs stay serial) and its
 *    execution context is suspended in memory. The control-plane's
 *    ResumeSignal (approve / request_changes / resume signal / budget
 *    supplemented) continues the run with a new turn; human feedback is
 *    injected into that turn's context. After a server restart the context
 *    is rebuilt from the card store + ledger + state file (best effort).
 *
 *  - PATCH pause (主动暂停, 03-API契约.md, 不走审批管线): pauseActiveRun
 *    drives active → paused through the control-plane, then KILLS the
 *    executing process (阶段 2 关键决策 — 选项 A). Rationale for A over
 *    B (let the turn finish, then park): phase 2 has no worktree isolation
 *    and partial-result semantics are undefined — a turn that keeps running
 *    after the human said "pause" would keep mutating the workspace and
 *    would land a judgment for a run that is already paused. The killed
 *    turn's partial result is dropped (no ledger entry / judgment for it);
 *    the session_ref is kept (session jsonl stays on disk) so resume
 *    continues on the SAME session from the next turn. Codex capability
 *    gap (00-落地映射 短板表): codex.ts AgentSession has no graceful
 *    interrupt — only abort — so on a Codex runtime pause/cancel can only
 *    ever kill the process and the partial result is lost; on Claude the
 *    SDK interrupt exists but option A deliberately uniformizes on
 *    terminate so both runtimes share one pause semantics. Recorded as a
 *    known deviation (06).
 *
 *  - Budget: the contract's budget (max_turns 含首轮 / max_retries 不含首轮,
 *    先触者停) is passed to the control-plane every turn together with the
 *    turn's measured consumption (wall-clock minutes; tokens from the
 *    adapter result message's usage, 02 §4 — null when the runtime does
 *    not expose it, never fabricated).
 *
 * Read-only guarantee for LEGACY runs (card without loop.policy, unchanged
 * from phase 0):
 *  1. permissionMode "plan" (read-only tools auto-approve);
 *  2. explicit deny rules for file-mutating tools (assembly);
 *  3. every tool-approval request is auto-denied — the run is unattended,
 *     so an approval prompt would otherwise hang the turn until the idle
 *     timeout.
 *
 * Policy projection (card declares loop.policy, phase 2 second slice):
 * the canUseTool rule source is the policy arbiter (loop/policy/) wired
 * through a per-turn approval hook — local rollbackable work self-approves
 * with a bypass_used decision-ledger audit per call; hard-gate actions
 * (merge/deploy/delete/publish/bill/notify/close) are blocked even under
 * bypass and escalate the run to needs_human via applyJudgment's
 * policyEscalation (05 阶段 2 验收 4). Interactive sessions never carry
 * the hook; their approval flow is untouched.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CollectorReport,
  IntentContract,
  JudgmentReport,
  LoopCard,
  ProviderName,
  RunLedgerEntry,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import {
  CollectorReportSchema,
  DEFAULT_PROVIDER,
  IntentContractSchema,
  TurnHandoffSchema,
} from "@yep-anywhere/shared";
import {
  AdapterError,
  adapterErrorCodeToFailureTag,
} from "../sdk/adapter-error.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { QueueFullResponse } from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import { describeAdapter } from "./assembly/adapter-info.js";
import { resolveAdapterPolicy } from "./assembly/adapter-policy.js";
import {
  AssemblyError,
  type RuntimeAssemblyContext,
  type RuntimeInput,
  assembleRuntimeInput,
  extractExecutorSummary,
} from "./assembly/runtime-input.js";
import {
  type ContractSource,
  buildIntentContract,
} from "./contract/intent-contract.js";
import {
  type ControlPlane,
  ControlPlaneError,
  type ResumeSignal,
} from "./control-plane/control-plane.js";
import { retryBackoffMs } from "./control-plane/retry-backoff.js";
import {
  type PermissionEvent,
  type PolicyEscalation,
  createLoopToolApprovalHook,
} from "./policy/approval-hook.js";
import type { FailurePatternStore } from "./state/failure-pattern-store.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import type { ProposalStore } from "./state/proposal-store.js";
import type { RunLedgerStore } from "./state/run-ledger-store.js";
import { checkRequiredArtifacts } from "./verification/required-artifacts.js";
import {
  type VerificationRefs,
  verificationArtifactName,
  verifyRun,
} from "./verification/verify-run.js";
import {
  type RunWorktree,
  ensureRunWorktree,
  mergeRunWorktree,
  worktreeHasChanges,
} from "./worktree/worktree.js";

export type LoopRunErrorCode =
  | "loop_not_found"
  | "loop_archived"
  | "loop_paused"
  | "run_active"
  | "loop_not_runnable";

export class LoopRunError extends Error {
  constructor(
    readonly code: LoopRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LoopRunError";
  }
}

/** 03 POST /api/loops/:id/runs 的 intent_overrides: 对 LoopCard handoff
 *  的本轮覆盖 (仅影响本次合约构造与装配, 不写回注册表)。 */
export interface IntentOverrides {
  task?: string;
  default_task_type?: string;
  max_items_per_run?: number;
}

export interface RunSummary {
  run_id: string;
  loop_id: string;
  /** "active" while in flight; afterwards the control-plane's latest state */
  state: RunState;
  source: ContractSource;
  created_at: string;
}

/**
 * LedgerSummary — 运行账本 / 决策账本的摘要投影（03-API契约.md
 * "GET /api/runs/:id"），不是全量账本；前端需要明细时按 URI 解析文件。
 */
export interface LedgerSummary {
  turns_used: number;
  retries_used: number;
  /** 合约预算上限（控制面预算快照）；run_state 不属于该 run 时为 null */
  max_turns: number | null;
  max_retries: number | null;
  /** 最新一条决策（decision kind + reason），解释 run 为何处于当前状态 */
  last_decision: { decision: string; reason: string } | null;
  verifier_report_refs: string[];
  judgment_report_ref: string | null;
  collector_report_ref: string | null;
  handoff_ref: string | null;
  blocker_fingerprint: string | null;
  repeated_blocker_count: number;
  /** judgment_report 摘要（overall / next_action / requires_human） */
  judgment_summary: {
    overall: string;
    next_action: string;
    requires_human: boolean;
  } | null;
  decision_refs: string[];
  failure_tags: string[];
}

interface ActiveRun {
  runId: string;
  loopId: string;
  source: ContractSource;
  createdAt: string;
}

interface ExecutionOutcome {
  ok: boolean;
  finalText: string;
  sessionRef: string;
  error?: string;
  /** Token usage from the adapter result message (02 §4); null when absent. */
  usage: { tokens: number } | null;
  /** Set when the failure is a unified adapter hard error (02 §4). */
  adapterError?: AdapterError;
  /** Normalized runtime messages observed during the turn (ProcessEvent
   *  "message" stream, 00 挂载点三: 统一 trace 源). Persisted as the turn's
   *  runtime-events artifact and referenced by the verification input
   *  (02 §5 runtime_event_refs / structured_output). */
  runtimeEvents?: unknown[];
}

interface CollectorOutcome {
  reportRef: string | null;
  outputRef: string | null;
  inputRef: string | null;
  /** collector session 的报告本体 (修复计划 #12: card 要求 review 段时
   *  转成 verifier_report 参与聚合)。 */
  report: CollectorReport | null;
}

/** Everything a suspended (needs_human / budget_limited / paused) run needs
 *  to continue with its next turn after a ResumeSignal. */
interface RunExecutionContext {
  active: ActiveRun;
  card: LoopCard;
  contract: IntentContract | null;
  contractJson: string | null;
  input: RuntimeInput | null;
  turn: number;
  /** Session ref shared by all turns (resumeSession target); null pre-turn-1. */
  sessionRef: string | null;
  lastJudgment: JudgmentReport | null;
  lastJudgmentRef: string | null;
  /** Context injected into the next turn's prompt (retry evidence / human
   *  feedback). Consumed by the next executeTurn call. */
  pendingContext: string | null;
  /** Hard-gate / high-risk escalations recorded by the policy hook during
   *  the current turn (05 阶段 2: 硬闸门拦截升级 needs_human). Reset at
   *  each turn start; drained into applyJudgment after the turn. */
  policyEscalations: PolicyEscalation[];
  /** Permission verdicts recorded by the policy hook during the current
   *  turn (02 §5 permission_event_refs 的证据载体). Reset at each turn
   *  start; persisted as the turn's permission-events artifact. */
  permissionEvents: PermissionEvent[];
  /** Set when contract/assembly setup failed before turn 1 could start. */
  setupError?: Error;
  /** 02 §3 memory packet 的 artifact 内容 (turn 1 落盘; 无 open 模式时
   *  为 null, input_refs.memory_packet 随之 null)。 */
  memoryPacketJson?: string | null;
  /** worktree 隔离证据 (workspace.strategy: "worktree"): setup 时落
   *  workspace.json artifact 并引用进 turn 1 artifact_refs; direct 为 null。 */
  workspaceEvidence?: {
    originPath: string;
    worktreePath: string;
    branch: string;
    baseSha: string;
  } | null;
}

export interface LoopRunServiceDeps {
  supervisor: Supervisor;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  /** Phase-2 control-plane; absent in tests that only exercise phase-0
   *  orchestration (single-turn, verdicts map straight to complete/failed,
   *  no budget enforcement). */
  controlPlane?: ControlPlane;
  /**
   * 阶段 3 装配消费：装配时读取 published / canary 提案（memory packet
   * 模板 / adapter policy / policy profile 覆盖），05 阶段 3 验收 5。
   * 缺席时装配行为与阶段 2 一致（proposals 默认空数组）。
   */
  proposalStore?: ProposalStore;
  /** Backoff wait between retry turns; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Verification seam for tests; defaults to the real verifyRun. */
  verifyRunFn?: typeof verifyRun;
  /** 失败模式账本（02 §8.3）：验证输入的 known_failure_patterns 取自这里
   *  的 open 模式（02 §5）。缺席时退化为空数组（阶段 2 以前行为）。 */
  failurePatternStore?: FailurePatternStore;
  /** GitHub token store used by github_prompt discovery loops. */
  githubCredentialStore?: { getToken(): Promise<string | null> };
  /** Managed gh provisioner used by github_prompt discovery loops. */
  githubToolProvisioner?: {
    ensureGh(): Promise<{ path: string; version: string; installed: boolean }>;
  };
  /** Server data directory; used for managed github_prompt workspaces. */
  dataDir?: string;
}

function makeRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGitHubPromptLoop(card: LoopCard): boolean {
  return card.loop.discovery?.source === "github_prompt";
}

function displayGitHubPromptWorkspacePath(loopId: string): string {
  return `managed://github-workspaces/prompt-loops/${loopId}`;
}

function githubPromptWorkspacePath(dataDir: string, loopId: string): string {
  return path.join(dataDir, "github-workspaces", "prompt-loops", loopId);
}

function loopRuntime(
  card: LoopCard,
): { provider?: string; model?: string } | undefined {
  return (card.loop as { runtime?: { provider?: string; model?: string } })
    .runtime;
}

// describeAdapter 已移至 loop/assembly/adapter-info.ts (装配层与账本共用
// 02 §3 native_invocation / §8.1 runtime 块的同一投影), 此处再导出兼容。
export { describeAdapter } from "./assembly/adapter-info.js";

/** Retry = 证据传递：the next turn gets the previous judgment verbatim. */
function buildRetryContext(
  nextTurn: number,
  judgment: JudgmentReport | null,
  judgmentRef: string | null,
): string {
  const lines = [
    `This is retry turn ${nextTurn} of an unattended read-only loop run. The previous turn failed verification — address the findings below and finish with a text report.`,
    "",
    `Previous judgment (${judgmentRef ?? "not_available"}): overall=${judgment?.overall ?? "unknown"}, next_action=${judgment?.next_action ?? "unknown"}`,
  ];
  if (judgment && judgment.unresolved_risks.length > 0) {
    lines.push("", "Unresolved risks from the previous turn:");
    for (const risk of judgment.unresolved_risks) {
      lines.push(`- ${risk}`);
    }
  }
  if (judgment && judgment.evidence.length > 0) {
    lines.push("", "Evidence refs:");
    for (const ref of judgment.evidence) {
      lines.push(`- ${ref}`);
    }
  }
  return lines.join("\n");
}

/**
 * Drain the current turn's policy escalations into the applyJudgment input.
 * The first escalation carries the decision; additional blocks of the same
 * turn are summarized (each block already has its own policy_blocked
 * decision-ledger entry from the hook).
 */
function drainPolicyEscalation(
  ctx: RunExecutionContext,
): { action: string; reason: string; policyRef: string } | undefined {
  const [first, ...rest] = ctx.policyEscalations;
  if (!first) {
    return undefined;
  }
  return {
    action: first.action,
    reason:
      rest.length === 0
        ? first.reason
        : `${first.reason} (+${rest.length} more policy block(s) this turn, see policy_blocked decision entries)`,
    policyRef: first.policyRef,
  };
}

/** Human response (approve / request_changes / resume / budget) as next-turn context. */
function buildHumanResumeContext(
  signal: ResumeSignal,
  judgment: JudgmentReport | null,
  judgmentRef: string | null,
): string {
  const lines: string[] = [];
  switch (signal.cause) {
    case "human_approve":
      lines.push(
        "The human reviewer approved this loop run's pending decision; the run resumes.",
      );
      break;
    case "human_request_changes":
      lines.push(
        "The human reviewer requested changes on this loop run; apply them in this turn.",
      );
      break;
    case "resume_signal":
      lines.push("This loop run was resumed after a pause; continue the task.");
      break;
    case "budget_supplemented":
      lines.push(
        "This loop run's budget was supplemented by a human; continue the task.",
      );
      break;
  }
  if (signal.feedback?.trim()) {
    lines.push("", `Human feedback: ${signal.feedback.trim()}`);
  }
  if (judgment) {
    lines.push(
      "",
      `Previous judgment (${judgmentRef ?? "not_available"}): overall=${judgment.overall}, next_action=${judgment.next_action}`,
    );
    if (judgment.unresolved_risks.length > 0) {
      lines.push("Unresolved risks:");
      for (const risk of judgment.unresolved_risks) {
        lines.push(`- ${risk}`);
      }
    }
  }
  lines.push("", "Finish with a text report.");
  return lines.join("\n");
}

function buildCollectorPrompt(inputRef: string, bundle: unknown): string {
  return [
    "Collector input bundle:",
    JSON.stringify(bundle, null, 2),
    "",
    `Read ${inputRef} as the durable input reference. Independently inspect only the evidence needed to review this turn. Stay read-only and finish with a concise evidence report.`,
  ].join("\n");
}

function mergeEvidence(
  judgment: JudgmentReport,
  extraRefs: (string | null)[],
): JudgmentReport {
  const evidence = Array.from(
    new Set([
      ...judgment.evidence,
      ...extraRefs.filter((ref): ref is string => Boolean(ref)),
    ]),
  );
  return { ...judgment, evidence };
}

const execFileAsync = promisify(execFile);

/**
 * Capture the workspace's full diff against HEAD (staged + unstaged) for
 * the verification input's evidence_refs.diff (02 §5, 04: diff.patch
 * 永久保留). Returns null when the workspace is not a git repo, git is
 * unavailable, or the turn produced no changes — never fabricates a diff.
 */
async function captureGitDiff(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "diff", "HEAD"],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

/** diff_summary 截断上限: 避免巨型 --stat 输出灌进 WS 事件。 */
const DIFF_SUMMARY_MAX_CHARS = 500;

/**
 * run-decision-required 事件的 diff_summary: 工作区相对基线的
 * git diff --stat 摘要文本。worktree 策略基线传 baseSha (含 loop 分支
 * 已提交改动), direct 策略缺省对 HEAD。与 captureGitDiff 同口径: 不含
 * 未跟踪新文件 (--stat 限制, 与 diff.patch 证据一致); 非 git 工作区 /
 * git 不可用 / 无变更时返回 null, 不伪造 — 该字段只是审批展示的辅助
 * 信息, 失败即省略, 绝不阻断控制决策。
 */
async function captureGitDiffStat(
  workspacePath: string,
  baseRef?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "diff", "--stat", baseRef ?? "HEAD"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.length > DIFF_SUMMARY_MAX_CHARS
      ? `${trimmed.slice(0, DIFF_SUMMARY_MAX_CHARS)}…`
      : trimmed;
  } catch {
    return null;
  }
}

export class LoopRunService {
  private readonly deps: LoopRunServiceDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verify: typeof verifyRun;
  /** loop_id -> active run (same-loop runs are serial) */
  private activeByLoop = new Map<string, ActiveRun>();
  private activeByRunId = new Map<string, ActiveRun>();
  /** run_id -> suspended execution context (needs_human / budget_limited / paused) */
  private suspended = new Map<string, RunExecutionContext>();
  /** run_id -> context of a run currently inside the turn loop (incl. turn 1
   *  in flight, before any state record exists) */
  private executingContexts = new Map<string, RunExecutionContext>();
  /** run_id -> the Process executing the current turn (for PATCH pause kill) */
  private executingProcesses = new Map<string, Process>();

  constructor(deps: LoopRunServiceDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.verify = deps.verifyRunFn ?? verifyRun;
    // A needs_human run keeps its active registration while it waits; the
    // control-plane calls this when a human decision terminates it (reject).
    deps.controlPlane?.onRunResolved((runId) => this.releaseRun(runId));
    // A blocked run that comes back to active continues with a new turn.
    deps.controlPlane?.onResumeRequested((signal) => {
      void this.continueRun(signal).catch((error) => {
        console.error(
          `[LoopRunService] failed to continue run ${signal.runId}:`,
          error,
        );
      });
    });
  }

  /** Release a resolved run's active registration + suspended context. */
  private releaseRun(runId: string): void {
    const active = this.activeByRunId.get(runId);
    if (active) {
      this.activeByRunId.delete(runId);
      this.activeByLoop.delete(active.loopId);
    }
    this.suspended.delete(runId);
  }

  isRunActive(loopId: string): boolean {
    return this.activeByLoop.has(loopId);
  }

  /**
   * PATCH pause 的实现（03-API契约.md: 主动暂停，不走审批管线 — 审批队列
   * 无新增排队项）. Drives active → paused through the control-plane, then
   * kills the executing process (选项 A, 见文件头): the partial turn result
   * is dropped, the session_ref survives for resume.
   *
   * Returns the updated run_state, or null when the loop has no active run
   * (the route then only sets the loop-level pause flag — 仅阻止后续触发).
   * Throws ControlPlaneError invalid_state for runs in a non-active
   * non-terminal state (needs_human runs pause via the decision endpoint).
   */
  async pauseActiveRun(loopId: string): Promise<RunStateRecord | null> {
    const controlPlane = this.deps.controlPlane;
    if (!controlPlane) {
      throw new LoopRunError(
        "loop_not_runnable",
        "Control plane not wired; pause is unavailable",
      );
    }
    const record = await controlPlane.getRunState(loopId);
    if (
      record &&
      record.state !== "active" &&
      record.state !== "complete" &&
      record.state !== "failed"
    ) {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${loopId}' run is '${record.state}', not active (03: 对非 active run pause → 409; needs_human runs are paused via POST /api/runs/:id/decision)`,
      );
    }
    const active = this.activeByLoop.get(loopId);
    if (record?.state === "active") {
      // Also covers a stale active record after a server restart: the
      // transition still lands; terminateExecuting is then a no-op.
      const updated = await controlPlane.pauseActive(loopId);
      this.terminateExecuting(record.run_id);
      return updated;
    }
    if (active) {
      // Turn 1 still in flight: no run_state record exists yet (it is first
      // written at judgment time) — or a terminal record from the previous
      // run is in its place. Pause via a seeded record (PauseSeed).
      const ctx = this.executingContexts.get(active.runId);
      const updated = await controlPlane.pauseActive(loopId, {
        runId: active.runId,
        turn: ctx?.turn ?? 1,
        goalId: ctx?.contract?.intent_id ?? "unknown",
        workspaceRef: `workspace://${loopId}/${active.runId}`,
        budget: ctx?.contract?.budget ?? null,
        createdAt: active.createdAt,
        // ctx.sessionRef 要等 turn 结束才赋值; 在飞 turn 的 session 从
        // 执行中的 Process 取, 供重启后 resume 续上同一 session。
        sessionRef:
          this.executingProcesses.get(active.runId)?.sessionId ??
          ctx?.sessionRef ??
          null,
      });
      this.terminateExecuting(active.runId);
      return updated;
    }
    return null;
  }

  /**
   * Kill the process executing a run's current turn (PATCH pause, 选项 A).
   * No-op when the run is between turns (backoff / verification): the run
   * stays paused in the state file and resume rebuilds the context.
   * Process.terminate kills the underlying CLI via abortFn and emits
   * "terminated", which settles watchProcess as a failed turn — the paused
   * check in runTurns then suspends the context before any judgment lands.
   */
  private terminateExecuting(runId: string): void {
    const proc = this.executingProcesses.get(runId);
    if (!proc) {
      return;
    }
    proc.terminate(
      "run paused via PATCH /api/loops/:id (主动暂停, 选项 A: kill executing process, partial result dropped)",
    );
  }

  /**
   * Start a run for a loop. Registers the run as active synchronously
   * (so concurrent triggers get run_active), then executes in the
   * background — ledger entries are appended per turn as the run finishes.
   *
   * intentOverrides (03 POST /api/loops/:id/runs 请求体): 对 LoopCard
   * handoff 的本轮覆盖 —— 只影响这一次的合约构造与装配, 不写回注册表。
   */
  async startRun(
    loopId: string,
    source: ContractSource,
    intentOverrides?: IntentOverrides,
  ): Promise<RunSummary> {
    const stored = this.deps.loopCardStore.getLoop(loopId);
    if (!stored) {
      throw new LoopRunError("loop_not_found", `Loop '${loopId}' not found`);
    }
    if (stored.archived) {
      throw new LoopRunError("loop_archived", `Loop '${loopId}' is archived`);
    }
    if (this.activeByLoop.has(loopId)) {
      throw new LoopRunError(
        "run_active",
        `Loop '${loopId}' already has an active run`,
      );
    }
    // Loop-level pause flag (03 PATCH pause: 无活跃 run 时仅阻止后续触发).
    // Checked after run_active so a paused run still reports run_active.
    if (stored.paused) {
      throw new LoopRunError(
        "loop_paused",
        `Loop '${loopId}' is paused (PATCH resume to re-enable triggers)`,
      );
    }

    const card = intentOverrides
      ? {
          ...stored.card,
          loop: {
            ...stored.card.loop,
            handoff: {
              ...stored.card.loop.handoff,
              ...Object.fromEntries(
                Object.entries(intentOverrides).filter(
                  ([, value]) => value !== undefined,
                ),
              ),
            },
          },
        }
      : stored.card;

    const createdAt = new Date();
    const runId = makeRunId(createdAt);
    const active: ActiveRun = {
      runId,
      loopId,
      source,
      createdAt: createdAt.toISOString(),
    };
    this.activeByLoop.set(loopId, active);
    this.activeByRunId.set(runId, active);

    // Fire-and-forget: the HTTP handler / scheduler must not block on the
    // agent finishing. The ledger is the durable record of the run.
    void this.executeRun(active, card).catch((error) => {
      console.error(`[LoopRunService] run ${runId} crashed:`, error);
      this.releaseRun(runId);
    });

    return {
      run_id: runId,
      loop_id: loopId,
      state: "active",
      source,
      created_at: active.createdAt,
    };
  }

  /** Active runs + finished runs (from ledger files), newest first. */
  async listRuns(loopId: string): Promise<RunSummary[]> {
    const summaries: RunSummary[] = [];

    const runIds = await this.deps.runLedgerStore.listRunIds();
    for (const runId of runIds) {
      const entry = await this.deps.runLedgerStore.readEntry(runId);
      if (entry && entry.loop_id === loopId) {
        summaries.push({
          run_id: entry.run_id,
          loop_id: entry.loop_id,
          // The ledger entry is append-only — the control-plane's latest
          // known state wins when available.
          state:
            this.deps.controlPlane?.currentStateOf(entry.run_id) ??
            entry.final_status,
          // 06 偏差 #28: 触发来源实记账本; 旧条目无该字段时按历史约定
          // 回退 "cron"。
          source: entry.source ?? "cron",
          created_at: entry.created_at,
        });
      }
    }

    const active = this.activeByLoop.get(loopId);
    if (active && !summaries.some((s) => s.run_id === active.runId)) {
      summaries.push({
        run_id: active.runId,
        loop_id: loopId,
        state: this.deps.controlPlane?.currentStateOf(active.runId) ?? "active",
        source: active.source,
        created_at: active.createdAt,
      });
    }

    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return summaries;
  }

  /** List artifact file names written for a run (empty when none). */
  async listRunArtifacts(runId: string): Promise<string[]> {
    return this.deps.runLedgerStore.listArtifacts(runId);
  }

  /** Read one artifact's content for a run (undefined when missing). */
  async readRunArtifact(
    runId: string,
    name: string,
  ): Promise<string | undefined> {
    return this.deps.runLedgerStore.readArtifact(runId, name);
  }

  /** Single run view: active run metadata or the finished ledger entry,
   *  plus the 03 LedgerSummary projection (incl. judgment_report 摘要). */
  async getRun(runId: string): Promise<{
    run: RunSummary;
    ledger: RunLedgerEntry | null;
    ledger_summary: LedgerSummary;
    session_ref: string | null;
  } | null> {
    const active = this.activeByRunId.get(runId);
    if (active) {
      // Active run: ledger not yet written, but the executing context may
      // already carry the session ref (set after executeTurn starts). For
      // suspended runs (paused / needs_human / budget_limited) the context
      // moved out of executingContexts — the ref survives in suspended.
      const ctx =
        this.executingContexts.get(runId) ?? this.suspended.get(runId);
      return {
        run: {
          run_id: active.runId,
          loop_id: active.loopId,
          state: this.deps.controlPlane?.currentStateOf(runId) ?? "active",
          source: active.source,
          created_at: active.createdAt,
        },
        ledger: null,
        // 首轮在飞时 run_state 尚未落账 — 预算上限从执行上下文的合约
        // 兜底, 前端不再显示 "—"。
        ledger_summary: await this.buildLedgerSummary(
          runId,
          active.loopId,
          null,
          ctx?.contract?.budget ?? null,
        ),
        session_ref: ctx?.sessionRef ?? null,
      };
    }
    const entry = await this.deps.runLedgerStore.readEntry(runId);
    if (!entry) {
      return null;
    }
    return {
      run: {
        run_id: entry.run_id,
        loop_id: entry.loop_id,
        // Append-only ledger can hold a stale state; prefer the
        // control-plane's latest known state (see listRuns).
        state:
          this.deps.controlPlane?.currentStateOf(entry.run_id) ??
          entry.final_status,
        source: entry.source ?? "cron",
        created_at: entry.created_at,
      },
      ledger: entry,
      ledger_summary: await this.buildLedgerSummary(
        runId,
        entry.loop_id,
        entry,
      ),
      session_ref: entry.runtime.session_ref,
    };
  }

  /** Build the 03 LedgerSummary projection from the ledger file + artifacts. */
  private async buildLedgerSummary(
    runId: string,
    loopId: string,
    entry: RunLedgerEntry | null,
    /** 首轮在飞时 run_state 尚未落账, 用执行上下文合约的预算上限兜底 */
    fallbackBudget?: { max_turns: number; max_retries: number } | null,
  ): Promise<LedgerSummary> {
    const refs = entry?.verification_refs;
    const notApplicable = (ref: string | undefined): ref is string =>
      ref !== undefined && ref !== "not_applicable";

    let judgmentSummary: LedgerSummary["judgment_summary"] = null;
    // 判定文件名随轮次走 (judgment-report[-turnN].json): 已完成 run 以
    // 账本 verification_refs 的引用为准, 在飞 run 回退首轮名。
    const judgmentName = notApplicable(refs?.judgment_report)
      ? (refs?.judgment_report ?? "").slice(
          (refs?.judgment_report ?? "").lastIndexOf("/") + 1,
        )
      : "judgment-report.json";
    const judgmentJson = await this.deps.runLedgerStore.readArtifact(
      runId,
      judgmentName,
    );
    if (judgmentJson) {
      try {
        const judgment = JSON.parse(judgmentJson) as JudgmentReport;
        judgmentSummary = {
          overall: judgment.overall,
          next_action: judgment.next_action,
          requires_human: judgment.requires_human,
        };
      } catch {
        console.warn(
          `[LoopRunService] judgment-report.json for run ${runId} is unparseable`,
        );
      }
    }

    const decisionEntries =
      await this.deps.runLedgerStore.readDecisionEntries(runId);
    const latestBlockingDecision = [...decisionEntries]
      .reverse()
      .find((decision) => decision.blocker_fingerprint);
    const artifactRefs = entry?.artifact_refs ?? [];
    const collectorReportRef =
      [...artifactRefs]
        .reverse()
        .find((ref) => /\/collector-report(?:-turn\d+)?\.json$/.test(ref)) ??
      null;
    const handoffRef =
      [...artifactRefs]
        .reverse()
        .find((ref) => /\/turn-handoff(?:-turn\d+)?\.json$/.test(ref)) ?? null;

    // turns_used / retries_used come from the control-plane's budget snapshot
    // (03: budget 消耗对照 max_turns / max_retries); the run_state belongs to
    // this run only when its run_id matches (same-loop runs are serial but a
    // newer run may already hold the loop's state file). max_* 同源 — 前端
    // 按 used / max 展示, 无快照时为 null (显示 "—")。
    let turnsUsed = 1;
    let retriesUsed = 0;
    let maxTurns: number | null = null;
    let maxRetries: number | null = null;
    const runState = await this.deps.controlPlane?.getRunState(loopId);
    if (runState && runState.run_id === runId && runState.budget) {
      turnsUsed = runState.budget.used_turns;
      retriesUsed = runState.budget.used_retries;
      maxTurns = runState.budget.max_turns;
      maxRetries = runState.budget.max_retries;
    } else if (fallbackBudget) {
      maxTurns = fallbackBudget.max_turns;
      maxRetries = fallbackBudget.max_retries;
    }
    const lastDecisionEntry = decisionEntries[decisionEntries.length - 1];

    return {
      turns_used: turnsUsed,
      retries_used: retriesUsed,
      max_turns: maxTurns,
      max_retries: maxRetries,
      last_decision: lastDecisionEntry
        ? {
            decision: lastDecisionEntry.decision,
            reason: lastDecisionEntry.reason,
          }
        : null,
      verifier_report_refs: notApplicable(refs?.verifier_report)
        ? [refs.verifier_report]
        : [],
      judgment_report_ref: notApplicable(refs?.judgment_report)
        ? refs.judgment_report
        : null,
      collector_report_ref: collectorReportRef,
      handoff_ref: handoffRef,
      blocker_fingerprint: latestBlockingDecision?.blocker_fingerprint ?? null,
      repeated_blocker_count:
        latestBlockingDecision?.repeated_blocker_count ?? 0,
      judgment_summary: judgmentSummary,
      decision_refs:
        decisionEntries.length > 0 ? [`ledger://decision-${runId}`] : [],
      // Failure attribution recorded on decision entries (adapter hard
      // errors, 02 §4); the learning side (phase 3) aggregates further.
      failure_tags: [
        ...new Set(decisionEntries.flatMap((d) => d.failure_tags ?? [])),
      ],
    };
  }

  /**
   * Set up the run (contract + assembly) and drive the turn loop. Setup
   * failures become a failed first turn so the crash still lands in the
   * ledger and the control-plane, like phase 1.
   */
  private async executeRun(active: ActiveRun, card: LoopCard): Promise<void> {
    const { runId, source } = active;
    const ctx: RunExecutionContext = {
      active,
      card,
      contract: null,
      contractJson: null,
      input: null,
      turn: 1,
      sessionRef: null,
      lastJudgment: null,
      lastJudgmentRef: null,
      pendingContext: null,
      policyEscalations: [],
      permissionEvents: [],
    };
    try {
      const { card: executableCard, worktree } =
        await this.resolveExecutableCard(card, runId);
      ctx.card = executableCard;
      ctx.workspaceEvidence = worktree
        ? {
            originPath: card.loop.workspace.path ?? "",
            worktreePath: worktree.path,
            branch: worktree.branch,
            baseSha: worktree.baseSha,
          }
        : null;
      ctx.contract = buildIntentContract(executableCard, { runId, source });
      ctx.contractJson = JSON.stringify(ctx.contract, null, 2);
      // 装配即落盘合约快照 (不等首轮结束): 首轮在飞时被暂停、随后进程
      // 重启的 run, resume 仍能凭此 artifact 重建执行上下文。
      await this.deps.runLedgerStore.writeArtifact(
        runId,
        "intent-contract.json",
        ctx.contractJson,
      );
      if (ctx.workspaceEvidence) {
        // worktree 隔离证据: 原目录 / worktree 目录 / 分支 / 基线 SHA,
        // 供审计"这个 run 在哪里执行、从哪个基线拉取"。
        await this.deps.runLedgerStore.writeArtifact(
          runId,
          "workspace.json",
          `${JSON.stringify(
            {
              strategy: "worktree",
              origin_path: ctx.workspaceEvidence.originPath,
              worktree_path: ctx.workspaceEvidence.worktreePath,
              branch: ctx.workspaceEvidence.branch,
              base_sha: ctx.workspaceEvidence.baseSha,
            },
            null,
            2,
          )}\n`,
        );
      }
      const runtimeContext =
        await this.resolveRuntimeAssemblyContext(executableCard);
      // 02 §3 memory packet: 失败模式账本 open 模式的摘要进装配
      // (04 单写者表: assembly 读 failure-patterns)。
      const memoryPacket = this.buildMemoryPacket(executableCard);
      if (memoryPacket) {
        runtimeContext.memoryPacket = memoryPacket.promptText;
        ctx.memoryPacketJson = memoryPacket.artifactJson;
      }
      // 02 §3 budget_remaining: 首轮即合约全量 (used_* 均为 0)。
      runtimeContext.budgetRemaining = ctx.contract.budget;
      // 阶段 3 装配消费：published / canary 提案在此进入 RuntimeInput
      // （每次新 run 重新装配 → 发布后新 run 即生效，rollback 后回到旧行为）。
      ctx.input = assembleRuntimeInput(
        executableCard,
        ctx.contract,
        this.deps.proposalStore?.listProposals() ?? [],
        runtimeContext,
      );
    } catch (error) {
      ctx.setupError =
        error instanceof Error ? error : new Error(String(error));
    }
    await this.runTurns(ctx);
  }

  /**
   * 02 §3 memory packet: 从失败模式账本构建本轮的记忆包——本 loop 相关
   *  (affected_loop_specs 命中或全局) 的 open 模式按出现次数取前 5,
   *  确定性文本注入 prompt, 完整结构落 memory-packet.json artifact
   *  (账本 input_refs.memory_packet 的真实来源, 不再恒 null)。
   * 无 open 模式 / store 未接线时返回 null。
   */
  private buildMemoryPacket(
    card: LoopCard,
  ): { promptText: string; artifactJson: string } | null {
    const store = this.deps.failurePatternStore;
    if (!store) {
      return null;
    }
    const patterns = store
      .list()
      .filter(
        (pattern) =>
          pattern.status === "open" &&
          (pattern.affected_loop_specs.length === 0 ||
            pattern.affected_loop_specs.includes(card.loop.id)),
      )
      .sort((a, b) => b.occurrence_count - a.occurrence_count)
      .slice(0, 5);
    if (patterns.length === 0) {
      return null;
    }
    return {
      promptText: patterns
        .map(
          (pattern) =>
            `- [${pattern.type}] ${pattern.summary} (seen ${pattern.occurrence_count}x, pattern ${pattern.pattern_id})`,
        )
        .join("\n"),
      artifactJson: `${JSON.stringify(
        {
          loop_id: card.loop.id,
          built_at: new Date().toISOString(),
          patterns: patterns.map((pattern) => ({
            pattern_id: pattern.pattern_id,
            type: pattern.type,
            summary: pattern.summary,
            occurrence_count: pattern.occurrence_count,
            signature: pattern.signature,
          })),
        },
        null,
        2,
      )}\n`,
    };
  }

  /**
   * 运行前改写 card 的统一挂载点：GitHub prompt loop 重写 workspace.path
   * 到 managed 目录；workspace.strategy "worktree" 创建/复用 run 级隔离
   * worktree 并把 path 改写为 worktree 目录 —— 下游 assembly / executor /
   * verifier / diff 取证全部以改写后的 path 为 cwd, 零改动获得隔离。
   * 返回 worktree 证据供 executeRun 落 workspace.json (direct 为 null)。
   */
  private async resolveExecutableCard(
    card: LoopCard,
    runId: string,
  ): Promise<{ card: LoopCard; worktree: RunWorktree | null }> {
    if (isGitHubPromptLoop(card)) {
      if (!this.deps.dataDir) {
        throw new AssemblyError(
          "GitHub prompt loop cannot start: server data directory is not configured",
        );
      }
      const expectedWorkspacePath = displayGitHubPromptWorkspacePath(
        card.loop.id,
      );
      if (card.loop.workspace.path !== expectedWorkspacePath) {
        throw new AssemblyError(
          `GitHub prompt loop cannot start: workspace.path must be '${expectedWorkspacePath}'`,
        );
      }
      const workspacePath = githubPromptWorkspacePath(
        this.deps.dataDir,
        card.loop.id,
      );
      await mkdir(workspacePath, { recursive: true });
      return {
        card: {
          ...card,
          loop: {
            ...card.loop,
            workspace: {
              ...card.loop.workspace,
              strategy: "direct",
              path: workspacePath,
            },
          },
        },
        worktree: null,
      };
    }
    if (card.loop.workspace.strategy !== "worktree") {
      return { card, worktree: null };
    }
    const repoPath = card.loop.workspace.path;
    if (!repoPath) {
      throw new AssemblyError(
        `Loop '${card.loop.id}' workspace.strategy is worktree but workspace.path is missing`,
      );
    }
    if (!this.deps.dataDir) {
      throw new AssemblyError(
        `Loop '${card.loop.id}' workspace.strategy is worktree but server data directory is not configured`,
      );
    }
    const worktree = await ensureRunWorktree({
      repoPath,
      loopId: card.loop.id,
      runId,
      dataDir: this.deps.dataDir,
    });
    return {
      card: {
        ...card,
        loop: {
          ...card.loop,
          workspace: {
            ...card.loop.workspace,
            path: worktree.path,
          },
        },
      },
      worktree,
    };
  }

  private async resolveRuntimeAssemblyContext(
    card: LoopCard,
  ): Promise<RuntimeAssemblyContext> {
    if (!isGitHubPromptLoop(card)) {
      return {};
    }
    if (!this.deps.githubCredentialStore) {
      throw new AssemblyError(
        "GitHub prompt loop cannot start: GitHub credential store is not configured",
      );
    }
    if (!this.deps.githubToolProvisioner) {
      throw new AssemblyError(
        "GitHub prompt loop cannot start: GitHub CLI provisioner is not configured",
      );
    }

    const token = await this.deps.githubCredentialStore.getToken();
    if (!token) {
      throw new AssemblyError(
        "GitHub prompt loop cannot start: save a GitHub token before running this loop",
      );
    }
    const tool = await this.deps.githubToolProvisioner.ensureGh();
    if (!tool.path) {
      throw new AssemblyError(
        "GitHub prompt loop cannot start: managed GitHub CLI path is unavailable",
      );
    }
    return { github: { token, ghPath: tool.path } };
  }

  /**
   * The turn loop: execute → verify → control-plane judgment, repeat while
   * the decision is retry. Blocking states (needs_human / budget_limited)
   * suspend the context and keep the active registration; terminal states
   * release it (finally).
   */
  private async runTurns(ctx: RunExecutionContext): Promise<void> {
    const { runId, loopId, createdAt } = ctx.active;
    const store = this.deps.runLedgerStore;
    let blocked = false;
    this.executingContexts.set(runId, ctx);

    try {
      for (;;) {
        const turnStartedAt = Date.now();

        // learning_refs.human_feedback 在轮首快照 (见 buildHumanFeedbackRefs):
        // 人工反馈只会在阻塞等待期 (轮与轮之间) 进决策账本, 轮首取到的集合
        // 即本轮 entry 落账时的最终集合; 轮首取数也避免在"状态转移已可见、
        // entry 未落账"的收尾窗口里再串入 IO 延迟。
        const humanFeedbackRefs = await this.buildHumanFeedbackRefs(runId);

        // --- execution ---
        let outcome: ExecutionOutcome;
        if (ctx.setupError) {
          const error = ctx.setupError;
          ctx.setupError = undefined;
          outcome = {
            ok: false,
            finalText: "",
            sessionRef: "none",
            error:
              error instanceof AssemblyError
                ? error.message
                : `run setup/execution failed: ${error.message}`,
            usage: null,
            adapterError: error instanceof AdapterError ? error : undefined,
          };
        } else {
          outcome = await this.executeTurn(ctx);
        }
        if (outcome.sessionRef !== "none") {
          ctx.sessionRef = outcome.sessionRef;
        }
        const timeMinutes = (Date.now() - turnStartedAt) / 60_000;

        // --- PATCH pause interception (主动暂停, 选项 A, 见文件头) ---
        // The control-plane already moved the run to paused and the
        // executing process was killed; the partial turn produced no
        // auditable result, so no artifacts / verification / judgment /
        // ledger entry are written for it. The session_ref captured above
        // stays valid (session jsonl on disk) so resume continues on the
        // same session. Suspend exactly like the other blocking states
        // (active registration kept → same-loop runs stay serial).
        if (this.deps.controlPlane?.currentStateOf(runId) === "paused") {
          blocked = true;
          // The partial turn writes no ledger entry / judgment, but keep its
          // captured event stream as an artifact so the Stream Output panel
          // can show what the executor did before it was killed. A resumed
          // turn with the same number overwrites it.
          if (outcome.runtimeEvents && outcome.runtimeEvents.length > 0) {
            const eventsName =
              ctx.turn === 1
                ? "runtime-events.jsonl"
                : `runtime-events-turn${ctx.turn}.jsonl`;
            await store.writeArtifact(
              runId,
              eventsName,
              `${outcome.runtimeEvents
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
            );
          }
          this.suspended.set(runId, ctx);
          return;
        }

        // --- artifacts ---
        if (ctx.turn === 1 && ctx.contractJson) {
          await store.writeArtifact(
            runId,
            "intent-contract.json",
            ctx.contractJson,
          );
        }
        // 02 §3 memory packet: 本轮的记忆包落 artifact, 账本
        // input_refs.memory_packet 引用它。
        if (ctx.turn === 1 && ctx.memoryPacketJson) {
          await store.writeArtifact(
            runId,
            "memory-packet.json",
            ctx.memoryPacketJson,
          );
        }
        // 02 §3 policy_projection 段：策略投影的 run 在 turn 1 落投影快照，
        // 与 intent-contract 同级可审计。
        if (ctx.turn === 1 && ctx.input?.policyProjection) {
          await store.writeArtifact(
            runId,
            "policy-projection.json",
            JSON.stringify(ctx.input.policyProjection, null, 2),
          );
        }
        // 02 §3 RuntimeInputBundle: turn 1 落完整 bundle 快照
        // (execution_contract / native_invocation / context_injection /
        // observability / budget_remaining) 与主 prompt 文本。
        if (ctx.turn === 1 && ctx.input) {
          await store.writeArtifact(runId, "prompt.md", ctx.input.prompt);
          await store.writeArtifact(
            runId,
            "runtime-input-bundle.json",
            `${JSON.stringify(
              {
                goal_id: ctx.contract?.intent_id ?? "unknown",
                run_id: runId,
                turn: ctx.turn,
                execution_contract: ctx.input.executionContract,
                native_invocation: ctx.input.nativeInvocation,
                context_injection: {
                  prompt_ref: `artifact://${runId}/prompt.md`,
                  instruction_overlay_ref: null,
                  memory_packet_ref: ctx.memoryPacketJson
                    ? `artifact://${runId}/memory-packet.json`
                    : null,
                  mcp_config_ref: null,
                },
                policy_projection:
                  ctx.input.policyProjection ?? "not_applicable",
                observability: ctx.input.observability,
                budget_remaining: ctx.input.budgetRemaining ?? null,
                permission_bridge_ref: null,
              },
              null,
              2,
            )}\n`,
          );
        }
        // Turn 1 keeps the phase-0/1 name for compatibility; later turns
        // get their own stdout file so per-turn evidence survives.
        const stdoutName =
          ctx.turn === 1 ? "stdout.log" : `stdout-turn${ctx.turn}.log`;
        const stdout = outcome.finalText || outcome.error || "(no output)";
        await store.writeArtifact(runId, stdoutName, stdout);

        const artifactRefs = [
          ...(ctx.turn === 1 && ctx.contractJson
            ? [`artifact://${runId}/intent-contract.json`]
            : []),
          ...(ctx.turn === 1 && ctx.workspaceEvidence
            ? [`artifact://${runId}/workspace.json`]
            : []),
          `artifact://${runId}/${stdoutName}`,
        ];

        // 02 §5 runtime_event_refs / structured_output：轮内归一消息流落
        // 盘为 jsonl（一行一个 {at, message}），作为 maker→checker 的
        // 运行时证据引用进验证输入。
        let runtimeEventsRef: string | null = null;
        if (outcome.runtimeEvents && outcome.runtimeEvents.length > 0) {
          const eventsName =
            ctx.turn === 1
              ? "runtime-events.jsonl"
              : `runtime-events-turn${ctx.turn}.jsonl`;
          await store.writeArtifact(
            runId,
            eventsName,
            `${outcome.runtimeEvents
              .map((event) => JSON.stringify(event))
              .join("\n")}\n`,
          );
          runtimeEventsRef = `artifact://${runId}/${eventsName}`;
          artifactRefs.push(runtimeEventsRef);
        }

        // 02 §5 executor_summary：提取执行者自述（装配 prompt 契约的标
        // 记块）落 markdown artifact。executor 没产出标记块时为 null—
        // 自述缺失本身也是信号，不伪造。
        let executorSummaryRef: string | null = null;
        const executorSummary = extractExecutorSummary(outcome.finalText);
        if (executorSummary) {
          const summaryName =
            ctx.turn === 1
              ? "executor-summary.md"
              : `executor-summary-turn${ctx.turn}.md`;
          await store.writeArtifact(runId, summaryName, `${executorSummary}\n`);
          executorSummaryRef = `artifact://${runId}/${summaryName}`;
          artifactRefs.push(executorSummaryRef);
        }

        // 02 §5 evidence_refs.diff + 04 diff.patch 永久保留：捕获工作区
        // 相对 HEAD 的完整差异（含 staged）；非 git 工作区或无变更时为
        // null，不伪造证据。
        let diffRef: string | null = null;
        const workspacePath = ctx.card.loop.workspace.path;
        if (workspacePath) {
          const diff = await captureGitDiff(workspacePath);
          if (diff) {
            const diffName =
              ctx.turn === 1 ? "diff.patch" : `diff-turn${ctx.turn}.patch`;
            await store.writeArtifact(runId, diffName, diff);
            diffRef = `artifact://${runId}/${diffName}`;
            artifactRefs.push(diffRef);
          }
        }

        // 02 §5 permission_event_refs：策略钩子本轮的裁决事件（bypass 自
        // 批准 / 硬闸门拦截 / 拒绝）落盘，高风险任务的验证输入必须包含。
        const permissionEventRefs: string[] = [];
        if (ctx.permissionEvents.length > 0) {
          const permissionName =
            ctx.turn === 1
              ? "permission-events.json"
              : `permission-events-turn${ctx.turn}.json`;
          await store.writeArtifact(
            runId,
            permissionName,
            `${JSON.stringify(ctx.permissionEvents, null, 2)}\n`,
          );
          permissionEventRefs.push(`artifact://${runId}/${permissionName}`);
        }

        const collector = await this.runCollector(
          ctx,
          outcome,
          `artifact://${runId}/${stdoutName}`,
        );
        if (collector.inputRef) {
          artifactRefs.push(collector.inputRef);
        }
        if (collector.outputRef) {
          artifactRefs.push(collector.outputRef);
        }
        if (collector.reportRef) {
          artifactRefs.push(collector.reportRef);
        }

        // --- verification ---
        // Verification artifacts are named per-turn (turn 1 keeps the
        // canonical names): a retry turn never overwrites the previous
        // turn's evidence, so every ledger entry's refs stay
        // dereferenceable (02 §8.1: 每次 retry 独立 entry + 保存引用).
        let verificationRefs: VerificationRefs = {
          verification_input: "not_applicable",
          verifier_runtime: "not_applicable",
          verifier_report: "not_applicable",
          judgment_report: "not_applicable",
        };
        let verificationRan = false;
        let judgment: JudgmentReport | null = null;
        let judgmentRef: string | null = null;

        const requiredPhases = ctx.card.loop.verification.required;
        if (requiredPhases.length > 0 && ctx.contract && workspacePath) {
          // 02 §5 policy_intent_ref：策略投影 run 引用 turn 1 的投影快照。
          const policyIntentRef = ctx.input?.policyProjection
            ? `artifact://${runId}/policy-projection.json`
            : null;
          // 02 §5 known_failure_patterns：失败模式账本的 open 模式供
          // verifier 对照（只读，不写——04 单写者表）。
          const knownFailurePatterns = (
            this.deps.failurePatternStore?.list() ?? []
          )
            .filter((pattern) => pattern.status === "open")
            .map((pattern) => pattern.pattern_id);
          try {
            // 修复计划 #12: card 的 verifier_chain 含 review 时, collector
            // session 的报告转成 review 段 verifier_report 参与聚合
            // (requires_human 透传不再被丢弃); 未声明 review 的卡保持
            // 证据级 merge (collector 只作证据采集, 不参与判定)。
            const reviewInChain = requiredPhases.includes("review");
            const reviewReport =
              reviewInChain && collector.report
                ? {
                    verifier_phase: "review" as const,
                    status: collector.report.status,
                    evidence_refs: collector.report.evidence_refs,
                    unresolved_risks: collector.report.unresolved_risks,
                    recommendation: collector.report.recommendation,
                    confidence: collector.report.confidence,
                    requires_human: collector.report.requires_human,
                  }
                : undefined;
            const verification = await this.verify(
              {
                card: ctx.card,
                contract: ctx.contract,
                runId,
                turn: ctx.turn,
                workspacePath,
                exitStatus: outcome.ok ? 0 : 1,
                stdoutRef: `artifact://${runId}/${stdoutName}`,
                diffRef,
                runtimeEventsRef,
                executorSummaryRef,
                permissionEventRefs,
                policyIntentRef,
                knownFailurePatterns,
                reviewReport,
              },
              { store },
            );
            verificationRefs = verification.refs;
            verificationRan = true;
            judgment =
              !reviewInChain && collector.reportRef
                ? mergeEvidence(verification.judgment, [collector.reportRef])
                : verification.judgment;
            judgmentRef = verification.refs.judgment_report;
            if (!reviewInChain && collector.reportRef) {
              await store.writeArtifact(
                runId,
                verificationArtifactName("judgment-report.json", ctx.turn),
                `${JSON.stringify(judgment, null, 2)}\n`,
              );
            }
          } catch (error) {
            // 验证层自身崩溃不得静默判过（verifier theater）：合成一份
            // inconclusive + requires_human 的 judgment 升级人工，并把
            // 错误落盘为证据——card 要求验证而验证没跑成时，由人决定
            // 这个 run 是否成立。
            console.error(
              `[LoopRunService] verification failed for run ${runId}:`,
              error,
            );
            const errorName = verificationArtifactName(
              "verification-error.json",
              ctx.turn,
            );
            const message =
              error instanceof Error ? error.message : String(error);
            await store
              .writeArtifact(
                runId,
                errorName,
                `${JSON.stringify(
                  {
                    run_id: runId,
                    turn: ctx.turn,
                    error: message,
                    at: new Date().toISOString(),
                  },
                  null,
                  2,
                )}\n`,
              )
              .catch(() => {});
            const errorRef = `artifact://${runId}/${errorName}`;
            artifactRefs.push(errorRef);
            verificationRan = true;
            judgment = {
              overall: "inconclusive",
              next_action: "escalate",
              retryable: false,
              requires_human: true,
              evidence: [errorRef],
              unresolved_risks: [
                `verification layer crashed and produced no judgment: ${message}`,
              ],
            };
            judgmentRef = null;
          }
        }
        // --- observability.required_artifacts 校验 (judgment 落账前) ---
        // card 声明必备产物时逐项检查本 run 的产物目录, 缺失项以
        // `missing_required_artifact:<name>` 标注进 judgment evidence。
        // 口径钉死: 只标注, 不改 verdict 语义 (不降级、不升级
        // needs_human) —— 无告警通道, 先做到可查。
        // 验证层崩溃分支 (judgmentRef=null) 已有 verification-error 证据,
        // 跳过本检查, 不在崩溃 judgment 上叠噪音; card 未声明时零开销。
        const requiredArtifacts =
          ctx.card.loop.observability?.required_artifacts;
        if (
          verificationRan &&
          judgment &&
          judgmentRef &&
          requiredArtifacts?.length
        ) {
          const artifactAnnotations = await checkRequiredArtifacts({
            artifactsDir: store.artifactsDirFor(runId),
            required: requiredArtifacts,
            turn: ctx.turn,
          });
          if (artifactAnnotations.length > 0) {
            judgment = {
              ...judgment,
              evidence: [...judgment.evidence, ...artifactAnnotations],
            };
            // 判定报告同步改写, 与最终落账 judgment 口径一致 (同下方
            // merge-gate 的改写约定, 不留报告与决策打架的假象)。
            await store.writeArtifact(
              runId,
              verificationArtifactName("judgment-report.json", ctx.turn),
              `${JSON.stringify(judgment, null, 2)}\n`,
            );
          }
        }
        // --- merge gate (worktree 策略 + modify): 验证通过且 worktree
        // 有改动时不直接 complete — 改写 judgment 升级 needs_human
        // (requires_human 透传, 02 §6 人工优先), 等人工批准后才把
        // loop 分支合并回原仓库。合并证据落 merge-gate.json (批准后的
        // 实际合并从该文件取参, 重启可恢复)。
        if (
          outcome.ok &&
          judgment?.next_action === "complete" &&
          judgment.overall === "passed" &&
          ctx.workspaceEvidence &&
          ctx.card.loop.policy &&
          (await worktreeHasChanges(
            ctx.workspaceEvidence.worktreePath,
            ctx.workspaceEvidence.baseSha,
          ))
        ) {
          judgment = {
            ...judgment,
            next_action: "needs_human",
            requires_human: true,
            unresolved_risks: [
              ...judgment.unresolved_risks,
              `worktree changes pending merge approval: branch ${ctx.workspaceEvidence.branch} → ${ctx.workspaceEvidence.originPath}`,
            ],
          };
          await store.writeArtifact(
            runId,
            "merge-gate.json",
            `${JSON.stringify(
              {
                turn: ctx.turn,
                origin_path: ctx.workspaceEvidence.originPath,
                worktree_path: ctx.workspaceEvidence.worktreePath,
                branch: ctx.workspaceEvidence.branch,
                base_sha: ctx.workspaceEvidence.baseSha,
                judgment_ref: judgmentRef,
                created_at: new Date().toISOString(),
              },
              null,
              2,
            )}\n`,
          );
          artifactRefs.push(`artifact://${runId}/merge-gate.json`);
          // 判定报告同步改写, 与最终控制决策口径一致 (报告说"判过但
          // 待合并确认", 不留下 complete 与 needs_human 打架的假象)。
          await store.writeArtifact(
            runId,
            verificationArtifactName("judgment-report.json", ctx.turn),
            `${JSON.stringify(judgment, null, 2)}\n`,
          );
        }
        ctx.lastJudgment = judgment;
        ctx.lastJudgmentRef = judgmentRef;

        // --- control decision ---
        // Adapter hard errors (02 §4: timeout / spawn_failed / ...) are
        // terminal by construction and never trigger needs_human or retry:
        // there is no work product to judge and nothing a resumed session
        // could fix — the failure attribution (失败模式账本 vocabulary) is
        // attached to the control decision entry so the ledger carries it.
        let finalStatus: RunState = outcome.ok ? "complete" : "failed";
        let retriesUsed = 0;
        let blockerFingerprint: string | undefined;
        let repeatedBlockerCount: number | undefined;
        if (this.deps.controlPlane && ctx.contract) {
          // 升级 needs_human 时随 run-decision-required 事件带给前端的
          // 改动摘要 (git diff --stat; worktree 策略对 baseSha 取全量,
          // direct 对 HEAD)。每轮都算一次, 由 control-plane 决定仅在
          // needs_human 事件里透传; 捕获失败为 null 即省略该字段。
          const diffSummary = workspacePath
            ? ((await captureGitDiffStat(
                workspacePath,
                ctx.workspaceEvidence?.baseSha,
              )) ?? undefined)
            : undefined;
          const applied = await this.deps.controlPlane.applyJudgment({
            loopId,
            runId,
            turn: ctx.turn,
            goalId: ctx.contract.intent_id,
            workspaceRef: `workspace://${loopId}/${runId}`,
            executionOk: outcome.ok,
            verificationRan,
            judgment,
            judgmentRef,
            createdAt,
            budget: ctx.contract.budget,
            diffSummary,
            // 02 §2 stop_rules: repetition.max_same_failure 由
            // control-plane 按同一阻断指纹计数消费
            stopRules: ctx.contract.stop_rules,
            // 06 #32: run_state.session_ref 供前端订阅对应 session
            sessionRef: outcome.sessionRef,
            // 硬闸门 / 高风险策略拦截（本 turn 内 policy hook 收集）：
            // 升级 needs_human，bypass 下仍被拦（05 阶段 2 验收 4）。
            policyEscalation: drainPolicyEscalation(ctx),
            usage: {
              tokens: outcome.usage?.tokens ?? null,
              timeMinutes,
            },
            adapterFailure: outcome.adapterError
              ? {
                  code: outcome.adapterError.code,
                  failureTag: adapterErrorCodeToFailureTag(
                    outcome.adapterError.code,
                  ),
                  message: outcome.adapterError.message,
                }
              : undefined,
          });
          finalStatus = applied.state;
          retriesUsed = applied.budget.used_retries;
          blockerFingerprint = applied.entry.blocker_fingerprint;
          repeatedBlockerCount = applied.entry.repeated_blocker_count;
        } else if (this.deps.controlPlane && !ctx.contract) {
          // Setup failed before a contract existed: record a terminal
          // control decision with a no-op budget (executionOk=false → failed).
          const applied = await this.deps.controlPlane.applyJudgment({
            loopId,
            runId,
            turn: ctx.turn,
            goalId: "unknown",
            workspaceRef: `workspace://${loopId}/${runId}`,
            executionOk: outcome.ok,
            verificationRan,
            judgment,
            judgmentRef,
            createdAt,
            budget: {
              max_tokens: 0,
              max_time_minutes: 0,
              max_turns: 1,
              max_retries: 0,
            },
            sessionRef: outcome.sessionRef,
            usage: { tokens: null, timeMinutes },
            adapterFailure: outcome.adapterError
              ? {
                  code: outcome.adapterError.code,
                  failureTag: adapterErrorCodeToFailureTag(
                    outcome.adapterError.code,
                  ),
                  message: outcome.adapterError.message,
                }
              : undefined,
          });
          finalStatus = applied.state;
          blockerFingerprint = applied.entry.blocker_fingerprint;
          repeatedBlockerCount = applied.entry.repeated_blocker_count;
        } else if (verificationRan && judgment) {
          finalStatus =
            outcome.ok && judgment.overall === "passed" ? "complete" : "failed";
        }

        const handoffRef = await this.writeTurnHandoff(ctx, {
          collectorReportRef: collector.reportRef,
          judgmentRef,
          evidenceRefs: judgment?.evidence ?? artifactRefs,
          blockerFingerprint,
          repeatedBlockerCount,
        });
        artifactRefs.push(handoffRef);

        // --- per-turn ledger entry (02 §8.1: 每次 retry 产生独立 entry;
        // the session_ref is identical across turns of one run) ---
        // runtime 块从 card 的 provider 真实投影（describeAdapter）：02
        // §8.1 的 mode 是 runtime 原生模式（claude=print / codex=exec），
        // permissionMode 记入能力快照；interrupt 能力按 06 偏差 #17 如实
        // 记录（Codex=kill-only，pause/cancel 只能杀进程——loop 的 pause
        // 语义在两种 runtime 下统一为杀进程，选项 A，见文件头）。
        const adapterInfo = describeAdapter(loopRuntime(ctx.card)?.provider);
        const permissionMode = ctx.input?.permissionMode ?? "plan";
        // 本次装配实际生效的提案 id 进能力快照 (appliedProposals 的审计
        // 消费点: 哪个 run 吃了哪份提案, 账本可查)。
        const appliedNote = ctx.input?.appliedProposals?.length
          ? `;proposals=${ctx.input.appliedProposals.join("|")}`
          : "";
        // adapter_policy 的实际消费情况记入能力快照（含未消费键 —— 配置
        // 以为生效实际没有的键必须可审计）。
        const consumedPolicy = resolveAdapterPolicy(ctx.input?.adapterPolicy);
        const adapterPolicyNote =
          consumedPolicy.model !== undefined ||
          consumedPolicy.timeoutMs !== undefined ||
          consumedPolicy.ignoredKeys.length > 0
            ? `;adapterPolicy[${[
                consumedPolicy.model ? `model=${consumedPolicy.model}` : null,
                consumedPolicy.timeoutMs
                  ? `timeout_seconds=${consumedPolicy.timeoutMs / 1000}`
                  : null,
                consumedPolicy.ignoredKeys.length > 0
                  ? `ignored=${consumedPolicy.ignoredKeys.join("|")}`
                  : null,
              ]
                .filter(Boolean)
                .join(",")}]`
            : "";
        const capabilitySnapshot = ctx.input?.policyProfile
          ? `realSdk(${adapterInfo.bridge});permissionMode=${permissionMode};policy=${ctx.input.policyProfile.policy_profile};selfApproveAudit;interrupt=${adapterInfo.interrupt}${adapterPolicyNote}${appliedNote}`
          : `realSdk(${adapterInfo.bridge});permissionMode=${permissionMode};autoDenyApprovals;interrupt=${adapterInfo.interrupt}${adapterPolicyNote}${appliedNote}`;
        const entry: RunLedgerEntry = {
          loop_id: loopId,
          run_id: runId,
          source: ctx.active.source,
          runtime: {
            adapter: adapterInfo.adapter,
            session_ref: outcome.sessionRef,
            mode: adapterInfo.mode,
            adapter_capability_snapshot: capabilitySnapshot,
          },
          input_refs: {
            intent: `intent://${loopId}`,
            // 02 §3 memory packet: 有 open 失败模式时引用本轮的
            // memory-packet.json, 无则如实 null
            memory_packet: ctx.memoryPacketJson
              ? `artifact://${runId}/memory-packet.json`
              : null,
            workspace: `workspace://${loopId}/${runId}`,
          },
          verification_refs: verificationRefs,
          learning_refs: {
            control_decision: `ledger://${runId}`,
            // 02 §8.1: 人工反馈引用，轮首快照（无人工反馈则 [] 不落
            // 文件，见 buildHumanFeedbackRefs）。
            human_feedback: humanFeedbackRefs,
            // 挂账口径：当前无 CI/PR/issue 外部反馈通道，恒 []
            // （待 spec 06 登记后再回填）。
            external_feedback: [],
          },
          artifact_refs: artifactRefs,
          final_status: finalStatus,
          created_at: createdAt,
        };
        await store.appendEntry(runId, entry);
        // No control-plane wired (phase-0 style runs): the adapter failure
        // attribution still lands in the decision ledger, so the timeout /
        // hard-error path is auditable there too (05 阶段 1 验收 4).
        if (!this.deps.controlPlane && outcome.adapterError) {
          await store.appendDecisionEntry(runId, {
            decision_id: `decision-${runId}-adapter-failure`,
            loop_id: loopId,
            run_id: runId,
            decision: "failed",
            reason: `adapter hard error (${outcome.adapterError.code}): ${outcome.adapterError.message}`,
            evidence_refs: [],
            policy_refs: [],
            next_action: "none",
            failure_tags: [
              adapterErrorCodeToFailureTag(outcome.adapterError.code),
            ],
            created_at: new Date().toISOString(),
          });
        }
        console.log(
          `[LoopRunService] run ${runId} (loop '${loopId}') turn ${ctx.turn}: ${finalStatus}${outcome.error ? ` — ${outcome.error}` : ""}`,
        );

        // --- state machine drive ---
        if (finalStatus === "retry") {
          // 退避（1min × 2^(n-1)，封顶 5min）后在同一 session 上开新一轮。
          const backoff = retryBackoffMs(retriesUsed);
          console.log(
            `[LoopRunService] run ${runId} retry #${retriesUsed} in ${backoff}ms`,
          );
          await this.sleep(backoff);
          ctx.turn += 1;
          ctx.pendingContext = buildRetryContext(
            ctx.turn,
            judgment,
            judgmentRef,
          );
          const begin = await this.deps.controlPlane?.beginTurn(
            runId,
            ctx.turn,
          );
          if (begin && !begin.ok) {
            // 每轮开始前的预算检查先触者停 → budget_limited（阻塞等补充）。
            blocked = true;
            this.suspended.set(runId, ctx);
            return;
          }
          continue;
        }

        // Re-widen: the control-plane's idempotent replay can return
        // "paused" (a PATCH pause that landed between the interception
        // check above and applyJudgment), which the ControlDecisionKind
        // assignment narrowed away at the type level.
        const status = finalStatus as RunState;
        if (
          status === "needs_human" ||
          status === "budget_limited" ||
          status === "paused"
        ) {
          // Blocking wait states: keep the active registration (same-loop
          // runs stay serial) and suspend the context; a ResumeSignal from
          // the control-plane continues the run (continueRun).
          blocked = true;
          this.suspended.set(runId, ctx);
          return;
        }

        // complete / failed: terminal.
        return;
      }
    } catch (error) {
      console.error(`[LoopRunService] run ${runId} failed:`, error);
    } finally {
      this.executingContexts.delete(runId);
      if (!blocked) {
        this.activeByLoop.delete(loopId);
        this.activeByRunId.delete(runId);
        this.suspended.delete(runId);
      }
    }
  }

  /**
   * Continue a suspended run after a ResumeSignal (human approve /
   * request_changes, resume signal, budget supplemented): advance the turn,
   * inject the human response (and the previous judgment) as context, run
   * the pre-turn budget check, and re-enter the turn loop on the same
   * session. After a server restart the context is rebuilt from the stores.
   */
  private async continueRun(signal: ResumeSignal): Promise<void> {
    const controlPlane = this.deps.controlPlane;
    if (!controlPlane) {
      return;
    }
    let ctx = this.suspended.get(signal.runId) ?? null;
    if (!ctx) {
      ctx = await this.rebuildContext(signal);
      if (!ctx) {
        console.error(
          `[LoopRunService] cannot continue run ${signal.runId}: no suspended context and rebuild failed`,
        );
        return;
      }
      // Re-register: a rebuilt run was not tracked in this process.
      if (!this.activeByRunId.has(signal.runId)) {
        this.activeByLoop.set(signal.loopId, ctx.active);
        this.activeByRunId.set(signal.runId, ctx.active);
      }
    }

    // --- 合并闸门批准 (worktree merge gate): human_approve 且存在当前
    // 轮的 merge-gate.json 时, 不开新一轮 — 执行 git merge 并经
    // 控制面终局 (complete / 冲突 failed)。gate.turn 与 run_state 对齐
    // 才走合并, 防止上一轮遗留的 gate 文件在无关审批上误触发。
    if (signal.cause === "human_approve") {
      const gateJson = await this.deps.runLedgerStore.readArtifact(
        signal.runId,
        "merge-gate.json",
      );
      if (gateJson) {
        const gate = JSON.parse(gateJson) as {
          turn: number;
          origin_path: string;
          worktree_path: string;
          branch: string;
        };
        const runState = await controlPlane.getRunState(signal.loopId);
        if (runState?.turn === gate.turn) {
          let mergeResult: {
            ok: boolean;
            merge_commit_sha?: string;
            error?: string;
          };
          try {
            const merged = await mergeRunWorktree({
              worktreePath: gate.worktree_path,
              originPath: gate.origin_path,
              branch: gate.branch,
              runId: signal.runId,
            });
            mergeResult = { ok: true, merge_commit_sha: merged.mergeCommitSha };
          } catch (error) {
            mergeResult = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          await this.deps.runLedgerStore.writeArtifact(
            signal.runId,
            "merge-result.json",
            `${JSON.stringify(
              {
                run_id: signal.runId,
                turn: gate.turn,
                ...mergeResult,
                at: new Date().toISOString(),
              },
              null,
              2,
            )}\n`,
          );
          await controlPlane.settleMerge({
            loopId: signal.loopId,
            runId: signal.runId,
            turn: gate.turn,
            ok: mergeResult.ok,
            mergeCommitSha: mergeResult.merge_commit_sha ?? null,
            error: mergeResult.error,
          });
          // 合并终局: 释放注册 (不开新一轮, 无 turn 循环)
          this.releaseRun(signal.runId);
          return;
        }
      }
    }

    ctx.turn += 1;
    ctx.pendingContext = buildHumanResumeContext(
      signal,
      ctx.lastJudgment,
      ctx.lastJudgmentRef,
    );
    const begin = await controlPlane.beginTurn(signal.runId, ctx.turn);
    if (!begin.ok) {
      // Budget exhausted again before the turn could start (e.g. time
      // budget): the run went back to budget_limited — keep it suspended.
      this.suspended.set(signal.runId, ctx);
      return;
    }
    this.suspended.delete(signal.runId);
    await this.runTurns(ctx);
  }

  /**
   * Rebuild a suspended run's execution context from the stores (server
   * restart path): card from the card store, contract from its artifact
   * snapshot, session ref from the ledger, turn / judgment ref from
   * run_state. Best effort — returns null when any piece is missing.
   */
  private async rebuildContext(
    signal: ResumeSignal,
  ): Promise<RunExecutionContext | null> {
    const stored = this.deps.loopCardStore.getLoop(signal.loopId);
    if (!stored || stored.archived) {
      return null;
    }
    const store = this.deps.runLedgerStore;
    const entry = await store.readEntry(signal.runId);
    let contractJson = await store.readArtifact(
      signal.runId,
      "intent-contract.json",
    );
    const runState = await this.deps.controlPlane?.getRunState(signal.loopId);
    if (!runState) {
      return null;
    }
    try {
      const { card: executableCard } = await this.resolveExecutableCard(
        stored.card,
        signal.runId,
      );
      if (!contractJson) {
        // 首轮在飞时被暂停 (或早于"装配即落盘"版本的 run): turn 1 未产生
        // 合约快照与账本, 按卡片重新装配合约、同 run_id 重新开始。更晚
        // 轮次缺快照则无法忠实重建, 放弃。
        if (runState.turn !== 1) {
          return null;
        }
        contractJson = JSON.stringify(
          buildIntentContract(executableCard, {
            runId: signal.runId,
            source:
              stored.card.loop.trigger.type === "schedule" ? "cron" : "manual",
          }),
          null,
          2,
        );
        // 快照落盘: 下次重启直接按正常路径重建, 不再依赖本兜底。
        await store.writeArtifact(
          signal.runId,
          "intent-contract.json",
          contractJson,
        );
      }
      if (!entry && runState.turn !== 1) {
        // 缺账本只在首轮暂停时合法 (turn 1 未完成本就无 entry); 更晚
        // 轮次缺账本则来源/会话无从确定, 放弃。
        return null;
      }
      const contract = IntentContractSchema.parse(JSON.parse(contractJson));
      const runtimeContext =
        await this.resolveRuntimeAssemblyContext(executableCard);
      const memoryPacket = this.buildMemoryPacket(executableCard);
      if (memoryPacket) {
        runtimeContext.memoryPacket = memoryPacket.promptText;
      }
      // 后续轮的账本 input_refs.memory_packet 仍指向 turn 1 落盘的那份
      // 记忆包 (内容以 turn 1 为准, 不按当前账本重建)。
      const memoryPacketJson =
        (await store
          .readArtifact(signal.runId, "memory-packet.json")
          .catch(() => undefined)) ?? null;
      // 02 §3 budget_remaining: 从 run_state 预算快照算剩余量。
      if (runState.budget) {
        const b = runState.budget;
        runtimeContext.budgetRemaining = {
          max_tokens:
            b.max_tokens > 0 ? Math.max(0, b.max_tokens - b.used_tokens) : 0,
          max_time_minutes: Math.max(
            0,
            b.max_time_minutes - b.used_time_minutes,
          ),
          max_turns: Math.max(0, b.max_turns - b.used_turns),
          max_retries: Math.max(0, b.max_retries - b.used_retries),
        };
      }
      const input = assembleRuntimeInput(
        executableCard,
        contract,
        this.deps.proposalStore?.listProposals() ?? [],
        runtimeContext,
      );
      let lastJudgment: JudgmentReport | null = null;
      const judgmentJson = await store.readArtifact(
        signal.runId,
        "judgment-report.json",
      );
      if (judgmentJson) {
        lastJudgment = JSON.parse(judgmentJson) as JudgmentReport;
      }
      return {
        active: {
          runId: signal.runId,
          loopId: signal.loopId,
          // 06 偏差 #28: 触发来源实记账本; 旧条目无该字段时按历史约定
          // 回退 "cron"。首轮暂停无账本时按合约快照还原 (ui→manual)。
          source:
            entry?.source ?? (contract.source === "cron" ? "cron" : "manual"),
          createdAt: entry?.created_at ?? runState.created_at,
        },
        card: executableCard,
        contract,
        contractJson,
        input,
        turn: runState.turn,
        sessionRef: entry
          ? entry.runtime.session_ref === "none"
            ? null
            : entry.runtime.session_ref
          : // 首轮暂停无账本: 暂停时落进 run_state 的 session_ref (06 #32)
            runState.session_ref,
        lastJudgment,
        lastJudgmentRef: runState.last_judgment,
        pendingContext: null,
        policyEscalations: [],
        permissionEvents: [],
        memoryPacketJson,
      };
    } catch (error) {
      console.error(
        `[LoopRunService] failed to rebuild context for run ${signal.runId}:`,
        error,
      );
      return null;
    }
  }

  private async runCollector(
    ctx: RunExecutionContext,
    outcome: ExecutionOutcome,
    stdoutRef: string,
  ): Promise<CollectorOutcome> {
    if (!ctx.input || !ctx.contract) {
      return { inputRef: null, outputRef: null, reportRef: null, report: null };
    }
    const { runId, loopId } = ctx.active;
    const inputName =
      ctx.turn === 1
        ? "collector-input.json"
        : `collector-input-turn${ctx.turn}.json`;
    const outputName =
      ctx.turn === 1
        ? "collector-output.log"
        : `collector-output-turn${ctx.turn}.log`;
    const reportName =
      ctx.turn === 1
        ? "collector-report.json"
        : `collector-report-turn${ctx.turn}.json`;
    const inputBundle = {
      run_id: runId,
      loop_id: loopId,
      turn: ctx.turn,
      task_type: ctx.contract.task_type.primary,
      workspace_ref: `workspace://${loopId}/${runId}`,
      workspace_path: ctx.input.cwd,
      stdout_ref: stdoutRef,
      execution_ok: outcome.ok,
      max_items_per_run: ctx.card.loop.handoff?.max_items_per_run ?? null,
      previous_judgment_ref: ctx.lastJudgmentRef,
      previous_unresolved_risks: ctx.lastJudgment?.unresolved_risks ?? [],
    };
    const inputJson = `${JSON.stringify(inputBundle, null, 2)}\n`;
    await this.deps.runLedgerStore.writeArtifact(runId, inputName, inputJson);
    const inputRef = `artifact://${runId}/${inputName}`;

    let collectorOutput = "";
    let collectorOk = false;
    try {
      const message = {
        text: buildCollectorPrompt(inputRef, inputBundle),
        mode: "plan" as const,
      };
      // collector 也是 adapter 调用 (02 §3): adapter_policy 的 model 覆盖
      // 与轮次超时同样适用 —— 挂死的 collector 不得挂死整个 run。
      const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
      const result = await this.deps.supervisor.startSession(
        ctx.input.cwd,
        message,
        "plan",
        {
          permissions: ctx.input.permissions,
          env: ctx.input.env,
          providerName: loopRuntime(ctx.card)?.provider as
            | ProviderName
            | undefined,
          model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
        },
      );
      if ("error" in result || "queued" in result) {
        collectorOutput =
          "collector could not start: supervisor queue unavailable";
      } else {
        const collected = await this.watchProcess(runId, result as Process, {
          timeoutMs: adapterPolicy.timeoutMs,
        });
        collectorOk = collected.ok;
        collectorOutput =
          collected.finalText ||
          collected.error ||
          "(collector produced no output)";
      }
    } catch (error) {
      collectorOutput =
        error instanceof Error
          ? error.message
          : `collector failed: ${String(error)}`;
    }

    await this.deps.runLedgerStore.writeArtifact(
      runId,
      outputName,
      collectorOutput,
    );
    const outputRef = `artifact://${runId}/${outputName}`;
    const report = CollectorReportSchema.parse({
      collector_phase: "review",
      status: collectorOk ? "passed" : "inconclusive",
      evidence_refs: [outputRef],
      unresolved_risks: collectorOk
        ? []
        : ["collector did not complete with a successful result"],
      recommendation: collectorOk ? "stop" : "escalate",
      confidence: collectorOk ? 0.7 : 0.2,
      requires_human: !collectorOk,
      summary: collectorOutput,
    });
    await this.deps.runLedgerStore.writeArtifact(
      runId,
      reportName,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return {
      inputRef,
      outputRef,
      reportRef: `artifact://${runId}/${reportName}`,
      report,
    };
  }

  /**
   * learning_refs.human_feedback 回填 (02 §8.1 / 04-存储约定): 人工反馈的
   * 真实载体是决策账本里带 feedback / override 的 decision_entry
   * (06 偏差 #9/#11)。每轮开始时快照一次 (人工反馈只会在阻塞等待期、即
   * 轮与轮之间进入决策账本, 轮首集合即本轮 entry 的最终集合): 无则 []
   * 且不落文件; 有则把相关决策条目聚合成 human-feedback.json 覆盖写
   * (同名 artifact, 内容随人工反馈累积更新), 并引用
   * artifact://<run_id>/human-feedback.json。每轮一条 entry — 前轮还没
   * 有人工反馈的 entry 保持 [], 后续轮次的 entry 自然带上前轮人工提交
   * 的反馈, 不重复落同一内容。人工 reject 直接终止 run (不再有新 entry),
   * 其反馈留在决策账本 (control_decision: ledger://<run_id>) 可查。
   */
  private async buildHumanFeedbackRefs(runId: string): Promise<string[]> {
    const decisions = await this.deps.runLedgerStore.readDecisionEntries(runId);
    const withFeedback = decisions.filter(
      (decision) =>
        decision.feedback !== undefined || decision.override !== undefined,
    );
    if (withFeedback.length === 0) {
      return [];
    }
    const name = "human-feedback.json";
    const content = {
      run_id: runId,
      entries: withFeedback.map((decision) => ({
        decision_id: decision.decision_id,
        decision: decision.decision,
        reason: decision.reason,
        feedback: decision.feedback ?? null,
        override: decision.override ?? null,
        created_at: decision.created_at,
      })),
    };
    await this.deps.runLedgerStore.writeArtifact(
      runId,
      name,
      `${JSON.stringify(content, null, 2)}\n`,
    );
    return [`artifact://${runId}/${name}`];
  }

  private async writeTurnHandoff(
    ctx: RunExecutionContext,
    refs: {
      collectorReportRef: string | null;
      judgmentRef: string | null;
      evidenceRefs: string[];
      blockerFingerprint?: string;
      repeatedBlockerCount?: number;
    },
  ): Promise<string> {
    const name =
      ctx.turn === 1
        ? "turn-handoff.json"
        : `turn-handoff-turn${ctx.turn}.json`;
    const handoff = TurnHandoffSchema.parse({
      run_id: ctx.active.runId,
      loop_id: ctx.active.loopId,
      turn: ctx.turn,
      workspace_ref: `workspace://${ctx.active.loopId}/${ctx.active.runId}`,
      session_ref: ctx.sessionRef,
      judgment_ref: refs.judgmentRef,
      collector_report_ref: refs.collectorReportRef,
      blocker_fingerprint: refs.blockerFingerprint ?? null,
      repeated_blocker_count: refs.repeatedBlockerCount ?? null,
      evidence_refs: refs.evidenceRefs,
      next_required_checks: ctx.card.loop.verification.required,
      actions_not_to_repeat: [],
      created_at: new Date().toISOString(),
    });
    await this.deps.runLedgerStore.writeArtifact(
      ctx.active.runId,
      name,
      `${JSON.stringify(handoff, null, 2)}\n`,
    );
    return `artifact://${ctx.active.runId}/${name}`;
  }

  /**
   * Execute one turn: turn 1 starts a new session; later turns resume the
   * run's session (05 阶段 2: retry = 新一轮 resumeSession, 不是新 session).
   */
  private async executeTurn(
    ctx: RunExecutionContext,
  ): Promise<ExecutionOutcome> {
    if (!ctx.input) {
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: "run setup failed: no assembled input",
        usage: null,
      };
    }
    const isFirstTurn = ctx.turn === 1 || !ctx.sessionRef;
    const prompt = isFirstTurn
      ? ctx.input.prompt
      : (ctx.pendingContext ??
        "Continue the loop task and finish with a text report.");
    ctx.pendingContext = null;
    const message = { text: prompt, mode: ctx.input.permissionMode };

    // Policy projection (05 阶段 2): when the card declared a policy, the
    // per-turn approval hook is the canUseTool rule source — self-approvals
    // are audited to the decision ledger, hard gates are blocked and
    // collected as escalations (drained into applyJudgment after the turn).
    // Legacy read-only runs (no policy) pass no hook: permissionMode "plan"
    // + deny rules + auto-deny watcher, exactly as phase 0/1.
    ctx.policyEscalations = [];
    ctx.permissionEvents = [];
    const toolApprovalHook = ctx.input.policyProfile
      ? createLoopToolApprovalHook({
          profile: ctx.input.policyProfile,
          runId: ctx.active.runId,
          loopId: ctx.active.loopId,
          turn: ctx.turn,
          workspacePath: ctx.input.cwd,
          store: this.deps.runLedgerStore,
          escalations: ctx.policyEscalations,
          permissionEvents: ctx.permissionEvents,
        })
      : undefined;
    // adapter_policy 消费 (修复计划 #13): published / canary 的
    // runtime_adapter_proposal 经装配带上 RuntimeInput.adapterPolicy,
    // 这里解析成真实旋钮 —— model 覆盖进 session settings,
    // timeout_seconds 进 watchProcess 的轮次超时 (02 §3: adapter 调用
    // 必须带超时)。
    const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
    const sessionSettings = {
      permissions: ctx.input.permissions,
      toolApprovalHook,
      env: ctx.input.env,
      providerName: loopRuntime(ctx.card)?.provider as ProviderName | undefined,
      model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
    };

    let result: Process | QueuedResponse | QueueFullResponse;
    try {
      result = isFirstTurn
        ? await this.deps.supervisor.startSession(
            ctx.input.cwd,
            message,
            ctx.input.permissionMode,
            sessionSettings,
          )
        : await this.deps.supervisor.resumeSession(
            ctx.sessionRef as string,
            ctx.input.cwd,
            message,
            ctx.input.permissionMode,
            sessionSettings,
          );
    } catch (error) {
      // startSession can throw synchronously (e.g. adapter spawn failure on
      // an invalid workspace path). Convert it to a failed ExecutionOutcome
      // so runTurns writes a ledger entry instead of crashing silently.
      const message_ = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: `session start failed: ${message_}`,
        usage: null,
      };
    }

    if ("error" in result && result.error === "queue_full") {
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: "supervisor queue is full",
        usage: null,
      };
    }
    if ("queued" in result && (result as QueuedResponse).queued === true) {
      // A queued session starts later without a ledger track; treated as a
      // failed turn instead of waiting indefinitely.
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: "supervisor at capacity; run request was queued",
        usage: null,
      };
    }

    const proc = result as Process;
    // 立即暴露 session: getRun / Stream Output 在轮中即可订阅实时流
    // (此前要等 outcome 返回才赋值, 首轮在飞期间 session_ref 恒 null)。
    // runTurns 在 outcome 返回后用同值再赋一次。
    ctx.sessionRef = proc.sessionId;
    // Registered so PATCH pause can kill the executing turn (选项 A);
    // removed again when watchProcess settles.
    this.executingProcesses.set(ctx.active.runId, proc);
    return this.watchProcess(ctx.active.runId, proc, {
      timeoutMs: adapterPolicy.timeoutMs,
    });
  }

  /**
   * Collect a turn's final result from the session process. Resolves on the
   * SDK "result" message, or on process completion/termination if no result
   * ever arrives. Token usage comes from the result message's `usage`
   * (Claude SDK AdapterOutput, 02 §4: input_tokens + output_tokens); when
   * the runtime does not expose usage it stays null — never fabricated.
   *
   * opts.timeoutMs: 轮次超时 (adapter_policy.timeout_seconds, 02 §3:
   * adapter 调用必须带超时)。超时按 adapter 硬错误 timeout 归因
   * (runtime_blackbox_error), 进程被杀, 不无限等待。
   */
  private async watchProcess(
    runId: string,
    proc: Process,
    opts: { timeoutMs?: number } = {},
  ): Promise<ExecutionOutcome> {
    return new Promise<ExecutionOutcome>((resolve) => {
      let finalText = "";
      let tokens: number | null = null;
      let settled = false;
      let adapterError: AdapterError | undefined;
      let timer: NodeJS.Timeout | undefined;
      // 轮内归一消息流（00 挂载点三: ProcessEvent message 即统一 trace
      // 源）——逐条收集，turn 结束后落 runtime-events artifact 供验证
      // 输入引用（02 §5 runtime_event_refs / structured_output）。
      const runtimeEvents: unknown[] = [];

      // 无默认轮次超时（2026-07-27 用户决策：硬超时太绝对 —— 真实只读
      // 扫描常需 5-10min，一刀切会误杀健康轮次并丢弃其报告）。只有
      // adapter_policy.timeout_seconds 显式配置时才计时；挂起/死循环
      // 的治理走代办 watchdog（docs/plans/loop-spec-gap-fix-plan.md
      // 代办节），不靠固定计时。
      const timeoutMs = opts.timeoutMs ?? 0;

      const settle = (ok: boolean, error?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        unsubscribe();
        this.executingProcesses.delete(runId);
        // Free the worker slot; the session jsonl stays on disk, so a
        // later turn can still resumeSession on the same session_ref.
        void proc.abort().catch(() => {});
        resolve({
          ok,
          finalText,
          sessionRef: proc.sessionId,
          error,
          usage: tokens === null ? null : { tokens },
          adapterError,
          runtimeEvents,
        });
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          adapterError = new AdapterError(
            "timeout",
            `turn exceeded timeout (${timeoutMs}ms, adapter_policy.timeout_seconds)`,
          );
          settle(false, adapterError.message);
        }, timeoutMs);
        // 计时器不得拖住 server 进程退出
        timer.unref();
      }

      const unsubscribe = proc.subscribe((event) => {
        if (event.type === "message") {
          const message = event.message;
          runtimeEvents.push({ at: new Date().toISOString(), message });
          if (message.type === "result") {
            if (typeof message.result === "string") {
              finalText = message.result;
            }
            // 02 §4 usage: the Claude SDK result message carries
            // usage { input_tokens, output_tokens, ... } — counted as
            // input + output per the contract's usage shape (cache tokens
            // are not part of the 02 §4 usage contract).
            const usage = (
              message as {
                usage?: { input_tokens?: number; output_tokens?: number };
              }
            ).usage;
            if (usage && typeof usage.input_tokens === "number") {
              tokens = usage.input_tokens + (usage.output_tokens ?? 0);
            }
            const isError =
              message.is_error === true ||
              (typeof message.subtype === "string" &&
                message.subtype !== "success");
            settle(
              !isError,
              isError ? `agent result: ${String(message.subtype)}` : undefined,
            );
          }
        } else if (
          event.type === "state-change" &&
          event.state.type === "waiting-input"
        ) {
          // Unattended read-only run: auto-deny every approval request
          // instead of hanging the turn.
          proc.respondToInput(
            event.state.request.id,
            "deny",
            undefined,
            "Unattended read-only loop run: approval requests are auto-denied. Stay read-only and finish with a text report.",
          );
        } else if (event.type === "complete") {
          settle(
            finalText.length > 0,
            finalText.length > 0
              ? undefined
              : "process completed without a result message",
          );
        } else if (event.type === "terminated") {
          if (event.error instanceof AdapterError) {
            adapterError = event.error;
          }
          settle(false, `process terminated: ${event.reason}`);
        } else if (event.type === "error") {
          if (event.error instanceof AdapterError) {
            adapterError = event.error;
          }
          settle(false, event.error.message);
        }
      });
    });
  }
}
