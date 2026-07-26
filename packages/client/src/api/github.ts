import { fetchJSON } from "./client";
import type { LoopRunSummary } from "./loops";

export interface GitHubCredentialStatus {
  configured: boolean;
  tokenPreview: string | null;
  updatedAt: string | null;
}

export interface GitHubToolStatus {
  installed: boolean;
  path: string;
  version: string;
}

export interface GitHubIssueCandidate {
  repository: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface GitHubIssueLoopRun {
  issue: GitHubIssueCandidate;
  loopId: string;
  workspacePath: string;
  branch: string;
  run: LoopRunSummary;
}

export const githubApi = {
  getCredentialStatus: () =>
    fetchJSON<{ credential: GitHubCredentialStatus }>("/github/credentials"),

  setCredential: (token: string) =>
    fetchJSON<{ credential: GitHubCredentialStatus }>("/github/credentials", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  clearCredential: () =>
    fetchJSON<{ credential: GitHubCredentialStatus }>("/github/credentials", {
      method: "DELETE",
    }),

  ensureGh: () =>
    fetchJSON<{ tool: GitHubToolStatus }>("/github/tools/gh/ensure", {
      method: "POST",
    }),

  searchIssues: (query: string, limit = 5) => {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    });
    return fetchJSON<{ issues: GitHubIssueCandidate[] }>(
      `/github/issues/search?${params.toString()}`,
    );
  },

  startIssueLoop: (query: string) =>
    fetchJSON<GitHubIssueLoopRun>("/github/issue-loops/start", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),
};
