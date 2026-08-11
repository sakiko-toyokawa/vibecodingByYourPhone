/**
 * cleanup.ts (04 容量与清理) 测试:
 *  - 每 loop 超保留线的账本压缩为仅 run_ledger_entry 行;
 *  - artifacts 随账本裁剪, 终态 run 保留 judgment/diff 最小证据;
 *  - 非终态 run 的一切受保护;
 *  - events.jsonl 消费位点前超龄行截断, cursor 前移。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunLedgerEntry, RunStateRecord } from "@yep-anywhere/shared";
import { RunStateStore } from "../control-plane/run-state-store.js";
import { runLoopStorageCleanup } from "./cleanup.js";
import { listColdArchives, readColdLedger } from "./cold-storage.js";
import { LearningEventStore } from "./learning-event-store.js";
import { RunLedgerStore } from "./run-ledger-store.js";

function makeEntry(
  loopId: string,
  runId: string,
  createdAt: string,
  finalStatus: RunLedgerEntry["final_status"] = "complete",
): RunLedgerEntry {
  return {
    loop_id: loopId,
    run_id: runId,
    source: "cron",
    runtime: {
      adapter: "claude",
      session_ref: "s",
      mode: "print",
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
    final_status: finalStatus,
    created_at: createdAt,
  };
}

function makeDecision(runId: string) {
  return {
    decision_id: `decision-${runId}-t1-complete`,
    loop_id: "loop-1",
    run_id: runId,
    decision: "complete" as const,
    reason: "done",
    evidence_refs: [],
    policy_refs: [],
    next_action: "none" as const,
    created_at: "2026-07-01T00:00:00.000Z",
  };
}

function makeState(
  runId: string,
  state: RunStateRecord["state"],
): RunStateRecord {
  return {
    version: 2,
    goal_id: "g",
    run_id: runId,
    state,
    turn: 1,
    intent_version: 1,
    workspace_ref: `workspace://loop-1/${runId}`,
    last_judgment: null,
    pending_approval: null,
    session_ref: null,
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 3,
      max_retries: 2,
      used_tokens: 0,
      used_time_minutes: 0,
      used_turns: 1,
      used_retries: 0,
    },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

async function seedRun(
  store: RunLedgerStore,
  runId: string,
  createdAt: string,
): Promise<void> {
  await store.appendEntry(runId, makeEntry("loop-1", runId, createdAt));
  await store.appendDecisionEntry(runId, makeDecision(runId));
  await store.writeArtifact(runId, "stdout.log", "out");
  await store.writeArtifact(runId, "judgment-report.json", "{}");
  await store.writeArtifact(runId, "diff.patch", "diff");
  await store.writeArtifact(runId, "runtime-events.jsonl", "{}\n");
}

test("超保留线的 run 冷归档 + hot 移除 (终态最小证据入 cold)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cleanup-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    await seedRun(store, "run-new", "2026-07-20T00:00:00.000Z");
    await seedRun(store, "run-old", "2026-07-01T00:00:00.000Z");

    const result = await runLoopStorageCleanup(
      {
        runLedgerStore: store,
        learningEventStore: new LearningEventStore({ dataDir }),
        runStateStore: new RunStateStore({ dataDir }),
        now: () => new Date("2026-07-24T00:00:00.000Z"),
      },
      { keepRunsPerLoop: 1 },
    );

    assert.equal(result.archivesCreated, 1);
    assert.equal(result.ledgersCompressed, 0);
    const oldRaw = await readColdLedger(store, "run-old");
    assert.ok(oldRaw?.includes("run_ledger_entry"));
    assert.ok(oldRaw?.includes("decision_entry"));
    assert.equal((await listColdArchives(store)).length, 1);
    // 新账本原样
    const newRaw = await readFile(
      join(dataDir, "loops", "runs", "run-new.jsonl"),
      "utf-8",
    );
    assert.ok(newRaw.includes("decision_entry"));

    // 旧 run 的 hot artifacts 已整体移除
    await assert.rejects(
      readdir(join(dataDir, "loops", "artifacts", "run-old")),
    );
    // 新 run artifacts 原样
    const newArtifacts = await readdir(
      join(dataDir, "loops", "artifacts", "run-new"),
    );
    assert.equal(
      newArtifacts.filter((name) => name !== "manifest.jsonl").length,
      4,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("非终态 run 的一切受保护 (活跃扫描)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cleanup-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    await seedRun(store, "run-active", "2026-07-01T00:00:00.000Z");
    const stateStore = new RunStateStore({ dataDir });
    await stateStore.save("loop-1", makeState("run-active", "needs_human"));

    const result = await runLoopStorageCleanup(
      {
        runLedgerStore: store,
        learningEventStore: new LearningEventStore({ dataDir }),
        runStateStore: stateStore,
        now: () => new Date("2026-07-24T00:00:00.000Z"),
      },
      { keepRunsPerLoop: 0 },
    );
    assert.equal(result.ledgersCompressed, 0);
    assert.equal(result.artifactFilesDeleted, 0);
    const artifacts = await readdir(
      join(dataDir, "loops", "artifacts", "run-active"),
    );
    assert.equal(
      artifacts.filter((name) => name !== "manifest.jsonl").length,
      4,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("events.jsonl: 消费位点前超龄行截断, cursor 前移, 未消费保留", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-cleanup-"));
  try {
    const eventStore = new LearningEventStore({ dataDir });
    const old = {
      event_id: "e-old",
      run_id: "run-1",
      loop_id: "loop-1",
      decision: "failed" as const,
      judgment_ref: "not_available",
      ledger_refs: [],
      failure_tags: [],
      created_at: "2026-06-01T00:00:00.000Z", // 超 30 天
    };
    const recent = {
      ...old,
      event_id: "e-recent",
      created_at: "2026-07-20T00:00:00.000Z",
    };
    await eventStore.appendEvent(old);
    await eventStore.appendEvent(recent);
    await eventStore.writeCursor(2); // 两行都已消费

    const result = await runLoopStorageCleanup(
      {
        runLedgerStore: new RunLedgerStore({ dataDir }),
        learningEventStore: eventStore,
        runStateStore: new RunStateStore({ dataDir }),
        now: () => new Date("2026-07-24T00:00:00.000Z"),
      },
      {},
    );
    assert.equal(result.eventsTruncated, 1);
    assert.equal(await eventStore.readCursor(), 1); // 前移一行
    const { events } = await eventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_id, "e-recent");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
