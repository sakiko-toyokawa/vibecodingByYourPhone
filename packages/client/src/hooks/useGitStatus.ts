import type { GitStatusInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 5000;

export function useGitStatus(projectId: string | undefined) {
  const [gitStatus, setGitStatus] = useState<GitStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const projectIdRef = useRef(projectId);

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getGitStatus(projectId);
      setGitStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Reset on projectId change + initial fetch
  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      setLoading(true);
      setGitStatus(null);
      setError(null);
      projectIdRef.current = projectId;
    }
    fetchStatus();
  }, [fetchStatus, projectId]);

  // Poll while visible
  useEffect(() => {
    if (!projectId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchStatus, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchStatus();
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [projectId, fetchStatus]);

  return { gitStatus, loading, error, refetch: fetchStatus };
}
