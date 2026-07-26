import { Hono } from "hono";
import type {
  GitHubClient,
  GitHubCredentialStore,
  GitHubIssueLoopService,
  GitHubToolProvisioner,
  PublishDraftPrInput,
} from "../github/index.js";

export interface GitHubRoutesDeps {
  credentialStore: GitHubCredentialStore;
  toolProvisioner: GitHubToolProvisioner;
  githubClient: GitHubClient;
  issueLoopService?: GitHubIssueLoopService;
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

export function createGitHubRoutes(deps: GitHubRoutesDeps): Hono {
  const app = new Hono();
  const { credentialStore, toolProvisioner, githubClient, issueLoopService } =
    deps;

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

  app.post("/issue-loops/start", async (c) => {
    if (!issueLoopService) {
      return c.json({ error: "github_issue_loop_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const query =
      body && typeof body === "object"
        ? getString(body as Record<string, unknown>, "query")
        : null;
    if (!query) {
      return c.json({ error: "query_required" }, 400);
    }
    try {
      const result = await issueLoopService.startFromQuery(query);
      return c.json(result, 201);
    } catch (error) {
      return c.json(
        { error: "github_issue_loop_failed", message: errorMessage(error) },
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
    };
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
      return c.json({ prUrl });
    } catch (error) {
      return c.json(
        { error: "publish_failed", message: errorMessage(error) },
        502,
      );
    }
  });

  return app;
}
