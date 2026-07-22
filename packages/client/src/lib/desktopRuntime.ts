export function hasTauriInternals(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (
      window as Window & {
        __TAURI_INTERNALS__?: unknown;
      }
    ).__TAURI_INTERNALS__ !== undefined
  );
}

export function isDesktopTauriApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    hasTauriInternals() &&
    (window as Window & { __DESKTOP_TOKEN__?: string }).__DESKTOP_TOKEN__ !==
      undefined
  );
}

export async function restartDesktopServer(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_server");
}

export async function listenDesktopServerRestartStarted(
  callback: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("desktop://server-restart-started", () => callback());
}

export async function listenDesktopServerRestartFinished(
  callback: (error: string | null) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("desktop://server-restart-finished", (event) =>
    callback(event.payload || null),
  );
}
