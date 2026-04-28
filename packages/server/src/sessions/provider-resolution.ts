import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import { providerRegistry } from "../providers/registry.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import type { CodexSessionReader } from "./codex-reader.js";
import type { GeminiSessionReader } from "./gemini-reader.js";
import { ClaudeSessionReader } from "./reader.js";
import type { ISessionReader } from "./types.js";

type ProviderGroup = string;

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

export interface ProviderResolutionDeps {
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

export interface SessionSource {
  provider: ProviderName;
  reader: ISessionReader;
  sessionDir: string;
  kind: string;
}

export interface ResolvedSessionSummary {
  source: SessionSource;
  summary: SessionSummary;
}

function normalizeProviderGroup(
  provider: ProviderName | string | undefined,
): ProviderGroup | null {
  if (!provider) return null;
  const descriptor = providerRegistry.getOrNull(provider);
  return (descriptor?.group as ProviderGroup) ?? null;
}

function mayHaveCodexSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.codexPaths.has(canonicalizeProjectPath(project.path));
  }
  return normalizeProviderGroup(project.provider) === "claude";
}

function mayHaveGeminiSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.geminiPaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return provider === "claude" || provider === "codex";
}

function buildCandidateGroups(
  project: Project,
  preferredProvider: ProviderName | string | undefined,
  catalog?: ProviderProjectCatalog,
): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const pushGroup = (group: ProviderGroup | null) => {
    if (!group || groups.includes(group)) return;
    groups.push(group);
  };

  const preferredGroup = normalizeProviderGroup(preferredProvider);
  const projectGroup = normalizeProviderGroup(project.provider);

  pushGroup(preferredGroup);
  pushGroup(projectGroup);

  if (mayHaveCodexSessions(project, catalog)) {
    pushGroup("codex");
  }
  if (mayHaveGeminiSessions(project, catalog)) {
    pushGroup("gemini");
  }

  return groups;
}

function getSourceForGroup(
  project: Project,
  deps: ProviderResolutionDeps,
  group: ProviderGroup,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  const descriptor = providerRegistry.getByGroup(group);
  if (!descriptor) return null;

  const isPrimary = normalizeProviderGroup(project.provider) === group;

  if (isPrimary) {
    return {
      provider: project.provider,
      reader: deps.readerFactory(project),
      sessionDir: project.sessionDir,
      kind: "primary",
    };
  }

  // Extra sources: prefer test-injected factories for known providers, then fallback to descriptor
  if (group === "codex") {
    const reader =
      deps.codexReaderFactory?.(project.path) ??
      descriptor.createExtraReader(project.path);
    if (!reader) return null;
    return {
      provider: "codex",
      reader,
      sessionDir: deps.codexSessionsDir ?? descriptor.getSessionDir(),
      kind: group,
    };
  }

  if (group === "gemini") {
    const reader =
      deps.geminiReaderFactory?.(project.path) ??
      descriptor.createExtraReader(project.path);
    if (!reader) return null;
    return {
      provider: "gemini",
      reader,
      sessionDir: deps.geminiSessionsDir ?? descriptor.getSessionDir(),
      kind: group,
    };
  }

  // Generic extra source for any other provider
  const reader = descriptor.createExtraReader(project.path);
  if (!reader) return null;
  return {
    provider: (descriptor.names[0] ?? group) as ProviderName,
    reader,
    sessionDir: descriptor.getSessionDir(),
    kind: group,
  };
}

function getSessionSources(
  project: Project,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
): SessionSource[] {
  const sources: SessionSource[] = [];
  for (const group of buildCandidateGroups(
    project,
    preferredProvider,
    catalog,
  )) {
    const source = getSourceForGroup(project, deps, group, catalog);
    if (!source) continue;
    if (
      sources.some(
        (existing) =>
          existing.kind === source.kind &&
          existing.sessionDir === source.sessionDir,
      )
    ) {
      continue;
    }
    sources.push(source);
  }
  return sources;
}

async function listSessionsForSource(
  project: Project,
  source: SessionSource,
  deps: ProviderResolutionDeps,
): Promise<SessionSummary[]> {
  if (!deps.sessionIndexService) {
    return source.reader.listSessions(project.id);
  }

  let sessions = await deps.sessionIndexService.getSessionsWithCache(
    source.sessionDir,
    project.id,
    source.reader,
  );

  if (
    source.kind === "primary" &&
    project.mergedSessionDirs &&
    project.mergedSessionDirs.length > 0
  ) {
    for (const dir of project.mergedSessionDirs) {
      const mergedReader = new ClaudeSessionReader({ sessionDir: dir });
      const merged = await deps.sessionIndexService.getSessionsWithCache(
        dir,
        project.id,
        mergedReader,
      );
      sessions = [...sessions, ...merged];
    }
  }

  return sessions;
}

export async function listSessionsAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionsForSource(project, source, deps);
    for (const session of sourceSessions) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  return sessions;
}

export async function findSessionSummaryAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
): Promise<ResolvedSessionSummary | null> {
  for (const source of getSessionSources(project, deps, preferredProvider)) {
    const summary = await source.reader.getSessionSummary(sessionId, projectId);
    if (summary) {
      return { source, summary };
    }
  }

  return null;
}
