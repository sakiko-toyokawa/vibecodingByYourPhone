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
} from "../tauri";

interface Props {
  agents: string[];
  onNext: () => void;
}

export function AuthPage({ agents, onNext }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [started, setStarted] = useState(false);
  const [exited, setExited] = useState(false);
  const [alreadyAuthed, setAlreadyAuthed] = useState<boolean | null>(null);

  const hasClaude = agents.includes("claude");

  // Check if already authenticated on mount
  useEffect(() => {
    if (!hasClaude) return;
    checkClaudeAuth()
      .then((authed) => setAlreadyAuthed(authed))
      .catch(() => setAlreadyAuthed(false));
  }, [hasClaude]);

  useEffect(() => {
    if (!termRef.current || alreadyAuthed) return;

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
    });

    // Resize handler
    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(termRef.current);

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [alreadyAuthed]);

  const startAuth = async () => {
    setStarted(true);
    try {
      await spawnPty("claude", ["auth", "login"]);
    } catch (e) {
      terminalRef.current?.writeln(`\r\nError: ${e}`);
    }
  };

  const canContinue = !hasClaude || alreadyAuthed || exited;

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
        {!hasClaude
          ? "No agents require authentication. You can skip this step."
          : alreadyAuthed
            ? "You're already signed in to Claude. You can continue to the next step."
            : "Click the button below, then press Enter in the terminal to open your browser and sign in."}
      </p>

      {hasClaude && !alreadyAuthed && alreadyAuthed !== null && (
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
              Start Sign In
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
