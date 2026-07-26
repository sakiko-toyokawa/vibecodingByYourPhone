/**
 * uri.ts (resolveUri, 04 URI scheme 解析表) 与 RunLedgerStore.readUri
 * 的测试 —— 引用不再是只写不读, 且解析必须拒绝路径逃逸。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedgerStore } from "./run-ledger-store.js";
import { UriResolutionError, resolveUri } from "./uri.js";

const DATA_DIR = "/tmp/uri-test";

test("resolveUri: artifact/ledger 解析到 loops/ 子树内的正确路径", () => {
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

test("resolveUri: 非文件 scheme 只解析不出路径; 未知 scheme 抛错", () => {
  assert.deepEqual(resolveUri("intent://loop-1", { dataDir: DATA_DIR }), {
    kind: "intent",
    loopId: "loop-1",
  });
  assert.deepEqual(resolveUri("policy://loop_bypass", { dataDir: DATA_DIR }), {
    kind: "policy",
    profile: "loop_bypass",
  });
  assert.deepEqual(
    resolveUri("workspace://loop-1/run-1", { dataDir: DATA_DIR }),
    { kind: "workspace", loopId: "loop-1", runId: "run-1" },
  );
  assert.throws(
    () => resolveUri("http://evil.example", { dataDir: DATA_DIR }),
    UriResolutionError,
  );
});

test("resolveUri: 拒绝路径逃逸 (.. / 分隔符 / 非法字符)", () => {
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

test("readUri: artifact/ledger 引用真实可读 (只写不读修复)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-uri-read-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    await store.writeArtifact("run-1", "stdout.log", "hello trace");
    const artifact = await store.readUri("artifact://run-1/stdout.log");
    assert.equal(artifact, "hello trace");
    // 缺失容忍 ENOENT (04: 超出保留线的引用解析为 missing)
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
    const full = await store.readUri("ledger://run-1");
    assert.ok(full?.includes("decision_entry"));

    // 非文件 scheme 不可读
    await assert.rejects(store.readUri("intent://loop-1"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
