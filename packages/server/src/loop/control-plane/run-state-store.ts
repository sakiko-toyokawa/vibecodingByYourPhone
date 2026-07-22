/**
 * Run state store (spec: docs/spec/04-存储约定.md, 02-schema契约.md §7).
 *
 * Persists run_state snapshots as `state/<loop_id>.json` — one file per
 * loop holding the current run's state-machine record (same-loop runs are
 * serial, so one file per loop is sufficient). Whole-file read / write-back
 * following the SessionMetadataService pattern (06 hard constraint #9):
 * tolerant load (ENOENT → null, corrupt → null + warning, never crashes the
 * server) and atomic write via temp file + rename.
 *
 * Single-writer convention (04): only the control-plane writes these files;
 * trigger / assembly / API are readers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type RunStateRecord,
  RunStateRecordSchema,
} from "@yep-anywhere/shared";

/** loop ids (kebab-case) must stay inside the state directory. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface RunStateStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class RunStateStore {
  private readonly stateDir: string;

  constructor(options: RunStateStoreOptions = {}) {
    this.stateDir = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "state",
    );
  }

  /** Load the current run_state for a loop; null when absent or corrupt. */
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
    try {
      return RunStateRecordSchema.parse(JSON.parse(content));
    } catch (error) {
      console.warn(
        `[RunStateStore] state/${loopId}.json failed validation; treating as absent:`,
        error,
      );
      return null;
    }
  }

  /** Persist a run_state snapshot (validated, atomic temp-file + rename). */
  async save(loopId: string, state: RunStateRecord): Promise<void> {
    this.assertSafeName(loopId);
    const validated = RunStateRecordSchema.parse(state);
    await fs.mkdir(this.stateDir, { recursive: true });
    const filePath = this.filePath(loopId);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(
      tmpPath,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf-8",
    );
    await fs.rename(tmpPath, filePath);
  }

  /** All stored run_state snapshots (corrupt files are skipped). */
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
      if (!file.endsWith(".json")) {
        continue;
      }
      const loopId = file.slice(0, -".json".length);
      const state = await this.load(loopId);
      if (state) {
        states.push({ loopId, state });
      }
    }
    return states;
  }

  private filePath(loopId: string): string {
    return path.join(this.stateDir, `${loopId}.json`);
  }

  private assertSafeName(loopId: string): void {
    if (!SAFE_NAME.test(loopId)) {
      throw new Error(
        `[RunStateStore] unsafe loop_id: '${loopId}' (must match ${SAFE_NAME})`,
      );
    }
  }
}
