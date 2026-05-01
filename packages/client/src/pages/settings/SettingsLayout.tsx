import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  getDevelopmentCategory,
  getEmulatorCategory,
  getSettingsCategories,
} from "../../i18n-settings";
import { useNavigationLayout } from "../../layouts";
import { AboutSettings } from "./AboutSettings";
import { AgentContextSettings } from "./AgentContextSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DevelopmentSettings } from "./DevelopmentSettings";
import { DevicesSettings } from "./DevicesSettings";
import { EmulatorSettings } from "./EmulatorSettings";
import { LifecycleWebhooksSettings } from "./LifecycleWebhooksSettings";
import { LocalAccessSettings } from "./LocalAccessSettings";
import { ModelSettings } from "./ModelSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { RemoteExecutorsSettings } from "./RemoteExecutorsSettings";
import type { SettingsCategory } from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: AppearanceSettings,
  model: ModelSettings,
  "agent-context": AgentContextSettings,
  notifications: NotificationsSettings,
  webhooks: LifecycleWebhooksSettings,
  devices: DevicesSettings,
  "local-access": LocalAccessSettings,
  remote: RemoteAccessSettings,
  providers: ProvidersSettings,
  "remote-executors": RemoteExecutorsSettings,
  emulator: EmulatorSettings,
  about: AboutSettings,
  development: DevelopmentSettings,
};

interface SettingsCategoryItemProps {
  category: SettingsCategory;
  isActive: boolean;
  onClick: () => void;
}

function SettingsCategoryItem({
  category,
  isActive,
  onClick,
}: SettingsCategoryItemProps) {
  return (
    <button
      type="button"
      className={`flex w-full cursor-pointer py-1.5 text-left text-[13px] transition-colors duration-150 ${
        isActive
          ? "text-[var(--accent-rust)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
      onClick={onClick}
    >
      <span className="truncate">{category.label}</span>
    </button>
  );
}

function SettingsNavList({
  categories,
  activeCategory,
  onCategoryClick,
  title,
}: {
  categories: SettingsCategory[];
  activeCategory?: string;
  onCategoryClick: (id: string) => void;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h1
          className="text-3xl text-[var(--text-primary)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {title}
        </h1>
      </div>
      <div className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-[var(--text-muted)]">
        {t("settingsConfigurationLabel")}
      </div>
      <div className="flex flex-col gap-0.5">
        {categories.map((cat) => (
          <SettingsCategoryItem
            key={cat.id}
            category={cat}
            isActive={activeCategory === cat.id}
            onClick={() => onCategoryClick(cat.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function SettingsLayout() {
  const { t } = useI18n();
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { isManualReloadMode } = useReloadNotifications();
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];

  // Build the list of categories, conditionally including emulator and dev
  const categories: SettingsCategory[] = [
    ...getSettingsCategories((key) => t(key as never)),
  ];
  if (
    capabilities.includes("deviceBridge") ||
    capabilities.includes("deviceBridge-download") ||
    capabilities.includes("deviceBridge-available")
  ) {
    // Insert before "about"
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(
      aboutIndex >= 0 ? aboutIndex : categories.length,
      0,
      getEmulatorCategory((key) => t(key as never)),
    );
  }
  if (isManualReloadMode) {
    categories.push(getDevelopmentCategory((key) => t(key as never)));
  }

  // On wide screen, default to first category if none selected
  const effectiveCategory =
    category || (isWideScreen ? categories[0]?.id : undefined);

  const handleCategoryClick = (categoryId: string) => {
    navigate(`${basePath}/settings/${categoryId}`);
  };

  const handleBack = () => {
    navigate(`${basePath}/settings`);
  };

  // Get the component for the current category
  const CategoryComponent = effectiveCategory
    ? CATEGORY_COMPONENTS[effectiveCategory]
    : null;

  // Mobile: category list OR category detail (not both)
  if (!isWideScreen) {
    if (!category) {
      // Show category list
      return (
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
            <PageHeader
              title={t("pageTitleSettings")}
              onOpenSidebar={openSidebar}
              onToggleSidebar={toggleSidebar}
              isWideScreen={isWideScreen}
              isSidebarCollapsed={isSidebarCollapsed}
            />
            <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
              <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
                <SettingsNavList
                  categories={categories}
                  onCategoryClick={handleCategoryClick}
                  title={t("pageTitleSettings")}
                />
              </div>
            </main>
          </div>
        </div>
      );
    }

    // Show category detail with back button
    const currentCategory = categories.find((c) => c.id === category);
    return (
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden">
          <PageHeader
            title={currentCategory?.label || t("pageTitleSettings")}
            onOpenSidebar={openSidebar}
            showBack
            onBack={handleBack}
          />
          <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
            <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
              {CategoryComponent && <CategoryComponent />}
            </div>
          </main>
        </div>
      </div>
    );
  }

  // Desktop: two-column layout with category list on left, content on right
  return (
    <div className="flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden">
      <div className="flex h-dvh w-full flex-col">
        <PageHeader
          title={t("pageTitleSettings")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
          <div
            className="flex min-h-0 gap-10 px-6 py-8 md:px-10 md:py-10"
            style={{ maxWidth: "calc(220px + 900px + 40px)" }}
          >
            <nav className="w-[220px] shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] pr-6">
              <SettingsNavList
                categories={categories}
                activeCategory={effectiveCategory}
                onCategoryClick={handleCategoryClick}
                title={t("pageTitleSettings")}
              />
            </nav>
            <div className="min-w-0 max-w-[900px] flex-1 overflow-y-auto">
              {CategoryComponent && <CategoryComponent />}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
