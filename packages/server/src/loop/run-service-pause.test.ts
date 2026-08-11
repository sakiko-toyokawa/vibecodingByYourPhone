/**
 * Phase-2 third slice integration test (spec: docs/spec/03-API契约.md
 * "PATCH /api/loops/:id", 05-分阶段计划.md 阶段 2 验收 5):
 *
 *  - pause: active run → paused, the executing process is killed (选项 A:
 *    partial result dropped, session_ref kept), and the approval pipeline
 *    gets NO new queued item (主动暂停不走审批管线 — no
 *    run-decision-required event, pending_approval stays null);
 *  - resume: paused → active, the run continues from the NEXT turn in a
 *    fresh session (Loop Engineering: per-turn startSession + AU2 handoff);
 *  - error codes per 03: 400 invalid_action, 404 loop_not_found,
 *    409 invalid_state (pause on a non-active run, resume on a non-paused
 *    run, operations on an archived loop, archive with an active run);
 *  - pause with no active run only blocks future triggers (loop-level flag,
 *    startRun → 409 loop_paused); archive is a soft delete.
 *
 * Real routes + stores + control-plane + run service; only the Supervisor
 * and the verification layer are mocked.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport, LoopCard, RunState } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { createLoopsRoutes } from "../routes/loops.js";
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

interface SupervisorCall {
  method: "start" | "resume";
  role: "executor" | "collector";
  sessionId: string | null;
  text: string;
}

/** Fake Supervisor: processes hang until told to succeed (autoSucceed) or
 *  are killed via terminate (PATCH pause path). */
class FakeSupervisor {
  readonly calls: SupervisorCall[] = [];
  /** When true, every new process emits a successful result immediately. */
  autoSucceed = false;
  private listener: ((event: unknown) => void) | null = null;

  async startSession(
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    const sessionId = `session-pause-${++sessionCounter}`;
    this.calls.push({
      method: "start",
      role: message.text.includes("Collector input bundle")
        ? "collector"
        : "executor",
      sessionId,
      text: message.text,
    });
    return this.makeProcess(sessionId);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
  ): Promise<Process> {
    this.calls.push({
      method: "resume",
      role: "executor",
      sessionId,
      text: message.text,
    });
    return this.makeProcess(sessionId);
  }

  private makeProcess(sessionId: string): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        this.listener = listener;
        queueMicrotask(() => {
          // A working message before any result, so a killed (paused) turn
          // still has a partial event stream worth keeping.
          listener({
            type: "message",
            message: { type: "assistant", content: "working on it" },
          });
          if (this.autoSucceed) {
            listener({
              type: "message",
              message: {
                type: "result",
                subtype: "success",
                result: "turn report text",
                is_error: false,
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            });
          }
        });
        return () => {};
      },
      terminate: (reason: string) => {
        this.listener?.({ type: "terminated", reason });
      },
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
  }
}

function makeCard(id = "loop-it"): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/loop-it-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
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

const HUMAN_JUDGMENT: JudgmentReport = {
  overall: "failed",
  next_action: "needs_human",
  retryable: false,
  requires_human: true,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: ["needs a human call"],
};

