export interface RuntimeEvent {
  at: string;
  message: {
    type?: string;
    subtype?: string;
    role?: string;
    content?: unknown;
    error?: string;
    [key: string]: unknown;
  };
}

/** Accumulated display entry after merging stream events. */
export interface DisplayEntry {
  at: string;
  kind:
    | "system"
    | "user"
    | "assistant"
    | "error"
    | "result"
    | "info"
    | "tool_use"
    | "tool_result";
  text: string;
  label?: string;
}

/** Only parse the tail of large runtime-events.jsonl files (performance). */
export const MAX_PARSE_LINES = 5000;
/** Only display the latest N merged entries (performance). */
export const MAX_DISPLAY_ENTRIES = 200;

export interface RuntimeContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === "string"
          ? item
          : blockText(
              (item as RuntimeContentBlock | undefined)?.content ?? item,
            ),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  if (typeof content === "object") return JSON.stringify(content, null, 2);
  return String(content);
}

export function toolInputSummary(input: unknown): string {
  if (typeof input === "string") {
    return input.length > 600 ? `${input.slice(0, 600)}\n…` : input;
  }
  if (input === undefined || input === null) return "";
  const json = JSON.stringify(input, null, 2) ?? "";
  return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json;
}

export function parseRuntimeEvents(content: string): RuntimeEvent[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const tail =
    lines.length > MAX_PARSE_LINES ? lines.slice(-MAX_PARSE_LINES) : lines;
  return tail
    .map((line) => {
      try {
        return JSON.parse(line) as RuntimeEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RuntimeEvent => event !== null);
}

/** runtime-events.jsonl → turn 1; runtime-events-turnN.jsonl → turn N. */
export function turnOfEventFile(name: string): number {
  const match = /^runtime-events(?:-turn(\d+))?\.jsonl$/.exec(name);
  if (!match) return Number.POSITIVE_INFINITY;
  return match[1] ? Number(match[1]) : 1;
}

/**
 * Merge raw runtime events into human-readable display entries.
 * stream_event deltas are accumulated per message; thinking/text blocks are
 * concatenated into a single assistant entry instead of one line per delta.
 */
export function buildDisplayEntries(events: RuntimeEvent[]): DisplayEntry[] {
  const entries: DisplayEntry[] = [];
  /** messageId -> accumulated text */
  const streamAccum = new Map<string, { at: string; text: string }>();
  const streamTool = new Map<string, { name: string; input: string }>();
  const toolNames = new Map<string, string>();
  let currentStreamId: string | null = null;

  const flushStream = () => {
    if (!currentStreamId) return;
    const tool = streamTool.get(currentStreamId);
    if (tool) {
      toolNames.set(currentStreamId, tool.name);
      entries.push({
        at: streamAccum.get(currentStreamId)?.at ?? new Date().toISOString(),
        kind: "tool_use",
        label: `tool_use · ${tool.name}`,
        text: tool.input.trim() || "…",
      });
      streamTool.delete(currentStreamId);
    }
    const acc = streamAccum.get(currentStreamId);
    if (acc && acc.text.trim().length > 0) {
      entries.push({ at: acc.at, kind: "assistant", text: acc.text });
    }
    streamAccum.delete(currentStreamId);
    currentStreamId = null;
  };

  for (const event of events) {
    const msg = event.message;
    // SDK 信封解包：runtime 事件的真实内容在 msg.message.content
    // （{role, content} 结构），扁平事件才在 msg.content。统一取 content，
    // 让下面的 assistant/user 分支两种形状都能渲染。
    const innerMessage =
      msg.message && typeof msg.message === "object"
        ? (msg.message as { role?: string; content?: unknown })
        : null;
    const content = innerMessage?.content ?? msg.content;

    if (msg.error) {
      flushStream();
      entries.push({ at: event.at, kind: "error", text: msg.error });
      continue;
    }

    if (msg.type === "stream_event") {
      const evt = (msg as { event?: { type?: string; [key: string]: unknown } })
        .event;
      if (!evt) continue;

      if (evt.type === "message_start") {
        flushStream();
        const message = evt.message as { id?: string } | undefined;
        currentStreamId = message?.id ?? `stream-${Date.now()}`;
        streamAccum.set(currentStreamId, { at: event.at, text: "" });
        continue;
      }

      if (evt.type === "content_block_start") {
        const block = evt.content_block as RuntimeContentBlock | undefined;
        if (block?.type === "tool_use" && currentStreamId) {
          streamTool.set(currentStreamId, {
            name: block.name ?? "tool",
            input: "",
          });
        }
        continue;
      }

      if (evt.type === "content_block_delta" && currentStreamId) {
        const delta = evt.delta as
          | {
              type?: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            }
          | undefined;
        const acc = streamAccum.get(currentStreamId);
        if (acc && delta) {
          if (delta.type === "text_delta" && delta.text) {
            acc.text += delta.text;
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            acc.text += delta.thinking;
          } else if (delta.type === "input_json_delta" && delta.partial_json) {
            const tool = streamTool.get(currentStreamId);
            if (tool) tool.input += delta.partial_json;
          }
        }
        continue;
      }

      if (evt.type === "message_stop" || evt.type === "content_block_stop") {
        flushStream();
        continue;
      }
      continue;
    }

    // Non-stream events
    flushStream();

    if (msg.type === "assistant" && Array.isArray(content)) {
      for (const raw of content as unknown[]) {
        const block = raw as RuntimeContentBlock;
        if (block.type === "tool_use" && block.name) {
          const toolId = typeof block.id === "string" ? block.id : block.name;
          toolNames.set(toolId, block.name);
          entries.push({
            at: event.at,
            kind: "tool_use",
            label: `tool_use · ${block.name}`,
            text: toolInputSummary(block.input),
          });
        } else if (block.type === "tool_result") {
          const toolName = toolNames.get(block.tool_use_id ?? "") ?? "tool";
          entries.push({
            at: event.at,
            kind: "tool_result",
            label: `tool_result · ${toolName}`,
            text: blockText(block.content),
          });
        } else {
          const text = blockText(block.content ?? block.text ?? block.thinking);
          if (text.trim().length > 0) {
            entries.push({ at: event.at, kind: "assistant", text });
          }
        }
      }
      continue;
    }

    if (msg.type === "user" && Array.isArray(content)) {
      for (const raw of content as unknown[]) {
        const block = raw as RuntimeContentBlock;
        if (block.type === "tool_result") {
          const toolName = toolNames.get(block.tool_use_id ?? "") ?? "tool";
          entries.push({
            at: event.at,
            kind: "tool_result",
            label: `tool_result · ${toolName}`,
            text: blockText(block.content),
          });
        } else {
          const text = blockText(block.content ?? block.text);
          if (text.trim().length > 0) {
            entries.push({ at: event.at, kind: "user", text });
          }
        }
      }
      continue;
    }

    if (msg.type === "system" && msg.subtype === "init") {
      entries.push({
        at: event.at,
        kind: "system",
        text: `session initialized (cwd: ${msg.cwd ?? "unknown"})`,
      });
    } else if (msg.type === "user" && content) {
      entries.push({ at: event.at, kind: "user", text: blockText(content) });
    } else if (msg.type === "assistant" && content) {
      entries.push({
        at: event.at,
        kind: "assistant",
        text: blockText(content),
      });
    } else if (msg.type === "result") {
      entries.push({ at: event.at, kind: "result", text: "turn finished" });
    } else if (msg.type === "system" && msg.subtype === "status") {
      const status = (msg as { status?: string }).status;
      if (status) {
        entries.push({ at: event.at, kind: "info", text: `status: ${status}` });
      }
    }
  }

  flushStream();
  return entries;
}
