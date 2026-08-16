function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertOk(value: unknown, message?: string): asserts value {
  if (!value) {
    throw new Error(message ?? "Expected truthy value");
  }
}

import {
  buildDisplayEntries,
  parseRuntimeEvents,
  turnOfEventFile,
} from "./RunStreamOutput.shared.js";

function testEnvelopeAssistantText(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:00.000Z",
      message: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先查看 issue 內容。" }],
        },
      },
    },
  ]);
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.kind, "assistant");
  assertOk(entries[0]?.text.includes("我先查看 issue 內容。"));
}

function testEnvelopeUserToolResult(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:01.000Z",
      message: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
    },
    {
      at: "2026-08-15T10:00:02.000Z",
      message: {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
    },
  ]);
  const toolResult = entries.find((entry) => entry.kind === "tool_result");
  assertOk(toolResult);
  assertEqual(toolResult.label, "tool_result · Bash");
  assertEqual(toolResult.text, "ok");
}

function testEnvelopeAssistantToolUse(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:01.000Z",
      message: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
    },
  ]);
  const toolUse = entries.find((entry) => entry.kind === "tool_use");
  assertOk(toolUse);
  assertEqual(toolUse.label, "tool_use · Bash");
  assertOk(toolUse.text.includes("ls"));
}

function testFlatLegacyAssistantShape(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:00.000Z",
      message: {
        type: "assistant",
        content: [{ type: "text", text: "legacy" }],
      },
    },
  ]);
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.kind, "assistant");
  assertEqual(entries[0]?.text, "legacy");
}

function testStreamEventDeltaAggregation(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:00.000Z",
      message: {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_1" } },
      },
    },
    {
      at: "2026-08-15T10:00:00.100Z",
      message: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "你好" },
        },
      },
    },
    {
      at: "2026-08-15T10:00:00.200Z",
      message: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "世界" },
        },
      },
    },
    {
      at: "2026-08-15T10:00:00.300Z",
      message: {
        type: "stream_event",
        event: { type: "message_stop" },
      },
    },
  ]);
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.kind, "assistant");
  assertEqual(entries[0]?.text, "你好世界");
}

function testResultEvent(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:00.000Z",
      message: { type: "result" },
    },
  ]);
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.kind, "result");
  assertEqual(entries[0]?.text, "turn finished");
}

function testErrorEvent(): void {
  const entries = buildDisplayEntries([
    {
      at: "2026-08-15T10:00:00.000Z",
      message: { type: "system", error: "boom" },
    },
  ]);
  assertEqual(entries.length, 1);
  assertEqual(entries[0]?.kind, "error");
  assertEqual(entries[0]?.text, "boom");
}

function testTurnOfEventFile(): void {
  assertEqual(turnOfEventFile("runtime-events.jsonl"), 1);
  assertEqual(turnOfEventFile("runtime-events-turn3.jsonl"), 3);
  assertEqual(turnOfEventFile("notes.md"), Number.POSITIVE_INFINITY);
}

function testParseRuntimeEventsToleranceAndTail(): void {
  const tailLines = Array.from({ length: 5001 }, (_, index) =>
    JSON.stringify({
      at: index === 0 ? "marker" : `line-${index}`,
      message: { type: "result" },
    }),
  );
  const events = parseRuntimeEvents(tailLines.join("\n"));
  assertEqual(events.length, 5000);
  assertEqual(
    events.some((event) => event.at === "marker"),
    false,
  );

  const mixed = parseRuntimeEvents(
    '{"at":"a","message":{"type":"result"}}\nbad\n{"at":"b","message":{"type":"result"}}',
  );
  assertEqual(mixed.length, 2);
}

const cases: Array<[string, () => void]> = [
  [
    "envelope assistant text unwraps SDK message envelope",
    testEnvelopeAssistantText,
  ],
  ["envelope user tool_result resolves tool name", testEnvelopeUserToolResult],
  [
    "envelope assistant tool_use renders structured entry",
    testEnvelopeAssistantToolUse,
  ],
  ["flat legacy assistant shape still works", testFlatLegacyAssistantShape],
  [
    "stream_event text deltas aggregate into one assistant entry",
    testStreamEventDeltaAggregation,
  ],
  ["result event renders turn finished", testResultEvent],
  ["error event renders error entry", testErrorEvent],
  ["turnOfEventFile maps runtime event files", testTurnOfEventFile],
  [
    "parseRuntimeEvents skips bad lines and keeps tail",
    testParseRuntimeEventsToleranceAndTail,
  ],
];

for (const [name, run] of cases) {
  run();
  console.log(`PASS ${name}`);
}
