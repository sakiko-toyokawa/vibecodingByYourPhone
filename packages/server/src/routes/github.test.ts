import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubToolProvisioner,
  PublishDraftPrInput,
} from "../github/index.js";
import { createGitHubRoutes } from "./github.js";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function makeWebhookApp(
  relation: Record<string, unknown>,
  relationUpdates: Array<{ id: string; state: string; patch?: object }>,
  enqueued: Array<{ event_id: string; payload: object }>,
) {
  return new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {} as GitHubClient,
      relationStore: {
        findById: () => relation,
        findByGitHubPr: () => relation,
        updateState: async (id: string, state: string, patch?: object) => {
          relationUpdates.push({ id, state, patch });
          return { ...relation, ...patch, state };
        },
      } as never,
      triggerQueueStore: {
        enqueue: async (input: { event_id: string; payload: object }) => {
          enqueued.push(input);
          return { ...input, state: "pending" };
        },
      } as never,
      drainPendingTriggers: async () => {},
    }),
  );
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

test("GitHub webhook enqueues a trigger for a known relation", async () => {
  const enqueued: Array<{
    event_id: string;
    loop_id: string;
    payload: object;
  }> = [];
  let drainedLoop: string | undefined;
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const relationStore = {
    findById: () => ({
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    }),
    findByGitHubPr: () => ({
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    }),
    updateState: async (id: string, state: string, patch?: object) => {
      relationUpdates.push({ id, state, patch });
      return { relation_id: id, state };
    },
  } as never;
  const triggerQueueStore = {
    enqueue: async (input: {
      event_id: string;
      loop_id: string;
      payload: object;
    }) => {
      enqueued.push(input);
      return { ...input, state: "pending" };
    },
  } as never;
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {} as GitHubClient,
      relationStore,
      triggerQueueStore,
      drainPendingTriggers: async (loopId?: string) => {
        drainedLoop = loopId;
      },
    }),
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request_review_comment",
      "x-github-delivery": "delivery-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12 },
      comment: { id: 123 },
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await json(response), {
    accepted: true,
    event_id: "delivery-1",
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.loop_id, "loop-maintainer");
  assert.equal(
    (enqueued[0]?.payload as { relation_id: string }).relation_id,
    "rel-1",
  );
  assert.equal(
    (enqueued[0]?.payload as { maintenance_id: string }).maintenance_id,
    "rel-1",
  );
  assert.equal(drainedLoop, "loop-maintainer");
  assert.equal(relationUpdates.length, 1);
  assert.equal(relationUpdates[0]?.state, "fixing");
  assert.equal(
    (
      relationUpdates[0]?.patch as {
        last_processed: { comment_id?: number };
      }
    )?.last_processed.comment_id,
    123,
  );
});

test("GitHub webhook writes issue_comment watermark separately", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 0,
      last_processed: { comment_id: 10 },
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-issue-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: { id: 9 },
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(enqueued.length, 1);
  assert.equal(
    (
      relationUpdates[0]?.patch as {
        last_processed: { issue_comment_id?: number; comment_id?: number };
      }
    )?.last_processed.issue_comment_id,
    9,
  );
  assert.equal(
    (
      relationUpdates[0]?.patch as {
        last_processed: { comment_id?: number };
      }
    )?.last_processed.comment_id,
    10,
  );
});

test("GitHub webhook routes pull_request.closed to terminal without repair", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 2,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-close-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12, merged: true },
      action: "closed",
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await json(response), {
    accepted: false,
    reason: "merged",
  });
  assert.equal(enqueued.length, 0);
  assert.equal(relationUpdates[0]?.state, "merged");
});

test("GitHub webhook ignores review dismissal and approval", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const dismissed = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request_review",
      "x-github-delivery": "delivery-dismiss-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12 },
      review: { id: 20, state: "dismissed" },
      action: "dismissed",
    }),
  });
  assert.equal(dismissed.status, 202);
  assert.equal((await json(dismissed)).reason, "review_dismissed");

  const approved = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request_review",
      "x-github-delivery": "delivery-approve-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12 },
      review: { id: 21, state: "approved" },
      action: "submitted",
    }),
  });
  assert.equal(approved.status, 202);
  assert.equal((await json(approved)).reason, "review_approved");
  assert.equal(enqueued.length, 0);
});

test("GitHub webhook ignores synchronize without repair", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 2,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-sync-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12 },
      action: "synchronize",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal((await json(response)).reason, "pull_request_event_ignored");
  assert.equal(enqueued.length, 0);
  assert.equal(
    (
      relationUpdates[0]?.patch as {
        repair_count?: number;
      }
    )?.repair_count,
    2,
  );
});

test("GitHub webhook ignores non-whitelisted events", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_feedback",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "check_run",
      "x-github-delivery": "delivery-check-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      check_run: { id: 1 },
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await json(response), { ignored: "event" });
  assert.equal(enqueued.length, 0);
  assert.equal(relationUpdates.length, 0);
});

test("GitHub webhook advances awaiting_review on ready_for_review", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "awaiting_review",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-ready-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12, draft: false },
      action: "ready_for_review",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal((await json(response)).reason, "ready_for_review");
  assert.equal(enqueued.length, 0);
  assert.equal(relationUpdates[0]?.state, "awaiting_feedback");
});

