/**
 * The multi-turn run loop: execute → verify → control-plane judgment, plus
 * resume/continue/restart recovery.
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import { createHash } from "node:crypto";
import type {
  FailureTag,
  IntentContract,
  JudgmentReport,
  LoopCard,
  ProviderName,
  RunLedgerEntry,
  RunState,
} from "@yep-anywhere/shared";
import {
  AdapterError,
  adapterErrorCodeToFailureTag,
} from "../../sdk/adapter-error.js";
import type { Process } from "../../supervisor/Process.js";
import type { Supervisor } from "../../supervisor/Supervisor.js";
import type { IEventBus } from "../../watcher/index.js";
import { describeAdapter } from "../assembly/adapter-info.js";
import { resolveAdapterPolicy } from "../assembly/adapter-policy.js";
import {
  AssemblyError,
  assembleRuntimeInput,
  extractExecutorSummary,
  extractLoopState,
} from "../assembly/runtime-input.js";
import { buildIntentContract } from "../contract/intent-contract.js";
import { buildIntentContractWithUnderstanding } from "../contract/intent-understanding-agent.js";
import type { PlannerService } from "../contract/planner.js";
import type {
  ControlPlane,
  ResumeSignal,
} from "../control-plane/control-plane.js";
import { retryBackoffMs } from "../control-plane/retry-backoff.js";
import type { RunStateStore } from "../control-plane/run-state-store.js";
import {
  type MaintenanceRequest,
  extractMaintenanceRequest,
} from "../maintenance/maintenance-request.js";
import type { MaintenanceTargetStore } from "../maintenance/maintenance-target-store.js";
import { extractRestrictionRelease } from "../policy/restriction-release.js";
import { RelationLifecycleService } from "../relation/lifecycle-service.js";
import type { FailurePatternStore } from "../state/failure-pattern-store.js";
import { writeDualTrackHandoff } from "../state/handoff.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import type { ProposalStore } from "../state/proposal-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { runInteractionAgent } from "../verification/agent/run-interaction-agent.js";
import { runVerifierAgent } from "../verification/agent/run-verifier-agent.js";
import { detectProjectType } from "../verification/project-type.js";
import { checkRequiredArtifacts } from "../verification/required-artifacts.js";
import {
  type VerificationRefs,
  verificationArtifactName,
  verifyRun,
} from "../verification/verify-run.js";
import {
  WORKSPACE_UNSTABLE_ANNOTATION,
  type WorkspaceSnapshot,
  captureWorkspaceSnapshot,
  workspaceSnapshotChanged,
} from "../verification/workspace-stability.js";
import { mergeRunWorktree, worktreeHasChanges } from "../worktree/worktree.js";
import {
  buildHumanFeedbackRefs,
  captureGitDiff,
  captureGitDiffStat,
  mergeEvidence,
  runCollector,
  writeTurnHandoff,
} from "./artifacts.js";
import {
  type RunContextDeps,
  buildMemoryPacket,
  rebuildContext,
} from "./context.js";
import {
  buildHumanResumeContext,
  buildRetryContext,
  drainPolicyEscalation,
  executeTurn,
  hashNormalizedOutput,
  normalizeTurnOutput,
  watchProcess,
} from "./turn-execution.js";
import type {
  ActiveRun,
  ExecutionOutcome,
  GithubCredentialStore,
  GithubToolProvisioner,
  RunExecutionContext,
} from "./types.js";
import { validateRunWorkingState } from "./working-state-validation.js";
import {
  loopRuntime,
  resolveExecutableCard,
  resolveRuntimeAssemblyContext,
} from "./workspace.js";

export interface TurnLoopDeps extends RunContextDeps {
  runStateStore?: RunStateStore;
  eventBus?: IEventBus;
  supervisor: Supervisor;
  /** Backoff wait between retry turns; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Verification seam for tests; defaults to the real verifyRun. */
  verifyRunFn?: typeof verifyRun;
  /** Planner Agent for multi-turn task decomposition (optional). */
  planner?: PlannerService;
  loopWatchdog: {
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

export interface TurnLoopState {
  /** loop_id -> active run (same-loop runs are serial) */
  activeByLoop: Map<string, ActiveRun>;
  activeByRunId: Map<string, ActiveRun>;
  /** run_id -> suspended execution context (needs_human / budget_limited / paused) */
  suspended: Map<string, RunExecutionContext>;
  /** run_id -> context of a run currently inside the turn loop */
  executingContexts: Map<string, RunExecutionContext>;
  /** run_id -> the Process executing the current turn (for PATCH pause kill) */
  executingProcesses: Map<string, Process>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Release a resolved run's active registration + suspended context. */
export function releaseRun(runId: string, state: TurnLoopState): void {
  const active = state.activeByRunId.get(runId);
  if (active) {
    state.activeByRunId.delete(runId);
    state.activeByLoop.delete(active.loopId);
  }
  state.suspended.delete(runId);
}

/**
 * Set up the run (contract + assembly) and drive the turn loop. Setup
 * failures become a failed first turn so the crash still lands in the
 * ledger and the control-plane, like phase 1.
 */
export async function executeRun(
  active: ActiveRun,
  card: LoopCard,
  deps: TurnLoopDeps,
  state: TurnLoopState,
): Promise<void> {
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
    approvedToolCalls: [],
    taskPlan: null,
    workingState: null,
    waivedPhases: [],
    currentSubtaskIndex: 0,
    recentTurnOutputHashes: [],
    recentTurnDiffStatHashes: [],
    recentBlockerFingerprints: [],
    relation: null,
    maintenanceTarget: null,
  };
  try {
    const { card: executableCard, worktree } = await resolveExecutableCard(
      card,
      runId,
      { dataDir: deps.dataDir },
    );
    ctx.card = executableCard;
    ctx.workspaceEvidence = worktree
      ? {
          originPath: card.loop.workspace.path ?? "",
          worktreePath: worktree.path,
          branch: worktree.branch,
          baseSha: worktree.baseSha,
        }
      : null;
    // Planner Agent: decompose complex tasks into a multi-turn plan.
    let taskPlan: IntentContract["plan"];
    const task = executableCard.loop.handoff?.task;
    const runtime = executableCard.loop.runtime;
    if (deps.planner && task) {
      try {
        const plan = await deps.planner.planTask(task, {
          providerName: runtime?.provider as ProviderName | undefined,
          model: runtime?.model,
        });
        if (plan.subtasks.length > 1) {
          taskPlan = plan;
        }
      } catch {
        // Planner failure is non-fatal; fall back to no plan.
      }
    }
    ctx.contract = buildIntentContract(executableCard, {
      runId,
      source,
      plan: taskPlan,
    });
    // P5 意圖理解：card 開啟 intent_understanding.use_agent 時, 範本命中
    // 直接覆蓋 (已確認), 否則意圖理解 Agent 產生合約草案 (未確認, 走
    // 下方人工閘門)。agent 失敗回退確定性裝配, 不阻塞 run。
    if (executableCard.loop.intent_understanding?.use_agent) {
      try {
        const understood = await buildIntentContractWithUnderstanding(
          executableCard,
          { runId, source, plan: taskPlan },
          {
            supervisor: deps.supervisor,
            watchProcess: async (runId_, proc, opts) => {
              const result = await watchProcess(runId_, proc, {
                timeoutMs: opts.timeoutMs,
                deps,
                executingProcesses: state.executingProcesses,
              });
              return {
                ok: result.ok,
                finalText: result.finalText,
                error: result.error,
              };
            },
          },
        );
        if (understood) {
          ctx.contract = understood;
        }
      } catch (error) {
        console.warn(
          `[LoopRunService] intent understanding agent failed for run ${runId}, falling back to deterministic contract:`,
          error,
        );
      }
    }
    ctx.taskPlan = taskPlan ?? null;
    ctx.contractJson = JSON.stringify(ctx.contract, null, 2);
    // 装配即落盘合约快照 (不等首轮结束): 首轮在飞时被暂停、随后进程
    // 重启的 run, resume 仍能凭此 artifact 重建执行上下文。
    await deps.runLedgerStore.writeArtifact(
      runId,
      "intent-contract.json",
      ctx.contractJson,
    );
    if (ctx.workspaceEvidence) {
      // worktree 隔离证据: 原目录 / worktree 目录 / 分支 / 基线 SHA,
      // 供审计"这个 run 在哪里执行、从哪个基线拉取"。
      await deps.runLedgerStore.writeArtifact(
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
    const runtimeContext = await resolveRuntimeAssemblyContext(executableCard, {
      githubCredentialStore: deps.githubCredentialStore,
      githubToolProvisioner: deps.githubToolProvisioner,
    });
    if (active.relationId && deps.relationStore) {
      const relation = deps.relationStore.findById(active.relationId);
      if (relation) {
        ctx.relation = relation;
        runtimeContext.relation = relation;
        await deps.runLedgerStore.writeArtifact(
          runId,
          "relation.json",
          `${JSON.stringify(relation, null, 2)}\n`,
        );
      }
    }
    if (active.maintenanceId && deps.maintenanceTargetStore) {
      const target = deps.maintenanceTargetStore.findById(active.maintenanceId);
      if (target) {
        ctx.maintenanceTarget = target;
        runtimeContext.maintenanceTarget = target;
        await deps.runLedgerStore.writeArtifact(
          runId,
          "maintenance-target.json",
          `${JSON.stringify(target, null, 2)}\n`,
        );
      }
    }
    // 02 §3 memory packet: 失败模式账本 open 模式的摘要进装配
    // (04 单写者表: assembly 读 failure-patterns)。
    const memoryPacket = buildMemoryPacket(
      executableCard,
      deps.failurePatternStore,
    );
    if (memoryPacket) {
      runtimeContext.memoryPacket = memoryPacket.promptText;
      ctx.memoryPacketJson = memoryPacket.artifactJson;
    }
    // 02 §3 budget_remaining: 首轮即合约全量 (used_* 均为 0)。
    runtimeContext.budgetRemaining = ctx.contract.budget;
    // 阶段 3 装配消费：published / canary 的提案在此进入 RuntimeInput
    // （每次新 run 重新装配 → 发布后新 run 即生效，rollback 后回到旧行为）。
    ctx.input = assembleRuntimeInput(
      executableCard,
      ctx.contract,
      deps.proposalStore?.listProposals() ?? [],
      runtimeContext,
      ctx.turn,
    );
  } catch (error) {
    ctx.setupError = error instanceof Error ? error : new Error(String(error));
  }

  // P5 意圖閘門：agent 產生的合約未經人工確認 → 首輪執行前泊入
  // needs_human (turn 0 = 閘門, 尚未執行任何輪次; approve 後 continueRun
  // 以 turn 1 起步)。control-plane 未接線時 (phase-0) 無閘門可用,
  // 誠實跳過 —— 該模式本來就沒有 needs_human 語義。
  const understanding = ctx.contract?.intent_understanding;
  if (
    !ctx.setupError &&
    deps.controlPlane &&
    understanding?.generated_by === "agent" &&
    !understanding.confirmed_by_human
  ) {
    const applied = await deps.controlPlane.applyJudgment({
      loopId: ctx.active.loopId,
      runId,
      turn: 0,
      goalId: ctx.contract?.intent_id ?? `intent-${runId}`,
      workspaceRef: `workspace://${ctx.active.loopId}/${runId}`,
      executionOk: true,
      verificationRan: true,
      judgment: {
        overall: "passed",
        next_action: "needs_human",
        retryable: false,
        requires_human: true,
        evidence: [`artifact://${runId}/intent-contract.json`],
        unresolved_risks: [
          `意圖合約由意圖理解 Agent 產生, 未經人工確認: ${understanding.understanding_summary}`,
          ...understanding.clarification_questions.map(
            (question) => `待澄清: ${question}`,
          ),
        ],
      },
      judgmentRef: null,
      createdAt: ctx.active.createdAt,
      budget: ctx.contract?.budget ?? {
        max_tokens: 0,
        max_time_minutes: 1,
        max_turns: 1,
        max_retries: 0,
      },
      usage: { tokens: null, timeMinutes: 0 },
    });
    if (applied.state === "needs_human") {
      // 保留執行上下文 (turn 0 = 閘門輪, 未執行), approve 後 continueRun
      // 的 ctx.turn += 1 使首輪以 turn 1 起步續跑。
      ctx.turn = 0;
      state.suspended.set(runId, ctx);
      return;
    }
  }

  await runTurns(ctx, deps, state);
}

interface StagnationDetail {
  reason: "similar_output" | "no_diff_progress";
  threshold: number;
  detail: string;
  outputHash: string;
  diffStatHash: string;
}

/**
 * Escalate a retrying run to needs_human when loop stagnation is detected.
 * Writes a loop-stagnation artifact, mutates ctx.lastJudgment, and returns
 * the updated judgment.
 */
async function escalateToNeedsHumanForStagnation(
  ctx: RunExecutionContext,
  store: RunLedgerStore,
  artifactRefs: string[],
  judgment: JudgmentReport,
  info: StagnationDetail,
): Promise<JudgmentReport> {
  const { runId } = ctx.active;
  const stagnationReport = {
    run_id: runId,
    turn: ctx.turn,
    detected_at: new Date().toISOString(),
    reason: info.reason,
    threshold: info.threshold,
    output_hash: info.outputHash,
    diff_stat_hash: info.diffStatHash,
    note: `Loop is retrying without progress (${info.detail}); escalating to needs_human to avoid infinite loop.`,
  };
  const stagnationArtifactName = verificationArtifactName(
    "loop-stagnation.json",
    ctx.turn,
  );
  await store.writeArtifact(
    runId,
    stagnationArtifactName,
    `${JSON.stringify(stagnationReport, null, 2)}\n`,
  );
  artifactRefs.push(`artifact://${runId}/${stagnationArtifactName}`);
  const updated: JudgmentReport = {
    ...judgment,
    overall: "inconclusive",
    next_action: "needs_human",
    requires_human: true,
    retryable: false,
    evidence: [
      ...judgment.evidence,
      `artifact://${runId}/${stagnationArtifactName}`,
    ],
    unresolved_risks: [
      ...judgment.unresolved_risks,
      `loop stagnation: ${info.detail}`,
    ],
  };
  ctx.lastJudgment = updated;
  console.warn(
    `[LoopRunService] run ${runId} turn ${ctx.turn} stagnation detected: ${info.detail}, escalating to needs_human`,
  );
  return updated;
}

/**
 * The turn loop: execute → verify → control-plane judgment, repeat while
 * the decision is retry. Blocking states (needs_human / budget_limited)
 * suspend the context and keep the active registration; terminal states
 * release it (finally).
 */
export async function runTurns(
  ctx: RunExecutionContext,
  deps: TurnLoopDeps,
  state: TurnLoopState,
): Promise<void> {
  const { runId, loopId, createdAt } = ctx.active;
  const store = deps.runLedgerStore;
  let blocked = false;
  state.executingContexts.set(runId, ctx);
  const relationLifecycle =
    deps.relationLifecycle ??
    (deps.relationStore
      ? new RelationLifecycleService({ relationStore: deps.relationStore })
      : undefined);
  const sleep = deps.sleep ?? defaultSleep;
  const verify = deps.verifyRunFn ?? verifyRun;

  try {
    for (;;) {
      const turnStartedAt = Date.now();

      // 子任务索引不从轮次号推导: 推进由"已完成子任务数"驱动 (推进路径
      // 显式递增 / 重启重建时按 subtask_advance 决策计数), 与轮次号解耦。

      // learning_refs.human_feedback 在轮首快照 (见 buildHumanFeedbackRefs):
      const humanFeedbackRefs = await buildHumanFeedbackRefs(
        { runLedgerStore: deps.runLedgerStore },
        runId,
      );

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
        outcome = await executeTurn(ctx, deps, state.executingProcesses);
      }
      if (outcome.sessionRef !== "none") {
        ctx.sessionRef = outcome.sessionRef;
      }
      deps.eventBus?.emit({
        type: "turn-completed",
        loop_id: loopId,
        run_id: runId,
        turn: ctx.turn,
        session_ref: outcome.sessionRef,
        ok: outcome.ok,
        error: outcome.error,
        timestamp: new Date().toISOString(),
      });
      // One-shot restriction releases expire after the turn they were granted
      // for, whether or not the agent used them.
      ctx.approvedToolCalls = [];
      const timeMinutes = (Date.now() - turnStartedAt) / 60_000;

      // --- PATCH pause interception (主动暂停, 选项 A) ---
      if (deps.controlPlane?.currentStateOf(runId) === "paused") {
        blocked = true;
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
        state.suspended.set(runId, ctx);
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
      if (ctx.turn === 1 && ctx.memoryPacketJson) {
        await store.writeArtifact(
          runId,
          "memory-packet.json",
          ctx.memoryPacketJson,
        );
      }
      if (ctx.turn === 1 && ctx.input?.policyProjection) {
        await store.writeArtifact(
          runId,
          "policy-projection.json",
          JSON.stringify(ctx.input.policyProjection, null, 2),
        );
      }
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
              policy_projection: ctx.input.policyProjection ?? "not_applicable",
              observability: ctx.input.observability,
              budget_remaining: ctx.input.budgetRemaining ?? null,
              permission_bridge_ref: null,
            },
            null,
            2,
          )}\n`,
        );
      }
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

      const loopState = extractLoopState(outcome.finalText);
      if (loopState) {
        const candidate = {
          ...loopState,
          run_id: runId,
          turn: ctx.turn,
          updated_at: new Date().toISOString(),
        };
        const validation = await validateRunWorkingState(candidate);
        if (validation.verified) {
          ctx.workingState = candidate;
          await store.writeArtifact(
            runId,
            "working-state.json",
            `${JSON.stringify(ctx.workingState, null, 2)}\n`,
          );
        } else {
          console.warn(
            `[LoopRunService] run ${runId} turn ${ctx.turn} reported unverified working state: ${validation.issues.join("; ")}`,
          );
          const validationArtifact = `${JSON.stringify(
            {
              run_id: runId,
              turn: ctx.turn,
              verified_at: new Date().toISOString(),
              verified: false,
              issues: validation.issues,
              selected_subject: validation.selected_subject,
            },
            null,
            2,
          )}\n`;
          await store.writeArtifact(
            runId,
            "working-state-validation.json",
            validationArtifact,
          );
          artifactRefs.push(
            `artifact://${runId}/working-state-validation.json`,
          );
        }
      }

      let diffRef: string | null = null;
      const verificationWorkspacePath =
        ctx.workingState?.selected_subject?.clone_path ??
        ctx.card.loop.workspace.path;
      if (verificationWorkspacePath) {
        const diff = await captureGitDiff(verificationWorkspacePath);
        if (diff) {
          const diffName =
            ctx.turn === 1 ? "diff.patch" : `diff-turn${ctx.turn}.patch`;
          await store.writeArtifact(runId, diffName, diff);
          diffRef = `artifact://${runId}/${diffName}`;
          artifactRefs.push(diffRef);
        }
      }

      if (outcome.evidence) {
        outcome.evidence.has_diff = Boolean(diffRef);
        const required = ctx.card.loop.observability?.required_artifacts ?? [];
        outcome.evidence.has_required_artifacts = required.some((name) =>
          artifactRefs.some((ref) => ref.endsWith(`/${name}`)),
        );
        outcome.producedEvidence =
          outcome.evidence.has_final_text ||
          outcome.evidence.has_runtime_events ||
          outcome.evidence.has_diff ||
          outcome.evidence.has_required_artifacts;
      }

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

      const collector = ctx.card.loop.verification.review?.judge_only
        ? null
        : await runCollector(
            {
              supervisor: deps.supervisor,
              runLedgerStore: deps.runLedgerStore,
              watchProcess: async (runId_, proc, opts) => {
                const result = await watchProcess(runId_, proc, {
                  timeoutMs: opts.timeoutMs,
                  deps,
                  executingProcesses: state.executingProcesses,
                });
                return {
                  ok: result.ok,
                  finalText: result.finalText,
                  error: result.error,
                };
              },
            },
            ctx,
            outcome,
            `artifact://${runId}/${stdoutName}`,
          );
      if (collector) {
        if (collector.inputRef) {
          artifactRefs.push(collector.inputRef);
        }
        if (collector.outputRef) {
          artifactRefs.push(collector.outputRef);
        }
        if (collector.reportRef) {
          artifactRefs.push(collector.reportRef);
        }
      }

      // --- verification ---
      let verificationRefs: VerificationRefs = {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "not_applicable",
      };
      let verificationRan = false;
      let judgment: JudgmentReport | null = null;
      let judgmentRef: string | null = null;
      let verifierFailureTags: FailureTag[] = [];
      let missingFinalReport = false;
      let preVerifySnapshot: WorkspaceSnapshot | null = null;
      let skipExecutablePhases: {
        phase: "static" | "runtime";
        reason: string;
      }[] = [];

      const requiredPhases = ctx.card.loop.verification.required;
      if (
        requiredPhases.length > 0 &&
        ctx.contract &&
        verificationWorkspacePath
      ) {
        const policyIntentRef = ctx.input?.policyProjection
          ? `artifact://${runId}/policy-projection.json`
          : null;
        const knownFailurePatterns = (deps.failurePatternStore?.list() ?? [])
          .filter((pattern) => pattern.status === "open")
          .map((pattern) => pattern.pattern_id);
        const currentSubtask = ctx.taskPlan?.subtasks[ctx.currentSubtaskIndex];
        const nonCodeSubtask =
          currentSubtask?.target_artifacts.length === 0 &&
          (await detectProjectType(verificationWorkspacePath)) === "unknown" &&
          diffRef === null;
        if (nonCodeSubtask) {
          skipExecutablePhases = requiredPhases
            .filter(
              (phase): phase is "static" | "runtime" =>
                phase === "static" || phase === "runtime",
            )
            .map((phase) => ({
              phase,
              reason: "non-code subtask, no clone materialized",
            }));
        }
        for (const phase of requiredPhases) {
          if (
            (phase === "static" || phase === "runtime") &&
            ctx.waivedPhases.includes(phase) &&
            !skipExecutablePhases.some((item) => item.phase === phase)
          ) {
            skipExecutablePhases.push({
              phase,
              reason: "waived by human decision",
            });
          }
        }
        preVerifySnapshot =
          ctx.card.loop.workspace.strategy === "direct" &&
          verificationWorkspacePath
            ? await captureWorkspaceSnapshot(verificationWorkspacePath)
            : null;
        try {
          const reviewInChain = requiredPhases.includes("review");
          const interactionInChain = requiredPhases.includes("interaction");
          // P4: review 段由 Verifier Agent (read-only judge) 承載;
          // collector 報告只做證據合併 (下方 mergeEvidence), 不再充當
          // review verdict —— 修復計畫 #12 的 collector-as-review 路徑退役。
          const verification = await verify(
            {
              card: ctx.card,
              contract: ctx.contract,
              runId,
              turn: ctx.turn,
              workspacePath: verificationWorkspacePath,
              exitStatus: outcome.ok ? 0 : 1,
              stdoutRef: `artifact://${runId}/${stdoutName}`,
              diffRef,
              runtimeEventsRef,
              executorSummaryRef,
              permissionEventRefs,
              policyIntentRef,
              knownFailurePatterns,
              skipExecutablePhases,
            },
            {
              store,
              runInteractionAgent: interactionInChain
                ? (agentCtx) =>
                    runInteractionAgent(
                      {
                        supervisor: deps.supervisor,
                        runLedgerStore: store,
                        watchProcess: async (runId_, proc, opts) => {
                          const result = await watchProcess(runId_, proc, {
                            timeoutMs: opts.timeoutMs,
                            deps,
                            executingProcesses: state.executingProcesses,
                          });
                          return {
                            ok: result.ok,
                            finalText: result.finalText,
                            error: result.error,
                            usage: result.usage,
                          };
                        },
                      },
                      ctx,
                      agentCtx,
                    )
                : undefined,
              runReviewAgent: reviewInChain
                ? (agentCtx) =>
                    runVerifierAgent(
                      {
                        supervisor: deps.supervisor,
                        runLedgerStore: store,
                        eventBus: deps.eventBus,
                        watchProcess: async (runId_, proc, opts) => {
                          const result = await watchProcess(runId_, proc, {
                            timeoutMs: opts.timeoutMs,
                            deps,
                            executingProcesses: state.executingProcesses,
                          });
                          return {
                            ok: result.ok,
                            finalText: result.finalText,
                            error: result.error,
                            usage: result.usage,
                          };
                        },
                      },
                      ctx,
                      agentCtx,
                    )
                : undefined,
            },
          );
          verificationRefs = verification.refs;
          verificationRan = true;
          verifierFailureTags = verification.failureTags ?? [];
          // collector 報告恆作為證據合併進 judgment (不充當 verdict);
          // P4 前 review-in-chain 時不合併是怕重複計票 —— 現在 review
          // verdict 由 Verifier Agent 產出, collector 純證據, 恆合併。
          judgment = collector?.reportRef
            ? mergeEvidence(
                verification.judgment,
                [collector.reportRef],
                collector.report,
              )
            : verification.judgment;
          judgmentRef = verification.refs.judgment_report;
          if (collector?.reportRef) {
            await store.writeArtifact(
              runId,
              verificationArtifactName("judgment-report.json", ctx.turn),
              `${JSON.stringify(judgment, null, 2)}\n`,
            );
          }
        } catch (error) {
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
          verifierFailureTags = ["runtime_blackbox_error"];
        }
      }

      // --- direct 策略: 验证期间工作区稳定性标注 ---
      if (
        verificationRan &&
        judgment &&
        judgmentRef &&
        preVerifySnapshot &&
        verificationWorkspacePath
      ) {
        const postVerifySnapshot = await captureWorkspaceSnapshot(
          verificationWorkspacePath,
        );
        const verificationPassed =
          judgment.overall === "passed" && judgment.next_action === "complete";
        if (
          postVerifySnapshot &&
          workspaceSnapshotChanged(preVerifySnapshot, postVerifySnapshot) &&
          !verificationPassed
        ) {
          judgment = {
            ...judgment,
            evidence: [...judgment.evidence, WORKSPACE_UNSTABLE_ANNOTATION],
          };
          await store.writeArtifact(
            runId,
            verificationArtifactName("judgment-report.json", ctx.turn),
            `${JSON.stringify(judgment, null, 2)}\n`,
          );
        }
      }

      // --- observability.required_artifacts 校验 ---
      const requiredArtifacts = ctx.card.loop.observability?.required_artifacts;
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
          await store.writeArtifact(
            runId,
            verificationArtifactName("judgment-report.json", ctx.turn),
            `${JSON.stringify(judgment, null, 2)}\n`,
          );
        }
      }

      // Empty-output guard: a successful process that produced no text, no
      // runtime events, no diff, and none of the declared required artifacts
      // is not evidence of a completed task. Static lint passing must not
      // turn that into complete.
      if (outcome.ok && outcome.producedEvidence === false) {
        judgment = {
          overall: "inconclusive",
          next_action: "needs_human",
          retryable: false,
          requires_human: true,
          evidence: artifactRefs,
          unresolved_risks: [
            "executor produced no observable evidence (empty output, no diff, no required artifacts)",
          ],
        };
        verificationRan = true;
        judgmentRef = null;
        verifierFailureTags = ["verification_error"];
        await store.writeArtifact(
          runId,
          verificationArtifactName("judgment-report.json", ctx.turn),
          `${JSON.stringify(judgment, null, 2)}\n`,
        );
      }

      // Missing final report guard: a turn that ends with only an interim
      // sentence or tool output is not a deliverable. Retry automatically
      // instead of asking a human for a report the agent can still produce.
      if (
        outcome.ok &&
        outcome.finalText &&
        !extractExecutorSummary(outcome.finalText)
      ) {
        missingFinalReport = true;
        judgment = {
          overall: "failed",
          next_action: "retry",
          retryable: true,
          requires_human: false,
          evidence: artifactRefs,
          unresolved_risks: [
            "executor did not produce the required final report/executor summary; retrying the turn",
          ],
        };
        verificationRan = true;
        judgmentRef = null;
        verifierFailureTags = ["verification_error"];
        await store.writeArtifact(
          runId,
          verificationArtifactName("judgment-report.json", ctx.turn),
          `${JSON.stringify(judgment, null, 2)}\n`,
        );
      }

      // --- merge gate (worktree 策略 + modify) ---
      const taskPlan = ctx.taskPlan;
      const hasMoreSubtasks =
        taskPlan !== null &&
        ctx.currentSubtaskIndex + 1 < taskPlan.subtasks.length;
      if (
        outcome.ok &&
        judgment?.next_action === "complete" &&
        judgment.overall === "passed" &&
        !hasMoreSubtasks &&
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
        await store.writeArtifact(
          runId,
          verificationArtifactName("judgment-report.json", ctx.turn),
          `${JSON.stringify(judgment, null, 2)}\n`,
        );
      }
      ctx.lastJudgment = judgment;
      ctx.lastJudgmentRef = judgmentRef;

      // --- loop stagnation / idle / dead-loop detection ---
      const outputHash = hashNormalizedOutput(
        normalizeTurnOutput(outcome.finalText || outcome.error || ""),
      );
      const diffStat = verificationWorkspacePath
        ? ((await captureGitDiffStat(
            verificationWorkspacePath,
            ctx.workspaceEvidence?.baseSha,
          )) ?? "")
        : "";
      const diffStatHash = hashNormalizedOutput(diffStat);

      // A) identical output across turns
      if (
        !missingFinalReport &&
        outcome.ok &&
        judgment &&
        (judgment.next_action === "retry" ||
          judgment.next_action === "needs_human") &&
        deps.loopWatchdog.stagnationSimilarTurnsThreshold > 0
      ) {
        const threshold = deps.loopWatchdog.stagnationSimilarTurnsThreshold;
        const recent = ctx.recentTurnOutputHashes;
        if (
          recent.length >= threshold - 1 &&
          recent.slice(-(threshold - 1)).every((h) => h === outputHash)
        ) {
          judgment = await escalateToNeedsHumanForStagnation(
            ctx,
            store,
            artifactRefs,
            judgment,
            {
              reason: "similar_output",
              threshold,
              detail: `identical output for ${threshold} consecutive turns`,
              outputHash,
              diffStatHash,
            },
          );
        }
      }

      // B) no effective workspace change across retry turns (idle / spinning)
      if (
        !missingFinalReport &&
        outcome.ok &&
        judgment &&
        judgment.next_action === "retry" &&
        deps.loopWatchdog.idleNoProgressTurnsThreshold > 0
      ) {
        const threshold = deps.loopWatchdog.idleNoProgressTurnsThreshold;
        const recent = ctx.recentTurnDiffStatHashes;
        if (
          recent.length >= threshold - 1 &&
          recent.slice(-(threshold - 1)).every((h) => h === diffStatHash)
        ) {
          judgment = await escalateToNeedsHumanForStagnation(
            ctx,
            store,
            artifactRefs,
            judgment,
            {
              reason: "no_diff_progress",
              threshold,
              detail: `workspace diff stat unchanged for ${threshold} consecutive retry turns`,
              outputHash,
              diffStatHash,
            },
          );
        }
      }

      ctx.recentTurnOutputHashes.push(outputHash);
      if (
        ctx.recentTurnOutputHashes.length >
        deps.loopWatchdog.stagnationSimilarTurnsThreshold
      ) {
        ctx.recentTurnOutputHashes.shift();
      }
      ctx.recentTurnDiffStatHashes.push(diffStatHash);
      if (
        ctx.recentTurnDiffStatHashes.length >
        deps.loopWatchdog.idleNoProgressTurnsThreshold
      ) {
        ctx.recentTurnDiffStatHashes.shift();
      }

      // --- subtask-driven turn control ---
      const subtaskHadNoExecutableVerification =
        requiredPhases.length === 0 ||
        (skipExecutablePhases.length > 0 &&
          requiredPhases.every(
            (phase) =>
              phase === "interaction" ||
              skipExecutablePhases.some((item) => item.phase === phase),
          ));
      const subtaskPassed =
        outcome.ok &&
        (judgment?.overall === "passed" || subtaskHadNoExecutableVerification);
      const shouldAdvanceSubtask =
        taskPlan !== null &&
        subtaskPassed &&
        hasMoreSubtasks &&
        !judgment?.requires_human &&
        ctx.policyEscalations.length === 0;

      // --- control decision ---
      const restrictionRelease = extractRestrictionRelease(outcome.finalText);
      let finalStatus: RunState = outcome.ok ? "complete" : "failed";
      let retriesUsed = 0;
      let blockerFingerprint: string | undefined;
      let repeatedBlockerCount: number | undefined;
      if (deps.controlPlane && ctx.contract && shouldAdvanceSubtask) {
        finalStatus = "active";
      } else if (deps.controlPlane && ctx.contract) {
        const diffSummary = verificationWorkspacePath
          ? ((await captureGitDiffStat(
              verificationWorkspacePath,
              ctx.workspaceEvidence?.baseSha,
            )) ?? undefined)
          : undefined;
        const applied = await deps.controlPlane.applyJudgment({
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
          stopRules: ctx.contract.stop_rules,
          sessionRef: outcome.sessionRef,
          policyEscalation: drainPolicyEscalation(ctx, restrictionRelease),
          usage: {
            tokens: outcome.usage?.tokens ?? null,
            tokensUnavailable: outcome.usage === null,
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
          verifierFailureTags,
        });
        finalStatus = applied.state;
        retriesUsed = applied.budget.used_retries;
        blockerFingerprint = applied.entry.blocker_fingerprint;
        repeatedBlockerCount = applied.entry.repeated_blocker_count;
      } else if (deps.controlPlane && !ctx.contract) {
        const applied = await deps.controlPlane.applyJudgment({
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
          verifierFailureTags,
        });
        finalStatus = applied.state;
        blockerFingerprint = applied.entry.blocker_fingerprint;
        repeatedBlockerCount = applied.entry.repeated_blocker_count;
      } else if (verificationRan && judgment) {
        finalStatus =
          outcome.ok && judgment.overall === "passed" ? "complete" : "failed";
      }

      // --- dead-loop detection: same blocker recurring in needs_human ---
      if (
        finalStatus === "needs_human" &&
        blockerFingerprint &&
        repeatedBlockerCount !== undefined &&
        deps.loopWatchdog.repeatedBlockerThreshold > 0 &&
        repeatedBlockerCount >= deps.loopWatchdog.repeatedBlockerThreshold
      ) {
        console.warn(
          `[LoopRunService] run ${runId} turn ${ctx.turn} dead-loop detected: blocker ${blockerFingerprint} repeated ${repeatedBlockerCount} times, forcing failed`,
        );
        await deps.controlPlane?.failRun(
          runId,
          `dead loop: the same blocker (${blockerFingerprint}) recurred ${repeatedBlockerCount} times; forcing failed to avoid waiting forever for human`,
          { force: true },
        );
        finalStatus = "failed";
      }

      if (
        !ctx.relation &&
        deps.relationStore &&
        ctx.card.loop.discovery?.source === "github_prompt"
      ) {
        await relationLifecycle?.registerGithubPrPublish(
          loopId,
          runId,
          outcome.finalText,
        );
      }

      const handoffRef = await writeTurnHandoff(
        { runLedgerStore: deps.runLedgerStore },
        ctx,
        {
          collectorReportRef: collector?.reportRef ?? null,
          judgmentRef,
          evidenceRefs: judgment?.evidence ?? artifactRefs,
          blockerFingerprint,
          repeatedBlockerCount,
        },
      );
      artifactRefs.push(handoffRef);

      // Phase 6 dual-track handoff + checkpoint. The checkpoint is appended
      // after handoff artifacts so its manifest hash covers the full turn.
      if (deps.runStateStore && deps.controlPlane) {
        const runRecord = await deps.controlPlane.getRunState(loopId);
        if (runRecord && runRecord.run_id === runId) {
          const previousCheckpoint =
            await deps.runStateStore.latestCheckpoint(loopId);
          const workspaceSnapshot = verificationWorkspacePath
            ? await captureWorkspaceSnapshot(verificationWorkspacePath)
            : null;
          const dual = await writeDualTrackHandoff(
            { runLedgerStore: deps.runLedgerStore },
            ctx,
            {
              runStateRecord: runRecord,
              checkpointEventId: previousCheckpoint?.event_id ?? null,
              workspaceSnapshot,
              executionError: outcome.error ?? null,
              toolUsage: ctx.permissionEvents.map((event) => ({
                tool: event.tool,
                purpose: `${event.action} (${event.summary})`,
              })),
            },
          );
          artifactRefs.push(dual.humanReportRef, dual.machineStateRef);
          const artifactManifestHash = await store.artifactManifestHash(runId);
          await deps.runStateStore.appendCheckpoint(loopId, {
            run_id: runId,
            state: runRecord.state,
            turn: runRecord.turn,
            workspace_snapshot: workspaceSnapshot,
            artifact_manifest_hash: artifactManifestHash,
          });
        }
      }

      // --- per-turn ledger entry ---
      const adapterInfo = describeAdapter(loopRuntime(ctx.card)?.provider);
      const permissionMode = ctx.input?.permissionMode ?? "plan";
      const appliedNote = ctx.input?.appliedProposals?.length
        ? `;proposals=${ctx.input.appliedProposals.join("|")}`
        : "";
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
          memory_packet: ctx.memoryPacketJson
            ? `artifact://${runId}/memory-packet.json`
            : null,
          workspace: `workspace://${loopId}/${runId}`,
        },
        verification_refs: verificationRefs,
        learning_refs: {
          control_decision: `ledger://${runId}`,
          human_feedback: humanFeedbackRefs,
          external_feedback: [],
        },
        artifact_refs: artifactRefs,
        final_status: finalStatus,
        created_at: createdAt,
      };
      await store.appendEntry(runId, entry);
      if (finalStatus === "failed") {
        const failureTags = [...verifierFailureTags];
        if (outcome.adapterError) {
          const tag = adapterErrorCodeToFailureTag(outcome.adapterError.code);
          if (!failureTags.includes(tag)) {
            failureTags.push(tag);
          }
        }
        const postmortem = `${JSON.stringify(
          {
            run_id: runId,
            loop_id: loopId,
            state: finalStatus,
            turn: ctx.turn,
            failure_tags: failureTags,
            reason: outcome.error ?? "run failed without a turn error",
            created_at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`;
        await store.writeArtifact(runId, "postmortem.json", postmortem);
      }
      if (!deps.controlPlane && outcome.adapterError) {
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
      if (shouldAdvanceSubtask) {
        const completedTurn = ctx.turn;
        const completedSubtaskIndex = ctx.currentSubtaskIndex + 1;
        if (ctx.workingState && taskPlan) {
          const completedSubtask = taskPlan.subtasks[ctx.currentSubtaskIndex];
          if (completedSubtask) {
            ctx.workingState.subtask_status = [
              ...ctx.workingState.subtask_status.filter(
                (item) => item.id !== completedSubtask.id,
              ),
              {
                id: completedSubtask.id,
                status: "done",
                outputs: "subtask completed and verified",
              },
            ];
            await store.writeArtifact(
              runId,
              "working-state.json",
              `${JSON.stringify(ctx.workingState, null, 2)}\n`,
            );
          }
        }
        ctx.turn += 1;
        ctx.currentSubtaskIndex += 1;
        ctx.pendingContext = null;
        if (deps.controlPlane && ctx.contract) {
          const advanced = await deps.controlPlane.advanceSubtaskTurn(
            runId,
            loopId,
            ctx.turn,
            ctx.contract.budget,
            ctx.sessionRef,
            {
              completedTurn,
              subtaskIndex: completedSubtaskIndex,
              subtaskCount: taskPlan?.subtasks.length ?? 0,
              judgment,
              usage: {
                tokens: outcome.usage?.tokens ?? null,
                tokensUnavailable: outcome.usage === null,
                timeMinutes,
              },
            },
          );
          if (advanced.state === "budget_limited") {
            ctx.turn = completedTurn;
            ctx.pendingContext = null;
            blocked = true;
            state.suspended.set(runId, ctx);
            return;
          }
        }
        continue;
      }

      if (finalStatus === "retry") {
        const backoff = retryBackoffMs(retriesUsed);
        console.log(
          `[LoopRunService] run ${runId} retry #${retriesUsed} in ${backoff}ms`,
        );
        await sleep(backoff);
        ctx.turn += 1;
        ctx.pendingContext = buildRetryContext(ctx.turn, judgment, judgmentRef);
        const begin = await deps.controlPlane?.beginTurn(runId, ctx.turn);
        if (begin && !begin.ok) {
          blocked = true;
          state.suspended.set(runId, ctx);
          return;
        }
        continue;
      }

      const status = finalStatus as RunState;
      if (
        status === "needs_human" ||
        status === "budget_limited" ||
        status === "paused"
      ) {
        // needs_human 是挂起而非终态：run 停在原地等人工决策，下面的终态
        // 回写不会执行。relation 必须同步转 needs_human，否则它会一直显示
        // fixing（假活），人工也无从得知该去 run 详情页做决策。
        // continueRun 恢复时会把 relation 转回 fixing。
        if (status === "needs_human" && ctx.relation && deps.relationStore) {
          const current = deps.relationStore.findById(ctx.relation.relation_id);
          if (current && current.state === "fixing") {
            await relationLifecycle?.transition(
              current.relation_id,
              "needs_human",
              {
                needs_human_reason: `run ${runId} awaits a human decision (POST /api/runs/${runId}/decision)`,
              },
              {
                event: "run_needs_human",
                message: `relation run ${runId} parked at needs_human`,
              },
            );
          }
        }
        blocked = true;
        state.suspended.set(runId, ctx);
        return;
      }

      if (ctx.relation && deps.relationStore) {
        const current = deps.relationStore.findById(ctx.relation.relation_id);
        if (current) {
          const toState =
            status === "complete" ? "awaiting_feedback" : "needs_human";
          await relationLifecycle?.transition(
            current.relation_id,
            toState,
            {
              ...(status !== "complete"
                ? { needs_human_reason: `relation run ended as ${status}` }
                : {}),
            },
            {
              event: status === "complete" ? "run_complete" : "run_failed",
              message: `relation run ${runId} ended as ${status}`,
            },
          );
        }
      }
      if (ctx.maintenanceTarget && deps.maintenanceTargetStore) {
        const current = deps.maintenanceTargetStore.findById(
          ctx.maintenanceTarget.target_id,
        );
        if (current) {
          const failed = status !== "complete";
          await deps.maintenanceTargetStore.updateState(
            current.target_id,
            failed ? "needs_human" : "waiting",
            {
              ...(failed
                ? {
                    repair_count: current.repair_count + 1,
                    context_payload: {
                      ...current.context_payload,
                      last_maintenance_status: status,
                    },
                  }
                : {}),
            },
          );
        }
      } else if (
        status === "complete" &&
        deps.maintenanceTargetStore &&
        ctx.card.loop.discovery?.source !== "github_prompt"
      ) {
        const request = extractMaintenanceRequest(outcome.finalText);
        if (request) {
          await registerMaintenanceTarget(
            loopId,
            runId,
            request,
            deps.maintenanceTargetStore,
          );
        }
      }
      return;
    }
  } catch (error) {
    console.error(`[LoopRunService] run ${runId} failed:`, error);
  } finally {
    state.executingContexts.delete(runId);
    if (!blocked) {
      state.activeByLoop.delete(loopId);
      state.activeByRunId.delete(runId);
      state.suspended.delete(runId);
    }
  }
}

