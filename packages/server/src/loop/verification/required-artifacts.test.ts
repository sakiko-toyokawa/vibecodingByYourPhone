/**
 * checkRequiredArtifacts 单元测试: LoopCard observability.required_artifacts
 * 的产物存在性校验 (命名口径 04/06 #29 per-turn, 匹配/容错口径见实现头注)。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_UNAVAILABLE_ANNOTATION,
  checkRequiredArtifacts,
  turnSuffixedArtifactName,
} from "./required-artifacts.js";

test("turnSuffixedArtifactName: turn 1 保持规范名, turn >1 在扩展名前插后缀", () => {
  assert.equal(turnSuffixedArtifactName("stdout.log", 1), "stdout.log");
  assert.equal(turnSuffixedArtifactName("stdout.log", 2), "stdout-turn2.log");
  assert.equal(
    turnSuffixedArtifactName("executor-summary.md", 3),
    "executor-summary-turn3.md",
  );
  assert.equal(
    turnSuffixedArtifactName("runtime-events.jsonl", 2),
    "runtime-events-turn2.jsonl",
  );
  // 无扩展名直接追加
  assert.equal(turnSuffixedArtifactName("README", 2), "README-turn2");
});

async function withDir(
  files: string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yep-required-artifacts-"));
  try {
    for (const file of files) {
      await writeFile(join(dir, file), "x");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("本轮缺该产物 → 标注 missing_required_artifact:<name>", async () => {
  await withDir(["stdout.log"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["stdout.log", "executor-summary.md"],
      turn: 1,
    });
    assert.deepEqual(annotations, [
      "missing_required_artifact:executor-summary.md",
    ]);
  });
});

test("产物存在 (规范名) → 无标注", async () => {
  await withDir(["stdout.log", "judgment-report.json"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["stdout.log", "judgment-report.json"],
      turn: 1,
    });
    assert.deepEqual(annotations, []);
  });
});

test("turn >1: 本轮 -turnN 后缀变体命中 → 无标注", async () => {
  await withDir(["stdout-turn2.log"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["stdout.log"],
      turn: 2,
    });
    assert.deepEqual(annotations, []);
  });
});

test("turn >1: 后缀变体不存在时回落规范名命中 → 无标注", async () => {
  await withDir(["memory-packet.json"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["memory-packet.json"],
      turn: 3,
    });
    assert.deepEqual(annotations, []);
  });
});

test("turn >1: 后缀变体与规范名都不存在 → 标注缺失", async () => {
  await withDir(["stdout.log"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["executor-summary.md"],
      turn: 2,
    });
    assert.deepEqual(annotations, [
      "missing_required_artifact:executor-summary.md",
    ]);
  });
});

test("目录读不到 → 不当全部缺失误报, 标注检查不可用", async () => {
  const annotations = await checkRequiredArtifacts({
    artifactsDir: join(tmpdir(), "yep-required-artifacts-nonexistent-dir"),
    required: ["stdout.log"],
    turn: 1,
  });
  assert.deepEqual(annotations, [CHECK_UNAVAILABLE_ANNOTATION]);
});
