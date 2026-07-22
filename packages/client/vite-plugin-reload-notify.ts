import type { Plugin, ViteDevServer } from "vite";

interface ReloadNotifyOptions {
  /** API endpoint to notify (default: /api/dev/frontend-changed) */
  endpoint?: string;
  /** Whether notifications are enabled (default: true) */
  enabled?: boolean;
}

/**
 * Vite plugin that notifies the backend when frontend files change.
 * Used in manual reload mode (NO_FRONTEND_RELOAD=true) to show a banner
 * instead of auto-reloading.
 */
export function reloadNotify(options: ReloadNotifyOptions = {}): Plugin {
  const { endpoint = "/api/dev/frontend-changed", enabled = true } = options;

  let server: ViteDevServer | null = null;

  return {
    name: "reload-notify",

    configureServer(_server) {
      server = _server;
    },

    handleHotUpdate({ file, modules }) {
      if (!enabled || !server) {
        // Let Vite handle normally (HMR)
        return;
      }

      // Get relative path from project root
      const relativePath = file.replace(`${server.config.root}/`, "");

      // Only notify for source files, not node_modules or dist
      if (
        relativePath.includes("node_modules") ||
        relativePath.includes("dist")
      ) {
        return;
      }

      // Notify the backend about the file change
      const apiPort = process.env.VITE_API_PORT || "3400";
      const url = `http://localhost:${apiPort}${endpoint}`;

      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ files: [relativePath] }),
      }).catch((err) => {
        // Don't crash if backend is down
        console.warn(
          `[reload-notify] Failed to notify backend: ${err.message}`,
        );
      });

      // Return empty array to prevent HMR from updating
      // The user will manually reload instead
      return [];
    },
  };
}