async function registerMaintenanceTarget(
  loopId: string,
  runId: string,
  request: MaintenanceRequest,
  store: MaintenanceTargetStore,
): Promise<void> {
  const targetId = maintenanceTargetId(loopId, request);
  const existing = store.findById(targetId);
  if (existing && existing.state !== "done") {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    ...(existing ?? {
      state: "waiting",
      feedback_cursor: {},
      feedback_count: 0,
      repair_count: 0,
      created_at: now,
    }),
    target_id: targetId,
    loop_id: loopId,
    target_type: request.target_type,
    external_ref: request.external_ref,
    wake_policy: request.wake_policy,
    context_payload: {
      ...request.context_payload,
      registered_by_run: runId,
    },
    updated_at: now,
  });
}

function maintenanceTargetId(
  loopId: string,
  request: MaintenanceRequest,
): string {
  const source = String(request.external_ref.source ?? "");
  const subjectId = String(request.external_ref.subject_id ?? "");
  const digest = createHash("sha1")
    .update(`${source}:${subjectId}`)
    .digest("hex")
    .slice(0, 12);
  return `mt-${loopId}-${digest}`;
}

/**
 * Continue a suspended run after a ResumeSignal (human approve /
 * request_changes, resume signal, budget supplemented): advance the turn,
 * inject the human response (and the previous judgment) as context, run
 * the pre-turn budget check, and re-enter the turn loop. The next
 * executeTurn starts a fresh provider session from the AU2 handoff. After
 * a server restart the context is rebuilt from the stores.
 */
