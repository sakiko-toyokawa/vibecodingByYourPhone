import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JudgmentReport, RunLedgerEntry } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import {
  ControlPlane,
  LoopRunService,
  RunLedgerStore,
  RunStateStore,
} from "../loop/index.js";
import type { LoopCardStore } from "../loop/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { createRunsRoutes } from "./runs.js";

const JUDGMENT: JudgmentReport = {
  overall: "failed",
  next_action: "needs_human",
  retryable: false,
  requires_human: true,
  evidence: ["artifact://run-1/verifier-reports.json"],
  unresolved_risks: ["lint errors"],
};

/** Index into an array under noUncheckedIndexedAccess (fails loudly). */
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  assert.ok(value !== undefined, `expected element at index ${index}`);
  return value;
}

function makeLedgerEntry(runId: string): RunLedgerEntry {
  return {
    loop_id: "loop-1",
    run_id: runId,
    runtime: {
      adapter: "claude",
      session_ref: "session-1",
      mode: "plan",
      adapter_capability_snapshot: "realSdk;permissionMode=plan",
    },
    input_refs: {
      intent: "intent://loop-1",
      memory_packet: null,
      workspace: `workspace://loop-1/${runId}`,
    },
    verification_refs: {
      verification_input: `artifact://${runId}/verification-input.json`,
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: `artifact://${runId}/verifier-reports.json`,
      judgment_report: `artifact://${runId}/judgment-report.json`,
    },
    learning_refs: {
      control_decision: `ledger://${runId}`,
      human_feedback: [],
      external_feedback: [],
    },
    artifact_refs: [`artifact://${runId}/stdout.log`],
    final_status: "needs_human",
    created_at: new Date().toISOString(),
  };
}

async function withFixture(
  fn: (ctx: {
    app: Hono;
    controlPlane: ControlPlane;
    ledgerStore: RunLedgerStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-runs-routes-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: new RunStateStore({ dataDir }),
      runLedgerStore: ledgerStore,
    });
    const runService = new LoopRunService({
      // GET /:id only touches the ledger store / control-plane; the
      // supervisor and card store are unused on this path.
      supervisor: {} as Supervisor,
      loopCardStore: {} as LoopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
    });
    const app = createRunsRoutes({ runService, controlPlane });
    await fn({ app, controlPlane, ledgerStore });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Seed a needs_human run (ledger entry + judgment artifact + pending gate). */
async function seedNeedsHumanRun(
  controlPlane: ControlPlane,
  ledgerStore: RunLedgerStore,
  runId = "run-1",
): Promise<void> {
  await ledgerStore.appendEntry(runId, makeLedgerEntry(runId));
  await ledgerStore.writeArtifact(
    runId,
    "judgment-report.json",
    JSON.stringify(JUDGMENT),
  );
  const applied = await controlPlane.applyJudgment({
    loopId: "loop-1",
    runId,
    turn: 1,
    goalId: "intent-1",
    workspaceRef: `workspace://loop-1/${runId}`,
    executionOk: true,
    verificationRan: true,
    judgment: JUDGMENT,
    judgmentRef: `artifact://${runId}/judgment-report.json`,
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
}

function postDecision(app: Hono, runId: string, body: unknown) {
  return app.request(`/${runId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("needs_human run accepts approve → 200 active + override落账（阶段 2 恢复执行）; replay → 409 invalid_state", async () => {
  await withFixture(async ({ app, controlPlane, ledgerStore }) => {
    await seedNeedsHumanRun(controlPlane, ledgerStore);

    const res = await postDecision(app, "run-1", {
      decision: "approve",
      feedback: "人工强判通过",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      run_state: { state: string; pending_approval: unknown };
    };
    // 阶段 2 完整迁移表：approve → active（携带人工响应恢复执行）
    assert.equal(body.run_state.state, "active");
    assert.equal(body.run_state.pending_approval, null);

    const decisions = await ledgerStore.readDecisionEntries("run-1");
    const human = at(decisions, decisions.length - 1);
    assert.equal(human.decision, "resumed");
    assert.equal(
      human.override?.original_judgment_ref,
      "artifact://run-1/judgment-report.json",
    );
    assert.equal(human.feedback, "人工强判通过");

    // Run no longer in needs_human → 409 invalid_state
    const replay = await postDecision(app, "run-1", { decision: "approve" });
    assert.equal(replay.status, 409);
    const replayBody = (await replay.json()) as { error: string };
    assert.equal(replayBody.error, "invalid_state");
  });
});

test("decision on an unknown run → 404 run_not_found", async () => {
  await withFixture(async ({ app }) => {
    const res = await postDecision(app, "run-ghost", { decision: "approve" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: "run_not_found",
      message: "Run 'run-ghost' not found",
    });
  });
});

test("invalid decision payloads → 400 invalid_decision", async () => {
  await withFixture(async ({ app, controlPlane, ledgerStore }) => {
    await seedNeedsHumanRun(controlPlane, ledgerStore);

    const badEnum = await postDecision(app, "run-1", { decision: "bogus" });
    assert.equal(badEnum.status, 400);
    assert.equal(
      ((await badEnum.json()) as { error: string }).error,
      "invalid_decision",
    );

    // request_changes requires feedback (03: 作为下一轮上下文注入)
    const noFeedback = await postDecision(app, "run-1", {
      decision: "request_changes",
    });
    assert.equal(noFeedback.status, 400);
    assert.equal(
      ((await noFeedback.json()) as { error: string }).error,
      "invalid_decision",
    );
  });
});

test("GET /:id ledger_summary carries the judgment_report 摘要 and decision refs", async () => {
  await withFixture(async ({ app, controlPlane, ledgerStore }) => {
    await seedNeedsHumanRun(controlPlane, ledgerStore);
    await postDecision(app, "run-1", { decision: "reject" });

    const res = await app.request("/run-1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      run: { state: string };
      ledger_summary: {
        judgment_report_ref: string | null;
        judgment_summary: {
          overall: string;
          next_action: string;
          requires_human: boolean;
        } | null;
        decision_refs: string[];
        verifier_report_refs: string[];
      };
    };
    assert.equal(body.run.state, "failed"); // human reject terminated the run
    assert.equal(
      body.ledger_summary.judgment_report_ref,
      "artifact://run-1/judgment-report.json",
    );
    assert.deepEqual(body.ledger_summary.judgment_summary, {
      overall: "failed",
      next_action: "needs_human",
      requires_human: true,
    });
    assert.deepEqual(body.ledger_summary.decision_refs, [
      "ledger://decision-run-1",
    ]);
    assert.deepEqual(body.ledger_summary.verifier_report_refs, [
      "artifact://run-1/verifier-reports.json",
    ]);
  });
});

test("GET /:id on an unknown run → 404 run_not_found", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.request("/run-ghost");
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "run_not_found",
    );
  });
});
