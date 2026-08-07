import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runTask } from "./run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const tasksJsonl = join(rootDir, "benchmarks", "loop-modules", "tasks.jsonl");

interface TaskManifest {
  task_id: string;
  module: string;
  issue_title: string;
}

async function* readTasks(): AsyncGenerator<TaskManifest> {
  const rl = createInterface({ input: createReadStream(tasksJsonl) });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as TaskManifest;
    } catch {
      console.error(`Invalid JSON in tasks.jsonl: ${trimmed}`);
    }
  }
}

async function main() {
  const byModule = new Map<string, { total: number; resolved: number }>();
  let total = 0;
  let resolved = 0;

  for await (const task of readTasks()) {
    const result = await runTask(task.task_id);
    const mod = byModule.get(task.module) ?? { total: 0, resolved: 0 };
    mod.total += 1;
    total += 1;
    if (result.resolved) {
      mod.resolved += 1;
      resolved += 1;
    }
    byModule.set(task.module, mod);
  }

  console.log("# Loop Modules Benchmark Score");
  console.log("");
  console.log("| Module | Resolved | Total | Rate |");
  console.log("|---|---|---|---|");
  for (const [module, stats] of byModule) {
    const rate =
      stats.total === 0
        ? "0%"
        : `${((stats.resolved / stats.total) * 100).toFixed(1)}%`;
    console.log(`| ${module} | ${stats.resolved} | ${stats.total} | ${rate} |`);
  }
  console.log("");
  console.log(
    `**Overall:** ${resolved}/${total} = ${total === 0 ? "0%" : ((resolved / total) * 100).toFixed(1)}%`,
  );
}

void main();
