import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "./client.js";

const VERIFIED_EMAIL = "contributor@example.com";

function publishFakeRunGh(calls: string[][], authorEmail = VERIFIED_EMAIL) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1] === "user/emails") {
        return { exitCode: 0, stdout: `${VERIFIED_EMAIL}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "contributor\n", stderr: "" };
    }
    if (args[0] === "git" && args[1] === "config" && args[2] === "user.name") {
      return { exitCode: 0, stdout: "contributor\n", stderr: "" };
    }
    if (args[0] === "git" && args[1] === "config" && args[2] === "user.email") {
      return { exitCode: 0, stdout: `${VERIFIED_EMAIL}\n`, stderr: "" };
    }
    if (args[0] === "git" && args[1] === "log") {
      return { exitCode: 0, stdout: `${authorEmail}\n`, stderr: "" };
    }
    if (args[0] === "pr") {
      return {
        exitCode: 0,
        stdout: "https://github.com/owner/repo/pull/12\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("GitHubClient searches issues with token isolated in environment", async () => {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: async (args, options) => {
      calls.push({ args, env: options.env });
      return {
        exitCode: 0,
        stdout:
          '[{"repository":{"nameWithOwner":"owner/repo"},"number":7,"title":"Bug","url":"https://github.com/owner/repo/issues/7","labels":[{"name":"bug"}]}]',
        stderr: "",
      };
    },
  });

  const issues = await client.searchIssues("label:bug language:TypeScript", {
    limit: 1,
  });

  assert.deepEqual(calls[0]?.args, [
    "search",
    "issues",
    "label:bug language:TypeScript",
    "--json",
    "repository,number,title,url,labels",
    "--limit",
    "1",
  ]);
  assert.equal(calls[0]?.env.GH_TOKEN, "secret-token");
  assert.equal(issues[0]?.repository, "owner/repo");
});

test("GitHubClient publish flow forks, pushes, and opens a draft PR", async () => {
  const calls: string[][] = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: publishFakeRunGh(calls),
  });

  const url = await client.publishDraftPr({
    repository: "owner/repo",
    branch: "yep/7-bug",
    title: "Fix bug",
    body: "Verification passed.",
    cwd: "E:/work/owner/repo",
  });

  assert.deepEqual(calls, [
    [
      "repo",
      "fork",
      "owner/repo",
      "--clone=false",
      "--remote=true",
      "--remote-name",
      "fork",
    ],
    ["api", "user", "--jq", ".login"],
    ["api", "user/emails", "--jq", ".[] | select(.verified == true) | .email"],
    ["auth", "setup-git", "--hostname", "github.com"],
    ["git", "remote", "get-url", "fork"],
    ["git", "remote", "add", "fork", "https://github.com/contributor/repo.git"],
    ["git", "config", "user.name"],
    ["git", "config", "user.email"],
    ["git", "log", "-1", "--format=%ae"],
    ["git", "push", "fork", "yep/7-bug"],
    [
      "pr",
      "create",
      "--repo",
      "owner/repo",
      "--head",
      "contributor:yep/7-bug",
      "--title",
      "Fix bug",
      "--body",
      "Verification passed.",
      "--draft",
    ],
  ]);
  assert.equal(url, "https://github.com/owner/repo/pull/12");
});

test("GitHubClient publish flow opens a normal PR when draft is false", async () => {
  const calls: string[][] = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: publishFakeRunGh(calls),
  });

  await client.publishDraftPr({
    repository: "owner/repo",
    branch: "yep/7-bug",
    title: "Fix bug",
    body: "Verification passed.",
    cwd: "E:/work/owner/repo",
    draft: false,
  });

  const prCall = calls.find((args) => args[0] === "pr");
  assert.ok(prCall, "pr create was called");
  assert.equal(prCall.includes("--draft"), false);
});

test("GitHubClient publish rejects a commit with a non-verified author email", async () => {
  const calls: string[][] = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: publishFakeRunGh(calls, "zhapodanshushu@outlook.com"),
  });

  await assert.rejects(
    () =>
      client.publishDraftPr({
        repository: "owner/repo",
        branch: "yep/7-bug",
        title: "Fix bug",
        body: "Verification passed.",
        cwd: "E:/work/owner/repo",
      }),
    /GitHub identity mismatch/,
  );
  assert.ok(!calls.some((args) => args[0] === "pr"));
});

test("GitHubClient clones a repository and creates the working branch", async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args[0] === "api" && args[1] === "user/emails") {
        return { exitCode: 0, stdout: `${VERIFIED_EMAIL}\n`, stderr: "" };
      }
      if (args[0] === "api") {
        return { exitCode: 0, stdout: "contributor\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await client.cloneAndCheckoutBranch({
    repository: "owner/repo",
    destination: "E:/data/github-workspaces/owner/repo/issues/7",
    branch: "yep/7-bug",
  });

  assert.deepEqual(calls, [
    {
      args: [
        "git",
        "clone",
        "owner/repo",
        "E:/data/github-workspaces/owner/repo/issues/7",
      ],
      cwd: undefined,
    },
    {
      args: ["git", "checkout", "-B", "yep/7-bug"],
      cwd: "E:/data/github-workspaces/owner/repo/issues/7",
    },
    {
      args: ["api", "user", "--jq", ".login"],
      cwd: undefined,
    },
    {
      args: [
        "api",
        "user/emails",
        "--jq",
        ".[] | select(.verified == true) | .email",
      ],
      cwd: undefined,
    },
    {
      args: ["git", "config", "user.name", "contributor"],
      cwd: "E:/data/github-workspaces/owner/repo/issues/7",
    },
    {
      args: ["git", "config", "user.email", VERIFIED_EMAIL],
      cwd: "E:/data/github-workspaces/owner/repo/issues/7",
    },
  ]);
});

test("GitHubClient throws with stderr when gh command fails", async () => {
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: async () => ({ exitCode: 1, stdout: "", stderr: "bad credentials" }),
  });

  await assert.rejects(
    () => client.searchIssues("label:bug", { limit: 1 }),
    /bad credentials/,
  );
});

test("GitHubClient treats an already-ready PR as ready", async () => {
  const calls: string[][] = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: async (args) => {
      calls.push(args);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Pull request #12 is not a draft",
      };
    },
  });

  await client.markPullRequestReady("owner/repo", 12);
  assert.deepEqual(calls[0], ["pr", "ready", "12", "--repo", "owner/repo"]);
});
