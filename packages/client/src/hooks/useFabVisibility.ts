import { useMemo } from "react";
import {
  DESKTOP_BREAKPOINT,
  SIDEBAR_COLLAPSED_WIDTH,
  getSidebarWidth,
} from "./useSidebarWidth";
import { useViewportWidth } from "./useViewportWidth";

// Layout constants
const CONTENT_MAX_WIDTH = 830; // Matches .main-content-constrained max-width
const FAB_MIN_WIDTH = 100; // Minimum width for the FAB input
const FAB_MARGIN = 24; // Breathing room around FAB
const FAB_BOTTOM_OFFSET = 80; // Distance from bottom - positioned just below message input area

/**
 * Calculate the right margin available for the FAB.
 * Content is centered, so right margin = (viewport - sidebar - content) / 2
 */
function calculateRightMargin(
  viewportWidth: number,
  sidebarWidth: number,
): number {
  const contentAreaWidth = viewportWidth - sidebarWidth;
  const effectiveContentWidth = Math.min(contentAreaWidth, CONTENT_MAX_WIDTH);
  return (contentAreaWidth - effectiveContentWidth) / 2;
}

/**
 * Hook that determines FAB visibility and positioning.
 * Returns null if FAB shouldn't be shown, or position/size info if it should.
 */
export function useFabVisibility(): {
  visible: boolean;
  right: number;
  bottom: number;
  maxWidth: number;
} | null {
  const viewportWidth = useViewportWidth();

  return useMemo(() => {
    // Never show on mobile/tablet
    if (viewportWidth < DESKTOP_BREAKPOINT) {
      return null;
    }

    // Get current sidebar width (could be collapsed or expanded)
    const sidebarWidth = getSidebarWidth();

    // Check if sidebar would be collapsed at this viewport width
    // Sidebar collapses when: viewportWidth < sidebarWidth + MIN_CONTENT_WIDTH (600)
    const wouldSidebarCollapse = viewportWidth < sidebarWidth + 600;
    const effectiveSidebarWidth = wouldSidebarCollapse
      ? SIDEBAR_COLLAPSED_WIDTH
      : sidebarWidth;

    // Calculate available right margin
    const rightMargin = calculateRightMargin(
      viewportWidth,
      effectiveSidebarWidth,
    );

    // Need enough space for FAB + margins on both sides
    const requiredSpace = FAB_MIN_WIDTH + FAB_MARGIN * 2;
    if (rightMargin < requiredSpace) {
      return null;
    }

    // Calculate FAB positioning
    // Position it in the right margin, with some padding from edges
    const fabRight = FAB_MARGIN;
    const fabMaxWidth = Math.min(rightMargin - FAB_MARGIN * 2, 300); // Cap at 300px

    return {
      visible: true,
      right: fabRight,
      bottom: FAB_BOTTOM_OFFSET,
      maxWidth: fabMaxWidth,
    };
  }, [viewportWidth]);
}
