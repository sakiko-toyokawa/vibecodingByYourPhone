/**
 * Restart recovery tests for loop runs.
 *
 *  - retry state: a run whose last completed turn decided retry is resumed
 *    on a new service instance after "restart".
 *  - active state: a run whose run_state says active/turn=N (beginTurn
 *    completed but the executing process died) is resumed and turn N runs.
 *  - terminal states (complete/failed) are not resumed.
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
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

let sessionCounter = 0;

function nextSessionId(): string {
  return `session-restart-${++sessionCounter}`;
}

interface ProcessController {
  emit(event: unknown): void;
  terminate(reason: string): void;
}

/** Fake Supervisor that can be configured to auto-emit a fixed result. */
class FakeSupervisor {
  readonly calls: { method: string; text: string; sessionId: string }[] = [];
  private controllers = new Map<
    string,
    ProcessController & {
      listener?: (event: unknown) => void;
      buffered: unknown[];
    }
  >();
  private sessionId: string | null = null;
  autoResult: string | null = null;
  private subscribeResolve: (() => void) | null = null;
  private subscribePromise: Promise<void> | null = null;

  waitForSubscribe(): Promise<void> {
    if (!this.subscribePromise) {
      this.subscribePromise = new Promise((resolve) => {
        this.subscribeResolve = resolve;
      });
    }
    return this.subscribePromise;
  }

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    const sessionId = nextSessionId();
    this.calls.push({ method: "start", text: message.text, sessionId });
    return this.makeProcess(sessionId, message.text);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({ method: "resume", text: message.text, sessionId });
    return this.makeProcess(sessionId, message.text);
  }

  private makeProcess(sessionId: string, text: string): Process {
    this.sessionId = sessionId;
    const controller: ProcessController & {
      listener?: (event: unknown) => void;
      buffered: unknown[];
    } = {
      buffered: [],
      emit: (event: unknown) => {
        if (controller.listener) {
          controller.listener(event);
        } else {
          controller.buffered.push(event);
        }
      },
      terminate: () => {},
    };
    this.controllers.set(sessionId, controller);
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        controller.listener = listener;
        for (const event of controller.buffered) {
          listener(event);
        }
        controller.buffered = [];
        if (this.subscribeResolve) {
          this.subscribeResolve();
          this.subscribeResolve = null;
        }
        if (this.autoResult) {
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
                result: this.autoResult,
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

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Stores {
  dataDir: string;
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  runStateStore: RunStateStore;
}

async function createStores(): Promise<Stores> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-restart-"));
  const loopCardStore = new LoopCardStore({ dataDir });
  await loopCardStore.initialize();
  const runLedgerStore = new RunLedgerStore({ dataDir });
  const runStateStore = new RunStateStore({ dataDir });
  return { dataDir, loopCardStore, runLedgerStore, runStateStore };
}

function createService(
  stores: Stores,
  supervisor: FakeSupervisor,
  verifyRunFn: () => Promise<VerifyRunResult>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): LoopRunService {
  const eventBus = { emit: () => {} } as unknown as IEventBus;
  const controlPlane = new ControlPlane({
    runStateStore: stores.runStateStore,
    runLedgerStore: stores.runLedgerStore,
    eventBus,
  });
  return new LoopRunService({
    supervisor: supervisor as unknown as Supervisor,
    loopCardStore: stores.loopCardStore,
    runLedgerStore: stores.runLedgerStore,
    controlPlane,
    sleep: opts.sleep,
    verifyRunFn: verifyRunFn as never,
    loopWatchdog: {
      turnIdleTimeoutMs: 10 * 60 * 1000,
      turnIdleCheckIntervalMs: 30 * 1000,
      stagnationSimilarTurnsThreshold: 3,
      idleNoProgressTurnsThreshold: 3,
      repeatedBlockerThreshold: 3,
    },
  });
}

function makePausingSleep() {
  let resolveRef: (() => void) | null = null;
  let released = false;
  const promise = new Promise<void>((resolve) => {
    resolveRef = resolve;
  });
  const release = () => {
    if (released || !resolveRef) return;
    released = true;
    resolveRef();
  };
  const sleep = async () => {
    await promise;
  };
  return { sleep, release };
}

test("resumeAfterRestart resumes a retry-state run on a new service", async () => {
  const stores = await createStores();
  try {
    await stores.loopCardStore.createLoop(makeCard("loop-it"));
    const supervisor = new FakeSupervisor();
    // Collector session auto-completes so verification can run; the executor
    // session is manually driven below.
    supervisor.autoResult = "collector done";
    const { sleep } = makePausingSleep();
    const service = createService(stores, supervisor, fakeVerifyRetry, {
      sleep,
    });

    const subscribePromise = supervisor.waitForSubscribe();
    const start = service.startRun("loop-it", "manual");
    await waitFor(() => supervisor.calls.length === 1, "turn 1 to start");

    // Emit the executor result before subscribe() so it is replayed first and
    // settles the turn on "retry output" rather than the collector autoResult.
    const summary = await start;
    const runId = summary.run_id;
    const ctrl = supervisor.getController();
    if (!ctrl) {
      throw new Error("executor controller not found");
    }
    ctrl.emit({
      type: "message",
      message: { type: "assistant", content: "thinking" },
    });
    ctrl.emit({
      type: "message",
      message: {
        type: "result",
        subtype: "success",
        result: "retry output",
        is_error: false,
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    });

    // Wait for executeTurn to subscribe and process the buffered events.
    await subscribePromise;

    await waitFor(
      async () =>
        (await stores.runStateStore.load("loop-it"))?.state === "retry",
      "turn 1 to finish and enter retry",
    );

    const stateBefore = await stores.runStateStore.load("loop-it");
    assert.equal(stateBefore?.state, "retry");
    assert.equal(stateBefore?.run_id, runId);

    // Simulate restart: create a fresh service sharing the same stores.
    // Freeze the resumed run after it starts turn 2 so the test ends cleanly
    // without background writes racing the temp directory cleanup.
    const restartedSupervisor = new FakeSupervisor();
    restartedSupervisor.autoResult = "fixed output";
    const { sleep: resumedSleep } = makePausingSleep();
    const restartedService = createService(
      stores,
      restartedSupervisor,
      fakeVerifyPassed,
      { sleep: resumedSleep },
    );

    await restartedService.resumeAfterRestart("loop-it");

    // The resumed run should start turn 2 via a fresh session.
    await waitFor(
      () => restartedSupervisor.calls.length >= 1,
      "turn 2 to start after restart",
    );
    assert.equal(restartedSupervisor.calls[0]?.method, "start");
    assert.ok(restartedSupervisor.calls[0]?.sessionId);
    assert.ok(
      restartedSupervisor.calls[0]?.text.includes("retry"),
      "turn 2 prompt should include retry context",
    );
  } finally {
    await rm(stores.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resumeAfterRestart resumes an active-state run on a new service", async () => {
  const stores = await createStores();
  try {
    const card = makeCard("loop-it");
    await stores.loopCardStore.createLoop(card);

    // Seed a run that completed turn 1 and crashed during turn 2 after
    // beginTurn wrote run_state active/turn=2.
    const runId = "run-restart-active-1";
    const contract = {
      intent_id: "intent-1",
      source: "ui",
      raw_goal: "test",
      task_type: {
        primary: "code",
        confidence: 1,
        requires_clarification: false,
      },
      outcome: "test outcome",
      success_criteria: ["pass"],
      constraints: [],
      budget: {
        max_turns: 5,
        max_retries: 3,
        max_time_minutes: 30,
        max_tokens: 0,
      },
      stop_rules: {},
    };
    await stores.runLedgerStore.writeArtifact(
      runId,
      "intent-contract.json",
      JSON.stringify(contract, null, 2),
    );
    await stores.runLedgerStore.writeArtifact(
      runId,
      "stdout.log",
      "turn 1 output",
    );
    await stores.runLedgerStore.appendEntry(runId, {
      loop_id: "loop-it",
      run_id: runId,
      source: "manual",
      runtime: {
        adapter: "claude",
        session_ref: runId,
        mode: "print",
        adapter_capability_snapshot: "",
      },
      input_refs: {
        intent: `artifact://${runId}/intent-contract.json`,
        memory_packet: null,
        workspace: "workspace://loop-it/run-restart-active-1",
      },
      verification_refs: {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "not_applicable",
      },
      learning_refs: {
        control_decision: "ledger://decision",
        human_feedback: [],
        external_feedback: [],
      },
      artifact_refs: [`artifact://${runId}/stdout.log`],
      final_status: "complete",
      created_at: new Date().toISOString(),
    });
    await stores.runStateStore.save("loop-it", {
      version: 2,
      goal_id: "intent-1",
      run_id: runId,
      state: "active",
      turn: 2,
      intent_version: 1,
      workspace_ref: "workspace://loop-it/run-restart-active-1",
      last_judgment: `artifact://${runId}/judgment-report.json`,
      pending_approval: null,
      budget: {
        max_turns: 5,
        max_retries: 3,
        max_time_minutes: 30,
        max_tokens: 0,
        used_turns: 1,
        used_retries: 0,
        used_time_minutes: 0,
        used_tokens: 0,
      },
      session_ref: runId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const restartedSupervisor = new FakeSupervisor();
    restartedSupervisor.autoResult = "completed after restart";
    const restartedService = createService(
      stores,
      restartedSupervisor,
      fakeVerifyPassed,
    );

    await restartedService.resumeAfterRestart("loop-it");

    // Turn 2 should be executed via a fresh session, not the old session_ref.
    await waitFor(
      () => restartedSupervisor.calls.length >= 1,
      "turn 2 to resume after restart",
    );
    assert.equal(restartedSupervisor.calls[0]?.method, "start");
    assert.ok(restartedSupervisor.calls[0]?.sessionId);
    assert.notEqual(restartedSupervisor.calls[0]?.sessionId, runId);
  } finally {
    await rm(stores.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resumeAfterRestart ignores terminal runs", async () => {
  const stores = await createStores();
  try {
    await stores.loopCardStore.createLoop(makeCard("loop-it"));
    const supervisor = new FakeSupervisor();
    supervisor.autoResult = "done";
    const service = createService(stores, supervisor, fakeVerifyPassed);

    const start = service.startRun("loop-it", "manual");
    await waitFor(() => supervisor.calls.length === 1, "turn 1 to start");
    const summary = await start;
    const runId = summary.run_id;

    await waitFor(
      () => service.isRunActive("loop-it") === false,
      "run to complete",
    );

    const restartedSupervisor = new FakeSupervisor();
    const restartedService = createService(
      stores,
      restartedSupervisor,
      fakeVerifyPassed,
    );
    await restartedService.resumeAfterRestart("loop-it");

    // No new calls because the run is already complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(restartedSupervisor.calls.length, 0);
  } finally {
    await rm(stores.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resumeAfterRestart fails a run whose context cannot be rebuilt", async () => {
  const stores = await createStores();
  try {
    const card = makeCard("loop-it");
    await stores.loopCardStore.createLoop(card);

    // Seed an active run at turn 2 but delete its intent-contract snapshot.
    // rebuildContext() requires the contract artifact for non-first turns,
    // so the run cannot be resumed and must be forced to failed.
    const runId = "run-restart-unrecoverable-1";
    await stores.runLedgerStore.appendEntry(runId, {
      loop_id: "loop-it",
      run_id: runId,
      source: "manual",
      runtime: {
        adapter: "claude",
        session_ref: runId,
        mode: "print",
        adapter_capability_snapshot: "",
      },
      input_refs: {
        intent: `artifact://${runId}/intent-contract.json`,
        memory_packet: null,
        workspace: "workspace://loop-it/run-restart-unrecoverable-1",
      },
      verification_refs: {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "not_applicable",
      },
      learning_refs: {
        control_decision: "ledger://decision",
        human_feedback: [],
        external_feedback: [],
      },
      artifact_refs: [`artifact://${runId}/stdout.log`],
      final_status: "complete",
      created_at: new Date().toISOString(),
    });
    await stores.runStateStore.save("loop-it", {
      version: 2,
      goal_id: "intent-1",
      run_id: runId,
      state: "active",
      turn: 2,
      intent_version: 1,
      workspace_ref: "workspace://loop-it/run-restart-unrecoverable-1",
      last_judgment: null,
      pending_approval: null,
      budget: {
        max_turns: 5,
        max_retries: 3,
        max_time_minutes: 30,
        max_tokens: 0,
        used_turns: 1,
        used_retries: 0,
        used_time_minutes: 0,
        used_tokens: 0,
      },
      session_ref: runId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const restartedSupervisor = new FakeSupervisor();
    const restartedService = createService(
      stores,
      restartedSupervisor,
      fakeVerifyPassed,
    );

    await restartedService.resumeAfterRestart("loop-it");

    // No turn should be started because recovery failed before execution.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(restartedSupervisor.calls.length, 0);

    // The run must be moved out of active to avoid staying stuck forever.
    const runState = await stores.runStateStore.load("loop-it");
    assert.equal(runState?.state, "failed");
    assert.equal(runState?.run_id, runId);
  } finally {
    await rm(stores.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
