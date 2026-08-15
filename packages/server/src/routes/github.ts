import { createHmac, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubToolProvisioner,
  PublishDraftPrInput,
} from "../github/index.js";
import {
  RelationLifecycleService,
  type RelationRecord,
  type RelationStore,
  type TriggerQueueStore,
} from "../loop/index.js";
import { isGitWorkTree } from "../loop/index.js";
import { githubPromptWorkspacePath } from "../loop/run/workspace.js";

export interface GitHubRoutesDeps {
  credentialStore: GitHubCredentialStore;
  toolProvisioner: GitHubToolProvisioner;
  githubClient: GitHubClient;
  /** Required to validate that pending PR publish cwd stays in the managed workspace. */
  dataDir?: string;
  relationStore?: RelationStore;
  relationLifecycle?: RelationLifecycleService;
  triggerQueueStore?: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

const WEBHOOK_EVENT_WHITELIST = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request",
]);

function prNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function issueNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/issues\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export function createGitHubRoutes(deps: GitHubRoutesDeps): Hono {
  const app = new Hono();
  const { credentialStore, toolProvisioner, githubClient } = deps;
  const lifecycle = deps.relationStore
    ? (deps.relationLifecycle ??
      new RelationLifecycleService({ relationStore: deps.relationStore }))
    : undefined;

  app.get("/credentials", (c) => {
    return c.json({ credential: credentialStore.getStatus() });
  });

  app.put("/credentials", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const token =
      body && typeof body === "object"
        ? getString(body as Record<string, unknown>, "token")
        : null;
    if (!token) {
      return c.json({ error: "token_required" }, 400);
    }
    try {
      await credentialStore.setToken(token);
      return c.json({ credential: credentialStore.getStatus() });
    } catch (error) {
      return c.json(
        { error: "credential_error", message: errorMessage(error) },
        400,
      );
    }
  });

  app.delete("/credentials", async (c) => {
    await credentialStore.clearToken();
    return c.json({ credential: credentialStore.getStatus() });
  });

  app.post("/tools/gh/ensure", async (c) => {
    try {
      const tool = await toolProvisioner.ensureGh();
      return c.json({ tool });
    } catch (error) {
      return c.json(
        { error: "tool_install_failed", message: errorMessage(error) },
        500,
      );
    }
  });

  app.get("/issues/search", async (c) => {
    const query = c.req.query("query")?.trim();
    if (!query) {
      return c.json({ error: "query_required" }, 400);
    }
    const rawLimit = Number(c.req.query("limit") ?? "1");
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(10, Math.trunc(rawLimit)))
      : 1;
    try {
      const issues = await githubClient.searchIssues(query, { limit });
      return c.json({ issues });
    } catch (error) {
      return c.json(
        { error: "github_search_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  app.post("/publish/draft-pr", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const input = body as Record<string, unknown>;
    if (input.approved !== true) {
      return c.json({ error: "approval_required" }, 400);
    }
    const publishInput: PublishDraftPrInput = {
      repository: getString(input, "repository") ?? "",
      branch: getString(input, "branch") ?? "",
      title: getString(input, "title") ?? "",
      body: getString(input, "body") ?? "",
      cwd: getString(input, "cwd") ?? "",
      draft: typeof input.draft === "boolean" ? input.draft : undefined,
    };
    const relationId = optionalString(input, "relation_id");
    const loopId = optionalString(input, "loop_id");
    const issueNumber = optionalNumber(input, "issue_number");
    const baseSha = optionalString(input, "base_sha");
    const forkOwner = optionalString(input, "fork_owner");
    if (
      !publishInput.repository ||
      !publishInput.branch ||
      !publishInput.title ||
      !publishInput.body ||
      !publishInput.cwd
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      const prUrl = await githubClient.publishDraftPr(publishInput);
      if (
        deps.relationStore &&
        relationId &&
        loopId &&
        !deps.relationStore.findById(relationId)
      ) {
        const prNumber = prNumberFromUrl(prUrl);
        const relation: RelationRecord = {
          relation_id: relationId,
          loop_id: loopId,
          subject: {
            type: "github_pr",
            repository: publishInput.repository,
            pr_number: prNumber,
            ...(issueNumber ? { issue_number: issueNumber } : {}),
            branch: publishInput.branch,
            ...(forkOwner ? { fork_owner: forkOwner } : {}),
            ...(baseSha ? { base_sha: baseSha } : {}),
          },
          state: "awaiting_feedback",
          last_processed: {},
          feedback_count: 0,
          repair_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await lifecycle?.upsert(relation, {
          event: "awaiting_feedback",
          message: `Draft PR published for ${publishInput.repository}:${publishInput.branch}`,
        });
      }
      return c.json({ prUrl });
    } catch (error) {
      return c.json(
        { error: "publish_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  app.post("/relations", async (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const input = body as Record<string, unknown>;
    const relationId = getString(input, "relation_id");
    const loopId = getString(input, "loop_id");
    const repository = getString(input, "repository");
    const branch = getString(input, "branch");
    if (!relationId || !loopId || !repository || !branch) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const existing = deps.relationStore.findById(relationId);
    const now = new Date().toISOString();
    const relation: RelationRecord = {
      ...(existing ?? {
        relation_id: relationId,
        loop_id: loopId,
        subject: {
          type: "github_pr",
          repository,
          branch,
        },
        state: "awaiting_feedback",
        last_processed: {},
        feedback_count: 0,
        repair_count: 0,
        created_at: now,
        updated_at: now,
      }),
      relation_id: relationId,
      loop_id: loopId,
      subject: {
        type: "github_pr",
        repository,
        branch,
        ...(optionalNumber(input, "issue_number")
          ? { issue_number: optionalNumber(input, "issue_number") }
          : {}),
        ...(optionalNumber(input, "pr_number")
          ? { pr_number: optionalNumber(input, "pr_number") }
          : {}),
        ...(optionalString(input, "fork_owner")
          ? { fork_owner: optionalString(input, "fork_owner") }
          : {}),
        ...(optionalString(input, "base_sha")
          ? { base_sha: optionalString(input, "base_sha") }
          : {}),
      },
      state: existing?.state ?? "awaiting_feedback",
      last_processed: existing?.last_processed ?? {},
      feedback_count: existing?.feedback_count ?? 0,
      repair_count: existing?.repair_count ?? 0,
      updated_at: now,
    };
    const saved = await lifecycle?.upsert(relation);
    if (!saved) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    return c.json({ relation: saved }, 200);
  });

  app.get("/relations", (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    const loopId = c.req.query("loop_id");
    const relations = deps.relationStore
      .list()
      .filter((relation) => !loopId || relation.loop_id === loopId);
    return c.json({ relations });
  });

  app.get("/relations/:id", (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    const relation = deps.relationStore.findById(c.req.param("id"));
    if (!relation) {
      return c.json({ error: "relation_not_found" }, 404);
    }
    return c.json({ relation });
  });

  app.post("/relations/:id/approve-pr", async (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    const relation = deps.relationStore.findById(c.req.param("id"));
    if (!relation) {
      return c.json({ error: "relation_not_found" }, 404);
    }
    if (relation.state !== "pr_pending_approval") {
      return c.json(
        {
          error: "invalid_state",
          message: `relation '${relation.relation_id}' is '${relation.state}', not 'pr_pending_approval'`,
        },
        409,
      );
    }
    const pending = relation.pending_publish;
    if (
      relation.subject.type !== "github_pr" ||
      !pending ||
      !pending.repository ||
      !pending.branch ||
      !pending.title ||
      !pending.body ||
      !pending.cwd
    ) {
      return c.json(
        {
          error: "invalid_publish_payload",
          message: "relation has no complete pending_publish payload",
        },
        409,
      );
    }
    if (deps.dataDir && !(await isValidPrPublishCwd(relation, deps.dataDir))) {
      return c.json(
        {
          error: "invalid_publish_payload",
          message:
            "pending_publish.cwd must be an existing git checkout inside this loop's managed workspace",
        },
        409,
      );
    }
    try {
      const prUrl = await githubClient.publishDraftPr({
        repository: pending.repository,
        branch: pending.branch,
        title: pending.title,
        body: pending.body,
        cwd: pending.cwd,
        draft: true,
      });
      const prNumber = prNumberFromUrl(prUrl);
      if (!prNumber) {
        throw new Error(`GitHub returned an invalid PR URL: ${prUrl}`);
      }
      const updated = await lifecycle?.transition(
        relation.relation_id,
        "awaiting_review",
        {
          subject: {
            ...relation.subject,
            repository: pending.repository,
            branch: pending.branch,
            pr_number: prNumber,
          },
          pending_publish: undefined,
        },
        {
          event: "awaiting_review",
          message: `Draft PR published as ${pending.repository}#${prNumber}`,
        },
      );
      if (!updated) {
        throw new Error("relation disappeared while publishing draft PR");
      }
      return c.json({ relation: updated, prUrl });
    } catch (error) {
      return c.json(
        { error: "publish_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  /**
   * POST /relations/:id/approve-issue — 人工批准并发布 ISSUE-PROPOSAL。
   * 与 approve-pr 对称：publish_mode="issue" 的调研型 loop 产出的提案
   * 停在 pr_pending_approval，批准后由 server 执行 gh issue create，
   * relation 转 awaiting_feedback 等待维护者回应。
   *
   * Errors: 404 relation_not_found；409 invalid_state /
   * invalid_issue_payload；502 publish_failed。
   */
  app.post("/relations/:id/approve-issue", async (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    const relation = deps.relationStore.findById(c.req.param("id"));
    if (!relation) {
      return c.json({ error: "relation_not_found" }, 404);
    }
    if (relation.state !== "pr_pending_approval") {
      return c.json(
        {
          error: "invalid_state",
          message: `relation '${relation.relation_id}' is '${relation.state}', not 'pr_pending_approval'`,
        },
        409,
      );
    }
    const proposal = relation.pending_issue;
    if (
      relation.subject.type !== "github_issue" ||
      !proposal ||
      !proposal.repository ||
      !proposal.title ||
      !proposal.body
    ) {
      return c.json(
        {
          error: "invalid_issue_payload",
          message: "relation has no complete pending_issue payload",
        },
        409,
      );
    }
    try {
      // 查重后提案可能要求评论已有 issue 而非新建（agent 在提案里用
      // action=comment_on_existing_issue + target_issue 表达）。
      if (proposal.action === "comment_on_existing_issue") {
        if (!proposal.target_issue) {
          return c.json(
            {
              error: "invalid_issue_payload",
              message: "comment action requires target_issue",
            },
            409,
          );
        }
        const commentUrl = await githubClient.commentOnIssue({
          repository: proposal.repository,
          issueNumber: proposal.target_issue,
          body: proposal.body,
        });
        const updated = await lifecycle?.transition(
          relation.relation_id,
          "awaiting_feedback",
          {
            subject: {
              type: "github_issue",
              repository: proposal.repository,
              issue_number: proposal.target_issue,
            },
            pending_issue: undefined,
          },
          {
            event: "comment_published",
            message: `Analysis posted as a comment on ${proposal.repository}#${proposal.target_issue} (${commentUrl})`,
          },
        );
        if (!updated) {
          throw new Error("relation disappeared while posting comment");
        }
        return c.json({ relation: updated, commentUrl });
      }
      const issueUrl = await githubClient.createIssue({
        repository: proposal.repository,
        title: proposal.title,
        body: proposal.body,
      });
      const issueNumber = issueNumberFromUrl(issueUrl);
      const updated = await lifecycle?.transition(
        relation.relation_id,
        "awaiting_feedback",
        {
          subject: {
            type: "github_issue",
            repository: proposal.repository,
            ...(issueNumber ? { issue_number: issueNumber } : {}),
          },
          pending_issue: undefined,
        },
        {
          event: "issue_published",
          message: `Issue published as ${proposal.repository}#${issueNumber ?? "?"} (${issueUrl})`,
        },
      );
      if (!updated) {
        throw new Error("relation disappeared while publishing issue");
      }
      return c.json({ relation: updated, issueUrl });
    } catch (error) {
      return c.json(
        { error: "publish_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  app.post("/relations/:id/mark-ready", async (c) => {
    if (!deps.relationStore) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    const relation = deps.relationStore.findById(c.req.param("id"));
    if (!relation) {
      return c.json({ error: "relation_not_found" }, 404);
    }
    if (relation.state !== "awaiting_review") {
      return c.json(
        {
          error: "invalid_state",
          message: `relation '${relation.relation_id}' is '${relation.state}', not 'awaiting_review'`,
        },
        409,
      );
    }
    if (relation.subject.type !== "github_pr") {
      return c.json(
        {
          error: "invalid_relation_subject",
          message: "mark-ready only applies to github_pr relations",
        },
        409,
      );
    }
    const prNumber = relation.subject.pr_number;
    if (!prNumber || !relation.subject.repository) {
      return c.json(
        {
          error: "invalid_relation_subject",
          message: "relation has no published PR number",
        },
        409,
      );
    }
    try {
      await githubClient.markPullRequestReady(
        relation.subject.repository,
        prNumber,
      );
      const updated = await lifecycle?.transition(
        relation.relation_id,
        "awaiting_feedback",
        {},
        {
          event: "ready_for_review",
          message: `Draft PR ${relation.subject.repository}#${prNumber} marked ready for review`,
        },
      );
      if (!updated) {
        throw new Error("relation disappeared while marking PR ready");
      }
      return c.json({ relation: updated });
    } catch (error) {
      return c.json(
        { error: "mark_ready_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  /**
   * POST /relations/:id/resolve — needs_human relation 的人工出口。
   * action=retry：重置 repair 预算，回到 awaiting_feedback 等下一条反馈；
   * action=close：停止跟踪（终态 closed，日志事件 dismissed，
   * poller 不会把它当作 GitHub 侧关闭后又重开而复活）。
   *
   * Errors: 400 invalid_resolve（body 非法）；404 relation_not_found；
   * 409 invalid_state（relation 不在 needs_human）。
   */
  app.post("/relations/:id/resolve", async (c) => {
    if (!deps.relationStore || !lifecycle) {
      return c.json({ error: "relation_store_unavailable" }, 503);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_resolve", message: "invalid JSON" }, 400);
    }
    const action = getString(body, "action");
    if (action !== "retry" && action !== "close") {
      return c.json(
        {
          error: "invalid_resolve",
          message: "action must be 'retry' or 'close'",
        },
        400,
      );
    }
    const note = optionalString(body, "note");
    const result = await lifecycle.resolve(c.req.param("id"), action, note);
    if (result === null) {
      return c.json({ error: "relation_not_found" }, 404);
    }
    if (result === "invalid_state") {
      const relation = deps.relationStore.findById(c.req.param("id"));
      return c.json(
        {
          error: "invalid_state",
          message: `relation '${c.req.param("id")}' is '${relation?.state ?? "unknown"}', not 'needs_human'`,
        },
        409,
      );
    }
    return c.json({ relation: result });
  });

  app.post("/webhook", async (c) => {
    if (!deps.relationStore || !deps.triggerQueueStore) {
      return c.json({ error: "relation_trigger_unavailable" }, 503);
    }
    const eventType = c.req.header("x-github-event") ?? "unknown";
    const delivery = c.req.header("x-github-delivery") ?? "";
    const raw = await c.req.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const signature = c.req.header("x-hub-signature-256") ?? "";
      const expected = `sha256=${createHmac("sha256", secret)
        .update(raw)
        .digest("hex")}`;
      const expectedBuffer = Buffer.from(expected);
      const signatureBuffer = Buffer.from(signature);
      if (
        expectedBuffer.length !== signatureBuffer.length ||
        !timingSafeEqual(expectedBuffer, signatureBuffer)
      ) {
        return c.json({ error: "invalid_signature" }, 401);
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!WEBHOOK_EVENT_WHITELIST.has(eventType)) {
      return c.json({ ignored: "event" }, 202);
    }
    const repository =
      typeof payload.repository === "object" &&
      payload.repository !== null &&
      typeof (payload.repository as Record<string, unknown>).full_name ===
        "string"
        ? ((payload.repository as Record<string, unknown>).full_name as string)
        : undefined;
    const pullRequest =
      typeof payload.pull_request === "object" && payload.pull_request !== null
        ? (payload.pull_request as Record<string, unknown>)
        : undefined;
    const issue =
      typeof payload.issue === "object" && payload.issue !== null
        ? (payload.issue as Record<string, unknown>)
        : undefined;
    const prNumber =
      typeof pullRequest?.number === "number"
        ? pullRequest.number
        : typeof issue?.number === "number"
          ? issue.number
          : undefined;
    if (!repository || !prNumber) {
      return c.json(
        { accepted: false, reason: "missing_repository_or_pr" },
        202,
      );
    }
    const relation = deps.relationStore.findByGitHubPr(repository, prNumber);
    if (!relation) {
      return c.json({ accepted: false, reason: "relation_not_found" }, 202);
    }
    const comment =
      typeof payload.comment === "object" && payload.comment !== null
        ? (payload.comment as Record<string, unknown>)
        : undefined;
    const review =
      typeof payload.review === "object" && payload.review !== null
        ? (payload.review as Record<string, unknown>)
        : undefined;
    const action = getString(payload, "action") ?? "";
    if (eventType === "pull_request_review" && action === "dismissed") {
      await lifecycle?.transition(
        relation.relation_id,
        relation.state,
        {},
        {
          event: "review_dismissed",
          message: `GitHub review dismissed on ${repository}#${prNumber}`,
        },
      );
      return c.json({ accepted: false, reason: "review_dismissed" }, 202);
    }
    if (eventType === "pull_request_review" && review?.state === "approved") {
      await lifecycle?.transition(
        relation.relation_id,
        relation.state,
        {},
        {
          event: "review_approved",
          message: `GitHub review approved on ${repository}#${prNumber}`,
        },
      );
      return c.json({ accepted: false, reason: "review_approved" }, 202);
    }
    if (eventType === "pull_request") {
      if (action === "closed") {
        const merged = pullRequest?.merged === true;
        const terminalState = merged ? "merged" : "closed";
        await lifecycle?.transition(
          relation.relation_id,
          terminalState,
          {},
          {
            event: terminalState,
            message: `GitHub webhook observed PR ${repository}#${prNumber} ${merged ? "merged" : "closed"}`,
          },
        );
        return c.json({ accepted: false, reason: terminalState }, 202);
      }
      if (action === "reopened" && relation.state === "closed") {
        await lifecycle?.transition(
          relation.relation_id,
          "awaiting_feedback",
          {},
          {
            event: "reopened",
            message: `GitHub webhook observed PR ${repository}#${prNumber} reopened`,
          },
        );
        return c.json({ accepted: false, reason: "reopened" }, 202);
      }
      if (
        action === "ready_for_review" &&
        relation.state === "awaiting_review"
      ) {
        await lifecycle?.transition(
          relation.relation_id,
          "awaiting_feedback",
          {},
          {
            event: "ready_for_review",
            message: `GitHub webhook observed PR ${repository}#${prNumber} ready for review`,
          },
        );
        return c.json({ accepted: false, reason: "ready_for_review" }, 202);
      }
      await lifecycle?.transition(
        relation.relation_id,
        relation.state,
        {},
        {
          event: "pull_request_event_ignored",
          message: `GitHub pull_request event '${action}' did not require a maintenance wake for ${repository}#${prNumber}`,
        },
      );
      return c.json(
        { accepted: false, reason: "pull_request_event_ignored", action },
        202,
      );
    }
    if (relation.state !== "awaiting_feedback" && relation.state !== "fixing") {
      return c.json(
        { accepted: false, reason: "relation_not_actionable" },
        202,
      );
    }
    const commentId =
      typeof comment?.id === "number"
        ? comment.id
        : typeof comment?.id === "string" && comment.id.trim() !== ""
          ? Number(comment.id)
          : undefined;
    const reviewId =
      typeof review?.id === "number"
        ? review.id
        : typeof review?.id === "string" && review.id.trim() !== ""
          ? Number(review.id)
          : undefined;
    const issueCommentId =
      eventType === "issue_comment" ? commentId : undefined;
    const lastProcessedPatch: Partial<RelationRecord["last_processed"]> = {};
    const eventPayload: Record<string, unknown> = {};
    if (eventType === "issue_comment") {
      if (!issueCommentId) {
        return c.json({ accepted: false, reason: "missing_comment" }, 202);
      }
      lastProcessedPatch.issue_comment_id = issueCommentId;
      eventPayload.issue_comment_id = issueCommentId;
    } else if (eventType === "pull_request_review_comment") {
      if (!commentId) {
        return c.json({ accepted: false, reason: "missing_comment" }, 202);
      }
      lastProcessedPatch.comment_id = commentId;
      eventPayload.comment_id = commentId;
    } else if (eventType === "pull_request_review") {
      if (!reviewId) {
        return c.json({ accepted: false, reason: "missing_review" }, 202);
      }
      lastProcessedPatch.review_id = reviewId;
      eventPayload.review_id = reviewId;
    } else {
      return c.json({ accepted: false, reason: "event_ignored" }, 202);
    }
    const feedback = await lifecycle?.receiveFeedback(relation.relation_id, {
      eventType,
      cursor: lastProcessedPatch,
      incrementFeedbackCount: true,
      log: {
        event: eventType,
        message: `GitHub webhook ${eventType} woke maintenance for ${repository}#${prNumber}`,
      },
    });
    if (feedback?.repairLimitReached) {
      return c.json({ accepted: false, reason: "repair_limit_reached" }, 202);
    }
    if (!feedback?.relation) {
      return c.json({ accepted: false, reason: "relation_not_found" }, 202);
    }
    const eventId = delivery || `github-${eventType}-${repository}-${prNumber}`;
    await deps.triggerQueueStore.enqueue({
      event_id: eventId,
      loop_id: relation.loop_id,
      source: "webhook",
      priority: "normal",
      payload: {
        relation_id: relation.relation_id,
        maintenance_id: relation.relation_id,
        event_type: eventType,
        repository,
        pr_number: prNumber,
        ...eventPayload,
      },
    });
    await deps.drainPendingTriggers?.(relation.loop_id);
    return c.json({ accepted: true, event_id: eventId }, 202);
  });

  return app;
}

async function isValidPrPublishCwd(
  relation: RelationRecord,
  dataDir: string,
): Promise<boolean> {
  const pending = relation.pending_publish;
  if (!pending) {
    return false;
  }
  const cwd = path.resolve(pending.cwd);
  const managedRoot = githubPromptWorkspacePath(dataDir, relation.loop_id);
  const relative = path.relative(path.resolve(managedRoot), cwd);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !(await stat(cwd).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  ) {
    return false;
  }
  return isGitWorkTree(cwd);
}
