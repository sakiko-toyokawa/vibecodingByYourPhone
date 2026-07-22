import type { DeviceInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { EmulatorNavButtons } from "../components/EmulatorNavButtons";
import { EmulatorStream } from "../components/EmulatorStream";
import { PageHeader } from "../components/PageHeader";
import { useEmulatorSettings } from "../hooks/useEmulatorSettings";
import { useEmulatorStream } from "../hooks/useEmulatorStream";
import { useEmulators } from "../hooks/useEmulators";
import { useVersion } from "../hooks/useVersion";
import { useNavigationLayout } from "../layouts";

const DEVICE_TYPE_ORDER: DeviceInfo["type"][] = [
  "emulator",
  "android",
  "chromeos",
  "ios-simulator",
];

function deviceLabel(device: DeviceInfo): string {
  return device.label || device.avd || device.id;
}

function deviceTypeLabel(type: DeviceInfo["type"]): string {
  switch (type) {
    case "emulator":
      return "Android Emulators";
    case "android":
      return "Android Devices";
    case "chromeos":
      return "ChromeOS Devices";
    case "ios-simulator":
      return "iOS Simulators";
    default:
      return "Devices";
  }
}

function hasAction(device: DeviceInfo, action: "stream" | "start" | "stop") {
  if (device.actions?.length) {
    return device.actions.includes(action);
  }

  if (action === "stream") {
    return device.state !== "stopped";
  }
  if (action === "start") {
    return device.type === "emulator" && device.state === "stopped";
  }
  if (action === "stop") {
    return device.type === "emulator" && device.state !== "stopped";
  }
  return false;
}

type NavigatorKeyboard = {
  lock?: (keyCodes?: string[]) => Promise<void>;
  unlock?: () => void;
};

function getNavigatorKeyboard(): NavigatorKeyboard | undefined {
  return (navigator as Navigator & { keyboard?: NavigatorKeyboard }).keyboard;
}

function EmulatorListItem({
  device,
  onConnect,
  onStart,
  onStop,
}: {
  device: DeviceInfo;
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const canConnect = hasAction(device, "stream");
  const canStart = hasAction(device, "start");
  const canStop = hasAction(device, "stop");

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-[var(--text-primary)]">
          {deviceLabel(device)}
        </span>
        <span
          className={`text-[0.8em] ${device.state === "stopped" ? "text-[var(--text-muted)]" : "text-[var(--accent-rust)]"}`}
        >
          {device.state}
        </span>
      </div>
      <div className="flex gap-2">
        {canConnect && (
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--accent-rust)] text-white hover:bg-[var(--accent-rust)] hover:opacity-90"
            onClick={() => onConnect(device)}
          >
            Connect
          </button>
        )}
        {canStop && (
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
            onClick={() => onStop(device.id)}
          >
            Stop
          </button>
        )}
        {!canStop && canStart && (
          <button
            type="button"
            className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
            onClick={() => onStart(device.id)}
          >
            Start
          </button>
        )}
        {!canConnect && !canStop && !canStart && (
          <span className="text-[0.8em] text-[var(--text-secondary)]">
            No actions
          </span>
        )}
      </div>
    </div>
  );
}

