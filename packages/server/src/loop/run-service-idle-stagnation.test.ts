/**
 * Loop watchdog / stagnation tests:
 *
 *  - Idle watchdog: a turn that produces no process events for the idle
 *    timeout is killed as a timeout and attributed runtime_blackbox_error.
 *  - Stagnation detection: consecutive retry turns with identical output are
 *    escalated to needs_human instead of burning the retry budget.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport, LoopCard } from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { IEventBus } from "../watcher/index.js";
import { blockerFingerprint } from "./control-plane/blocker.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

let sessionCounter = 0;

function nextSessionId(): string {
  return `session-idle-${++sessionCounter}`;
}

interface ProcessController {
  emit(event: unknown): void;
  terminate(reason: string): void;
}

/** Fake Supervisor whose processes hang until explicitly driven by tests. */
class FakeSupervisor {
  readonly calls: { method: string; text: string }[] = [];
  private controllers = new Map<string, ProcessController>();
  private sessionId: string | null = null;
  /** When set, every non-collector process automatically emits this result after a microtask. */
  autoResult: string | null = null;
  /** Sequence of results to emit for consecutive non-collector turns (overrides autoResult). */
  autoResultSequence: string[] | null = null;
  private autoResultIndex = 0;
  /** When set, collector processes automatically emit this result after a microtask. */
  collectorResult: string | null = "collector ok";

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({ method: "start", text: message.text });
    return this.makeProcess(
      nextSessionId(),
      message.text,
      this.isCollectorMessage(message.text),
    );
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({ method: "resume", text: message.text });
    return this.makeProcess(
      sessionId,
      message.text,
      this.isCollectorMessage(message.text),
    );
  }

  private isCollectorMessage(text: string): boolean {
    return text.startsWith("Collector input bundle:");
  }

  private makeProcess(
    sessionId: string,
    text: string,
    isCollector = false,
  ): Process {
    this.sessionId = sessionId;
    const controller: ProcessController = {
      emit: () => {},
      terminate: () => {},
    };
    this.controllers.set(sessionId, controller);
    const proc = {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        controller.emit = (event) => listener(event);
        const result = isCollector
          ? this.collectorResult
          : this.nextAutoResult();
        if (result) {
          queueMicrotask(() => {
            listener({
              type: "message",
              message: { type: "assistant", content: "thinking" },
            });
            listener({
              type: "message",
              message: {
                type: "result",
                subtype: "success",
                result,
                is_error: false,
                usage: { input_tokens: 5, output_tokens: 5 },
              },
            });
          });
        }
        return () => {};
      },
      terminate: (reason: string) => {
        controller.terminate(reason);
      },
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
    return proc;
  }

  private nextAutoResult(): string | null {
    if (
      this.autoResultSequence &&
      this.autoResultIndex < this.autoResultSequence.length
    ) {
      const result = this.autoResultSequence[this.autoResultIndex++];
      return result ?? null;
    }
    if (this.autoResult) {
      return this.autoResult;
    }
    return null;
  }

  getController(sessionId?: string): ProcessController | undefined {
    return this.controllers.get(sessionId ?? this.sessionId ?? "");
  }
}

function makeCard(
  id = "loop-it",
  opts: { max_retries?: number } = {},
): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/loop-it-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
      stop_rules: {
        max_turns: 10,
        max_time_minutes: 30,
        max_retries: opts.max_retries ?? 5,
      },
    },
  };
}

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: [],
};

const RETRY_JUDGMENT: JudgmentReport = {
  overall: "failed",
  next_action: "retry",
  retryable: true,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: ["static check failed"],
};

const NEEDS_HUMAN_JUDGMENT: JudgmentReport = {
  overall: "failed",
  next_action: "needs_human",
  retryable: false,
  requires_human: true,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: ["manual approval required"],
};

async function fakeVerifyPassed(): Promise<VerifyRunResult> {
  return {
    reports: [],
    judgment: PASSED_JUDGMENT,
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  };
}

