import type { DeviceType } from "@yep-anywhere/shared";

interface EmulatorNavButtonsProps {
  /** WebRTC DataChannel for sending key events */
  dataChannel: RTCDataChannel | null;
  /** Device type for platform-specific controls */
  deviceType?: DeviceType;
}

/**
 * Device navigation buttons sent via WebRTC DataChannel.
 */
export function EmulatorNavButtons({
  dataChannel,
  deviceType,
}: EmulatorNavButtonsProps) {
  const showAndroidNav = deviceType === "emulator" || deviceType === "android";
  const showIOSHome = deviceType === "ios-simulator";

  if (!showAndroidNav && !showIOSHome) {
    return null;
  }

  const sendKey = (key: string) => {
    if (!dataChannel || dataChannel.readyState !== "open") return;
    dataChannel.send(JSON.stringify({ type: "key", key }));
  };

  const disabled = !dataChannel || dataChannel.readyState !== "open";

  return (
    <div className="flex justify-center gap-6 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
      {showAndroidNav && (
        <button
          type="button"
          className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40"
          onClick={() => sendKey("GoBack")}
          disabled={disabled}
          title="Back"
          aria-label="Back"
        >
          <span className="text-lg">&#x2039;</span>
        </button>
      )}
      <button
        type="button"
        className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40"
        onClick={() => sendKey("GoHome")}
        disabled={disabled}
        title="Home"
        aria-label="Home"
      >
        <span className="text-lg">&#x25cf;</span>
      </button>
      {showAndroidNav && (
        <button
          type="button"
          className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40"
          onClick={() => sendKey("AppSwitch")}
          disabled={disabled}
          title="Recents"
          aria-label="Recents"
        >
          <span className="text-lg">&#x25a1;</span>
        </button>
      )}
    </div>
  );
}
