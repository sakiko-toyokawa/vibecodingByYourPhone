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
 *  - Budget: the contract's budget (max_turns 含首轮 / max_retries 不含首轮,
 *    先触者停) is passed to the control-plane every turn together with the
 *    turn's measured consumption (wall-clock minutes; tokens from the
 *    adapter result message's usage, 02 §4 — null when the runtime does
 *    not expose it, never fabricated).
 *
 * Read-only guarantee (three layers, unchanged from phase 0):
 *  1. permissionMode "plan" (read-only tools auto-approve);
 *  2. explicit deny rules for file-mutating tools (assembly);
 *  3. every tool-approval request is auto-denied — the run is unattended,
 *     so an approval prompt would otherwise hang the turn until the idle
 *     timeout.
 */

import { randomUUID } from "node:crypto";
import type {
  IntentContract,
  JudgmentReport,
  LoopCard,
  RunLedgerEntry,
  RunState,
} from "@yep-anywhere/shared";
import { IntentContractSchema } from "@yep-anywhere/shared";
import {
  AdapterError,
  adapterErrorCodeToFailureTag,
} from "../sdk/adapter-error.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import {
  AssemblyError,
  type RuntimeInput,
  assembleRuntimeInput,
} from "./assembly/runtime-input.js";
import {
  type ContractSource,
  buildIntentContract,
} from "./contract/intent-contract.js";
import type {
  ControlPlane,
  ResumeSignal,
} from "./control-plane/control-plane.js";
import { retryBackoffMs } from "./control-plane/retry-backoff.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import type { RunLedgerStore } from "./state/run-ledger-store.js";
import { type VerificationRefs, verifyRun } from "./verification/verify-run.js";

export type LoopRunErrorCode =
  | "loop_not_found"
  | "loop_archived"
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
  verifier_report_refs: string[];
  judgment_report_ref: string | null;
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
  /** Set when contract/assembly setup failed before turn 1 could start. */
  setupError?: Error;
}

