import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { EventBus } from "../../watcher/EventBus.js";
import type { BusEvent } from "../../watcher/EventBus.js";
import { LearningEventStore } from "../state/learning-event-store.js";
import { LoopCardStore } from "../state/loop-card-store.js";
import { LoopProposalLifecycleService } from "./lifecycle-service.js";
import { LoopProposalStore } from "./loop-proposal-store.js";
import { LOOP_PROPOSAL_BEGIN, LOOP_PROPOSAL_END } from "./loop-proposal.js";

function parentCard(overrides: Record<string, unknown> = {}): LoopCard {
  return {
    loop: {
      id: "parent-loop",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 5, max_time_minutes: 60, max_retries: 1 },
      can_propose_loops: true,
      ...overrides,
    },
  } as LoopCard;
}

function proposalText(childId: string, reason = "值得专项跟进"): string {
  const card = {
    loop: {
      id: childId,
      trigger: { type: "schedule", cron: "0 10 * * *" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 1 },
      handoff: { task: "专项跟进" },
    },
  };
  return [
    "报告正文。",
    LOOP_PROPOSAL_BEGIN,
    JSON.stringify({ card, reason }),
    LOOP_PROPOSAL_END,
  ].join("\n");
}

interface Fixture {
  dataDir: string;
  loopCardStore: LoopCardStore;
  proposalStore: LoopProposalStore;
  learningEventStore: LearningEventStore;
  eventBus: EventBus;
  events: BusEvent[];
  lifecycle: LoopProposalLifecycleService;
}

async function makeFixture(
  options: { dailyProposalLimit?: number; maxActiveLoops?: number } = {},
): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-proposal-"));
  const loopCardStore = new LoopCardStore({ dataDir });
  await loopCardStore.initialize();
  await loopCardStore.createLoop(parentCard());
  const proposalStore = new LoopProposalStore({ dataDir });
  await proposalStore.initialize();
  const learningEventStore = new LearningEventStore({ dataDir });
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const lifecycle = new LoopProposalLifecycleService({
    proposalStore,
    loopCardStore,
    eventBus,
    learningEventStore,
    ...options,
  });
  return {
    dataDir,
    loopCardStore,
    proposalStore,
    learningEventStore,
    eventBus,
    events,
    lifecycle,
  };
}

