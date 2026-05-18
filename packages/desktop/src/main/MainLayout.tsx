import { useEffect, useState } from "react";
import { renderDesktopClient } from "@yep-anywhere/client/desktop";
import {
  getDesktopToken,
  getServerError,
  getServerPort,
  getServerStatus,
  onDesktopServerRestartFinished,
  onDesktopServerRestartStarted,
} from "../tauri";

const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const HEALTH_STARTUP_TIMEOUT_MS = 30000;

export function MainLayout() {
  const [serverStatus, setServerStatus] = useState<string>("checking");
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartTick, setRestartTick] = useState(0);

  useEffect(() => {
    let cleanupStarted: (() => void) | undefined;
    let cleanupFinished: (() => void) | undefined;

    onDesktopServerRestartStarted(() => {
      setError(null);
      setPort(null);
      setServerStatus("starting");
    }).then((unlisten) => {
      cleanupStarted = unlisten;
    });

    onDesktopServerRestartFinished((restartError) => {
      if (restartError) {
        setError(restartError);
        setServerStatus("error");
        return;
      }
      setError(null);
      setPort(null);
      setServerStatus("running");
      setRestartTick((tick) => tick + 1);
    }).then((unlisten) => {
      cleanupFinished = unlisten;
    });

    return () => {
      cleanupStarted?.();
      cleanupFinished?.();
    };
  }, []);

  useEffect(() => {
    const check = () => {
      getServerStatus()
        .then((s) => {
          console.log("[Desktop] Server status:", s);
          setServerStatus(s);
        })
        .catch((e) => {
          console.error("[Desktop] getServerStatus failed:", e);
          setServerStatus("error");
          setError(String(e));
        });
    };
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (serverStatus === "running" || serverStatus === "starting") {
      if (error != null) {
        console.log("[Desktop] Clearing startup error while server is active");
      }
      setError(null);
      return;
    }

    if (serverStatus !== "error") {
      return;
    }

    getServerError()
      .then((message) => {
        console.error("[Desktop] Server startup error:", message);
        setError(message ?? "Server failed to start");
      })
      .catch((fetchError) => {
        console.error("[Desktop] Failed to read server error:", fetchError);
        setError(String(fetchError));
      });
  }, [serverStatus, error]);

  // Fetch the active port from server state once it's running
  useEffect(() => {
    if (serverStatus !== "running") {
      setPort(null);
      return;
    }
    if (port != null) return;

    const poll = async () => {
      for (let i = 0; i < 50; i++) {
        const p = await getServerPort();
        if (p != null) {
          console.log("[Desktop] Server port:", p);
          setPort(p);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      console.warn("[Desktop] Timed out waiting for server port");
    };
    poll();
  }, [serverStatus, port, restartTick]);

  // Poll /health, then mount the client app
  useEffect(() => {
    if (serverStatus !== "running" || port == null) return;

    let cancelled = false;
    const bootstrap = async () => {
      const serverOrigin = `http://127.0.0.1:${port}`;
      // Wait for HTTP server to be ready
      let healthOk = false;
      const startedAt = Date.now();
      while (!cancelled) {
        if (Date.now() - startedAt >= HEALTH_STARTUP_TIMEOUT_MS) {
          setError("Server health check timed out during startup");
          return;
        }

        const controller = new AbortController();
        const requestTimeout = setTimeout(
          () => controller.abort(),
          HEALTH_REQUEST_TIMEOUT_MS,
        );
        try {
          const res = await fetch(`${serverOrigin}/health`, {
            signal: controller.signal,
          });
          if (res.ok) {
            console.log("[Desktop] Health check OK");
            healthOk = true;
            break;
          }
          console.log("[Desktop] Health check not OK:", res.status);
        } catch (e) {
          console.log("[Desktop] Health check failed:", e);
        } finally {
          clearTimeout(requestTimeout);
        }
        await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
      }
      if (cancelled || !healthOk) return;

      // Fetch desktop auth token and inject globals
      try {
        const token = await getDesktopToken();
        window.__YEP_SERVER_URL__ = serverOrigin;
        if (token) {
          window.__DESKTOP_TOKEN__ = token;
        }
        console.log("[Desktop] Injected server URL and token");
      } catch {
        window.__YEP_SERVER_URL__ = serverOrigin;
        console.log("[Desktop] Injected server URL (no token)");
      }

      // Mount the client app
      try {
        const rootEl = document.getElementById("root");
        if (!rootEl) {
          throw new Error("Root element not found");
        }
        console.log("[Desktop] Mounting client app...");
        renderDesktopClient(rootEl);
        console.log("[Desktop] Client app mounted");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Desktop] Failed to mount client app:", e);
        setError(msg);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [serverStatus, port, restartTick]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center text-[var(--wizard-error,#ff4444)]"
      >
        <div>Failed to load app: {error}</div>
        <div className="text-sm text-[var(--wizard-text-secondary)]"
        >
          Server running on port {port}. Check DevTools (Ctrl+Shift+I) for details.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center text-[var(--wizard-text-secondary)]"
    >
      {serverStatus === "error"
        ? error ?? "Server failed to start. Use tray menu to restart."
        : serverStatus === "starting" || serverStatus === "checking"
          ? "Starting server..."
          : "Waiting for server startup..."}
    </div>
  );
}
