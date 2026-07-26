/**
 * In-process cron scheduler (spec: docs/spec/05-分阶段计划.md phase 0).
 *
 * Ticks once per minute, evaluates every registered loop's
 * `card.loop.trigger.cron` against the local time, and fires `onTrigger`
 * for matching loops.
 *
 * Idempotency / dedupe: the dedupe key is `<loop_id>:<minute stamp>`
 * (minute precision, server-local time), so the same cron firing instant
 * can only ignite one run per loop per process — a second tick landing in
 * the same minute is a no-op. Missed instants after a process restart are
 * NOT caught up (phase-0 accepted trade-off, see 05 "风险与依赖").
 *
 * Queue (01-架构 trigger 职责: 排队; 05 阶段 0 改动清单 "去重队列"):
 * - 点火顺序按 `card.loop.schedule.queue` 优先级 (urgent > normal >
 *   background, 缺省 normal), 不再按注册表顺序;
 * - 上一个 run 仍活跃的 loop 不再直接丢弃点火: 进待触发队列 (每 loop
 *   至多一条, 去重), 后续 tick 发现空闲即按优先级补点 —— 队列纯内存,
 *   进程重启即丢 (与"重启不补跑"的既定取舍一致);
 * - same-loop runs stay serial (04-存储约定.md 并发约定), 补点也只在
 *   isRunActive 为 false 时发生。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoopCardStore } from "../state/loop-card-store.js";
import {
  type CronSchedule,
  matchesCron,
  parseCronExpression,
} from "./cron-matcher.js";

export interface CronSchedulerDeps {
  loopCardStore: LoopCardStore;
  /** Fire a run for the loop. Must not throw; errors are the callee's. */
  onTrigger: (loopId: string, dedupeKey: string) => void;
  /** True when the loop currently has an active run (queue this trigger). */
  isRunActive: (loopId: string) => boolean;
  /** Tick interval, defaults to 60s. Injectable for tests. */
  intervalMs?: number;
  /**
   * Yep data directory: 提供后点火键持久化到 loops/trigger/cron-fired.json
   * (幂等键跨进程存活 —— 重启同一分钟内不重复点火; 缺席则保持纯内存)。
   */
  dataDir?: string;
}

type QueuePriority = "urgent" | "normal" | "background";

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  urgent: 0,
  normal: 1,
  background: 2,
};

interface PendingTrigger {
  loopId: string;
  dedupeKey: string;
  priority: QueuePriority;
}

/** Minute-precision stamp used in dedupe keys (local time). */
export function minuteStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function cronDedupeKey(loopId: string, date: Date): string {
  return `${loopId}:${minuteStamp(date)}`;
}

