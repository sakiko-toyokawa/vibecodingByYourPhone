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

function formatEventText(event: RuntimeEvent): string {
  const msg = event.message;
  if (msg.error) {
    return `[error] ${msg.error}`;
  }
  if (msg.type === "system" && msg.subtype === "init") {
    return `[system] session initialized (cwd: ${msg.cwd ?? "unknown"})`;
  }
  if (msg.type === "user" && msg.content) {
    return `[user] ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "…" : ""}`;
  }
  if (msg.type === "assistant" && msg.content) {
    return `[assistant] ${msg.content.slice(0, 500)}${msg.content.length > 500 ? "…" : ""}`;
  }
  if (msg.type === "result") {
    return "[result] turn finished";
  }
  if (msg.type === "stream_event") {
    const delta = (msg as { delta?: { text?: string } }).delta?.text;
    if (delta) {
      return `[stream] ${delta}`;
    }
  }
  return `[${msg.type ?? "event"}] ${JSON.stringify(msg).slice(0, 120)}`;
}

/**
 * Live stream output for a loop run.
 * - Finished runs: reads runtime-events.jsonl for historical events.
 * - Active runs: also subscribes to the executor session via WebSocket for
 *   real-time messages, falling back to polling if the session is gone.
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

  // Load historical events from runtime-events.jsonl
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

  // WebSocket subscription for live messages (active run + known session)
  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType !== "message") return;
      const event: RuntimeEvent = {
        at: new Date().toISOString(),
        message: data as RuntimeEvent["message"],
      };
      setLiveEvents((prev) => [...prev, event]);
    },
    [],
  );

  const { connected: wsConnected } = useSessionStream(
    isActive && sessionRef ? sessionRef : null,
    { onMessage: handleStreamMessage },
  );

  const allEvents = [...historicalEvents, ...liveEvents];

  if (loading) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        Loading stream…
      </p>
    );
  }

  if (allEvents.length === 0) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        {isActive
          ? "Waiting for executor output…"
          : "No stream events recorded."}
      </p>
    );
  }

  return (
    <div className="flex max-h-[480px] flex-col gap-1 overflow-y-auto rounded bg-[var(--bg-primary)] p-3 font-mono [font-size:var(--font-size-xs)]">
      {allEvents.map((event, index) => (
        <div key={`${event.at}-${index}`} className="flex gap-2">
          <span className="shrink-0 text-[var(--text-dimmed)]">
            {new Date(event.at).toLocaleTimeString()}
          </span>
          <span className="whitespace-pre-wrap break-all text-[var(--text-primary)]">
            {formatEventText(event)}
          </span>
        </div>
      ))}
      {isActive && (
        <div className="mt-2 text-[var(--text-muted)] italic">
          {wsConnected ? "live" : "polling"}…
        </div>
      )}
    </div>
  );
}
