/**
 * routes-001-loop-crud-pause-resume public tests
 *
 * Verify HTTP route behavior for loop CRUD, pause/resume/archive, and the
 * error-code contract from docs/spec/03-API契约.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard, RunState } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { ControlPlane } from "../../../../packages/server/src/loop/control-plane/control-plane.js";
import { RunStateStore } from "../../../../packages/server/src/loop/control-plane/run-state-store.js";
import { LoopRunService } from "../../../../packages/server/src/loop/run-service.js";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import { TriggerQueueStore } from "../../../../packages/server/src/loop/state/trigger-queue-store.js";
import { drainPendingTriggers } from "../../../../packages/server/src/loop/trigger/trigger-dispatcher.js";
import type { VerifyRunResult } from "../../../../packages/server/src/loop/verification/verify-run.js";
import { createLoopsRoutes } from "../../../../packages/server/src/routes/loops.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import {
  FakeSupervisor,
  asSupervisor,
} from "../../fixtures/fake-supervisor.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

const SESSION_ID = "session-routes-001";

function makeCard(id: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/routes-001-ws" },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

const PASSED_JUDGMENT = {
  overall: "passed" as const,
  next_action: "complete" as const,
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: [],
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
  loopCardStore: LoopCardStore;
  controlPlane: ControlPlane;
  supervisor: FakeSupervisor;
}

async function withFixture(
  fn: (ctx: Fixture) => Promise<void>,
  options: { autoSucceed?: boolean; cards?: string[] } = {},
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    for (const id of options.cards ?? ["loop-it"]) {
      await loopCardStore.createLoop(makeCard(id));
    }
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const { bus: eventBus } = createFakeEventBus();
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor = new FakeSupervisor({
      sessionId: SESSION_ID,
      autoSucceed: options.autoSucceed ?? false,
    });
    const service = new LoopRunService({
      supervisor: asSupervisor(supervisor),
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: fakeVerify as never,
    });
    const triggerQueueStore = new TriggerQueueStore({ dataDir });
    const app = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
      triggerQueueStore,
      drainPendingTriggers: (loopId, options) =>
        drainPendingTriggers(
          {
            queueStore: triggerQueueStore,
            runService: service,
            controlPlane,
          },
          loopId,
          options,
        ),
    });
    await fn({ app, loopCardStore, controlPlane, supervisor });
  });
}

async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 5000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = controlPlane.currentStateOf(runId);
    if (state && expected.includes(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("POST /api/loops creates a loop and GET /api/loops lists it", async () => {
  await withFixture(async ({ app }) => {
    const create = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeCard("loop-new")),
    });
    assert.equal(create.status, 201);
    const createBody = (await create.json()) as { loop: { id: string } };
    assert.equal(createBody.loop.id, "loop-new");

    const list = await app.request("/");
    assert.equal(list.status, 200);
    const ids = ((await list.json()) as { loops: { id: string }[] }).loops.map(
      (l) => l.id,
    );
    assert.ok(ids.includes("loop-it"));
    assert.ok(ids.includes("loop-new"));
  });
});

test("POST /api/loops with duplicate id returns 409 loop_exists", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeCard("loop-it")),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "loop_exists");
  });
});

test("POST /api/loops with invalid body returns 400 invalid_loop_card", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loop: { id: "bad" } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_loop_card");
  });
});

test("GET /api/loops/:id returns loop and run state; 404 for archived", async () => {
  await withFixture(async ({ app, loopCardStore }) => {
    const detail = await app.request("/loop-it");
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      loop: { id: string };
      current_run_state: unknown;
      last_run_summary: unknown;
    };
    assert.equal(body.loop.id, "loop-it");
    assert.equal(body.current_run_state, null);
    assert.equal(body.last_run_summary, null);

    await loopCardStore.archiveLoop("loop-it");
    const archived = await app.request("/loop-it");
    assert.equal(archived.status, 404);
  });
});

test("GET /api/loops/:id returns 404 loop_not_found for unknown loop", async () => {
  await withFixture(async ({ app }) => {
    const res = await app.request("/loop-ghost");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "loop_not_found");
  });
});

test("PATCH pause / resume round-trip: active run paused, then resumes to complete", async () => {
  await withFixture(async ({ app, controlPlane, supervisor }) => {
    const trigger = await app.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(trigger.status, 201);
    const { run } = (await trigger.json()) as { run: { run_id: string } };

    const pause = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(pause.status, 200);
    const pauseBody = (await pause.json()) as {
      loop_id: string;
      current_run_state: string;
    };
    assert.equal(pauseBody.loop_id, "loop-it");
    assert.equal(pauseBody.current_run_state, "paused");

    // Resume needs the supervisor to succeed so the run can complete.
    supervisor.autoSucceed = true;
    const resume = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(resume.status, 200);
    const resumeBody = (await resume.json()) as { current_run_state: string };
    assert.equal(resumeBody.current_run_state, "active");

    const final = await waitForState(controlPlane, run.run_id, ["complete"]);
    assert.equal(final, "complete");
  });
});

test("PATCH invalid action / non-JSON body / unknown loop error codes", async () => {
  await withFixture(async ({ app }) => {
    const invalid = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "frobnicate" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: string }).error,
      "invalid_action",
    );

    const nonJson = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });
    assert.equal(nonJson.status, 400);
    assert.equal(
      ((await nonJson.json()) as { error: string }).error,
      "invalid_action",
    );

    const missing = await app.request("/loop-ghost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "loop_not_found",
    );
  });
});

test("PATCH archive: active run blocks with 409, after pause archive succeeds and hides loop", async () => {
  await withFixture(async ({ app, loopCardStore }) => {
    const trigger = await app.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(trigger.status, 201);

    const blocked = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(
      ((await blocked.json()) as { error: string }).error,
      "invalid_state",
    );

    const pause = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(pause.status, 200);

    const archive = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    assert.equal(archive.status, 200);
    const archiveBody = (await archive.json()) as {
      loop_id: string;
      current_run_state: string;
    };
    assert.equal(archiveBody.loop_id, "loop-it");
    assert.equal(loopCardStore.getLoop("loop-it")?.archived, true);

    const list = await app.request("/");
    assert.equal(((await list.json()) as { loops: unknown[] }).loops.length, 0);

    const resumingArchived = await app.request("/loop-it", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(resumingArchived.status, 409);
    assert.equal(
      ((await resumingArchived.json()) as { error: string }).error,
      "invalid_state",
    );
  });
});

test("POST /api/loops/:id/runs on archived loop returns 409 loop_archived", async () => {
  await withFixture(async ({ app, loopCardStore }) => {
    await loopCardStore.archiveLoop("loop-it");
    const res = await app.request("/loop-it/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "loop_archived",
    );
  });
});

test("GET /api/loops status filter and pagination query params are honored", async () => {
  await withFixture(
    async ({ app, loopCardStore }) => {
      await loopCardStore.setPaused("loop-paused", true);

      const all = await app.request("/?limit=10");
      assert.equal(all.status, 200);
      assert.equal(
        ((await all.json()) as { loops: unknown[] }).loops.length,
        2,
      );

      const paused = await app.request("/?status=paused");
      assert.equal(paused.status, 200);
      const pausedBody = (await paused.json()) as {
        loops: { id: string }[];
      };
      assert.equal(pausedBody.loops.length, 1);
      assert.equal(pausedBody.loops[0]?.id, "loop-paused");

      const offset = await app.request("/?limit=1&offset=1");
      assert.equal(offset.status, 200);
      assert.equal(
        ((await offset.json()) as { loops: unknown[] }).loops.length,
        1,
      );
    },
    { cards: ["loop-it", "loop-paused"] },
  );
});
