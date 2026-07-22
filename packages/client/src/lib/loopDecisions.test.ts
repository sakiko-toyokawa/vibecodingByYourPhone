import {
  buildDecisionRequest,
  isAwaitingHuman,
  loopChangedState,
} from "./loopDecisions.js";

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

testApproveWithoutFeedback();
testRejectWithFeedback();
testRequestChangesRequiresFeedback();
testRequestChangesWithFeedback();
testLoopChangedState();
testIsAwaitingHuman();

console.log("loopDecisions tests passed");
