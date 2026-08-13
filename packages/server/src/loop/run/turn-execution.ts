/**
 * Per-turn execution: start a fresh session for every loop turn, watch the
 * process, and collect the ExecutionOutcome. State is carried into the fresh
 * session through the standing runtime prompt plus the Phase 6 AU2 handoff
 * artifacts (human-report.md / machine-state.json).
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import { createHash } from "node:crypto";
import {
  type IntentContract,
  type JudgmentReport,
  type LoopCard,
  MachineStateSchema,
  type TaskPlan,
} from "@yep-anywhere/shared";
import type { ProviderName } from "@yep-anywhere/shared";
import { AdapterError, toAdapterError } from "../../sdk/adapter-error.js";
import type { Process } from "../../supervisor/Process.js";
import type { Supervisor } from "../../supervisor/Supervisor.js";
import type { QueueFullResponse } from "../../supervisor/Supervisor.js";
import type { QueuedResponse } from "../../supervisor/WorkerQueue.js";
import { resolveAdapterPolicy } from "../assembly/adapter-policy.js";
import type { ResumeSignal } from "../control-plane/control-plane.js";
import {
  type PermissionEvent,
  createLoopToolApprovalHook,
} from "../policy/approval-hook.js";
import { runPolicyReviewAgent } from "../policy/reviewer.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import type { ExecutionOutcome, RunExecutionContext } from "./types.js";
import { isGitHubManagedLoop, loopRuntime } from "./workspace.js";

export interface TurnExecutionDeps {
  supervisor: Supervisor;
  runLedgerStore: RunLedgerStore;
  loopWatchdog: {
    turnIdleTimeoutMs: number;
    turnIdleCheckIntervalMs: number;
  };
}

/** Direct-mode write allowlist. GitHub-managed workspaces own the whole clone. */
export function resolveDirectWriteAllowlist(
  card: LoopCard,
  contract: IntentContract | null,
): string[] | undefined {
  if (card.loop.workspace.strategy !== "direct") {
    return undefined;
  }
  if (isGitHubManagedLoop(card)) {
    return ["."];
  }
  return contract?.target?.files ?? [];
}

/**
 * Normalize turn output for stagnation detection.
 *
 * Removes whitespace, common volatile tokens (ISO timestamps, UUIDs, random
 * hex ids) so that semantically identical reports do not produce different
 * hashes just because they embed a fresh timestamp.
 */
export function normalizeTurnOutput(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TS>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<UUID>",
    )
    .replace(/\b0x[0-9a-f]+\b/gi, "<HEX>")
    .trim()
    .toLowerCase();
}

export function hashNormalizedOutput(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function providerErrorMessage(message: unknown): string {
  if (message instanceof Error) {
    return message.message;
  }
  if (typeof message === "string") {
    return message;
  }
  if (message && typeof message === "object") {
    const fields = message as { error?: unknown; message?: unknown };
    for (const value of [fields.error, fields.message]) {
      if (value instanceof Error) {
        return value.message;
      }
      if (typeof value === "string") {
        return value;
      }
      if (value && typeof value === "object" && "message" in value) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === "string") {
          return nested;
        }
      }
    }
  }
  return String(message);
}

