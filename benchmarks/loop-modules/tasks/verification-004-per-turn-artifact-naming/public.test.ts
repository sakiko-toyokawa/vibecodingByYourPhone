import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import {
  verificationArtifactName,
  verifyRun,
} from "../../../../packages/server/src/loop/verification/verify-run.js";

function makeCard(workspacePath: string): LoopCard {
  return {
    loop: {
      id: "loop-naming",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-naming.json" },
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
  const dataDir = await mkdtemp(join(tmpdir(), "yep-naming-"));
  const workspace = await mkdtemp(join(tmpdir(), "yep-naming-ws-"));
  try {
    await fn({
      store: new RunLedgerStore({ dataDir }),
      workspace,
      runId: "run-naming-1",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("verificationArtifactName: turn 1 保持规范名", () => {
  assert.equal(
    verificationArtifactName("judgment-report.json", 1),
    "judgment-report.json",
  );
  assert.equal(
    verificationArtifactName("verification-input.json", 1),
    "verification-input.json",
  );
});

test("verificationArtifactName: turn > 1 带 -turnN 后缀", () => {
  assert.equal(
    verificationArtifactName("judgment-report.json", 2),
    "judgment-report-turn2.json",
  );
  assert.equal(
    verificationArtifactName("verifier-report-static.json", 3),
    "verifier-report-static-turn3.json",
  );
});

test("verifyRun turn 1 产物使用规范名", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store },
    );

    assert.equal(
      result.refs.verification_input,
      `artifact://${runId}/verification-input.json`,
    );
    assert.equal(
      result.refs.judgment_report,
      `artifact://${runId}/judgment-report.json`,
    );
    assert.equal(
      result.refs.verifier_report,
      `artifact://${runId}/verifier-reports.json`,
    );
    await store.readArtifact(runId, "verification-input.json");
    await store.readArtifact(runId, "judgment-report.json");
    await store.readArtifact(runId, "verifier-reports.json");
  });
});
