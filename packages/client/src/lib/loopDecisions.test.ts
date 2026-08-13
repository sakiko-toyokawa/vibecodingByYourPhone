import {
  buildDecisionRequest,
  isAwaitingHuman,
  loopChangedState,
} from "./loopDecisions.js";
import {
  buildReportSummary,
  formatHumanReasons,
  humanizeDecision,
  humanizeReason,
} from "./loopHumanText.js";

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function testApproveWithoutFeedback(): void {
  const result = buildDecisionRequest("approve");
  if (!result.ok) throw new Error("approve without feedback should be ok");
  assertEqual(result.request.decision, "approve");
  assertEqual(result.request.feedback, undefined);
}

function testRejectWithFeedback(): void {
  const result = buildDecisionRequest("reject", "  not needed  ");
  if (!result.ok) throw new Error("reject with feedback should be ok");
  assertEqual(result.request.feedback, "not needed");
}

function testRequestChangesRequiresFeedback(): void {
  for (const feedback of [undefined, "", "   "]) {
    const result = buildDecisionRequest("request_changes", feedback);
    if (result.ok) {
      throw new Error(
        `request_changes with feedback=${String(feedback)} must fail`,
      );
    }
    assertEqual(result.error, "feedback_required");
  }
}

function testRequestChangesWithFeedback(): void {
  const result = buildDecisionRequest("request_changes", "add tests");
  if (!result.ok) throw new Error("request_changes with feedback should be ok");
  assertEqual(result.request.feedback, "add tests");
}

function testLoopChangedState(): void {
  assertEqual(loopChangedState({ to_state: "complete" }), "complete");
  assertEqual(loopChangedState({ state: "paused" }), "paused");
  assertEqual(
    loopChangedState({ to_state: "failed", state: "ignored" }),
    "failed",
  );
  assertEqual(loopChangedState({}), undefined);
}

function testIsAwaitingHuman(): void {
  assertEqual(isAwaitingHuman("needs_human"), true);
  assertEqual(isAwaitingHuman("complete"), false);
  assertEqual(isAwaitingHuman(undefined), false);
}

function testHumanizedLoopText(): void {
  assertEqual(humanizeDecision("needs_human"), "Human review required");
  assertEqual(humanizeDecision("budget_limited"), "Budget exhausted");
  assertEqual(humanizeDecision("mystery_state"), "mystery_state");
  assertEqual(
    humanizeReason(
      "judgment overall == inconclusive, not automatically retryable",
    ),
    "Verifier could not reach a clear verdict; the run was escalated for human review.",
  );
  assertEqual(
    humanizeReason("budget exhausted before turn 9"),
    "Budget exhausted before the next turn; increase budget to continue.",
  );
  assertEqual(
    humanizeReason(
      "a verifier requires human review (overall == passed); human escalation outranks the verdict",
    ),
    "A verifier passed but requested human review; the run was escalated for a human decision.",
  );
}

function testReportSummary(): void {
  const summary = buildReportSummary(
    "judgment-report-turn2.json",
    JSON.stringify({
      overall: "failed",
      next_action: "retry",
      requires_human: false,
      unresolved_risks: ["missing evidence"],
      human_reasons: [
        {
          code: "duplicate_pr",
          message: "Open PR #123 already covers this fix.",
        },
      ],
    }),
  );
  if (!summary) throw new Error("judgment summary should be built");
  assertEqual(summary.title, "Judgment Summary");
  assertEqual(summary.rows[0]?.label, "Overall");
  assertEqual(summary.rows[0]?.value, "Failed");
  assertEqual(summary.risks[0], "missing evidence");
  assertEqual(summary.humanReasons[0]?.code, "duplicate_pr");
  assertEqual(
    formatHumanReasons(summary.humanReasons),
    "Open PR #123 already covers this fix.",
  );
}

testApproveWithoutFeedback();
testRejectWithFeedback();
testRequestChangesRequiresFeedback();
testRequestChangesWithFeedback();
testLoopChangedState();
testIsAwaitingHuman();
testHumanizedLoopText();
testReportSummary();

console.log("loopDecisions + loopHumanText tests passed");