test("LoopProposalStore persists proposals across re-initialize", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.equal(proposal?.state, "pending_approval");

    const reloaded = new LoopProposalStore({ dataDir: fixture.dataDir });
    await reloaded.initialize();
    const stored = reloaded.findById(proposal?.proposal_id ?? "");
    assert.equal(stored?.state, "pending_approval");
    assert.equal(stored?.card.loop.id, "child-loop");
    assert.equal(stored?.parent_loop_id, "parent-loop");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("registerLoopProposal parks a clamped proposal and emits an event", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.equal(proposal?.state, "pending_approval");
    // 钳制层已生效：血缘写入、提案权关闭、managed 工作区
    assert.equal(proposal?.card.loop.parent_loop_id, "parent-loop");
    assert.equal(proposal?.card.loop.can_propose_loops, false);
    assert.ok(proposal?.card.loop.workspace.path?.startsWith("managed://"));
    const changed = fixture.events.find(
      (event) => event.type === "loop-proposal-changed",
    );
    assert.ok(changed);
    assert.equal(
      changed.type === "loop-proposal-changed" && changed.to_state,
      "pending_approval",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("registerLoopProposal drops proposals without a grant or valid block", async () => {
  const fixture = await makeFixture();
  try {
    // 无提案块
    assert.equal(
      await fixture.lifecycle.registerLoopProposal(
        "parent-loop",
        "run-1",
        "plain report",
      ),
      null,
    );
    // 未授权 loop 的提案直接丢弃
    await fixture.loopCardStore.createLoop(
      parentCard({ id: "rogue-loop", can_propose_loops: undefined }),
    );
    assert.equal(
      await fixture.lifecycle.registerLoopProposal(
        "rogue-loop",
        "run-2",
        proposalText("child-loop"),
      ),
      null,
    );
    assert.equal(fixture.proposalStore.list().length, 0);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("daily proposal quota rejects overflow without entering the queue", async () => {
  const fixture = await makeFixture({ dailyProposalLimit: 2 });
  try {
    const first = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-1"),
    );
    const second = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-2",
      proposalText("child-2"),
    );
    const third = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-3",
      proposalText("child-3"),
    );
    assert.equal(first?.state, "pending_approval");
    assert.equal(second?.state, "pending_approval");
    // 超限提案直接 rejected，不进人工队列
    assert.equal(third?.state, "rejected");
    assert.ok(third?.rejection_reason?.startsWith("quota_exceeded"));
    const pending = fixture.proposalStore
      .list()
      .filter((proposal) => proposal.state === "pending_approval");
    assert.equal(pending.length, 2);
    // 记 learning event
    const { events } = await fixture.learningEventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.decision, "policy_blocked");
    assert.equal(events[0]?.run_id, "run-3");
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("active loop quota rejects overflow proposals", async () => {
  const fixture = await makeFixture({ maxActiveLoops: 2 });
  try {
    // parent-loop 已占 1 个活跃名额，再注册 1 个即触顶
    await fixture.loopCardStore.createLoop(parentCard({ id: "other-loop" }));
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.equal(proposal?.state, "rejected");
    assert.ok(proposal?.rejection_reason?.includes("active loop limit"));
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("approve creates the loop from the clamped card and records lineage", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);
    const approved = await fixture.lifecycle.approve(proposal.proposal_id);
    assert.ok(
      approved && approved !== "invalid_state" && approved !== "loop_exists",
    );
    assert.equal(approved.state, "approved");
    assert.equal(approved.created_loop_id, "child-loop");
    const created = fixture.loopCardStore.getLoop("child-loop");
    assert.ok(created);
    assert.equal(created.card.loop.parent_loop_id, "parent-loop");
    // 重复批准 → invalid_state
    assert.equal(
      await fixture.lifecycle.approve(proposal.proposal_id),
      "invalid_state",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("approve reports loop_exists when the card id is taken", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);
    await fixture.loopCardStore.createLoop(parentCard({ id: "child-loop" }));
    assert.equal(
      await fixture.lifecycle.approve(proposal.proposal_id),
      "loop_exists",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("registerLoopProposal is idempotent and never revives a terminal proposal", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);
    // 同一 run 重复注册（restart recovery 会重跑完成路径）：直接返回
    // 现有 pending 提案，不产生重复记录/事件。
    const again = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.equal(again?.proposal_id, proposal.proposal_id);
    assert.equal(fixture.proposalStore.list().length, 1);
    assert.equal(
      fixture.events.filter((event) => event.type === "loop-proposal-changed")
        .length,
      1,
    );
    // 人工拒绝后同一 run 再注册：终态不复活（restart recovery 安全）。
    await fixture.lifecycle.reject(proposal.proposal_id, "预算不允许");
    const revived = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.equal(revived, null);
    assert.equal(
      fixture.proposalStore.findById(proposal.proposal_id)?.state,
      "rejected",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("reject records the reason and appends a learning event", async () => {
  const fixture = await makeFixture();
  try {
    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);
    const rejected = await fixture.lifecycle.reject(
      proposal.proposal_id,
      "预算不允许",
    );
    assert.ok(rejected && rejected !== "invalid_state");
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.rejection_reason, "预算不允许");
    const { events } = await fixture.learningEventStore.readEvents(0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.loop_id, "parent-loop");
    assert.equal(
      await fixture.lifecycle.reject(proposal.proposal_id),
      "invalid_state",
    );
    assert.equal(await fixture.lifecycle.reject("missing"), null);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});
