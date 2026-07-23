import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ImprovementProposal } from "@yep-anywhere/shared";
import { ProposalStore, ProposalStoreError } from "./proposal-store.js";

function makeProposal(
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: "prop_20260720_001",
    type: "memory_packet_template_proposal",
    source_patterns: ["fp_ci_retry_loop"],
    summary: "CI 修复任务应注入 pnpm workspace 规则摘要",
    target: "loop_ci_fix.memory_packet_template",
    expected_effect: "减少同类 context_error",
    risk: "medium",
    validation_plan: "在 CI golden tasks 上 shadow + canary",
    status: "draft",
    created_by: "worker",
    created_at: "2026-07-20T11:00:00.000Z",
    ...overrides,
  };
}

async function withStore(
  fn: (ctx: { dataDir: string; store: ProposalStore }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-proposal-"));
  try {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await fn({ dataDir, store });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("create：draft 起步，落盘 proposals/<id>.json + index.json", async () => {
  await withStore(async ({ dataDir, store }) => {
    await store.create(makeProposal());
    assert.equal(store.get("prop_20260720_001")?.status, "draft");

    const file = JSON.parse(
      await readFile(
        join(
          dataDir,
          "loops",
          "learning",
          "proposals",
          "prop_20260720_001.json",
        ),
        "utf-8",
      ),
    );
    assert.equal(file.proposal.proposal_id, "prop_20260720_001");
    assert.deepEqual(file.history, []);

    const index = JSON.parse(
      await readFile(
        join(dataDir, "loops", "learning", "proposals", "index.json"),
        "utf-8",
      ),
    );
    assert.equal(index.proposals.length, 1);
    assert.equal(index.proposals[0].status, "draft");
  });
});

test("create 拒绝非 draft 起步", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.create(makeProposal({ status: "shadow" })),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_proposal",
    );
  });
});

test("管线推进：draft → shadow → canary → approved → published，history 全程可审计", async () => {
  await withStore(async ({ store }) => {
    await store.create(makeProposal());
    await store.transitionStatus("prop_20260720_001", "shadow", {
      stage: "shadow",
      reason: "进入 shadow 验证",
    });
    await store.transitionStatus("prop_20260720_001", "canary", {
      stage: "regression",
      reason: "eval 最小集复跑通过",
    });
    await store.transitionStatus("prop_20260720_001", "approved", {
      stage: "canary",
      by: "human",
      reason: "canary 证据达标，人工批准",
    });
    const published = await store.transitionStatus(
      "prop_20260720_001",
      "published",
      { stage: "publish", by: "human" },
    );
    assert.equal(published.status, "published");

    const history = store.getHistory("prop_20260720_001");
    assert.equal(history.length, 4);
    assert.deepEqual(
      history.map((h) => `${h.from}->${h.to}`),
      [
        "draft->shadow",
        "shadow->canary",
        "canary->approved",
        "approved->published",
      ],
    );
    // regression 档位记在 history.stage，不是持久化状态
    assert.equal(history[1]?.stage, "regression");
    // 人工批准动作可审计（元规则仅人工的来源记录）
    assert.equal(history[2]?.by, "human");
    assert.ok(
      history.every((h) => typeof h.at === "string" && h.at.length > 0),
    );
  });
});

test("非法推进被拒绝：draft 不能直达 published，published 不能回 draft", async () => {
  await withStore(async ({ store }) => {
    await store.create(makeProposal());
    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "published"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );

    await store.transitionStatus("prop_20260720_001", "shadow");
    await store.transitionStatus("prop_20260720_001", "canary");
    await store.transitionStatus("prop_20260720_001", "approved");
    await store.transitionStatus("prop_20260720_001", "published");
    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "draft"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );
    // 状态未被非法调用污染
    assert.equal(store.get("prop_20260720_001")?.status, "published");
  });
});

test("回滚：published → rolled_back，history 记录原因", async () => {
  await withStore(async ({ store }) => {
    await store.create(makeProposal());
    for (const to of ["shadow", "canary", "approved", "published"] as const) {
      await store.transitionStatus("prop_20260720_001", to);
    }
    const rolledBack = await store.rollback("prop_20260720_001", {
      by: "human",
      reason: "上线后 eval 退化",
    });
    assert.equal(rolledBack.status, "rolled_back");

    const history = store.getHistory("prop_20260720_001");
    const last = history[history.length - 1];
    assert.equal(last?.to, "rolled_back");
    assert.equal(last?.from, "published");
    assert.equal(last?.reason, "上线后 eval 退化");
    assert.equal(last?.by, "human");

    // rolled_back 是终态
    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "shadow"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );
  });
});

test("状态推进持久化：新实例读回 status 与 history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-proposal-"));
  try {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());
    await store.transitionStatus("prop_20260720_001", "shadow", {
      stage: "shadow",
    });

    const reopened = new ProposalStore({ dataDir });
    await reopened.initialize();
    assert.equal(reopened.get("prop_20260720_001")?.status, "shadow");
    assert.equal(reopened.getHistory("prop_20260720_001").length, 1);
    assert.equal(reopened.list("shadow").length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("未知提案抛 proposal_not_found；危险 id 拒绝落盘", async () => {
  await withStore(async ({ store }) => {
    assert.throws(
      () => store.getHistory("nope"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "proposal_not_found",
    );
    await assert.rejects(
      store.create(makeProposal({ proposal_id: "../escape" })),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_proposal",
    );
  });
});
