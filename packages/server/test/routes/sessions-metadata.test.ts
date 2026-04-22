import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex metadata title",
    fullTitle: "Codex metadata title",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 2,
    ownership: { owner: "none" },
    provider: "codex",
    model: "gpt-5-codex",
  };
}

describe("Sessions metadata route", () => {
  it("resolves metadata across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session).toMatchObject({
      id: "sess-1",
      title: "Codex metadata title",
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      project.id,
    );
  });

  it("keeps persisted provider when metadata refresh misses the session summary", async () => {
    const project = createProject();

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          id: "proc-1",
          permissionMode: "default",
          modeVersion: 0,
          state: { type: "idle", since: new Date("2026-03-10T09:47:00.000Z") },
          provider: "claude",
          supportsDynamicCommands: false,
        })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        getProvider: vi.fn(() => "codex"),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/metadata`,
    );
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.session.provider).toBe("codex");
  });

  it("prefers persisted provider over conflicting client resume provider", async () => {
    const project = createProject();
    const resumeSession = vi.fn(async () => ({
      id: "proc-1",
      sessionId: "sess-1",
      permissionMode: "default",
      modeVersion: 0,
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "continue",
          provider: "claude",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resumeSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({ providerName: "codex" }),
    );
  });

  it("preserves persisted provider and model when queueing a restartable message", async () => {
    const project = createProject();
    const queueMessageToSession = vi.fn(async () => ({
      success: true as const,
      restarted: true,
      process: { id: "proc-2" },
    }));

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => ({
          projectPath: project.path,
          isTerminated: false,
          provider: "claude",
          model: "gpt-5.4",
          resolvedModel: "gpt-5.4",
          executor: undefined,
        })),
        queueMessageToSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    });

    const response = await routes.request("/sessions/sess-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "continue",
        thinking: "max",
      }),
    });

    expect(response.status).toBe(200);
    expect(queueMessageToSession).toHaveBeenCalledWith(
      "sess-1",
      project.path,
      expect.objectContaining({ text: "continue" }),
      undefined,
      expect.objectContaining({
        model: "gpt-5.4",
        providerName: "codex",
      }),
    );
  });
});
