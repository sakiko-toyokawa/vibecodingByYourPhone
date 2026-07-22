import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProject, useProjects } from "../hooks/useProjects";
import { resolvePreferredProjectId } from "../hooks/useRecentProject";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

export function NewSessionPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Get all projects to find default if no projectId specified
  const { projects, loading: projectsLoading } = useProjects();

  // Use the provided projectId, or the preferred recent project when available
  const effectiveProjectId = projectId || resolvePreferredProjectId(projects);

  const {
    project,
    loading: projectLoading,
    error,
  } = useProject(effectiveProjectId ?? undefined);

  // Update browser tab title (must be called unconditionally before any early returns)
  useDocumentTitle(project?.name, t("newSessionTitle"));

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  const loading = projectLoading || projectsLoading;

  // Guard against missing projectId (no projects available)
  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return (
      <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
        {t("newSessionNoProjects")}
      </div>
    );
  }

  // Render loading/error states
  if (loading || error) {
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
            title={t("newSessionTitle")}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="flex-1 overflow-y-auto min-h-0">
            <div className="px-6 py-8 md:px-10 md:py-10 max-w-[1200px] mx-auto">
              {loading ? (
                <div className="text-[var(--text-muted)] italic">
                  {t("newSessionLoading")}
                </div>
              ) : (
                <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
                  {t("newSessionErrorPrefix")} {error?.message}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
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
          title={project?.name ?? t("newSessionTitle")}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="flex-1 overflow-y-auto min-h-0">
          <div className="px-6 py-8 md:px-10 md:py-10 max-w-[1200px] mx-auto">
            {effectiveProjectId && (
              <NewSessionForm projectId={effectiveProjectId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