export interface LoopRunServiceDeps {
  supervisor: Supervisor;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  /** Phase-2 control-plane; absent in tests that only exercise phase-0
   *  orchestration (single-turn, verdicts map straight to complete/failed,
   *  no budget enforcement). */
  controlPlane?: ControlPlane;
  /** Backoff wait between retry turns; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Verification seam for tests; defaults to the real verifyRun. */
  verifyRunFn?: typeof verifyRun;
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

export class LoopRunService {
  private readonly deps: LoopRunServiceDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verify: typeof verifyRun;
  /** loop_id -> active run (same-loop runs are serial) */
  private activeByLoop = new Map<string, ActiveRun>();
  private activeByRunId = new Map<string, ActiveRun>();
  /** run_id -> suspended execution context (needs_human / budget_limited / paused) */
  private suspended = new Map<string, RunExecutionContext>();

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
   * Start a run for a loop. Registers the run as active synchronously
   * (so concurrent triggers get run_active), then executes in the
   * background — ledger entries are appended per turn as the run finishes.
   */
  async startRun(loopId: string, source: ContractSource): Promise<RunSummary> {
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
    void this.executeRun(active, stored.card).catch((error) => {
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
          source: "cron", // source is not in the ledger schema; see report
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

  /** Single run view: active run metadata or the finished ledger entry,
   *  plus the 03 LedgerSummary projection (incl. judgment_report 摘要). */
  async getRun(runId: string): Promise<{
    run: RunSummary;
    ledger: RunLedgerEntry | null;
    ledger_summary: LedgerSummary;
  } | null> {
    const active = this.activeByRunId.get(runId);
    if (active) {
      return {
        run: {
          run_id: active.runId,
          loop_id: active.loopId,
          state: this.deps.controlPlane?.currentStateOf(runId) ?? "active",
          source: active.source,
          created_at: active.createdAt,
        },
        ledger: null,
        ledger_summary: await this.buildLedgerSummary(
          runId,
          active.loopId,
          null,
        ),
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
        source: "cron",
        created_at: entry.created_at,
      },
      ledger: entry,
      ledger_summary: await this.buildLedgerSummary(
        runId,
        entry.loop_id,
        entry,
      ),
    };
  }

  /** Build the 03 LedgerSummary projection from the ledger file + artifacts. */
  private async buildLedgerSummary(
    runId: string,
    loopId: string,
    entry: RunLedgerEntry | null,
  ): Promise<LedgerSummary> {
    const refs = entry?.verification_refs;
    const notApplicable = (ref: string | undefined): ref is string =>
      ref !== undefined && ref !== "not_applicable";

    let judgmentSummary: LedgerSummary["judgment_summary"] = null;
    const judgmentJson = await this.deps.runLedgerStore.readArtifact(
      runId,
      "judgment-report.json",
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

    // turns_used / retries_used come from the control-plane's budget snapshot
    // (03: budget 消耗对照 max_turns / max_retries); the run_state belongs to
    // this run only when its run_id matches (same-loop runs are serial but a
    // newer run may already hold the loop's state file).
    let turnsUsed = 1;
    let retriesUsed = 0;
    const runState = await this.deps.controlPlane?.getRunState(loopId);
    if (runState && runState.run_id === runId && runState.budget) {
      turnsUsed = runState.budget.used_turns;
      retriesUsed = runState.budget.used_retries;
    }

    return {
      turns_used: turnsUsed,
      retries_used: retriesUsed,
      verifier_report_refs: notApplicable(refs?.verifier_report)
        ? [refs.verifier_report]
        : [],
      judgment_report_ref: notApplicable(refs?.judgment_report)
        ? refs.judgment_report
        : null,
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
    };
    try {
      ctx.contract = buildIntentContract(card, { runId, source });
      ctx.contractJson = JSON.stringify(ctx.contract, null, 2);
      ctx.input = assembleRuntimeInput(card, ctx.contract);
    } catch (error) {
      ctx.setupError =
        error instanceof Error ? error : new Error(String(error));
    }
    await this.runTurns(ctx);
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

    try {
      for (;;) {
        const turnStartedAt = Date.now();

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

        // --- artifacts ---
        if (ctx.turn === 1 && ctx.contractJson) {
          await store.writeArtifact(
            runId,
            "intent-contract.json",
            ctx.contractJson,
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
          `artifact://${runId}/${stdoutName}`,
        ];

        // --- verification ---
        // NOTE: verification artifacts (verifier-reports.json,
        // judgment-report.json) use canonical per-run names — a later turn
        // overwrites the previous turn's files (latest-wins; the API summary
        // always shows the freshest judgment). The previous turn's judgment
        // content is not lost for the run itself: it is injected into the
        // retry turn's context (retry = 证据传递).
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
        const workspacePath = ctx.card.loop.workspace.path;
        if (requiredPhases.length > 0 && ctx.contract && workspacePath) {
          try {
            const verification = await this.verify(
              {
                card: ctx.card,
                contract: ctx.contract,
                runId,
                workspacePath,
                exitStatus: outcome.ok ? 0 : 1,
                stdoutRef: `artifact://${runId}/${stdoutName}`,
              },
              { store },
            );
            verificationRefs = verification.refs;
            verificationRan = true;
            judgment = verification.judgment;
            judgmentRef = verification.refs.judgment_report;
          } catch (error) {
            console.error(
              `[LoopRunService] verification failed for run ${runId}:`,
              error,
            );
          }
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
        if (this.deps.controlPlane && ctx.contract) {
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
        } else if (verificationRan && judgment) {
          finalStatus =
            outcome.ok && judgment.overall === "passed" ? "complete" : "failed";
        }

        // --- per-turn ledger entry (02 §8.1: 每次 retry 产生独立 entry;
        // the session_ref is identical across turns of one run) ---
        const entry: RunLedgerEntry = {
          loop_id: loopId,
          run_id: runId,
          runtime: {
            adapter: "claude",
            session_ref: outcome.sessionRef,
            mode: "plan",
            adapter_capability_snapshot:
              "realSdk(agent_sdk);permissionMode=plan;autoDenyApprovals",
          },
          input_refs: {
            intent: `intent://${loopId}`,
            memory_packet: null, // no memory packet yet
            workspace: `workspace://${loopId}/${runId}`,
          },
          verification_refs: verificationRefs,
          learning_refs: {
            control_decision: `ledger://${runId}`,
            human_feedback: [],
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

        if (finalStatus === "needs_human" || finalStatus === "budget_limited") {
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
    const contractJson = await store.readArtifact(
      signal.runId,
      "intent-contract.json",
    );
    const runState = await this.deps.controlPlane?.getRunState(signal.loopId);
    if (!entry || !contractJson || !runState) {
      return null;
    }
    try {
      const contract = IntentContractSchema.parse(JSON.parse(contractJson));
      const input = assembleRuntimeInput(stored.card, contract);
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
          // source is not in the ledger schema (see listRuns); "cron" is
          // the existing convention for ledger-derived runs.
          source: "cron",
          createdAt: entry.created_at,
        },
        card: stored.card,
        contract,
        contractJson,
        input,
        turn: runState.turn,
        sessionRef:
          entry.runtime.session_ref === "none"
            ? null
            : entry.runtime.session_ref,
        lastJudgment,
        lastJudgmentRef: runState.last_judgment,
        pendingContext: null,
      };
    } catch (error) {
      console.error(
        `[LoopRunService] failed to rebuild context for run ${signal.runId}:`,
        error,
      );
      return null;
    }
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

    const result = isFirstTurn
      ? await this.deps.supervisor.startSession(
          ctx.input.cwd,
          message,
          ctx.input.permissionMode,
          { permissions: ctx.input.permissions },
        )
      : await this.deps.supervisor.resumeSession(
          ctx.sessionRef as string,
          ctx.input.cwd,
          message,
          ctx.input.permissionMode,
          { permissions: ctx.input.permissions },
        );

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

    return this.watchProcess(result as Process);
  }

  /**
   * Collect a turn's final result from the session process. Resolves on the
   * SDK "result" message, or on process completion/termination if no result
   * ever arrives. Token usage comes from the result message's `usage`
   * (Claude SDK AdapterOutput, 02 §4: input_tokens + output_tokens); when
   * the runtime does not expose usage it stays null — never fabricated.
   */
  private async watchProcess(proc: Process): Promise<ExecutionOutcome> {
    return new Promise<ExecutionOutcome>((resolve) => {
      let finalText = "";
      let tokens: number | null = null;
      let settled = false;
      let adapterError: AdapterError | undefined;

      const settle = (ok: boolean, error?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
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
        });
      };

      const unsubscribe = proc.subscribe((event) => {
        if (event.type === "message") {
          const message = event.message;
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
