import type { RelationRecord } from "../../relation/relation-store.js";
import type {
  TargetAdapter,
  TargetPollContext,
} from "../../targets/registry.js";
import { isExternalFeedbackAuthor } from "./feedback-filter.js";
import { handleGithubWebhookRelation } from "./webhook.js";

const FAILED = new Set(["failure", "timed_out", "action_required"]);

export function createGithubPrTarget(): TargetAdapter {
  return {
    targetType: "github_pr",
    async poll(
      relation: RelationRecord,
      ctx: TargetPollContext,
    ): Promise<number> {
      const subject = relation.subject;
      const client = ctx.githubClient;
      if (subject.type !== "github_pr" || !subject.pr_number || !client)
        return 0;
      const { repository, pr_number: prNumber } = subject;
      const pull = await client.getPullRequest(repository, prNumber);
      if (pull.state === "closed" || pull.merged) {
        const state = pull.merged ? "merged" : "closed";
        if (relation.state !== state)
          await ctx.lifecycle.transition(
            relation.relation_id,
            state,
            {},
            {
              event: state,
              message: `GitHub PR ${repository}#${prNumber} ${pull.merged ? "merged" : "closed"}`,
            },
          );
        return 0;
      }
      if (
        relation.state === "closed" &&
        relation.state_logs?.at(-1)?.event !== "dismissed"
      ) {
        await ctx.lifecycle.transition(
          relation.relation_id,
          "awaiting_feedback",
          {},
          {
            event: "reopened",
            message: `GitHub PR ${repository}#${prNumber} was reopened`,
          },
        );
        return 0;
      }
      if (
        relation.state === "needs_human" ||
        relation.state === "pr_pending_approval"
      )
        return 0;
      if (relation.state === "awaiting_review") {
        if (!pull.draft)
          await ctx.lifecycle.transition(
            relation.relation_id,
            "awaiting_feedback",
            {},
            {
              event: "ready_for_review",
              message: `GitHub PR ${repository}#${prNumber} is no longer a draft`,
            },
          );
        return 0;
      }
      if (relation.state !== "awaiting_feedback") return 0;
      const self = ctx.selfLogin ?? null;
      const comments = (
        await client.listPullRequestComments(repository, prNumber)
      ).filter((item) => isExternalFeedbackAuthor(item.user, self));
      const issueComments = (
        await client.listIssueComments(repository, prNumber)
      ).filter((item) => isExternalFeedbackAuthor(item.user, self));
      const reviews = (
        await client.listPullRequestReviews(repository, prNumber)
      ).filter((item) => isExternalFeedbackAuthor(item.user, self));
      const checks = await client.getCheckRuns(repository, pull.head_sha);
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
      const previous = relation.last_processed;
      const cursor = { ...previous };
      const signals: string[] = [];
      if (previous.commit_sha !== pull.head_sha) {
        cursor.commit_sha = pull.head_sha;
        if (previous.commit_sha) signals.push("head_moved");
      }
      const failed = checks.some(
        (run) =>
          run.status === "completed" &&
          run.conclusion !== null &&
          FAILED.has(run.conclusion),
      );
      if (failed) {
        if (previous.ci_failure_sha !== pull.head_sha) {
          cursor.ci_failure_sha = pull.head_sha;
          signals.push("ci_failure");
        }
      } else if (previous.ci_failure_sha) cursor.ci_failure_sha = undefined;
      if (newestCommentId > (previous.comment_id ?? 0)) {
        cursor.comment_id = newestCommentId;
        signals.push("pull_request_review_comment");
      }
      if (newestIssueCommentId > (previous.issue_comment_id ?? 0)) {
        cursor.issue_comment_id = newestIssueCommentId;
        signals.push("issue_comment");
      }
      if (newestReviewId > (previous.review_id ?? 0)) {
        cursor.review_id = newestReviewId;
        signals.push("pull_request_review");
      }
      if (signals.length === 0) {
        if (
          cursor.commit_sha !== previous.commit_sha ||
          cursor.ci_failure_sha !== previous.ci_failure_sha
        )
          await ctx.lifecycle.transition(
            relation.relation_id,
            relation.state,
            { last_processed: cursor },
            previous.ci_failure_sha && !failed
              ? {
                  event: "checks_recovered",
                  message: `GitHub PR ${repository}#${prNumber} checks recovered on ${pull.head_sha}`,
                }
              : undefined,
          );
        return 0;
      }
      const primary = signals.includes("head_moved")
        ? "head_moved"
        : signals.includes("ci_failure")
          ? "ci_failure"
          : (signals[0] ?? "issue_comment");
      const suffix =
        primary === "head_moved"
          ? `head-${pull.head_sha}`
          : primary === "ci_failure"
            ? `ci-${pull.head_sha}`
            : String(
                Math.max(newestCommentId, newestIssueCommentId, newestReviewId),
              );
      const feedback = await ctx.lifecycle.receiveFeedback(
        relation.relation_id,
        {
          eventType: primary,
          cursor,
          log: {
            event: primary,
            message: `GitHub poll woke maintenance for ${repository}#${prNumber} (${signals.join(", ")})`,
          },
        },
      );
      if (feedback.repairLimitReached || !feedback.relation) return 0;
      await ctx.triggerQueueStore.enqueue({
        event_id: `github-poll-${relation.relation_id}-${suffix}`,
        loop_id: relation.loop_id,
        source: "issue",
        priority: "normal",
        payload: {
          relation_id: relation.relation_id,
          maintenance_id: relation.relation_id,
          event_type: primary,
          event_types: signals,
          repository,
          pr_number: prNumber,
          head_sha: pull.head_sha,
          polled_at: new Date().toISOString(),
        },
      });
      await ctx.drainPendingTriggers?.(relation.loop_id);
      return 1;
    },
    handleWebhook: handleGithubWebhookRelation,
    toTargetState: (state) =>
      state === "merged" || state === "closed" ? "done" : (state as never),
    fromTargetState: (state, fallback) =>
      state === "done" ? (fallback === "merged" ? "merged" : "closed") : state,
  };
}
