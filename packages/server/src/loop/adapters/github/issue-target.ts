import type { RelationRecord } from "../../relation/relation-store.js";
import type {
  TargetAdapter,
  TargetPollContext,
} from "../../targets/registry.js";
import { isExternalFeedbackAuthor } from "./feedback-filter.js";
import { handleGithubWebhookRelation } from "./webhook.js";

export function createGithubIssueTarget(): TargetAdapter {
  return {
    targetType: "github_issue",
    async poll(
      relation: RelationRecord,
      ctx: TargetPollContext,
    ): Promise<number> {
      const subject = relation.subject;
      if (
        subject.type !== "github_issue" ||
        !subject.issue_number ||
        !ctx.githubClient
      )
        return 0;
      const { repository, issue_number: issueNumber } = subject;
      const issue = await ctx.githubClient.getIssueState(
        repository,
        issueNumber,
      );
      if (issue.state === "closed") {
        if (relation.state !== "closed")
          await ctx.lifecycle.transition(
            relation.relation_id,
            "closed",
            {},
            {
              event: "closed",
              message: `GitHub issue ${repository}#${issueNumber} closed`,
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
            message: `GitHub issue ${repository}#${issueNumber} was reopened`,
          },
        );
        return 0;
      }
      if (relation.state !== "awaiting_feedback") return 0;
      const comments = (
        await ctx.githubClient.listIssueComments(repository, issueNumber)
      ).filter((item) =>
        isExternalFeedbackAuthor(item.user, ctx.selfLogin ?? null),
      );
      const newestId = comments.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      if (newestId <= (relation.last_processed.issue_comment_id ?? 0)) return 0;
      const feedback = await ctx.lifecycle.receiveFeedback(
        relation.relation_id,
        {
          eventType: "issue_comment",
          cursor: { ...relation.last_processed, issue_comment_id: newestId },
          log: {
            event: "issue_comment",
            message: `GitHub poll woke maintenance for ${repository}#${issueNumber} (issue_comment)`,
          },
        },
      );
      if (feedback.repairLimitReached || !feedback.relation) return 0;
      await ctx.triggerQueueStore.enqueue({
        event_id: `github-poll-${relation.relation_id}-issue-${newestId}`,
        loop_id: relation.loop_id,
        source: "issue",
        priority: "normal",
        payload: {
          relation_id: relation.relation_id,
          maintenance_id: relation.relation_id,
          event_type: "issue_comment",
          event_types: ["issue_comment"],
          repository,
          issue_number: issueNumber,
          polled_at: new Date().toISOString(),
        },
      });
      await ctx.drainPendingTriggers?.(relation.loop_id);
      return 1;
    },
    handleWebhook: handleGithubWebhookRelation,
    toTargetState: (state) => (state === "closed" ? "done" : (state as never)),
    fromTargetState: (state, fallback) =>
      state === "done" ? (fallback === "merged" ? "merged" : "closed") : state,
  };
}
