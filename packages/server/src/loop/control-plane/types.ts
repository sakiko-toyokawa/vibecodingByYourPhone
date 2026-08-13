/**
 * Shared control-plane types and state shape.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import type {
  Budget,
  BudgetLimits,
  DecisionEntry,
  FailureTag,
  IntentContract,
  JudgmentReport,
  PendingToolCall,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import type { IEventBus } from "../../watcher/index.js";
import type { LearningEventStore } from "../state/learning-event-store.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import type { RunStateStore } from "./run-state-store.js";

export interface ControlPlaneDeps {
  runStateStore: RunStateStore;
  runLedgerStore: RunLedgerStore;
  /** Optional: events are only broadcast when a bus is wired. */
  eventBus?: IEventBus;
  /**
   * Optional: learning_event sink (阶段 3). When wired, a run reaching a
   * terminal decision (complete / failed / budget_limited) or a decision
   * carrying failure_tags appends one learning_event to
   * learning/events.jsonl — fire-and-forget (只发不等), emission failures
   * are logged and never affect run progression.
   */
  learningEventStore?: LearningEventStore;
  /**
   * Optional: LoopCard 注册表 (只读), 供 .loop/STATE.md 人可读投影取
   * workspace.path 与 persistence.state_file (04-存储约定)。未接线时
   * 跳过投影, 不影响主链路。
   */
  loopCardStore?: Pick<LoopCardStore, "getLoop">;
  /** Server data directory; used to resolve managed:// workspace paths for STATE.md projection. */
  dataDir?: string;
  /** Ratio of max_tokens at which a loop-budget-warning is emitted. */
  loopTokenAlertRatio?: number;
}

export interface PendingApproval {
  loopId: string;
  requestId: string;
}

/** Per-turn resource consumption reported by the run service. */
export interface TurnUsage {
  /**
   * Tokens consumed by the turn (AdapterOutput usage, 02 §4); null when the
   * runtime did not expose usage — the budget counter is left unchanged,
   * never fabricated.
   */
  tokens: number | null;
  /** Wall-clock minutes the turn took (execution + verification). */
  timeMinutes: number;
}

export interface ApplyJudgmentInput {
  loopId: string;
  runId: string;
  turn: number;
  goalId: string;
  workspaceRef: string;
  /** Whether the run's execution turn succeeded. */
  executionOk: boolean;
  /** Whether the verification layer ran (card requires phases). */
  verificationRan: boolean;
  /** Aggregated judgment_report; null when verification did not run. */
  judgment: JudgmentReport | null;
  /** artifact:// ref of judgment-report.json; null when verification did not run. */
  judgmentRef: string | null;
  /** Run creation time (ISO 8601), used for the state record's created_at. */
  createdAt: string;
  /** Budget limits from the IntentContract (数值唯一权威来源, 02 §2). */
  budget: BudgetLimits;
  /** This turn's consumption, accumulated into the run's budget snapshot. */
  usage: TurnUsage;
  /**
   * Set when the run was terminated by a unified adapter hard error
   * (02-schema契约.md §4). The failure attribution (失败模式账本 vocabulary)
   * is recorded on the control decision entry. Adapter hard errors are
   * terminal: they decide `failed` via executionOk=false and never bridge
   * to needs_human (see the run-service call-site comment).
   */
  adapterFailure?: {
    code: string;
    failureTag: FailureTag;
    message: string;
  };
  /**
   * Set when the policy projection intercepted a hard-gate / high-risk
   * action during the turn (05 阶段 2 验收 4: 硬闸门拦截升级 needs_human,
   * bypass 下仍被拦 — bypass ≠ 绕过硬闸门). Forces the control decision
   * to needs_human unless the turn already failed terminally; the policy
   * ref lands on the decision entry's policy_refs.
   */
  policyEscalation?: {
    action: string;
    reason: string;
    policyRef: string;
    /** Exact blocked tool call, included when the agent requests a release. */
    toolCall?: PendingToolCall;
    /** Review_or_policy lanes are human-reviewable, not necessarily failures. */
    reviewable?: boolean;
  };
  /** Phase 7: deterministic tags derived from L3/L4 verifier signals. */
  verifierFailureTags?: FailureTag[];
  /**
   * 合约的非预算停止规则 (02 §2 stop_rules; 当前只有
   * repetition.max_same_failure 被消费: 同一阻断指纹重复超过上限即停,
   * needs_human 循环打断为终态 failed —— 预算与停止规则.md "同一
   * verifier 同一错误重复 → 停止或人工")。
   */
  stopRules?: IntentContract["stop_rules"];
  /** 本轮执行的 session 引用 (06 偏差 #32: run_state.session_ref,
   *  前端据此订阅对应 session 的消息流)。 */
  sessionRef?: string;
  /** 工作区 diff 摘要 (git diff --stat 文本, 由 run-service 捕获)。仅在
   *  升级 needs_human 时随 run-decision-required 事件透传给前端;
   *  缺失则事件不携带 diff_summary 字段。 */
  diffSummary?: string;
}

