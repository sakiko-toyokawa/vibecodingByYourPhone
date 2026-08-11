/**
 * Persistent external trigger queue (webhook / issue / resume).
 *
 * Entries live in `<dataDir>/loops/trigger/queue.jsonl` so a server restart
 * does not lose an accepted external event. Appends are serialized through a
 * per-file promise chain; invalid lines are skipped with a warning.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type TriggerSource = "webhook" | "issue" | "resume";
export type TriggerQueueState = "pending" | "done" | "failed";

export interface TriggerQueueEntry {
  event_id: string;
  loop_id: string;
  source: TriggerSource;
  priority: "urgent" | "normal" | "background";
  payload: Record<string, unknown>;
  state: TriggerQueueState;
  attempts: number;
  enqueued_at: string;
  updated_at: string;
  error?: string;
}

export interface TriggerQueueStoreOptions {
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class TriggerQueueStore {
  private readonly filePath: string;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(options: TriggerQueueStoreOptions = {}) {
    this.filePath = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "trigger",
      "queue.jsonl",
    );
  }

  async enqueue(input: {
    event_id: string;
    loop_id: string;
    source: TriggerSource;
    priority?: TriggerQueueEntry["priority"];
    payload?: Record<string, unknown>;
  }): Promise<TriggerQueueEntry> {
    const existing = await this.findByEventId(input.event_id);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const entry: TriggerQueueEntry = {
      event_id: input.event_id,
      loop_id: input.loop_id,
      source: input.source,
      priority: input.priority ?? "normal",
      payload: input.payload ?? {},
      state: "pending",
      attempts: 0,
      enqueued_at: now,
      updated_at: now,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const previous = this.appendChain;
    const next = previous.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf-8");
    });
    this.appendChain = next.catch((error) => {
      console.warn("[TriggerQueueStore] queue append failed:", error);
    });
    await next;
    return entry;
  }

  async listPending(loopId?: string): Promise<TriggerQueueEntry[]> {
    return (await this.readAll()).filter(
      (entry) =>
        entry.state === "pending" && (!loopId || entry.loop_id === loopId),
    );
  }

  async findByEventId(eventId: string): Promise<TriggerQueueEntry | null> {
    return (
      (await this.readAll()).find((entry) => entry.event_id === eventId) ?? null
    );
  }

  async mark(
    eventId: string,
    state: TriggerQueueState,
    error?: string,
  ): Promise<void> {
    const entries = await this.readAll();
    const target = entries.find((entry) => entry.event_id === eventId);
    if (!target) {
      return;
    }
    target.state = state;
    target.attempts += 1;
    target.updated_at = new Date().toISOString();
    if (error) {
      target.error = error;
    }
    const tmpPath = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      tmpPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );
    await fs.rename(tmpPath, this.filePath);
  }

  private async readAll(): Promise<TriggerQueueEntry[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const entries: TriggerQueueEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed) as TriggerQueueEntry);
      } catch {
        console.warn("[TriggerQueueStore] skipping invalid queue line");
      }
    }
    return entries;
  }
}
