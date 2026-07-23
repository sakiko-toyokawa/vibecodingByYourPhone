import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DecisionEntry, LearningEvent } from "@yep-anywhere/shared";
import { FailurePatternStore } from "../state/failure-pattern-store.js";
import { LearningEventStore } from "../state/learning-event-store.js";
import { ProposalStore } from "../state/proposal-store.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import {
  buildSignature,
  normalizeErrorText,
  patternIdFor,
} from "./signature.js";
import { ATTRIBUTION_TO_PROPOSAL, LearningWorker } from "./worker.js";

/** Assert the array has exactly one element and return it. */
function only<T>(items: T[]): T {
  assert.equal(items.length, 1);
  return items[0] as T;
}

function makeEvent(overrides: Partial<LearningEvent> = {}): LearningEvent {
  return {
    event_id: "learn-evt-1",
    run_id: "run-1",
    loop_id: "loop-1",
    decision: "failed",
    judgment_ref: "not_available",
    ledger_refs: ["ledger://run-1"],
    failure_tags: ["tool_error"],
    created_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

function makeDecisionEntry(
  overrides: Partial<DecisionEntry> = {},
): DecisionEntry {
  return {
    decision_id: "decision-run-1-t1-failed",
    loop_id: "loop-1",
    run_id: "run-1",
    decision: "failed",
    reason: "adapter timeout after 30000 ms",
    evidence_refs: [],
    policy_refs: [],
    next_action: "none",
    failure_tags: ["tool_error"],
    created_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

interface Ctx {
  dataDir: string;
  eventStore: LearningEventStore;
  patternStore: FailurePatternStore;
  proposalStore: ProposalStore;
  runLedgerStore: RunLedgerStore;
  worker: LearningWorker;
}

async function withWorker(
  fn: (ctx: Ctx) => Promise<void>,
  workerConfig: ConstructorParameters<typeof LearningWorker>[1] = {},
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-learning-worker-"));
  try {
    const eventStore = new LearningEventStore({ dataDir });
    const patternStore = new FailurePatternStore({ dataDir });
    const proposalStore = new ProposalStore({ dataDir });
    const runLedgerStore = new RunLedgerStore({ dataDir });
    const worker = new LearningWorker(
      {
        learningEventStore: eventStore,
        failurePatternStore: patternStore,
        proposalStore,
        runLedgerStore,
      },
      { now: () => new Date("2026-07-23T12:00:00.000Z"), ...workerConfig },
    );
    await fn({
      dataDir,
      eventStore,
      patternStore,
      proposalStore,
      runLedgerStore,
      worker,
    });
    worker.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

// --- 签名归一化 ---

test("归一化: 剔除 run_id / 时间戳 / 路径 / uuid / 数字等易变部分", () => {
  const a = normalizeErrorText(
    "run-42 failed at 2026-07-23T14:26:11.533Z in C:\\repo\\proj\\src\\a.ts: timeout after 30000 ms (req 9f8b7c6d-1234-1234-1234-abcdefabcdef)",
  );
  const b = normalizeErrorText(
    "run-99 failed at 2026-01-01T00:00:00.000Z in /home/ci/proj/src/a.ts: timeout after 45 s (req 11111111-2222-3333-4444-555555555555)",
  );
  assert.equal(a, b);
  assert.ok(!a.includes("run-42"));
  assert.ok(!a.includes("2026"));
  assert.ok(!a.includes("C:\\"));
  assert.ok(!a.includes("30000"));
});

test("归一化: 不同错误消息得到不同签名; 空证据得到稳定桶", () => {
  const s1 = buildSignature("tool_error", "adapter timeout after 30000 ms");
  const s2 = buildSignature("tool_error", "adapter timeout after 60 s");
  const s3 = buildSignature("tool_error", "permission denied on write");
  const s4 = buildSignature("policy_error", "adapter timeout after 30000 ms");
  assert.equal(s1, s2); // 同形不同参 → 同桶
  assert.notEqual(s1, s3); // 不同消息 → 不同桶
  assert.notEqual(s1, s4); // 不同归因 → 不同桶
  assert.equal(
    buildSignature("tool_error", ""),
    buildSignature("tool_error", "   "),
  );
});

// --- 阈值语义 ---

test("阈值: 单次失败不进模式层, 跨 run 第二次同类失败才入账本", async () => {
  await withWorker(async ({ eventStore, patternStore, worker }) => {
    await eventStore.appendEvent(
      makeEvent({ event_id: "e1", run_id: "run-1" }),
    );
    await worker.tick();
    assert.equal(patternStore.list().length, 0); // 单次不进

    await eventStore.appendEvent(
      makeEvent({ event_id: "e2", run_id: "run-2" }),
    );
    await worker.tick();
    const pattern = only(patternStore.list());
    assert.equal(pattern.occurrence_count, 2);
    assert.deepEqual([...pattern.evidence_runs].sort(), ["run-1", "run-2"]);
    assert.deepEqual(pattern.affected_loop_specs, ["loop-1"]);
    assert.equal(pattern.status, "open");
    assert.equal(pattern.suggested_action, "monitor"); // 未到提案阈值
  });
});

test("阈值: 同一 run 重复事件只计一次 (按 run 去重)", async () => {
  await withWorker(async ({ eventStore, patternStore, worker }) => {
    await eventStore.appendEvent(
      makeEvent({ event_id: "e1", run_id: "run-1" }),
    );
    await eventStore.appendEvent(
      makeEvent({ event_id: "e2", run_id: "run-1" }),
    );
    await worker.tick();
    assert.equal(patternStore.list().length, 0); // 仍是一次发作
  });
});

test("聚类: 决策账本 reason 只差易变部分的失败进同一个 pattern", async () => {
  await withWorker(
    async ({ eventStore, patternStore, runLedgerStore, worker }) => {
      await runLedgerStore.appendDecisionEntry(
        "run-1",
        makeDecisionEntry({
          run_id: "run-1",
          decision_id: "d1",
          reason: "adapter timeout after 30000 ms in run-1",
        }),
      );
      await runLedgerStore.appendDecisionEntry(
        "run-2",
        makeDecisionEntry({
          run_id: "run-2",
          decision_id: "d2",
          reason: "adapter timeout after 45 s in run-2",
        }),
      );
      await eventStore.appendEvent(
        makeEvent({ event_id: "e1", run_id: "run-1" }),
      );
      await eventStore.appendEvent(
        makeEvent({ event_id: "e2", run_id: "run-2" }),
      );
      await worker.tick();
      assert.equal(only(patternStore.list()).occurrence_count, 2);
    },
  );
});

test("更新: 已有 pattern 累计 occurrence_count 与首末次时间", async () => {
  await withWorker(async ({ eventStore, patternStore, worker }) => {
    await eventStore.appendEvent(
      makeEvent({
        event_id: "e1",
        run_id: "run-1",
        created_at: "2026-07-20T10:00:00.000Z",
      }),
    );
    await worker.tick();
    await eventStore.appendEvent(
      makeEvent({
        event_id: "e2",
        run_id: "run-2",
        created_at: "2026-07-23T10:00:00.000Z",
      }),
    );
    await worker.tick();
    const pattern = only(patternStore.list());
    assert.equal(pattern.first_seen_at, "2026-07-20T10:00:00.000Z");
    assert.equal(pattern.last_seen_at, "2026-07-23T10:00:00.000Z");
    assert.equal(
      pattern.pattern_id,
      patternIdFor(buildSignature("tool_error", "failed")),
    );
  });
});

// --- 提案生成与去重 ---

test("提案: occurrence >= 3 的 open pattern 生成模板化提案 (归因→类型映射)", async () => {
  await withWorker(
    async ({ eventStore, patternStore, proposalStore, worker }) => {
      for (const runId of ["run-1", "run-2", "run-3"]) {
        await eventStore.appendEvent(
          makeEvent({
            event_id: `e-${runId}`,
            run_id: runId,
            failure_tags: ["runtime_blackbox_error"],
          }),
        );
      }
      await worker.tick();
      const pattern = only(patternStore.list());
      assert.equal(pattern.occurrence_count, 3);
      assert.equal(pattern.suggested_action, "proposal_required");

      const proposalId = only(proposalStore.list()).proposal_id;
      const proposal = proposalStore.get(proposalId);
      assert.ok(proposal);
      const mapping = ATTRIBUTION_TO_PROPOSAL.runtime_blackbox_error;
      assert.equal(proposal.type, mapping.type); // runtime_adapter_proposal
      assert.equal(proposal.risk, mapping.risk);
      assert.equal(proposal.target, `loop-1.${mapping.targetHint}`);
      assert.deepEqual(proposal.source_patterns, [pattern.pattern_id]);
      assert.equal(proposal.status, "draft");
      assert.equal(proposal.created_by, "worker");
      assert.ok(proposal.summary.includes(pattern.pattern_id));
      assert.ok(proposal.expected_effect.length > 0);
      assert.ok(proposal.validation_plan.length > 0);
    },
  );
});

test("提案去重: 后续 tick 同 pattern 不重复建提案", async () => {
  await withWorker(async ({ eventStore, proposalStore, worker }) => {
    for (const runId of ["run-1", "run-2", "run-3"]) {
      await eventStore.appendEvent(
        makeEvent({ event_id: `e-${runId}`, run_id: runId }),
      );
    }
    await worker.tick();
    assert.equal(proposalStore.list().length, 1);
    // 第四次出现 → pattern 更新, 但提案仍只有一条
    await eventStore.appendEvent(
      makeEvent({ event_id: "e-run-4", run_id: "run-4" }),
    );
    await worker.tick();
    assert.equal(proposalStore.list().length, 1);
  });
});

// --- worker 健壮性 ---

test("无 failure_tags 的事件不进模式层", async () => {
  await withWorker(async ({ eventStore, patternStore, worker }) => {
    await eventStore.appendEvent(
      makeEvent({ event_id: "e1", decision: "complete", failure_tags: [] }),
    );
    await worker.tick();
    assert.equal(patternStore.list().length, 0);
    assert.equal(worker.getHealth().eventsProcessed, 1);
  });
});

test("崩溃隔离: store 抛错的一轮 tick 不 reject, 下一轮恢复正常", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-learning-worker-"));
  try {
    const eventStore = new LearningEventStore({ dataDir });
    await eventStore.appendEvent(makeEvent({ event_id: "e1" }));
    const realRead = eventStore.readEvents.bind(eventStore);
    let failOnce = true;
    eventStore.readEvents = async (fromOffset?: number) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("boom: simulated store crash");
      }
      return realRead(fromOffset);
    };
    const patternStore = new FailurePatternStore({ dataDir });
    const worker = new LearningWorker({
      learningEventStore: eventStore,
      failurePatternStore: patternStore,
      proposalStore: new ProposalStore({ dataDir }),
      runLedgerStore: new RunLedgerStore({ dataDir }),
    });

    await worker.tick(); // 不 reject
    let health = worker.getHealth();
    assert.equal(health.consecutiveFailures, 1);
    assert.ok(health.lastError?.includes("boom"));

    await worker.tick(); // 恢复: 正常消费
    health = worker.getHealth();
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.eventsProcessed, 1);
    worker.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("毒行: 损坏行被跳过不阻塞, cursor 推进越过毒行", async () => {
  await withWorker(async ({ dataDir, eventStore, patternStore, worker }) => {
    await eventStore.appendEvent(
      makeEvent({ event_id: "e1", run_id: "run-1" }),
    );
    const eventsFile = join(dataDir, "loops", "learning", "events.jsonl");
    await appendFile(eventsFile, "{not valid json\n", "utf-8");
    await eventStore.appendEvent(
      makeEvent({ event_id: "e2", run_id: "run-2" }),
    );

    await worker.tick();
    assert.equal(worker.getHealth().eventsProcessed, 2); // 两条好事件都消费
    const pattern = only(patternStore.list());
    assert.equal(pattern.occurrence_count, 2);
    assert.equal(await eventStore.readCursor(), 3); // 含毒行共 3 行
  });
});
