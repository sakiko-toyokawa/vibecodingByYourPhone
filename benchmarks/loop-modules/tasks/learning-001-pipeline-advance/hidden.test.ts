import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    summary: "注入摘要规则",
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
  dataDir: string;
  store: ProposalStore;
  pipeline: ProposalPipeline;
}

async function withPipeline(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-pipeline-hidden-"));
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
    await fn({ dataDir, store, pipeline });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("shadow 档 scorecard 落盘且能被 history 引用", async () => {
  await withPipeline(async ({ dataDir, store, pipeline }) => {
    await store.create(makeProposal("prop-shadow"));
    await pipeline.advanceEligible();

    const reason = store.getHistory("prop-shadow")[0]?.reason ?? "";
    const match = /eval\/results\/(\S+)\.json/.exec(reason);
    assert.ok(match, `history 应引用 shadow scorecard，got: ${reason}`);

    const scorecard = JSON.parse(
      await readFile(
        join(dataDir, "loops/eval/results", `${match[1]}.json`),
        "utf-8",
      ),
    ) as { mode: string; proposal_id?: string };
    assert.equal(scorecard.mode, "shadow");
    assert.equal(scorecard.proposal_id, "prop-shadow");
  });
});

test("payload 真实应用时 history 记录 applied 槽位", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(
      makeProposal("prop-payload", {
        payload: { memory_packet_template: "verify before reporting" },
      }),
    );
    await pipeline.advanceEligible(); // draft → shadow
    const shadowReason = store.getHistory("prop-payload")[0]?.reason ?? "";
    assert.match(shadowReason, /applied: memory_packet_template/);

    await pipeline.advanceEligible(); // shadow → canary
    const regressionReason = store.getHistory("prop-payload")[1]?.reason ?? "";
    assert.match(regressionReason, /regression 通过/);
    assert.match(regressionReason, /applied: memory_packet_template/);
  });
});

test("eval 集损坏时 regression fail-closed 回滚", async () => {
  await withPipeline(async ({ dataDir, store, pipeline }) => {
    await store.create(makeProposal("prop-closed"));
    await pipeline.advanceEligible(); // draft → shadow
    await writeFile(join(dataDir, "loops/eval/cases.json"), "{broken");
    await pipeline.advanceEligible();
    assert.equal(store.get("prop-closed")?.status, "rolled_back");
    const last = store.getHistory("prop-closed").at(-1);
    assert.match(last?.reason ?? "", /fail-closed/);
  });
});
