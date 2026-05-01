import { Link } from "react-router-dom";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { type ProcessInfo, useProcesses } from "../hooks/useProcesses";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

/**
 * Format uptime duration from start time to now.
 */
function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Get a display label for the process state.
 */
function getStateLabel(state: string, t: (key: never) => string): string {
  switch (state) {
    case "running":
      return t("agentsRunning" as never);
    case "waiting-input":
      return t("agentsNeedsInput" as never);
    case "idle":
      return t("agentsIdle" as never);
    case "terminated":
      return t("agentsStopped" as never);
    default:
      return state;
  }
}

/**
 * Get CSS class for state badge.
 */
function getStateBadgeClass(state: string): string {
  switch (state) {
    case "running":
      return "bg-[var(--status-badge-running-bg)] text-[var(--status-badge-running-text)]";
    case "waiting-input":
      return "bg-[var(--status-badge-input-bg)] text-[var(--status-badge-input-text)]";
    case "idle":
      return "bg-[var(--status-badge-idle-bg)] text-[var(--status-badge-idle-text)]";
    case "terminated":
      return "bg-[var(--bg-hover)] text-[var(--text-muted)]";
    default:
      return "";
  }
}

/**
 * Get display name for provider.
 */
function getProviderLabel(
  provider: string | undefined,
  t: (key: never) => string,
): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "local":
      return t("agentsProviderLocal" as never);
    default:
      return provider ?? "Claude";
  }
}

/**
 * Get CSS class for provider badge.
 */
function getProviderBadgeClass(provider: string | undefined): string {
  switch (provider) {
    case "codex":
      return "bg-gradient-to-br from-[#10a37f] to-[#14b8a6] text-white";
    case "gemini":
      return "bg-gradient-to-br from-[#4f46e5] to-[#7c3aed] text-white";
    case "local":
      return "bg-gradient-to-br from-[#6b7280] to-[#9ca3af] text-white";
    default:
      return "bg-gradient-to-br from-[#d97706] to-[#f59e0b] text-white";
  }
}

interface ProcessCardProps {
  process: ProcessInfo;
  isTerminated?: boolean;
}

function ProcessCard({ process, isTerminated = false }: ProcessCardProps) {
  const { t } = useI18n();
  return (
    <Link
      to={`/projects/${process.projectId}/sessions/${process.sessionId}`}
      className={`block w-full border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] p-6 text-left no-underline text-inherit transition-[border-color] duration-150 hover:border-[var(--border-hover)] ${isTerminated ? "border-dashed opacity-70" : ""}`}
    >
      <div className="flex flex-col gap-[var(--space-1)]">
        <div className="flex min-w-0 items-center gap-[var(--space-2)]">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[var(--text-primary)]">
            {process.sessionTitle || t("agentsUntitled" as never)}
          </span>
          <span
            className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-semibold uppercase tracking-wider ${getProviderBadgeClass(process.provider)}`}
          >
            {getProviderLabel(process.provider, t)}
          </span>
          {process.state === "in-turn" ? (
            <ThinkingIndicator
              variant="pill"
              label={t("agentsRunning" as never)}
            />
          ) : (
            <span
              className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium ${getStateBadgeClass(process.state)}`}
            >
              {getStateLabel(process.state, t)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {process.projectName}
          </span>
          {!isTerminated && (
            <span className="shrink-0 [font-size:var(--font-size-sm)] font-mono text-[var(--text-muted)]">
              {formatUptime(process.startedAt)}
            </span>
          )}
          {process.contextUsage && (
            <ContextUsageIndicator usage={process.contextUsage} />
          )}
        </div>
      </div>

      {(process.permissionMode ||
        process.queueDepth > 0 ||
        process.terminationReason) && (
        <div className="mt-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-3)]">
          {process.permissionMode && (
            <div className="flex items-start justify-between gap-[var(--space-3)] py-[var(--space-1)]">
              <span className="shrink-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("agentsPermissionMode" as never)}
              </span>
              <span className="break-all text-right [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                {process.permissionMode}
              </span>
            </div>
          )}
          {process.queueDepth > 0 && (
            <div className="flex items-start justify-between gap-[var(--space-3)] py-[var(--space-1)]">
              <span className="shrink-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("agentsMessagesQueued" as never)}
              </span>
              <span className="break-all text-right [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                {process.queueDepth}
              </span>
            </div>
          )}
          {process.terminationReason && (
            <div className="flex items-start justify-between gap-[var(--space-3)] py-[var(--space-1)]">
              <span className="shrink-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("agentsStopReason" as never)}
              </span>
              <span className="break-all text-right [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                {process.terminationReason}
              </span>
            </div>
          )}
        </div>
      )}
    </Link>
  );
}

export function AgentsPage() {
  const { t } = useI18n();
  const { processes, terminatedProcesses, loading, error } = useProcesses();

  const { openSidebar, isWideScreen } = useNavigationLayout();

  // Split processes into active (in-turn/waiting-input) and idle
  const activeProcesses = processes.filter(
    (p) => p.state === "in-turn" || p.state === "waiting-input",
  );
  const idleProcesses = processes.filter((p) => p.state === "idle");

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
          title={t("agentsTitle" as never)}
          onOpenSidebar={openSidebar}
        />

        <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
          <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
            {loading && (
              <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                {t("agentsLoading" as never)}
              </p>
            )}

            {error && (
              <p className="p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                {t("agentsError" as never, { message: error.message })}
              </p>
            )}

            {!loading && !error && (
              <>
                <section className="mb-12">
                  <h2
                    className="m-0 mb-4 text-[2rem] text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {t("agentsSectionActive" as never)}
                  </h2>
                  {activeProcesses.length === 0 ? (
                    <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                      {t("agentsEmptyActive" as never)}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-[var(--space-2)]">
                      {activeProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="mb-12">
                  <h2
                    className="m-0 mb-4 text-[2rem] text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {t("agentsSectionIdle" as never)}
                  </h2>
                  {idleProcesses.length === 0 ? (
                    <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                      {t("agentsEmptyIdle" as never)}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-[var(--space-2)]">
                      {idleProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="mb-12">
                  <h2
                    className="m-0 mb-4 text-[2rem] text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {t("agentsSectionStopped" as never)}
                  </h2>
                  {terminatedProcesses.length === 0 ? (
                    <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                      {t("agentsEmptyStopped" as never)}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-[var(--space-2)]">
                      {terminatedProcesses.map((process) => (
                        <ProcessCard
                          key={process.id}
                          process={process}
                          isTerminated
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