export async function continueRun(
  signal: ResumeSignal,
  deps: TurnLoopDeps,
  state: TurnLoopState,
): Promise<void> {
  const controlPlane = deps.controlPlane;
  if (!controlPlane) {
    return;
  }
  let ctx = state.suspended.get(signal.runId) ?? null;
  if (!ctx) {
    ctx = await rebuildContext(signal, deps);
    if (!ctx) {
      console.error(
        `[LoopRunService] cannot continue run ${signal.runId}: no suspended context and rebuild failed`,
      );
      return;
    }
    // Re-register: a rebuilt run was not tracked in this process.
    if (!state.activeByRunId.has(signal.runId)) {
      state.activeByLoop.set(signal.loopId, ctx.active);
      state.activeByRunId.set(signal.runId, ctx.active);
    }
  }
  ctx.approvedToolCalls = signal.approvedToolCall
    ? [signal.approvedToolCall]
    : [];

  // run 恢复执行：若 relation 因 run 挂起被同步成 needs_human（见下方
  // 终态回写段的注释），现在转回 fixing。人工在 run 决策里选择继续，
  // 就等于宣告这条 relation 的修复重新在飞。
  if (ctx.relation && deps.relationStore) {
    const current = deps.relationStore.findById(ctx.relation.relation_id);
    if (current && current.state === "needs_human") {
      const lifecycle =
        deps.relationLifecycle ??
        new RelationLifecycleService({ relationStore: deps.relationStore });
      await lifecycle.transition(
        current.relation_id,
        "fixing",
        { needs_human_reason: undefined },
        {
          event: "run_resumed",
          message: `relation run ${signal.runId} resumed by human decision`,
        },
      );
    }
  }

  // --- 合并闸门批准 ---
  if (signal.cause === "human_approve") {
    const gateJson = await deps.runLedgerStore.readArtifact(
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
        await deps.runLedgerStore.writeArtifact(
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
        releaseRun(signal.runId, state);
        return;
      }
    }
  }

  // P5 意圖閘門: 人工 approve 視為確認 agent 合約 —— 翻轉
  // confirmed_by_human 並回寫合約快照, 後續重啟重建不再重複進閘門。
  if (
    signal.cause === "human_approve" &&
    ctx.contract?.intent_understanding?.generated_by === "agent" &&
    !ctx.contract.intent_understanding.confirmed_by_human
  ) {
    ctx.contract = {
      ...ctx.contract,
      intent_understanding: {
        ...ctx.contract.intent_understanding,
        confirmed_by_human: true,
      },
    };
    ctx.contractJson = JSON.stringify(ctx.contract, null, 2);
    await deps.runLedgerStore.writeArtifact(
      signal.runId,
      "intent-contract.json",
      ctx.contractJson,
    );
  }

  const restartRecoveryActive =
    signal.cause === "restart_recovery_approve" &&
    signal.restartRecoveryFromState === "active";
  if (restartRecoveryActive) {
    // An active run's checkpoint points at the turn to execute; approval
    // resumes that same turn instead of skipping it.
    ctx.pendingContext = null;
  } else {
    if (signal.waivedPhases?.length) {
      ctx.waivedPhases = Array.from(
        new Set([...ctx.waivedPhases, ...signal.waivedPhases]),
      );
    }
    if (signal.advanceSubtask && ctx.taskPlan) {
      ctx.currentSubtaskIndex = Math.min(
        ctx.currentSubtaskIndex + 1,
        ctx.taskPlan.subtasks.length - 1,
      );
    }
    ctx.turn += 1;
    const resumeContext = buildHumanResumeContext(
      signal,
      ctx.lastJudgment,
      ctx.lastJudgmentRef,
    );
    ctx.pendingContext = resumeContext;
  }
  const begin = await controlPlane.beginTurn(signal.runId, ctx.turn);
  if (!begin.ok) {
    state.suspended.set(signal.runId, ctx);
    return;
  }
  state.suspended.delete(signal.runId);
  await runTurns(ctx, deps, state);
}

