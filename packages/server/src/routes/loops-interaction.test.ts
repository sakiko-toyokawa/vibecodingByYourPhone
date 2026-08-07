import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { LoopCardStore } from "../loop/state/loop-card-store.js";
import { createLoopsRoutes } from "./loops.js";

function makeCard(loopId: string, workspacePath: string): LoopCard {
  return {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: {
        required: ["interaction"],
        interaction: { enabled: true, url: "http://localhost:3400" },
      },
      persistence: { state_file: `.loop/state/${loopId}/STATE.md` },
      stop_rules: { max_turns: 1, max_time_minutes: 30, max_retries: 0 },
    },
  };
}

async function withApp(
  fn: (ctx: {
    app: ReturnType<typeof createLoopsRoutes>;
    workspacePath: string;
  }) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "loops-interaction-data-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "loops-interaction-ws-"));
  const loopCardStore = new LoopCardStore({ dataDir });
  await loopCardStore.initialize();
  await loopCardStore.createLoop(makeCard("loop-interaction", workspacePath));
  try {
    const app = createLoopsRoutes({
      loopCardStore,
      installInteractionDependencies: async (_workspacePath, command) => ({
        ok: true,
        output: `installed with ${command}`,
      }),
    });
    await fn({ app, workspacePath });
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("GET /:id/interaction-deps reports missing Playwright dependency", async () => {
  await withApp(async ({ app, workspacePath }) => {
    await writeFile(join(workspacePath, "package.json"), JSON.stringify({}));
    const res = await app.request("/loop-interaction/interaction-deps");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "missing");
    assert.match(body.installCommand, /playwright/);
  });
});

test("POST /:id/interaction-deps/install allows Playwright dev dependency command", async () => {
  await withApp(async ({ app }) => {
    const res = await app.request("/loop-interaction/interaction-deps/install", {
      method: "POST",
      body: JSON.stringify({
        install_command: "pnpm add -D @playwright/test playwright",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.output, /pnpm add -D/);
  });
});

test("POST /:id/interaction-deps/install rejects arbitrary shell commands", async () => {
  await withApp(async ({ app }) => {
    const res = await app.request("/loop-interaction/interaction-deps/install", {
      method: "POST",
      body: JSON.stringify({
        install_command:
          "pnpm add -D @playwright/test playwright; echo unsafe",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "install_command_not_allowed");
  });
});
