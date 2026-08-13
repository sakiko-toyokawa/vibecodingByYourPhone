import type { ProviderInfo } from "@yep-anywhere/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  type GitHubCredentialStatus,
  type GitHubRelation,
  type GitHubToolStatus,
  githubApi,
} from "../api/github";
import { type LoopRunSummary, type StoredLoop, loopsApi } from "../api/loops";
import { GitHubRelationCard } from "../components/GitHubRelationCard";
import { PageHeader } from "../components/PageHeader";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import {
  DEFAULT_LOOP_CREATE_FORM,
  type LoopCreateFormState,
  buildLoopCard,
} from "../lib/loopCardBuilder";
import { humanizeDecision, humanizeRelationState } from "../lib/loopHumanText";
import { runStateBadgeClass } from "../lib/loopStateStyle";

interface LoopListEntry {
  loop: StoredLoop;
  /** Latest run (runs are newest-first), undefined when never run or on error */
  lastRun?: LoopRunSummary;
}

function isGithubLoop(loop: StoredLoop): boolean {
  return loop.card.loop.discovery?.source === "github_prompt";
}

function formatTrigger(loop: StoredLoop): string {
  const trigger = loop.card.loop.trigger;
  if (trigger.type === "schedule" && trigger.cron) {
    return trigger.cron;
  }
  return trigger.type;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Loops list page: registered loops with trigger type, latest run state,
 * and creation time. Click a loop to open its detail page.
 */
export function LoopsPage({ mode = "normal" }: { mode?: "normal" | "github" }) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const githubMode = mode === "github";
  const [entries, setEntries] = useState<LoopListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<LoopCreateFormState>(
    DEFAULT_LOOP_CREATE_FORM,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [githubCredential, setGithubCredential] =
    useState<GitHubCredentialStatus | null>(null);
  const [githubToken, setGithubToken] = useState("");
  const [githubTool, setGithubTool] = useState<GitHubToolStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState<"credential" | "tool" | null>(
    null,
  );
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [relations, setRelations] = useState<GitHubRelation[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  const load = useCallback(async () => {
    try {
      const { loops } = await loopsApi.listLoops();
      const visible = loops.filter(
        (loop) =>
          !loop.archived &&
          (mode === "github" ? isGithubLoop(loop) : !isGithubLoop(loop)),
      );
      // Latest run state per loop; a failing runs call must not hide the loop
      const withRuns = await Promise.all(
        visible.map(async (loop): Promise<LoopListEntry> => {
          try {
            const { runs } = await loopsApi.listRuns(loop.id);
            return { loop, lastRun: runs[0] };
          } catch {
            return { loop };
          }
        }),
      );
      setEntries(
        [...withRuns].sort((a, b) =>
          (b.lastRun?.created_at ?? "").localeCompare(
            a.lastRun?.created_at ?? "",
          ),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [mode]);

  const loadRelations = useCallback(async () => {
    try {
      const { relations } = await githubApi.listRelations();
      setRelations(relations);
    } catch {
      setRelations([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    githubApi
      .getCredentialStatus()
      .then(({ credential }) => setGithubCredential(credential))
      .catch(() => setGithubCredential(null));
  }, []);

  useEffect(() => {
    void loadRelations();
  }, [loadRelations]);

  useEffect(() => {
    api
      .getProviders()
      .then(({ providers }) => setProviders(providers))
      .catch(() => setProviders([]));
  }, []);

  const selectedModelProvider = providers.find(
    (provider) => provider.name === createForm.modelProvider,
  );
  const availableModels = selectedModelProvider?.models ?? [];

  const updateCreateForm = useCallback(
    <K extends keyof LoopCreateFormState>(
      key: K,
      value: LoopCreateFormState[K],
    ) => {
      setCreateForm((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const handleCreateLoop = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateError(null);
      const card = buildLoopCard(createForm);
      if (!card.loop.id) {
        setCreateError(t("loopsCreateIdRequired"));
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(card.loop.id)) {
        setCreateError(t("loopsCreateIdInvalid"));
        return;
      }
      if (createForm.kind === "workspace" && !card.loop.workspace.path) {
        setCreateError(t("loopsCreateWorkspaceRequired"));
        return;
      }
      if (!card.loop.handoff?.task) {
        setCreateError(t("loopsCreateTaskRequired"));
        return;
      }
      if (
        card.loop.trigger.type === "schedule" &&
        !card.loop.trigger.cron?.trim()
      ) {
        setCreateError(t("loopsCreateCronRequired"));
        return;
      }

      setCreating(true);
      try {
        const { loop } = await loopsApi.createLoop(card);
        setCreateForm(DEFAULT_LOOP_CREATE_FORM);
        setCreateOpen(false);
        await load();
        navigate(`${basePath}/loops/${encodeURIComponent(loop.id)}`);
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    },
    [basePath, createForm, load, navigate, t],
  );

  const handleSaveGitHubToken = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setGithubError(null);
      setGithubMessage(null);
      if (!githubToken.trim()) {
        setGithubError(t("githubLoopTokenRequired"));
        return;
      }
      setGithubBusy("credential");
      try {
        const { credential } = await githubApi.setCredential(githubToken);
        setGithubCredential(credential);
        setGithubToken("");
        setGithubMessage(t("githubLoopTokenSaved"));
      } catch (err) {
        setGithubError(err instanceof Error ? err.message : String(err));
      } finally {
        setGithubBusy(null);
      }
    },
    [githubToken, t],
  );

  const handleClearGitHubToken = useCallback(async () => {
    setGithubError(null);
    setGithubMessage(null);
    setGithubBusy("credential");
    try {
      const { credential } = await githubApi.clearCredential();
      setGithubCredential(credential);
      setGithubMessage(t("githubLoopTokenCleared"));
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err));
    } finally {
      setGithubBusy(null);
    }
  }, [t]);

  const handleEnsureGh = useCallback(async () => {
    setGithubError(null);
    setGithubMessage(null);
    setGithubBusy("tool");
    try {
      const { tool } = await githubApi.ensureGh();
      setGithubTool(tool);
      setGithubMessage(t("githubLoopToolReady", { version: tool.version }));
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err));
    } finally {
      setGithubBusy(null);
    }
  }, [t]);

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
          title={githubMode ? "GitHub" : t("loopsTitle")}
          onOpenSidebar={openSidebar}
          rightContent={
            <button
              type="button"
              className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
              aria-expanded={createOpen}
              onClick={() => {
                setCreateError(null);
                setCreateForm((current) => ({
                  ...current,
                  kind: githubMode ? "github_prompt" : "workspace",
                }));
                setCreateOpen((open) => !open);
              }}
            >
              {t("loopsCreateOpen")}
            </button>
          }
        />

        <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
          <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
            {githubMode && (
              <section className="mb-6 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6">
                <div className="mb-5 flex flex-col gap-1">
                  <h2
                    className="m-0 text-lg text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {t("githubLoopSetupTitle")}
                  </h2>
                  <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                    {t("githubLoopSetupDescription")}
                  </p>
                </div>

                {githubError && (
                  <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                    {githubError}
                  </p>
                )}
                {githubMessage && (
                  <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--success-color)]/40 bg-[var(--success-color)]/10 p-3 [font-size:var(--font-size-sm)] text-[var(--success-color)]">
                    {githubMessage}
                  </p>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="m-0 [font-size:var(--font-size-sm)] font-semibold text-[var(--text-primary)]">
                          {t("githubLoopCredentialTitle")}
                        </h3>
                        <p className="m-0 mt-1 [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                          {githubCredential?.configured
                            ? t("githubLoopCredentialConfigured", {
                                preview:
                                  githubCredential.tokenPreview ??
                                  t("githubLoopCredentialMasked"),
                              })
                            : t("githubLoopCredentialMissing")}
                        </p>
                      </div>
                      {githubCredential?.configured && (
                        <button
                          type="button"
                          className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                          disabled={githubBusy === "credential"}
                          onClick={() => void handleClearGitHubToken()}
                        >
                          {t("githubLoopTokenClear")}
                        </button>
                      )}
                    </div>
                    <form
                      className="flex flex-col gap-2 sm:flex-row"
                      onSubmit={(event) => void handleSaveGitHubToken(event)}
                    >
                      <input
                        type="password"
                        className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                        value={githubToken}
                        onChange={(event) => setGithubToken(event.target.value)}
                        placeholder={t("githubLoopTokenPlaceholder")}
                        autoComplete="off"
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                        disabled={githubBusy === "credential"}
                      >
                        {githubBusy === "credential"
                          ? t("githubLoopSaving")
                          : t("githubLoopTokenSave")}
                      </button>
                    </form>
                  </div>

                  <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="m-0 [font-size:var(--font-size-sm)] font-semibold text-[var(--text-primary)]">
                          {t("githubLoopToolTitle")}
                        </h3>
                        <p className="m-0 mt-1 break-all [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                          {githubTool
                            ? t("githubLoopToolInstalled", {
                                version: githubTool.version,
                                path: githubTool.path,
                              })
                            : t("githubLoopToolMissing")}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                        disabled={githubBusy === "tool"}
                        onClick={() => void handleEnsureGh()}
                      >
                        {githubBusy === "tool"
                          ? t("githubLoopChecking")
                          : t("githubLoopToolEnsure")}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {githubMode && (
              <section className="mb-6 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6">
                <div className="mb-4">
                  <h2
                    className="m-0 text-lg text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    GitHub Relations
                  </h2>
                  <p className="m-0 mt-1 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                    PRs currently tracked and maintained by GitHub loops.
                  </p>
                </div>
                {relations.length === 0 ? (
                  <p className="m-0 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                    No relations yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {relations.map((relation) => (
                      <GitHubRelationCard
                        key={relation.relation_id}
                        relation={relation}
                        showLoop
                        onChanged={() => void loadRelations()}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {createOpen && (
              <form
                className="mb-6 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6"
                onSubmit={(event) => void handleCreateLoop(event)}
              >
                <div className="mb-5 flex flex-col gap-1">
                  <h2
                    className="m-0 text-lg text-[var(--text-primary)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {t("loopsCreateTitle")}
                  </h2>
                  <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                    {t("loopsCreateDescription")}
                  </p>
                </div>

                {createError && (
                  <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                    {createError}
                  </p>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateKindLabel")}
                    </span>
                    <select
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                      value={createForm.kind}
                      onChange={(event) => {
                        const next = event.target
                          .value as LoopCreateFormState["kind"];
                        setCreateForm((current) =>
                          next === "github_prompt"
                            ? {
                                ...current,
                                kind: next,
                                verifyStatic: false,
                                verifyRuntime: false,
                              }
                            : { ...current, kind: next },
                        );
                      }}
                    >
                      {!githubMode && (
                        <option value="workspace">
                          {t("loopsCreateKindWorkspace")}
                        </option>
                      )}
                      {githubMode && (
                        <option value="github_prompt">
                          {t("loopsCreateKindGithubPrompt")}
                        </option>
                      )}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateModelProviderLabel")}
                    </span>
                    <select
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                      value={createForm.modelProvider}
                      onChange={(event) => {
                        updateCreateForm("modelProvider", event.target.value);
                        updateCreateForm("model", "");
                      }}
                    >
                      <option value="">
                        {t("loopsCreateModelProviderDefault")}
                      </option>
                      {providers.map((provider) => (
                        <option key={provider.name} value={provider.name}>
                          {provider.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateModelLabel")}
                    </span>
                    <select
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)] disabled:opacity-50"
                      value={createForm.model}
                      disabled={!createForm.modelProvider}
                      onChange={(event) =>
                        updateCreateForm("model", event.target.value)
                      }
                    >
                      <option value="">{t("loopsCreateModelDefault")}</option>
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateIdLabel")}
                    </span>
                    <input
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                      value={createForm.id}
                      onChange={(event) =>
                        updateCreateForm("id", event.target.value)
                      }
                      placeholder="daily-repo-check"
                    />
                  </label>

                  {createForm.kind === "workspace" ? (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                          {t("loopsCreateWorkspaceLabel")}
                        </span>
                        <input
                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                          value={createForm.workspacePath}
                          onChange={(event) =>
                            updateCreateForm(
                              "workspacePath",
                              event.target.value,
                            )
                          }
                          placeholder="E:\\projects\\my-app"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                          {t("loopsCreatePolicyModeLabel")}
                        </span>
                        <select
                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                          value={createForm.policyMode}
                          onChange={(event) =>
                            updateCreateForm(
                              "policyMode",
                              event.target
                                .value as LoopCreateFormState["policyMode"],
                            )
                          }
                        >
                          <option value="readonly">
                            {t("loopsCreatePolicyModeReadonly")}
                          </option>
                          <option value="modify">
                            {t("loopsCreatePolicyModeModify")}
                          </option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                          {t("loopsCreateStrategyLabel")}
                        </span>
                        <select
                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                          value={createForm.workspaceStrategy}
                          onChange={(event) =>
                            updateCreateForm(
                              "workspaceStrategy",
                              event.target
                                .value as LoopCreateFormState["workspaceStrategy"],
                            )
                          }
                        >
                          <option value="direct">
                            {t("loopsCreateStrategyDirect")}
                          </option>
                          <option value="worktree">
                            {t("loopsCreateStrategyWorktree")}
                          </option>
                        </select>
                      </label>
                    </>
                  ) : (
                    <div className="flex flex-col justify-end gap-1 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2">
                      <span className="[font-size:var(--font-size-xs)] font-medium text-[var(--text-muted)]">
                        {t("loopsCreateManagedWorkspaceLabel")}
                      </span>
                      <span className="break-all font-mono [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                        {t("loopsCreateManagedWorkspaceValue", {
                          loopId: createForm.id.trim() || "loop-id",
                        })}
                      </span>
                    </div>
                  )}

                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {createForm.kind === "github_prompt"
                        ? t("loopsCreateGithubPromptLabel")
                        : t("loopsCreateTaskLabel")}
                    </span>
                    <textarea
                      className="min-h-[88px] resize-y rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                      value={createForm.task}
                      onChange={(event) =>
                        updateCreateForm("task", event.target.value)
                      }
                      placeholder={
                        createForm.kind === "github_prompt"
                          ? t("loopsCreateGithubPromptPlaceholder")
                          : t("loopsCreateTaskPlaceholder")
                      }
                    />
                    {createForm.kind === "github_prompt" && (
                      <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                        多子任務計劃每輪推進一個子任務，max_turns 需 ≥ 子任務數
                      </span>
                    )}
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateTriggerLabel")}
                    </span>
                    <select
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                      value={createForm.triggerType}
                      onChange={(event) =>
                        updateCreateForm(
                          "triggerType",
                          event.target
                            .value as LoopCreateFormState["triggerType"],
                        )
                      }
                    >
                      <option value="manual">{t("loopsCreateManual")}</option>
                      <option value="schedule">
                        {t("loopsCreateSchedule")}
                      </option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateCronLabel")}
                    </span>
                    <input
                      className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)] disabled:opacity-50"
                      value={createForm.cron}
                      onChange={(event) =>
                        updateCreateForm("cron", event.target.value)
                      }
                      disabled={createForm.triggerType !== "schedule"}
                    />
                  </label>

                  <div className="flex flex-col gap-2">
                    <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                      {t("loopsCreateVerificationLabel")}
                    </span>
                    <label className="flex items-center gap-2 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={createForm.verifyStatic}
                        onChange={(event) =>
                          updateCreateForm("verifyStatic", event.target.checked)
                        }
                      />
                      {t("loopsCreateVerifyStatic")}
                    </label>
                    <label className="flex items-center gap-2 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={createForm.verifyRuntime}
                        onChange={(event) =>
                          updateCreateForm(
                            "verifyRuntime",
                            event.target.checked,
                          )
                        }
                      />
                      {t("loopsCreateVerifyRuntime")}
                    </label>
                    <label className="flex items-center gap-2 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={createForm.verifyInteraction}
                        onChange={(event) =>
                          updateCreateForm(
                            "verifyInteraction",
                            event.target.checked,
                          )
                        }
                      />
                      {t("loopsCreateVerifyInteraction")}
                    </label>
                  </div>

                  {createForm.verifyInteraction && (
                    <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                          {t("loopsCreateInteractionUrlLabel")}
                        </span>
                        <input
                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                          value={createForm.interactionUrl}
                          onChange={(event) =>
                            updateCreateForm(
                              "interactionUrl",
                              event.target.value,
                            )
                          }
                          placeholder="http://localhost:3400"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="[font-size:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                          {t("loopsCreateInteractionStartCommandLabel")}
                        </span>
                        <input
                          className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                          value={createForm.interactionStartCommand}
                          onChange={(event) =>
                            updateCreateForm(
                              "interactionStartCommand",
                              event.target.value,
                            )
                          }
                          placeholder="pnpm dev"
                        />
                      </label>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="flex flex-col gap-1">
                      <span className="[font-size:var(--font-size-xs)] font-medium text-[var(--text-muted)]">
                        {t("loopsCreateMaxTurns")}
                      </span>
                      <input
                        type="number"
                        min="1"
                        className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                        value={createForm.maxTurns}
                        onChange={(event) =>
                          updateCreateForm("maxTurns", event.target.value)
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="[font-size:var(--font-size-xs)] font-medium text-[var(--text-muted)]">
                        {t("loopsCreateMaxRetries")}
                      </span>
                      <input
                        type="number"
                        min="0"
                        className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                        value={createForm.maxRetries}
                        onChange={(event) =>
                          updateCreateForm("maxRetries", event.target.value)
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="[font-size:var(--font-size-xs)] font-medium text-[var(--text-muted)]">
                        {t("loopsCreateMaxTime")}
                      </span>
                      <input
                        type="number"
                        min="1"
                        className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                        value={createForm.maxTimeMinutes}
                        onChange={(event) =>
                          updateCreateForm("maxTimeMinutes", event.target.value)
                        }
                      />
                    </label>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border-color)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    onClick={() => {
                      setCreateOpen(false);
                      setCreateError(null);
                    }}
                    disabled={creating}
                  >
                    {t("loopsCreateCancel")}
                  </button>
                  <button
                    type="submit"
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)] disabled:opacity-50"
                    disabled={creating}
                  >
                    {creating
                      ? t("loopsCreateCreating")
                      : t("loopsCreateSubmit")}
                  </button>
                </div>
              </form>
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

            {!loading && !error && entries.length === 0 && (
              <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                {t("loopsEmpty")}
              </p>
            )}

            {!loading && !error && entries.length > 0 && (
              <div className="flex flex-col gap-[var(--space-2)]">
                {entries.map(({ loop, lastRun }) => {
                  const relation = relations.find(
                    (item) => item.loop_id === loop.id,
                  );
                  const prompt =
                    loop.card.loop.handoff?.task ??
                    loop.card.loop.discovery?.query ??
                    "";
                  return (
                    <Link
                      key={loop.id}
                      to={`${basePath}/loops/${encodeURIComponent(loop.id)}`}
                      className="block w-full border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] p-6 text-left no-underline text-inherit transition-[border-color] duration-150 hover:border-[var(--border-hover)]"
                    >
                      <div className="flex flex-col gap-[var(--space-1)]">
                        <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[var(--text-primary)]">
                            {loop.id}
                          </span>
                          {loop.card.loop.policy ? (
                            <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--warning-color)]/15 px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium text-[var(--warning-color)]">
                              modify
                            </span>
                          ) : (
                            <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium text-[var(--text-muted)]">
                              readonly
                            </span>
                          )}
                          {lastRun && (
                            <span
                              className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium ${runStateBadgeClass(lastRun.state)}`}
                            >
                              {humanizeDecision(lastRun.state)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-1">
                          <span className="[font-size:var(--font-size-sm)] font-mono text-[var(--text-muted)]">
                            {formatTrigger(loop)}
                          </span>
                          <span className="[font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                            {t("loopsCreated", {
                              time: formatTime(loop.created_at),
                            })}
                          </span>
                        </div>
                        {prompt && (
                          <div className="mt-2 line-clamp-3 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-3 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                            {prompt}
                          </div>
                        )}
                        {githubMode && relation && (
                          <div className="mt-1 [font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                            {relation.subject.repository}#
                            {relation.subject.pr_number ?? "?"} ·{" "}
                            {humanizeRelationState(relation.state)} · feedback{" "}
                            {relation.feedback_count}
                          </div>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
