import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { type GitHubRelation, githubApi } from "../api/github";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { humanizeRelationState } from "../lib/loopHumanText";

interface GitHubRelationCardProps {
  relation: GitHubRelation;
  onChanged?: () => void | Promise<void>;
  showLoop?: boolean;
}

/**
 * Relation card shared by the GitHub page and loop detail page.
 * Pending PRs expose the human approval actions from the PR approval plan.
 */
export function GitHubRelationCard({
  relation,
  onChanged,
  showLoop = false,
}: GitHubRelationCardProps) {
  const basePath = useRemoteBasePath();
  const [busy, setBusy] = useState<
    "approve" | "ready" | "retry" | "close" | "publish-issue" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = useCallback(
    async (
      action: "approve" | "ready" | "retry" | "close" | "publish-issue",
    ) => {
      setError(null);
      setBusy(action);
      try {
        if (action === "approve") {
          await githubApi.approvePr(relation.relation_id);
        } else if (action === "ready") {
          await githubApi.markReady(relation.relation_id);
        } else if (action === "publish-issue") {
          await githubApi.approveIssue(relation.relation_id);
        } else {
          await githubApi.resolveRelation(relation.relation_id, action);
        }
        await onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [onChanged, relation.relation_id],
  );

  const subject = relation.subject;
  const prUrl =
    subject.type === "github_pr" && subject.pr_number
      ? `https://github.com/${subject.repository}/pull/${subject.pr_number}`
      : null;
  const issueUrl =
    subject.type === "github_issue" && subject.issue_number
      ? `https://github.com/${subject.repository}/issues/${subject.issue_number}`
      : null;
  const subjectLabel =
    subject.type === "github_pr"
      ? `${subject.repository}#${subject.pr_number ?? "pending"}`
      : `${subject.repository}${subject.issue_number ? `#${subject.issue_number}` : " · issue proposal"}`;
  const externalUrl = prUrl ?? issueUrl;

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
          {subjectLabel}
        </span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
          {humanizeRelationState(relation.state)}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          feedback {relation.feedback_count} · repair {relation.repair_count}
        </span>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)]"
          >
            {prUrl ? "Open PR" : "Open issue"}
          </a>
        )}
      </div>

      {relation.pending_publish && (
        <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-3">
          <div className="break-words text-sm font-semibold text-[var(--text-primary)]">
            {relation.pending_publish.title}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">
            {relation.pending_publish.repository} ·{" "}
            {relation.pending_publish.branch}
          </div>
          {relation.pending_publish.author_name &&
            relation.pending_publish.author_email && (
              <div className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">
                {relation.pending_publish.author_name} &lt;
                {relation.pending_publish.author_email}&gt;
                {relation.pending_publish.identity_source
                  ? ` · ${relation.pending_publish.identity_source}`
                  : ""}
              </div>
            )}
          <pre className="m-0 mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
            {relation.pending_publish.body}
          </pre>
        </div>
      )}

      {relation.pending_issue && (
        <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-3">
          <div className="break-words text-sm font-semibold text-[var(--text-primary)]">
            {relation.pending_issue.title}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">
            {relation.pending_issue.repository} · issue proposal
          </div>
          <pre className="m-0 mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
            {relation.pending_issue.body}
          </pre>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-[var(--text-dimmed)]">
          {relation.relation_id}
          {showLoop && (
            <>
              {" · "}
              <Link
                to={`${basePath}/loops/${encodeURIComponent(relation.loop_id)}`}
                className="text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
              >
                {relation.loop_id}
              </Link>
            </>
          )}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {relation.state === "pr_pending_approval" &&
            relation.pending_issue && (
              <button
                type="button"
                className="rounded-md border border-[var(--primary)] bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void runAction("publish-issue")}
              >
                {busy === "publish-issue"
                  ? "Publishing..."
                  : "Approve & Publish Issue"}
              </button>
            )}
          {relation.state === "pr_pending_approval" &&
            relation.pending_publish && (
              <button
                type="button"
                className="rounded-md border border-[var(--primary)] bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void runAction("approve")}
              >
                {busy === "approve"
                  ? "Publishing..."
                  : "Approve & Publish Draft PR"}
              </button>
            )}
          {relation.state === "awaiting_review" && (
            <button
              type="button"
              className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void runAction("ready")}
            >
              {busy === "ready" ? "Marking ready..." : "Mark Ready for Review"}
            </button>
          )}
          {relation.state === "needs_human" && (
            <>
              <button
                type="button"
                className="rounded-md border border-[var(--primary)] bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void runAction("retry")}
              >
                {busy === "retry" ? "Resuming..." : "Retry (reset repairs)"}
              </button>
              <button
                type="button"
                className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void runAction("close")}
              >
                {busy === "close" ? "Closing..." : "Stop tracking"}
              </button>
            </>
          )}
        </span>
      </div>

      {relation.state === "needs_human" && (
        <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-muted)]">
          <div className="break-words">
            {relation.needs_human_reason ?? "Human review required."}
          </div>
          <div className="mt-1">
            If a run is waiting for a decision, handle it in{" "}
            <Link
              to={`${basePath}/loops/${encodeURIComponent(relation.loop_id)}`}
              className="text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
            >
              the loop detail page
            </Link>
            ; use Retry to reset the repair budget, or Stop tracking to drop
            this relation.
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-2 text-xs text-[var(--error-color)]">
          {error}
        </p>
      )}
    </div>
  );
}
