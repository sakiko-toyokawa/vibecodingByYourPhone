import { useCallback, useEffect, useRef, useState } from "react";
import { loopsApi } from "../api/loops";
import { useSessionStream } from "../hooks/useSessionStream";

interface RuntimeEvent {
  at: string;
  message: {
    type?: string;
    subtype?: string;
    role?: string;
    content?: string;
    error?: string;
    [key: string]: unknown;
  };
}

interface RunStreamOutputProps {
  runId: string;
  isActive: boolean;
  sessionRef: string | null;
}

/** Accumulated display entry after merging stream events. */
interface DisplayEntry {
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
const MAX_PARSE_LINES = 5000;
/** Only display the latest N merged entries (performance). */
const MAX_DISPLAY_ENTRIES = 200;

interface RuntimeContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

function blockText(content: unknown): string {
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

function toolInputSummary(input: unknown): string {
  if (typeof input === "string") {
    return input.length > 600 ? `${input.slice(0, 600)}\n…` : input;
  }
  if (input === undefined || input === null) return "";
  const json = JSON.stringify(input, null, 2) ?? "";
  return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json;
}

function parseRuntimeEvents(content: string): RuntimeEvent[] {
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
function turnOfEventFile(name: string): number {
  const match = /^runtime-events(?:-turn(\d+))?\.jsonl$/.exec(name);
  if (!match) return Number.POSITIVE_INFINITY;
  return match[1] ? Number(match[1]) : 1;
}

/**
 * Merge raw runtime events into human-readable display entries.
 * stream_event deltas are accumulated per message; thinking/text blocks are
 * concatenated into a single assistant entry instead of one line per delta.
 */
function buildDisplayEntries(events: RuntimeEvent[]): DisplayEntry[] {
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

    if (msg.type === "assistant" && Array.isArray(msg.content)) {
      for (const raw of msg.content as unknown[]) {
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
          const text = blockText(block.content ?? block.text);
          if (text.trim().length > 0) {
            entries.push({ at: event.at, kind: "assistant", text });
          }
        }
      }
      continue;
    }

    if (msg.type === "user" && Array.isArray(msg.content)) {
      for (const raw of msg.content as unknown[]) {
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
    } else if (msg.type === "user" && msg.content) {
      entries.push({ at: event.at, kind: "user", text: msg.content });
    } else if (msg.type === "assistant" && msg.content) {
      entries.push({ at: event.at, kind: "assistant", text: msg.content });
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

function kindLabel(kind: DisplayEntry["kind"]): string {
  switch (kind) {
    case "system":
      return "[system]";
    case "user":
      return "[user]";
    case "assistant":
      return "[assistant]";
    case "error":
      return "[error]";
    case "result":
      return "[result]";
    case "info":
      return "[info]";
    case "tool_use":
      return "[tool_use]";
    case "tool_result":
      return "[tool_result]";
  }
}

/**
 * Live stream output for a loop run.
 * - History: reads every runtime-events[-turnN].jsonl artifact (one per
 *   completed turn, concatenated in turn order; each file is fetched once —
 *   completed turns are immutable).
 * - Active runs: also subscribes to the executor session via WebSocket for
 *   real-time messages, merging stream deltas into readable entries.
 *
 * Render with `key={runId}` so switching runs remounts with fresh state.
 */
export function RunStreamOutput({
  runId,
  isActive,
  sessionRef,
}: RunStreamOutputProps) {
  /** file name -> parsed events (completed-turn files never change) */
  const [eventsByFile, setEventsByFile] = useState<
    Record<string, RuntimeEvent[]>
  >({});
  const [liveEvents, setLiveEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedFilesRef = useRef<Set<string>>(new Set());

  const loadHistorical = useCallback(async () => {
    try {
      const { artifacts } = await loopsApi.listRunArtifacts(runId);
      const eventFiles = artifacts
        .filter((name) => turnOfEventFile(name) !== Number.POSITIVE_INFINITY)
        .sort((a, b) => turnOfEventFile(a) - turnOfEventFile(b));
      for (const name of eventFiles) {
        if (loadedFilesRef.current.has(name)) continue;
        try {
          const { content } = await loopsApi.getRunArtifact(runId, name);
          loadedFilesRef.current.add(name);
          const events = parseRuntimeEvents(content);
          setEventsByFile((prev) => ({ ...prev, [name]: events }));
        } catch {
          // A turn's file may vanish mid-listing; retry next poll.
        }
      }
      setError(null);
    } catch {
      setError("runtime events not available yet");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadHistorical();
    if (!isActive) return;
    const interval = setInterval(() => void loadHistorical(), 5000);
    return () => clearInterval(interval);
  }, [loadHistorical, isActive]);

  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType !== "message") return;
      setLiveEvents((prev) => [
        ...prev,
        {
          at: new Date().toISOString(),
          message: data as RuntimeEvent["message"],
        },
      ]);
    },
    [],
  );

  const { connected: wsConnected } = useSessionStream(
    isActive && sessionRef ? sessionRef : null,
    { onMessage: handleStreamMessage },
  );

  // Completed turns are merged per file; a divider marks each turn when the
  // run has more than one, so turn 1 / turn 2 stay distinguishable.
  const turnGroups = Object.keys(eventsByFile)
    .sort((a, b) => turnOfEventFile(a) - turnOfEventFile(b))
    .map((name) => ({
      turn: turnOfEventFile(name),
      entries: buildDisplayEntries(eventsByFile[name] ?? []),
    }))
    .filter((group) => group.entries.length > 0);

  const allEntries: DisplayEntry[] = [];
  for (const group of turnGroups) {
    if (turnGroups.length > 1) {
      allEntries.push({
        at: group.entries[0]?.at ?? "",
        kind: "info",
        text: `—— turn ${group.turn} ——`,
      });
    }
    allEntries.push(...group.entries);
  }
  allEntries.push(...buildDisplayEntries(liveEvents));
  const displayEntries = allEntries.slice(-MAX_DISPLAY_ENTRIES);
  const hiddenCount = allEntries.length - displayEntries.length;

  if (loading) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        Loading stream…
      </p>
    );
  }

  if (allEntries.length === 0) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        {isActive
          ? "Waiting for executor output…"
          : "No stream events recorded."}
      </p>
    );
  }

