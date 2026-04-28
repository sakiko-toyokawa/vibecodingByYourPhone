import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  spawnPty,
  writePty,
  resizePty,
  onPtyOutput,
  onPtyExit,
  checkClaudeAuth,
  checkGeminiAuth,
} from "../tauri";

interface Props {
  agents: string[];
  onNext: () => void;
}

const AUTH_AGENTS = ["claude", "gemini"];

export function AuthPage({ agents, onNext }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [started, setStarted] = useState(false);
  const [exited, setExited] = useState(false);
  const [authStatus, setAuthStatus] = useState<Record<string, boolean>>({});
  const [currentAgent, setCurrentAgent] = useState<string | null>(null);

  const relevantAgents = agents.filter((a) => AUTH_AGENTS.includes(a));

  // Check auth status for all relevant agents on mount
  useEffect(() => {
    if (relevantAgents.length === 0) return;

    Promise.all(
      relevantAgents.map(async (agent) => {
        try {
          if (agent === "claude") {
            return await checkClaudeAuth();
          }
          if (agent === "gemini") {
            return await checkGeminiAuth();
          }
          return false;
        } catch {
          return false;
        }
      }),
    ).then((results) => {
      const map: Record<string, boolean> = {};
      relevantAgents.forEach((agent, i) => {
        map[agent] = results[i];
      });
      setAuthStatus(map);
    });
  }, []);

  // Find the next agent that needs auth
  const pendingAgent = relevantAgents.find((a) => !authStatus[a]);
  const allAuthed = relevantAgents.every((a) => authStatus[a]);

  // Terminal setup: recreate when currentAgent changes
  useEffect(() => {
    if (!termRef.current || !currentAgent) return;

    const term = new Terminal({
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
      },
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    terminalRef.current = term;

    // Forward keystrokes to PTY
    term.onData((data) => {
      writePty(data).catch(() => {});
    });

    // Sync PTY size when terminal resizes
    term.onResize(({ cols, rows }) => {
      resizePty(cols, rows).catch(() => {});
    });

    // Listen for PTY output
    const unlistenOutput = onPtyOutput((data) => {
      term.write(data);
    });

    const unlistenExit = onPtyExit(() => {
      setExited(true);
      term.writeln("\r\n[Process exited]");
      if (currentAgent) {
        setAuthStatus((prev) => ({ ...prev, [currentAgent]: true }));
        setCurrentAgent(null);
        setStarted(false);
      }
    });

    // Resize handler
    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(termRef.current);

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, [currentAgent]);

  const startAuth = async () => {
    if (!pendingAgent) return;
    setStarted(true);
    setExited(false);
    setCurrentAgent(pendingAgent);
    try {
      await spawnPty(pendingAgent, ["auth", "login"]);
    } catch (e) {
      terminalRef.current?.writeln(`\r\nError: ${e}`);
    }
  };

  const needsAuth = relevantAgents.length > 0 && !allAuthed;
  const canContinue = !needsAuth || (currentAgent && exited) || allAuthed;

  // UI text based on current state
  let statusText: string;
  if (relevantAgents.length === 0) {
    statusText = "No agents require authentication. You can skip this step.";
  } else if (allAuthed) {
    statusText = "You're already signed in to all agents. You can continue to the next step.";
  } else if (pendingAgent) {
    const name = pendingAgent === "claude" ? "Claude" : "Gemini";
    statusText = `Click the button below, then press Enter in the terminal to open your browser and sign in to ${name}.`;
  } else {
    statusText = "";
  }

  return (
    <div style={{ width: "100%", maxWidth: 700 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Sign in to your agents
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          marginBottom: 16,
        }}
      >
        {statusText}
      </p>

      {/* Auth status list */}
      {relevantAgents.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginBottom: 16,
          }}
        >
          {relevantAgents.map((agent) => (
            <div
              key={agent}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
              }}
            >
              <span
                style={{
                  color: authStatus[agent]
                    ? "var(--success)"
                    : "var(--text-secondary)",
                }}
              >
                {authStatus[agent] ? "●" : "○"}
              </span>
              <span>
                {agent === "claude" ? "Claude Code" : "Gemini CLI"}
                {authStatus[agent] ? " — signed in" : " — not signed in"}
              </span>
            </div>
          ))}
        </div>
      )}

      {needsAuth && pendingAgent && (
        <>
          <div
            ref={termRef}
            style={{
              height: 400,
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid var(--border)",
              marginBottom: 16,
            }}
          />

          {!started && (
            <button
              className="btn-primary"
              onClick={startAuth}
              style={{ width: "100%", marginBottom: 12 }}
            >
              Sign in to {pendingAgent === "claude" ? "Claude" : "Gemini"}
            </button>
          )}
        </>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        {!canContinue && (
          <button
            className="btn-secondary"
            onClick={onNext}
            style={{ flex: 1 }}
          >
            Skip
          </button>
        )}
        <button
          className="btn-primary"
          onClick={onNext}
          disabled={!canContinue && started}
          style={{ flex: 1 }}
        >
          {canContinue ? "Continue" : "Waiting..."}
        </button>
      </div>
    </div>
  );
}
