import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ImprovementProposal, LoopCard } from "@yep-anywhere/shared";
import { LoopCardStore } from "../state/loop-card-store.js";
import { ProposalStore } from "../state/proposal-store.js";
import { EvalRunner } from "./eval-runner.js";
import { ProposalPipeline, isMetaRuleProposal } from "./pipeline.js";

const NOW = "2026-07-24T10:00:00.000Z";

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "注入 pnpm workspace 规则摘要",
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
  loopCardStore: LoopCardStore;
  pipeline: ProposalPipeline;
}

async function withPipeline(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-pipeline-"));
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

/** 最小合法 LoopCard (可带 eval 块). */
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

/** 写入一个必失败的 eval 集 (应通过却 exit 1) 让 regression 档不过. */
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

// --- 元规则判定 ---

test("isMetaRuleProposal: 验证层自身类型与 pipeline/eval/verifier target", () => {
  assert.ok(
    isMetaRuleProposal(makeProposal("m1", { type: "eval_task_proposal" })),
  );
  assert.ok(
    isMetaRuleProposal(
      makeProposal("m2", { type: "verification_rule_proposal" }),
    ),
  );
  assert.ok(
    isMetaRuleProposal(
      makeProposal("m3", { target: "release_pipeline.stages" }),
    ),
  );
  assert.ok(
    isMetaRuleProposal(makeProposal("m4", { target: "verifier_rubric" })),
  );
  assert.ok(
    !isMetaRuleProposal(
      makeProposal("m5", { target: "loop-1.memory_packet_template" }),
    ),
  );
  assert.ok(
    !isMetaRuleProposal(makeProposal("m6", { target: "adapter.tool_config" })),
  );
});

// --- 管线推进 ---

test("happy path: draft →(shadow 档)→ shadow →(regression 档)→ canary, 全程 history 可查", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(makeProposal("prop-happy"));

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "shadow");

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "canary");

    // 自动推进到此为止 —— approved/published 无自动路径
    await pipeline.advanceEligible();
    assert.equal(store.get("prop-happy")?.status, "canary");

    const history = store.getHistory("prop-happy");
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((h) => h.stage),
      ["shadow", "regression"],
    );
    assert.match(history[0]?.reason ?? "", /shadow 旁路评估记录/);
    assert.match(history[1]?.reason ?? "", /regression 通过/);
    assert.ok(history.every((h) => h.by === "worker"));
  });
});

