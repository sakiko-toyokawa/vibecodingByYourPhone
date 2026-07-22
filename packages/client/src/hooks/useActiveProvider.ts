import { useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { ProviderName } from "../types";
import { useProject } from "./useProjects";

/**
 * Infer the active AI provider from the current route.
 *
 * Rules:
 * - /projects/:projectId/* → use that project's provider
 * - /sessions?project=xxx → use query param project's provider
 * - All other routes → null (default Yep Anywhere brand)
 */
export function useActiveProvider(): ProviderName | null {
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const location = useLocation();

  // Also check query params for project selection (e.g., /sessions?project=xxx)
  const queryProjectId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("project") ?? undefined;
  }, [location.search]);

  const effectiveProjectId = routeProjectId ?? queryProjectId;
  const { project, loading, error } = useProject(effectiveProjectId);

  return useMemo(() => {
    // Debug: log provider detection state
    if (effectiveProjectId) {
      console.debug(
        "[useActiveProvider] projectId:",
        effectiveProjectId,
        "provider:",
        project?.provider,
        "loading:",
        loading,
        "error:",
        error,
      );
    }
    if (project?.provider) {
      return project.provider;
    }
    return null;
  }, [project?.provider, effectiveProjectId, loading, error]);
}
