import { useCallback, useEffect, useState } from "react";
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
  kind: "system" | "user" | "assistant" | "error" | "result" | "info";
  text: string;
}

function parseRuntimeEvents(content: string): RuntimeEvent[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RuntimeEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RuntimeEvent => event !== null);
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
  let currentStreamId: string | null = null;

  const flushStream = () => {
    if (!currentStreamId) return;
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

      if (evt.type === "content_block_delta" && currentStreamId) {
        const delta = evt.delta as
          | { type?: string; text?: string; thinking?: string }
          | undefined;
        const acc = streamAccum.get(currentStreamId);
        if (acc && delta) {
          if (delta.type === "text_delta" && delta.text) {
            acc.text += delta.text;
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            acc.text += delta.thinking;
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
  }
}

/**
 * Live stream output for a loop run.
 * - Finished runs: reads runtime-events.jsonl for historical events.
 * - Active runs: also subscribes to the executor session via WebSocket for
 *   real-time messages, merging stream deltas into readable entries.
 */
export function RunStreamOutput({
  runId,
  isActive,
  sessionRef,
}: RunStreamOutputProps) {
  const [historicalEvents, setHistoricalEvents] = useState<RuntimeEvent[]>([]);
  const [liveEvents, setLiveEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadHistorical = useCallback(async () => {
    try {
      const { content } = await loopsApi.getRunArtifact(
        runId,
        "runtime-events.jsonl",
      );
      setHistoricalEvents(parseRuntimeEvents(content));
      setError(null);
    } catch {
      setHistoricalEvents([]);
      setError("runtime-events.jsonl not available yet");
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

  const allEntries = buildDisplayEntries([...historicalEvents, ...liveEvents]);

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
      {allEntries.map((entry, index) => (
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
                  : "text-[var(--text-muted)]"
            }`}
          >
            {kindLabel(entry.kind)}
          </span>
          <span className="whitespace-pre-wrap break-all [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
            {entry.text}
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
