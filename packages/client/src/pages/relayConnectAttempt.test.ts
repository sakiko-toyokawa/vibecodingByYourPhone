import {
  buildRelayConnectKey,
  finishRelayConnectAttempt,
  tryBeginRelayConnectAttempt,
} from "./relayConnectAttempt.js";

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function testBuildRelayConnectKey(): void {
  assertEqual(buildRelayConnectKey("host-1", "session-1"), "host-1:session-1");
}

function testDuplicateAttemptIsRejected(): void {
  const key = buildRelayConnectKey("host-1", "session-1");
  assertEqual(tryBeginRelayConnectAttempt(null, key), true);
  assertEqual(tryBeginRelayConnectAttempt(key, key), false);
}

function testDifferentAttemptCanStart(): void {
  const current = buildRelayConnectKey("host-1", "session-1");
  const next = buildRelayConnectKey("host-1", "session-2");
  assertEqual(tryBeginRelayConnectAttempt(current, next), true);
}

function testCompletingOldAttemptDoesNotClearNewLock(): void {
  const oldKey = buildRelayConnectKey("host-1", "session-1");
  const newKey = buildRelayConnectKey("host-1", "session-2");
  assertEqual(finishRelayConnectAttempt(newKey, oldKey), newKey);
}

function testCompletingActiveAttemptClearsLock(): void {
  const key = buildRelayConnectKey("host-1", "session-1");
  assertEqual(finishRelayConnectAttempt(key, key), null);
}

function main(): void {
  const cases: Array<[string, () => void]> = [
    [
      "buildRelayConnectKey composes host and session ids",
      testBuildRelayConnectKey,
    ],
    [
      "tryBeginRelayConnectAttempt rejects duplicate attempts",
      testDuplicateAttemptIsRejected,
    ],
    [
      "tryBeginRelayConnectAttempt allows a different attempt",
      testDifferentAttemptCanStart,
    ],
    [
      "finishRelayConnectAttempt keeps a newer in-flight attempt locked",
      testCompletingOldAttemptDoesNotClearNewLock,
    ],
    [
      "finishRelayConnectAttempt clears the active attempt",
      testCompletingActiveAttemptClearsLock,
    ],
  ];

  for (const [name, run] of cases) {
    run();
    console.log(`PASS ${name}`);
  }
}

main();
