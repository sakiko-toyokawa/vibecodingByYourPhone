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
  type DecisionEntry,
  DecisionEntrySchema,
  type RunLedgerEntry,
  RunLedgerEntrySchema,
} from "@yep-anywhere/shared";
import { UriResolutionError, resolveUri } from "./uri.js";

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
    await this.enqueueAppend(
      runId,
      `${JSON.stringify({ type: "run_ledger_entry", ...validated })}\n`,
    );
  }

  /**
   * Append a decision_entry (决策账本, 02 §8.2) to runs/<run_id>.jsonl.
   * Run ledger and decision ledger share one file per 04-存储约定; readers
   * split by the `type` discriminator.
   */
  async appendDecisionEntry(
    runId: string,
    entry: DecisionEntry,
  ): Promise<void> {
    this.assertSafeName(runId, "run_id");
    const validated = DecisionEntrySchema.parse(entry);
    await this.enqueueAppend(
      runId,
      `${JSON.stringify({ type: "decision_entry", ...validated })}\n`,
    );
  }

  /** Serialize appends to the same run file through a per-file chain. */
  private enqueueAppend(runId: string, line: string): Promise<void> {
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
   * Read the run_ledger_entry for a run. A run appends one entry per turn
   * (02 §8.1: 每次 retry 产生独立 entry) — this returns the LAST valid
   * entry, i.e. the latest turn's, whose final_status reflects the run's
   * most recent control decision. Corrupt lines are skipped with a
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

    let latest: RunLedgerEntry | null = null;
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
          continue;
        }
        latest = result.data;
      }
    }
    return latest;
  }

  /**
   * Read all decision_entry lines for a run (ledger://decision-<run_id>).
   * Corrupt or invalid lines are skipped with a warning.
   */
  async readDecisionEntries(runId: string): Promise<DecisionEntry[]> {
    this.assertSafeName(runId, "run_id");
    let content: string;
    try {
      content = await fs.readFile(
        path.join(this.runsDir, `${runId}.jsonl`),
        "utf-8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: DecisionEntry[] = [];
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
        (parsed as { type?: unknown }).type === "decision_entry"
      ) {
        const { type: _type, ...entry } = parsed as Record<string, unknown>;
        const result = DecisionEntrySchema.safeParse(entry);
        if (!result.success) {
          console.warn(
            `[RunLedgerStore] decision_entry in runs/${runId}.jsonl failed schema validation:`,
            result.error,
          );
          continue;
        }
        entries.push(result.data);
      }
    }
    return entries;
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

  /** List artifact file names written for a run (empty when none). */
  async listArtifacts(runId: string): Promise<string[]> {
    this.assertSafeName(runId, "run_id");
    try {
      const files = await fs.readdir(path.join(this.artifactsDir, runId));
      return files.filter((file) => !file.endsWith(".tmp"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * 统一 URI 读取 (04 L113: resolveUri 统一在 loop/state/, 引用不再是
   * 只写不读)。artifact:// 返回文件内容 (缺失 undefined); ledger:// 返
   * 回 jsonl 原文; ledger://decision-<run_id> 返回决策条目的 jsonl。
   * 非文件 scheme (intent/policy/workspace) 抛 UriResolutionError。
   */
  async readUri(uri: string): Promise<string | undefined> {
    const resolved = resolveUri(uri, {
      dataDir: path.dirname(this.loopsDir),
    });
    if (resolved.kind === "artifact") {
      return this.readArtifact(resolved.runId, resolved.file);
    }
    if (resolved.kind === "ledger") {
      if (resolved.decisionsOnly) {
        const entries = await this.readDecisionEntries(resolved.runId);
        return entries.length > 0
          ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
          : undefined;
      }
      try {
        return await fs.readFile(resolved.filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }
    throw new UriResolutionError(
      `loop URI scheme '${resolved.kind}' is not file-resolvable`,
    );
  }

  /**
   * 04 容量与清理: 把过期 run 的账本压缩为仅 run_ledger_entry 行 (决策
   * 明细剔除)。压缩与追加共用 per-file 串行链, 不与在飞写入交错。
   * 返回是否发生了压缩 (无文件 / 本就纯净时 false)。
   */
  async compressLedgerToRunEntries(runId: string): Promise<boolean> {
    this.assertSafeName(runId, "run_id");
    const filePath = path.join(this.runsDir, `${runId}.jsonl`);
    const previous = this.appendChains.get(runId) ?? Promise.resolve();
    let compressed = false;
    const next = previous.then(async () => {
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        return; // ENOENT — 无可压缩
      }
      const kept = content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .filter((line) => {
          try {
            return (
              (JSON.parse(line) as { type?: unknown }).type ===
              "run_ledger_entry"
            );
          } catch {
            return false; // 坏行随压缩剔除
          }
        });
      if (kept.length === 0) {
        return;
      }
      const current = content.split("\n").filter((l) => l.trim().length > 0);
      if (kept.length === current.length) {
        return; // 本就纯净
      }
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, `${kept.join("\n")}\n`, "utf-8");
      await fs.rename(tmpPath, filePath);
      compressed = true;
    });
    this.appendChains.set(
      runId,
      next.catch((error) => {
        console.error(`[RunLedgerStore] compress failed for ${runId}:`, error);
      }),
    );
    await next;
    return compressed;
  }

  /** Artifacts directory of a run (cleanup/reader use; name-safe). */
  artifactsDirFor(runId: string): string {
    this.assertSafeName(runId, "run_id");
    return path.join(this.artifactsDir, runId);
  }

  private assertSafeName(name: string, what: string): void {
    if (!SAFE_NAME.test(name)) {
      throw new Error(
        `[RunLedgerStore] unsafe ${what}: '${name}' (must match ${SAFE_NAME})`,
      );
    }
  }
}
