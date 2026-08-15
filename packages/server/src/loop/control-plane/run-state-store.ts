/**
 * Run state store (spec: docs/spec/04-存储约定.md, 02-schema契约.md §7).
 *
 * Phase 6: `state/<loop_id>.json` 直接切換為 `state/<loop_id>.jsonl`。
 * - 每個 event append-only，控制面遷移寫 `state_snapshot`，每輪完成後寫
 *   `checkpoint`。
 * - 每行帶 `schema_version` 與 `checksum`；讀取時壞行跳過，最新有效
 *   snapshot 為目前 run_state。
 * - 寫入同時使用 per-file promise chain 與 proper-lockfile，避免單進程
 *   交錯與跨進程併寫。
 * - 舊 `.json` 不做自動遷移（已決定直接切換），只保留原檔。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type RunStateCheckpoint,
  type RunStateEvent,
  RunStateEventSchema,
  type RunStateRecord,
  RunStateRecordSchema,
  type WorkspaceSnapshot,
} from "@yep-anywhere/shared";
import { checksumOfJson, sha256Hex } from "../../utils/checksum.js";
import { withFileLock } from "../../utils/fileLock.js";

/** loop ids (kebab-case) must stay inside the state directory. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface RunStateStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

export interface RunStateCheckpointInput {
  run_id: string;
  state: RunStateRecord["state"];
  turn: number;
  workspace_snapshot: WorkspaceSnapshot | null;
  artifact_manifest_hash: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class RunStateStore {
  private readonly stateDir: string;
  /** Per-file write serialization (same-loop state transitions are serial). */
  private writeChains = new Map<string, Promise<void>>();

  constructor(options: RunStateStoreOptions = {}) {
    this.stateDir = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "state",
    );
  }

  /** Load the latest valid state_snapshot for a loop; null when absent. */
  async load(loopId: string): Promise<RunStateRecord | null> {
    this.assertSafeName(loopId);
    let content: string;
    try {
      content = await fs.readFile(this.filePath(loopId), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let latest: RunStateRecord | null = null;
    for (const event of this.parseEvents(loopId, content)) {
      if (event.type === "state_snapshot") {
        latest = event.record;
      }
    }
    return latest;
  }

  /**
   * Append a validated run_state snapshot event. Keeps the existing
   * `save(loopId, state)` signature so control-plane readers do not change.
   */
  async save(loopId: string, state: RunStateRecord): Promise<void> {
    this.assertSafeName(loopId);
    const record = RunStateRecordSchema.parse(state);
    const created_at = new Date().toISOString();
    const event_id = `state-snapshot-${randomUUID()}`;
    const payload = {
      type: "state_snapshot" as const,
      schema_version: 2,
      event_id,
      loop_id: loopId,
      record,
      created_at,
    };
    const checksum = checksumOfJson(payload);
    await this.enqueueWrite(
      loopId,
      `${JSON.stringify({ ...payload, checksum })}\n`,
    );
  }

  /** Append a checkpoint event after a completed turn. */
  async appendCheckpoint(
    loopId: string,
    input: RunStateCheckpointInput,
  ): Promise<void> {
    this.assertSafeName(loopId);
    const payload = {
      type: "checkpoint" as const,
      schema_version: 2,
      event_id: `checkpoint-${randomUUID()}`,
      loop_id: loopId,
      run_id: input.run_id,
      state: input.state,
      turn: input.turn,
      workspace_snapshot: input.workspace_snapshot,
      artifact_manifest_hash: input.artifact_manifest_hash,
      created_at: new Date().toISOString(),
    };
    const checksum = checksumOfJson(payload);
    await this.enqueueWrite(
      loopId,
      `${JSON.stringify({ ...payload, checksum })}\n`,
    );
  }

  /** Latest valid checkpoint event for a loop; null when absent. */
  async latestCheckpoint(loopId: string): Promise<RunStateCheckpoint | null> {
    this.assertSafeName(loopId);
    let content: string;
    try {
      content = await fs.readFile(this.filePath(loopId), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let latest: RunStateCheckpoint | null = null;
    for (const event of this.parseEvents(loopId, content)) {
      if (event.type === "checkpoint") {
        latest = event;
      }
    }
    return latest;
  }

  /** Permanently remove a loop's run-state event log. */
  async deleteLoop(loopId: string): Promise<void> {
    this.assertSafeName(loopId);
    await fs.rm(this.filePath(loopId), { force: true }).catch(() => {});
  }

  /** All valid state events, oldest first. */
  async readEvents(loopId: string): Promise<RunStateEvent[]> {
    this.assertSafeName(loopId);
    try {
      const content = await fs.readFile(this.filePath(loopId), "utf-8");
      return this.parseEvents(loopId, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /** All stored run_state snapshots (corrupt/checkpoint lines are skipped). */
  async list(): Promise<{ loopId: string; state: RunStateRecord }[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const states: { loopId: string; state: RunStateRecord }[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const loopId = file.slice(0, -".jsonl".length);
      const state = await this.load(loopId);
      if (state) {
        states.push({ loopId, state });
      }
    }
    return states;
  }

  private parseEvents(loopId: string, content: string): RunStateEvent[] {
    const events: RunStateEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        console.warn(
          `[RunStateStore] skipping unparseable line in state/${loopId}.jsonl`,
        );
        continue;
      }
      const result = RunStateEventSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[RunStateStore] state/${loopId}.jsonl event failed schema validation:`,
          result.error,
        );
        continue;
      }
      const { checksum, ...payload } = result.data;
      if (checksum !== checksumOfJson(payload)) {
        console.warn(
          `[RunStateStore] checksum mismatch in state/${loopId}.jsonl event ${result.data.event_id}; rolling back to the previous valid event`,
        );
        continue;
      }
      events.push(result.data);
    }
    return events;
  }

  private enqueueWrite(loopId: string, line: string): Promise<void> {
    const filePath = this.filePath(loopId);
    const previous = this.writeChains.get(loopId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await fs.mkdir(this.stateDir, { recursive: true });
      await fs.writeFile(filePath, "", { flag: "a" });
      await withFileLock(filePath, async () => {
        await fs.appendFile(filePath, line, "utf-8");
      });
    });
    this.writeChains.set(
      loopId,
      next.catch((error) => {
        console.error(
          `[RunStateStore] append failed for ${loopId}: ${String(error)}`,
        );
      }),
    );
    return next;
  }

  private filePath(loopId: string): string {
    return path.join(this.stateDir, `${loopId}.jsonl`);
  }

  private assertSafeName(loopId: string): void {
    if (!SAFE_NAME.test(loopId)) {
      throw new Error(
        `[RunStateStore] unsafe loop_id: '${loopId}' (must match ${SAFE_NAME})`,
      );
    }
  }
}

export { sha256Hex };
