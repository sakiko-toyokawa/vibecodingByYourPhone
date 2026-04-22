import { useEffect } from "react";
import { useInboxContext } from "../contexts/InboxContext";

// Regex to match and strip existing badge prefix like "(3) "
const BADGE_PREFIX_REGEX = /^\(\d+\)\s*/;

/**
 * Hook that monitors the global inbox "needs attention" count and updates
 * the browser tab title with a badge prefix like "(3) ".
 *
 * This hook works independently of useDocumentTitle - it observes title changes
 * and prepends/updates the badge as needed.
 *
 * Uses InboxContext for data - no independent fetching.
 */
export function useNeedsAttentionBadge() {
  const { totalNeedsAttention: count } = useInboxContext();

  // Update document title when count changes
  useEffect(() => {
    // Track if we're currently updating to avoid observer loop
    let isUpdating = false;

    const updateTitle = () => {
      isUpdating = true;
      // Strip any existing badge prefix
      const baseTitle = document.title.replace(BADGE_PREFIX_REGEX, "");

      if (count > 0) {
        document.title = `(${count}) ${baseTitle}`;
      } else {
        document.title = baseTitle;
      }
      // Use setTimeout to reset flag after current mutation cycle completes
      setTimeout(() => {
        isUpdating = false;
      }, 0);
    };

    updateTitle();

    // Also observe title changes from useDocumentTitle and re-apply badge
    const observer = new MutationObserver(() => {
      // Skip if we're the ones who triggered the change
      if (isUpdating) return;

      // Check if the badge needs to be (re)applied
      const currentTitle = document.title;
      const hasCorrectBadge =
        count > 0
          ? currentTitle.startsWith(`(${count}) `)
          : !BADGE_PREFIX_REGEX.test(currentTitle);

      if (!hasCorrectBadge) {
        updateTitle();
      }
    });

    const titleElement = document.querySelector("title");
    if (titleElement) {
      observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return () => {
      observer.disconnect();
      // Clean up badge on unmount
      document.title = document.title.replace(BADGE_PREFIX_REGEX, "");
    };
  }, [count]);

  return count;
}
