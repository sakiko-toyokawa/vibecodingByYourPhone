import { fetchJSON } from "./client";

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

export type GitHubRelationState =
  | "pr_pending_approval"
  | "awaiting_feedback"
  | "awaiting_review"
  | "fixing"
  | "merged"
  | "closed"
  | "needs_human";

export interface GitHubPrSubject {
  type: "github_pr";
  repository: string;
  issue_number?: number;
  pr_number?: number;
  branch: string;
  fork_owner?: string;
  base_sha?: string;
}

export interface GitHubIssueSubject {
  type: "github_issue";
  repository: string;
  issue_number?: number;
}

export type GitHubRelationSubject = GitHubPrSubject | GitHubIssueSubject;

export interface GitHubRelation {
  relation_id: string;
  loop_id: string;
  subject: GitHubRelationSubject;
  state: GitHubRelationState;
  last_processed: {
    comment_id?: number;
    review_id?: number;
    commit_sha?: string;
  };
  feedback_count: number;
  repair_count: number;
  pending_publish?: {
    repository: string;
    branch: string;
    title: string;
    body: string;
    cwd: string;
    author_name?: string;
    author_email?: string;
    identity_source?: string;
    run_id?: string;
    created_at?: string;
  };
  pending_issue?: {
    repository: string;
    title: string;
    body: string;
    run_id?: string;
    created_at?: string;
  };
  needs_human_reason?: string;
  created_at: string;
  updated_at: string;
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

  listRelations: (loopId?: string) => {
    const params = loopId ? `?loop_id=${encodeURIComponent(loopId)}` : "";
    return fetchJSON<{ relations: GitHubRelation[] }>(
      `/github/relations${params}`,
    );
  },

  getRelation: (relationId: string) =>
    fetchJSON<{ relation: GitHubRelation }>(
      `/github/relations/${encodeURIComponent(relationId)}`,
    ),

  approvePr: (relationId: string) =>
    fetchJSON<{ relation: GitHubRelation; prUrl: string }>(
      `/github/relations/${encodeURIComponent(relationId)}/approve-pr`,
      { method: "POST" },
    ),

  /** 人工批准并发布 ISSUE-PROPOSAL 提案（publish_mode="issue" 的 loop 产出）。 */
  approveIssue: (relationId: string) =>
    fetchJSON<{ relation: GitHubRelation; issueUrl: string }>(
      `/github/relations/${encodeURIComponent(relationId)}/approve-issue`,
      { method: "POST" },
    ),

  markReady: (relationId: string) =>
    fetchJSON<{ relation: GitHubRelation }>(
      `/github/relations/${encodeURIComponent(relationId)}/mark-ready`,
      { method: "POST" },
    ),

  /** needs_human relation 的人工出口：retry 重置修复预算，close 停止跟踪。 */
  resolveRelation: (
    relationId: string,
    action: "retry" | "close",
    note?: string,
  ) =>
    fetchJSON<{ relation: GitHubRelation }>(
      `/github/relations/${encodeURIComponent(relationId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      },
    ),
};
