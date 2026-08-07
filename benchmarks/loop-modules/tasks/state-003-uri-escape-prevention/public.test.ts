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

const DATA_DIR = "/tmp/uri-test";

test("resolveUri maps artifact and ledger URIs to loops/ subtree", () => {
  const artifact = resolveUri("artifact://run-1/stdout.log", {
    dataDir: DATA_DIR,
  });
  assert.equal(artifact.kind, "artifact");
  if (artifact.kind === "artifact") {
    assert.equal(
      artifact.filePath,
      join(DATA_DIR, "loops", "artifacts", "run-1", "stdout.log"),
    );
  }

  const ledger = resolveUri("ledger://run-1", { dataDir: DATA_DIR });
  assert.equal(ledger.kind, "ledger");
  if (ledger.kind === "ledger") {
    assert.equal(ledger.decisionsOnly, false);
    assert.equal(
      ledger.filePath,
      join(DATA_DIR, "loops", "runs", "run-1.jsonl"),
    );
  }

  const decisions = resolveUri("ledger://decision-run-1", {
    dataDir: DATA_DIR,
  });
  assert.equal(decisions.kind, "ledger");
  if (decisions.kind === "ledger") {
    assert.equal(decisions.decisionsOnly, true);
  }
});

test("resolveUri maps non-file schemes to structured results", () => {
  assert.deepEqual(resolveUri("intent://loop-1", { dataDir: DATA_DIR }), {
    kind: "intent",
    loopId: "loop-1",
  });
  assert.deepEqual(resolveUri("policy://assisted", { dataDir: DATA_DIR }), {
    kind: "policy",
    profile: "assisted",
  });
  assert.deepEqual(
    resolveUri("workspace://loop-1/run-1", { dataDir: DATA_DIR }),
    {
      kind: "workspace",
      loopId: "loop-1",
      runId: "run-1",
    },
  );
});

test("resolveUri rejects path traversal attempts", () => {
  for (const bad of [
    "artifact://run-1/../../etc/passwd",
    "artifact://../x/stdout.log",
    "ledger://run-1%2e%2e",
    "artifact://run-1/sub/dir.log",
  ]) {
    assert.throws(
      () => resolveUri(bad, { dataDir: DATA_DIR }),
      UriResolutionError,
      `should reject: ${bad}`,
    );
  }
});

test("resolveUri rejects unknown schemes", () => {
  assert.throws(
    () => resolveUri("http://evil.example", { dataDir: DATA_DIR }),
    UriResolutionError,
  );
});
