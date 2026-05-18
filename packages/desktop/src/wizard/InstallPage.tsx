import { useEffect, useState } from "react";
import {
  installYepServer,
  installClaude,
  installCodex,
  installGemini,
  checkAgentInstalled,
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
    if (agents.includes("gemini")) {
      t.push({ id: "gemini", label: "Gemini CLI", status: "pending" });
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
        for (const agent of agents) {
          const installed = await checkAgentInstalled(agent);
          if (installed) {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === agent
                  ? { ...t, status: "done", message: "Already installed" }
                  : t,
              ),
            );
            continue;
          }
          if (agent === "claude") {
            await installClaude();
          } else if (agent === "codex") {
            await installCodex();
          } else if (agent === "gemini") {
            await installGemini();
          }
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
        return "text-[var(--wizard-text-secondary)]";
      case "installing":
        return "text-[var(--wizard-accent)]";
      case "done":
        return "text-[var(--wizard-success)]";
      case "error":
        return "text-[var(--wizard-error)]";
    }
  };

  return (
    <div className="w-full max-w-[400px]">
      <h2 className="mb-2 text-[22px] font-semibold">
        Setting things up
      </h2>
      <p className="mb-6 text-sm text-[var(--wizard-text-secondary)]">
        Installing your selected agents. This may take a minute.
      </p>

      <div className="mb-8 flex flex-col gap-4">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-3">
            <span
              className={`w-6 text-center text-lg ${statusColor(task.status)}`}
            >
              {statusIcon(task.status)}
            </span>
            <div>
              <div className="font-medium">{task.label}</div>
              {task.message && (
                <div className="text-xs text-[var(--wizard-text-secondary)]">
                  {task.message}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-[var(--wizard-error)] bg-[rgba(239,68,68,0.1)] p-3 text-[13px] text-[var(--wizard-error)]">
          {error}
        </div>
      )}

      <button
        className="btn-primary w-full"
        onClick={onNext}
        disabled={!allDone}
      >
        {allDone ? "Continue" : "Installing..."}
      </button>
    </div>
  );
}
