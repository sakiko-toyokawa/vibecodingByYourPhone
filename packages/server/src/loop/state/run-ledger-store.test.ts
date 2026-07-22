import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type RunLedgerEntry,
  RunLedgerEntrySchema,
} from "@yep-anywhere/shared";
import { RunLedgerStore } from "./run-ledger-store.js";

function makeEntry(runId: string, loopId = "test-loop"): RunLedgerEntry {
  return {
    loop_id: loopId,
    run_id: runId,
    runtime: {
      adapter: "claude",
      session_ref: "session-123",
      mode: "plan",
      adapter_capability_snapshot: "realSdk;permissionMode=plan",
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

async function withTempDir(
  fn: (dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-ledger-"));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("appendEntry writes a typed JSONL line that validates against the schema", async () => {
  await withTempDir(async (dataDir) => {
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

    const read = await store.readEntry("run-1");
    assert.deepEqual(read, entry);
  });
});

test("multiple appends land as separate lines in order", async () => {
  await withTempDir(async (dataDir) => {
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

test("readEntry returns the latest turn's entry for multi-turn runs", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.appendEntry("run-1", {
      ...makeEntry("run-1"),
      final_status: "retry",
    });
    await store.appendEntry("run-1", {
      ...makeEntry("run-1"),
      final_status: "complete",
    });

    // 02 §8.1: 每次 retry 产生独立 entry；readEntry 以最后一轮为准
    const read = await store.readEntry("run-1");
    assert.equal(read?.final_status, "complete");
  });
});

test("readEntry skips corrupt lines and still finds the entry", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const runsDir = join(dataDir, "loops", "runs");
    await store.appendEntry("run-1", makeEntry("run-1"));
    // Simulate a torn write (bad last line) plus a decision_entry line
    const filePath = join(runsDir, "run-1.jsonl");
    const existing = await readFile(filePath, "utf-8");
    await writeFile(
      filePath,
      `${existing}{"type":"decision_entry","note":"future"}\nnot-json-at-all\n`,
    );

    const read = await store.readEntry("run-1");
    assert.equal(read?.run_id, "run-1");
  });
});

test("a fully corrupt ledger file does not crash the reader", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    const runsDir = join(dataDir, "loops", "runs");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(runsDir, { recursive: true }),
    );
    await writeFile(join(runsDir, "run-bad.jsonl"), "garbage{{{\n");
    assert.equal(await store.readEntry("run-bad"), null);
    assert.equal(await store.readEntry("run-missing"), null);
  });
});

test("artifacts round-trip; missing artifacts read as undefined", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await store.writeArtifact("run-1", "stdout.log", "report text");
    assert.equal(
      await store.readArtifact("run-1", "stdout.log"),
      "report text",
    );
    assert.equal(await store.readArtifact("run-1", "missing.log"), undefined);
  });
});

test("listRunIds lists ledger files and tolerates a missing runs dir", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    assert.deepEqual(await store.listRunIds(), []);
    await store.appendEntry("run-b", makeEntry("run-b"));
    await store.appendEntry("run-a", makeEntry("run-a"));
    assert.deepEqual((await store.listRunIds()).sort(), ["run-a", "run-b"]);
  });
});

test("unsafe names (path traversal) are rejected", async () => {
  await withTempDir(async (dataDir) => {
    const store = new RunLedgerStore({ dataDir });
    await assert.rejects(() => store.appendEntry("../evil", makeEntry("x")));
    await assert.rejects(() => store.readEntry("a/b"));
    await assert.rejects(() => store.writeArtifact("run-1", "../x", "y"));
  });
});
