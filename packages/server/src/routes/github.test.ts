import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubIssueLoopService,
  GitHubToolProvisioner,
} from "../github/index.js";
import { createGitHubRoutes } from "./github.js";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("GitHub routes store token without echoing it", async () => {
  let token: string | null = null;
  const credentialStore = {
    getStatus: () => ({
      configured: token !== null,
      tokenPreview: token ? "ghp_...1234" : null,
      updatedAt: token ? "2026-07-24T00:00:00.000Z" : null,
    }),
    setToken: async (next: string) => {
      token = next;
    },
    clearToken: async () => {
      token = null;
    },
  } as GitHubCredentialStore;
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {} as GitHubClient,
    }),
  );

  const response = await app.request("/github/credentials", {
    method: "PUT",
    body: JSON.stringify({ token: "ghp_secret1234" }),
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body.credential, {
    configured: true,
    tokenPreview: "ghp_...1234",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(body).includes("ghp_secret1234"), false);
});

test("GitHub routes ensure gh and search issues", async () => {
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {
        getStatus: () => ({
          configured: true,
          tokenPreview: "ghp_...1234",
          updatedAt: "2026-07-24T00:00:00.000Z",
        }),
      } as GitHubCredentialStore,
      toolProvisioner: {
        ensureGh: async () => ({
          installed: true,
          path: "E:/data/tools/gh/2.64.0/bin/gh.exe",
          version: "2.64.0",
        }),
      } as GitHubToolProvisioner,
      githubClient: {
        searchIssues: async (query: string, options: { limit: number }) => [
          {
            repository: "owner/repo",
            number: options.limit,
            title: query,
            url: "https://github.com/owner/repo/issues/1",
            labels: ["bug"],
          },
        ],
      } as unknown as GitHubClient,
    }),
  );

  const toolResponse = await app.request("/github/tools/gh/ensure", {
    method: "POST",
  });
  assert.equal(toolResponse.status, 200);
  assert.equal((await json(toolResponse)).tool instanceof Object, true);

  const searchResponse = await app.request(
    "/github/issues/search?query=label%3Abug&limit=1",
  );
  assert.equal(searchResponse.status, 200);
  assert.deepEqual((await json(searchResponse)).issues, [
    {
      repository: "owner/repo",
      number: 1,
      title: "label:bug",
      url: "https://github.com/owner/repo/issues/1",
      labels: ["bug"],
    },
  ]);
});

test("GitHub routes publish draft PR through the approved publish endpoint", async () => {
  let published = false;
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        publishDraftPr: async () => {
          published = true;
          return "https://github.com/owner/repo/pull/12";
        },
      } as unknown as GitHubClient,
    }),
  );

  const response = await app.request("/github/publish/draft-pr", {
    method: "POST",
    body: JSON.stringify({
      repository: "owner/repo",
      branch: "yep/1-fix",
      title: "Fix bug",
      body: "Verification passed.",
      cwd: "E:/work/owner/repo",
      approved: true,
    }),
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.status, 200);
  assert.equal(published, true);
  assert.deepEqual(await json(response), {
    prUrl: "https://github.com/owner/repo/pull/12",
  });
});

test("GitHub routes reject draft PR publication without explicit approval flag", async () => {
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        publishDraftPr: async () => {
          throw new Error("should not publish");
        },
      } as unknown as GitHubClient,
    }),
  );

  const response = await app.request("/github/publish/draft-pr", {
    method: "POST",
    body: JSON.stringify({
      repository: "owner/repo",
      branch: "yep/1-fix",
      title: "Fix bug",
      body: "Verification passed.",
      cwd: "E:/work/owner/repo",
    }),
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error, "approval_required");
});

test("GitHub routes start an issue loop from a search query", async () => {
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {} as GitHubClient,
      issueLoopService: {
        startFromQuery: async (query: string) => ({
          issue: {
            repository: "owner/repo",
            number: 7,
            title: query,
            url: "https://github.com/owner/repo/issues/7",
            labels: ["bug"],
          },
          loopId: "github-owner-repo-issue-7",
          workspacePath: "E:/data/github-workspaces/owner/repo/issues/7",
          branch: "yep/7-bug",
          run: {
            run_id: "run-1",
            loop_id: "github-owner-repo-issue-7",
            state: "active",
            source: "manual",
            created_at: "2026-07-24T00:00:00.000Z",
          },
        }),
      } as GitHubIssueLoopService,
    }),
  );

  const response = await app.request("/github/issue-loops/start", {
    method: "POST",
    body: JSON.stringify({ query: "label:bug language:TypeScript" }),
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.status, 201);
  assert.equal((await json(response)).loopId, "github-owner-repo-issue-7");
});
