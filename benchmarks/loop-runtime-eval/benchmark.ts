/**
 * Phase 7 benchmark:
 * - state log read latency with 1000 events
 * - structural tsc --noEmit startup latency
 * Writes a JSON report to benchmarks/loop-runtime-eval/results/.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RunStateStore } from "../../packages/server/src/loop/control-plane/run-state-store.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

function makeState(runId: string, turn: number) {
  return {
    version: 2,
    goal_id: "benchmark",
    run_id: runId,
    state: turn % 2 === 0 ? ("complete" as const) : ("active" as const),
    turn,
    intent_version: 1,
    workspace_ref: `workspace://benchmark/${runId}`,
    last_judgment: null,
    pending_approval: null,
    session_ref: null,
    budget: {
      max_tokens: 0,
      max_time_minutes: 30,
      max_turns: 10,
      max_retries: 2,
      used_tokens: 0,
      used_time_minutes: 0,
      used_turns: turn,
      used_retries: 0,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

async function benchmarkStateLog(): Promise<{
  loadP95Ms: number;
  readEventsP95Ms: number;
  events: number;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "phase7-state-log-"));
  try {
    const store = new RunStateStore({ dataDir });
    for (let i = 1; i <= 500; i += 1) {
      await store.save("benchmark-loop", makeState("benchmark-run", i));
      await store.appendCheckpoint("benchmark-loop", {
        run_id: "benchmark-run",
        state: "active",
        turn: i,
        workspace_snapshot: null,
        artifact_manifest_hash: `hash-${i}`,
      });
    }
    const loads: number[] = [];
    const reads: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      let start = performance.now();
      await store.load("benchmark-loop");
      loads.push(performance.now() - start);
      start = performance.now();
      const events = await store.readEvents("benchmark-loop");
      reads.push(performance.now() - start);
      if (events.length !== 1000) {
        throw new Error(`expected 1000 state events, got ${events.length}`);
      }
    }
    return {
      loadP95Ms: percentile(loads, 95),
      readEventsP95Ms: percentile(reads, 95),
      events: 1000,
    };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function benchmarkTsc(): Promise<{
  tscNoEmitMs: number;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "phase7-tsc-"));
  try {
    await writeFile(
      join(workspace, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "index.ts"),
      "export const answer: number = 42;\n",
    );
    const tscBin = join(rootDir, "node_modules", "typescript", "bin", "tsc");
    const start = performance.now();
    await execFileAsync(
      process.execPath,
      [tscBin, "--noEmit", "--pretty", "false"],
      {
        cwd: workspace,
        timeout: 60_000,
      },
    );
    return { tscNoEmitMs: performance.now() - start };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [stateLog, tsc] = await Promise.all([
    benchmarkStateLog(),
    benchmarkTsc(),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    stateLog,
    structural: tsc,
    thresholds: {
      stateLogReadP95Ms: 100,
      verifierCostRatio: 0.3,
    },
  };
  if (stateLog.readEventsP95Ms > 100) {
    throw new Error(
      `state log read p95 exceeded threshold: ${stateLog.readEventsP95Ms}ms > 100ms`,
    );
  }
  const resultsDir = join(__dirname, "results");
  await mkdir(resultsDir, { recursive: true });
  const reportPath = join(
    resultsDir,
    `phase7-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Report written to ${reportPath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