/**
 * Resume runs that were active or retrying when the server restarted.
 * If the execution context cannot be rebuilt or the resumed run crashes
 * before producing a judgment, the run is forced to `failed` so it does not
 * stay stuck in `active`/`retry` after the restart.
 */
export async function resumeAfterRestart(
  loopId: string,
  deps: TurnLoopDeps,
  state: TurnLoopState,
): Promise<void> {
  const controlPlane = deps.controlPlane;
  if (!controlPlane) {
    return;
  }
  const runState = await controlPlane.getRunState(loopId);
  if (!runState) {
    return;
  }
  if (runState.state !== "active" && runState.state !== "retry") {
    return;
  }

  const recoveryReason = await findRestartRecoveryReason(
    deps,
    loopId,
    runState,
  );
  if (recoveryReason) {
    console.warn(
      `[LoopRunService] run ${runState.run_id} for loop '${loopId}' requires restart confirmation: ${recoveryReason}`,
    );
    await controlPlane.requestRestartRecovery(loopId, recoveryReason);
    return;
  }

  const signal: ResumeSignal = {
    runId: runState.run_id,
    loopId,
    cause: "resume_signal",
  };
  const ctx = await rebuildContext(signal, deps);
  if (!ctx) {
    console.warn(
      `[LoopRunService] cannot resume run ${runState.run_id} for loop '${loopId}' after restart: context rebuild failed`,
    );
    await controlPlane.failRun(
      runState.run_id,
      `restart recovery failed: execution context could not be rebuilt for ${runState.state} run at turn ${runState.turn}`,
    );
    return;
  }

  state.activeByLoop.set(loopId, ctx.active);
  state.activeByRunId.set(ctx.active.runId, ctx.active);

  if (runState.state === "retry") {
    ctx.turn += 1;
    ctx.pendingContext = buildRetryContext(
      ctx.turn,
      ctx.lastJudgment,
      ctx.lastJudgmentRef,
    );
    const begin = await controlPlane.beginTurn(ctx.active.runId, ctx.turn);
    if (!begin.ok) {
      state.suspended.set(ctx.active.runId, ctx);
      return;
    }
  } else {
    ctx.turn = runState.turn;
    ctx.pendingContext = null;
  }

  void runTurns(ctx, deps, state).catch(async (error) => {
    console.error(
      `[LoopRunService] resumed run ${ctx.active.runId} crashed after restart:`,
      error,
    );
    await controlPlane.failRun(
      ctx.active.runId,
      `resumed ${runState.state} run crashed after restart: ${error instanceof Error ? error.message : String(error)}`,
    );
    releaseRun(ctx.active.runId, state);
  });
}

