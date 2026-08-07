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
  const results: Awaited<ReturnType<typeof runTask>>[] = [];
  for await (const task of readTasks()) {
    console.error(`Running ${task.task_id}...`);
    results.push(await runTask(task.task_id));
  }
  console.log(JSON.stringify(results, null, 2));
}

void main();
