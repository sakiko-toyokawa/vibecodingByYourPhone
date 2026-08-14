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

export interface GitHubVerifiedIdentity {
  login: string;
  email: string;
  emails: string[];
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
    const identity = await this.getVerifiedIdentity();
    const repositoryOwner = input.repository.split("/")[0]?.toLowerCase();
    const sameAccount =
      repositoryOwner !== undefined &&
      identity.login.toLowerCase() === repositoryOwner;
    if (!sameAccount) {
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
      await this.ensureForkRemote(input.cwd, input.repository, identity.login);
    }
    await this.runChecked(
      ["auth", "setup-git", "--hostname", "github.com"],
      input.cwd,
    );
    await this.assertGitIdentity(input.cwd, identity);
    await this.runChecked(
      ["git", "push", sameAccount ? "origin" : "fork", input.branch],
      input.cwd,
    );
    const prArgs = [
      "pr",
      "create",
      "--repo",
      input.repository,
      "--head",
      sameAccount ? input.branch : `${identity.login}:${input.branch}`,
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

  async getVerifiedIdentity(): Promise<GitHubVerifiedIdentity> {
    const login = (
      await this.runChecked(["api", "user", "--jq", ".login"])
    ).trim();
    if (!login) {
      throw new Error("Unable to determine GitHub viewer login");
    }
    const emailOutput = await this.runChecked([
      "api",
      "user/emails",
      "--jq",
      ".[] | select(.verified == true) | .email",
    ]);
    const emails = emailOutput
      .split(/\r?\n/)
      .map((email) => email.trim())
      .filter((email) => email.length > 0);
    if (emails.length === 0) {
      throw new Error(
        `GitHub account '${login}' has no verified email; configure one before publishing a PR`,
      );
    }
    const email = emails[0];
    if (!email) {
      throw new Error(
        `GitHub account '${login}' has no verified email; configure one before publishing a PR`,
      );
    }
    return { login, email, emails };
  }

  async configureGitIdentity(cwd: string): Promise<GitHubVerifiedIdentity> {
    const identity = await this.getVerifiedIdentity();
    await this.runChecked(["git", "config", "user.name", identity.login], cwd);
    await this.runChecked(["git", "config", "user.email", identity.email], cwd);
    return identity;
  }

  private async assertGitIdentity(
    cwd: string,
    identity: GitHubVerifiedIdentity,
  ): Promise<void> {
    const configuredName = await this.runChecked(
      ["git", "config", "user.name"],
      cwd,
    ).catch(() => "");
    const configuredEmail = await this.runChecked(
      ["git", "config", "user.email"],
      cwd,
    ).catch(() => "");
    const authorEmail = await this.runChecked(
      ["git", "log", "-1", "--format=%ae"],
      cwd,
    ).catch(() => "");
    const problems: string[] = [];
    if (configuredName.trim() !== identity.login) {
      problems.push(
        `git user.name is '${configuredName.trim()}', expected '${identity.login}'`,
      );
    }
    if (!identity.emails.includes(configuredEmail.trim())) {
      problems.push(
        `git user.email '${configuredEmail.trim()}' is not a verified email for '${identity.login}'`,
      );
    }
    if (!identity.emails.includes(authorEmail.trim())) {
      problems.push(
        `HEAD author email '${authorEmail.trim()}' is not a verified email for '${identity.login}'`,
      );
    }
    if (problems.length > 0) {
      throw new Error(
        `GitHub identity mismatch for ${cwd}: ${problems.join("; ")}`,
      );
    }
  }

  private async ensureForkRemote(
    cwd: string,
    repository: string,
    viewerLogin: string,
  ): Promise<void> {
    const repoName = repository.split("/").pop();
    if (!repoName) {
      throw new Error(`Invalid GitHub repository: ${repository}`);
    }
    const expectedUrl = `https://github.com/${viewerLogin}/${repoName}.git`;
    let currentUrl: string | null = null;
    try {
      currentUrl = (
        await this.runChecked(["git", "remote", "get-url", "fork"], cwd)
      ).trim();
    } catch {
      currentUrl = null;
    }
    if (currentUrl === expectedUrl) {
      return;
    }
    if (currentUrl) {
      await this.runChecked(
        ["git", "remote", "set-url", "fork", expectedUrl],
        cwd,
      );
      return;
    }
    await this.runChecked(["git", "remote", "add", "fork", expectedUrl], cwd);
  }

  async markPullRequestReady(
    repository: string,
    prNumber: number,
  ): Promise<void> {
    try {
      await this.runChecked([
        "pr",
        "ready",
        String(prNumber),
        "--repo",
        repository,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not (a )?draft|is not draft/i.test(message)) {
        return;
      }
      throw error;
    }
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
      "{state,merged,head_sha:.head.sha}",
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
      "clone",
      input.repository,
      input.destination,
    ]);
    await this.runChecked(
      ["git", "checkout", "-B", input.branch],
      input.destination,
    );
    await this.configureGitIdentity(input.destination);
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
