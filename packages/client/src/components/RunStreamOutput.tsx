import { useCallback, useEffect, useState } from "react";
import { loopsApi } from "../api/loops";

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
 * Live stream output for a loop run: reads runtime-events.jsonl and polls
 * for updates while the run is active. Shows executor messages in order.
 */
export function RunStreamOutput({ runId, isActive }: RunStreamOutputProps) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { content } = await loopsApi.getRunArtifact(
        runId,
        "runtime-events.jsonl",
      );
      setEvents(parseRuntimeEvents(content));
      setError(null);
    } catch {
      setEvents([]);
      setError("runtime-events.jsonl not available");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
    if (!isActive) return;
    const interval = setInterval(() => void load(), 3000);
    return () => clearInterval(interval);
  }, [load, isActive]);

  if (loading) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        Loading stream…
      </p>
    );
  }

  if (error) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        {error}
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        No stream events recorded.
      </p>
    );
  }

  return (
    <div className="flex max-h-[480px] flex-col gap-1 overflow-y-auto rounded bg-[var(--bg-primary)] p-3 font-mono [font-size:var(--font-size-xs)]">
      {events.map((event, index) => (
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
          polling for new events…
        </div>
      )}
    </div>
  );
}
