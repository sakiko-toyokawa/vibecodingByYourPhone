import { useEffect, useState } from "react";
import { renderDesktopClient } from "@yep-anywhere/client/desktop";
import {
  getDesktopToken,
  getServerPort,
  getServerStatus,
} from "../tauri";

export function MainLayout() {
  const [serverStatus, setServerStatus] = useState<string>("checking");
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        });
    };
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

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
  }, [serverStatus, port]);

  // Poll /health, then mount the client app
  useEffect(() => {
    if (serverStatus !== "running" || port == null) return;

    let cancelled = false;
    const bootstrap = async () => {
      const serverOrigin = `http://127.0.0.1:${port}`;
      // Wait for HTTP server to be ready
      let healthOk = false;
      while (!cancelled) {
        try {
          const res = await fetch(`${serverOrigin}/health`);
          if (res.ok) {
            console.log("[Desktop] Health check OK");
            healthOk = true;
            break;
          }
          console.log("[Desktop] Health check not OK:", res.status);
        } catch (e) {
          console.log("[Desktop] Health check failed:", e);
        }
        await new Promise((r) => setTimeout(r, 100));
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
  }, [serverStatus, port]);

  if (error) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-danger, #ff4444)",
          padding: "2rem",
          textAlign: "center",
          gap: "1rem",
        }}
      >
        <div>Failed to load app: {error}</div>
        <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
          Server running on port {port}. Check DevTools (Ctrl+Shift+I) for details.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-secondary)",
      }}
    >
      {serverStatus === "error"
        ? "Server error. Use tray menu to restart."
        : "Starting server..."}
    </div>
  );
}
