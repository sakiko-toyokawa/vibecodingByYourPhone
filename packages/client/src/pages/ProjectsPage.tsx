import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { useInboxContext } from "../contexts/InboxContext";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

export function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, refetch } = useProjects();
  const { needsAttention, active } = useInboxContext();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Count needs-attention items per project (client-side filter - free)
  const attentionByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of needsAttention) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [needsAttention]);

  // Count actively-thinking sessions per project (from inbox "active" tier)
  const thinkingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of active) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [active]);

  // Sort projects: those needing attention first, then by recency
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aNeeds = attentionByProject.get(a.id) ?? 0;
      const bNeeds = attentionByProject.get(b.id) ?? 0;

      // Projects needing attention come first
      if (aNeeds > 0 && bNeeds === 0) return -1;
      if (bNeeds > 0 && aNeeds === 0) return 1;

      // Then sort by last activity (most recent first)
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }, [projects, attentionByProject]);

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectPath.trim()) return;

    setAdding(true);
    setAddError(null);

    try {
      const { project } = await api.addProject(newProjectPath.trim());
      await refetch();
      setNewProjectPath("");
      setShowAddForm(false);
      // Navigate to sessions filtered by the new project
      navigate(`${basePath}/sessions?project=${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("projectsAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const isEmpty = !loading && !error && projects.length === 0;
  let content: React.ReactNode;

  if (loading) {
    content = (
      <div className="flex min-h-[50vh] items-center justify-center px-4 py-12 text-center text-[var(--text-muted)]">
        <p className="m-0 text-base italic">{t("projectsLoading")}</p>
      </div>
    );
  } else if (error) {
    content = (
      <div className="px-4 py-8">
        <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
          {t("projectsErrorPrefix")} {error.message}
        </div>
      </div>
    );
  } else if (isEmpty) {
    content = (
      <div className="flex flex-col items-center justify-center px-4 py-24 text-center text-[var(--text-muted)]">
        <span
          className="text-5xl mb-6"
          aria-hidden="true"
          style={{ color: "var(--text-muted)" }}
        >
          &#128193;
        </span>
        <h3
          className="text-2xl text-[var(--text-primary)] mb-3"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("projectsEmptyTitle")}
        </h3>
        <p className="m-0 text-base leading-relaxed">
          {t("projectsEmptyDescription")}
        </p>
      </div>
    );
  } else {
    content = (
      <ul className="list-none m-0 p-0 flex flex-col gap-4">
        {sortedProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            needsAttentionCount={attentionByProject.get(project.id) ?? 0}
            thinkingCount={thinkingByProject.get(project.id) ?? 0}
            basePath={basePath}
          />
        ))}
      </ul>
    );
  }

  return (
    <div
      className={
        isWideScreen
          ? "flex justify-center min-w-0 h-[100dvh] overflow-hidden"
          : "flex-1 flex flex-col min-h-0"
      }
    >
      <div
        className={
          isWideScreen
            ? "w-full flex flex-col h-[100dvh]"
            : "flex-1 flex flex-col min-h-0"
        }
      >
        <PageHeader
          title={t("pageTitleProjects")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="flex-1 overflow-y-auto min-h-0">
          <div className="px-6 py-8 md:px-10 md:py-10 max-w-[1200px] mx-auto">
            {/* Toolbar with Add Project button */}
            <div className="flex justify-end gap-2 mb-6">
              {!showAddForm ? (
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] text-sm cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setShowAddForm(true)}
                >
                  <span aria-hidden="true">+</span>
                  {t("projectsAdd")}
                </button>
              ) : (
                <form
                  onSubmit={handleAddProject}
                  className="flex-1 flex flex-col gap-2"
                >
                  <input
                    type="text"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    placeholder={t("projectsAddPlaceholder")}
                    disabled={adding}
                    className="px-3 py-2 border border-[var(--border-input)] rounded-[var(--radius-md)] bg-[var(--bg-input)] text-[var(--text-primary)] text-base focus:outline-none focus:border-[var(--focus-border)]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={adding || !newProjectPath.trim()}
                      className="px-3 py-2 border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {adding ? t("projectsAdding") : t("projectsAddConfirm")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(false);
                        setNewProjectPath("");
                        setAddError(null);
                      }}
                      disabled={adding}
                      className="px-3 py-2 border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t("projectsCancel")}
                    </button>
                  </div>
                  {addError && (
                    <div className="text-[var(--error-color)] text-sm p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
                      {addError}
                    </div>
                  )}
                </form>
              )}
            </div>

            {content}
          </div>
        </main>
      </div>
    </div>
  );
}
