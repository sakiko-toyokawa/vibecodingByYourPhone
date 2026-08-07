import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EvalRunner } from "../../../../packages/server/src/loop/learning/eval-runner.js";

async function withRunner(
  fn: (ctx: { dataDir: string; runner: EvalRunner }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-eval-scope-"));
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

test("scope 白名单只跑白名单内 case", async () => {
  await withRunner(async ({ runner }) => {
    const all = await runner.loadCases(); // 触发内置集落盘
    const picked = all.slice(0, 2).map((c) => c.case_id);
    const scorecard = await runner.run({
      mode: "regression",
      scope: [...picked, "no-such-case"],
    });
    assert.equal(scorecard.ok, true);
    assert.equal(scorecard.total, 2);
    assert.deepEqual(
      scorecard.results.map((r) => r.case_id),
      picked,
    );
    assert.deepEqual(scorecard.scope?.requested, [...picked, "no-such-case"]);
    assert.deepEqual(scorecard.scope?.matched, picked);
    assert.deepEqual(scorecard.scope?.unknown_ids, ["no-such-case"]);
  });
});

test("scope 过滤后 0 命中 → fail-closed", async () => {
  await withRunner(async ({ runner }) => {
    const scorecard = await runner.run({
      mode: "regression",
      scope: ["no-such-case"],
    });
    assert.equal(scorecard.ok, false);
    assert.equal(scorecard.total, 0);
    assert.equal(scorecard.failed, 0);
    assert.deepEqual(scorecard.scope?.matched, []);
    assert.deepEqual(scorecard.scope?.unknown_ids, ["no-such-case"]);
  });
});
