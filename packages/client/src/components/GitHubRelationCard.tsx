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
  const [busy, setBusy] = useState<"approve" | "ready" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = useCallback(
    async (action: "approve" | "ready") => {
      setError(null);
      setBusy(action);
      try {
        if (action === "approve") {
          await githubApi.approvePr(relation.relation_id);
        } else {
          await githubApi.markReady(relation.relation_id);
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

  const prUrl = relation.subject.pr_number
    ? `https://github.com/${relation.subject.repository}/pull/${relation.subject.pr_number}`
    : null;

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
          {relation.subject.repository}#
          {relation.subject.pr_number ?? "pending"}
        </span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
          {humanizeRelationState(relation.state)}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          feedback {relation.feedback_count} · repair {relation.repair_count}
        </span>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)]"
          >
            Open PR
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
          {relation.state === "pr_pending_approval" && (
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
        </span>
      </div>

      {error && (
        <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-2 text-xs text-[var(--error-color)]">
          {error}
        </p>
      )}
    </div>
  );
}