/** Retry = 证据传递：the next turn gets the previous judgment verbatim. */
export function buildRetryContext(
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

/** Next subtask context injected into the prompt when a planner plan is active. */
export function buildNextSubtaskContext(
  nextSubtaskIndex: number,
  taskPlan: TaskPlan | null,
): string {
  if (!taskPlan || nextSubtaskIndex >= taskPlan.subtasks.length) {
    return "Continue the loop task and finish with a text report.";
  }
  const subtask = taskPlan.subtasks[nextSubtaskIndex];
  if (!subtask) {
    return "Continue the loop task and finish with a text report.";
  }
  const lines = [
    `This is turn ${nextSubtaskIndex + 1} of a multi-turn loop run. The task was decomposed by the planner into ${taskPlan.subtasks.length} subtasks.`,
    "",
    "Overall plan:",
    ...taskPlan.subtasks.map((s) => `- ${s.id}: ${s.description}`),
    "",
    `Current subtask (${subtask.id}):`,
    `- Description: ${subtask.description}`,
    "- Success criteria:",
    ...subtask.success_criteria.map((c) => `  - ${c}`),
    ...(subtask.target_artifacts.length > 0
      ? [
          "- Target artifacts:",
          ...subtask.target_artifacts.map((a) => `  - ${a}`),
        ]
      : []),
    "",
    "Important: this turn must only complete the current subtask. Do not start or finish later subtasks. Report which subtask was completed and what remains in the executor summary.",
  ];
  return lines.join("\n");
}

/**
 * Drain the current turn's policy escalations into the applyJudgment input.
 * The first escalation carries the decision; additional blocks of the same
 * turn are summarized (each block already has its own policy_blocked
 * decision-ledger entry from the hook).
 */
export function drainPolicyEscalation(
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
export function buildHumanResumeContext(
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

function turnSuffixedArtifactName(base: string, turn: number): string {
  if (turn <= 1) {
    return base;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return `${base}-turn${turn}`;
  }
  return `${base.slice(0, dot)}-turn${turn}${base.slice(dot)}`;
}

function artifactRef(runId: string, name: string): string {
  return `artifact://${runId}/${name}`;
}

function turnHandoffRefs(raw: string | undefined): {
  judgment_ref?: string | null;
  collector_report_ref?: string | null;
  evidence_refs?: string[];
} | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      judgment_ref?: unknown;
      collector_report_ref?: unknown;
      evidence_refs?: unknown;
    };
    return {
      judgment_ref:
        typeof parsed.judgment_ref === "string" ? parsed.judgment_ref : null,
      collector_report_ref:
        typeof parsed.collector_report_ref === "string"
          ? parsed.collector_report_ref
          : null,
      evidence_refs: Array.isArray(parsed.evidence_refs)
        ? parsed.evidence_refs.filter(
            (ref): ref is string => typeof ref === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

function machineStateProjection(raw: string | undefined): string {
  if (!raw) {
    return "not_available";
  }
  try {
    const parsed = MachineStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return `unparseable machine-state.json: ${parsed.error.message}`;
    }
    const machine = parsed.data;
    return [
      `run_id=${machine.run_id}`,
      `turn=${machine.turn}`,
      `state=${machine.record.state}`,
      `artifact_manifest=${machine.artifact_manifest_ref}`,
      `checkpoint_event_id=${machine.checkpoint_event_id ?? "null"}`,
      `workspace_snapshot=${JSON.stringify(machine.workspace_snapshot ?? null)}`,
      `budget=${JSON.stringify(machine.record.budget ?? null)}`,
    ].join("\n");
  } catch {
    return "unparseable machine-state.json";
  }
}

function previousJudgmentSummary(
  ctx: RunExecutionContext,
  handoffRefs: ReturnType<typeof turnHandoffRefs>,
): string {
  const ref = ctx.lastJudgmentRef ?? handoffRefs?.judgment_ref ?? null;
  if (!ctx.lastJudgment) {
    return `overall=unknown; next_action=unknown; ref=${ref ?? "not_available"}`;
  }
  return `overall=${ctx.lastJudgment.overall}; next_action=${ctx.lastJudgment.next_action}; requires_human=${ctx.lastJudgment.requires_human}; ref=${ref ?? "not_available"}`;
}

/**
 * Build the prompt for a loop turn. Turn 1 uses the assembled runtime input
 * unchanged. Later turns reuse that standing task brief and add the Phase 6
 * dual-track handoff so a fresh provider session can continue without
 * inheriting the previous transcript.
 */
export async function buildLoopTurnStartPrompt(
  ctx: RunExecutionContext,
  store: RunLedgerStore,
): Promise<string> {
  if (!ctx.input) {
    return "Continue the loop task and finish with a text report.";
  }
  const base = ctx.input.prompt;
  if (ctx.turn <= 1 && !ctx.taskPlan) {
    return base;
  }

  const { runId } = ctx.active;
  const previousTurn = Math.max(1, ctx.turn - 1);
  const humanReportName = "human-report.md";
  const machineStateName = "machine-state.json";
  const turnHandoffName = turnSuffixedArtifactName(
    "turn-handoff.json",
    previousTurn,
  );
  const executorSummaryName = turnSuffixedArtifactName(
    "executor-summary.md",
    previousTurn,
  );
  const runtimeEventsName = turnSuffixedArtifactName(
    "runtime-events.jsonl",
    previousTurn,
  );

  const [humanReport, machineState, turnHandoff, executorSummary] =
    await Promise.all([
      store.readArtifact(runId, humanReportName),
      store.readArtifact(runId, machineStateName),
      store.readArtifact(runId, turnHandoffName),
      store.readArtifact(runId, executorSummaryName),
    ]);
  const handoffRefs = turnHandoffRefs(turnHandoff);
  const judgmentSummary = previousJudgmentSummary(ctx, handoffRefs);

  const lines = [
    "",
    "## Loop turn handoff (fresh session)",
    `- current_turn: ${ctx.turn}`,
    `- previous_turn: ${previousTurn}`,
    `- handoff_available: ${humanReport && machineState ? "true" : "false"}`,
    `- human_report: ${artifactRef(runId, humanReportName)}`,
    `- machine_state: ${artifactRef(runId, machineStateName)}`,
    `- turn_handoff: ${artifactRef(runId, turnHandoffName)}`,
    `- previous_judgment: ${judgmentSummary}`,
    `- previous_executor_summary: ${artifactRef(runId, executorSummaryName)}`,
    `- previous_runtime_events: ${artifactRef(runId, runtimeEventsName)}`,
    "",
    "### AU2 human report",
    humanReport ?? "(previous AU2 human report not available)",
    "",
    "### Machine state projection",
    machineStateProjection(machineState),
    "",
    "### Previous executor summary",
    executorSummary ?? "(previous executor summary not available)",
    "",
    "### Turn-specific instruction",
    ctx.pendingContext ??
      "Continue the loop task and finish with a text report.",
  ];

  if (ctx.taskPlan) {
    lines.push(
      "",
      "### Current subtask",
      buildNextSubtaskContext(ctx.currentSubtaskIndex, ctx.taskPlan),
    );
  }

  return `${base}\n\n${lines.join("\n")}`;
}

/**
 * Execute one turn. Every loop turn starts a fresh provider session; the
 * standing prompt plus AU2 handoff supplies the context that an interactive
 * resume would otherwise have inherited from the old transcript.
 */
export async function executeTurn(
  ctx: RunExecutionContext,
  deps: TurnExecutionDeps,
  executingProcesses: Map<string, Process>,
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
  const runtimeInput = ctx.input;
  const prompt = await buildLoopTurnStartPrompt(ctx, deps.runLedgerStore);
  ctx.pendingContext = null;
  const message = { text: prompt, mode: runtimeInput.permissionMode };

  // Policy projection (05 阶段 2): when the card declared a policy, the
  // per-turn approval hook is the canUseTool rule source — self-approvals
  // are audited to the decision ledger, hard gates are blocked and
  // collected as escalations (drained into applyJudgment after the turn).
  // Legacy read-only runs (no policy) pass no hook: permissionMode "plan"
  // + deny rules + auto-deny watcher, exactly as phase 0/1.
  ctx.policyEscalations = [];
  ctx.permissionEvents = [];
  const directWriteAllowlist = resolveDirectWriteAllowlist(
    ctx.card,
    ctx.contract,
  );
  const toolApprovalHook = runtimeInput.policyProfile
    ? createLoopToolApprovalHook({
        profile: runtimeInput.policyProfile,
        runId: ctx.active.runId,
        loopId: ctx.active.loopId,
        turn: ctx.turn,
        workspacePath: runtimeInput.cwd,
        store: deps.runLedgerStore,
        escalations: ctx.policyEscalations,
        permissionEvents: ctx.permissionEvents,
        directWriteAllowlist,
        relation: ctx.relation,
        contract: ctx.contract,
        policyReviewer: (request) =>
          runPolicyReviewAgent(
            {
              supervisor: deps.supervisor,
              runLedgerStore: deps.runLedgerStore,
            },
            {
              card: ctx.card,
              contract: ctx.contract,
              input: runtimeInput,
              runId: ctx.active.runId,
              loopId: ctx.active.loopId,
              turn: ctx.turn,
            },
            request,
          ),
      })
    : undefined;
  // adapter_policy 消费 (修复计划 #13): published / canary 的
  // runtime_adapter_proposal 经装配带上 RuntimeInput.adapterPolicy,
  // 这里解析成真实旋钮 —— model 覆盖进 session settings,
  // timeout_seconds 进 watchProcess 的轮次超时 (02 §3: adapter 调用
  // 必须带超时)。
  const adapterPolicy = resolveAdapterPolicy(runtimeInput.adapterPolicy);
  const sessionSettings = {
    permissions: runtimeInput.permissions,
    toolApprovalHook,
    env: runtimeInput.env,
    providerName: loopRuntime(ctx.card)?.provider as ProviderName | undefined,
    model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
  };

  let result: Process | QueuedResponse | QueueFullResponse;
  try {
    result = await deps.supervisor.startSession(
      runtimeInput.cwd,
      message,
      runtimeInput.permissionMode,
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
  executingProcesses.set(ctx.active.runId, proc);
  return watchProcess(ctx.active.runId, proc, {
    timeoutMs:
      adapterPolicy.timeoutMs ??
      (ctx.input.nativeInvocation.timeout_seconds
        ? ctx.input.nativeInvocation.timeout_seconds * 1000
        : undefined),
    deps,
    executingProcesses,
  });
}

export interface WatchProcessOptions {
  timeoutMs?: number;
  deps: TurnExecutionDeps;
  executingProcesses: Map<string, Process>;
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
export async function watchProcess(
  runId: string,
  proc: Process,
  opts: WatchProcessOptions,
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
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (idleCheckTimer) {
        clearInterval(idleCheckTimer);
      }
      unsubscribe();
      opts.executingProcesses.delete(runId);
      // Free the worker slot; the session jsonl stays on disk for audit, and
      // later loop turns start fresh sessions from the AU2 handoff.
      void proc.abort().catch(() => {});
      const hasMeaningfulRuntimeEvents = runtimeEvents.some((entry) => {
        const message = (entry as { message?: { type?: string } }).message;
        return message?.type !== "result";
      });
      resolve({
        ok,
        finalText,
        sessionRef: proc.sessionId,
        error,
        usage: tokens === null ? null : { tokens },
        adapterError,
        runtimeEvents,
        evidence: {
          has_final_text: finalText.trim().length > 0,
          has_runtime_events: hasMeaningfulRuntimeEvents,
          has_diff: false,
          has_required_artifacts: false,
        },
        producedEvidence:
          finalText.trim().length > 0 || hasMeaningfulRuntimeEvents,
      });
    };

    // Heartbeat to avoid Claude CLI's SessionIdleManager 300s timeout.
    // Send a lightweight message every 4 minutes to keep the session alive.
    // This is a workaround for Claude Code's hardcoded idle timeout.
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
    const startHeartbeat = () => {
      heartbeatTimer = setInterval(() => {
        if (settled) return;
        const heartbeatMessage = {
          text: "Heartbeat: still working on the task. Please continue.",
        };
        const result = proc.queueMessage(heartbeatMessage);
        if (!result.success) {
          // If queueMessage fails (e.g., process terminated), stop the heartbeat.
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    };
    startHeartbeat();

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

    // Idle watchdog: kill the turn if the process produces no events for a
    // configurable timeout. Unlike a hard wall-clock timeout, this only
    // triggers when the executor is truly stuck (no output, no file reads,
    // no progress). 0 disables idle detection.
    let idleCheckTimer: NodeJS.Timeout | undefined;
    const idleTimeoutMs = opts.deps.loopWatchdog.turnIdleTimeoutMs;
    const idleCheckIntervalMs = opts.deps.loopWatchdog.turnIdleCheckIntervalMs;
    let lastActivityAt = Date.now();
    if (idleTimeoutMs > 0) {
      idleCheckTimer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastActivityAt > idleTimeoutMs) {
          adapterError = new AdapterError(
            "timeout",
            `turn idle timeout: no process activity for ${idleTimeoutMs}ms`,
          );
          settle(false, adapterError.message);
        }
      }, idleCheckIntervalMs);
      idleCheckTimer.unref();
    }

    const unsubscribe = proc.subscribe((event) => {
      if (event.type === "message") {
        lastActivityAt = Date.now();
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
              message.subtype !== "success") ||
            adapterError !== undefined;
          settle(
            !isError,
            adapterError
              ? adapterError.message
              : isError
                ? `agent result: ${String(message.subtype)}`
                : undefined,
          );
        } else if (message.type === "error") {
          adapterError = toAdapterError(
            new Error(providerErrorMessage(message)),
            { operation: "turn/stream" },
          );
          settle(false, adapterError.message);
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
