import type {
  RunDecisionAction,
  RunDecisionRequest,
} from "@yep-anywhere/shared";

/**
 * Pure helpers for the loop approval flow (needs_human decisions).
 * Kept UI-free so they can be unit tested with plain node asserts.
 */

export type DecisionRequestResult =
  | { ok: true; request: RunDecisionRequest }
  | { ok: false; error: "feedback_required" };

/**
 * Build the POST /api/runs/:id/decision body.
 * request_changes requires non-empty feedback (server: 400 invalid_decision);
 * validated client-side first so the user gets immediate feedback.
 */
export function buildDecisionRequest(
  decision: RunDecisionAction,
  feedback?: string,
): DecisionRequestResult {
  const trimmed = feedback?.trim();
  if (decision === "request_changes" && !trimmed) {
    return { ok: false, error: "feedback_required" };
  }
  return {
    ok: true,
    request: { decision, feedback: trimmed || undefined },
  };
}

/**
 * Extract the new state from a loop-state-changed event.
 * The server emits `to_state`; `state` is tolerated for forward compat.
 */
export function loopChangedState(event: {
  to_state?: string;
  state?: string;
}): string | undefined {
  return event.to_state ?? event.state;
}

/** Whether a run state still waits on a human decision. */
export function isAwaitingHuman(state: string | undefined): boolean {
  return state === "needs_human";
}