async function fakeVerify(): Promise<VerifyRunResult> {
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

interface Fixture {
  app: Hono;
  service: LoopRunService;
  controlPlane: ControlPlane;
  supervisor: FakeSupervisor;
  loopCardStore: LoopCardStore;
  ledgerStore: RunLedgerStore;
  stateStore: RunStateStore;
  events: { type: string }[];
}

async function withFixture(
  fn: (ctx: Fixture) => Promise<void>,
  cardIds: string[] = ["loop-it"],
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-patch-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    for (const id of cardIds) {
      await loopCardStore.createLoop(makeCard(id));
    }
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const events: { type: string }[] = [];
    const eventBus = {
      emit: (event: { type: string }) => events.push(event),
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
      verifyRunFn: fakeVerify as never,
    });
    const app = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
    });
    await fn({
      app,
      service,
      controlPlane,
      supervisor,
      loopCardStore,
      ledgerStore,
      stateStore,
      events,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function patchLoop(app: Hono, loopId: string, body: unknown) {
  return app.request(`/${loopId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function triggerRun(app: Hono, loopId: string) {
  return app.request(`/${loopId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** Poll until the run reaches one of the expected states (or time out). */
async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 5000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = controlPlane.currentStateOf(runId);
    if (state && expected.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Poll until a condition holds (or time out). */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("pause mid-turn: run → paused, process killed, 审批管线无新增排队项; resume: fresh session continues", async () => {
  await withFixture(
    async ({
      app,
      service,
      controlPlane,
      supervisor,
      loopCardStore,
      ledgerStore,
      stateStore,
      events,
    }) => {
      // Turn 1 hangs (autoSucceed = false).
      const trigger = await triggerRun(app, "loop-it");
      assert.equal(trigger.status, 201);
      const { run } = (await trigger.json()) as { run: { run_id: string } };
      const runId = run.run_id;
      await waitFor(() => supervisor.calls.length === 1, "turn 1 to start");

      // --- PATCH pause ---
      const pause = await patchLoop(app, "loop-it", { action: "pause" });
      assert.equal(pause.status, 200);
      const pauseBody = (await pause.json()) as {
        loop_id: string;
        current_run_state: string;
      };
      assert.equal(pauseBody.loop_id, "loop-it");
      assert.equal(pauseBody.current_run_state, "paused");

      // run_state: paused, no pending approval (不走审批管线).
      const pausedRecord = await stateStore.load("loop-it");
      assert.equal(pausedRecord?.state, "paused");
      assert.equal(pausedRecord?.run_id, runId);
      assert.equal(pausedRecord?.pending_approval, null);

      // Decision ledger: exactly one paused entry, no needs_human entry;
      // the event bus never saw a run-decision-required (审批管线无新增).
      const decisions = await ledgerStore.readDecisionEntries(runId);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.decision, "paused");
      assert.equal(decisions[0]?.decision_id, `decision-${runId}-t1-paused`);
      assert.equal(decisions[0]?.next_action, "wait_for_resume_signal");
      assert.ok(
        !events.some((e) => e.type === "run-decision-required"),
        "pause must not queue an approval item",
      );
      assert.ok(
        events.some((e) => e.type === "loop-state-changed"),
        "pause broadcasts the state change",
      );

      // 选项 A: the killed turn's partial result is dropped — no run ledger
      // entry — but the run stays registered (same-loop serial).
      assert.equal(await ledgerStore.readEntry(runId), null);
      assert.equal(service.isRunActive("loop-it"), true);
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, true);

      // The partial turn's event stream survives as an artifact so the
      // Stream Output panel can show what the executor did before the kill.
      const partialEvents = await ledgerStore.readArtifact(
        runId,
        "runtime-events.jsonl",
      );
      assert.ok(partialEvents, "paused run keeps the partial runtime events");
      assert.match(partialEvents ?? "", /working on it/);

      // Run detail projection for a paused run: paused state, session_ref
      // kept for resume, budget max + the pausing decision visible.
      const detail = await service.getRun(runId);
      assert.equal(detail?.run.state, "paused");
      assert.equal(
        detail?.session_ref,
        supervisor.calls[0]?.sessionId,
        "session_ref records the interrupted fresh session",
      );
      assert.equal(detail?.ledger_summary.max_turns, 3);
      assert.equal(detail?.ledger_summary.max_retries, 2);
      assert.equal(detail?.ledger_summary.last_decision?.decision, "paused");

      // New triggers are rejected while paused.
      const during = await triggerRun(app, "loop-it");
      assert.equal(during.status, 409);

      // --- PATCH resume ---
      supervisor.autoSucceed = true;
      const resume = await patchLoop(app, "loop-it", { action: "resume" });
      assert.equal(resume.status, 200);
      const resumeBody = (await resume.json()) as {
        current_run_state: string;
      };
      assert.equal(resumeBody.current_run_state, "active");

      // 从下一轮继续：turn 2 opens a fresh session.
      const finalState = await waitForState(controlPlane, runId, ["complete"]);
      assert.equal(finalState, "complete");
      const executorCalls = supervisor.calls.filter(
        (call) => call.role === "executor",
      );
      assert.equal(executorCalls.length, 2);
      const second = executorCalls[1];
      assert.equal(second?.method, "start");
      assert.ok(second?.sessionId);
      assert.notEqual(second?.sessionId, executorCalls[0]?.sessionId);
      assert.match(second?.text ?? "", /resumed after a pause/);

      const completedRecord = await stateStore.load("loop-it");
      assert.equal(completedRecord?.state, "complete");
      assert.equal(completedRecord?.turn, 2, "resume 从下一轮继续");
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, false);
      assert.equal(service.isRunActive("loop-it"), false);

      const afterResume = await ledgerStore.readDecisionEntries(runId);
      assert.ok(
        afterResume.some(
          (d) =>
            d.decision === "resumed" &&
            d.decision_id === `decision-${runId}-t1-resumed-pause`,
        ),
        "resume signal 落账 (paused → active)",
      );
    },
  );
});

test("pause on a needs_human run → 409 invalid_state (走决策端点); resume on needs_human → 409", async () => {
  await withFixture(async ({ app, controlPlane, ledgerStore }) => {
    // Seed a needs_human run directly through the control-plane.
    await ledgerStore.appendEntry("run-nh", {
      loop_id: "loop-it",
      run_id: "run-nh",
      runtime: {
        adapter: "claude",
        session_ref: "session-nh",
        mode: "plan",
        adapter_capability_snapshot: "realSdk;permissionMode=plan",
      },
      input_refs: {
        intent: "intent://loop-it",
        memory_packet: null,
        workspace: "workspace://loop-it/run-nh",
      },
      verification_refs: {
        verification_input: "not_applicable",
        verifier_runtime: "not_applicable",
        verifier_report: "not_applicable",
        judgment_report: "artifact://run-nh/judgment-report.json",
      },
      learning_refs: {
        control_decision: "ledger://run-nh",
        human_feedback: [],
        external_feedback: [],
      },
      artifact_refs: [],
      final_status: "needs_human",
      created_at: new Date().toISOString(),
    });
    const applied = await controlPlane.applyJudgment({
      loopId: "loop-it",
      runId: "run-nh",
      turn: 1,
      goalId: "intent-1",
      workspaceRef: "workspace://loop-it/run-nh",
      executionOk: true,
      verificationRan: true,
      judgment: HUMAN_JUDGMENT,
      judgmentRef: "artifact://run-nh/judgment-report.json",
      createdAt: new Date().toISOString(),
      budget: {
        max_tokens: 0,
        max_time_minutes: 30,
        max_turns: 3,
        max_retries: 2,
      },
      usage: { tokens: null, timeMinutes: 1 },
    });
    assert.equal(applied.state, "needs_human");

    // 03: 对非 active run pause → 409 invalid_state (needs_human 的 pause
    // 走 POST /api/runs/:id/decision)。
    const pause = await patchLoop(app, "loop-it", { action: "pause" });
    assert.equal(pause.status, 409);
    assert.equal(
      ((await pause.json()) as { error: string }).error,
      "invalid_state",
    );

    // 03: needs_human 不能用本端点 resume（恢复必须携带人工响应）。
    const resume = await patchLoop(app, "loop-it", { action: "resume" });
    assert.equal(resume.status, 409);
    assert.equal(
      ((await resume.json()) as { error: string }).error,
      "invalid_state",
    );

    // Nothing changed: still needs_human, approval item intact.
    const record = await controlPlane.getRunState("loop-it");
    assert.equal(record?.state, "needs_human");
    assert.ok(record?.pending_approval);
  });
});

test("invalid action / non-JSON body → 400 invalid_action; unknown loop → 404 loop_not_found", async () => {
  await withFixture(async ({ app }) => {
    const bogus = await patchLoop(app, "loop-it", { action: "bogus" });
    assert.equal(bogus.status, 400);
    assert.equal(
      ((await bogus.json()) as { error: string }).error,
      "invalid_action",
    );

    const nonJson = await patchLoop(app, "loop-it", "not-json{");
    assert.equal(nonJson.status, 400);
    assert.equal(
      ((await nonJson.json()) as { error: string }).error,
      "invalid_action",
    );

    const missing = await patchLoop(app, "loop-ghost", { action: "pause" });
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "loop_not_found",
    );
  });
});

test("pause with no active run only blocks triggers (loop-level flag); resume clears it", async () => {
  await withFixture(
    async ({ app, loopCardStore, supervisor, controlPlane }) => {
      const pause = await patchLoop(app, "loop-it", { action: "pause" });
      assert.equal(pause.status, 200);
      const body = (await pause.json()) as { current_run_state: string | null };
      assert.equal(body.current_run_state, null, "无活跃 run: 仅阻止后续触发");
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, true);

      const blocked = await triggerRun(app, "loop-it");
      assert.equal(blocked.status, 409);
      assert.equal(
        ((await blocked.json()) as { error: string }).error,
        "loop_paused",
      );

      // resume with no paused run but the loop flag set → 200, flag cleared.
      const resume = await patchLoop(app, "loop-it", { action: "resume" });
      assert.equal(resume.status, 200);
      assert.equal(loopCardStore.getLoop("loop-it")?.paused, false);

      // Trigger works again (completes immediately with autoSucceed). Wait
      // for completion so the background run's ledger writes finish before
      // the fixture cleans up the temp dir.
      supervisor.autoSucceed = true;
      const trigger = await triggerRun(app, "loop-it");
      assert.equal(trigger.status, 201);
      const { run } = (await trigger.json()) as { run: { run_id: string } };
      await waitForState(controlPlane, run.run_id, ["complete"]);
    },
  );
});

test("resume on a non-paused loop (never ran) → 409 invalid_state", async () => {
  await withFixture(async ({ app }) => {
    const resume = await patchLoop(app, "loop-it", { action: "resume" });
    assert.equal(resume.status, 409);
    assert.equal(
      ((await resume.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("archive: active run → 409 (须先 pause); after pause → 200 soft delete; archived loop → 409 on any PATCH; hidden from list/detail", async () => {
  await withFixture(async ({ app, loopCardStore }) => {
    // Turn 1 hangs → active run in flight (no state record yet).
    const trigger = await triggerRun(app, "loop-it");
    assert.equal(trigger.status, 201);

    const blocked = await patchLoop(app, "loop-it", { action: "archive" });
    assert.equal(blocked.status, 409);
    assert.equal(
      ((await blocked.json()) as { error: string }).error,
      "invalid_state",
    );
    assert.equal(loopCardStore.getLoop("loop-it")?.archived, false);

    // 须先 pause → then archive succeeds (paused is not an executing state).
    const pause = await patchLoop(app, "loop-it", { action: "pause" });
    assert.equal(pause.status, 200);
    const archived = await patchLoop(app, "loop-it", { action: "archive" });
    assert.equal(archived.status, 200);
    const archivedBody = (await archived.json()) as {
      loop_id: string;
      current_run_state: string | null;
    };
    assert.equal(archivedBody.loop_id, "loop-it");
    assert.equal(archivedBody.current_run_state, "paused");

    // Soft delete: hidden from the default list + detail, file not deleted.
    const list = await app.request("/");
    const listBody = (await list.json()) as { loops: { id: string }[] };
    assert.equal(listBody.loops.length, 0);
    const detail = await app.request("/loop-it");
    assert.equal(detail.status, 404);
    assert.equal(loopCardStore.getLoop("loop-it")?.archived, true);

    // 对已归档 loop 的任何 PATCH → 409 invalid_state。
    for (const action of ["pause", "resume", "archive"]) {
      const res = await patchLoop(app, "loop-it", { action });
      assert.equal(res.status, 409, `PATCH ${action} on archived loop`);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        "invalid_state",
      );
    }
  });
});

test("archive with no run → 200; trigger on archived loop → 409 loop_archived", async () => {
  await withFixture(async ({ app }) => {
    const archived = await patchLoop(app, "loop-it", { action: "archive" });
    assert.equal(archived.status, 200);
    const body = (await archived.json()) as {
      current_run_state: string | null;
    };
    assert.equal(body.current_run_state, null);

    const trigger = await triggerRun(app, "loop-it");
    assert.equal(trigger.status, 409);
    assert.equal(
      ((await trigger.json()) as { error: string }).error,
      "loop_archived",
    );
  });
});

test("restart recovery: pause mid-turn-1 → 重启后 resume 重建上下文, fresh session 续跑至 complete", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-restart-"));
  try {
    // --- generation 1: start a run, pause it mid-turn-1, then "die" ---
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-it"));
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const events: { type: string }[] = [];
    const eventBus = {
      emit: (event: { type: string }) => events.push(event),
    } as unknown as IEventBus;
    const controlPlane1 = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor1 = new FakeSupervisor(); // hangs (autoSucceed = false)
    const service1 = new LoopRunService({
      supervisor: supervisor1 as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane: controlPlane1,
      sleep: async () => {},
      verifyRunFn: fakeVerify as never,
    });
    const app1 = createLoopsRoutes({
      loopCardStore,
      runService: service1,
      controlPlane: controlPlane1,
    });

    const trigger = await triggerRun(app1, "loop-it");
    assert.equal(trigger.status, 201);
    const { run } = (await trigger.json()) as { run: { run_id: string } };
    const runId = run.run_id;
    await waitFor(() => supervisor1.calls.length === 1, "turn 1 to start");
    const pause = await patchLoop(app1, "loop-it", { action: "pause" });
    assert.equal(pause.status, 200);

    // The paused run_state keeps the killed turn's session for audit/recovery
    // reference (06 #32), and the setup-time contract snapshot is already on
    // disk for context rebuild.
    const pausedRecord = await stateStore.load("loop-it");
    assert.equal(pausedRecord?.state, "paused");
    assert.ok(pausedRecord?.session_ref);
    assert.ok(
      await ledgerStore.readArtifact(runId, "intent-contract.json"),
      "contract snapshot persisted at assembly time",
    );

    // --- generation 2 ("server restart"): fresh in-memory maps, same stores ---
    const controlPlane2 = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor2 = new FakeSupervisor();
    supervisor2.autoSucceed = true;
    const service2 = new LoopRunService({
      supervisor: supervisor2 as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane: controlPlane2,
      sleep: async () => {},
      verifyRunFn: fakeVerify as never,
    });
    const app2 = createLoopsRoutes({
      loopCardStore,
      runService: service2,
      controlPlane: controlPlane2,
    });

    const resume = await patchLoop(app2, "loop-it", { action: "resume" });
    assert.equal(resume.status, 200);

    const finalState = await waitForState(controlPlane2, runId, ["complete"]);
    assert.equal(finalState, "complete");
    const executorCalls = supervisor2.calls.filter(
      (call) => call.role === "executor",
    );
    assert.equal(executorCalls.length, 1);
    assert.equal(
      executorCalls[0]?.method,
      "start",
      "rebuilt run opens a fresh session after restart",
    );
    assert.ok(executorCalls[0]?.sessionId);
    assert.notEqual(
      executorCalls[0]?.sessionId,
      pausedRecord?.session_ref,
      "restart does not reuse the interrupted session",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
