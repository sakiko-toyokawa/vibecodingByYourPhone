import type { GitHubClient } from "../../github/index.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";
import type { RelationStore } from "./relation-store.js";

export interface RelationPollerDeps {
  relationStore: RelationStore;
  githubClient: GitHubClient;
  triggerQueueStore: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

export class RelationPoller {
  private readonly deps: RelationPollerDeps;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: RelationPollerDeps) {
    this.deps = deps;
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
        relation.state === "merged" ||
        relation.state === "closed" ||
        relation.state === "needs_human"
      ) {
        continue;
      }
      const { repository, pr_number: prNumber } = relation.subject;
      const pull = await this.deps.githubClient.getPullRequest(
        repository,
        prNumber,
      );
      if (pull.state === "closed" || pull.merged) {
        await this.deps.relationStore.updateState(
          relation.relation_id,
          pull.merged ? "merged" : "closed",
        );
        continue;
      }
      const comments = await this.deps.githubClient.listPullRequestComments(
        repository,
        prNumber,
      );
      const reviews = await this.deps.githubClient.listPullRequestReviews(
        repository,
        prNumber,
      );
      const newestCommentId = comments.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      const newestReviewId = reviews.reduce(
        (max, item) => Math.max(max, item.id),
        0,
      );
      const hasNewComment =
        newestCommentId > (relation.last_processed.comment_id ?? 0);
      const hasNewReview =
        newestReviewId > (relation.last_processed.review_id ?? 0);
      if (!hasNewComment && !hasNewReview) {
        continue;
      }
      const newestId = Math.max(newestCommentId, newestReviewId);
      const nextRepairCount = relation.repair_count + 1;
      if (nextRepairCount > 3) {
        await this.deps.relationStore.updateState(
          relation.relation_id,
          "needs_human",
          {
            needs_human_reason:
              "repeated relation feedback exceeded auto-repair limit",
          },
        );
        continue;
      }
      await this.deps.relationStore.updateState(
        relation.relation_id,
        "fixing",
        {
          last_processed: {
            ...relation.last_processed,
            ...(newestCommentId ? { comment_id: newestCommentId } : {}),
            ...(newestReviewId ? { review_id: newestReviewId } : {}),
          },
          repair_count: nextRepairCount,
        },
      );
      const eventId = `github-poll-${relation.relation_id}-${newestId}`;
      await this.deps.triggerQueueStore.enqueue({
        event_id: eventId,
        loop_id: relation.loop_id,
        source: "issue",
        priority: "normal",
        payload: {
          relation_id: relation.relation_id,
          event_type: hasNewReview ? "pull_request_review" : "issue_comment",
          repository,
          pr_number: prNumber,
          polled_at: new Date().toISOString(),
        },
      });
      events += 1;
      await this.deps.drainPendingTriggers?.(relation.loop_id);
    }
    return events;
  }
}
