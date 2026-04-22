import { useGlobalActiveAgents } from "../hooks/useGlobalActiveAgents";
import { SidebarIcons, SidebarNavItem } from "./SidebarNavItem";

interface AgentsNavItemProps {
  /** Called when item is clicked (e.g., to close mobile sidebar) */
  onClick?: () => void;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
}

/**
 * Agents navigation item with built-in activity indicator.
 * Use this component instead of manually wiring up SidebarNavItem for agents
 * to ensure consistent behavior across all sidebars.
 */
export function AgentsNavItem({ onClick, basePath }: AgentsNavItemProps) {
  const activeAgentsCount = useGlobalActiveAgents();

  return (
    <SidebarNavItem
      to="/agents"
      icon={SidebarIcons.agents}
      label="Agents"
      onClick={onClick}
      hasActivityIndicator={activeAgentsCount > 0}
      basePath={basePath}
    />
  );
}
