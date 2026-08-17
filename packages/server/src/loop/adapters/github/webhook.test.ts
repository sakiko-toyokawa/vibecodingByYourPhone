import assert from "node:assert/strict";
import test from "node:test";
import type { TargetWebhookContext } from "../../targets/registry.js";
import { createGithubPrTarget } from "./pr-target.js";

/** 直面生产路径的 adapter webhook 语义测试（路由层 fallback 不覆盖这些）。 */

function makeRelation(state = "awaiting_feedback") {
  return {
    relation_id: "rel-1",
    loop_id: "loop-1",
    subject: {
      type: "github_pr" as const,
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state,
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    // biome 与 tsc 都只要求结构匹配 RelationRecord；缺省字段在测试里省略
  } as never;
}

function makeCtx(overrides: Partial<TargetWebhookContext> = {}) {
  const transitions: Array<{ state: string; event: string }> = [];
  const feedbackCalls: number[] = [];
  const enqueued: Array<{
    event_id: string;
    payload: Record<string, unknown>;
  }> = [];
  const lifecycle = {
    transition: async (
      id: string,
      state: string,
      _patch: object,
      log?: { event: string },
    ) => {
      transitions.push({ state, event: log?.event ?? "" });
      return makeRelation(state);
    },
    receiveFeedback: async () => {
      feedbackCalls.push(1);
      return { relation: makeRelation("fixing"), repairLimitReached: false };
    },
  };
  const triggerQueueStore = {
    enqueue: async (input: {
      event_id: string;
      payload: Record<string, unknown>;
    }) => {
      enqueued.push(input);
      return { ...input, state: "pending" };
    },
  };
  const ctx: TargetWebhookContext = {
    lifecycle: lifecycle as never,
    triggerQueueStore: triggerQueueStore as never,
    eventType: "issue_comment",
    action: "created",
    repository: "owner/repo",
    subjectNumber: 12,
    delivery: "d-1",
    selfLogin: null,
    ...overrides,
  };
  return { ctx, transitions, feedbackCalls, enqueued };
}

test("webhook adapter short-circuits approved reviews without a wake", async () => {
  const { ctx, transitions, feedbackCalls, enqueued } = makeCtx({
    eventType: "pull_request_review",
    action: "submitted",
    review: { id: 5, state: "approved", user: { login: "maintainer" } },
  });
  const result = await createGithubPrTarget().handleWebhook(
    makeRelation(),
    {},
    ctx,
  );
  assert.deepEqual(result, { accepted: false, reason: "review_approved" });
  assert.equal(feedbackCalls.length, 0);
  assert.equal(enqueued.length, 0);
  assert.equal(transitions[0]?.event, "review_approved");
});

test("webhook adapter short-circuits dismissed reviews without a wake", async () => {
  const { ctx, feedbackCalls, enqueued } = makeCtx({
    eventType: "pull_request_review",
    action: "dismissed",
    review: { id: 5, state: "dismissed", user: { login: "maintainer" } },
  });
  const result = await createGithubPrTarget().handleWebhook(
    makeRelation(),
    {},
    ctx,
  );
  assert.deepEqual(result, { accepted: false, reason: "review_dismissed" });
  assert.equal(feedbackCalls.length, 0);
  assert.equal(enqueued.length, 0);
});

test("webhook adapter logs and ignores unhandled pull_request actions", async () => {
  const { ctx, transitions, enqueued } = makeCtx({
    eventType: "pull_request",
    action: "synchronize",
    pullRequest: { number: 12 },
  });
  const result = await createGithubPrTarget().handleWebhook(
    makeRelation(),
    {},
    ctx,
  );
  assert.deepEqual(result, {
    accepted: false,
    reason: "pull_request_event_ignored",
    action: "synchronize",
  });
  assert.equal(enqueued.length, 0);
  assert.equal(transitions[0]?.event, "pull_request_event_ignored");
});

test("webhook adapter wakes on external comments with a relation-scoped event id", async () => {
  const { ctx, enqueued } = makeCtx({
    comment: { id: 77, user: { login: "external-user" } },
  });
  const result = await createGithubPrTarget().handleWebhook(
    makeRelation(),
    { comment: { id: 77 } },
    ctx,
  );
  assert.deepEqual(result, { accepted: true, event_id: "d-1-rel-1" });
  assert.equal(enqueued.length, 1);
  // 只带水位 cursor,不把整个 webhook payload 摊进队列条目
  assert.equal(enqueued[0]?.payload.issue_comment_id, 77);
  assert.equal(enqueued[0]?.payload.comment, undefined);
});
