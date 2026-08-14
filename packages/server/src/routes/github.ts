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
  type RelationRecord,
  type RelationStore,
  type TriggerQueueStore,
  appendRelationStateLog,
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

export function createGitHubRoutes(deps: GitHubRoutesDeps): Hono {
  const app = new Hono();
  const { credentialStore, toolProvisioner, githubClient } = deps;

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
        await deps.relationStore.upsert(relation);
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
    const saved = await deps.relationStore.upsert(relation);
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
      const updated = await deps.relationStore.updateState(
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
      const updated = await deps.relationStore.updateState(
        relation.relation_id,
        "awaiting_feedback",
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
      await deps.relationStore.updateState(
        relation.relation_id,
        relation.state,
        {
          state_logs: appendRelationStateLog(
            relation,
            "review_dismissed",
            `GitHub review dismissed on ${repository}#${prNumber}`,
          ),
        },
      );
      return c.json({ accepted: false, reason: "review_dismissed" }, 202);
    }
    if (eventType === "pull_request_review" && review?.state === "approved") {
      await deps.relationStore.updateState(
        relation.relation_id,
        relation.state,
        {
          state_logs: appendRelationStateLog(
            relation,
            "review_approved",
            `GitHub review approved on ${repository}#${prNumber}`,
          ),
        },
      );
      return c.json({ accepted: false, reason: "review_approved" }, 202);
    }
    if (eventType === "pull_request") {
      if (action === "closed") {
        const merged = pullRequest?.merged === true;
        const terminalState = merged ? "merged" : "closed";
        await deps.relationStore.updateState(
          relation.relation_id,
          terminalState,
          {
            state_logs: appendRelationStateLog(
              relation,
              terminalState,
              `GitHub webhook observed PR ${repository}#${prNumber} ${merged ? "merged" : "closed"}`,
            ),
          },
        );
        return c.json({ accepted: false, reason: terminalState }, 202);
      }
      if (action === "reopened" && relation.state === "closed") {
        await deps.relationStore.updateState(
          relation.relation_id,
          "awaiting_feedback",
          {
            state_logs: appendRelationStateLog(
              relation,
              "reopened",
              `GitHub webhook observed PR ${repository}#${prNumber} reopened`,
            ),
          },
        );
        return c.json({ accepted: false, reason: "reopened" }, 202);
      }
      if (
        action === "ready_for_review" &&
        relation.state === "awaiting_review"
      ) {
        await deps.relationStore.updateState(
          relation.relation_id,
          "awaiting_feedback",
          {
            state_logs: appendRelationStateLog(
              relation,
              "ready_for_review",
              `GitHub webhook observed PR ${repository}#${prNumber} ready for review`,
            ),
          },
        );
        return c.json({ accepted: false, reason: "ready_for_review" }, 202);
      }
      await deps.relationStore.updateState(
        relation.relation_id,
        relation.state,
        {
          state_logs: appendRelationStateLog(
            relation,
            "pull_request_event_ignored",
            `GitHub pull_request event '${action}' did not require a maintenance wake for ${repository}#${prNumber}`,
          ),
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
    const nextRepairCount = relation.repair_count + 1;
    if (nextRepairCount > 3) {
      await deps.relationStore.updateState(
        relation.relation_id,
        "needs_human",
        {
          needs_human_reason:
            "repeated relation feedback exceeded auto-repair limit",
          last_processed: {
            ...relation.last_processed,
            ...lastProcessedPatch,
          },
        },
      );
      return c.json({ accepted: false, reason: "repair_limit_reached" }, 202);
    }
    await deps.relationStore.updateState(relation.relation_id, "fixing", {
      last_processed: {
        ...relation.last_processed,
        ...lastProcessedPatch,
      },
      feedback_count: relation.feedback_count + 1,
      repair_count: nextRepairCount,
      state_logs: appendRelationStateLog(
        relation,
        eventType,
        `GitHub webhook ${eventType} woke maintenance for ${repository}#${prNumber}`,
      ),
    });
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