async function fakeVerifyRetry(): Promise<VerifyRunResult> {
  return {
    reports: [],
    judgment: RETRY_JUDGMENT,
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  };
}

async function fakeVerifyNeedsHuman(): Promise<VerifyRunResult> {
  // Small delay so tests can pre-seed the ledger before the control decision
  // reads decision entries.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    reports: [],
    judgment: NEEDS_HUMAN_JUDGMENT,
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  };
}

interface Fixture {
  service: LoopRunService;
  controlPlane: ControlPlane;
  supervisor: FakeSupervisor;
  loopCardStore: LoopCardStore;
  ledgerStore: RunLedgerStore;
  stateStore: RunStateStore;
}

async function withFixture(
  fn: (ctx: Fixture) => Promise<void>,
  opts: {
    card?: LoopCard;
    verifyRunFn?: () => Promise<VerifyRunResult>;
    idleTimeoutMs?: number;
    stagnationThreshold?: number;
    idleNoProgressThreshold?: number;
    repeatedBlockerThreshold?: number;
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-watchdog-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const card = opts.card ?? makeCard();
    await loopCardStore.createLoop(card);
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const eventBus = {
      emit: () => {},
    } as unknown as IEventBus;
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor = new FakeSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: opts.verifyRunFn ?? (fakeVerifyPassed as never),
      loopWatchdog: {
        turnIdleTimeoutMs: opts.idleTimeoutMs ?? 10 * 60 * 1000,
        turnIdleCheckIntervalMs: 25,
        stagnationSimilarTurnsThreshold: opts.stagnationThreshold ?? 3,
        idleNoProgressTurnsThreshold: opts.idleNoProgressThreshold ?? 3,
        repeatedBlockerThreshold: opts.repeatedBlockerThreshold ?? 3,
      },
    });
    await fn({
      service,
      controlPlane,
      supervisor,
      loopCardStore,
      ledgerStore,
      stateStore,
    });
  } finally {
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

/** Poll until a condition holds (or time out). */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("idle watchdog kills a stuck turn after no process activity", async () => {
  await withFixture(
    async ({ service, controlPlane, supervisor }) => {
      const start = service.startRun("loop-it", "manual");
      await waitFor(() => supervisor.calls.length === 1, "turn 1 to start");
      const summary = await start;
      const runId = summary.run_id;

      // Process emits one message then stays silent; idle watchdog should kill it.
      const controller = supervisor.getController();
      if (!controller) {
        throw new Error("executor controller not found");
      }
      controller.emit({
        type: "message",
        message: { type: "assistant", content: "working" },
      });

      await waitFor(
        () =>
          controlPlane.currentStateOf(runId) === "failed" ||
          controlPlane.currentStateOf(runId) === "retry",
        "run to fail/retry after idle timeout",
        2000,
      );

      const state = controlPlane.currentStateOf(runId);
      assert.ok(
        state === "failed" || state === "retry",
        `expected failed/retry, got ${state}`,
      );

      // Ledger entry should reflect the timeout outcome.
      const lastEntry = await service.readRunLedgerEntry(runId);
      assert.ok(lastEntry);
      assert.equal(lastEntry.final_status, state);

      // Stdout artifact should contain the idle timeout message.
      const stdoutName = state === "failed" ? "stdout.log" : "stdout-turn1.log";
      const stdout = await service.readRunArtifact(runId, stdoutName);
      assert.ok(stdout?.includes("idle timeout"));
    },
    { idleTimeoutMs: 150 },
  );
});

test("stagnation detection escalates identical retry output to needs_human", async () => {
  await withFixture(
    async ({ service, controlPlane, supervisor }) => {
      supervisor.autoResult = "same report every time";
      const start = service.startRun("loop-it", "manual");
      await waitFor(() => supervisor.calls.length >= 1, "turn 1 to start");
      const summary = await start;
      const runId = summary.run_id;

      // Wait for needs_human (escalated by stagnation).
      await waitFor(
        () => controlPlane.currentStateOf(runId) === "needs_human",
        "run to reach needs_human",
        3000,
      );

      const state = controlPlane.currentStateOf(runId);
      assert.equal(
        state,
        "needs_human",
        `expected needs_human due to stagnation, got ${state}`,
      );

      // A stagnation artifact should have been written.
      const artifacts = await service.listRunArtifacts(runId);
      assert.ok(
        artifacts.some((name) => name.includes("loop-stagnation")),
        `expected loop-stagnation artifact, got ${artifacts.join(", ")}`,
      );
    },
    {
      verifyRunFn: fakeVerifyRetry,
      stagnationThreshold: 2,
      card: makeCard("loop-it", { max_retries: 5 }),
    },
  );
});

test("idle no-diff-progress detection escalates retry-without-workspace-change to needs_human", async () => {
  await withFixture(
    async ({ service, controlPlane, supervisor }) => {
      // Vary the process output each turn so the similar-output guard does not
      // fire first; the workspace (/tmp/loop-it-ws) is not a git repo, so the
      // diff stat stays empty (null -> "" -> same hash) across retries.
      supervisor.autoResultSequence = [
        "attempt one",
        "attempt two",
        "attempt three",
      ];
      const start = service.startRun("loop-it", "manual");
      await waitFor(() => supervisor.calls.length >= 1, "turn 1 to start");
      const summary = await start;
      const runId = summary.run_id;

      await waitFor(
        () => controlPlane.currentStateOf(runId) === "needs_human",
        "run to reach needs_human via no-diff-progress",
        3000,
      );

      const state = controlPlane.currentStateOf(runId);
      assert.equal(
        state,
        "needs_human",
        `expected needs_human due to no-diff-progress, got ${state}`,
      );

      const artifacts = await service.listRunArtifacts(runId);
      assert.ok(
        artifacts.some((name) => name.includes("loop-stagnation")),
        `expected loop-stagnation artifact, got ${artifacts.join(", ")}`,
      );
    },
    {
      verifyRunFn: fakeVerifyRetry,
      // Disable similar-output escalation so the no-diff-progress path is hit.
      stagnationThreshold: 100,
      idleNoProgressThreshold: 2,
      card: makeCard("loop-it", { max_retries: 5 }),
    },
  );
});

test("repeated blocker dead-loop detection forces needs_human run to failed", async () => {
  await withFixture(
    async ({ service, controlPlane, supervisor, ledgerStore }) => {
      supervisor.autoResult = "needs human approval";
      const summary = await service.startRun("loop-it", "manual");
      const runId = summary.run_id;

      // Pre-seed one prior needs_human decision with the same blocker fingerprint
      // so the very next needs_human decision repeats it. The live judgment will
      // have the collector report merged into its evidence, so match that.
      const fingerprint = blockerFingerprint({
        ...NEEDS_HUMAN_JUDGMENT,
        evidence: [
          ...NEEDS_HUMAN_JUDGMENT.evidence,
          `artifact://${runId}/collector-report.json`,
        ],
      });
      assert.ok(fingerprint);
      await ledgerStore.appendDecisionEntry(runId, {
        decision_id: "preseed-dead-loop-1",
        loop_id: "loop-it",
        run_id: runId,
        decision: "needs_human",
        reason: "prior unresolved blocker",
        evidence_refs: ["artifact://run/verifier-reports.json"],
        policy_refs: [],
        next_action: "wait_for_approval",
        blocker_fingerprint: fingerprint,
        repeated_blocker_count: 1,
        created_at: new Date().toISOString(),
      });

      await waitFor(
        () => controlPlane.currentStateOf(runId) === "failed",
        "run to be forced to failed by dead-loop detection",
        3000,
      );

      const state = controlPlane.currentStateOf(runId);
      assert.equal(state, "failed", `expected failed, got ${state}`);

      const lastEntry = await service.readRunLedgerEntry(runId);
      assert.ok(lastEntry);
      assert.equal(lastEntry.final_status, "failed");
    },
    {
      verifyRunFn: fakeVerifyNeedsHuman,
      repeatedBlockerThreshold: 2,
      card: makeCard("loop-it", { max_retries: 5 }),
    },
  );
});