export interface ApplyJudgmentResult {
  state: import("./decide.js").ControlDecisionKind;
  entry: DecisionEntry;
  /** Budget snapshot after accumulating this turn (drives retry backoff). */
  budget: Budget;
  /** True when this exact transition was already ledgered (repeat trigger). */
  idempotent: boolean;
}

export interface BeginTurnResult {
  /** False when the pre-turn budget check stopped the run (budget_limited). */
  ok: boolean;
  state: RunState;
  record: RunStateRecord;
}

/**
 * ResumeSignal — a blocked run (needs_human / paused / budget_limited)
 * came back to active; the run service continues it with a new turn.
 */
export interface ResumeSignal {
  runId: string;
  loopId: string;
  cause:
    | "human_approve"
    | "human_request_changes"
    | "resume_signal"
    | "budget_supplemented"
    | "restart_recovery_approve";
  /** Original state when a restart-recovery approval resumes a run. */
  restartRecoveryFromState?: "active" | "retry";
  /** Human feedback to inject into the next turn's context, when given. */
  feedback?: string;
  /** Exact tool call approved by the human for one next-turn execution. */
  approvedToolCall?: PendingToolCall;
  /** Human confirmed the current subtask and asked the run to advance. */
  advanceSubtask?: boolean;
  /** Verification phases waived by the human for the remaining run. */
  waivedPhases?: string[];
}

/**
 * Seed for pausing a run whose first turn is still in flight: turn 1 has no
 * run_state record yet (it is first written at judgment time), so PATCH
 * pause materializes one from the run service's execution context before
 * driving active → paused.
 */
export interface PauseSeed {
  runId: string;
  turn: number;
  goalId: string;
  workspaceRef: string;
  /** Contract budget limits; null when setup failed before a contract existed. */
  budget: BudgetLimits | null;
  createdAt: string;
  /** Session of the in-flight turn being killed, kept for audit/recovery
   *  reference after a server restart; loop resumes open a fresh session
   *  (06 #32). Null when no session had started yet. */
  sessionRef?: string | null;
}

export interface ControlPlaneState {
  /** run_id -> pending approval (in-memory index; rebuilt from state files) */
  pending: Map<string, PendingApproval>;
  /** run_id -> loop_id (in-memory index; rebuilt from state files on scan) */
  runIndex: Map<string, string>;
  /** run_id -> latest known state (drives API state projections) */
  statesByRunId: Map<string, import("@yep-anywhere/shared").RunState>;
  /** In-flight fire-and-forget learning_event appends (settle hook for tests). */
  pendingLearningEvents: Promise<void>[];
  /** In-flight fire-and-forget STATE.md projections (settle hook for tests). */
  pendingStateMdProjections: Promise<void>[];
  /** Budget warning de-duplication set. */
  budgetWarned: Set<string>;
}
