/**
 * Cold storage tier for completed runs.
 *
 * Expired hot runs are archived as:
 * - `loops/cold/<run_id>.jsonl.gz` (gzipped ledger)
 * - `loops/cold/<run_id>/` (artifacts, including manifest.jsonl)
 * - `loops/cold/index.json` (audit index)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RunLedgerStore } from "./run-ledger-store.js";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface ColdArchiveEntry {
  run_id: string;
  loop_id: string;
  ledger_gzip: string;
  artifacts_dir: string;
  archived_at: string;
}

export interface ArchiveRunToColdResult {
  archived: boolean;
  archivePath: string | null;
}

function coldDirOf(store: RunLedgerStore): string {
  const runArtifactsDir = store.artifactsDirFor("__unused__");
  const loopsDir = path.dirname(path.dirname(runArtifactsDir));
  return path.join(loopsDir, "cold");
}

function assertSafe(runId: string): void {
  if (!SAFE_NAME.test(runId)) {
    throw new Error(`[ColdStorage] unsafe run_id: '${runId}'`);
  }
}

async function readIndex(coldDir: string): Promise<ColdArchiveEntry[]> {
  try {
    const content = await fs.readFile(
      path.join(coldDir, "index.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as ColdArchiveEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(
  coldDir: string,
  entries: ColdArchiveEntry[],
): Promise<void> {
  const indexPath = path.join(coldDir, "index.json");
  const tmpPath = `${indexPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, indexPath);
}

/** Archive a run's hot ledger and artifacts into cold/. Returns false when
 *  the run has no hot ledger to archive. */
export async function archiveRunToCold(
  store: RunLedgerStore,
  runId: string,
): Promise<ArchiveRunToColdResult> {
  assertSafe(runId);
  const loopsDir = path.dirname(path.dirname(store.artifactsDirFor(runId)));
  const coldDir = path.join(loopsDir, "cold");
  const ledgerPath = path.join(loopsDir, "runs", `${runId}.jsonl`);
  let ledger: string;
  try {
    ledger = await fs.readFile(ledgerPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { archived: false, archivePath: null };
    }
    throw error;
  }

  await fs.mkdir(coldDir, { recursive: true });
  const archivePath = path.join(coldDir, `${runId}.jsonl.gz`);
  await fs.writeFile(archivePath, gzipSync(Buffer.from(ledger, "utf-8")));

  const artifactsDir = path.join(coldDir, runId);
  const sourceArtifacts = path.join(loopsDir, "artifacts", runId);
  try {
    await fs.cp(sourceArtifacts, artifactsDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const entry = await store.readEntry(runId);
  const index = await readIndex(coldDir);
  index.push({
    run_id: runId,
    loop_id: entry?.loop_id ?? "unknown",
    ledger_gzip: `${runId}.jsonl.gz`,
    artifacts_dir: runId,
    archived_at: new Date().toISOString(),
  });
  await writeIndex(coldDir, index);
  return { archived: true, archivePath };
}

/** Remove a run's hot ledger and artifacts after successful cold archive. */
export async function removeHotRunStorage(
  store: RunLedgerStore,
  runId: string,
): Promise<void> {
  assertSafe(runId);
  const loopsDir = path.dirname(path.dirname(store.artifactsDirFor(runId)));
  await fs
    .rm(path.join(loopsDir, "runs", `${runId}.jsonl`), { force: true })
    .catch(() => {});
  await fs
    .rm(path.join(loopsDir, "artifacts", runId), {
      recursive: true,
      force: true,
    })
    .catch(() => {});
}

/** Remove a run's cold ledger, cold artifacts, and index entry. */
export async function removeColdRun(
  store: RunLedgerStore,
  runId: string,
): Promise<void> {
  assertSafe(runId);
  const coldDir = coldDirOf(store);
  await fs
    .rm(path.join(coldDir, `${runId}.jsonl.gz`), { force: true })
    .catch(() => {});
  await fs
    .rm(path.join(coldDir, runId), { recursive: true, force: true })
    .catch(() => {});
  await fs.mkdir(coldDir, { recursive: true });
  const index = (await readIndex(coldDir)).filter(
    (entry) => entry.run_id !== runId,
  );
  await writeIndex(coldDir, index);
}

export async function readColdLedger(
  store: RunLedgerStore,
  runId: string,
): Promise<string | null> {
  assertSafe(runId);
  const coldDir = coldDirOf(store);
  try {
    const content = await fs.readFile(path.join(coldDir, `${runId}.jsonl.gz`));
    return gunzipSync(content).toString("utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function listColdArchives(
  store: RunLedgerStore,
): Promise<ColdArchiveEntry[]> {
  return readIndex(coldDirOf(store));
}
