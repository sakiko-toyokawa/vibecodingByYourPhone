import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
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
    artifact_refs: [],
    final_status: "complete",
    created_at: new Date().toISOString(),
  };
}

test("corrupt and invalid lines are skipped without crashing", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-1", makeEntry("run-1"));
    const filePath = join(dataDir, "loops", "runs", "run-1.jsonl");
    const existing = await readFile(filePath, "utf-8");
    await writeFile(
      filePath,
      `${existing}{"type":"decision_entry","note":"future"}\nnot-json-at-all\n`,
    );

    const entry = await store.readEntry("run-1");
    assert.equal(entry?.run_id, "run-1");
    assert.deepEqual(await store.readEntry("run-missing"), null);
  });
});

test("fully corrupt ledger file does not crash the reader", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const runsDir = join(dataDir, "loops", "runs");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(runsDir, { recursive: true }),
    );
    await writeFile(join(runsDir, "run-bad.jsonl"), "garbage{{{\n");
    assert.equal(await store.readEntry("run-bad"), null);
  });
});

test("concurrent appends to the same run do not interleave lines", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const runId = "run-concurrent";
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.appendEntry(runId, {
          ...makeEntry(runId),
          created_at: new Date().toISOString(),
        }),
      ),
    );

    const raw = await readFile(
      join(dataDir, "loops", "runs", `${runId}.jsonl`),
      "utf-8",
    );
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 50);
    for (const line of lines) {
      assert.ok(line);
      const parsed = JSON.parse(line);
      assert.equal(parsed.type, "run_ledger_entry");
      assert.equal(parsed.run_id, runId);
    }
  });
});

test("unsafe run_id or artifact names are rejected", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await assert.rejects(() => store.appendEntry("../evil", makeEntry("x")));
    await assert.rejects(() => store.readEntry("a/b"));
    await assert.rejects(() => store.writeArtifact("run-1", "../x", "y"));
  });
});
