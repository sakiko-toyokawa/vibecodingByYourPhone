import { useCallback, useEffect, useState } from "react";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";

interface ProjectLike {
  id: string;
}

/**
 * Get the most recently visited project ID from localStorage.
 * Returns null if none has been set.
 */
export function getRecentProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return getServerScoped("recentProject", LEGACY_KEYS.recentProject);
}

/**
 * Set the most recently visited project ID in localStorage.
 */
export function setRecentProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  setServerScoped("recentProject", projectId, LEGACY_KEYS.recentProject);
}

/**
 * Resolve the best available project ID for starting a new session.
 *
 * Prefers the recent project stored in localStorage when it still exists in the
 * current project list, then an optional caller-provided fallback, then the
 * first available project.
 */
export function resolvePreferredProjectId<T extends ProjectLike>(
  projects: readonly T[],
  fallbackProjectId?: string | null,
): string | null {
  const recentProjectId = getRecentProjectId();
  if (
    recentProjectId &&
    projects.some((project) => project.id === recentProjectId)
  ) {
    return recentProjectId;
  }

  if (
    fallbackProjectId &&
    projects.some((project) => project.id === fallbackProjectId)
  ) {
    return fallbackProjectId;
  }

  return projects[0]?.id ?? null;
}

/**
 * Hook that tracks the most recently visited project.
 * - Returns the current recent project ID
 * - Provides a setter to update it (call when navigating to a project)
 * - Uses localStorage (persists across tabs and browser sessions)
 */
export function useRecentProject(): [
  string | null,
  (projectId: string) => void,
] {
  const [recentProjectId, setRecentProjectIdState] = useState<string | null>(
    () => getRecentProjectId(),
  );

  const setRecentProject = useCallback((projectId: string) => {
    setRecentProjectId(projectId);
    setRecentProjectIdState(projectId);
  }, []);

  // Sync with sessionStorage on mount (in case another component updated it)
  useEffect(() => {
    setRecentProjectIdState(getRecentProjectId());
  }, []);

  return [recentProjectId, setRecentProject];
}
