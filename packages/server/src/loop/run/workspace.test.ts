import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { resolveExecutableCard } from "./workspace.js";

/** managed:// 通用工作区（LOOP-PROPOSAL 閘門落地的子 loop 走的分支）。 */
function makeManagedCard(workspacePath: string): LoopCard {
  return {
    loop: {
      id: "managed-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 1, max_time_minutes: 5, max_retries: 0 },
      handoff: { task: "t" },
    },
  } as LoopCard;
}

test("resolveExecutableCard resolves managed:// workspaces under the data dir", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-workspace-"));
  try {
    const result = await resolveExecutableCard(
      makeManagedCard("managed://loop-workspaces/managed-loop"),
      "run-1",
      { dataDir },
    );
    assert.equal(result.worktree, null);
    assert.equal(result.card.loop.workspace.strategy, "direct");
    assert.equal(
      result.card.loop.workspace.path,
      join(dataDir, "loop-workspaces", "managed-loop"),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("resolveExecutableCard rejects managed:// paths escaping the data dir", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-workspace-"));
  try {
    // 直建卡/脏数据可能带 managed://../../x——解析器必须拒绝且不能
    // 先把越界目录建出来（检查先于 mkdir）。
    await assert.rejects(
      resolveExecutableCard(
        makeManagedCard("managed://../../outside"),
        "run-1",
        {
          dataDir,
        },
      ),
      /escapes the server data directory/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
