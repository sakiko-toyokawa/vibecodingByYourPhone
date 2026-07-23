import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FailurePattern } from "@yep-anywhere/shared";
import { FailurePatternStore } from "./failure-pattern-store.js";

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    pattern_id: "fp_ci_retry_loop",
    type: "context_error",
    summary: "CI 修复任务反复缺少 pnpm workspace 规则",
    signature: "context_error:ci:missing-pnpm-workspace-rules",
    occurrence_count: 3,
    first_seen_at: "2026-07-18T09:00:00.000Z",
    last_seen_at: "2026-07-20T10:05:00.000Z",
    evidence_runs: ["run_001", "run_004", "run_009"],
    affected_loop_specs: ["loop_ci_fix"],
    suggested_action: "proposal_required",
    status: "open",
    ...overrides,
  };
}

async function withStore(
  fn: (ctx: { dataDir: string; store: FailurePatternStore }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-failure-pattern-"));
  try {
    const store = new FailurePatternStore({ dataDir });
    await fn({ dataDir, store });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("upsert + get + list，重启（重新 initialize）后仍在", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-failure-pattern-"));
  try {
    const store = new FailurePatternStore({ dataDir });
    await store.initialize();
    await store.upsert(makePattern());
    await store.upsert(
      makePattern({
        pattern_id: "fp_tool_timeout",
        type: "tool_error",
        occurrence_count: 2,
      }),
    );
    assert.equal(store.list().length, 2);
    assert.equal(store.get("fp_tool_timeout")?.type, "tool_error");

    // 整文件写回持久化：新实例读回同一文件
    const reopened = new FailurePatternStore({ dataDir });
    await reopened.initialize();
    assert.equal(reopened.list().length, 2);
    assert.equal(reopened.get("fp_ci_retry_loop")?.occurrence_count, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("upsert 同 pattern_id 覆盖（worker 聚类更新出现次数）", async () => {
  await withStore(async ({ store }) => {
    await store.initialize();
    await store.upsert(makePattern({ occurrence_count: 3 }));
    await store.upsert(
      makePattern({
        occurrence_count: 4,
        evidence_runs: ["run_001", "run_004", "run_009", "run_012"],
      }),
    );
    assert.equal(store.list().length, 1);
    assert.equal(store.get("fp_ci_retry_loop")?.occurrence_count, 4);
  });
});

test("损坏的 failure-patterns.json：备份 .corrupt-<ts> 并从空启动（worker 不崩）", async () => {
  await withStore(async ({ dataDir, store }) => {
    await store.initialize();
    await store.upsert(makePattern());
    const filePath = store.getFilePath();

    // 写入垃圾模拟文件损坏
    await writeFile(filePath, "{ not json !!!", "utf-8");

    const recovered = new FailurePatternStore({ dataDir });
    await recovered.initialize(); // 不抛
    assert.deepEqual(recovered.list(), []);

    // 损坏文件被备份保留，未被静默覆盖
    const files = await readdir(join(dataDir, "loops", "learning"));
    assert.ok(
      files.some((f) => f.startsWith("failure-patterns.json.corrupt-")),
      `expected a .corrupt- backup in ${files.join(", ")}`,
    );

    // 从空启动后可继续写入
    await recovered.upsert(makePattern({ pattern_id: "fp_new" }));
    assert.equal(recovered.get("fp_new")?.status, "open");
  });
});

test("schema 非法条目视为损坏文件：备份并从空启动", async () => {
  await withStore(async ({ dataDir, store }) => {
    await store.initialize();
    const filePath = store.getFilePath();
    // 结构合法但条目违反 schema（type 不是 8 值归因词汇）
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        patterns: { fp_bad: { ...makePattern(), type: "weird_error" } },
      }),
      "utf-8",
    );
    const recovered = new FailurePatternStore({ dataDir });
    await recovered.initialize();
    assert.deepEqual(recovered.list(), []);
  });
});

test("缺文件（ENOENT）= 空账本，不产生备份", async () => {
  await withStore(async ({ dataDir, store }) => {
    await store.initialize();
    assert.deepEqual(store.list(), []);
    const dir = join(dataDir, "loops", "learning");
    const files = await readdir(dir).catch(() => [] as string[]);
    assert.ok(!files.some((f) => f.includes(".corrupt-")));
  });
});
