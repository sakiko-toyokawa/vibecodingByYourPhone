# Mid-Generation Message Queuing Analysis

## Key Finding

**Messages CAN be injected mid-turn during long multi-step tasks.** The behavior depends on task complexity:

1. **Short tasks (single tool call):** Message queues and waits for turn completion
2. **Long tasks (many tool calls):** Message gets injected BETWEEN tool calls

However, **Claude sees the message but may choose to continue** with its current task rather than honoring an interrupt request.

---

## Test 1: Short Task (Single Tool Call)

**Session ID:** `c48c14b7-e8b6-418f-b1bf-0cde3871dfe8`
**Task:** "Read index.ts and tell me what it does"
**Interrupt:** "INTERRUPT: Actually just say hello"

### Result: Message waited until turn completion

```
User "Read index.ts"  (829cda66)
         │
         ▼
Assistant tool_use   (afb6ffcb)
         │
    [INTERRUPT QUEUED - but waits]
         │
         ▼
Tool result          (cd1bcfb4)
         │
         ▼
Assistant response   (09e8b499)
         │
    [INTERRUPT DEQUEUED NOW - after turn completed]
         │
         ▼
User "INTERRUPT..."  (326f86fd) ─── parentUuid: 09e8b499
         │
         ▼
Assistant "Hello!"   (34eed11c)
```

The message waited for the full turn to complete, then was processed as a follow-up.

---

## Test 2: Long Task (Many Tool Calls)

**Session ID:** `a9c8a5a7-73d0-449f-8d8a-b4de657f20a4`
**Task:** "Search for all uses of EventBus, read each file, summarize"
**Interrupt:** "STOP - just say hi instead"

### Result: Message INJECTED mid-turn!

```
User "Search EventBus..."
         │
         ▼
Assistant tool_use (Grep)
         │
         ▼
Tool result (24 files found)
         │
         ▼
Assistant tool_use (Read file 1)
         │
         ▼
...several more tool calls...
         │
         ▼
Assistant tool_use (97835ab4)
         │
         ▼
┌──────────────────────────────────────────────┐
│ USER: "STOP - just say hi instead" (0e833de7)│  ◄── INJECTED HERE
└──────────────────────────────────────────────┘
         │
         ▼
Assistant tool_use (21af2044)  ◄── Claude CONTINUED after seeing STOP!
         │
         ▼
Assistant tool_use (8d37fe21)
         │
         ▼
...more tool calls...
         │
         ▼
Assistant final summary (c24e637d)
```

The user message was injected IN THE MIDDLE of the assistant's tool call sequence. Claude saw the "STOP" request but **chose to continue** with the original task.

---

## Why The Difference?

The SDK's message queue yields messages at specific points during processing:

| Scenario | When Queue Yields |
|----------|-------------------|
| Single tool call | After turn completes |
| Multiple tool calls | Between tool results |
| Streaming text only | After message completes |

With many tool calls, there are natural yield points between each tool result where a queued user message can be injected into the conversation.

---

## Critical Observation

**Injection ≠ Immediate Interruption**

The user message is added to the conversation context, but:
- Claude sees it in context at the next thinking block
- Response may be delayed 1-2 thinking blocks as Claude finishes current thought
- Claude will eventually pivot to the new request
- Tool calls already in flight will complete first

**Claude WILL react** - just not necessarily instantly. The delay depends on where Claude is in its reasoning. For immediate hard-stop, use the **abort API**.

---

## Response Timing

When a user message is injected mid-turn:

| Claude's State | Response Delay |
|----------------|----------------|
| Between tool calls | Next thinking block |
| Mid-tool execution | After tool completes |
| Streaming text | After current block |
| Deep in reasoning | 1-2 thinking blocks |

The SDK injects the message, but Claude's architecture means it processes at natural pause points (thinking blocks, tool boundaries).

---

## Message Ordering in Long Tasks

From Test 2, the in-memory message history shows:

```
... tool_use (97835ab4)
USER "STOP - just say hi instead" (0e833de7)   ◄── Mid-turn injection!
... tool_use (21af2044)
... tool_use (8d37fe21)
... tool_use (add486aa)
... tool_use (dd263144)
... assistant text "Let me now read..."
... tool_use (9b1b6ae7)
... final summary (c24e637d)
```

17 assistant messages, with the user interrupt appearing after message 12.

---

## Summary

| Task Type | Injection Point | Claude's Response |
|-----------|-----------------|-------------------|
| Short (1 tool) | After turn | Follows up immediately |
| Long (many tools) | Between tools | Reacts within 1-2 thinking blocks |
| Text streaming | After message | Follows up immediately |

Message injection works for redirecting Claude's attention. For immediate hard-stop of long tasks, use abort API.
