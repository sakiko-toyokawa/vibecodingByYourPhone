import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 3400);
const BASE_URL = process.env.SERVER_URL ?? `http://127.0.0.1:${PORT}`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const TEST_REPO = process.env.GITHUB_TEST_REPO ?? "";
const TEST_ISSUE = process.env.GITHUB_TEST_ISSUE ?? "";

const REQUIRED = ["GITHUB_TOKEN", "GITHUB_TEST_REPO", "GITHUB_TEST_ISSUE"];

for (const name of REQUIRED) {
  if (!process.env[name]) {
    throw new Error(`${name} is required for the GitHub PR maintenance flow`);
  }
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error("Server did not become ready in 30s");
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "X-Yep-Anywhere": "true",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function createLoop(): Promise<string> {
  const loopId = `github-pr-maintenance-${Date.now()}`;
  await api("/loops", {
    method: "POST",
    body: JSON.stringify({
      loop: {
        id: loopId,
        trigger: { type: "manual" },
        discovery: {
          source: "github_prompt",
          query: `repo:${TEST_REPO} issue number:${TEST_ISSUE}`,
        },
        handoff: {
          default_task_type: "github_issue_repair",
          max_items_per_run: 1,
          task: `Fix issue ${TEST_ISSUE} in ${TEST_REPO}. Clone the repo under the managed workspace, create a branch, make a minimal fix, run tests, commit, and emit the PR-PUBLISH block with the absolute clone path.`,
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
    }),
  });
  return loopId;
}

async function triggerAndWait(loopId: string): Promise<string> {
  const { run } = await api<{ run: { run_id: string } }>(
    `/loops/${loopId}/runs`,
    { method: "POST", body: "{}" },
  );
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const detail = await api<{
      run: { state: string };
      run_state: { state: string } | null;
    }>(`/runs/${run.run_id}`);
    const state = detail.run_state?.state ?? detail.run.state;
    console.error(`  state=${state}`);
    if (
      ["complete", "failed", "needs_human", "budget_limited"].includes(state)
    ) {
      if (state !== "complete") {
        throw new Error(`Run ended as ${state}`);
      }
      return run.run_id;
    }
    await sleep(3000);
  }
  throw new Error("Run did not finish in time");
}

async function approveAndReady(
  loopId: string,
): Promise<{ relation_id: string; pr_number: number }> {
  const { relations } = await api<{
    relations: Array<{
      relation_id: string;
      state: string;
      subject: { pr_number?: number };
      pending_publish?: { cwd?: string };
    }>;
  }>(`/github/relations?loop_id=${encodeURIComponent(loopId)}`);
  const pending = relations.find((r) => r.state === "pr_pending_approval");
  if (!pending) {
    throw new Error("No pr_pending_approval relation was created");
  }
  if (!pending.pending_publish?.cwd) {
    throw new Error("PR publish payload has no cwd");
  }
  const approved = await api<{
    relation: { state: string; subject: { pr_number?: number } };
  }>(`/github/relations/${pending.relation_id}/approve-pr`, {
    method: "POST",
    body: "{}",
  });
  if (approved.relation.state !== "awaiting_review") {
    throw new Error(`Expected awaiting_review, got ${approved.relation.state}`);
  }
  const prNumber = approved.relation.subject.pr_number;
  if (!prNumber) {
    throw new Error("Approved relation has no PR number");
  }
  const ready = await api<{
    relation: { state: string };
  }>(`/github/relations/${pending.relation_id}/mark-ready`, {
    method: "POST",
    body: "{}",
  });
  if (ready.relation.state !== "awaiting_feedback") {
    throw new Error(`Expected awaiting_feedback, got ${ready.relation.state}`);
  }
  return { relation_id: pending.relation_id, pr_number: prNumber };
}

async function triggerFeedbackAndWait(relationId: string): Promise<void> {
  const eventId = `maintenance-e2e-${Date.now()}`;
  const response = await fetch(`${BASE_URL}/api/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": eventId,
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({
      repository: { full_name: TEST_REPO },
      issue: { number: Number(TEST_ISSUE) },
      comment: { id: Date.now() },
      action: "created",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Webhook trigger failed: ${response.status} ${await response.text()}`,
    );
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const { relation } = await api<{
      relation: { state: string };
    }>(`/github/relations/${relationId}`);
    console.error(`  relation state=${relation.state}`);
    if (
      relation.state === "awaiting_feedback" ||
      relation.state === "needs_human"
    ) {
      if (relation.state === "needs_human") {
        throw new Error("Maintenance run escalated to needs_human");
      }
      return;
    }
    await sleep(3000);
  }
  throw new Error("Relation did not return to awaiting_feedback");
}

async function cleanup(prNumber: number): Promise<void> {
  await fetch(`https://api.github.com/repos/${TEST_REPO}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ state: "closed" }),
  }).catch((error) => console.warn("[cleanup] failed to close PR:", error));
}

async function main(): Promise<void> {
  await waitForServer();
  const loopId = await createLoop();
  console.error(`Created loop ${loopId}`);
  const runId = await triggerAndWait(loopId);
  console.error(`Run complete: ${runId}`);
  const { relation_id: relationId, pr_number: prNumber } =
    await approveAndReady(loopId);
  console.error(`Draft PR ready: #${prNumber}`);
  await triggerFeedbackAndWait(relationId);
  console.log(
    JSON.stringify(
      { loopId, runId, relationId, prNumber, result: "pass" },
      null,
      2,
    ),
  );
  await cleanup(prNumber);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