test("GitHub webhook revives a closed relation on reopen", async () => {
  const relationUpdates: Array<{
    id: string;
    state: string;
    patch?: object;
  }> = [];
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  const app = makeWebhookApp(
    {
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      state: "closed",
      feedback_count: 0,
      repair_count: 0,
      last_processed: {},
    },
    relationUpdates,
    enqueued,
  );

  const response = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-reopen-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12, state: "open" },
      action: "reopened",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal((await json(response)).reason, "reopened");
  assert.equal(enqueued.length, 0);
  assert.equal(relationUpdates[0]?.state, "awaiting_feedback");
});

test("GitHub publish draft PR creates a relation when relation metadata is supplied", async () => {
  const relations: Array<{
    relation_id: string;
    subject: { pr_number?: number };
  }> = [];
  const relationStore = {
    findById: () => null,
    upsert: async (relation: (typeof relations)[number]) => {
      relations.push(relation);
      return relation;
    },
  } as never;
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        publishDraftPr: async () => "https://github.com/owner/repo/pull/12",
      } as unknown as GitHubClient,
      relationStore,
    }),
  );

  const response = await app.request("/github/publish/draft-pr", {
    method: "POST",
    body: JSON.stringify({
      repository: "owner/repo",
      branch: "fix/12",
      title: "Fix bug",
      body: "Verification passed.",
      cwd: "E:/work/owner/repo",
      relation_id: "rel-1",
      loop_id: "loop-maintainer",
      issue_number: 1,
      approved: true,
    }),
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.status, 200);
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.relation_id, "rel-1");
  assert.equal(relations[0]?.subject.pr_number, 12);
});

test("GitHub routes list and get relations", async () => {
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state: "awaiting_feedback",
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
  };
  const relationStore = {
    list: () => [relation],
    findById: () => relation,
  } as never;
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {} as GitHubClient,
      relationStore,
    }),
  );

  const listResponse = await app.request("/github/relations");
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await json(listResponse)).relations, [relation]);

  const detailResponse = await app.request("/github/relations/rel-1");
  assert.equal(detailResponse.status, 200);
  const detail = await json(detailResponse);
  assert.equal(
    (detail.relation as { relation_id: string }).relation_id,
    "rel-1",
  );
});

test("GitHub approve-pr rejects a relation that is not waiting for approval", async () => {
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state: "awaiting_feedback",
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
  };
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
      relationStore: {
        findById: () => relation,
      } as never,
    }),
  );

  const response = await app.request("/github/relations/rel-1/approve-pr", {
    method: "POST",
  });

  assert.equal(response.status, 409);
  assert.equal((await json(response)).error, "invalid_state");
});

test("GitHub approve-pr publishes the pending draft and transitions to awaiting_review", async () => {
  let publishInput: {
    repository: string;
    branch: string;
    title: string;
    body: string;
    cwd: string;
  } | null = null;
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      branch: "fix/12",
    },
    state: "pr_pending_approval",
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    pending_publish: {
      repository: "owner/repo",
      branch: "fix/12",
      title: "Fix bug 12",
      body: "Closes #12",
      cwd: "E:/work/owner/repo",
    },
  };
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        publishDraftPr: async (input: PublishDraftPrInput) => {
          publishInput = input;
          return "https://github.com/owner/repo/pull/12";
        },
      } as unknown as GitHubClient,
      relationStore: {
        findById: () => relation,
        updateState: async (id: string, state: string, patch?: object) => ({
          ...relation,
          ...patch,
          state,
          subject: {
            ...relation.subject,
            ...((patch as { subject?: object } | undefined)?.subject ?? {}),
          },
        }),
      } as never,
    }),
  );

  const response = await app.request("/github/relations/rel-1/approve-pr", {
    method: "POST",
  });

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal((body.relation as { state: string }).state, "awaiting_review");
  assert.equal(
    (body.relation as { subject: { pr_number?: number } }).subject.pr_number,
    12,
  );
  assert.equal(body.prUrl, "https://github.com/owner/repo/pull/12");
  const capturedInput = publishInput as PublishDraftPrInput | null;
  assert.equal(capturedInput?.repository, "owner/repo");
  assert.equal(capturedInput?.branch, "fix/12");
});

test("GitHub mark-ready rejects a relation that is not awaiting review", async () => {
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state: "pr_pending_approval",
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
  };
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        markPullRequestReady: async () => {
          throw new Error("should not mark ready");
        },
      } as unknown as GitHubClient,
      relationStore: {
        findById: () => relation,
      } as never,
    }),
  );

  const response = await app.request("/github/relations/rel-1/mark-ready", {
    method: "POST",
  });

  assert.equal(response.status, 409);
  assert.equal((await json(response)).error, "invalid_state");
});

test("GitHub mark-ready marks the draft PR ready and transitions to awaiting_feedback", async () => {
  let readyArgs: { repository: string; prNumber: number } | null = null;
  const relation = {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state: "awaiting_review",
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
  };
  const app = new Hono().route(
    "/github",
    createGitHubRoutes({
      credentialStore: {} as GitHubCredentialStore,
      toolProvisioner: {} as GitHubToolProvisioner,
      githubClient: {
        markPullRequestReady: async (repository: string, prNumber: number) => {
          readyArgs = { repository, prNumber };
        },
      } as unknown as GitHubClient,
      relationStore: {
        findById: () => relation,
        updateState: async (id: string, state: string) => ({
          ...relation,
          state,
        }),
      } as never,
    }),
  );

  const response = await app.request("/github/relations/rel-1/mark-ready", {
    method: "POST",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(readyArgs, { repository: "owner/repo", prNumber: 12 });
  assert.equal(
    ((await json(response)).relation as { state: string }).state,
    "awaiting_feedback",
  );
});
