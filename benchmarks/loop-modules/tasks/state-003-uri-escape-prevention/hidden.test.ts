import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";
import {
  UriResolutionError,
  resolveUri,
} from "../../../../packages/server/src/loop/state/uri.js";

test("readUri uses the resolver and remains inside loops/ subtree", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-uri-bench-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    await store.writeArtifact("run-1", "stdout.log", "hello trace");
    assert.equal(
      await store.readUri("artifact://run-1/stdout.log"),
      "hello trace",
    );
    assert.equal(await store.readUri("artifact://run-1/gone.log"), undefined);

    await store.appendDecisionEntry("run-1", {
      decision_id: "decision-run-1-t1-complete",
      loop_id: "loop-1",
      run_id: "run-1",
      decision: "complete",
      reason: "done",
      evidence_refs: [],
      policy_refs: [],
      next_action: "none",
      created_at: new Date().toISOString(),
    });
    const decisions = await store.readUri("ledger://decision-run-1");
    assert.ok(decisions?.includes("decision-run-1-t1-complete"));

    await assert.rejects(store.readUri("intent://loop-1"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("path traversal in any URI segment is rejected", () => {
  const traversalCases = [
    "artifact://run-1/..%2Fetc%2Fpasswd",
    "artifact://run-1/foo%2Fbar",
    "ledger://decision-../escape",
    "workspace://loop-1/../run-1",
    "workspace://../loop/run-1",
    "intent://loop-1/../other",
    "policy://../profile",
    "artifact://run-1/sub:dir.log",
  ];
  for (const bad of traversalCases) {
    assert.throws(
      () => resolveUri(bad, { dataDir: "/tmp/uri-test" }),
      UriResolutionError,
      `should reject: ${bad}`,
    );
  }
});

test("safe names with dots, dashes, and underscores are allowed", () => {
  assert.doesNotThrow(() =>
    resolveUri("artifact://run_1.2-3/file-turn2.log", {
      dataDir: "/tmp/uri-test",
    }),
  );
  assert.doesNotThrow(() =>
    resolveUri("ledger://loop-run_2026-001", { dataDir: "/tmp/uri-test" }),
  );
});
