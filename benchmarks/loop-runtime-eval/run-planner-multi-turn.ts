import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3400;
const BASE_URL = process.env.SERVER_URL ?? `http://127.0.0.1:${PORT}`;

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function makeWorkspace(): Promise<string> {
  const dir = await makeTempDir("yep-loop-planner-ws-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Planner multi-turn sample\n");
  const pkg = {
    name: "loop-planner-target",
    version: "1.0.0",
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
    },
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
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
  const loopId = `planner-eval-${Date.now()}`;
  const body = {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      handoff: {
        default_task_type: "maintenance",
        task:
          "Research the workspace structure and create PLAN.md with a simple design. " +
          "Then implement the design in src/main.js. " +
          "Then verify everything works with tests. " +
          "This is a multi-step task that should be decomposed by the planner.",
      },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static", "runtime"] },
      persistence: { state_file: `state/${loopId}.json` },
      stop_rules: { max_turns: 5, max_retries: 1, max_time_minutes: 10 },
      policy: { approval_mode: "assisted" },
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

async function pollRun(runId: string, timeoutMs = 300_000): Promise<unknown> {
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
    const turn = data.run_state?.turn ?? 0;
    console.error(`  state=${state} turn=${turn}`);
    if (
      state &&
      ["complete", "failed", "budget_limited", "needs_human"].includes(state)
    ) {
      return data;
    }
    await sleep(2000);
  }
  throw new Error("Run did not finish in time");
}

async function main() {
  const workspacePath = await makeWorkspace();
  console.error(`Workspace: ${workspacePath}`);
  console.error(`Server: ${BASE_URL}`);

  await waitForServer();
  console.error("Server ready");

  const loopId = await createLoop(workspacePath);
  console.error(`Created loop ${loopId}`);

  const runId = await triggerRun(loopId);
  console.error(`Triggered run ${runId}`);

  const result = await pollRun(runId);
  console.log(JSON.stringify(result, null, 2));
  console.error("Run finished");
}

void main();
