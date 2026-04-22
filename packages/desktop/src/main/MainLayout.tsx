import { useEffect, useState } from "react";
import {
  getDesktopToken,
  getServerPort,
  getServerStatus,
} from "../tauri";

export function MainLayout() {
  const [serverStatus, setServerStatus] = useState<string>("checking");
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    const check = () => {
      getServerStatus()
        .then(setServerStatus)
        .catch(() => setServerStatus("error"));
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
          setPort(p);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    poll();
  }, [serverStatus, port]);

  // Poll /health, then navigate webview to server URL
  useEffect(() => {
    if (serverStatus !== "running" || port == null) return;

    let cancelled = false;
    const poll = async () => {
      // Wait for HTTP server to be ready
      while (!cancelled) {
        try {
          const res = await fetch(`http://localhost:${port}/health`);
          if (res.ok) break;
        } catch {
          // Server not ready yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (cancelled) return;

      // Fetch desktop auth token and navigate
      try {
        const token = await getDesktopToken();
        const url = token
          ? `http://localhost:${port}/?desktop_token=${token}`
          : `http://localhost:${port}`;
        window.location.href = url;
      } catch {
        window.location.href = `http://localhost:${port}`;
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [serverStatus, port]);

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
