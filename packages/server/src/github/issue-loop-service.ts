import * as path from "node:path";
import type { LoopCard } from "@yep-anywhere/shared";
import type { RunSummary } from "../loop/run-service.js";
import type { StoredLoop } from "../loop/state/loop-card-store.js";
import type {
  GitHubClient,
  GitHubIssueCandidate,
  GitHubToolProvisioner,
} from "./index.js";

export interface GitHubIssueLoopServiceDeps {
  dataDir: string;
  toolProvisioner: Pick<GitHubToolProvisioner, "ensureGh">;
  githubClient: Pick<GitHubClient, "searchIssues" | "cloneAndCheckoutBranch">;
  loopCardStore: {
    getLoop(id: string): StoredLoop | undefined;
    createLoop(card: LoopCard): Promise<StoredLoop>;
  };
  runService: {
    startRun(loopId: string, source: "manual" | "cron"): Promise<RunSummary>;
  };
}

export interface GitHubIssueLoopRun {
  issue: GitHubIssueCandidate;
  loopId: string;
  workspacePath: string;
  branch: string;
  run: RunSummary;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function loopIdFor(issue: GitHubIssueCandidate): string {
  return `github-${issue.repository.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-issue-${issue.number}`;
}

function workspaceFor(dataDir: string, issue: GitHubIssueCandidate): string {
  const [owner = "unknown", repo = "repo"] = issue.repository.split("/");
  return path.join(
    dataDir,
    "github-workspaces",
    owner,
    repo,
    "issues",
    String(issue.number),
  );
}

function taskFor(issue: GitHubIssueCandidate, branch: string): string {
  return [
    `Fix GitHub issue ${issue.repository}#${issue.number}: ${issue.title}`,
    "",
    `Issue URL: ${issue.url}`,
    `Working branch: ${branch}`,
    "",
    "Requirements:",
    "- Reproduce or inspect the issue before editing.",
    "- Make the smallest reasonable fix in this workspace.",
    "- Run the relevant tests or checks.",
    "- Create a local git commit on the working branch.",
    "- Do not push, fork, open a PR, comment, close issues, release, or deploy.",
    "- Finish with a concise report including files changed and verification.",
  ].join("\n");
}

function cardFor(issue: GitHubIssueCandidate, workspacePath: string): LoopCard {
  const id = loopIdFor(issue);
  const branch = `yep/${issue.number}-${slug(issue.title) || "fix"}`;
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      discovery: {
        source: "github_issues",
        query: `${issue.repository}#${issue.number}`,
      },
      handoff: {
        default_task_type: "bugfix",
        max_items_per_run: 1,
        task: taskFor(issue, branch),
      },
      workspace: {
        strategy: "direct",
        path: workspacePath,
      },
      verification: {
        required: ["static", "runtime"],
      },
      policy: {
        profile: "github_issue_local_fix",
        approval_mode: "bypass",
      },
      persistence: {
        state_file: `.loop/state/${id}/STATE.md`,
      },
      stop_rules: {
        max_turns: 3,
        max_time_minutes: 60,
        max_retries: 1,
      },
    },
  };
}

export class GitHubIssueLoopService {
  constructor(private readonly deps: GitHubIssueLoopServiceDeps) {}

  async startFromQuery(query: string): Promise<GitHubIssueLoopRun> {
    await this.deps.toolProvisioner.ensureGh();
    const [issue] = await this.deps.githubClient.searchIssues(query, {
      limit: 1,
    });
    if (!issue) {
      throw new Error(`No GitHub issues matched query: ${query}`);
    }
    const workspacePath = workspaceFor(this.deps.dataDir, issue);
    const branch = `yep/${issue.number}-${slug(issue.title) || "fix"}`;
    await this.deps.githubClient.cloneAndCheckoutBranch({
      repository: issue.repository,
      destination: workspacePath,
      branch,
    });
    const loopId = loopIdFor(issue);
    if (!this.deps.loopCardStore.getLoop(loopId)) {
      await this.deps.loopCardStore.createLoop(cardFor(issue, workspacePath));
    }
    const run = await this.deps.runService.startRun(loopId, "manual");
    return { issue, loopId, workspacePath, branch, run };
  }
}
