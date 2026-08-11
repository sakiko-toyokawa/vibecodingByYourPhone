import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "./client.js";

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
    runGh: async (args) => {
      calls.push(args);
      if (args[0] === "api") {
        return { exitCode: 0, stdout: "contributor\n", stderr: "" };
      }
      if (args[0] === "pr") {
        return {
          exitCode: 0,
          stdout: "https://github.com/owner/repo/pull/12\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
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
    [
      "git",
      "-c",
      "http.proxy=",
      "-c",
      "https.proxy=",
      "push",
      "fork",
      "yep/7-bug",
    ],
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
    runGh: async (args) => {
      calls.push(args);
      if (args[0] === "api") {
        return { exitCode: 0, stdout: "contributor\n", stderr: "" };
      }
      if (args[0] === "pr") {
        return {
          exitCode: 0,
          stdout: "https://github.com/owner/repo/pull/13\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
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

test("GitHubClient clones a repository and creates the working branch", async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const client = new GitHubClient({
    ghPath: "/tools/gh",
    tokenProvider: async () => "secret-token",
    runGh: async (args, options) => {
      calls.push({ args, cwd: options.cwd });
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
        "-c",
        "http.proxy=",
        "-c",
        "https.proxy=",
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
