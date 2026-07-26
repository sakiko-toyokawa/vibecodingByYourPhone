/**
 * loops/ 存储的容量清理 (04-存储约定.md 容量与清理一节; 修复
 * docs/plans/loop-spec-gap-fix-plan.md #23: 此前零清理, 账本与
 * events.jsonl 无限增长)。
 *
 * 保留线 (04 建议值, 常量化于此; LoopCard cleanup_rule 覆盖未排期):
 * - runs/<run_id>.jsonl: 每 loop 保留最近 20 轮完整账本; 更早的压缩为
 *   仅 run_ledger_entry 行 (决策明细剔除);
 * - artifacts/<run_id>/: 随账本生命周期, 最近 20 轮全量保留; 超出后
 *   删除, 但 complete/failed 的 run 永久保留最小证据 (judgment-report
 *   与 diff 系列文件 —— 04 写的是 judgment_report.json/diff.patch,
 *   实现是 per-turn 命名, 两者都认);
 * - learning/events.jsonl: worker 消费位点之前、且超过 30 天的行截断;
 * - state/ proposals/ failure-patterns.json: 不清理 (04 明确)。
 *
 * 安全: 不动任何非终态 run (active/retry/needs_human/paused/
 * budget_limited) 引用的对象 —— 先扫描 state/*.json 的保护集合。
 * 由 learning worker 的定时任务顺带驱动 (04: worker 本来就是唯一的
 * 定期后台任务)。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunStateStore } from "../control-plane/run-state-store.js";
import type { LearningEventStore } from "./learning-event-store.js";
import type { RunLedgerStore } from "./run-ledger-store.js";

/** 非终态: 这些状态的 run 的一切文件受保护, 不清理。 */
const PROTECTED_STATES = new Set([
  "active",
  "retry",
  "needs_human",
  "paused",
  "budget_limited",
]);

/** 终态 run 永久保留的最小证据文件名模式 (含 per-turn 命名变体)。 */
const KEEP_ARTIFACT = /^(judgment[-_]report.*\.json|diff.*\.patch)$/;

export interface LoopCleanupDeps {
  runLedgerStore: RunLedgerStore;
  learningEventStore: LearningEventStore;
  runStateStore: RunStateStore;
  now?: () => Date;
}

export interface LoopCleanupOptions {
  /** 每 loop 保留的完整账本轮数 (04 建议值 20) */
  keepRunsPerLoop?: number;
  /** events.jsonl 已消费行的保留天数 (04 建议值 30) */
  eventsMaxAgeDays?: number;
}

export interface LoopCleanupResult {
  /** 被压缩 (剔除 decision_entry 行) 的账本数 */
  ledgersCompressed: number;
  /** 被删除的 artifact 文件数 */
  artifactFilesDeleted: number;
  /** 被截断的 events.jsonl 行数 */
  eventsTruncated: number;
}

export async function runLoopStorageCleanup(
  deps: LoopCleanupDeps,
  options: LoopCleanupOptions = {},
): Promise<LoopCleanupResult> {
  const keep = options.keepRunsPerLoop ?? 20;
  const maxAgeDays = options.eventsMaxAgeDays ?? 30;
  const now = deps.now ?? (() => new Date());
  const result: LoopCleanupResult = {
    ledgersCompressed: 0,
    artifactFilesDeleted: 0,
    eventsTruncated: 0,
  };

  // 1. 活跃 run 保护集合 (04: 不动任何当前活跃 run 引用的对象)
  const protectedRunIds = new Set<string>();
  for (const { state: record } of await deps.runStateStore.list()) {
    if (PROTECTED_STATES.has(record.state)) {
      protectedRunIds.add(record.run_id);
    }
  }

  // 2. 账本按 loop 分组, 超出保留线的压缩 + 裁剪 artifacts
  const runIds = await deps.runLedgerStore.listRunIds();
  const byLoop = new Map<
    string,
    { runId: string; createdAt: string; finalStatus: string }[]
  >();
  for (const runId of runIds) {
    if (protectedRunIds.has(runId)) {
      continue;
    }
    const entry = await deps.runLedgerStore.readEntry(runId);
    if (!entry) {
      continue;
    }
    const list = byLoop.get(entry.loop_id) ?? [];
    list.push({
      runId,
      createdAt: entry.created_at,
      finalStatus: entry.final_status,
    });
    byLoop.set(entry.loop_id, list);
  }

  for (const runs of byLoop.values()) {
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const expired of runs.slice(keep)) {
      if (await deps.runLedgerStore.compressLedgerToRunEntries(expired.runId)) {
        result.ledgersCompressed += 1;
      }
      result.artifactFilesDeleted += await pruneArtifacts(
        deps.runLedgerStore,
        expired,
      );
    }
  }

  // 3. events.jsonl: 消费位点之前且超龄的行截断
  const cursor = await deps.learningEventStore.readCursor();
  const cutoff = new Date(
    now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const truncated = await deps.learningEventStore.truncateConsumedBefore(
    cutoff,
    cursor,
  );
  if (truncated.removed > 0) {
    await deps.learningEventStore.writeCursor(truncated.newCursor);
    result.eventsTruncated = truncated.removed;
  }

  return result;
}

/** 删除过期 run 的 artifact 文件 (终态 run 保留最小证据两件套)。 */
async function pruneArtifacts(
  store: RunLedgerStore,
  run: { runId: string; finalStatus: string },
): Promise<number> {
  const dir = store.artifactsDirFor(run.runId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0; // 目录不存在 (ENOENT) — 无可清理
  }
  const keepForRun =
    run.finalStatus === "complete" || run.finalStatus === "failed";
  let deleted = 0;
  for (const name of names) {
    if (keepForRun && KEEP_ARTIFACT.test(name)) {
      continue;
    }
    await fs.rm(path.join(dir, name), { force: true });
    deleted += 1;
  }
  // 空目录一并收掉 (保留最小证据时目录非空)
  const rest = await fs.readdir(dir).catch(() => [] as string[]);
  if (rest.length === 0) {
    await fs.rmdir(dir).catch(() => {});
  }
  return deleted;
}
