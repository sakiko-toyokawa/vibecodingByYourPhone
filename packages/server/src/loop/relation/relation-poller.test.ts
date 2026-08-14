import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelationPoller } from "./relation-poller.js";
import { type RelationRecord, RelationStore } from "./relation-store.js";

function makeRelation(
  state: RelationRecord["state"] = "awaiting_feedback",
  patch: Partial<RelationRecord> = {},
): RelationRecord {
  return {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr",
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state,
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...patch,
  };
}

function githubClient(overrides: Record<string, unknown> = {}): never {
  return {
    getPullRequest: async () => ({
      state: "open",
      merged: false,
      head_sha: "sha",
      draft: false,
    }),
    listPullRequestComments: async () => [],
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getCheckRuns: async () => [],
    ...overrides,
  } as never;
}

function makeQueue() {
  const enqueued: Array<{ event_id: string; payload: object }> = [];
  return {
    enqueued,
    store: {
      enqueue: async (input: { event_id: string; payload: object }) => {
        enqueued.push(input);
        return { ...input, state: "pending" };
      },
    } as never,
  };
}

test("RelationPoller enqueues new inline comments and reviews", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        listPullRequestComments: async () => [
          { id: 3, body: "please fix", user: "reviewer", created_at: "now" },
        ],
        listPullRequestReviews: async () => [
          {
            id: 5,
            body: "",
            state: "changes_requested",
            user: "reviewer",
            submitted_at: "now",
          },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    const events = await poller.pollOnce();
    assert.equal(events, 1);
    assert.equal(queue.enqueued.length, 1);
    assert.match(queue.enqueued[0]?.event_id ?? "", /^github-poll-rel-1-5$/);
    assert.equal(
      (queue.enqueued[0]?.payload as { event_type: string }).event_type,
      "pull_request_review_comment",
    );
    const updated = relationStore.findById("rel-1");
    assert.equal(updated?.state, "fixing");
    assert.equal(updated?.last_processed.comment_id, 3);
    assert.equal(updated?.last_processed.review_id, 5);
    assert.equal(updated?.repair_count, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller enqueues conversation issue comments", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        listIssueComments: async () => [
          { id: 8, body: "please fix", user: "reviewer", created_at: "now" },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 1);
    assert.equal(
      (queue.enqueued[0]?.payload as { event_type: string }).event_type,
      "issue_comment",
    );
    assert.equal(
      relationStore.findById("rel-1")?.last_processed.issue_comment_id,
      8,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller enqueues once when multiple feedback types arrive together", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        listPullRequestComments: async () => [
          { id: 3, body: "inline", user: "reviewer", created_at: "now" },
        ],
        listIssueComments: async () => [
          { id: 8, body: "conversation", user: "reviewer", created_at: "now" },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 1);
    const updated = relationStore.findById("rel-1");
    assert.equal(updated?.repair_count, 1);
    assert.equal(updated?.last_processed.comment_id, 3);
    assert.equal(updated?.last_processed.issue_comment_id, 8);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller enqueues a failed check run once per sha", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getCheckRuns: async () => [
          {
            name: "ci",
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 1);
    assert.equal(
      (queue.enqueued[0]?.payload as { event_type: string }).event_type,
      "ci_failure",
    );
    const failed = relationStore.findById("rel-1");
    assert.equal(failed?.state, "fixing");
    assert.equal(failed?.last_processed.ci_failure_sha, "sha");

    await relationStore.updateState("rel-1", "awaiting_feedback");
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 1);
    assert.equal(relationStore.findById("rel-1")?.state, "awaiting_feedback");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller records recovered checks without enqueue", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(
      makeRelation("awaiting_feedback", {
        last_processed: {
          commit_sha: "sha",
          ci_failure_sha: "sha",
        },
      }),
    );
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getCheckRuns: async () => [
          {
            name: "ci",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    const updated = relationStore.findById("rel-1");
    assert.equal(updated?.last_processed.ci_failure_sha, undefined);
    assert.equal(updated?.state_logs?.at(-1)?.event, "checks_recovered");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller wakes on head movement and initializes the head cursor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(
      makeRelation("awaiting_feedback", {
        last_processed: { commit_sha: "old" },
      }),
    );
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getPullRequest: async () => ({
          state: "open",
          merged: false,
          head_sha: "new",
          draft: false,
        }),
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 1);
    assert.equal(
      (queue.enqueued[0]?.payload as { event_type: string }).event_type,
      "head_moved",
    );
    assert.equal(
      relationStore.findById("rel-1")?.last_processed.commit_sha,
      "new",
    );

    const firstPollStore = new RelationStore({ dataDir });
    await firstPollStore.initialize();
    await firstPollStore.upsert(makeRelation("awaiting_feedback"));
    const firstQueue = makeQueue();
    const firstPoller = new RelationPoller({
      relationStore: firstPollStore,
      githubClient: githubClient(),
      triggerQueueStore: firstQueue.store,
    });
    await firstPoller.pollOnce();
    assert.equal(firstQueue.enqueued.length, 0);
    assert.equal(
      firstPollStore.findById("rel-1")?.last_processed.commit_sha,
      "sha",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller keeps needs_human relations terminal-aware", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation("needs_human"));
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getPullRequest: async () => ({
          state: "closed",
          merged: true,
          head_sha: "sha",
          draft: false,
        }),
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "merged");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller advances awaiting_review when GitHub reports a non-draft PR", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation("awaiting_review"));
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient(),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "awaiting_feedback");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller keeps awaiting_review while the PR is still a draft", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation("awaiting_review"));
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getPullRequest: async () => ({
          state: "open",
          merged: false,
          head_sha: "sha",
          draft: true,
        }),
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "awaiting_review");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller revives closed relations when the PR reopens", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation("closed"));
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient(),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "awaiting_feedback");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller escalates repeated feedback to needs_human", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(
      makeRelation("awaiting_feedback", {
        repair_count: 3,
        last_processed: { comment_id: 2 },
      }),
    );
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        listPullRequestComments: async () => [
          {
            id: 5,
            body: "please fix again",
            user: "reviewer",
            created_at: "now",
          },
        ],
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(queue.enqueued.length, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "needs_human");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller marks merged relations terminal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const queue = makeQueue();
    const poller = new RelationPoller({
      relationStore,
      githubClient: githubClient({
        getPullRequest: async () => ({
          state: "closed",
          merged: true,
          head_sha: "sha",
          draft: false,
        }),
      }),
      triggerQueueStore: queue.store,
    });
    await poller.pollOnce();
    assert.equal(relationStore.findById("rel-1")?.state, "merged");
    assert.equal(queue.enqueued.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
