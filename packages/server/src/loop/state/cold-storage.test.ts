import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunLedgerEntry } from "@yep-anywhere/shared";
import {
  archiveRunToCold,
  listColdArchives,
  readColdLedger,
  removeHotRunStorage,
} from "./cold-storage.js";
import { RunLedgerStore } from "./run-ledger-store.js";

function makeEntry(runId: string): RunLedgerEntry {
  return {
    loop_id: "loop-1",
    run_id: runId,
    runtime: {
      adapter: "claude",
      session_ref: "s",
      mode: "plan",
      adapter_capability_snapshot: "realSdk",
    },
    input_refs: {
      intent: "intent://loop-1",
      memory_packet: null,
      workspace: `workspace://loop-1/${runId}`,
    },
    verification_refs: {
      verification_input: "not_applicable",
      verifier_runtime: "not_applicable",
      verifier_report: "not_applicable",
      judgment_report: "not_applicable",
    },
    learning_refs: {
      control_decision: `ledger://${runId}`,
      human_feedback: [],
      external_feedback: [],
    },
    artifact_refs: [],
    final_status: "complete",
    created_at: "2026-07-01T00:00:00.000Z",
  };
}

async function withTempDir(
  fn: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cold-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("archiveRunToCold + removeHotRunStorage move ledger and artifacts", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-old", makeEntry("run-old"));
    await store.writeArtifact("run-old", "stdout.log", "out");

    const result = await archiveRunToCold(store, "run-old");
    assert.equal(result.archived, true);
    assert.equal((await listColdArchives(store)).length, 1);
    const coldLedger = await readColdLedger(store, "run-old");
    assert.ok(coldLedger?.includes("run_ledger_entry"));

    await removeHotRunStorage(store, "run-old");
    await assert.rejects(
      readFile(join(dataDir, "loops", "runs", "run-old.jsonl")),
    );
    await assert.rejects(stat(join(dataDir, "loops", "artifacts", "run-old")));
    assert.ok((await readColdLedger(store, "run-old"))?.includes("run-old"));
  });
});

test("archiveRunToCold returns false for a run with no hot ledger", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const result = await archiveRunToCold(store, "run-missing");
    assert.equal(result.archived, false);
    assert.equal(result.archivePath, null);
  });
});
