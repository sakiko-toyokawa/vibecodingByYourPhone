import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import {
  detectRuntimeCommands,
  detectStaticCommands,
} from "./detect-commands.js";
import { selectRuntimeCommands } from "./runtime-verifier.js";
import { selectStaticCommands } from "./static-verifier.js";

async function withWorkspace(
  packageJson: unknown | null,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "yep-verifier-probe-"));
  try {
    if (packageJson !== null) {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify(packageJson),
        "utf-8",
      );
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeCard(commands?: {
  static?: string[];
  runtime?: string[];
}): LoopCard {
  return {
    loop: {
      id: "test-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct" },
      verification: { required: ["static", "runtime"], commands },
      persistence: { state_file: ".loop/state/test-loop/STATE.md" },
      stop_rules: { max_turns: 5, max_time_minutes: 10, max_retries: 2 },
    },
  };
}

test("probe: lint + typecheck + test scripts map to static / runtime", async () => {
  await withWorkspace(
    {
      scripts: {
        lint: "biome check .",
        typecheck: "tsc --noEmit",
        test: "node test.js",
      },
    },
    async (dir) => {
      assert.deepEqual(await detectStaticCommands(dir), [
        "pnpm run lint",
        "pnpm run typecheck",
      ]);
      assert.deepEqual(await detectRuntimeCommands(dir), ["pnpm run test"]);
    },
  );
});

test("probe: only lint script → static has lint, runtime empty", async () => {
  await withWorkspace({ scripts: { lint: "biome check ." } }, async (dir) => {
    assert.deepEqual(await detectStaticCommands(dir), ["pnpm run lint"]);
    assert.deepEqual(await detectRuntimeCommands(dir), []);
  });
});

test("probe: no package.json → both empty", async () => {
  await withWorkspace(null, async (dir) => {
    assert.deepEqual(await detectStaticCommands(dir), []);
    assert.deepEqual(await detectRuntimeCommands(dir), []);
  });
});

test("probe: package.json without scripts → both empty", async () => {
  await withWorkspace({ name: "no-scripts" }, async (dir) => {
    assert.deepEqual(await detectStaticCommands(dir), []);
    assert.deepEqual(await detectRuntimeCommands(dir), []);
  });
});

test("probe: unparseable package.json → both empty (never throws)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yep-verifier-probe-"));
  try {
    await writeFile(join(dir, "package.json"), "{not json", "utf-8");
    assert.deepEqual(await detectStaticCommands(dir), []);
    assert.deepEqual(await detectRuntimeCommands(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("select: card-pinned commands win over probing", async () => {
  await withWorkspace(
    { scripts: { lint: "biome check .", test: "node test.js" } },
    async (dir) => {
      const card = makeCard({
        static: ["custom-static-check"],
        runtime: ["custom-test --smoke"],
      });
      assert.deepEqual(await selectStaticCommands(card, dir), [
        "custom-static-check",
      ]);
      assert.deepEqual(await selectRuntimeCommands(card, dir), [
        "custom-test --smoke",
      ]);
    },
  );
});

test("select: card without commands falls back to probing", async () => {
  await withWorkspace({ scripts: { test: "node test.js" } }, async (dir) => {
    const card = makeCard();
    assert.deepEqual(await selectStaticCommands(card, dir), []);
    assert.deepEqual(await selectRuntimeCommands(card, dir), ["pnpm run test"]);
  });
});
