import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import { verifyRun } from "../../../../packages/server/src/loop/verification/verify-run.js";

function makeCard(workspacePath: string): LoopCard {
  return {
    loop: {
      id: "loop-naming-hidden",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-naming-hidden.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

async function withStore(
  fn: (ctx: {
    store: RunLedgerStore;
    workspace: string;
    runId: string;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-naming-hidden-"));
  const workspace = await mkdtemp(join(tmpdir(), "yep-naming-ws-hidden-"));
  try {
    await fn({
      store: new RunLedgerStore({ dataDir }),
      workspace,
      runId: "run-naming-hidden-1",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("verifyRun turn 2 写入 -turn2 产物且规范名不存在", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        turn: 2,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: `artifact://${runId}/stdout-turn2.log`,
      },
      { store },
    );

    assert.equal(
      result.refs.verification_input,
      `artifact://${runId}/verification-input-turn2.json`,
    );
    assert.equal(
      result.refs.judgment_report,
      `artifact://${runId}/judgment-report-turn2.json`,
    );
    assert.equal(
      result.refs.verifier_report,
      `artifact://${runId}/verifier-reports-turn2.json`,
    );

    await store.readArtifact(runId, "verification-input-turn2.json");
    await store.readArtifact(runId, "judgment-report-turn2.json");
    await store.readArtifact(runId, "verifier-reports-turn2.json");
    await store.readArtifact(runId, "verifier-report-static-turn2.json");

    assert.equal(
      await store.readArtifact(runId, "verification-input.json"),
      undefined,
    );
    assert.equal(
      await store.readArtifact(runId, "judgment-report.json"),
      undefined,
    );
    assert.equal(
      await store.readArtifact(runId, "verifier-report-static.json"),
      undefined,
    );
  });
});

test("verifyRun turn 1 不写入 turn 后缀产物", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    const contract = buildIntentContract(card, { runId, source: "manual" });

    await verifyRun(
      {
        card,
        contract,
        runId,
        turn: 1,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store },
    );

    assert.equal(
      await store.readArtifact(runId, "verification-input-turn1.json"),
      undefined,
    );
    assert.equal(
      await store.readArtifact(runId, "judgment-report-turn1.json"),
      undefined,
    );
  });
});
