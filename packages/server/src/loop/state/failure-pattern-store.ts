/**
 * Failure pattern store — the failure pattern ledger
 * (spec: docs/spec/02-schema契约.md §8.3, 04-存储约定.md learning/ 布局).
 *
 * Persisted as a single whole file `learning/failure-patterns.json`
 * following the SessionMetadataService pattern: version field + migration
 * chain, fault-tolerant load (a corrupt file is backed up to
 * `.corrupt-<ts>` and the ledger starts empty — the worker must not crash),
 * debounced serial writes, and temp-file + atomic rename on write-back.
 *
 * Single-writer convention (04 单写者表): only the learning worker writes
 * this file; assembly (memory packet 摘要) and the API are readers.
 *
 * Entry semantics (失败模式账本.md): a single failure does not enter the
 * pattern layer — only recurring failures do. The store is dumb storage;
 * the recurrence policy (occurrence_count, signature clustering) is the
 * worker's job.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type FailurePattern,
  FailurePatternSchema,
} from "@yep-anywhere/shared";

export interface FailurePatternStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

interface PatternLedgerState {
  /** Schema version for future migrations */
  version: number;
  /** Map of pattern_id -> failure pattern */
  patterns: Record<string, FailurePattern>;
}

const CURRENT_VERSION = 1;

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class FailurePatternStore {
  private state: PatternLedgerState;
  private readonly filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: FailurePatternStoreOptions = {}) {
    const dataDir = options.dataDir ?? defaultDataDir();
    this.filePath = path.join(
      dataDir,
      "loops",
      "learning",
      "failure-patterns.json",
    );
    this.state = { version: CURRENT_VERSION, patterns: {} };
  }

  /**
   * Load the ledger from disk. A missing file (ENOENT) means an empty
   * ledger; an unparseable or schema-invalid file is backed up next to the
   * original and the ledger starts empty — the worker never crashes on a
   * corrupt ledger.
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as PatternLedgerState;
      if (parsed.version === CURRENT_VERSION) {
        // Validate every entry; one bad entry poisons the file (整文件写回),
        // so treat it as corrupt rather than silently dropping it.
        const patterns: Record<string, FailurePattern> = {};
        for (const [id, pattern] of Object.entries(parsed.patterns ?? {})) {
          patterns[id] = FailurePatternSchema.parse(pattern);
        }
        this.state = { version: CURRENT_VERSION, patterns };
      } else {
        this.state = this.migrate(parsed);
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[FailurePatternStore] failed to load ledger, backing up corrupt file and starting empty:",
          error,
        );
        await this.backupCorruptFile();
      }
      this.state = { version: CURRENT_VERSION, patterns: {} };
    }
  }

  /** Migration chain for older ledger versions (only v1 exists today). */
  private migrate(parsed: PatternLedgerState): PatternLedgerState {
    return { version: CURRENT_VERSION, patterns: parsed.patterns ?? {} };
  }

  /** Move an unparseable ledger aside so the bad content is preserved. */
  private async backupCorruptFile(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // Best effort - the ledger already starts empty either way
    }
  }

  /** Get a pattern by id. */
  get(patternId: string): FailurePattern | undefined {
    return this.state.patterns[patternId];
  }

  /** List all patterns (open and resolved; resolved are kept for audit, 04). */
  list(): FailurePattern[] {
    return Object.values(this.state.patterns);
  }

  /**
   * Insert or replace a pattern (worker writer). The pattern is validated
   * against FailurePatternSchema before landing in the ledger.
   */
  async upsert(pattern: FailurePattern): Promise<FailurePattern> {
    const validated = FailurePatternSchema.parse(pattern);
    this.state.patterns[validated.pattern_id] = validated;
    await this.save();
    return validated;
  }

  /** Debounced serial write-back (SessionMetadataService pattern). */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      // Temp file + atomic rename so a crash mid-write can't leave a
      // truncated ledger
      const tmpPath = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      console.error("[FailurePatternStore] failed to save ledger:", error);
      throw error;
    }
  }

  /** File path for testing purposes. */
  getFilePath(): string {
    return this.filePath;
  }
}