export class CronScheduler {
  private readonly deps: CronSchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private firedKeys = new Set<string>();
  private currentMinute: string | null = null;
  /** Cache parsed schedules per loop id; loops rarely change in phase 0. */
  private parsedCache = new Map<string, CronSchedule | null>();
  private warnedLoops = new Set<string>();
  /** 待触发队列 (去重: 每 loop 至多一条); 纯内存, 重启即丢。 */
  private pending: PendingTrigger[] = [];
  private readonly firedFile: string | null;
  private firedLoaded = false;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
    this.firedFile = deps.dataDir
      ? path.join(deps.dataDir, "loops", "trigger", "cron-fired.json")
      : null;
  }

  /**
   * 点火键持久化 (loops/trigger/cron-fired.json): 进程重启后同一分钟内
   * 不重复点火 —— 内存 Set 只管进程生命周期, 文件管进程边界。容错加
   * 载 (坏文件当空), tmp+rename 写回。
   */
  private async loadFired(now: Date): Promise<void> {
    if (!this.firedFile || this.firedLoaded) {
      return;
    }
    this.firedLoaded = true;
    const currentStamp = minuteStamp(now);
    try {
      const content = await fs.readFile(this.firedFile, "utf-8");
      const parsed = JSON.parse(content) as { keys?: unknown };
      if (Array.isArray(parsed.keys)) {
        for (const key of parsed.keys) {
          // 键的时效就是它的分钟戳: 只保留本分钟的键, 历史键自然淘汰
          if (typeof key === "string" && key.endsWith(`:${currentStamp}`)) {
            this.firedKeys.add(key);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[CronScheduler] cron-fired.json 损坏, 按空集起步:",
          error,
        );
      }
    }
    // 加载的键属于当前分钟: 锚定 currentMinute, 避免 tick 的分钟滚动
    // 把刚加载的键当即刻过期的旧键清掉
    this.currentMinute = currentStamp;
  }

  private async saveFired(): Promise<void> {
    if (!this.firedFile) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(this.firedFile), { recursive: true });
      const tmpPath = `${this.firedFile}.tmp`;
      await fs.writeFile(
        tmpPath,
        `${JSON.stringify({ version: 1, keys: [...this.firedKeys] }, null, 2)}\n`,
        "utf-8",
      );
      await fs.rename(tmpPath, this.firedFile);
    } catch (error) {
      // 持久化失败不阻塞点火 (run_active 仍是并发兜底)
      console.warn("[CronScheduler] cron-fired.json 写回失败:", error);
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      // A tick must never take the server down
      void this.tick(new Date()).catch((error) => {
        console.error("[CronScheduler] tick failed:", error);
      });
    }, this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluate all loops against `now`. Returns the dedupe keys fired this
   * tick (exposed for tests and logging).
   */
  async tick(now: Date): Promise<string[]> {
    await this.loadFired(now);
    const stamp = minuteStamp(now);
    if (stamp !== this.currentMinute) {
      // A new minute invalidates every older dedupe key — cron expressions
      // can never re-match a past minute, so old keys only cost memory.
      this.firedKeys.clear();
      this.currentMinute = stamp;
    }

    const fired: string[] = [];
    // 本 tick 已点火的 loop: 待触发补点与新到期在同一 tick 不重复点火
    // (一个 tick 一个 loop 至多一次; 新到期的下一分钟照常评估)。
    const firedLoops = new Set<string>();
    // 1. 先补点待触发队列里已空闲的 loop (优先级 + 先来后到)。
    this.drainPending(fired, firedLoops);

    // 2. 收集本分钟到期的 loop, 按 queue 优先级排序后点火。
    const due: PendingTrigger[] = [];
    for (const stored of this.deps.loopCardStore.listLoops()) {
      const trigger = stored.card.loop.trigger;
      if (trigger.type !== "schedule" || !trigger.cron) {
        continue;
      }
      if (firedLoops.has(stored.id)) {
        continue;
      }

      const schedule = this.parseCached(stored.id, trigger.cron);
      if (!schedule || !matchesCron(schedule, now)) {
        continue;
      }

      const dedupeKey = cronDedupeKey(stored.id, now);
      if (this.firedKeys.has(dedupeKey)) {
        continue; // idempotent: same firing instant ignites only once
      }
      due.push({
        loopId: stored.id,
        dedupeKey,
        priority: stored.card.loop.schedule?.queue ?? "normal",
      });
    }
    due.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    for (const entry of due) {
      if (this.deps.isRunActive(entry.loopId)) {
        this.enqueue(entry); // 忙时不丢弃, 进待触发队列 (去重)
        continue;
      }
      this.fire(entry, fired, firedLoops);
    }
    // 点火键落盘 (本 tick 批量一次; tick 返回即持久化完成)
    await this.saveFired();
    return fired;
  }

  /** 补点待触发队列里已空闲的 loop (优先级排序, 同优先级按入队先后)。 */
  private drainPending(fired: string[], firedLoops: Set<string>): void {
    if (this.pending.length === 0) {
      return;
    }
    this.pending.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    );
    const remaining: PendingTrigger[] = [];
    for (const entry of this.pending) {
      if (this.deps.isRunActive(entry.loopId)) {
        remaining.push(entry);
        continue;
      }
      this.fire(entry, fired, firedLoops);
    }
    this.pending = remaining;
  }

  private enqueue(entry: PendingTrigger): void {
    // 去重队列: 同一 loop 至多一条待触发 (保留最早的到期时刻)
    if (this.pending.some((p) => p.loopId === entry.loopId)) {
      return;
    }
    this.pending.push(entry);
  }

  private fire(
    entry: PendingTrigger,
    fired: string[],
    firedLoops: Set<string>,
  ): void {
    this.firedKeys.add(entry.dedupeKey);
    firedLoops.add(entry.loopId);
    fired.push(entry.dedupeKey);
    this.deps.onTrigger(entry.loopId, entry.dedupeKey);
  }

  private parseCached(loopId: string, cron: string): CronSchedule | null {
    if (!this.parsedCache.has(loopId)) {
      try {
        this.parsedCache.set(loopId, parseCronExpression(cron));
      } catch (error) {
        // Invalid cron must not crash the scheduler; warn once per loop.
        this.parsedCache.set(loopId, null);
        if (!this.warnedLoops.has(loopId)) {
          this.warnedLoops.add(loopId);
          console.warn(
            `[CronScheduler] Loop '${loopId}' has an invalid cron expression, skipping:`,
            error,
          );
        }
      }
    }
    return this.parsedCache.get(loopId) ?? null;
  }
}
