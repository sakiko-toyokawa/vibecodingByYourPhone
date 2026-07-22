/**
 * Run ledger store (spec: docs/spec/04-存储约定.md).
 *
 * - `runs/<run_id>.jsonl`: append-only. Each line is a self-contained JSON
 *   entry with a `type` discriminator (`run_ledger_entry` in phase 0;
 *   `decision_entry` arrives with the control-plane in a later phase).
 *   Corrupt lines are skipped with a warning on read — a bad line never
 *   crashes the server.
 * - `artifacts/<run_id>/`: run-level evidence files referenced by
 *   `artifact://<run_id>/<file>` URIs in ledger entries.
 *
 * Single-writer convention: the server-process RunLedgerStore instance
 * (driven by the run service / orchestration layer) is the only writer;
 * API and (later) the learning worker are readers. Appends to the same
 * file are serialized through a per-file promise chain.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type RunLedgerEntry,
  RunLedgerEntrySchema,
} from "@yep-anywhere/shared";

/** run_id / artifact file names must stay inside their directory. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface RunLedgerStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class RunLedgerStore {
  private readonly loopsDir: string;
  private readonly runsDir: string;
  private readonly artifactsDir: string;
  /** Per-file append serialization (04: appends go through one writer) */
  private appendChains = new Map<string, Promise<void>>();

  constructor(options: RunLedgerStoreOptions = {}) {
    this.loopsDir = path.join(options.dataDir ?? defaultDataDir(), "loops");
    this.runsDir = path.join(this.loopsDir, "runs");
    this.artifactsDir = path.join(this.loopsDir, "artifacts");
  }

  /**
   * Append a run_ledger_entry to runs/<run_id>.jsonl.
   * The entry is validated against RunLedgerEntrySchema before writing.
   */
  async appendEntry(runId: string, entry: RunLedgerEntry): Promise<void> {
    this.assertSafeName(runId, "run_id");
    const validated = RunLedgerEntrySchema.parse(entry);
    const line = `${JSON.stringify({ type: "run_ledger_entry", ...validated })}\n`;
    const filePath = path.join(this.runsDir, `${runId}.jsonl`);

    const previous = this.appendChains.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await fs.mkdir(this.runsDir, { recursive: true });
      await fs.appendFile(filePath, line, "utf-8");
    });
    // Keep the chain alive even if one append fails
    this.appendChains.set(
      runId,
      next.catch((error) => {
        console.error(`[RunLedgerStore] append failed for ${runId}:`, error);
      }),
    );
    return next;
  }

  /** Write a run-level artifact (intent contract snapshot, stdout log, …). */
  async writeArtifact(
    runId: string,
    name: string,
    content: string,
  ): Promise<void> {
    this.assertSafeName(runId, "run_id");
    this.assertSafeName(name, "artifact name");
    const dir = path.join(this.artifactsDir, runId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, name);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  /** Read an artifact back (undefined when missing — readers tolerate ENOENT). */
  async readArtifact(runId: string, name: string): Promise<string | undefined> {
    this.assertSafeName(runId, "run_id");
    this.assertSafeName(name, "artifact name");
    try {
      return await fs.readFile(
        path.join(this.artifactsDir, runId, name),
        "utf-8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Read the run_ledger_entry for a run. Corrupt lines are skipped with a
   * warning; an entry that fails schema validation is treated as absent.
   */
  async readEntry(runId: string): Promise<RunLedgerEntry | null> {
    this.assertSafeName(runId, "run_id");
    let content: string;
    try {
      content = await fs.readFile(
        path.join(this.runsDir, `${runId}.jsonl`),
        "utf-8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

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
          `[RunLedgerStore] skipping unparseable line in runs/${runId}.jsonl`,
        );
        continue;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === "run_ledger_entry"
      ) {
        const { type: _type, ...entry } = parsed as Record<string, unknown>;
        const result = RunLedgerEntrySchema.safeParse(entry);
        if (!result.success) {
          console.warn(
            `[RunLedgerStore] run_ledger_entry in runs/${runId}.jsonl failed schema validation:`,
            result.error,
          );
          return null;
        }
        return result.data;
      }
    }
    return null;
  }

  /** List run ids that have a ledger file. */
  async listRunIds(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.runsDir);
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => file.slice(0, -".jsonl".length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private assertSafeName(name: string, what: string): void {
    if (!SAFE_NAME.test(name)) {
      throw new Error(
        `[RunLedgerStore] unsafe ${what}: '${name}' (must match ${SAFE_NAME})`,
      );
    }
  }
}
