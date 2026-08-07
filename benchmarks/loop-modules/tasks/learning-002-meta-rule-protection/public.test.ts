import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ImprovementProposal } from "@yep-anywhere/shared";
import { EvalRunner } from "../../../../packages/server/src/loop/learning/eval-runner.js";
import { ProposalPipeline } from "../../../../packages/server/src/loop/learning/pipeline.js";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { ProposalStore } from "../../../../packages/server/src/loop/state/proposal-store.js";

const NOW = "2026-07-24T10:00:00.000Z";

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "摘要规则",
    target: "loop-1.memory_packet_template",
    expected_effect: "减少 context_error",
    risk: "low",
    validation_plan: "shadow + regression + canary",
    status: "draft",
    created_by: "worker",
    created_at: NOW,
    ...overrides,
  };
}

interface Ctx {
  store: ProposalStore;
  pipeline: ProposalPipeline;
}

async function withPipeline(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-meta-rule-"));
  try {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const evalRunner = new EvalRunner({
      dataDir,
      now: () => new Date(NOW),
    });
    const pipeline = new ProposalPipeline({
      proposalStore: store,
      evalRunner,
      loopCardStore,
    });
    await fn({ store, pipeline });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("worker 发起的元规则提案被阻止在 draft", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(
      makeProposal("prop-meta-worker", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "worker",
      }),
    );

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-meta-worker")?.status, "draft");

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-meta-worker")?.status, "draft");
  });
});

test("人工发起的元规则提案可以正常推进", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(
      makeProposal("prop-meta-human", {
        type: "verification_rule_proposal",
        target: "loop-1.verifier_rubric",
        created_by: "human",
      }),
    );

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-meta-human")?.status, "shadow");
  });
});
