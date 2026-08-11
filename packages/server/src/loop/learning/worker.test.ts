import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  DecisionEntry,
  LearningEvent,
  LoopCard,
  RunStateRecord,
} from "@yep-anywhere/shared";
import { RunStateStore } from "../control-plane/run-state-store.js";
import { FailurePatternStore } from "../state/failure-pattern-store.js";
import { LearningEventStore } from "../state/learning-event-store.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import { ProposalStore } from "../state/proposal-store.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import { EvalRunner } from "./eval-runner.js";
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
  extraDeps: Partial<ConstructorParameters<typeof LearningWorker>[0]> = {},
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
        ...extraDeps,
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
      // runtime_blackbox_error (超时类) → 带真实可消费的 adapter_policy
      // 轮次超时 (#13: run-service watchProcess 是真消费者)
      assert.deepEqual(proposal.payload, {
        adapter_policy: { timeout_seconds: 600 },
      });
      assert.ok(proposal.summary.includes(pattern.pattern_id));
      assert.ok(proposal.expected_effect.length > 0);
      assert.ok(proposal.validation_plan.length > 0);
    },
  );
});

test("提案 payload: memory_packet_template_proposal 携带可装配的模板文本 (05 阶段 3 验收 5)", async () => {
  await withWorker(
    async ({ eventStore, patternStore, proposalStore, worker }) => {
      for (const runId of ["run-1", "run-2", "run-3"]) {
        await eventStore.appendEvent(
          makeEvent({
            event_id: `e-${runId}`,
            run_id: runId,
            failure_tags: ["context_error"],
          }),
        );
      }
      await worker.tick();
      const pattern = only(patternStore.list());

      const proposalId = only(proposalStore.list()).proposal_id;
      const proposal = proposalStore.get(proposalId);
      assert.ok(proposal);
      assert.equal(proposal.type, "memory_packet_template_proposal");
      const template = proposal.payload?.memory_packet_template;
      assert.ok(template, "memory packet template payload generated");
      assert.ok(template.includes(pattern.pattern_id));
      assert.ok(template.includes("context_error"));
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

test("生命周期收口: 来源提案 published 后 pattern 标记 resolved (02 §8.3)", async () => {
  await withWorker(
    async ({ eventStore, patternStore, proposalStore, worker }) => {
      // 两次同类失败 → pattern (open)
      await eventStore.appendEvent(
        makeEvent({ event_id: "e1", run_id: "run-1" }),
      );
      await eventStore.appendEvent(
        makeEvent({ event_id: "e2", run_id: "run-2" }),
      );
      await worker.tick();
      const pattern = only(patternStore.list());
      assert.equal(pattern.status, "open");

      // 来源提案走完管线到达 published
      await proposalStore.create({
        proposal_id: "prop-resolve",
        type: "memory_packet_template_proposal",
        source_patterns: [pattern.pattern_id],
        summary: "s",
        target: "loop-1.memory_packet_template",
        expected_effect: "e",
        risk: "low",
        validation_plan: "v",
        status: "draft",
        created_by: "human",
        created_at: "2026-07-23T12:00:00.000Z",
      });
      await proposalStore.transitionStatus("prop-resolve", "shadow", {
        stage: "shadow",
        by: "worker",
      });
      await proposalStore.transitionStatus("prop-resolve", "canary", {
        stage: "regression",
        by: "worker",
      });
      await proposalStore.transitionStatus("prop-resolve", "approved", {
        by: "human",
      });
      await proposalStore.transitionStatus("prop-resolve", "published", {
        stage: "publish",
        by: "human",
      });

      await worker.tick();
      assert.equal(patternStore.get(pattern.pattern_id)?.status, "resolved");

      // 幂等: 再 tick 不重复写 (last_seen_at 不变)
      const before = patternStore.get(pattern.pattern_id)?.last_seen_at;
      await worker.tick();
      assert.equal(patternStore.get(pattern.pattern_id)?.last_seen_at, before);
    },
  );
});

test("golden tasks 同步: open 失败模式 → golden case 入 eval 集 (只增不改)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-golden-"));
  try {
    const card: LoopCard = {
      loop: {
        id: "loop-1",
        trigger: { type: "manual" },
        workspace: { strategy: "direct", path: "/tmp/golden-ws" },
        verification: {
          required: ["static"],
          commands: { static: ["pnpm lint"] },
        },
        persistence: { state_file: ".loop/STATE.md" },
        stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      },
    };
    const loopCardStore = {
      getLoop: (id: string) =>
        id === "loop-1"
          ? {
              id,
              card,
              created_at: "2026-07-01T00:00:00.000Z",
              updated_at: "2026-07-01T00:00:00.000Z",
              archived: false,
            }
          : undefined,
    } as LoopCardStore;
    const eventStore = new LearningEventStore({ dataDir });
    const patternStore = new FailurePatternStore({ dataDir });
    const evalRunner = new EvalRunner({ dataDir });
    const worker = new LearningWorker(
      {
        learningEventStore: eventStore,
        failurePatternStore: patternStore,
        proposalStore: new ProposalStore({ dataDir }),
        runLedgerStore: new RunLedgerStore({ dataDir }),
        loopCardStore,
        evalRunner,
      },
      { now: () => new Date("2026-07-23T12:00:00.000Z") },
    );

    for (const runId of ["run-1", "run-2"]) {
      await eventStore.appendEvent(
        makeEvent({ event_id: `e-${runId}`, run_id: runId }),
      );
    }
    await worker.tick();
    const pattern = only(patternStore.list());

    const cases = await evalRunner.loadCases();
    const golden = cases.find(
      (c) => c.case_id === `golden-${pattern.pattern_id}`,
    );
    assert.ok(golden, "golden case added from failure pattern");
    assert.equal(golden.kind, "command");
    assert.equal(golden.command, "pnpm");
    assert.deepEqual(golden.args, ["lint"]);
    assert.equal(golden.expect, "fail");
    assert.equal(golden.category, "tool_error");
    assert.equal(golden.loop_id, "loop-1");
    assert.equal(golden.workspace, "/tmp/golden-ws");

    // 二次 tick: 只增不改, 不重复入集
    const before = cases.length;
    await worker.tick();
    assert.equal((await evalRunner.loadCases()).length, before);
    worker.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// --- 04 容量与清理: worktree 周期清理接线 ---

/** 与 cleanup.test.ts 同口径的 run_state fixture。 */
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("worktree 清理接线: tick 顺带 prune, 活跃 run 的 worktree 受保护 (04)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-worker-prune-"));
  try {
    // run 态: loop-a 活跃 (保护), loop-b 终态 (可清); 外加一个坏 state
    // 文件验证容错 (跳过不炸 tick)
    const runStateStore = new RunStateStore({ dataDir });
    await runStateStore.save("loop-a", makeState("run-active", "active"));
    await runStateStore.save("loop-b", makeState("run-done", "complete"));
    await writeFile(
      join(dataDir, "loops", "state", "broken.jsonl"),
      "{not json",
    );

    // card: loop-a 声明 cleanup_rule.max_age_days = 7 (经 store 读取,
    // 与 syncGoldenCases 同一访问途径)
    const card: LoopCard = {
      loop: {
        id: "loop-a",
        trigger: { type: "manual" },
        workspace: {
          strategy: "worktree",
          path: "/tmp/ws",
          cleanup_rule: { max_age_days: 7 },
        },
        verification: { required: ["static"] },
        persistence: { state_file: ".loop/STATE.md" },
        stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      },
    };
    const loopCardStore = {
      listLoops: () => [
        {
          id: "loop-a",
          card,
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:00.000Z",
          archived: false,
        },
      ],
    } as LoopCardStore;

    // 两个 30 天未动的 worktree 目录 (非 git 目录 → prune 退化为直接删)
    const protectedDir = join(dataDir, "worktrees", "loop-a", "run-active");
    const staleDir = join(dataDir, "worktrees", "loop-b", "run-done");
    await mkdir(protectedDir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    const old = new Date(Date.now() - 30 * 86_400_000);
    await utimes(protectedDir, old, old);
    await utimes(staleDir, old, old);

    const worker = new LearningWorker(
      {
        learningEventStore: new LearningEventStore({ dataDir }),
        failurePatternStore: new FailurePatternStore({ dataDir }),
        proposalStore: new ProposalStore({ dataDir }),
        runLedgerStore: new RunLedgerStore({ dataDir }),
        runStateStore,
        loopCardStore,
        dataDir,
      },
      { now: () => new Date() },
    );
    // 首个 tick 即跑清理 (lastCleanupAt = 0, 不受 cleanupIntervalMs 节流)
    await worker.tick();
    worker.stop();

    assert.ok(
      await pathExists(protectedDir),
      "活跃 run 的 worktree 超龄也保留",
    );
    assert.equal(await pathExists(staleDir), false, "终态超龄 worktree 被清");
    assert.equal(
      worker.getHealth().consecutiveFailures,
      0,
      "坏 state 文件容错跳过, tick 不记错",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
