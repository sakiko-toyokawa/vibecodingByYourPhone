import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvalRunner } from "../../../../packages/server/src/loop/learning/eval-runner.js";
import { ProposalPipeline } from "../../../../packages/server/src/loop/learning/pipeline.js";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { ProposalStore } from "../../../../packages/server/src/loop/state/proposal-store.js";

const NOW = "2026-07-24T10:00:00.000Z";

type ImprovementProposal = NonNullable<ReturnType<ProposalStore["get"]>>;
type LoopCard = Parameters<LoopCardStore["createLoop"]>[0];

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "摘要规则",
    target: "loop-scope.memory_packet_template",
    expected_effect: "减少 context_error",
    risk: "low",
    validation_plan: "shadow + regression + canary",
    status: "draft",
    created_by: "worker",
    created_at: NOW,
    ...overrides,
  };
}

function makeCard(id: string, evalBlock?: LoopCard["loop"]["eval"]): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: process.cwd() },
      verification: { required: [] },
      ...(evalBlock ? { eval: evalBlock } : {}),
      persistence: { state_file: `state/${id}.json` },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

async function withPipeline(
  fn: (ctx: {
    dataDir: string;
    store: ProposalStore;
    loopCardStore: LoopCardStore;
    pipeline: ProposalPipeline;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-scope-pipeline-"));
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
    await fn({ dataDir, store, loopCardStore, pipeline });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("cases.json 缺失时 EvalRunner 写入内置 behavior case 集", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-eval-seed-"));
  try {
    const runner = new EvalRunner({
      dataDir,
      now: () => new Date(NOW),
    });
    const cases = await runner.loadCases();
    const categories = new Set(cases.map((c) => c.category));
    assert.ok(cases.length >= 8);
    assert.ok(categories.size >= 8);
    for (const tag of [
      "intent_error",
      "context_error",
      "memory_packet_error",
      "runtime_blackbox_error",
      "tool_error",
      "policy_error",
      "verification_error",
      "eval_regression",
    ] as const) {
      assert.ok(
        cases.some((c) => c.category === tag),
        `内置集缺少类别 ${tag}`,
      );
    }
    for (const evalCase of cases) {
      assert.equal(evalCase.kind, "behavior");
    }
    const onDisk = JSON.parse(
      await readFile(join(dataDir, "loops/eval/cases.json"), "utf-8"),
    ) as { version: number; cases: unknown[] };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.cases.length, cases.length);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LoopCard regression_scope 被 pipeline regression 档消费", async () => {
  await withPipeline(async ({ dataDir, store, loopCardStore, pipeline }) => {
    const card = makeCard("loop-scope", {
      regression_scope: ["scoped-pass"],
    });
    await loopCardStore.createLoop(card);

    const node = process.execPath;
    const evalDir = join(dataDir, "loops/eval");
    await mkdir(evalDir, { recursive: true });
    await writeFile(
      join(evalDir, "cases.json"),
      JSON.stringify({
        version: 1,
        cases: [
          {
            case_id: "scoped-pass",
            category: "tool_error",
            command: node,
            args: ["-e", "process.exit(0)"],
            expect: "pass",
          },
          {
            case_id: "unscoped-broken",
            category: "tool_error",
            command: node,
            args: ["-e", "process.exit(1)"],
            expect: "pass",
          },
        ],
      }),
    );

    await store.create(makeProposal("prop-scope"));
    await pipeline.advanceEligible(); // draft → shadow
    await pipeline.advanceEligible(); // shadow → regression 档

    assert.equal(store.get("prop-scope")?.status, "canary");
    const reason = store.getHistory("prop-scope").at(-1)?.reason ?? "";
    assert.match(reason, /regression 通过 \(1\/1\)/);
    assert.match(reason, /regression_scope 白名单: 请求 1 命中 1/);
  });
});
