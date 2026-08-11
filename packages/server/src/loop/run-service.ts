/**
 * Phase-2 run orchestration (spec: docs/spec/05-分阶段计划.md 阶段 2).
 *
 * Wires trigger → contract → assembly → Supervisor → verification →
 * control-plane into the unattended loop. Phase 2 upgrades the run from
 * phase 1's single turn to a multi-turn execution driven by the full state
 * machine.
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

import { randomUUID } from "node:crypto";
import type {
  CollectorReport,
  IntentContract,
  JudgmentReport,
  LoopCard,
  ProviderName,
  RunLedgerEntry,
  RunState,
  RunStateRecord,
  TaskPlan,
} from "@yep-anywhere/shared";
import { DEFAULT_PROVIDER, IntentContractSchema } from "@yep-anywhere/shared";
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
  type RuntimeInput,
  assembleRuntimeInput,
  extractExecutorSummary,
} from "./assembly/runtime-input.js";
import {
  type ContractSource,
  buildIntentContract,
} from "./contract/intent-contract.js";
import type { PlannerService } from "./contract/planner.js";
import {
  type ControlPlane,
  ControlPlaneError,
  type PauseSeed,
  type ResumeSignal,
} from "./control-plane/control-plane.js";
import { retryBackoffMs } from "./control-plane/retry-backoff.js";
import type { RunStateStore } from "./control-plane/run-state-store.js";
import {
  type PermissionEvent,
  type PolicyEscalation,
  createLoopToolApprovalHook,
} from "./policy/approval-hook.js";
import { resolvePolicyProfile } from "./policy/profiles.js";
import type { RelationStore } from "./relation/relation-store.js";
import {
  buildHumanFeedbackRefs,
  captureGitDiff,
  captureGitDiffStat,
  mergeEvidence,
  runCollector,
  writeTurnHandoff,
} from "./run/artifacts.js";
import { rollbackDirectRun, writeDiscardResult } from "./run/discard.js";
import { buildLedgerSummary } from "./run/ledger-summary.js";
import {
  type TurnLoopState,
  continueRun,
  executeRun,
  releaseRun,
  resumeAfterRestart,
} from "./run/turn-loop.js";
import type {
  ActiveRun,
  GithubCredentialStore,
  GithubToolProvisioner,
  LedgerSummary,
  RunExecutionContext,
  RunSummary,
  RunTurnSummary,
} from "./run/types.js";
import {
  displayGitHubPromptWorkspacePath,
  githubPromptWorkspacePath,
  isGitHubPromptLoop,
  loopRuntime,
  resolveExecutableCard,
  resolveRuntimeAssemblyContext,
} from "./run/workspace.js";
import type { FailurePatternStore } from "./state/failure-pattern-store.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import type { ProposalStore } from "./state/proposal-store.js";
import type { RunLedgerStore } from "./state/run-ledger-store.js";
import { checkRequiredArtifacts } from "./verification/required-artifacts.js";
import {
  type VerificationRefs,
  verificationArtifactName,
  type verifyRun,
} from "./verification/verify-run.js";
import {
  WORKSPACE_UNSTABLE_ANNOTATION,
  type WorkspaceSnapshot,
  captureWorkspaceSnapshot,
  workspaceSnapshotChanged,
} from "./verification/workspace-stability.js";
import {
  discardRunWorktree,
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

export type { RunSummary, LedgerSummary, RunTurnSummary } from "./run/types.js";

export interface LoopRunServiceDeps {
  supervisor: Supervisor;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  /** Phase 6 checkpoint writing / restart recovery. */
  runStateStore?: RunStateStore;
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
  githubCredentialStore?: GithubCredentialStore;
  /** Managed gh provisioner used by github_prompt discovery loops. */
  githubToolProvisioner?: GithubToolProvisioner;
  /** Server data directory; used for managed github_prompt workspaces. */
  dataDir?: string;
  /** Durable external relationship store used by relation-aware runs. */
  relationStore?: RelationStore;
  /** Planner Agent for multi-turn task decomposition (optional). */
  planner?: PlannerService;
  /** Watchdog / stagnation settings. */
  loopWatchdog?: {
    turnIdleTimeoutMs: number;
    turnIdleCheckIntervalMs: number;
    /** Consecutive turns with identical normalized output → escalation. */
    stagnationSimilarTurnsThreshold: number;
    /** Consecutive retry turns with no effective workspace diff change →
     *  idle escalation. */
    idleNoProgressTurnsThreshold: number;
    /** Consecutive turns with the same blocker fingerprint → dead-loop
     *  escalation. */
    repeatedBlockerThreshold: number;
  };
}

function makeRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

// describeAdapter 已移至 loop/assembly/adapter-info.ts (装配层与账本共用
// 02 §3 native_invocation / §8.1 runtime 块的同一投影), 此处再导出兼容。
export { describeAdapter } from "./assembly/adapter-info.js";

export class LoopRunService {
  private readonly deps: LoopRunServiceDeps & {
    loopWatchdog: NonNullable<LoopRunServiceDeps["loopWatchdog"]>;
  };
  private readonly state: TurnLoopState = {
    activeByLoop: new Map<string, ActiveRun>(),
    activeByRunId: new Map<string, ActiveRun>(),
    suspended: new Map<string, RunExecutionContext>(),
    executingContexts: new Map<string, RunExecutionContext>(),
    executingProcesses: new Map<string, Process>(),
  };

  constructor(deps: LoopRunServiceDeps) {
    this.deps = {
      ...deps,
      loopWatchdog: deps.loopWatchdog ?? {
        turnIdleTimeoutMs: 10 * 60 * 1000,
        turnIdleCheckIntervalMs: 30 * 1000,
        stagnationSimilarTurnsThreshold: 3,
        idleNoProgressTurnsThreshold: 3,
        repeatedBlockerThreshold: 3,
      },
    };
    // A needs_human run keeps its active registration while it waits; the
    // control-plane calls this when a human decision terminates it (reject).
    deps.controlPlane?.onRunResolved((runId) => releaseRun(runId, this.state));
    // A blocked run that comes back to active continues with a new turn.
    deps.controlPlane?.onResumeRequested((signal) => {
      void continueRun(signal, this.deps, this.state).catch((error) => {
        console.error(
          `[LoopRunService] failed to continue run ${signal.runId}:`,
          error,
        );
      });
    });
  }

  isRunActive(loopId: string): boolean {
    return this.state.activeByLoop.has(loopId);
  }

