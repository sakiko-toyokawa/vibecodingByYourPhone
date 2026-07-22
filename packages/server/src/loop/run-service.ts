/**
 * Phase-0 run orchestration (spec: docs/spec/05-分阶段计划.md 阶段 0).
 *
 * Wires trigger → contract → assembly → Supervisor → run ledger into the
 * minimal closed loop. There is no control-plane yet: a run is either
 * "active" (tracked in memory) or finished with a ledger entry on disk;
 * there is no 7-state machine and no budget enforcement. When the card
 * requires verification phases, the phase-1 verification layer
 * (loop/verification/) runs after execution and its judgment decides
 * complete vs failed (needs_human bridging is the next slice).
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
import type { IntentContract, RunLedgerEntry } from "@yep-anywhere/shared";
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
  state: "active" | "complete" | "failed";
  source: ContractSource;
  created_at: string;
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
}

export interface LoopRunServiceDeps {
  supervisor: Supervisor;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
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
          state: entry.final_status === "complete" ? "complete" : "failed",
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
        state: "active",
        source: active.source,
        created_at: active.createdAt,
      });
    }

    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return summaries;
  }

  /** Single run view: active run metadata or the finished ledger entry. */
  async getRun(
    runId: string,
  ): Promise<{ run: RunSummary; ledger: RunLedgerEntry | null } | null> {
    const active = this.activeByRunId.get(runId);
    if (active) {
      return {
        run: {
          run_id: active.runId,
          loop_id: active.loopId,
          state: "active",
          source: active.source,
          created_at: active.createdAt,
        },
        ledger: null,
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
        state: entry.final_status === "complete" ? "complete" : "failed",
        source: "cron",
        created_at: entry.created_at,
      },
      ledger: entry,
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
      };
    }

    const stdout = outcome.finalText || outcome.error || "(no output)";
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
      let finalStatus: RunLedgerEntry["final_status"] = outcome.ok
        ? "complete"
        : "failed";

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
          // TODO(phase-1 next slice): judgment.next_action "needs_human" /
          // "escalate" must bridge into the Yep approval pipeline and move
          // the run to needs_human; this slice records failed/inconclusive
          // as failed.
          finalStatus =
            outcome.ok && verification.judgment.overall === "passed"
              ? "complete"
              : "failed";
        } catch (error) {
          console.error(
            `[LoopRunService] verification failed for run ${runId}:`,
            error,
          );
        }
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
      console.log(
        `[LoopRunService] run ${runId} (loop '${loopId}') finished: ${entry.final_status}${outcome.error ? ` — ${outcome.error}` : ""}`,
      );
    } catch (error) {
      console.error(
        `[LoopRunService] failed to persist ledger for run ${runId}:`,
        error,
      );
    } finally {
      this.activeByLoop.delete(loopId);
      this.activeByRunId.delete(runId);
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
          settle(false, `process terminated: ${event.reason}`);
        } else if (event.type === "error") {
          settle(false, event.error.message);
        }
      });
    });
  }
}
