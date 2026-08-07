import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3400;
const BASE_URL = process.env.SERVER_URL ?? `http://127.0.0.1:${PORT}`;

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
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

async function createLoop(_workspacePath: string): Promise<string> {
  const loopId = `github-issue-task-${Date.now()}`;
  const body = {
    loop: {
      id: loopId,
      trigger: { type: "manual" },
      discovery: {
        source: "github_prompt",
        query: "agent framework bug fix good first issue",
      },
      handoff: {
        default_task_type: "github_issue_repair",
        task:
          "Search GitHub for agent framework projects with open issues labeled 'good first issue' or 'bug'. " +
          "Select one issue that looks easy to fix and has clear reproduction steps. " +
          "Clone the repository, create a branch, implement a minimal fix, run tests, and prepare a PR draft. " +
          "Do not fork, push, or create pull requests — only prepare the local fix and PR description.",
      },
      workspace: {
        strategy: "direct",
        path: `managed://github-workspaces/prompt-loops/${loopId}`,
      },
      verification: { required: ["review"] },
      persistence: { state_file: `state/${loopId}.json` },
      stop_rules: { max_turns: 5, max_retries: 2, max_time_minutes: 15 },
      policy: { approval_mode: "bypass", profile: "github_issue_local_fix" },
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

async function pollRun(runId: string, timeoutMs = 600_000): Promise<unknown> {
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
    await sleep(3000);
  }
  throw new Error("Run did not finish in time");
}

async function listArtifacts(runId: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/runs/${runId}/artifacts`);
  if (!res.ok) return [];
  const data = (await res.json()) as { artifacts: string[] };
  return data.artifacts;
}

async function readArtifact(runId: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/runs/${runId}/artifacts/${name}`);
  if (!res.ok) return "";
  const data = (await res.json()) as { content: string };
  return data.content;
}

async function main() {
  const workspacePath = await makeTempDir("yep-github-issue-ws-");
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

  const artifacts = await listArtifacts(runId);
  console.error("\nArtifacts:");
  for (const name of artifacts) {
    console.error(`- ${name}`);
  }

  if (artifacts.includes("stdout.log")) {
    const stdout = await readArtifact(runId, "stdout.log");
    console.error("\n--- stdout.log ---");
    console.error(stdout.slice(0, 5000));
  }

  console.error("Run finished");
}

void main();
