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
  const dir = await makeTempDir("yep-loop-nh-ws-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Needs-human multi-turn sample\n");

  // Test fails until src/main.js exports a function named hello().
  const testScript = `const fs = require('fs');
const code = fs.readFileSync('src/main.js', 'utf8');
if (!code.includes('function hello') && !code.includes('const hello') && !code.includes('export function hello')) {
  console.error('src/main.js does not define hello');
  process.exit(1);
}
console.log('hello found');
`;
  await writeFile(join(dir, "test.js"), testScript);

  const pkg = {
    name: "loop-nh-target",
    version: "1.0.0",
    scripts: {
      test: "node test.js",
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
  const loopId = `nh-eval-${Date.now()}`;
  const body = {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      handoff: {
        default_task_type: "maintenance",
        task: "Create src/main.js and define a hello() function. The test requires this function. If the test fails, wait for human approval before retrying.",
      },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["runtime"] },
      persistence: { state_file: `state/${loopId}.json` },
      // max_retries=0 so a failed verification escalates to needs_human instead of auto-retry.
      stop_rules: { max_turns: 3, max_retries: 0, max_time_minutes: 5 },
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

async function pollRun(
  runId: string,
  timeoutMs = 300_000,
): Promise<{ state: string; turn: number }> {
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
    const state = data.run_state?.state ?? data.run?.state ?? "unknown";
    const turn = data.run_state?.turn ?? 0;
    console.error(`  state=${state} turn=${turn}`);
    if (
      ["complete", "failed", "budget_limited", "needs_human"].includes(state)
    ) {
      return { state, turn };
    }
    await sleep(2000);
  }
  throw new Error("Run did not finish in time");
}

async function approveDecision(runId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/runs/${runId}/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({ action: "approve" }),
  });
  if (!res.ok) {
    throw new Error(`Approve failed: ${res.status} ${await res.text()}`);
  }
  console.error(`Approved run ${runId}`);
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

  const first = await pollRun(runId);
  console.error(`First terminal state: ${first.state} turn=${first.turn}`);

  if (first.state === "needs_human") {
    await approveDecision(runId);
    const second = await pollRun(runId);
    console.error(`Second terminal state: ${second.state} turn=${second.turn}`);
    const res = await fetch(`${BASE_URL}/api/runs/${runId}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } else {
    const res = await fetch(`${BASE_URL}/api/runs/${runId}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  }

  console.error("Run finished");
}

void main();
