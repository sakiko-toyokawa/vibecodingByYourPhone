import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const dataDir = await mkdtemp(join(tmpdir(), "yep-pipeline-advance-"));
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

async function writeFailingCases(dataDir: string): Promise<void> {
  const evalDir = join(dataDir, "loops/eval");
  await mkdir(evalDir, { recursive: true });
  await writeFile(
    join(evalDir, "cases.json"),
    JSON.stringify({
      version: 1,
      cases: [
        {
          case_id: "always-broken",
          category: "tool_error",
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          expect: "pass",
        },
      ],
    }),
  );
}

test("happy path: draft → shadow → canary, 自动推进到此为止", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(makeProposal("prop-happy"));

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "shadow");

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "canary");

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "canary");

    const history = store.getHistory("prop-happy");
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((h) => h.stage),
      ["shadow", "regression"],
    );
    assert.ok(history.every((h) => h.by === "worker"));
  });
});

test("regression 失败 → rolled_back, history 记录失败明细", async () => {
  await withPipeline(async ({ dataDir, store, pipeline }) => {
    await store.create(makeProposal("prop-fail"));
    await pipeline.advanceEligible(); // draft → shadow
    assert.equal(store.get("prop-fail")?.status, "shadow");

    await writeFailingCases(dataDir);
    await pipeline.advanceEligible(); // regression 档失败 → 回滚
    assert.equal(store.get("prop-fail")?.status, "rolled_back");

    const last = store.getHistory("prop-fail").at(-1);
    assert.equal(last?.to, "rolled_back");
    assert.equal(last?.stage, "regression");
    assert.match(last?.reason ?? "", /regression 未通过/);
    assert.match(last?.reason ?? "", /always-broken/);
    assert.match(last?.reason ?? "", /scorecard eval\/results\//);
  });
});