  /**
   * PATCH pause 的实现（03-API契约.md: 主动暂停，不走审批管线 — 审批队列
   * 无新增排队项）. Drives active → paused through the control-plane, then
   * kills the executing process (选项 A, 见文件头): the partial turn result
   * is dropped, and the session_ref stays for audit/recovery reference. A
   * later resume starts a fresh provider session from the AU2 handoff.
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
    const active = this.state.activeByLoop.get(loopId);
    if (record?.state === "active") {
      // Also covers a stale active record after a server restart: the
      // transition still lands; terminateExecuting is then a no-op.
      const ctx = this.state.executingContexts.get(record.run_id);
      const updated = await controlPlane.pauseActive(loopId, {
        runId: record.run_id,
        turn: ctx?.turn ?? 1,
        goalId: ctx?.contract?.intent_id ?? "unknown",
        workspaceRef: `workspace://${loopId}/${record.run_id}`,
        budget: ctx?.contract?.budget ?? null,
        createdAt: active?.createdAt ?? record.created_at,
        // ctx.sessionRef 要等 turn 结束才赋值; 在飞 turn 的 session 从
        // 执行中的 Process 取, 供 audit / run_state 记录最新 session。
        sessionRef:
          this.state.executingProcesses.get(record.run_id)?.sessionId ??
          ctx?.sessionRef ??
          null,
      });
      this.terminateExecuting(record.run_id);
      return updated;
    }
    if (active) {
      // Turn 1 still in flight: no run_state record exists yet (it is first
      // written at judgment time) — or a terminal record from the previous
      // run is in its place. Pause via a seeded record (PauseSeed).
      const ctx = this.state.executingContexts.get(active.runId);
      const updated = await controlPlane.pauseActive(loopId, {
        runId: active.runId,
        turn: ctx?.turn ?? 1,
        goalId: ctx?.contract?.intent_id ?? "unknown",
        workspaceRef: `workspace://${loopId}/${active.runId}`,
        budget: ctx?.contract?.budget ?? null,
        createdAt: active.createdAt,
        sessionRef:
          this.state.executingProcesses.get(active.runId)?.sessionId ??
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
    const proc = this.state.executingProcesses.get(runId);
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
    options: { relationId?: string } = {},
  ): Promise<RunSummary> {
    const stored = this.deps.loopCardStore.getLoop(loopId);
    if (!stored) {
      throw new LoopRunError("loop_not_found", `Loop '${loopId}' not found`);
    }
    if (stored.archived) {
      throw new LoopRunError("loop_archived", `Loop '${loopId}' is archived`);
    }
    if (this.state.activeByLoop.has(loopId)) {
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

    const policyProfile = resolvePolicyProfile(card);
    if (
      card.loop.workspace.strategy === "direct" &&
      policyProfile &&
      !policyProfile.allow_direct_mutations
    ) {
      throw new LoopRunError(
        "loop_not_runnable",
        `Loop '${loopId}' uses direct workspace with policy '${policyProfile.policy_profile}', but that profile does not opt into allow_direct_mutations (use workspace_local_fix for dedicated direct workspaces)`,
      );
    }

    const createdAt = new Date();
    const runId = makeRunId(createdAt);
    const active: ActiveRun = {
      runId,
      loopId,
      source,
      createdAt: createdAt.toISOString(),
      relationId: options.relationId,
    };
    this.state.activeByLoop.set(loopId, active);
    this.state.activeByRunId.set(runId, active);

    // Fire-and-forget: the HTTP handler / scheduler must not block on the
    // agent finishing. The ledger is the durable record of the run.
    void executeRun(active, card, this.deps, this.state).catch((error) => {
      console.error(`[LoopRunService] run ${runId} crashed:`, error);
      releaseRun(runId, this.state);
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

    const active = this.state.activeByLoop.get(loopId);
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

  /** Per-turn history projection for the frontend turn view. */
  async listRunTurns(runId: string): Promise<RunTurnSummary[]> {
    const found = await this.getRun(runId);
    if (!found) {
      return [];
    }
    const entries = await this.deps.runLedgerStore.readEntries(runId);
    const decisions = await this.deps.runLedgerStore.readDecisionEntries(runId);
    const artifacts = new Set(
      await this.deps.runLedgerStore.listArtifacts(runId),
    );
    return entries.map((entry, index) => {
      const turn = index + 1;
      const suffix = turn === 1 ? "" : `-turn${turn}`;
      const stdoutName = `stdout${suffix}.log`;
      const judgmentName = `judgment-report${suffix}.json`;
      const summaryName = `executor-summary${suffix}.md`;
      const turnDecisions = decisions.filter(
        (decision) =>
          decision.decision_id.includes(`-t${turn}-`) &&
          decision.decision !== "bypass_used" &&
          decision.decision !== "resumed",
      );
      return {
        turn,
        status: entry.final_status,
        decision:
          turnDecisions.length > 0
            ? (turnDecisions[turnDecisions.length - 1]?.decision ?? undefined)
            : undefined,
        source: entry.source,
        created_at: entry.created_at,
        stdout_ref: artifacts.has(stdoutName)
          ? `artifact://${runId}/${stdoutName}`
          : null,
        judgment_ref: artifacts.has(judgmentName)
          ? `artifact://${runId}/${judgmentName}`
          : null,
        executor_summary_ref: artifacts.has(summaryName)
          ? `artifact://${runId}/${summaryName}`
          : null,
      };
    });
  }

  /** Read one artifact's content for a run (undefined when missing). */
  async readRunArtifact(
    runId: string,
    name: string,
  ): Promise<string | undefined> {
    return this.deps.runLedgerStore.readArtifact(runId, name);
  }

  /** Read the ledger entry for a run (null when missing). */
  async readRunLedgerEntry(runId: string): Promise<RunLedgerEntry | null> {
    return this.deps.runLedgerStore.readEntry(runId);
  }

