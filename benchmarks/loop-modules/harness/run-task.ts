import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const tasksDir = join(rootDir, "benchmarks", "loop-modules", "tasks");

interface TestResult {
  file: string;
  passed: boolean;
  stdout: string;
  stderr: string;
}

interface TaskResult {
  taskId: string;
  public: TestResult | null;
  hidden: TestResult | null;
  resolved: boolean;
}

async function runTestFile(testPath: string): Promise<TestResult> {
  const file = testPath;
  if (!existsSync(file)) {
    return { file, passed: false, stdout: "", stderr: "file not found" };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", "--test", file],
      { cwd: rootDir, encoding: "utf-8", shell: true },
    );
    return { file, passed: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return {
      file,
      passed: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(error),
    };
  }
}

export async function runTask(taskId: string): Promise<TaskResult> {
  const taskDir = join(tasksDir, taskId);
  const publicPath = join(taskDir, "public.test.ts");
  const hiddenPath = join(taskDir, "hidden.test.ts");

  const publicResult = await runTestFile(publicPath);
  const hiddenResult = await runTestFile(hiddenPath);

  return {
    taskId,
    public: publicResult,
    hidden: hiddenResult,
    resolved: publicResult.passed && hiddenResult.passed,
  };
}

async function main() {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("Usage: tsx harness/run-task.ts <task-id>");
    process.exit(1);
  }
  const result = await runTask(taskId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.resolved ? 0 : 1);
}

if (process.argv[1]?.includes("run-task.ts")) {
  void main();
}
