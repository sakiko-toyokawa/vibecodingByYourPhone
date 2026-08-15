import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ActionInbox } from "../components/loop-center/ActionInbox";
import { ActiveRunsBar } from "../components/loop-center/ActiveRunsBar";
import { PipelineBoard } from "../components/loop-center/PipelineBoard";
import { useLoops } from "../hooks/useLoops";
import { useNavigationLayout } from "../layouts";
import { HumanSlaQueuePage } from "./HumanSlaQueuePage";
import { LoopsPage } from "./LoopsPage";
import { MaintenanceTargetsPage } from "./MaintenanceTargetsPage";

type CenterTab = "pipeline" | "loops" | "human" | "maintenance";

const TABS: Array<{ value: CenterTab; label: string }> = [
  { value: "pipeline", label: "Pipeline" },
  { value: "loops", label: "All Loops" },
  { value: "human", label: "Human Queue" },
  { value: "maintenance", label: "Maintenance" },
];

function isCenterTab(value: string | null): value is CenterTab {
  return (
    value === "pipeline" ||
    value === "loops" ||
    value === "human" ||
    value === "maintenance"
  );
}

/**
 * Unified Loop control center. The pipeline tab is the default first view;
 * the other tabs reuse the existing loop pages and keep their own headers
 * and action buttons so no page functionality is lost.
 */
export function LoopCenterPage() {
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: CenterTab = isCenterTab(rawTab) ? rawTab : "pipeline";
  const { entries } = useLoops();

  const selectTab = (next: CenterTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "pipeline") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    setSearchParams(params);
  };

  return (
    <div
      className={
        isWideScreen
          ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
      }
    >
      {tab === "pipeline" && (
        <PageHeader
          title="Loop Center"
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />
      )}
      <div className="sticky top-0 z-20 flex min-w-0 gap-2 overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-surface)] px-4 py-2 md:px-6">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === item.value
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]"
                : "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:border-[var(--border-hover)]"
            }`}
            onClick={() => selectTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <main className="flex-1 min-h-0 w-full overflow-y-auto">
        {tab === "pipeline" && (
          <div className="flex min-h-full min-w-0 flex-col gap-4 p-4 md:p-6">
            <ActionInbox />
            <ActiveRunsBar entries={entries} />
            <PipelineBoard entries={entries} />
          </div>
        )}
        {tab === "loops" && <LoopsPage />}
        {tab === "human" && <HumanSlaQueuePage />}
        {tab === "maintenance" && <MaintenanceTargetsPage />}
      </main>
    </div>
  );
}
