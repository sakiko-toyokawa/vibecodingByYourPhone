import type { RelationRecord } from "../../relation/relation-store.js";
import type { TargetWebhookContext } from "../../targets/registry.js";
import { isExternalFeedbackAuthor } from "./feedback-filter.js";

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function handleGithubWebhookRelation(
  relation: RelationRecord,
  payload: Record<string, unknown>,
  ctx: TargetWebhookContext,
): Promise<Record<string, unknown>> {
  const eventType = ctx.eventType ?? "unknown";
  const action = ctx.action ?? "";
  const repository = ctx.repository ?? "";
  const number = ctx.subjectNumber ?? 0;
  const transition = (
    state: RelationRecord["state"],
    event: string,
    message: string,
  ) =>
    ctx.lifecycle.transition(
      relation.relation_id,
      state,
      {},
      { event, message },
    );
  const comment = ctx.comment;
  const review = ctx.review;
  const sender = ctx.sender;

  // review 的 dismissed/approved 不是维护反馈，直接短路——否则维护者每点
  // 一次 Approve 都会白扣 repair 额度并触发无效修复 run（触发层任务书
  // 修过的 bug 类，2026-08-14）。
  if (eventType === "pull_request_review" && action === "dismissed") {
    await transition(
      relation.state,
      "review_dismissed",
      `GitHub review dismissed on ${repository}#${number}`,
    );
    return { accepted: false, reason: "review_dismissed" };
  }
  if (eventType === "pull_request_review" && review?.state === "approved") {
    await transition(
      relation.state,
      "review_approved",
      `GitHub review approved on ${repository}#${number}`,
    );
    return { accepted: false, reason: "review_approved" };
  }
  if (eventType === "pull_request" && action === "closed") {
    const merged = ctx.pullRequest?.merged === true;
    const state = merged ? "merged" : "closed";
    await transition(
      state,
      state,
      `GitHub webhook observed PR ${repository}#${number} ${state}`,
    );
    return { accepted: false, reason: state };
  }
  if (
    eventType === "pull_request" &&
    action === "reopened" &&
    relation.state === "closed"
  ) {
    await transition(
      "awaiting_feedback",
      "reopened",
      `GitHub webhook observed PR ${repository}#${number} reopened`,
    );
    return { accepted: false, reason: "reopened" };
  }
  if (
    eventType === "pull_request" &&
    action === "ready_for_review" &&
    relation.state === "awaiting_review"
  ) {
    await transition(
      "awaiting_feedback",
      "ready_for_review",
      `GitHub webhook observed PR ${repository}#${number} ready for review`,
    );
    return { accepted: false, reason: "ready_for_review" };
  }
  // 其余 pull_request 动作（synchronize / labeled 等）不需要唤醒，但要记
  // 一条日志，避免排查时误以为 webhook 丢了。
  if (eventType === "pull_request") {
    await transition(
      relation.state,
      "pull_request_event_ignored",
      `GitHub pull_request event '${action}' did not require a maintenance wake for ${repository}#${number}`,
    );
    return { accepted: false, reason: "pull_request_event_ignored", action };
  }
  if (relation.state !== "awaiting_feedback" && relation.state !== "fixing") {
    return { accepted: false, reason: "relation_not_actionable" };
  }
  const user =
    comment?.user && typeof comment.user === "object"
      ? comment.user
      : review?.user && typeof review.user === "object"
        ? review.user
        : sender;
  const author =
    user &&
    typeof user === "object" &&
    typeof (user as Record<string, unknown>).login === "string"
      ? ((user as Record<string, unknown>).login as string)
      : null;
  if (
    [
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
    ].includes(eventType) &&
    !isExternalFeedbackAuthor(author, ctx.selfLogin)
  ) {
    await transition(
      relation.state,
      "feedback_author_filtered",
      `ignored feedback from bot/self author ${author ?? "unknown"} on ${repository}#${number}`,
    );
    return { accepted: false, reason: "feedback_author_filtered" };
  }
  const id = numberOf(
    eventType === "pull_request_review" ? review?.id : comment?.id,
  );
  if (!id)
    return {
      accepted: false,
      reason:
        eventType === "pull_request_review"
          ? "missing_review"
          : "missing_comment",
    };
  const cursor =
    eventType === "issue_comment"
      ? { issue_comment_id: id }
      : eventType === "pull_request_review_comment"
        ? { comment_id: id }
        : { review_id: id };
  const feedback = await ctx.lifecycle.receiveFeedback(relation.relation_id, {
    eventType,
    cursor,
    incrementFeedbackCount: true,
    log: {
      event: eventType,
      message: `GitHub webhook ${eventType} woke maintenance for ${repository}#${number}`,
    },
  });
  if (feedback.repairLimitReached)
    return { accepted: false, reason: "repair_limit_reached" };
  if (!feedback.relation)
    return { accepted: false, reason: "relation_not_found" };
  const eventId = `${ctx.delivery || `github-${eventType}-${repository}-${number}`}-${relation.relation_id}`;
  await ctx.triggerQueueStore.enqueue({
    event_id: eventId,
    loop_id: relation.loop_id,
    source: "webhook",
    priority: "normal",
    payload: {
      relation_id: relation.relation_id,
      maintenance_id: relation.relation_id,
      event_type: eventType,
      repository,
      pr_number: number,
      ...cursor,
    },
  });
  await ctx.drainPendingTriggers?.(relation.loop_id);
  return { accepted: true, event_id: eventId };
}
