/**
 * Phase-0 run orchestration (spec: docs/spec/05-分阶段计划.md 阶段 0).
 *
 * Wires trigger → contract → assembly → Supervisor → run ledger into the
 * minimal closed loop. When a control-plane is wired (phase 1), the
 * post-execution judgment drives the minimal state progression
 * (active → complete / needs_human / failed) and needs_human bridging;
 * without one (phase-0 tests), a run is either "active" (tracked in memory)
 * or finished with a ledger entry on disk — no budget enforcement.
 *
 * run_id rule: `run-<UTC yyyymmddTHHMMSSz>-<8 lowercase hex>` — sortable
 * by fire time, collision-safe, file-system safe (matches the ledger
 * store's SAFE_NAME pattern).
 *
 * Read-only guarantee (three layers):
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
  RunLedgerEntry,
  RunState,
} from "@yep-anywhere/shared";
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
import type { ControlPlane } from "./control-plane/control-plane.js";
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
  /** "active" while in flight; afterwards the ledger entry's final_status */
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
  /** Set when the failure is a unified adapter hard error (02 §4). */
  adapterError?: AdapterError;
}

export interface LoopRunServiceDeps {
  supervisor: Supervisor;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  /** Phase-1 minimal control-plane; absent in tests that only exercise
   *  phase-0 orchestration (verification verdicts then map straight to
   *  complete/failed as before). */
  controlPlane?: ControlPlane;
}

function makeRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

export class LoopRunService {
  private readonly deps: LoopRunServiceDeps;
  /** loop_id -> active run (same-loop runs are serial) */
  private activeByLoop = new Map<string, ActiveRun>();
  private activeByRunId = new Map<string, ActiveRun>();

  constructor(deps: LoopRunServiceDeps) {
    this.deps = deps;
    // A needs_human run keeps its active registration while it waits; the
    // control-plane calls this when the human decision resolves it.
    deps.controlPlane?.onRunResolved((runId) => this.releaseRun(runId));
  }

  /** Release a resolved (previously needs_human) run's active registration. */
  private releaseRun(runId: string): void {
    const active = this.activeByRunId.get(runId);
    if (active) {
      this.activeByRunId.delete(runId);
      this.activeByLoop.delete(active.loopId);
    }
  }

  isRunActive(loopId: string): boolean {
    return this.activeByLoop.has(loopId);
  }

