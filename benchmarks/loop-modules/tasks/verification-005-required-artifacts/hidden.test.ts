import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_UNAVAILABLE_ANNOTATION,
  checkRequiredArtifacts,
} from "../../../../packages/server/src/loop/verification/required-artifacts.js";

async function withDir(
  files: string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yep-required-hidden-"));
  try {
    for (const file of files) {
      await writeFile(join(dir, file), "x");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("turn > 1 时后缀变体不存在但规范名存在仍可命中", async () => {
  await withDir(["memory-packet.json"], async (dir) => {
    const annotations = await checkRequiredArtifacts({
      artifactsDir: dir,
      required: ["memory-packet.json"],
      turn: 3,
    });
    assert.deepEqual(annotations, []);
  });
});

test("turn > 1 时后缀变体与规范名都不存在 → 标注缺失", async () => {
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

test("目录读不到时不全部缺失误报", async () => {
  const annotations = await checkRequiredArtifacts({
    artifactsDir: join(tmpdir(), "yep-required-nonexistent-dir"),
    required: ["stdout.log"],
    turn: 1,
  });
  assert.deepEqual(annotations, [CHECK_UNAVAILABLE_ANNOTATION]);
});
