import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type GitHubRelation, githubApi } from "../api/github";
import {
  type InteractionDepsStatus,
  type LoopRunSummary,
  type RunDetail,
  type RunTurnSummary,
  type StoredLoop,
  loopsApi,
} from "../api/loops";
import { WorkspaceStrategyBadge } from "../components/LoopWorkspaceHint";
import { PageHeader } from "../components/PageHeader";
import { RunStreamOutput } from "../components/RunStreamOutput";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { activityBus } from "../lib/activityBus";
import { runStateBadgeClass } from "../lib/loopStateStyle";

const POLL_INTERVAL_MS = 10_000;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function artifactNameFromRef(ref: string | null): string | null {
  if (!ref) return null;
  return ref.split("/").at(-1) ?? null;
}

/**
 * Loop detail page: run history with state badges, judgment summary for the
 * selected run, and a manual "run now" trigger.
 *
 * Refreshes every 10s and immediately on loop-state-changed events for this
 * loop.
 */
export function LoopDetailPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const navigate = useNavigate();
  const { loopId } = useParams<{ loopId: string }>();

  const [loop, setLoop] = useState<StoredLoop | null>(null);
  const [runs, setRuns] = useState<LoopRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [patching, setPatching] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [runTurns, setRunTurns] = useState<RunTurnSummary[]>([]);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [interactionDeps, setInteractionDeps] =
    useState<InteractionDepsStatus | null>(null);
  const [interactionDepsLoading, setInteractionDepsLoading] = useState(false);
  const [interactionDepsInstalling, setInteractionDepsInstalling] =
    useState(false);
  const [interactionDepsMessage, setInteractionDepsMessage] = useState<
    string | null
  >(null);
  const [relations, setRelations] = useState<GitHubRelation[]>([]);
  const [discarding, setDiscarding] = useState(false);
  const selectedRunIdRef = useRef<string | null>(null);
  selectedRunIdRef.current = selectedRunId;

  const load = useCallback(async () => {
    if (!loopId) return;
    try {
      const [{ loop: storedLoop }, { runs: runList }] = await Promise.all([
        loopsApi.getLoop(loopId),
        loopsApi.listRuns(loopId),
      ]);
      setLoop(storedLoop);
      setRuns(runList);
      setError(null);
      // Refresh the open judgment panel too (state may have changed),
      // including the artifact list — turn artifacts (stdout, summaries,
      // reports) land as the run progresses.
      if (selectedRunIdRef.current) {
        try {
          const [detail, artifactList, turnList] = await Promise.all([
            loopsApi.getRun(selectedRunIdRef.current),
            loopsApi.listRunArtifacts(selectedRunIdRef.current),
            loopsApi.listRunTurns(selectedRunIdRef.current),
          ]);
          setRunDetail(detail);
          setArtifacts(artifactList.artifacts);
          setRunTurns(turnList.turns);
        } catch {
          // Keep showing the stale detail; the list still refreshed
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [loopId]);

  // Initial load + 10s polling
  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Immediate refresh on loop-state-changed for this loop
  useEffect(() => {
    if (!loopId) return;
    return activityBus.on("loop-state-changed", (event) => {
      if (event.loop_id === loopId) void load();
    });
  }, [loopId, load]);

  const loadInteractionDeps = useCallback(async () => {
    if (!loopId) return;
    setInteractionDepsLoading(true);
    setInteractionDepsMessage(null);
    try {
      setInteractionDeps(await loopsApi.getInteractionDeps(loopId));
    } catch (err) {
      setInteractionDeps(null);
      setInteractionDepsMessage(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setInteractionDepsLoading(false);
    }
  }, [loopId]);

  useEffect(() => {
    if (!loop?.card.loop.verification.required.includes("interaction")) {
      setInteractionDeps(null);
      return;
    }
    void loadInteractionDeps();
  }, [loadInteractionDeps, loop]);

  useEffect(() => {
    if (!loopId) return;
    githubApi
      .listRelations(loopId)
      .then(({ relations }) => setRelations(relations))
      .catch(() => setRelations([]));
  }, [loopId]);

  const handleInstallInteractionDeps = useCallback(async () => {
    if (!loopId) return;
    setInteractionDepsInstalling(true);
    setInteractionDepsMessage(null);
    try {
      const result = await loopsApi.installInteractionDeps(
        loopId,
        interactionDeps?.installCommand,
      );
      setInteractionDepsMessage(result.output || result.command);
      await loadInteractionDeps();
    } catch (err) {
      setInteractionDepsMessage(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setInteractionDepsInstalling(false);
    }
  }, [interactionDeps?.installCommand, loadInteractionDeps, loopId]);

  const handleSelectRun = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setDetailLoading(true);
    setSelectedArtifact(null);
    setArtifactContent(null);
    try {
      const [detail, artifactList, turnList] = await Promise.all([
        loopsApi.getRun(runId),
        loopsApi.listRunArtifacts(runId),
        loopsApi.listRunTurns(runId),
      ]);
      setRunDetail(detail);
      setArtifacts(artifactList.artifacts);
      setRunTurns(turnList.turns);
      setTurnsOpen(false);
    } catch {
      setRunDetail(null);
      setArtifacts([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleSelectArtifact = useCallback(
    async (name: string) => {
      if (!selectedRunId) return;
      setSelectedArtifact(name);
      setArtifactLoading(true);
      try {
        const { content } = await loopsApi.getRunArtifact(selectedRunId, name);
        setArtifactContent(content);
      } catch {
        setArtifactContent(null);
      } finally {
        setArtifactLoading(false);
      }
    },
    [selectedRunId],
  );

  const handleDiscardRun = useCallback(async () => {
    if (!selectedRunId || !runDetail) return;
    const isActive =
      runDetail.run.state === "active" || runDetail.run.state === "retry";
    const confirmed = window.confirm(
      isActive
        ? "Discard this run? The executing process will be terminated, then direct changes will be reverted or the worktree removed."
        : "Discard this run? This marks it discarded, reverts direct tracked changes by default, and removes the run worktree by default.",
    );
    if (!confirmed) return;
    setDiscarding(true);
    setActionError(null);
    try {
      await loopsApi.discardRun(selectedRunId, {
        reason: "Discarded by user from loop detail page",
        revert_files: true,
        cleanup_worktree: true,
        force: isActive,
      });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscarding(false);
    }
  }, [load, runDetail, selectedRunId]);

  const handleRunNow = useCallback(async () => {
    if (!loopId) return;
    setTriggering(true);
    setActionError(null);
    try {
      await loopsApi.triggerRun(loopId);
      await load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setActionError(t("loopsRunActive"));
      } else {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setTriggering(false);
    }
  }, [loopId, load, t]);

  // PATCH pause / resume (03-API契约.md, 阶段 2). The current run state is
  // derived from the newest run in the list projection.
  const handlePatch = useCallback(
    async (action: "pause" | "resume") => {
      if (!loopId) return;
      setPatching(true);
      setActionError(null);
      try {
        await loopsApi.patchLoop(loopId, action);
        await load();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setPatching(false);
      }
    },
    [loopId, load],
  );

  const sortedRuns = [...runs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const currentRunState = sortedRuns[0]?.state ?? null;

  const judgment = runDetail?.ledger_summary.judgment_summary ?? null;
  const failureTags = runDetail?.ledger_summary.failure_tags ?? [];
  const collectorReportRef =
    runDetail?.ledger_summary.collector_report_ref ?? null;
  const handoffRef = runDetail?.ledger_summary.handoff_ref ?? null;
  const blockerFingerprint =
    runDetail?.ledger_summary.blocker_fingerprint ?? null;
  const repeatedBlockerCount =
    runDetail?.ledger_summary.repeated_blocker_count ?? 0;

  return (
    <div
      className={
        isWideScreen
          ? "flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden"
          : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
      }
    >
      <div
        className={
          isWideScreen
            ? "flex h-dvh w-full flex-col"
            : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
        }
      >
        <PageHeader
          title={loopId ?? t("loopsTitle")}
          showBack
          onBack={() => navigate("..")}
          rightContent={
            <div className="flex items-center gap-[var(--space-2)]">
              {(currentRunState === "active" ||
                currentRunState === "retry") && (
                <button
                  type="button"
                  className="rounded-md border border-[var(--border-color)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                  onClick={() => void handlePatch("pause")}
                  disabled={patching}
                >
                  {t("loopsPause")}
                </button>
              )}
              {currentRunState === "paused" && (
                <button
                  type="button"
                  className="rounded-md border border-[var(--border-color)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                  onClick={() => void handlePatch("resume")}
                  disabled={patching}
                >
                  {t("loopsResume")}
                </button>
              )}
              <button
                type="button"
                className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                onClick={() => void handleRunNow()}
                disabled={triggering}
              >
                {triggering ? t("loopsRunStarting") : t("loopsRunNow")}
              </button>
            </div>
          }
        />

        <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
          <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
            {actionError && (
              <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                {actionError}
              </p>
            )}

            {loading && (
              <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                {t("loopsLoading")}
              </p>
            )}

            {error && (
              <p className="p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                {t("loopsError", { message: error.message })}
              </p>
            )}

            {loop && (
              <p className="mb-6 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                <span className="font-mono">
                  {loop.card.loop.trigger.type === "schedule" &&
                  loop.card.loop.trigger.cron
                    ? loop.card.loop.trigger.cron
                    : loop.card.loop.trigger.type}
                </span>
                {" · "}
                <WorkspaceStrategyBadge
                  strategy={loop.card.loop.workspace.strategy}
                  directHint={t("loopsDirectWorkspaceHint")}
                />
                {loop.card.loop.policy ? (
                  <span className="rounded-[var(--radius-sm)] bg-[var(--warning-color)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--warning-color)]">
                    modify
                  </span>
                ) : (
                  <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                    readonly
                  </span>
                )}
                {" · "}
                {t("loopsMaxTurns", {
                  count: loop.card.loop.stop_rules.max_turns,
                })}
                {" · "}
                {t("loopsCreated", { time: formatTime(loop.created_at) })}
              </p>
            )}

            {relations.length > 0 && (
              <section className="mb-6 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                <h2 className="m-0 mb-3 [font-size:var(--font-size-sm)] font-semibold text-[var(--text-primary)]">
                  GitHub Relation
                </h2>
                <div className="flex flex-col gap-2">
                  {relations.map((relation) => (
                    <div
                      key={relation.relation_id}
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                          {relation.subject.repository}#
                          {relation.subject.pr_number ?? "?"}
                        </span>
                        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                          {relation.state}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                        <div>
                          branch:{" "}
                          <span className="font-mono">
                            {relation.subject.branch}
                          </span>
                        </div>
                        <div>
                          feedback: {relation.feedback_count} · repair:{" "}
                          {relation.repair_count}
                        </div>
                        <div>
                          last processed:{" "}
                          {relation.last_processed.comment_id ??
                            relation.last_processed.review_id ??
                            "—"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {loop?.card.loop.verification.required.includes("interaction") && (
              <section className="mb-6 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="m-0 [font-size:var(--font-size-sm)] font-semibold text-[var(--text-primary)]">
                      {t("loopsInteractionDepsTitle")}
                    </h2>
                    <p className="m-0 mt-1 [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                      {interactionDepsLoading
                        ? t("loopsInteractionDepsChecking")
                        : interactionDeps
                          ? t(
                              `loopsInteractionDepsStatus_${interactionDeps.status}` as never,
                            )
                          : t("loopsInteractionDepsUnknown")}
                    </p>
                    {interactionDepsMessage && (
                      <p className="m-0 mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-2 font-mono [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                        {interactionDepsMessage}
                      </p>
                    )}
                  </div>
                  {interactionDeps?.status === "missing" && (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                      disabled={interactionDepsInstalling}
                      onClick={() => void handleInstallInteractionDeps()}
                    >
                      {interactionDepsInstalling
                        ? t("loopsInteractionDepsInstalling")
                        : t("loopsInteractionDepsInstall")}
                    </button>
                  )}
                </div>
              </section>
            )}

            {!loading && !error && (
              <>
                <h2
                  className="m-0 mb-4 text-xl text-[var(--text-primary)]"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {t("loopsRunsTitle")}
                </h2>
                {sortedRuns.length === 0 ? (
                  <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                    {t("loopsNoRuns")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-[var(--space-2)]">
                    {sortedRuns.map((run) => (
                      <button
                        key={run.run_id}
                        type="button"
                        onClick={() => void handleSelectRun(run.run_id)}
                        className={`block w-full border rounded-[var(--radius-md)] bg-[var(--bg-secondary)] p-4 text-left transition-[border-color] duration-150 hover:border-[var(--border-hover)] ${
                          selectedRunId === run.run_id
                            ? "border-[var(--accent-rust)]"
                            : "border-[var(--border-color)]"
                        }`}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]">
                          <span
                            className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium ${runStateBadgeClass(run.state)}`}
                          >
                            {run.state}
                          </span>
                          <span className="shrink-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                            {run.source}
                          </span>
                          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                            {formatTime(run.created_at)}
                          </span>
                        </div>
                        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-[var(--text-dimmed)]">
                          {run.run_id}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {selectedRunId && (
                  <section className="mt-6 border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] p-6">
                    <h3
                      className="m-0 mb-4 text-lg text-[var(--text-primary)]"
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {t("loopsJudgmentTitle")}
                    </h3>
                    {detailLoading ? (
                      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                        {t("loopsLoading")}
                      </p>
                    ) : !runDetail ? (
                      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                        {t("loopsNoJudgment")}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-[var(--space-2)] [font-size:var(--font-size-sm)]">
                        {!judgment &&
                          (runDetail.run.state === "active" ||
                            runDetail.run.state === "retry") && (
                            <p className="m-0 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-3 text-[var(--text-muted)]">
                              {t("loopsJudgmentPending")}
                            </p>
                          )}
                        {(runDetail.run.state === "paused" ||
                          runDetail.run.state === "needs_human" ||
                          runDetail.run.state === "budget_limited") && (
                          <p className="m-0 rounded-[var(--radius-sm)] border border-[var(--warning-color)]/40 bg-[var(--warning-color)]/10 p-3 text-[var(--warning-color)]">
                            {t("loopsRunBlocked", {
                              state: runDetail.run.state,
                              reason:
                                runDetail.ledger_summary.last_decision
                                  ?.reason ?? "—",
                            })}
                          </p>
                        )}
                        {runDetail.run.state !== "discarded" && (
                          <button
                            type="button"
                            className="self-end rounded-md border border-[var(--error-color)]/50 bg-[var(--error-color)]/10 px-4 py-2 text-sm font-medium text-[var(--error-color)] transition-opacity hover:opacity-90 disabled:opacity-50"
                            onClick={() => void handleDiscardRun()}
                            disabled={discarding}
                          >
                            {discarding ? "Discarding..." : "Discard run"}
                          </button>
                        )}
                        <div className="flex items-start justify-between gap-[var(--space-3)]">
                          <span className="shrink-0 text-[var(--text-muted)]">
                            {t("loopsJudgmentOverall")}
                          </span>
                          <span className="break-all text-right text-[var(--text-primary)]">
                            {judgment?.overall ?? "—"}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-[var(--space-3)]">
                          <span className="shrink-0 text-[var(--text-muted)]">
                            {t("loopsJudgmentNextAction")}
                          </span>
                          <span className="break-all text-right text-[var(--text-primary)]">
                            {judgment?.next_action ?? "—"}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-[var(--space-3)]">
                          <span className="shrink-0 text-[var(--text-muted)]">
                            {t("loopsJudgmentTurns")}
                          </span>
                          <span className="text-right text-[var(--text-primary)]">
                            {runDetail.ledger_summary.turns_used} /{" "}
                            {runDetail.ledger_summary.max_turns ?? "—"}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-[var(--space-3)]">
                          <span className="shrink-0 text-[var(--text-muted)]">
                            {t("loopsJudgmentRetries")}
                          </span>
                          <span className="text-right text-[var(--text-primary)]">
                            {runDetail.ledger_summary.retries_used} /{" "}
                            {runDetail.ledger_summary.max_retries ?? "—"}
                          </span>
                        </div>
                        {collectorReportRef && (
                          <div className="flex items-start justify-between gap-[var(--space-3)]">
                            <span className="shrink-0 text-[var(--text-muted)]">
                              Collector
                            </span>
                            <span className="break-all text-right font-mono text-xs text-[var(--text-primary)]">
                              {collectorReportRef}
                            </span>
                          </div>
                        )}
                        {handoffRef && (
                          <div className="flex items-start justify-between gap-[var(--space-3)]">
                            <span className="shrink-0 text-[var(--text-muted)]">
                              Handoff
                            </span>
                            <span className="break-all text-right font-mono text-xs text-[var(--text-primary)]">
                              {handoffRef}
                            </span>
                          </div>
                        )}
                        {blockerFingerprint && (
                          <div className="flex items-start justify-between gap-[var(--space-3)]">
                            <span className="shrink-0 text-[var(--text-muted)]">
                              Blocker
                            </span>
                            <span className="break-all text-right font-mono text-xs text-[var(--text-primary)]">
                              {blockerFingerprint}
                              {repeatedBlockerCount > 0
                                ? ` (${repeatedBlockerCount})`
                                : ""}
                            </span>
                          </div>
                        )}
                        {repeatedBlockerCount > 1 && (
                          <p className="m-0 rounded-[var(--radius-sm)] border border-[var(--warning-color)]/40 bg-[var(--warning-color)]/10 p-3 text-[var(--warning-color)]">
                            Approve is likely to repeat the same blocker. Use
                            request changes with new instructions or change the
                            environment first.
                          </p>
                        )}
                        {failureTags.length > 0 && (
                          <div className="flex flex-wrap items-center gap-[var(--space-2)] pt-1">
                            <span className="text-[var(--text-muted)]">
                              {t("loopsFailureTags")}
                            </span>
                            {failureTags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-[var(--radius-sm)] bg-[var(--error-color)]/15 px-2 py-0.5 text-xs font-medium text-[var(--error-color)]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="mt-4 border-t border-[var(--border-color)] pt-4">
                          <h4 className="m-0 mb-3 [font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                            Stream Output
                          </h4>
                          <RunStreamOutput
                            key={selectedRunId}
                            runId={selectedRunId}
                            isActive={
                              runDetail?.run.state === "active" ||
                              runDetail?.run.state === "retry"
                            }
                            sessionRef={runDetail?.session_ref ?? null}
                          />
                        </div>

                        {runTurns.length > 0 && (
                          <div className="mt-4 border-t border-[var(--border-color)] pt-4">
                            <div className="mb-3 flex items-center justify-between gap-2">
                              <h4 className="m-0 [font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                                Turn History
                              </h4>
                              <button
                                type="button"
                                className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)]"
                                onClick={() => setTurnsOpen((open) => !open)}
                              >
                                {turnsOpen ? "Hide turns" : "Show turns"}
                              </button>
                            </div>
                            {turnsOpen && (
                              <div className="flex flex-col gap-2">
                                {runTurns.map((turn) => (
                                  <div
                                    key={turn.turn}
                                    className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-3"
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-mono [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                                        turn {turn.turn}
                                      </span>
                                      <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                                        {turn.decision ?? turn.status}
                                      </span>
                                      {turn.source && (
                                        <span className="text-xs text-[var(--text-muted)]">
                                          {turn.source}
                                        </span>
                                      )}
                                      <span className="text-xs text-[var(--text-muted)]">
                                        {formatTime(turn.created_at)}
                                      </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {artifactNameFromRef(turn.stdout_ref) && (
                                        <button
                                          type="button"
                                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs font-mono text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)]"
                                          onClick={() =>
                                            void handleSelectArtifact(
                                              artifactNameFromRef(
                                                turn.stdout_ref,
                                              ) ?? "",
                                            )
                                          }
                                        >
                                          stdout
                                        </button>
                                      )}
                                      {artifactNameFromRef(
                                        turn.judgment_ref,
                                      ) && (
                                        <button
                                          type="button"
                                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs font-mono text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)]"
                                          onClick={() =>
                                            void handleSelectArtifact(
                                              artifactNameFromRef(
                                                turn.judgment_ref,
                                              ) ?? "",
                                            )
                                          }
                                        >
                                          judgment
                                        </button>
                                      )}
                                      {artifactNameFromRef(
                                        turn.executor_summary_ref,
                                      ) && (
                                        <button
                                          type="button"
                                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs font-mono text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)]"
                                          onClick={() =>
                                            void handleSelectArtifact(
                                              artifactNameFromRef(
                                                turn.executor_summary_ref,
                                              ) ?? "",
                                            )
                                          }
                                        >
                                          summary
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {artifacts.length > 0 && (
                          <div className="mt-4 border-t border-[var(--border-color)] pt-4">
                            <h4 className="m-0 mb-3 [font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                              Artifacts
                            </h4>
                            <div className="flex flex-wrap gap-[var(--space-2)]">
                              {artifacts.map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() =>
                                    void handleSelectArtifact(name)
                                  }
                                  className={`rounded-[var(--radius-sm)] border px-3 py-1.5 [font-size:var(--font-size-xs)] font-mono transition-colors ${
                                    selectedArtifact === name
                                      ? "border-[var(--accent-rust)] bg-[var(--accent-rust)]/10 text-[var(--accent-rust)]"
                                      : "border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:border-[var(--border-hover)]"
                                  }`}
                                >
                                  {name}
                                </button>
                              ))}
                            </div>

                            {selectedArtifact && (
                              <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-primary)] p-4">
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="font-mono [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                                    {selectedArtifact}
                                  </span>
                                  {artifactLoading && (
                                    <span className="[font-size:var(--font-size-xs)] italic text-[var(--text-muted)]">
                                      loading...
                                    </span>
                                  )}
                                </div>
                                <pre className="m-0 max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-secondary)] p-3 [font-size:var(--font-size-xs)] text-[var(--text-primary)]">
                                  {artifactContent ?? "—"}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
