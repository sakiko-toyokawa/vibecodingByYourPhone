import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport } from "@yep-anywhere/shared";
import type { BusEvent, IEventBus } from "../../watcher/index.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import { ControlPlane, ControlPlaneError } from "./control-plane.js";
import { RunStateStore } from "./run-state-store.js";

class FakeEventBus implements IEventBus {
  readonly events: BusEvent[] = [];
  subscribe(): () => void {
    return () => {};
  }
  emit(event: BusEvent): void {
    this.events.push(event);
  }
  get subscriberCount(): number {
    return 0;
  }
  ofType<T extends BusEvent["type"]>(
    type: T,
  ): Extract<BusEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<
      BusEvent,
      { type: T }
    >[];
  }
}

/** Index into an array under noUncheckedIndexedAccess (fails loudly). */
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  assert.ok(value !== undefined, `expected element at index ${index}`);
  return value;
}

function makeJudgment(overrides: Partial<JudgmentReport> = {}): JudgmentReport {
  return {
    overall: "failed",
    next_action: "retry",
    retryable: true,
    requires_human: false,
    evidence: ["artifact://run-1/verifier-reports.json"],
    unresolved_risks: ["lint errors"],
    ...overrides,
  };
}

const JUDGMENT_REF = "artifact://run-1/judgment-report.json";

function applyInput(overrides: Record<string, unknown> = {}) {
  return {
    loopId: "loop-1",
    runId: "run-1",
    turn: 1,
    goalId: "intent-1",
    workspaceRef: "workspace://loop-1/run-1",
    executionOk: true,
    verificationRan: true,
    judgment: makeJudgment(),
    judgmentRef: JUDGMENT_REF,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function withFixture(
  fn: (ctx: {
    dataDir: string;
    controlPlane: ControlPlane;
    bus: FakeEventBus;
    ledgerStore: RunLedgerStore;
    stateStore: RunStateStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-control-plane-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const bus = new FakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    await fn({ dataDir, controlPlane, bus, ledgerStore, stateStore });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("passed judgment → complete: state persisted, decision ledgered, loop-state-changed emitted", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore, stateStore }) => {
    const result = await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({
          overall: "passed",
          next_action: "complete",
        }),
      }),
    );
    assert.equal(result.state, "complete");

    const record = await stateStore.load("loop-1");
    assert.equal(record?.state, "complete");
    assert.equal(record?.last_judgment, JUDGMENT_REF);
    assert.equal(record?.pending_approval, null);

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(decisions.length, 1);
    assert.equal(at(decisions, 0).decision, "complete");
    assert.equal(at(decisions, 0).loop_id, "loop-1");
    assert.equal(at(decisions, 0).next_action, "none");

    const changes = bus.ofType("loop-state-changed");
    assert.equal(changes.length, 1);
    assert.deepEqual(
      changes.map((e) => ({
        from: e.from_state,
        to: e.to_state,
        loop: e.loop_id,
        run: e.run_id,
        turn: e.turn,
      })),
      [
        {
          from: "active",
          to: "complete",
          loop: "loop-1",
          run: "run-1",
          turn: 1,
        },
      ],
    );
    assert.equal(bus.ofType("run-decision-required").length, 0);
  });
});

