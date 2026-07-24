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
    assert.equal(cases.length, FailureTagSchema.options.length);
    for (const tag of FailureTagSchema.options) {
      assert.ok(
        cases.some((c) => c.category === tag),
        `内置集缺少类别 ${tag}`,
      );
    }
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
    assert.equal(scorecard.total, FailureTagSchema.options.length);
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