  /**
   * Start a run for a loop. Registers the run as active synchronously
   * (so concurrent triggers get run_active), then executes in the
   * background — the ledger entry is appended when the run finishes.
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
    // agent finishing. The ledger entry is the durable record of the run.
    void this.executeRun(active, stored.card).catch((error) => {
      console.error(`[LoopRunService] run ${runId} crashed:`, error);
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
          // The ledger entry is append-only (its final_status can be a stale
          // needs_human after a human decision) — the control-plane's latest
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
        ledger_summary: await this.buildLedgerSummary(runId, null),
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
        // Append-only ledger can hold a stale needs_human; prefer the
        // control-plane's latest known state (see listRuns).
        state:
          this.deps.controlPlane?.currentStateOf(entry.run_id) ??
          entry.final_status,
        source: "cron",
        created_at: entry.created_at,
      },
      ledger: entry,
      ledger_summary: await this.buildLedgerSummary(runId, entry),
    };
  }

  /** Build the 03 LedgerSummary projection from the ledger file + artifacts. */
  private async buildLedgerSummary(
    runId: string,
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

    return {
      turns_used: 1, // phase 1: single-turn runs
      retries_used: 0, // phase 1: no retry (phase-2 budget counter)
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

  private async executeRun(
    active: ActiveRun,
    card: Parameters<typeof buildIntentContract>[0],
  ): Promise<void> {
    const { runId, loopId, source, createdAt } = active;
    const store = this.deps.runLedgerStore;
    let outcome: ExecutionOutcome;
    let contract: IntentContract | null = null;
    let contractJson: string | null = null;

    try {
      contract = buildIntentContract(card, { runId, source });
      contractJson = JSON.stringify(contract, null, 2);
      const input = assembleRuntimeInput(card, contract);
      outcome = await this.execute(input);
    } catch (error) {
      outcome = {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error:
          error instanceof AssemblyError
            ? error.message
            : `run setup/execution failed: ${error instanceof Error ? error.message : String(error)}`,
        // Unified adapter hard errors (02 §4) keep their code so the failure
        // attribution below can use the 失败模式账本 vocabulary.
        adapterError: error instanceof AdapterError ? error : undefined,
      };
    }

    const stdout = outcome.finalText || outcome.error || "(no output)";
    let waitingForHuman = false;
    try {
      if (contractJson) {
        await store.writeArtifact(runId, "intent-contract.json", contractJson);
      }
      await store.writeArtifact(runId, "stdout.log", stdout);

      const artifactRefs = [
        ...(contractJson ? [`artifact://${runId}/intent-contract.json`] : []),
        `artifact://${runId}/stdout.log`,
      ];

      // Phase-1 verification layer (05 阶段 1 "两段起步"): runs only when the
      // card requires phases and the run got far enough to have a contract
      // and a workspace. When it does not run, verification_refs keep the
      // explicit "not_applicable" sentinel (not a fake reference).
      let verificationRefs: VerificationRefs = {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "not_applicable",
      };
      let verificationRan = false;
      let judgment: JudgmentReport | null = null;
      let judgmentRef: string | null = null;
      let finalStatus: RunState = outcome.ok ? "complete" : "failed";

      const requiredPhases = card.loop.verification.required;
      const workspacePath = card.loop.workspace.path;
      if (requiredPhases.length > 0 && contract && workspacePath) {
        try {
          const verification = await verifyRun(
            {
              card,
              contract,
              runId,
              workspacePath,
              exitStatus: outcome.ok ? 0 : 1,
              stdoutRef: `artifact://${runId}/stdout.log`,
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

      // Phase-1 minimal control-plane: the judgment decides complete /
      // needs_human / failed, the decision lands in the decision ledger, and
      // needs_human bridges into the human-decision pipeline (the run stays
      // registered as active while it waits — see the finally block).
      //
      // Adapter hard errors (02 §4: timeout / spawn_failed / ...) are
      // terminal by construction and never trigger needs_human: there is no
      // work product to judge and nothing a human verdict could unblock —
      // retry/resume semantics belong to the phase-2 state machine. The
      // failure attribution (失败模式账本 vocabulary) is attached to the
      // control decision entry so the ledger carries it.
      if (this.deps.controlPlane) {
        try {
          const applied = await this.deps.controlPlane.applyJudgment({
            loopId,
            runId,
            turn: 1,
            goalId: contract?.intent_id ?? "unknown",
            workspaceRef: `workspace://${loopId}/${runId}`,
            executionOk: outcome.ok,
            verificationRan,
            judgment,
            judgmentRef,
            createdAt,
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
          waitingForHuman = applied.state === "needs_human";
        } catch (error) {
          console.error(
            `[LoopRunService] control-plane failed for run ${runId}:`,
            error,
          );
        }
      } else if (verificationRan && judgment) {
        finalStatus =
          outcome.ok && judgment.overall === "passed" ? "complete" : "failed";
      }

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
          memory_packet: null, // phase 0: no memory packet
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
        `[LoopRunService] run ${runId} (loop '${loopId}') finished: ${entry.final_status}${outcome.error ? ` — ${outcome.error}` : ""}`,
      );
    } catch (error) {
      console.error(
        `[LoopRunService] failed to persist ledger for run ${runId}:`,
        error,
      );
    } finally {
      // A needs_human run is a blocking wait state: it keeps its active
      // registration (same-loop runs stay serial, 409 run_active) until the
      // human decision resolves it via ControlPlane → releaseRun().
      if (!waitingForHuman) {
        this.activeByLoop.delete(loopId);
        this.activeByRunId.delete(runId);
      }
    }
  }

  /**
   * Execute one read-only turn through Supervisor.startSession and collect
   * the final result text. Resolves on the SDK "result" message, or on
   * process completion/termination if no result ever arrives.
   */
  private async execute(input: RuntimeInput): Promise<ExecutionOutcome> {
    const result = await this.deps.supervisor.startSession(
      input.cwd,
      { text: input.prompt, mode: input.permissionMode },
      input.permissionMode,
      { permissions: input.permissions },
    );

    if ("error" in result && result.error === "queue_full") {
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: "supervisor queue is full",
      };
    }
    if ("queued" in result && (result as QueuedResponse).queued === true) {
      // Phase-0 limitation: a queued session starts later without a ledger
      // track; treated as a failed run instead of waiting indefinitely.
      return {
        ok: false,
        finalText: "",
        sessionRef: "none",
        error: "supervisor at capacity; run request was queued",
      };
    }

    const proc = result as Process;
    return new Promise<ExecutionOutcome>((resolve) => {
      let finalText = "";
      let settled = false;
      let adapterError: AdapterError | undefined;

      const settle = (ok: boolean, error?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        // Free the worker slot; the session jsonl stays on disk regardless.
        void proc.abort().catch(() => {});
        resolve({
          ok,
          finalText,
          sessionRef: proc.sessionId,
          error,
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
