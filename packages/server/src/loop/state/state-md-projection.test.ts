import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Budget } from "@yep-anywhere/shared";
import { type StateMdSnapshot, projectStateMd } from "./state-md-projection.js";

const BUDGET: Budget = {
  max_tokens: 0,
  max_time_minutes: 30,
  max_turns: 3,
  max_retries: 2,
  used_tokens: 1200,
  used_time_minutes: 4,
  used_turns: 2,
  used_retries: 1,
};

function snapshot(overrides: Partial<StateMdSnapshot> = {}): StateMdSnapshot {
  return {
    loopId: "loop-1",
    runId: "run-1",
    state: "needs_human",
    turn: 2,
    budget: BUDGET,
    sessionRef: "session-abc",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

async function withWorkspace(
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "yep-state-md-"));
  try {
    await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

test("正常投影: 整体重写 .loop/STATE.md, 含 loop/run/state/turn/budget/session", async () => {
  await withWorkspace(async (workspacePath) => {
    await projectStateMd({
      workspacePath,
      stateFile: ".loop/STATE.md",
      snapshot: snapshot(),
    });
    const content = await readFile(
      join(workspacePath, ".loop", "STATE.md"),
      "utf-8",
    );
    assert.match(content, /loop-1/);
    assert.match(content, /run-1/);
    assert.match(content, /needs_human/);
    assert.match(content, /\*\*turn\*\*: 2/);
    assert.match(content, /session-abc/);
    assert.match(content, /2026-07-28T00:00:00\.000Z/);
    // budget 快照 used/max
    assert.match(content, /\| turns \| 2 \| 3 \|/);
    assert.match(content, /\| retries \| 1 \| 2 \|/);
    assert.match(content, /\| tokens \| 1200 \| 0 \|/);
    assert.match(content, /\| time_minutes \| 4 \| 30 \|/);
  });
});

test("幂等: 重复调用全量重写, 内容反映最新快照", async () => {
  await withWorkspace(async (workspacePath) => {
    await projectStateMd({
      workspacePath,
      stateFile: ".loop/STATE.md",
      snapshot: snapshot(),
    });
    await projectStateMd({
      workspacePath,
      stateFile: ".loop/STATE.md",
      snapshot: snapshot({ state: "complete", turn: 3 }),
    });
    const content = await readFile(
      join(workspacePath, ".loop", "STATE.md"),
      "utf-8",
    );
    assert.match(content, /\*\*state\*\*: complete/);
    assert.match(content, /\*\*turn\*\*: 3/);
    assert.doesNotMatch(content, /needs_human/);
  });
});

test("容错: state_file 为空 → 跳过不抛", async () => {
  await withWorkspace(async (workspacePath) => {
    await projectStateMd({
      workspacePath,
      stateFile: "  ",
      snapshot: snapshot(),
    });
  });
});

test("容错: state_file 相对路径逃逸 (../x.md) → 跳过不抛, 不写文件", async () => {
  await withWorkspace(async (workspacePath) => {
    await projectStateMd({
      workspacePath,
      stateFile: "../escape.md",
      snapshot: snapshot(),
    });
    await assert.rejects(readFile(join(workspacePath, "..", "escape.md")));
  });
});

test("容错: state_file 绝对路径逃逸出 workspace → 跳过不抛", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(tmpdir(), `yep-state-md-escape-${process.pid}.md`);
    await projectStateMd({
      workspacePath,
      stateFile: outside,
      snapshot: snapshot(),
    });
    await assert.rejects(readFile(outside, "utf-8"));
  });
});

test("容错: 写失败 (workspacePath 是无法创建的非法路径) → 只 warn 不抛", async () => {
  // 非法路径 (含 NUL 字符) 让 mkdir/writeFile 必然失败
  await projectStateMd({
    workspacePath: "invalid\0path",
    stateFile: ".loop/STATE.md",
    snapshot: snapshot(),
  });
});
