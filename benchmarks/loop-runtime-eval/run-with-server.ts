import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3700;
const BASE_URL = process.env.SERVER_URL ?? `http://127.0.0.1:${PORT}`;
const USE_EXTERNAL_SERVER = process.env.SERVER_URL !== undefined;

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function makeWorkspace(): Promise<string> {
  if (process.env.WORKSPACE) {
    return process.env.WORKSPACE;
  }
  const dir = await makeTempDir("yep-loop-server-ws-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Sample workspace\n");
  await writeFile(join(dir, "src", "utils.js"), "export const util = 1;\n");
  return dir;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error("Server did not become ready in 30s");
}

async function createLoop(workspacePath: string): Promise<string> {
  const loopId = `server-eval-${Date.now()}`;
  const body = {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      handoff: {
        default_task_type: "read_only_report",
        task: "Scan the workspace and report all file names as a markdown list. Do not modify any files.",
      },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: [] },
      persistence: { state_file: `state/${loopId}.json` },
      stop_rules: { max_turns: 1, max_retries: 0, max_time_minutes: 5 },
    },
  };

  const res = await fetch(`${BASE_URL}/api/loops`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Create loop failed: ${res.status} ${await res.text()}`);
  }
  return loopId;
}

async function triggerRun(loopId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/loops/${loopId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Trigger run failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { run: { run_id: string } };
  return data.run.run_id;
}

async function pollRun(runId: string, timeoutMs = 180_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/runs/${runId}`);
    if (!res.ok) {
      throw new Error(`Poll run failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      run?: { state: string };
      run_state?: { state: string; turn: number } | null;
    };
    const state = data.run_state?.state ?? data.run?.state;
    if (
      state &&
      ["complete", "failed", "budget_limited", "needs_human"].includes(state)
    ) {
      return data;
    }
    await sleep(1000);
  }
  throw new Error("Run did not finish in time");
}

function startServer(
  dataDir: string,
  claudeConfigDir: string,
): ReturnType<typeof spawn> {
  return spawn(
    "node",
    [
      "scripts/run-with-safe-home.js",
      "tsx",
      "--conditions",
      "source",
      "packages/server/src/index.ts",
    ],
    {
      shell: true,
      env: {
        ...process.env,
        AUTH_DISABLED: "true",
        PORT: String(PORT),
        YEP_ANYWHERE_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
}

async function main() {
  const workspacePath = await makeWorkspace();
  console.error(`Workspace: ${workspacePath}`);

  let server: ReturnType<typeof spawn> | null = null;
  if (!USE_EXTERNAL_SERVER) {
    const dataDir = await makeTempDir("yep-loop-server-data-");
    const claudeConfigDir = await makeTempDir("yep-loop-server-claude-");
    console.error(`Data dir: ${dataDir}`);
    console.error(`Claude config dir: ${claudeConfigDir}`);
    server = startServer(dataDir, claudeConfigDir);
  } else {
    console.error(`Using external server at ${BASE_URL}`);
  }

  try {
    await waitForServer();
    console.error("Server ready");

    const loopId = await createLoop(workspacePath);
    console.error(`Created loop ${loopId}`);

    const runId = await triggerRun(loopId);
    console.error(`Triggered run ${runId}`);

    const result = await pollRun(runId);
    console.log(JSON.stringify(result, null, 2));
    console.error("Run finished");
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await sleep(1000);
      if (!server.killed) server.kill("SIGKILL");
    }
  }
}

void main();