test("needs_human bridging: decision-required event, human approve → complete with override落账", async () => {
  await withFixture(async ({ controlPlane, bus, ledgerStore, stateStore }) => {
    const resolved: [string, string][] = [];
    controlPlane.onRunResolved((runId, state) => resolved.push([runId, state]));

    const applied = await controlPlane.applyJudgment(applyInput());
    assert.equal(applied.state, "needs_human");
    assert.equal(controlPlane.currentStateOf("run-1"), "needs_human");

    // run blocks: state file carries the pending approval
    const waiting = await stateStore.load("loop-1");
    assert.equal(waiting?.state, "needs_human");
    assert.equal(
      waiting?.pending_approval?.request_id,
      "decision-run-1-control",
    );

    // run-decision-required payload shape (03 WS 事件契约)
    const required = bus.ofType("run-decision-required");
    assert.equal(required.length, 1);
    const payload = at(required, 0);
    assert.equal(payload.loop_id, "loop-1");
    assert.equal(payload.run_id, "run-1");
    assert.equal(payload.request_id, "decision-run-1-control");
    assert.equal(payload.action, "retry"); // judgment's next_action
    assert.equal(payload.risk, "unrated");
    assert.deepEqual(payload.evidence_refs, [
      "artifact://run-1/verifier-reports.json",
    ]);
    assert.deepEqual(payload.options, [
      "approve",
      "reject",
      "request_changes",
      "pause",
    ]);
    assert.equal(typeof payload.reason, "string");
    assert.equal(typeof payload.timestamp, "string");

    // human approves → complete, override recorded in the decision ledger
    const runState = await controlPlane.submitDecision(
      "run-1",
      "approve",
      "人工确认 lint 报错可接受",
    );
    assert.equal(runState.state, "complete");
    assert.equal(runState.pending_approval, null);

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(decisions.length, 2);
    const human = at(decisions, 1);
    assert.equal(human.decision, "complete");
    assert.equal(human.feedback, "人工确认 lint 报错可接受");
    assert.deepEqual(human.override, {
      original_judgment_ref: JUDGMENT_REF,
      reason: "human approved the run, overriding the judgment",
      feedback: "人工确认 lint 报错可接受",
    });

    const changes = bus.ofType("loop-state-changed");
    assert.equal(changes.length, 2);
    assert.equal(at(changes, 1).from_state, "needs_human");
    assert.equal(at(changes, 1).to_state, "complete");

    assert.deepEqual(resolved, [["run-1", "complete"]]);
  });
});

test("human reject → failed with override; request_changes requires feedback", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    await controlPlane.applyJudgment(applyInput());

    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "request_changes"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_decision",
    );

    const runState = await controlPlane.submitDecision(
      "run-1",
      "request_changes",
      "请先修掉 lint 再交付",
    );
    assert.equal(runState.state, "failed");

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const human = at(decisions, 1);
    assert.equal(human.decision, "failed");
    assert.equal(human.feedback, "请先修掉 lint 再交付");
    assert.equal(human.override?.original_judgment_ref, JUDGMENT_REF);
  });
});

test("human reject terminates as failed", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    await controlPlane.applyJudgment(applyInput());
    const runState = await controlPlane.submitDecision("run-1", "reject");
    assert.equal(runState.state, "failed");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, 1).decision, "failed");
    assert.equal(
      at(decisions, 1).override?.original_judgment_ref,
      JUDGMENT_REF,
    );
  });
});

test("human pause → paused (TODO phase-2 resume), recorded without override", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    await controlPlane.applyJudgment(applyInput());
    const runState = await controlPlane.submitDecision(
      "run-1",
      "pause",
      "明天再看",
    );
    assert.equal(runState.state, "paused");
    const decisions = await ledgerStore.readDecisionEntries("run-1");
    assert.equal(at(decisions, 1).decision, "paused");
    assert.equal(at(decisions, 1).next_action, "wait_for_resume_signal");
    assert.equal(at(decisions, 1).override, undefined);
  });
});

test("decision on a non-waiting run → invalid_state; unknown run → run_not_found", async () => {
  await withFixture(async ({ controlPlane, ledgerStore }) => {
    // A run that completed (not needs_human)
    await controlPlane.applyJudgment(
      applyInput({
        judgment: makeJudgment({ overall: "passed", next_action: "complete" }),
      }),
    );
    // Give it a run_ledger_entry so existence is detectable like in production
    // (control-plane decision lines alone also prove existence via memory).
    await assert.rejects(
      () => controlPlane.submitDecision("run-1", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "invalid_state",
    );

    await assert.rejects(
      () => controlPlane.submitDecision("run-ghost", "approve"),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "run_not_found",
    );

    assert.equal((await ledgerStore.readDecisionEntries("run-1")).length, 1);
  });
});

test("waiting runs survive a control-plane restart (state-file scan fallback)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-control-plane-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const first = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    await first.applyJudgment(applyInput());

    // New instance (fresh memory) over the same files
    const bus = new FakeEventBus();
    const second = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus: bus,
    });
    const runState = await second.submitDecision("run-1", "approve", "ok");
    assert.equal(runState.state, "complete");
    assert.equal(bus.ofType("loop-state-changed").length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("run-state store tolerates a corrupt state file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-state-"));
  try {
    const stateStore = new RunStateStore({ dataDir });
    const stateDir = join(dataDir, "loops", "state");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(stateDir, { recursive: true }),
    );
    await writeFile(join(stateDir, "bad-loop.json"), "{{{not json\n");
    assert.equal(await stateStore.load("bad-loop"), null);
    assert.deepEqual(await stateStore.list(), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
