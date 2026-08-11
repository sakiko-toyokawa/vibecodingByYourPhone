import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubToolProvisioner,
  PublishDraftPrInput,
} from "../github/index.js";
import type {
  RelationRecord,
  RelationStore,
  TriggerQueueStore,
} from "../loop/index.js";

export interface GitHubRoutesDeps {
  credentialStore: GitHubCredentialStore;
  toolProvisioner: GitHubToolProvisioner;
  githubClient: GitHubClient;
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
    const eventId = delivery || `github-${eventType}-${repository}-${prNumber}`;
    await deps.triggerQueueStore.enqueue({
      event_id: eventId,
      loop_id: relation.loop_id,
      source: "webhook",
      priority: "normal",
      payload: {
        relation_id: relation.relation_id,
        event_type: eventType,
        repository,
        pr_number: prNumber,
      },
    });
    await deps.drainPendingTriggers?.(relation.loop_id);
    return c.json({ accepted: true, event_id: eventId }, 202);
  });

  return app;
}
