import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkRequiredArtifacts,
  turnSuffixedArtifactName,
} from "../../../../packages/server/src/loop/verification/required-artifacts.js";

async function withDir(
  files: string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yep-required-public-"));
  try {
    for (const file of files) {
      await writeFile(join(dir, file), "x");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("turnSuffixedArtifactName: turn 1 保持规范名, turn > 1 插后缀", () => {
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

test("产物缺失 → 标注 missing_required_artifact", async () => {
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

test("turn > 1 时 -turnN 后缀变体命中", async () => {
  await withDir(["stdout-turn2.log"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["stdout.log"],
      turn: 2,
    });
    assert.deepEqual(annotations, []);
  });
});