  /** Single run view: active run metadata or the finished ledger entry,
   *  plus the 03 LedgerSummary projection (incl. judgment_report 摘要). */
  async getRun(runId: string): Promise<{
    run: RunSummary;
    ledger: RunLedgerEntry | null;
    ledger_summary: LedgerSummary;
    session_ref: string | null;
  } | null> {
    const active = this.state.activeByRunId.get(runId);
    if (active) {
      // Active run: ledger not yet written, but the executing context may
      // already carry the session ref (set after executeTurn starts). For
      // suspended runs (paused / needs_human / budget_limited) the context
      // moved out of executingContexts — the ref survives in suspended.
      const ctx =
        this.state.executingContexts.get(runId) ??
        this.state.suspended.get(runId);
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
        ledger_summary: await buildLedgerSummary(
          {
            runLedgerStore: this.deps.runLedgerStore,
            controlPlane: this.deps.controlPlane,
          },
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
      ledger_summary: await buildLedgerSummary(
        {
          runLedgerStore: this.deps.runLedgerStore,
          controlPlane: this.deps.controlPlane,
        },
        runId,
        entry.loop_id,
        entry,
      ),
      session_ref: entry.runtime.session_ref,
    };
  }

  /**
   * Resume runs that were active or retrying when the server restarted.
   * Delegated to the turn-loop driver.
   */
  async resumeAfterRestart(loopId: string): Promise<void> {
    return resumeAfterRestart(loopId, this.deps, this.state);
  }

  /**
   * Discard one run: transition to `discarded`, optionally revert direct
   * workspace changes and/or remove a worktree, then write discard evidence.
   */
  async discardRun(
    runId: string,
    input: {
      reason: string;
      revertFiles?: boolean;
      cleanupWorktree?: boolean;
      force?: boolean;
    },
  ): Promise<{
    run_state: RunStateRecord;
    discard_result_ref: string;
  }> {
    const detail = await this.getRun(runId);
    if (!detail) {
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }
    const controlPlane = this.deps.controlPlane;
    if (!controlPlane) {
      throw new ControlPlaneError(
        "invalid_state",
        "Control plane not wired; discard is unavailable",
      );
    }
    const { run } = detail;
    const loopId = run.loop_id;
    if ((run.state === "active" || run.state === "retry") && !input.force) {
      throw new ControlPlaneError(
        "invalid_state",
        `Run '${runId}' is '${run.state}'; discard requires force=true so the executing process can be terminated first`,
      );
    }
    if (input.force) {
      this.terminateExecuting(runId);
    }
    const active = this.state.activeByRunId.get(runId);
    const ctx =
      this.state.executingContexts.get(runId) ??
      this.state.suspended.get(runId);
    const seed: PauseSeed = {
      runId,
      turn: ctx?.turn ?? (active ? 1 : 0),
      goalId: ctx?.contract?.intent_id ?? "unknown",
      workspaceRef: `workspace://${loopId}/${runId}`,
      budget: ctx?.contract?.budget ?? null,
      createdAt: active?.createdAt ?? run.created_at,
      sessionRef:
        this.state.executingProcesses.get(runId)?.sessionId ??
        ctx?.sessionRef ??
        null,
    };
    const runState = await controlPlane.discardRun(runId, input.reason, {
      force: input.force,
      loopId,
      seed,
      evidenceRefs: [],
    });
    releaseRun(runId, this.state);

    const stored = this.deps.loopCardStore.getLoop(loopId);
    const card = stored?.card;
    let rollback: Awaited<ReturnType<typeof rollbackDirectRun>> | null = null;
    let worktreeCleanup: { ok: boolean; error?: string } | null = null;
    if (card?.loop.workspace.strategy === "direct") {
      const declaredPath = card.loop.workspace.path;
      const workspacePath =
        declaredPath?.startsWith("managed://github-workspaces/prompt-loops/") &&
        this.deps.dataDir
          ? githubPromptWorkspacePath(this.deps.dataDir, loopId)
          : declaredPath;
      rollback =
        input.revertFiles === false
          ? { ok: true, revertedTrackedFiles: false }
          : workspacePath
            ? await rollbackDirectRun(
                this.deps.runLedgerStore,
                workspacePath,
                runId,
              )
            : {
                ok: false,
                revertedTrackedFiles: false,
                error: "direct workspace path is missing",
              };
    } else if (
      card?.loop.workspace.strategy === "worktree" &&
      this.deps.dataDir &&
      input.cleanupWorktree !== false
    ) {
      worktreeCleanup = await discardRunWorktree({
        dataDir: this.deps.dataDir,
        loopId,
        runId,
      });
    }
    const discardResultRef = await writeDiscardResult(
      this.deps.runLedgerStore,
      runId,
      {
        reason: input.reason,
        rollback,
        worktreeCleanup,
      },
    );
    return { run_state: runState, discard_result_ref: discardResultRef };
  }
}
