import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { selectRuntimeCommands } from "../../../../packages/server/src/loop/verification/runtime-verifier.js";
import { selectStaticCommands } from "../../../../packages/server/src/loop/verification/static-verifier.js";

function makeCard(
  workspacePath: string,
  commands?: { static?: string[]; runtime?: string[] },
): LoopCard {
  return {
    loop: {
      id: "loop-cmd-selection-hidden",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: {
        required: ["static", "runtime"],
        ...(commands ? { commands } : {}),
      },
      persistence: { state_file: "state/loop.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

async function withWorkspace(
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "yep-cmd-hidden-"));
  try {
    await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("显式空数组 static 不回落到 package.json 探测", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(
      join(workspacePath, "package.json"),
      `${JSON.stringify(
        { name: "empty-static", scripts: { lint: "eslint ." } },
        null,
        2,
      )}\n`,
    );
    const card = makeCard(workspacePath, { static: [] });
    const commands = await selectStaticCommands(card, workspacePath);
    assert.deepEqual(commands, []);
  });
});

test("缺少 package.json 时返回空数组", async () => {
  await withWorkspace(async (workspacePath) => {
    const card = makeCard(workspacePath);
    const staticCommands = await selectStaticCommands(card, workspacePath);
    const runtimeCommands = await selectRuntimeCommands(card, workspacePath);
    assert.deepEqual(staticCommands, []);
    assert.deepEqual(runtimeCommands, []);
  });
});

test("package.json 缺少 scripts 字段时返回空数组", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(
      join(workspacePath, "package.json"),
      `${JSON.stringify({ name: "no-scripts" }, null, 2)}\n`,
    );
    const card = makeCard(workspacePath);
    const staticCommands = await selectStaticCommands(card, workspacePath);
    const runtimeCommands = await selectRuntimeCommands(card, workspacePath);
    assert.deepEqual(staticCommands, []);
    assert.deepEqual(runtimeCommands, []);
  });
});

test("package.json 损坏时返回空数组且不抛异常", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, "package.json"), "{ not json");
    const card = makeCard(workspacePath);
    const staticCommands = await selectStaticCommands(card, workspacePath);
    const runtimeCommands = await selectRuntimeCommands(card, workspacePath);
    assert.deepEqual(staticCommands, []);
    assert.deepEqual(runtimeCommands, []);
  });
});
