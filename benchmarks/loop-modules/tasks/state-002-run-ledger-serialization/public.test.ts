import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import { RunLedgerEntrySchema } from "../../../../packages/shared/src/index.ts";
import type { RunLedgerEntry } from "../../../../packages/shared/src/index.ts";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

function makeEntry(runId: string, loopId = "loop-a"): RunLedgerEntry {
  return {
    loop_id: loopId,
    run_id: runId,
    runtime: {
      adapter: "claude",
      session_ref: "session-123",
      mode: "plan",
      adapter_capability_snapshot: "realSdk",
    },
    input_refs: {
      intent: `intent://${loopId}`,
      memory_packet: null,
      workspace: `workspace://${loopId}/${runId}`,
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
    artifact_refs: [`artifact://${runId}/stdout.log`],
    final_status: "complete",
    created_at: new Date().toISOString(),
  };
}

test("appendEntry writes a typed JSONL line that validates", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const entry = makeEntry("run-1");
    await store.appendEntry("run-1", entry);

    const raw = await readFile(
      join(dataDir, "loops", "runs", "run-1.jsonl"),
      "utf-8",
    );
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    assert.equal(line.type, "run_ledger_entry");
    const { type: _type, ...rest } = line;
    assert.doesNotThrow(() => RunLedgerEntrySchema.parse(rest));
    assert.deepEqual(await store.readEntry("run-1"), entry);
  });
});

test("multiple appends land as separate ordered lines", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-1", makeEntry("run-1"));
    await store.appendEntry("run-1", makeEntry("run-1"));

    const raw = await readFile(
      join(dataDir, "loops", "runs", "run-1.jsonl"),
      "utf-8",
    );
    assert.equal(raw.trim().split("\n").length, 2);
  });
});

test("readEntry returns the latest run_ledger_entry for multi-turn runs", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-1", {
      ...makeEntry("run-1"),
      final_status: "retry",
    });
    await store.appendEntry("run-1", {
      ...makeEntry("run-1"),
      final_status: "complete",
    });

    const latest = await store.readEntry("run-1");
    assert.equal(latest?.final_status, "complete");
  });
});

test("decision entries are stored in the same file and read separately", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-1", makeEntry("run-1"));
    await store.appendDecisionEntry("run-1", {
      decision_id: "decision-1",
      loop_id: "loop-a",
      run_id: "run-1",
      decision: "complete",
      reason: "done",
      evidence_refs: [],
      policy_refs: [],
      next_action: "none",
      created_at: new Date().toISOString(),
    });

    const decisions = await store.readDecisionEntries("run-1");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision, "complete");

    const raw = await readFile(
      join(dataDir, "loops", "runs", "run-1.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]);
    assert.ok(lines[1]);
    assert.equal(JSON.parse(lines[0]).type, "run_ledger_entry");
    assert.equal(JSON.parse(lines[1]).type, "decision_entry");
  });
});