  return (
    <div className="flex max-h-[480px] flex-col gap-2 overflow-y-auto rounded bg-[var(--bg-primary)] p-3">
      {hiddenCount > 0 && (
        <div className="[font-size:var(--font-size-xs)] italic text-[var(--text-dimmed)]">
          … {hiddenCount} earlier entries hidden (showing latest{" "}
          {displayEntries.length}) …
        </div>
      )}
      {displayEntries.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="flex gap-2">
          <span className="shrink-0 font-mono [font-size:var(--font-size-xs)] text-[var(--text-dimmed)]">
            {new Date(entry.at).toLocaleTimeString()}
          </span>
          <span
            className={`shrink-0 font-mono [font-size:var(--font-size-xs)] ${
              entry.kind === "error"
                ? "text-[var(--error-color)]"
                : entry.kind === "assistant"
                  ? "text-[var(--accent-rust)]"
                  : entry.kind === "tool_use" || entry.kind === "tool_result"
                    ? "text-[var(--accent-rust)]"
                    : "text-[var(--text-muted)]"
            }`}
          >
            {entry.label ?? kindLabel(entry.kind)}
          </span>
          <span className="min-w-0 flex-1">
            {entry.kind === "tool_result" ? (
              <details className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-2">
                <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">
                  Show result
                </summary>
                <div className="mt-2 whitespace-pre-wrap break-all [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                  {entry.text}
                </div>
              </details>
            ) : (
              <span className="whitespace-pre-wrap break-all [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                {entry.text}
              </span>
            )}
          </span>
        </div>
      ))}
      {isActive && (
        <div className="mt-2 [font-size:var(--font-size-xs)] italic text-[var(--text-muted)]">
          {wsConnected ? "live" : "polling"}…
        </div>
      )}
    </div>
  );
}