/** Returns a reason string when a restart should ask the human first. */
async function findRestartRecoveryReason(
  deps: TurnLoopDeps,
  loopId: string,
  runState: import("@yep-anywhere/shared").RunStateRecord,
): Promise<string | null> {
  if (!deps.runStateStore) {
    return null; // Legacy test wiring: keep previous auto-resume behavior.
  }
  const checkpoint = await deps.runStateStore.latestCheckpoint(loopId);
  if (!checkpoint) {
    return `no checkpoint found for ${runState.state} run at turn ${runState.turn}`;
  }
  const sameRun = checkpoint.run_id === runState.run_id;
  const sameState =
    checkpoint.state === runState.state ||
    (checkpoint.state === "active" && runState.state === "active");
  const sameTurn =
    checkpoint.turn === runState.turn ||
    (checkpoint.state === "active" &&
      runState.state === "active" &&
      checkpoint.turn === runState.turn - 1);
  if (!sameRun || !sameState || !sameTurn) {
    return `checkpoint does not match persisted ${runState.state} state (checkpoint run=${checkpoint.run_id}, state=${checkpoint.state}, turn=${checkpoint.turn})`;
  }
  const integrity = await deps.runLedgerStore.verifyArtifactIntegrity(
    runState.run_id,
  );
  if (!integrity.ok) {
    return `external artifact mismatch: ${integrity.mismatches
      .map((item) => item.name)
      .join(", ")}`;
  }
  const stored = deps.loopCardStore.getLoop(loopId);
  const workspacePath = stored?.card.loop.workspace.path;
  if (workspacePath && checkpoint.workspace_snapshot) {
    const current = await captureWorkspaceSnapshot(workspacePath);
    if (
      current &&
      workspaceSnapshotChanged(checkpoint.workspace_snapshot, current)
    ) {
      return "workspace changed since the last checkpoint";
    }
  }
  return null;
}
