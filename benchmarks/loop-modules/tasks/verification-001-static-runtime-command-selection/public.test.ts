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
      id: "loop-cmd-selection",
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
  const workspacePath = await mkdtemp(join(tmpdir(), "yep-cmd-select-"));
  try {
    await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function writePackageJson(
  workspacePath: string,
  scripts: Record<string, string>,
): Promise<void> {
  await writeFile(
    join(workspacePath, "package.json"),
    `${JSON.stringify({ name: "cmd-select-fixture", scripts }, null, 2)}\n`,
  );
}

test("显式 static 命令优先于 package.json 脚本", async () => {
  await withWorkspace(async (workspacePath) => {
    await writePackageJson(workspacePath, {
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      test: "vitest run",
    });
    const card = makeCard(workspacePath, {
      static: ["npm run custom-lint"],
    });
    const commands = await selectStaticCommands(card, workspacePath);
    assert.deepEqual(commands, ["npm run custom-lint"]);
  });
});

test("显式 runtime 命令优先于 package.json 脚本", async () => {
  await withWorkspace(async (workspacePath) => {
    await writePackageJson(workspacePath, {
      lint: "eslint .",
      test: "vitest run",
    });
    const card = makeCard(workspacePath, {
      runtime: ["npm run custom-test"],
    });
    const commands = await selectRuntimeCommands(card, workspacePath);
    assert.deepEqual(commands, ["npm run custom-test"]);
  });
});

test("无显式命令时 static 探测 lint / typecheck 脚本", async () => {
  await withWorkspace(async (workspacePath) => {
    await writePackageJson(workspacePath, {
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      build: "tsc",
      test: "vitest run",
    });
    const card = makeCard(workspacePath);
    const commands = await selectStaticCommands(card, workspacePath);
    assert.deepEqual(commands, ["pnpm run lint", "pnpm run typecheck"]);
  });
});

test("无显式命令时 runtime 探测 test 脚本", async () => {
  await withWorkspace(async (workspacePath) => {
    await writePackageJson(workspacePath, {
      lint: "eslint .",
      test: "vitest run",
    });
    const card = makeCard(workspacePath);
    const commands = await selectRuntimeCommands(card, workspacePath);
    assert.deepEqual(commands, ["pnpm run test"]);
  });
});
