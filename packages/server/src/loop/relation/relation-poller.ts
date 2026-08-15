import type { GitHubCheckRun, GitHubClient } from "../../github/index.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";
import { RelationLifecycleService } from "./lifecycle-service.js";
import type { RelationRecord, RelationStore } from "./relation-store.js";

export interface RelationPollerDeps {
  relationStore: RelationStore;
  /** Optional in tests; production wires the single lifecycle service. */
  relationLifecycle?: RelationLifecycleService;
  githubClient: GitHubClient;
  triggerQueueStore: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
]);

function hasFailedCheckRuns(checkRuns: GitHubCheckRun[]): boolean {
  return checkRuns.some(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== null &&
      FAILED_CHECK_CONCLUSIONS.has(run.conclusion),
  );
}

export class RelationPoller {
  private readonly deps: RelationPollerDeps;
  private readonly lifecycle: RelationLifecycleService;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: RelationPollerDeps) {
    this.deps = deps;
    this.lifecycle =
      deps.relationLifecycle ??
      new RelationLifecycleService({ relationStore: deps.relationStore });
  }

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        console.error("[RelationPoller] poll failed:", error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<number> {
    let events = 0;
    for (const relation of this.deps.relationStore.list()) {
      if (
        relation.subject.type !== "github_pr" ||
        !relation.subject.pr_number ||
        relation.state === "merged"
      ) {
        continue;
      }
      const { repository, pr_number: prNumber } = relation.subject;
      const pull = await this.deps.githubClient.getPullRequest(
        repository,
        prNumber,
      );
      if (pull.state === "closed" || pull.merged) {
        const terminalState = pull.merged ? "merged" : "closed";
        await this.lifecycle.transition(
          relation.relation_id,
          terminalState,
          {},
          {
            event: terminalState,
            message: `GitHub PR ${repository}#${prNumber} ${pull.merged ? "merged" : "closed"}`,
          },
        );
        continue;
      }
      if (relation.state === "closed") {
        await this.lifecycle.transition(
          relation.relation_id,
          "awaiting_feedback",
          {},
          {
            event: "reopened",
            message: `GitHub PR ${repository}#${prNumber} was reopened`,
          },
        );
        continue;
      }
      if (
        relation.state === "needs_human" ||
        relation.state === "pr_pending_approval"
      ) {
        continue;
      }
      if (relation.state === "awaiting_review") {
        if (!pull.draft) {
          await this.lifecycle.transition(
            relation.relation_id,
            "awaiting_feedback",
            {},
            {
              event: "ready_for_review",
              message: `GitHub PR ${repository}#${prNumber} is no longer a draft`,
            },
          );
        }
        continue;
      }
      if (relation.state !== "awaiting_feedback") {
        continue;
      }
      const comments = await this.deps.githubClient.listPullRequestComments(
        repository,
        prNumber,
      );
      const issueComments = await this.deps.githubClient.listIssueComments(
        repository,
        prNumber,
      );
      const reviews = await this.deps.githubClient.listPullRequestReviews(
        repository,
        prNumber,
      );
      const checkRuns = await this.deps.githubClient.getCheckRuns(
        repository,
        pull.head_sha,
      );
      const newestCommentId = comments.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      const newestIssueCommentId = issueComments.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      const newestReviewId = reviews.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      const lastProcessed = relation.last_processed;
      const cursor: RelationRecord["last_processed"] = {
        ...lastProcessed,
      };
      const signals: string[] = [];
      if (lastProcessed.commit_sha !== pull.head_sha) {
        cursor.commit_sha = pull.head_sha;
        if (lastProcessed.commit_sha) {
          signals.push("head_moved");
        }
      }
      const hasFailure = hasFailedCheckRuns(checkRuns);
      if (hasFailure) {
        if (lastProcessed.ci_failure_sha !== pull.head_sha) {
          cursor.ci_failure_sha = pull.head_sha;
          signals.push("ci_failure");
        }
      } else if (lastProcessed.ci_failure_sha) {
        cursor.ci_failure_sha = undefined;
      }
      const hasNewComment = newestCommentId > (lastProcessed.comment_id ?? 0);
      const hasNewIssueComment =
        newestIssueCommentId > (lastProcessed.issue_comment_id ?? 0);
      const hasNewReview = newestReviewId > (lastProcessed.review_id ?? 0);
      if (hasNewComment) {
        cursor.comment_id = newestCommentId;
        signals.push("pull_request_review_comment");
      }
      if (hasNewIssueComment) {
        cursor.issue_comment_id = newestIssueCommentId;
        signals.push("issue_comment");
      }
      if (hasNewReview) {
        cursor.review_id = newestReviewId;
        signals.push("pull_request_review");
      }
      if (signals.length === 0) {
        if (
          cursor.commit_sha !== lastProcessed.commit_sha ||
          cursor.ci_failure_sha !== lastProcessed.ci_failure_sha
        ) {
          await this.lifecycle.transition(
            relation.relation_id,
            relation.state,
            {
              last_processed: cursor,
            },
            lastProcessed.ci_failure_sha && !hasFailure
              ? {
                  event: "checks_recovered",
                  message: `GitHub PR ${repository}#${prNumber} checks recovered on ${pull.head_sha}`,
                }
              : undefined,
          );
        }
        continue;
      }
      const newestId = Math.max(
        newestCommentId,
        newestIssueCommentId,
        newestReviewId,
      );
      const primaryEventType = signals.includes("head_moved")
        ? "head_moved"
        : signals.includes("ci_failure")
          ? "ci_failure"
          : (signals[0] ?? "issue_comment");
      const eventSuffix =
        primaryEventType === "head_moved"
          ? `head-${pull.head_sha}`
          : primaryEventType === "ci_failure"
            ? `ci-${pull.head_sha}`
            : String(newestId);
      const eventId = `github-poll-${relation.relation_id}-${eventSuffix}`;
      const feedback = await this.lifecycle.receiveFeedback(
        relation.relation_id,
        {
          eventType: primaryEventType,
          cursor,
          log: {
            event: primaryEventType,
            message: `GitHub poll woke maintenance for ${repository}#${prNumber} (${signals.join(", ")})`,
          },
        },
      );
      if (feedback.repairLimitReached || !feedback.relation) {
        continue;
      }
      await this.deps.triggerQueueStore.enqueue({
        event_id: eventId,
        loop_id: relation.loop_id,
        source: "issue",
        priority: "normal",
        payload: {
          relation_id: relation.relation_id,
          maintenance_id: relation.relation_id,
          event_type: primaryEventType,
          event_types: signals,
          repository,
          pr_number: prNumber,
          head_sha: pull.head_sha,
          polled_at: new Date().toISOString(),
        },
      });
      events += 1;
      await this.deps.drainPendingTriggers?.(relation.loop_id);
    }
    return events;
  }
}
