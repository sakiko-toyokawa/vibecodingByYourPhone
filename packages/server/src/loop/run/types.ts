/**
 * Internal types shared by the run orchestration modules.
 *
 * These were extracted from run-service.ts as part of the Phase-3 refactor
 * to keep the public facade thin while preserving the exact execution model.
 */

import type {
  CollectorReport,
  HumanReason,
  IntentContract,
  JudgmentReport,
  LoopCard,
  PendingToolCall,
  RunLedgerEntry,
  RunState,
  RunWorkingState,
  TaskPlan,
} from "@yep-anywhere/shared";
import type { AdapterError } from "../../sdk/adapter-error.js";
import type { RuntimeInput } from "../assembly/runtime-input.js";
import type { ContractSource } from "../contract/intent-contract.js";
import type { MaintenanceTarget } from "../maintenance/types.js";
import type {
  PermissionEvent,
  PolicyEscalation,
} from "../policy/approval-hook.js";
import type { RelationRecord } from "../relation/relation-store.js";

export interface GithubCredentialStore {
  getToken(): Promise<string | null>;
}

export interface GithubToolProvisioner {
  ensureGh(): Promise<{ path: string; version: string; installed: boolean }>;
}

export interface ActiveRun {
  runId: string;
  loopId: string;
  source: ContractSource;
  createdAt: string;
  relationId?: string;
  maintenanceId?: string;
}

export interface ExecutionOutcome {
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
  /** Whether the turn produced observable evidence. Missing for legacy paths. */
  evidence?: {
    has_final_text: boolean;
    has_runtime_events: boolean;
    has_diff: boolean;
    has_required_artifacts: boolean;
  };
  producedEvidence?: boolean;
}

export interface CollectorOutcome {
  reportRef: string | null;
  outputRef: string | null;
  inputRef: string | null;
  /** collector session 的报告本体 (修复计划 #12: card 要求 review 段时
   *  转成 verifier_report 参与聚合)。 */
  report: CollectorReport | null;
}

/** Everything a suspended (needs_human / budget_limited / paused) run needs
 *  to continue with its next turn after a ResumeSignal. */
export interface RunExecutionContext {
  active: ActiveRun;
  card: LoopCard;
  contract: IntentContract | null;
  contractJson: string | null;
  input: RuntimeInput | null;
  turn: number;
  /** Latest turn's provider session ref for audit/run_state/handoff; loop
   *  turns never resume it. Each executeTurn starts a fresh session. */
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
  /** One-shot tool calls approved by a human for the next turn only. */
  approvedToolCalls?: PendingToolCall[];
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
  /** Planner 生成的多轮任务分解计划（无 plan 时为 null）。 */
  taskPlan: TaskPlan | null;
  /** 最新一轮 executor 输出的 run 级领域工作记忆；无则 null。 */
  workingState: RunWorkingState | null;
  /** 人工豁免的 verification phases（waive_phases 决策后本 run 生效）。 */
  waivedPhases: string[];
  /** 当前执行的子任务索引（0-based）。 */
  currentSubtaskIndex: number;
  /** Hashes of the most recent turn outputs, used for stagnation detection. */
  recentTurnOutputHashes: string[];
  /** Hashes of the most recent git-diff --stat summaries, used for idle
   *  detection (no effective workspace change across turns). */
  recentTurnDiffStatHashes: string[];
  /** Most recent blocker fingerprints, used for loop/dead-loop detection. */
  recentBlockerFingerprints: string[];
  /** Durable external relationship this run is maintaining, when started
   *  from a relation-aware trigger. */
  relation?: RelationRecord | null;
  /** Generic maintenance target this run is maintaining, when started from
   *  an external event. */
  maintenanceTarget?: MaintenanceTarget | null;
}

/** Public projection of a run for routes; kept here to share with ledger-summary. */
export interface RunSummary {
  run_id: string;
  loop_id: string;
  /** "active" while in flight; afterwards the control-plane's latest state */
  state: RunState;
  source: ContractSource;
  created_at: string;
}

/** Ledger summary projection returned by getRun. */
export interface LedgerSummary {
  turns_used: number;
  retries_used: number;
  /** 合约预算上限（控制面预算快照）；run_state 不属于该 run 时为 null */
  max_turns: number | null;
  max_retries: number | null;
  /** 最新一条决策（decision kind + reason），解释 run 为何处于当前状态 */
  last_decision: {
    decision: string;
    reason: string;
    human_reasons?: HumanReason[];
  } | null;
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

/** Per-turn projection shown in the frontend turn history. */
export interface RunTurnSummary {
  turn: number;
  status: RunState;
  decision?: string;
  source?: string;
  created_at: string;
  stdout_ref: string | null;
  judgment_ref: string | null;
  executor_summary_ref: string | null;
}