function DeviceList({
  devices,
  onConnect,
  onStart,
  onStop,
}: {
  devices: DeviceInfo[];
  onConnect: (device: DeviceInfo) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<DeviceInfo["type"], DeviceInfo[]>();
    for (const type of DEVICE_TYPE_ORDER) {
      groups.set(type, []);
    }
    for (const device of devices) {
      const bucket = groups.get(device.type);
      if (bucket) {
        bucket.push(device);
      } else {
        groups.set(device.type, [device]);
      }
    }
    return groups;
  }, [devices]);

  return (
    <div className="flex flex-col gap-3">
      {Array.from(grouped.entries()).map(([type, entries]) => {
        if (entries.length === 0) return null;
        return (
          <section key={type} className="flex flex-col gap-2">
            <h3 className="m-0 text-[0.9rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
              {deviceTypeLabel(type)}
            </h3>
            {entries.map((device) => (
              <EmulatorListItem
                key={device.id}
                device={device}
                onConnect={onConnect}
                onStart={onStart}
                onStop={onStop}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function StreamView({
  device,
  onBack,
}: { device: DeviceInfo; onBack: () => void }) {
  const {
    remoteStream,
    dataChannel,
    peerConnection,
    connectionState,
    error,
    latestProfileEvent,
    profileEventHistory,
    connect,
    disconnect,
  } = useEmulatorStream();
  const { adaptiveFps, maxFps } = useEmulatorSettings();
  const streamViewRef = useRef<HTMLDivElement>(null);
  const [immersiveKeyboardActive, setImmersiveKeyboardActive] = useState(false);
  const [immersiveKeyboardBusy, setImmersiveKeyboardBusy] = useState(false);
  const [immersiveKeyboardError, setImmersiveKeyboardError] = useState<
    string | null
  >(null);
  const keyboardDevice =
    device.type === "emulator" || device.type === "android";
  const supportsImmersiveKeyboard =
    keyboardDevice &&
    document.fullscreenEnabled &&
    typeof getNavigatorKeyboard()?.lock === "function";

  // Auto-connect when entering stream view
  useEffect(() => {
    connect({ id: device.id, type: device.type });
    return () => disconnect();
  }, [device.id, device.type, connect, disconnect]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === streamViewRef.current;
      setImmersiveKeyboardActive(active);
      if (!active) {
        getNavigatorKeyboard()?.unlock?.();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      getNavigatorKeyboard()?.unlock?.();
    };
  }, []);

  const exitImmersiveKeyboard = useCallback(async () => {
    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      getNavigatorKeyboard()?.unlock?.();
      if (document.fullscreenElement === streamViewRef.current) {
        await document.exitFullscreen();
      }
      setImmersiveKeyboardActive(false);
    } catch (err) {
      setImmersiveKeyboardError(
        `Failed to exit immersive keyboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, []);

  const enterImmersiveKeyboard = useCallback(async () => {
    if (!supportsImmersiveKeyboard || !streamViewRef.current) return;

    setImmersiveKeyboardBusy(true);
    setImmersiveKeyboardError(null);
    try {
      if (document.fullscreenElement !== streamViewRef.current) {
        await streamViewRef.current.requestFullscreen();
      }
      await getNavigatorKeyboard()?.lock?.();
      setImmersiveKeyboardActive(true);
    } catch (err) {
      getNavigatorKeyboard()?.unlock?.();
      setImmersiveKeyboardActive(false);
      setImmersiveKeyboardError(
        `Immersive keyboard failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImmersiveKeyboardBusy(false);
    }
  }, [supportsImmersiveKeyboard]);

  const handleBack = () => {
    void exitImmersiveKeyboard();
    disconnect();
    onBack();
  };

  return (
    <div
      className="flex flex-col h-[100dvh] max-h-[100dvh]"
      ref={streamViewRef}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
        <button
          type="button"
          className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-active)]"
          onClick={handleBack}
        >
          Back
        </button>
        <span className="text-[0.85em] text-[var(--text-secondary)] capitalize text-center">
          {deviceLabel(device)} - {connectionState}
        </span>
        <div className="flex justify-end">
          {supportsImmersiveKeyboard && (
            <button
              type="button"
              className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:cursor-default"
              onClick={() => {
                if (immersiveKeyboardActive) {
                  void exitImmersiveKeyboard();
                } else {
                  void enterImmersiveKeyboard();
                }
              }}
              disabled={immersiveKeyboardBusy}
              title="Request fullscreen and keyboard lock"
            >
              {immersiveKeyboardBusy
                ? "Working..."
                : immersiveKeyboardActive
                  ? "Exit Immersive Keyboard"
                  : "Immersive Keyboard"}
            </button>
          )}
        </div>
      </div>

      {supportsImmersiveKeyboard && (
        <div className="px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] text-[0.75em]">
          Keyboard mode:{" "}
          {immersiveKeyboardActive ? "immersive (fullscreen)" : "standard"}
        </div>
      )}

      {immersiveKeyboardError && (
        <div className="px-4 py-3 my-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] text-[var(--error-color)] rounded-md text-[0.9em]">
          {immersiveKeyboardError}
        </div>
      )}

      {latestProfileEvent && (
        <div className="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] text-[0.8em]">
          Profile {latestProfileEvent.direction}: tier {latestProfileEvent.tier}
          /{latestProfileEvent.totalTiers} ({latestProfileEvent.width}x
          {latestProfileEvent.height}@{latestProfileEvent.fps}fps,{" "}
          {Math.round(latestProfileEvent.bitrate / 1000)} kbps)
        </div>
      )}

      {profileEventHistory.length > 0 && (
        <div
          className="flex flex-col gap-1 px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]"
          data-testid="profile-timeline"
        >
          {profileEventHistory.map((event, idx) => (
            <div
              key={`${event.receivedAt}-${event.direction}-${event.tier}-${idx}`}
              className={`flex gap-2 text-[0.75em] text-[var(--text-secondary)] whitespace-nowrap overflow-hidden text-ellipsis ${idx === 0 ? "text-[var(--text-primary)]" : ""}`}
            >
              <span className="tabular-nums opacity-85">
                {new Date(event.receivedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span className="min-w-0 overflow-hidden text-ellipsis">
                {event.direction} tier {event.tier}/{event.totalTiers} (
                {event.width}x{event.height}@{event.fps})
              </span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="px-4 py-3 my-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] text-[var(--error-color)] rounded-md text-[0.9em]">
          {error}
        </div>
      )}

      {connectionState === "connecting" && (
        <div className="p-6 text-center text-[var(--text-secondary)]">
          Connecting...
        </div>
      )}

      <div className="flex-1 min-h-0 flex items-center justify-center bg-black overflow-hidden">
        <EmulatorStream
          stream={remoteStream}
          dataChannel={dataChannel}
          deviceType={device.type}
          peerConnection={peerConnection}
          adaptiveFps={adaptiveFps}
          configuredFps={maxFps}
        />
      </div>

      <EmulatorNavButtons dataChannel={dataChannel} deviceType={device.type} />
    </div>
  );
}

export function BridgeRuntimePrompt({
  mode,
  installedVersion,
  latestVersion,
  onDownloaded,
}: {
  mode: "download" | "update";
  installedVersion?: string | null;
  latestVersion?: string | null;
  onDownloaded: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await api.downloadDeviceBridge();
      if (result.ok) {
        onDownloaded();
      } else {
        setError(result.error ?? "Download failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="px-6 py-8 text-center text-[var(--text-secondary)]">
      <p className="m-0 mb-4">
        {mode === "update" ? (
          <>
            Device streaming needs a bridge runtime update before use.
            {installedVersion && latestVersion
              ? ` Installed: v${installedVersion}. Latest: v${latestVersion}.`
              : null}
          </>
        ) : (
          <>
            Device streaming requires bridge runtime downloads (sidecar binary +
            Android server APK).
          </>
        )}
      </p>
      {error && (
        <div className="px-4 py-3 mb-4 bg-[var(--bg-error,rgba(207,34,46,0.1))] text-[var(--error-color)] rounded-md text-[0.9em]">
          {error}
        </div>
      )}
      <button
        type="button"
        className="px-3.5 py-1.5 rounded-md text-[0.85em] cursor-pointer transition-colors duration-150 border-none bg-[var(--accent-rust)] text-white hover:bg-[var(--accent-rust)] hover:opacity-90 disabled:opacity-40 disabled:cursor-default"
        onClick={handleDownload}
        disabled={downloading}
      >
        {downloading
          ? mode === "update"
            ? "Updating..."
            : "Downloading..."
          : mode === "update"
            ? "Update Bridge"
            : "Download Bridge"}
      </button>
    </div>
  );
}

export function EmulatorPage() {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { version: versionInfo, refetch: refetchVersion } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];
  const bridgeRuntimeMode =
    versionInfo?.deviceBridgeState === "update-available"
      ? "update"
      : capabilities.includes("deviceBridge-download") &&
          !capabilities.includes("deviceBridge")
        ? "download"
        : null;
  const needsDownload = bridgeRuntimeMode !== null;

  const { emulators, loading, error, startEmulator, stopEmulator } =
    useEmulators({ enabled: !needsDownload });
  const [activeDevice, setActiveDevice] = useState<DeviceInfo | null>(null);

  // ?auto — auto-connect to the first streamable running device.
  useEffect(() => {
    if (activeDevice || loading || needsDownload) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("auto")) return;
    const streamable = emulators.find((d) => hasAction(d, "stream"));
    if (streamable) setActiveDevice(streamable);
  }, [emulators, loading, activeDevice, needsDownload]);

  if (activeDevice) {
    return (
      <div className="flex justify-center min-w-0 h-[100dvh] overflow-hidden">
        <div className="w-full flex flex-col h-[100dvh]">
          <StreamView
            device={activeDevice}
            onBack={() => setActiveDevice(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center min-w-0 h-[100dvh] overflow-hidden">
      <div className="w-full flex flex-col h-[100dvh]">
        <PageHeader
          title="Devices"
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />
        <main className="flex-1 overflow-y-auto min-h-0">
          <div className="px-6 py-8 md:px-10 md:py-10">
            {bridgeRuntimeMode ? (
              <BridgeRuntimePrompt
                mode={bridgeRuntimeMode}
                installedVersion={versionInfo?.deviceBridgeVersion}
                latestVersion={versionInfo?.latestDeviceBridgeVersion}
                onDownloaded={refetchVersion}
              />
            ) : (
              <>
                {loading && (
                  <div className="p-6 text-center text-[var(--text-secondary)]">
                    Loading...
                  </div>
                )}
                {error && (
                  <div className="px-4 py-3 my-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] text-[var(--error-color)] rounded-md text-[0.9em]">
                    {error}
                  </div>
                )}
                {!loading && emulators.length === 0 && (
                  <div className="p-6 text-center text-[var(--text-secondary)]">
                    No devices detected. Connect an Android emulator/device or
                    add a ChromeOS SSH host alias in Settings.
                  </div>
                )}
                {emulators.length > 0 && (
                  <DeviceList
                    devices={emulators}
                    onConnect={setActiveDevice}
                    onStart={startEmulator}
                    onStop={stopEmulator}
                  />
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
