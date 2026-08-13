import { useCallback, useEffect, useMemo, useState } from "react";
import { type MaintenanceTarget, maintenanceApi } from "../api/maintenance";
import { MaintenanceTargetCard } from "../components/MaintenanceTargetCard";
import { PageHeader } from "../components/PageHeader";
import { useNavigationLayout } from "../layouts";
import { humanizeMaintenanceState } from "../lib/loopHumanText";

const POLL_INTERVAL_MS = 5000;

const EMPTY_CREATE_FORM = {
  target_id: "",
  loop_id: "",
  target_type: "generic_webhook",
  external_ref: '{\n  "source": "",\n  "subject_id": ""\n}',
  trigger_types: "deploy_ready",
  max_repairs: "3",
  context_payload: "{}",
};

const EMPTY_EVENT_FORM = {
  event_id: "",
  source: "generic_webhook",
  priority: "normal" as const,
  payload: "{}",
};

export function MaintenanceTargetsPage() {
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const [targets, setTargets] = useState<MaintenanceTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("");
  const [loopFilter, setLoopFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] =
    useState<MaintenanceTarget | null>(null);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);

  const load = useCallback(async () => {
    try {
      const { targets: next } = await maintenanceApi.listTargets();
      setTargets(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const loop = loopFilter.trim().toLowerCase();
    return targets.filter((target) => {
      const stateMatches = !stateFilter || target.state === stateFilter;
      const loopMatches = !loop || target.loop_id.toLowerCase().includes(loop);
      return stateMatches && loopMatches;
    });
  }, [loopFilter, stateFilter, targets]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {
      pending_approval: 0,
      awaiting_review: 0,
      awaiting_feedback: 0,
      waiting: 0,
      waking: 0,
      fixing: 0,
      needs_human: 0,
      done: 0,
    };
    for (const target of targets) {
      result[target.state] = (result[target.state] ?? 0) + 1;
    }
    return result;
  }, [targets]);

  const setCreate = (key: keyof typeof createForm, value: string) => {
    setCreateForm((form) => ({ ...form, [key]: value }));
  };

  const setEvent = (
    key: keyof typeof eventForm,
    value: string | "urgent" | "normal" | "background",
  ) => {
    setEventForm((form) => ({ ...form, [key]: value }));
  };

  const handleCreate = async () => {
    setMessage(null);
    setError(null);
    try {
      const externalRef = JSON.parse(createForm.external_ref) as Record<
        string,
        unknown
      >;
      const contextPayload = JSON.parse(createForm.context_payload) as Record<
        string,
        unknown
      >;
      const triggerTypes = createForm.trigger_types
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const maxRepairs = Number(createForm.max_repairs);
      if (
        !createForm.target_id.trim() ||
        !createForm.loop_id.trim() ||
        !createForm.target_type.trim() ||
        triggerTypes.length === 0 ||
        !Number.isFinite(maxRepairs)
      ) {
        throw new Error(
          "target id, loop id, type, triggers and max repairs are required",
        );
      }
      await maintenanceApi.createTarget({
        target_id: createForm.target_id.trim(),
        loop_id: createForm.loop_id.trim(),
        target_type: createForm.target_type.trim(),
        external_ref: externalRef,
        wake_policy: {
          trigger_types: triggerTypes,
          max_repairs: maxRepairs,
        },
        context_payload: contextPayload,
      });
      setCreateForm(EMPTY_CREATE_FORM);
      setCreateOpen(false);
      setMessage("Maintenance target created.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendEvent = async () => {
    if (!selectedTarget) return;
    setMessage(null);
    setError(null);
    try {
      const payload = JSON.parse(eventForm.payload) as Record<string, unknown>;
      const eventId = eventForm.event_id.trim() || `maintenance-${Date.now()}`;
      await maintenanceApi.sendEvent({
        source: eventForm.source.trim() || "generic_webhook",
        event_id: eventId,
        target_id: selectedTarget.target_id,
        priority: eventForm.priority,
        payload,
      });
      setEventForm(EMPTY_EVENT_FORM);
      setMessage(`Event ${eventId} accepted.`);
      setSelectedTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className={
        isWideScreen
          ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
      }
    >
      <PageHeader
        title="Maintenance Targets"
        onOpenSidebar={openSidebar}
        isWideScreen={isWideScreen}
        rightContent={
          <button
            type="button"
            className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90"
            onClick={() => setCreateOpen((open) => !open)}
          >
            {createOpen ? "Close form" : "New target"}
          </button>
        }
      />

      <main className="flex-1 min-h-0 w-full overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {error && (
            <p className="rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-3 text-sm text-[var(--error-color)]">
              {error}
            </p>
          )}
          {message && (
            <p className="rounded-[var(--radius-sm)] border border-[var(--success-color)]/40 bg-[var(--success-color)]/10 p-3 text-sm text-[var(--success-color)]">
              {message}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {Object.entries(counts).map(([state, count]) => (
              <button
                key={state}
                type="button"
                className={`rounded-[var(--radius-sm)] border p-3 text-left transition-colors ${
                  stateFilter === state
                    ? "border-[var(--primary)] bg-[var(--primary)]/10"
                    : "border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--border-hover)]"
                }`}
                onClick={() =>
                  setStateFilter((current) => (current === state ? "" : state))
                }
              >
                <div className="text-xl font-semibold text-[var(--text-primary)]">
                  {count}
                </div>
                <div className="break-words text-xs text-[var(--text-muted)]">
                  {humanizeMaintenanceState(state)}
                </div>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              State
              <select
                className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value)}
              >
                <option value="">All states</option>
                <option value="pending_approval">Pending approval</option>
                <option value="awaiting_review">Awaiting review</option>
                <option value="awaiting_feedback">Awaiting feedback</option>
                <option value="waiting">Waiting</option>
                <option value="waking">Waking</option>
                <option value="fixing">Fixing</option>
                <option value="needs_human">Human review required</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Loop id
              <input
                className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                value={loopFilter}
                onChange={(event) => setLoopFilter(event.target.value)}
                placeholder="Filter by loop id"
              />
            </label>
          </div>

          {createOpen && (
            <section className="rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
              <h2 className="m-0 mb-3 text-sm font-semibold text-[var(--text-primary)]">
                Create maintenance target
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Target id
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={createForm.target_id}
                    onChange={(event) =>
                      setCreate("target_id", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Loop id
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={createForm.loop_id}
                    onChange={(event) =>
                      setCreate("loop_id", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Target type
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={createForm.target_type}
                    onChange={(event) =>
                      setCreate("target_type", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Trigger types (comma separated)
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={createForm.trigger_types}
                    onChange={(event) =>
                      setCreate("trigger_types", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Max repairs
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={createForm.max_repairs}
                    onChange={(event) =>
                      setCreate("max_repairs", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  External ref JSON
                  <textarea
                    className="min-h-24 rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
                    value={createForm.external_ref}
                    onChange={(event) =>
                      setCreate("external_ref", event.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)] sm:col-span-2">
                  Context payload JSON
                  <textarea
                    className="min-h-24 rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
                    value={createForm.context_payload}
                    onChange={(event) =>
                      setCreate("context_payload", event.target.value)
                    }
                  />
                </label>
              </div>
              <button
                type="button"
                className="mt-3 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90"
                onClick={() => void handleCreate()}
              >
                Create target
              </button>
            </section>
          )}

          {selectedTarget && (
            <section className="rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
              <h2 className="m-0 mb-3 text-sm font-semibold text-[var(--text-primary)]">
                Send test event to {selectedTarget.target_id}
              </h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Event id
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={eventForm.event_id}
                    onChange={(event) =>
                      setEvent("event_id", event.target.value)
                    }
                    placeholder={`maintenance-${Date.now()}`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Source
                  <input
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={eventForm.source}
                    onChange={(event) => setEvent("source", event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  Priority
                  <select
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={eventForm.priority}
                    onChange={(event) =>
                      setEvent(
                        "priority",
                        event.target.value as
                          | "urgent"
                          | "normal"
                          | "background",
                      )
                    }
                  >
                    <option value="urgent">urgent</option>
                    <option value="normal">normal</option>
                    <option value="background">background</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)] sm:col-span-3">
                  Payload JSON
                  <textarea
                    className="min-h-24 rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]"
                    value={eventForm.payload}
                    onChange={(event) =>
                      setEvent("payload", event.target.value)
                    }
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90"
                  onClick={() => void handleSendEvent()}
                >
                  Send event
                </button>
                <button
                  type="button"
                  className="rounded-md border border-[var(--border-color)] px-4 py-2 text-sm font-medium text-[var(--text-primary)]"
                  onClick={() => setSelectedTarget(null)}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}

          {loading && targets.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No maintenance targets found.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((target) => (
                <MaintenanceTargetCard
                  key={target.target_id}
                  target={target}
                  showLoop
                  onChanged={() => void load()}
                  onSendEvent={(item) => {
                    setEventForm(EMPTY_EVENT_FORM);
                    setSelectedTarget(item);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
