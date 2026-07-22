/**
 * RemoteLoginModePage - Mode selection for remote client login.
 *
 * Landing page that lets users choose between:
 * - Relay connection (for NAT traversal via public relay server)
 * - Direct connection (for LAN, Tailscale, or direct WS URL)
 */

import { useNavigate } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";

export function RemoteLoginModePage() {
  const navigate = useNavigate();
  const { isAutoResuming } = useRemoteConnection();

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-surface)] p-4">
        <div className="w-full max-w-[360px] p-4">
          <div className="mb-6 flex justify-center">
            <YepAnywhereLogo size="lg" />
          </div>
          <p className="m-0 mb-4 text-center text-base text-[var(--text-muted)]">
            Reconnecting...
          </p>
          <div
            className="text-center text-[var(--text-muted)]"
            data-testid="auto-resume-loading"
          >
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-muted)] border-t-[var(--accent-rust)]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-surface)] p-4">
      <div className="w-full max-w-[360px] p-4">
        <div className="mb-6 flex justify-center">
          <YepAnywhereLogo size="lg" />
        </div>
        <h1
          className="m-0 mb-4 text-center text-[1.75rem] text-[var(--text-primary)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How would you like to connect?
        </h1>

        <div className="my-4 flex flex-col gap-3">
          <button
            type="button"
            className="flex cursor-pointer flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3 text-left transition-[border-color,background] duration-150 hover:border-[var(--accent-rust)] hover:bg-[var(--bg-hover)]"
            onClick={() => navigate("/relay")}
            data-testid="relay-mode-button"
          >
            <span className="text-base font-medium text-[var(--text-primary)]">
              Connect via Relay
            </span>
            <span className="text-sm text-[var(--text-muted)]">
              Use a relay server to connect from anywhere. No port forwarding
              needed.
            </span>
          </button>

          <button
            type="button"
            className="flex cursor-pointer flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3 text-left transition-[border-color,background] duration-150 hover:border-[var(--border-muted)] hover:bg-[var(--bg-hover)]"
            onClick={() => navigate("/direct")}
            data-testid="direct-mode-button"
          >
            <span className="text-base font-medium text-[var(--text-primary)]">
              Direct Connection
            </span>
            <span className="text-sm text-[var(--text-muted)]">
              Connect directly via WebSocket URL. For LAN or Tailscale.
            </span>
          </button>
        </div>

        <p className="mt-3 text-center text-sm text-[var(--text-dimmed)]">
          Most users should choose &quot;Connect via Relay&quot; for the easiest
          setup.
        </p>
      </div>
    </div>
  );
}
