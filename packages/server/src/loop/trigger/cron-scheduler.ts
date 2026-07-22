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
 * Concurrency: a loop whose previous run is still active is skipped
 * (same-loop runs are serial, see 04-存储约定.md 并发约定).
 */

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
  /** True when the loop currently has an active run (skip this tick). */
  isRunActive: (loopId: string) => boolean;
  /** Tick interval, defaults to 60s. Injectable for tests. */
  intervalMs?: number;
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

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      try {
        this.tick(new Date());
      } catch (error) {
        // A tick must never take the server down
        console.error("[CronScheduler] tick failed:", error);
      }
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
  tick(now: Date): string[] {
    const stamp = minuteStamp(now);
    if (stamp !== this.currentMinute) {
      // A new minute invalidates every older dedupe key — cron expressions
      // can never re-match a past minute, so old keys only cost memory.
      this.firedKeys.clear();
      this.currentMinute = stamp;
    }

    const fired: string[] = [];
    for (const stored of this.deps.loopCardStore.listLoops()) {
      const trigger = stored.card.loop.trigger;
      if (trigger.type !== "schedule" || !trigger.cron) {
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
      if (this.deps.isRunActive(stored.id)) {
        continue; // same-loop runs are serial
      }

      this.firedKeys.add(dedupeKey);
      fired.push(dedupeKey);
      this.deps.onTrigger(stored.id, dedupeKey);
    }
    return fired;
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
