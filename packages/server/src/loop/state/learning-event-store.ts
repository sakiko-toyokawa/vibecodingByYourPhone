/**
 * Learning event store (spec: docs/spec/04-存储约定.md learning/ 布局,
 * 02-schema契约.md §8.4).
 *
 * - `learning/events.jsonl`: append-only, one learning_event per line. The
 *   main chain (control-plane, on a run reaching a terminal decision or a
 *   decision carrying failure_tags) is the only writer; the learning worker
 *   is a read-only consumer. Appends are serialized through a promise chain.
 * - `learning/cursor.json`: the worker's consumption position (line offset
 *   into events.jsonl). Whole-file write-back with temp-file + atomic
 *   rename; the worker is its single writer (04 单写者表). A missing or
 *   corrupt cursor reads as offset 0 (worker re-consumes from the start —
 *   event_ids are idempotency keys, so re-consumption is safe).
 *
 * Offset semantics are line-based: events.jsonl is append-only, so line
 * positions are stable. readEvents skips corrupt/invalid lines but still
 * advances the offset past them — a bad line is consumed once, never
 * re-read, and never crashes the reader.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type LearningEvent, LearningEventSchema } from "@yep-anywhere/shared";

export interface LearningEventStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

export interface ReadEventsResult {
  /** Valid events at lines >= fromOffset, in file order. */
  events: LearningEvent[];
  /** Offset to persist as the cursor once the returned events are consumed. */
  nextOffset: number;
}

interface CursorFile {
  version: number;
  offset: number;
  updated_at: string;
}

const CURSOR_VERSION = 1;

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class LearningEventStore {
  private readonly learningDir: string;
  private readonly eventsFile: string;
  private readonly cursorFile: string;
  /** Append serialization (04: appends go through one writer) */
  private appendChain: Promise<void> = Promise.resolve();

  constructor(options: LearningEventStoreOptions = {}) {
    this.learningDir = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "learning",
    );
    this.eventsFile = path.join(this.learningDir, "events.jsonl");
    this.cursorFile = path.join(this.learningDir, "cursor.json");
  }

  /**
   * Append a learning_event (main-chain writer). The event is validated
   * against LearningEventSchema before writing. Callers on the main chain
   * must treat this as fire-and-forget (只发不等): a rejection is logged by
   * the emitter, never propagated into run progression.
   */
  async appendEvent(event: LearningEvent): Promise<void> {
    const validated = LearningEventSchema.parse(event);
    const line = `${JSON.stringify(validated)}\n`;
    const next = this.appendChain.then(async () => {
      await fs.mkdir(this.learningDir, { recursive: true });
      await fs.appendFile(this.eventsFile, line, "utf-8");
    });
    // Keep the chain alive even if one append fails
    this.appendChain = next.catch((error) => {
      console.error("[LearningEventStore] append failed:", error);
    });
    return next;
  }

  /**
   * Read events from a line offset (worker consumption). Corrupt or
   * schema-invalid lines are skipped with a warning but still count toward
   * nextOffset, so the worker never re-reads a poisoned line.
   */
  async readEvents(fromOffset = 0): Promise<ReadEventsResult> {
    let content: string;
    try {
      content = await fs.readFile(this.eventsFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], nextOffset: fromOffset };
      }
      throw error;
    }

    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const events: LearningEvent[] = [];
    for (let i = Math.max(0, fromOffset); i < lines.length; i++) {
      const line = lines[i] as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(
          `[LearningEventStore] skipping unparseable line ${i} in events.jsonl`,
        );
        continue;
      }
      const result = LearningEventSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[LearningEventStore] learning_event at line ${i} failed schema validation:`,
          result.error,
        );
        continue;
      }
      events.push(result.data);
    }
    return { events, nextOffset: lines.length };
  }

  /**
   * Read the worker's consumption cursor (learning/cursor.json). A missing
   * or corrupt cursor means offset 0 — re-consumption is safe because
   * event_id is an idempotency key (02 §8.4).
   */
  async readCursor(): Promise<number> {
    try {
      const content = await fs.readFile(this.cursorFile, "utf-8");
      const parsed = JSON.parse(content) as Partial<CursorFile>;
      if (
        typeof parsed.offset === "number" &&
        Number.isInteger(parsed.offset) &&
        parsed.offset >= 0
      ) {
        return parsed.offset;
      }
      console.warn(
        "[LearningEventStore] cursor.json has no valid offset; consuming from 0",
      );
      return 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[LearningEventStore] failed to read cursor.json; consuming from 0:",
          error,
        );
      }
      return 0;
    }
  }

  /**
   * Persist the worker's consumption cursor (worker single writer).
   * Whole-file write-back with temp-file + atomic rename.
   */
  async writeCursor(offset: number): Promise<void> {
    const cursor: CursorFile = {
      version: CURSOR_VERSION,
      offset,
      updated_at: new Date().toISOString(),
    };
    await fs.mkdir(this.learningDir, { recursive: true });
    const tmpPath = `${this.cursorFile}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(cursor, null, 2), "utf-8");
    await fs.rename(tmpPath, this.cursorFile);
  }

  /**
   * 04 容量与清理: 截断"消费位点之前且 created_at 早于 cutoff"的行。
   * 未消费行 (>= cursor) 与无法解析 created_at 的行一律保留 (宁可多留
   * 不误删)。返回删除行数与调整后的 cursor (被删行都在消费位点之前,
   * cursor 前移相应行数)。
   */
  async truncateConsumedBefore(
    cutoffIso: string,
    cursor: number,
  ): Promise<{ removed: number; newCursor: number }> {
    let content: string;
    try {
      content = await fs.readFile(this.eventsFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { removed: 0, newCursor: cursor };
      }
      throw error;
    }
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const kept: string[] = [];
    let removed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (i < cursor && isOlderThan(line, cutoffIso)) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) {
      const tmpPath = `${this.eventsFile}.tmp`;
      await fs.writeFile(tmpPath, `${kept.join("\n")}\n`, "utf-8");
      await fs.rename(tmpPath, this.eventsFile);
    }
    return { removed, newCursor: Math.max(0, cursor - removed) };
  }
}

/** created_at 早于 cutoff 才删; 解析不出时间戳的行返回 false (保留)。 */
function isOlderThan(line: string, cutoffIso: string): boolean {
  try {
    const createdAt = (JSON.parse(line) as { created_at?: unknown }).created_at;
    return typeof createdAt === "string" && createdAt < cutoffIso;
  } catch {
    return false;
  }
}
