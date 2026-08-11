import { spawn } from "node:child_process";

export interface GitHubIssueCandidate {
  repository: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface PublishDraftPrInput {
  repository: string;
  branch: string;
  title: string;
  body: string;
  cwd: string;
  /** False opens a normal PR. Defaults to true for backward compatibility. */
  draft?: boolean;
}

export interface CloneAndCheckoutBranchInput {
  repository: string;
  destination: string;
  branch: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: string | null;
  created_at: string;
}

export interface GitHubReview {
  id: number;
  body: string;
  state: string;
  user: string | null;
  submitted_at: string;
}

export interface GitHubPullRequestState {
  state: string;
  merged: boolean;
  head_sha: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunGitHubCommand = (
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface GitHubClientOptions {
  ghPath: string;
  tokenProvider: () => Promise<string | null>;
  runGh?: RunGitHubCommand;
}

interface SearchIssueJson {
  repository?: { nameWithOwner?: string };
  number?: number;
  title?: string;
  url?: string;
  labels?: Array<{ name?: string }>;
}

export class GitHubClient {
  private readonly ghPath: string;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly runCommand: RunGitHubCommand;

  constructor(options: GitHubClientOptions) {
    this.ghPath = options.ghPath;
    this.tokenProvider = options.tokenProvider;
    this.runCommand = options.runGh ?? this.spawnCommand.bind(this);
  }

  async searchIssues(
    query: string,
    options: { limit: number },
  ): Promise<GitHubIssueCandidate[]> {
    const stdout = await this.runChecked([
      "search",
      "issues",
      query,
      "--json",
      "repository,number,title,url,labels",
      "--limit",
      String(options.limit),
    ]);
    const parsed = JSON.parse(stdout || "[]") as SearchIssueJson[];
    return parsed
      .map((item) => ({
        repository: item.repository?.nameWithOwner ?? "",
        number: item.number ?? 0,
        title: item.title ?? "",
        url: item.url ?? "",
        labels: (item.labels ?? [])
          .map((label) => label.name)
          .filter((name): name is string => Boolean(name)),
      }))
      .filter(
        (item) =>
          item.repository.length > 0 &&
          item.number > 0 &&
          item.title.length > 0 &&
          item.url.length > 0,
      );
  }

  async publishDraftPr(input: PublishDraftPrInput): Promise<string> {
    await this.runChecked(
      [
        "repo",
        "fork",
        input.repository,
        "--clone=false",
        "--remote=true",
        "--remote-name",
        "fork",
      ],
      input.cwd,
    );
    const viewerLogin = (
      await this.runChecked(["api", "user", "--jq", ".login"])
    ).trim();
    if (!viewerLogin) {
      throw new Error("Unable to determine GitHub viewer login");
    }
    await this.runChecked(
      [
        "git",
        "-c",
        "http.proxy=",
        "-c",
        "https.proxy=",
        "push",
        "fork",
        input.branch,
      ],
      input.cwd,
    );
    const prArgs = [
      "pr",
      "create",
      "--repo",
      input.repository,
      "--head",
      `${viewerLogin}:${input.branch}`,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft !== false) {
      prArgs.push("--draft");
    }
    const stdout = await this.runChecked(prArgs, input.cwd);
    return stdout.trim();
  }

  async listPullRequestComments(
    repository: string,
    prNumber: number,
  ): Promise<GitHubComment[]> {
    const stdout = await this.runChecked([
      "api",
      `repos/${repository}/pulls/${prNumber}/comments`,
      "--jq",
      ".",
    ]);
    return (JSON.parse(stdout || "[]") as Array<Record<string, unknown>>).map(
      (item) => ({
        id: Number(item.id),
        body: String(item.body ?? ""),
        user:
          typeof item.user === "object" && item.user !== null
            ? String((item.user as Record<string, unknown>).login ?? "")
            : null,
        created_at: String(item.created_at ?? ""),
      }),
    );
  }

  async listPullRequestReviews(
    repository: string,
    prNumber: number,
  ): Promise<GitHubReview[]> {
    const stdout = await this.runChecked([
      "api",
      `repos/${repository}/pulls/${prNumber}/reviews`,
      "--jq",
      ".",
    ]);
    return (JSON.parse(stdout || "[]") as Array<Record<string, unknown>>).map(
      (item) => ({
        id: Number(item.id),
        body: String(item.body ?? ""),
        state: String(item.state ?? ""),
        user:
          typeof item.user === "object" && item.user !== null
            ? String((item.user as Record<string, unknown>).login ?? "")
            : null,
        submitted_at: String(item.submitted_at ?? ""),
      }),
    );
  }

  async getPullRequest(
    repository: string,
    prNumber: number,
  ): Promise<GitHubPullRequestState> {
    const stdout = await this.runChecked([
      "api",
      `repos/${repository}/pulls/${prNumber}`,
      "--jq",
      "{state, merged, head_sha: .head.sha}",
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      state: String(parsed.state ?? ""),
      merged: Boolean(parsed.merged),
      head_sha: String(parsed.head_sha ?? ""),
    };
  }

  async cloneAndCheckoutBranch(
    input: CloneAndCheckoutBranchInput,
  ): Promise<void> {
    await this.runChecked([
      "git",
      "-c",
      "http.proxy=",
      "-c",
      "https.proxy=",
      "clone",
      input.repository,
      input.destination,
    ]);
    await this.runChecked(
      ["git", "checkout", "-B", input.branch],
      input.destination,
    );
  }

  private async runChecked(args: string[], cwd?: string): Promise<string> {
    const token = await this.tokenProvider();
    if (!token) {
      throw new Error("GitHub token is not configured");
    }
    const result = await this.runCommand(args, {
      cwd,
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || "GitHub command failed",
      );
    }
    return result.stdout;
  }

  private async spawnCommand(
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    const isGit = args[0] === "git";
    const command = isGit ? "git" : this.ghPath;
    const commandArgs = isGit ? args.slice(1) : args;
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: options.cwd,
        env: options.env,
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
