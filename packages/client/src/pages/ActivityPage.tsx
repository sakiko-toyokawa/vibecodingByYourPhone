import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  type FileChangeEvent,
  type FileType,
  useFileActivity,
} from "../hooks/useFileActivity";
import { useI18n } from "../i18n";

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString();
}

function getTypeIcon(type: FileChangeEvent["changeType"]): string {
  switch (type) {
    case "create":
      return "+";
    case "modify":
      return "~";
    case "delete":
      return "-";
  }
}

function getTypeColor(type: FileChangeEvent["changeType"]): string {
  switch (type) {
    case "create":
      return "var(--success-color)";
    case "modify":
      return "var(--warning-color)";
    case "delete":
      return "var(--error-color)";
  }
}

function getTypeLabel(
  type: FileChangeEvent["changeType"],
  t: (key: never) => string,
): string {
  switch (type) {
    case "create":
      return t("activityTypeCreated" as never);
    case "modify":
      return t("activityTypeModified" as never);
    case "delete":
      return t("activityTypeDeleted" as never);
  }
}

function getFileTypeLabel(
  fileType: FileType,
  t: (key: never) => string,
): string {
  switch (fileType) {
    case "session":
      return t("activityFileTypeSession" as never);
    case "agent-session":
      return t("activityFileTypeAgentSession" as never);
    case "settings":
      return t("activityFileTypeSettings" as never);
    case "credentials":
      return t("activityFileTypeCredentials" as never);
    case "telemetry":
      return t("activityFileTypeTelemetry" as never);
    case "other":
      return t("activityFileTypeOther" as never);
  }
}

const FILE_TYPE_OPTIONS: FileType[] = [
  "session",
  "agent-session",
  "settings",
  "credentials",
  "telemetry",
  "other",
];

export function ActivityPage() {
  const { t } = useI18n();
  const [pathFilter, setPathFilter] = useState("");
  const [typeFilters, setTypeFilters] = useState<Set<FileType>>(new Set());
  const { events, connected, paused, clearEvents, togglePause } =
    useFileActivity();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Apply filters
  let filteredEvents = events;

  if (pathFilter) {
    const regex = new RegExp(pathFilter, "i");
    filteredEvents = filteredEvents.filter((e) => regex.test(e.relativePath));
  }

  if (typeFilters.size > 0) {
    filteredEvents = filteredEvents.filter((e) => typeFilters.has(e.fileType));
  }

  // Reverse for chronological order (oldest at top, newest at bottom)
  const displayedEvents = [...filteredEvents].reverse();

  const toggleTypeFilter = (type: FileType) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Track scroll position to know if we should auto-scroll
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const threshold = 20;
    isAtBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold;
  };

  // Auto-scroll to bottom when new events arrive (if already at bottom)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally trigger on events change
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (container && isAtBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [displayedEvents.length]);

  // Group events by date
  const eventsByDate = displayedEvents.reduce(
    (acc, event) => {
      const date = formatDate(event.timestamp);
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(event);
      return acc;
    },
    {} as Record<string, FileChangeEvent[]>,
  );

  return (
    <div
      className="mx-auto flex h-[100dvh] flex-col overflow-hidden px-6 py-8 md:px-10 md:py-10"
      style={{ maxWidth: "1200px" }}
    >
      <nav className="mb-4 text-sm text-[var(--text-muted)]">
        <Link to="/projects">{t("pageTitleProjects")}</Link>
        {" / "}
        {t("activityBreadcrumb" as never)}
      </nav>

      <div className="flex items-center justify-between">
        <h1
          className="text-[2rem] text-[var(--text-primary)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("activityTitle" as never)}
        </h1>
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              background: connected
                ? "var(--success-color)"
                : "var(--error-color)",
            }}
          />
          <span className="text-sm text-[var(--text-muted)]">
            {connected
              ? t("activityConnected" as never)
              : t("activityDisconnected" as never)}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="my-4 flex flex-wrap gap-3">
        <input
          type="text"
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          placeholder={t("activityPathPlaceholder" as never)}
          className="min-w-[200px] flex-1 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
        />
        <button
          type="button"
          onClick={togglePause}
          className="cursor-pointer rounded-md border border-[var(--border-color)] bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            borderColor: paused ? "var(--error-color)" : "var(--border-color)",
            color: paused ? "var(--error-color)" : "var(--text-primary)",
          }}
        >
          {paused ? t("activityResume" as never) : t("activityPause" as never)}
        </button>
        <button
          type="button"
          onClick={clearEvents}
          className="cursor-pointer rounded-md border border-[var(--border-color)] bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          {t("activityClear" as never)}
        </button>
      </div>

      {/* Type filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        {FILE_TYPE_OPTIONS.map((type) => (
          <button
            type="button"
            key={type}
            onClick={() => toggleTypeFilter(type)}
            className={`cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors ${
              typeFilters.has(type)
                ? "border border-[var(--accent-rust)] bg-[var(--accent-rust)] text-white"
                : "border border-[var(--border-color)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {getFileTypeLabel(type, t)}
          </button>
        ))}
        {typeFilters.size > 0 && (
          <button
            type="button"
            onClick={() => setTypeFilters(new Set())}
            className="cursor-pointer rounded-md border border-[var(--border-color)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            {t("activityClearFilters" as never)}
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="mb-4 flex gap-6 text-sm text-[var(--text-muted)]">
        <span>{t("activityTotal" as never, { count: events.length })}</span>
        <span>
          {t("activityShowing" as never, { count: displayedEvents.length })}
        </span>
      </div>

      {/* Events - scrollable container */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4"
      >
        {Object.entries(eventsByDate).length === 0 ? (
          <div className="p-12 text-center text-[var(--text-muted)]">
            {events.length === 0
              ? t("activityWaiting" as never)
              : t("activityNoMatches" as never)}
          </div>
        ) : (
          Object.entries(eventsByDate).map(([date, dateEvents]) => (
            <div key={date} className="mb-6">
              <h3 className="mb-2 text-sm text-[var(--text-muted)]">{date}</h3>
              <div className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                {dateEvents.map((event, i) => (
                  <div
                    key={`${event.timestamp}-${event.path}-${i}`}
                    className="grid items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3 font-mono text-sm last:border-b-0"
                    style={{
                      gridTemplateColumns: "80px 24px 100px 1fr",
                    }}
                  >
                    <span className="text-[var(--text-muted)]">
                      {formatTime(event.timestamp)}
                    </span>
                    <span
                      className="text-center font-bold"
                      style={{
                        color: getTypeColor(event.changeType),
                      }}
                      title={getTypeLabel(event.changeType, t)}
                    >
                      {getTypeIcon(event.changeType)}
                    </span>
                    <span className="rounded bg-[var(--bg-hover)] px-2 py-0.5 text-center text-xs text-[var(--text-muted)]">
                      {getFileTypeLabel(event.fileType, t)}
                    </span>
                    <span
                      className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)]"
                      title={event.path}
                    >
                      {event.relativePath}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
