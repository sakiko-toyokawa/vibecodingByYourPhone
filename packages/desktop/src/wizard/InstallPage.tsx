import { useEffect, useState } from "react";
import {
  installYepServer,
  installClaude,
  installCodex,
  onInstallProgress,
  type InstallProgress,
} from "../tauri";

interface Props {
  agents: string[];
  onNext: () => void;
}

interface TaskStatus {
  id: string;
  label: string;
  status: "pending" | "installing" | "done" | "error";
  message?: string;
}

export function InstallPage({ agents, onNext }: Props) {
  const [tasks, setTasks] = useState<TaskStatus[]>(() => {
    const t: TaskStatus[] = [
      { id: "yep", label: "Yep Anywhere Server", status: "pending" },
    ];
    if (agents.includes("claude")) {
      t.push({ id: "claude", label: "Claude Code", status: "pending" });
    }
    if (agents.includes("codex")) {
      t.push({ id: "codex", label: "Codex CLI", status: "pending" });
    }
    return t;
  });
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = onInstallProgress((progress: InstallProgress) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === progress.agent
            ? {
                ...t,
                status: progress.status as TaskStatus["status"],
                message: progress.message,
              }
            : t,
        ),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const allDone = tasks.every((t) => t.status === "done");

  useEffect(() => {
    if (installing) return;
    setInstalling(true);

    (async () => {
      try {
        await installYepServer();
        if (agents.includes("claude")) {
          await installClaude();
        }
        if (agents.includes("codex")) {
          await installCodex();
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  const statusIcon = (status: TaskStatus["status"]) => {
    switch (status) {
      case "pending":
        return "○";
      case "installing":
        return "◐";
      case "done":
        return "●";
      case "error":
        return "✕";
    }
  };

  const statusColor = (status: TaskStatus["status"]) => {
    switch (status) {
      case "pending":
        return "var(--text-secondary)";
      case "installing":
        return "var(--accent)";
      case "done":
        return "var(--success)";
      case "error":
        return "var(--error)";
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: 400 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Setting things up
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          marginBottom: 24,
        }}
      >
        Installing your selected agents. This may take a minute.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          marginBottom: 32,
        }}
      >
        {tasks.map((task) => (
          <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                color: statusColor(task.status),
                fontSize: 18,
                width: 24,
                textAlign: "center",
              }}
            >
              {statusIcon(task.status)}
            </span>
            <div>
              <div style={{ fontWeight: 500 }}>{task.label}</div>
              {task.message && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {task.message}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid var(--error)",
            borderRadius: 8,
            fontSize: 13,
            color: "var(--error)",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <button
        className="btn-primary"
        onClick={onNext}
        disabled={!allDone}
        style={{ width: "100%" }}
      >
        {allDone ? "Continue" : "Installing..."}
      </button>
    </div>
  );
}
