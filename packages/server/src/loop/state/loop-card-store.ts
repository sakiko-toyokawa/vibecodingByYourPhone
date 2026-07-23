/**
 * LoopCardStore manages the loop registry: every registered loop's LoopCard,
 * timestamps, and archived flag.
 *
 * State is persisted to `<dataDir>/loops/loops.json` following the
 * SessionMetadataService pattern (spec: docs/spec/04-存储约定.md):
 * version field + migration chain, fault-tolerant load (corrupt files are
 * backed up instead of crashing the server), debounced serial writes, and
 * temp-file + atomic rename on write-back.
 *
 * Single-writer convention: the server-process `loopCardStore` instance is
 * the only writer of loops.json; all other modules are readers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoopCard } from "@yep-anywhere/shared";

export interface StoredLoop {
  /** Loop id, taken from card.loop.id (LoopCard carries its own id) */
  id: string;
  card: LoopCard;
  created_at: string;
  updated_at: string;
  archived: boolean;
  /**
   * Loop-level pause flag (阶段 2, 03-API契约.md PATCH pause: "无活跃 run
   * 时仅阻止后续触发"). Undefined on pre-phase-2 registries = not paused.
   * While set, LoopRunService.startRun rejects new triggers (loop_paused).
   */
  paused?: boolean;
}

export interface LoopRegistryState {
  /** Schema version for future migrations */
  version: number;
  /** Map of loop id -> stored loop */
  loops: Record<string, StoredLoop>;
}

const CURRENT_VERSION = 1;

export interface LoopCardStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

export class LoopCardStore {
  private state: LoopRegistryState;
  private loopsDir: string;
  private filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: LoopCardStoreOptions = {}) {
    const dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.loopsDir = path.join(dataDir, "loops");
    this.filePath = path.join(this.loopsDir, "loops.json");
    this.state = { version: CURRENT_VERSION, loops: {} };
  }

  /**
   * Initialize the store by loading state from disk.
   * A missing file (ENOENT) means an empty registry; an unparseable file is
   * backed up next to the original and the registry starts fresh.
   */
  async initialize(): Promise<void> {
    console.log(`[LoopCardStore] Initializing from: ${this.filePath}`);
    try {
      // Ensure loops directory exists
      await fs.mkdir(this.loopsDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as LoopRegistryState;
      console.log(
        `[LoopCardStore] Loaded ${Object.keys(parsed.loops ?? {}).length} loops from disk`,
      );

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = { version: CURRENT_VERSION, loops: parsed.loops ?? {} };
      } else {
        this.state = this.migrate(parsed);
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[LoopCardStore] Failed to load state, backing up corrupt file and starting fresh:",
          error,
        );
        await this.backupCorruptFile();
      }
      this.state = { version: CURRENT_VERSION, loops: {} };
    }
  }

  /**
   * Migration chain for older registry versions. Only v1 exists today;
   * older versions are upgraded here segment by segment.
   */
  private migrate(parsed: LoopRegistryState): LoopRegistryState {
    return { version: CURRENT_VERSION, loops: parsed.loops ?? {} };
  }

  /**
   * Move an unparseable loops.json aside so the bad content is preserved
   * for inspection instead of being silently overwritten.
   */
  private async backupCorruptFile(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // Best effort - the registry already starts fresh either way
    }
  }

  /**
   * Get a stored loop by id.
   */
  getLoop(id: string): StoredLoop | undefined {
    return this.state.loops[id];
  }

  /**
   * List stored loops. Archived loops are hidden unless includeArchived is set.
   */
  listLoops(includeArchived = false): StoredLoop[] {
    return Object.values(this.state.loops).filter(
      (loop) => includeArchived || !loop.archived,
    );
  }

  /**
   * Register a new loop. The id comes from card.loop.id (LoopCard carries its
   * own kebab-case id). Callers must check getLoop() first; this overwrites.
   */
  async createLoop(card: LoopCard): Promise<StoredLoop> {
    const now = new Date().toISOString();
    const stored: StoredLoop = {
      id: card.loop.id,
      card,
      created_at: now,
      updated_at: now,
      archived: false,
    };
    this.state.loops[stored.id] = stored;
    await this.save();
    return stored;
  }

  /**
   * Set the loop-level pause flag (03 PATCH pause/resume). Durable across
   * restarts, so triggers stay blocked even when no run state exists.
   */
  async setPaused(
    id: string,
    paused: boolean,
  ): Promise<StoredLoop | undefined> {
    const stored = this.state.loops[id];
    if (!stored) {
      return undefined;
    }
    stored.paused = paused;
    stored.updated_at = new Date().toISOString();
    await this.save();
    return stored;
  }

  /**
   * Soft-delete a loop (03 PATCH archive): hidden from the default list, the
   * file is not deleted (04-存储约定). Callers must refuse archiving loops
   * with an active run before calling this.
   */
  async archiveLoop(id: string): Promise<StoredLoop | undefined> {
    const stored = this.state.loops[id];
    if (!stored) {
      return undefined;
    }
    stored.archived = true;
    stored.updated_at = new Date().toISOString();
    await this.save();
    return stored;
  }

  /**
   * Save state to disk with debouncing to prevent excessive writes.
   */
  private async save(): Promise<void> {
    // If a save is in progress, mark that we need another save
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    // If another save was requested while we were saving, do it now
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      // Temp file + atomic rename so a crash mid-write can't leave a
      // truncated loops.json that fault-tolerant load would silently swallow
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      console.error("[LoopCardStore] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
