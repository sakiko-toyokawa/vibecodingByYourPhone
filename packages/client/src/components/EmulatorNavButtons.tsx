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
    <div className="emulator-nav-buttons">
      {showAndroidNav && (
        <button
          type="button"
          className="emulator-nav-btn"
          onClick={() => sendKey("GoBack")}
          disabled={disabled}
          title="Back"
          aria-label="Back"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="emulator-nav-btn"
        onClick={() => sendKey("GoHome")}
        disabled={disabled}
        title="Home"
        aria-label="Home"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
        </svg>
      </button>
      {showAndroidNav && (
        <button
          type="button"
          className="emulator-nav-btn"
          onClick={() => sendKey("AppSwitch")}
          disabled={disabled}
          title="Recents"
          aria-label="Recents"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
      )}
    </div>
  );
}
