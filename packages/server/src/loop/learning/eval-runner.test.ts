import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FailureTagSchema } from "@yep-anywhere/shared";
import { EvalRunner, EvalRunnerError } from "./eval-runner.js";

async function withRunner(
  fn: (ctx: { dataDir: string; runner: EvalRunner }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-eval-runner-"));
  try {
    const runner = new EvalRunner({
      dataDir,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    await fn({ dataDir, runner });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("cases.json 缺失时写入内置初始集 (覆盖全部 8 个失败归因类别)", async () => {
  await withRunner(async ({ dataDir, runner }) => {
    const cases = await runner.loadCases();
    // 8 个归因类别全覆盖 (adapter_policy_application 与归因映射同类别,
    // 故总数 > 8)
    assert.ok(cases.length >= FailureTagSchema.options.length);
    for (const tag of FailureTagSchema.options) {
      assert.ok(
        cases.some((c) => c.category === tag),
        `内置集缺少类别 ${tag}`,
      );
    }
    // case_id 唯一 (同类别的多个 case 靠 behavior 名区分)
    assert.equal(new Set(cases.map((c) => c.case_id)).size, cases.length);
    // 落盘后可读回 (种子只写一次)
    const onDisk = JSON.parse(
      await readFile(join(dataDir, "loops/eval/cases.json"), "utf-8"),
    ) as { version: number; cases: unknown[] };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.cases.length, cases.length);
  });
});

test("内置 case 复跑全部符合预期, scorecard 落 results/", async () => {
  await withRunner(async ({ dataDir, runner }) => {
    const scorecard = await runner.run({
      mode: "regression",
      proposalId: "prop-1",
    });
    assert.equal(scorecard.ok, true);
    assert.equal(scorecard.total, scorecard.results.length);
    assert.equal(scorecard.failed, 0);
    assert.ok(
      scorecard.results.every((r) => r.actual === r.expect),
      "每条 case 的实际结果都应符合预期 (应通过/应失败)",
    );
    const persisted = JSON.parse(
      await readFile(
        join(dataDir, "loops/eval/results", `${scorecard.scorecard_id}.json`),
        "utf-8",
      ),
    ) as { ok: boolean; proposal_id?: string };
    assert.equal(persisted.ok, true);
    assert.equal(persisted.proposal_id, "prop-1");
  });
});

test("自定义 case: 应通过却失败 → scorecard.ok=false 并指明失败 case", async () => {
  await withRunner(async ({ dataDir, runner }) => {
    const node = process.execPath;
    await mkdir(join(dataDir, "loops/eval"), { recursive: true });
    await writeFile(
      join(dataDir, "loops/eval/cases.json"),
      JSON.stringify({
        version: 1,
        cases: [
          {
            case_id: "custom-pass",
            category: "tool_error",
            command: node,
            args: ["-e", "process.exit(0)"],
            expect: "pass",
          },
          {
            case_id: "custom-broken",
            category: "verification_error",
            command: node,
            args: ["-e", "process.exit(1)"],
            expect: "pass",
          },
        ],
      }),
    );
    const scorecard = await runner.run({ mode: "regression" });
    assert.equal(scorecard.ok, false);
    assert.equal(scorecard.failed, 1);
    const broken = scorecard.results.find((r) => r.case_id === "custom-broken");
    assert.equal(broken?.actual, "fail");
    assert.equal(broken?.ok, false);
  });
});

test("cases.json 损坏 → invalid_cases (fail-closed, 闸门不得放行)", async () => {
  await withRunner(async ({ dataDir, runner }) => {
    await mkdir(join(dataDir, "loops/eval"), { recursive: true });
    await writeFile(join(dataDir, "loops/eval/cases.json"), "{not json");
    await assert.rejects(runner.loadCases(), (error: unknown) => {
      assert.ok(error instanceof EvalRunnerError);
      assert.equal(error.code, "invalid_cases");
      return true;
    });
  });
});

test("内置集是 behavior 形态 (衡量真实子系统行为, 非空转命令)", async () => {
  await withRunner(async ({ runner }) => {
    const cases = await runner.loadCases();
    for (const evalCase of cases) {
      assert.equal(evalCase.kind, "behavior");
      assert.ok(evalCase.behavior, `${evalCase.case_id} 缺 behavior 键`);
    }
  });
});

test("behavior case 未知行为名 → fail (fail-closed per-case, 不崩溃整场)", async () => {
  await withRunner(async ({ dataDir, runner }) => {
    await mkdir(join(dataDir, "loops/eval"), { recursive: true });
    await writeFile(
      join(dataDir, "loops/eval/cases.json"),
      JSON.stringify({
        version: 1,
        cases: [
          {
            case_id: "bogus",
            category: "tool_error",
            kind: "behavior",
            behavior: "no_such_behavior",
            expect: "pass",
          },
        ],
      }),
    );
    const scorecard = await runner.run({ mode: "regression" });
    assert.equal(scorecard.ok, false);
    const bogus = scorecard.results.find((r) => r.case_id === "bogus");
    assert.equal(bogus?.actual, "fail");
    assert.match(bogus?.detail ?? "", /unknown behavior/);
  });
});

test("提案真实参与评估: applied 记录槽位与跳过原因 (#5 脱钩修复)", async () => {
  await withRunner(async ({ runner }) => {
    const scorecard = await runner.run({
      mode: "regression",
      proposal: {
        proposal_id: "prop-applied",
        type: "memory_packet_template_proposal",
        source_patterns: ["fp-1"],
        summary: "s",
        target: "loop-1.memory_packet_template",
        expected_effect: "e",
        risk: "low",
        validation_plan: "v",
        status: "shadow",
        created_by: "human",
        payload: {
          memory_packet_template: "always verify before reporting",
          adapter_policy: { timeout_seconds: 60 },
        },
        created_at: "2026-07-24T10:00:00.000Z",
      },
    });
    assert.equal(scorecard.ok, true);
    assert.equal(scorecard.applied?.proposal_id, "prop-applied");
    // adapter_policy 自 #13 修复后有真实消费者, 两个槽位都真实参与评估
    assert.deepEqual(scorecard.applied?.slots, [
      "memory_packet_template",
      "adapter_policy",
    ]);
    assert.deepEqual(scorecard.applied?.skipped, []);
  });
});

test("policy_profile 提案: 覆盖档名真实进裁决 (hard_gate_enforced 应用槽位)", async () => {
  await withRunner(async ({ runner }) => {
    const scorecard = await runner.run({
      mode: "shadow",
      proposal: {
        proposal_id: "prop-policy",
        type: "policy_profile_proposal",
        source_patterns: ["fp-2"],
        summary: "s",
        target: "loop-1.policy_profile",
        expected_effect: "e",
        risk: "high",
        validation_plan: "v",
        status: "draft",
        created_by: "human",
        payload: { policy_profile: "loop_strict_review" },
        created_at: "2026-07-24T10:00:00.000Z",
      },
    });
    assert.equal(scorecard.ok, true);
    assert.deepEqual(scorecard.applied?.slots, ["policy_profile"]);
    const gate = scorecard.results.find(
      (r) => r.case_id === "builtin-hard_gate_enforced",
    );
    assert.match(gate?.detail ?? "", /profile=loop_strict_review/);
  });
});