test("shadow 档记录 '若启用会如何' 的评估记录 (mode=shadow scorecard 落盘)", async () => {
  await withPipeline(async ({ dataDir, store, pipeline }) => {
    await store.create(makeProposal("prop-shadow"));
    await pipeline.advanceEligible();
    const reason = store.getHistory("prop-shadow")[0]?.reason ?? "";
    const match = /eval\/results\/(\S+)\.json/.exec(reason);
    assert.ok(match, `history 应引用 shadow scorecard, got: ${reason}`);
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

test("带 payload 的提案: 管线 history 记录真实应用的槽位 (#5)", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(
      makeProposal("prop-payload", {
        payload: { memory_packet_template: "verify before reporting" },
      }),
    );
    await pipeline.advanceEligible(); // draft → shadow
    const shadowReason = store.getHistory("prop-payload")[0]?.reason ?? "";
    assert.match(shadowReason, /applied: memory_packet_template/);

    await pipeline.advanceEligible(); // shadow → canary (regression 档)
    const regressionReason = store.getHistory("prop-payload")[1]?.reason ?? "";
    assert.match(regressionReason, /regression 通过/);
    assert.match(regressionReason, /applied: memory_packet_template/);
  });
});

test("regression 失败 → rolled_back, scorecard 引用与失败明细写 history", async () => {
  await withPipeline(async ({ dataDir, store, pipeline }) => {
    await store.create(makeProposal("prop-fail"));
    await pipeline.advanceEligible(); // draft → shadow
    assert.equal(store.get("prop-fail")?.status, "shadow");

    await writeFailingCases(dataDir);
    await pipeline.advanceEligible(); // regression 档不过 → 回滚
    assert.equal(store.get("prop-fail")?.status, "rolled_back");

    const history = store.getHistory("prop-fail");
    const last = history[history.length - 1];
    assert.equal(last?.stage, "regression");
    assert.equal(last?.to, "rolled_back");
    assert.match(last?.reason ?? "", /regression 未通过/);
    assert.match(last?.reason ?? "", /always-broken/);
    assert.match(last?.reason ?? "", /scorecard eval\/results\//);
  });
});

test("eval 集损坏 → regression fail-closed 回滚 (不得降低验证强度)", async () => {
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

// --- regression_scope 消费 (LoopCard eval 块 → regression 档白名单) ---

test("card 声明 regression_scope → regression 档只跑白名单 case", async () => {
  await withPipeline(async ({ dataDir, store, loopCardStore, pipeline }) => {
    await loopCardStore.createLoop(
      makeCard("loop-1", { regression_scope: ["scoped-pass"] }),
    );
    // eval 集: 白名单内的通过, 白名单外的必失败 —— 若全量复跑则 regression
    // 不过; scope 生效时只跑 scoped-pass → 放行
    const node = process.execPath;
    await mkdir(join(dataDir, "loops/eval"), { recursive: true });
    await writeFile(
      join(dataDir, "loops/eval/cases.json"),
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
    await pipeline.advanceEligible(); // draft → shadow (shadow 档不 scope)
    await pipeline.advanceEligible(); // shadow → regression 档

    assert.equal(store.get("prop-scope")?.status, "canary");
    const reason = store.getHistory("prop-scope").at(-1)?.reason ?? "";
    assert.match(reason, /regression 通过 \(1\/1\)/);
    assert.match(reason, /regression_scope 白名单: 请求 1 命中 1/);
  });
});

test("card 未声明 regression_scope → regression 档全量复跑 (现状不变)", async () => {
  await withPipeline(async ({ dataDir, store, loopCardStore, pipeline }) => {
    await loopCardStore.createLoop(makeCard("loop-1")); // 无 eval 块
    await store.create(makeProposal("prop-noscope"));
    await pipeline.advanceEligible(); // draft → shadow

    await writeFailingCases(dataDir); // 全量复跑会撞上这个必失败 case
    await pipeline.advanceEligible(); // regression 档不过 → 回滚
    assert.equal(store.get("prop-noscope")?.status, "rolled_back");
    const reason = store.getHistory("prop-noscope").at(-1)?.reason ?? "";
    assert.match(reason, /regression 未通过/);
    assert.doesNotMatch(reason, /regression_scope 白名单/);
  });
});

// --- 元规则保护 ---

test("元规则: worker 发起的元规则提案进管线被拒 (停 draft), 人工发起的可推进", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(
      makeProposal("prop-meta-worker", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "worker",
      }),
    );
    await store.create(
      makeProposal("prop-meta-human", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "human",
      }),
    );

    await pipeline.advanceEligible();
    assert.equal(store.get("prop-meta-worker")?.status, "draft");
    assert.equal(store.get("prop-meta-human")?.status, "shadow");
    // 停在 draft 不是一次性意外: 再推进依然不动
    await pipeline.advanceEligible();
    assert.equal(store.get("prop-meta-worker")?.status, "draft");
  });
});

// --- 回滚 ---

test("rollback: published 提案回滚到 rolled_back, 版本记录 (文件+history) 保留", async () => {
  await withPipeline(async ({ store, pipeline }) => {
    await store.create(makeProposal("prop-rb"));
    await store.transitionStatus("prop-rb", "shadow", {
      stage: "shadow",
      by: "worker",
    });
    await store.transitionStatus("prop-rb", "canary", {
      stage: "regression",
      by: "worker",
    });
    await store.transitionStatus("prop-rb", "approved", { by: "human" });
    await store.transitionStatus("prop-rb", "published", {
      stage: "publish",
      by: "human",
    });

    const rolledBack = await pipeline.rollback("prop-rb", {
      reason: "人工回滚: canary 指标变差",
    });
    assert.equal(rolledBack.status, "rolled_back");

    const history = store.getHistory("prop-rb");
    assert.deepEqual(
      history.map((h) => h.to),
      ["shadow", "canary", "approved", "published", "rolled_back"],
    );
    assert.equal(history.at(-1)?.reason, "人工回滚: canary 指标变差");
    // rolled_back 是终态
    await assert.rejects(store.rollback("prop-rb"));
  });
});
