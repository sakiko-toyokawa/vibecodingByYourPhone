import { useMemo } from "react";
import { useParams } from "react-router-dom";
import type { ProviderName } from "../types";
import { useProject } from "./useProjects";

/**
 * Infer the active AI provider from the current route.
 *
 * Rules:
 * - /projects/:projectId/* → use that project's provider
 * - All other routes → null (default Yep Anywhere brand)
 */
export function useActiveProvider(): ProviderName | null {
  const { projectId } = useParams<{ projectId?: string }>();
  const { project } = useProject(projectId);

  return useMemo(() => {
    if (project?.provider) {
      return project.provider;
    }
    return null;
  }, [project?.provider]);
}
