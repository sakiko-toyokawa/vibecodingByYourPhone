import {
  type ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
} from "react";
import { useModelSettings } from "../hooks/useModelSettings";
import {
  SPEECH_STATUS_LABELS,
  useSpeechRecognition,
} from "../hooks/useSpeechRecognition";
import { useVersion } from "../hooks/useVersion";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";

export interface VoiceInputButtonRef {
  /** Stop listening and return any pending interim text */
  stopAndFinalize: () => Promise<string>;
  /** Toggle listening on/off */
  toggle: () => void;
  /** Whether currently listening */
  isListening: boolean;
  /** Whether voice input is available (supported and enabled) */
  isAvailable: boolean;
}

interface VoiceInputButtonProps {
  /** Callback when final transcript is received - appends to input */
  onTranscript: (text: string) => void;
  /** Callback for interim results - shows live preview */
  onInterimTranscript?: (text: string) => void;
  /** Callback when listening starts - useful for focusing input */
  onListeningStart?: () => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
}

/**
 * Microphone button for voice input using Web Speech API.
 * Only renders when:
 * 1. Web Speech API is supported (Chrome/Edge)
 * 2. Voice input is enabled in settings
 */
export const VoiceInputButton = forwardRef(function VoiceInputButton(
  {
    onTranscript,
    onInterimTranscript,
    onListeningStart,
    disabled,
    className = "",
  }: VoiceInputButtonProps,
  ref: ForwardedRef<VoiceInputButtonRef>,
) {
  const { t } = useI18n();
  const { voiceInputEnabled } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const viewportWidth = useViewportWidth();

  // Show status text on desktop with sufficient width
  const showStatusText =
    !hasCoarsePointer() && viewportWidth >= 600 && voiceInputEnabled;

  const handleResult = useCallback(
    (transcript: string) => {
      onTranscript(transcript);
    },
    [onTranscript],
  );

  const handleInterim = useCallback(
    (transcript: string) => {
      onInterimTranscript?.(transcript);
    },
    [onInterimTranscript],
  );

  const {
    isSupported,
    isListening,
    status,
    toggleListening,
    stopListening,
    finalizeListening,
    error,
    interimTranscript,
  } = useSpeechRecognition({
    onResult: handleResult,
    onInterimResult: handleInterim,
  });

  const isAvailable = isSupported && voiceInputEnabled && serverVoiceEnabled;
  const statusLabelClasses =
    status === "error" || error
      ? "text-[rgb(239,68,68)]"
      : status === "reconnecting"
        ? "animate-[status-blink_0.8s_ease-in-out_infinite] text-[rgb(234,179,8)]"
        : status === "receiving"
          ? "font-medium text-[rgb(34,197,94)]"
          : status === "listening"
            ? "text-[rgb(239,68,68)]"
            : "text-[var(--text-muted)]";

  // Get display text for status
  const statusLabel = error || SPEECH_STATUS_LABELS[status];

  // Expose methods and state to parent
  useImperativeHandle(
    ref,
    () => ({
      stopAndFinalize: () => {
        if (isListening) {
          return finalizeListening();
        }
        return Promise.resolve(interimTranscript);
      },
      toggle: toggleListening,
      isListening,
      isAvailable,
    }),
    [
      interimTranscript,
      finalizeListening,
      isListening,
      toggleListening,
      isAvailable,
    ],
  );

  // Clear interim when listening stops
  useEffect(() => {
    if (!isListening && interimTranscript) {
      onInterimTranscript?.("");
    }
  }, [isListening, interimTranscript, onInterimTranscript]);

  // Handle click - toggle listening and notify when starting
  const handleClick = useCallback(() => {
    const wasListening = isListening;
    toggleListening();
    // If we weren't listening, we're now starting - notify parent
    if (!wasListening) {
      onListeningStart?.();
    }
  }, [isListening, toggleListening, onListeningStart]);

  // Don't render if not supported or disabled in settings
  if (!isAvailable) {
    return null;
  }

  const button = (
    <button
      type="button"
      className={`${className} inline-flex items-center justify-center rounded-md border px-2 py-2 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        isListening
          ? "border-[rgb(239,68,68)] bg-[rgba(239,68,68,0.15)] text-[rgb(239,68,68)] hover:bg-[rgba(239,68,68,0.25)]"
          : "border-[var(--border-color)] bg-transparent text-[var(--text-muted)] hover:border-[var(--border-input)] hover:bg-[var(--bg-hover)]"
      }`}
      onClick={handleClick}
      disabled={disabled}
      title={
        error
          ? error
          : isListening
            ? t("voiceInputStop" as never)
            : t("voiceInputStart" as never)
      }
      aria-label={
        isListening
          ? t("voiceInputStopLabel" as never)
          : t("voiceInputStartLabel" as never)
      }
      aria-pressed={isListening}
    >
      {isListening ? (
        // Recording indicator - animated bars
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="h-4 w-4"
        >
          <rect
            x="4"
            y="8"
            width="3"
            height="8"
            rx="1"
            className="animate-[voice-bar-pulse_0.8s_ease-in-out_infinite]"
            style={{ animationDelay: "0s" }}
          />
          <rect
            x="10.5"
            y="5"
            width="3"
            height="14"
            rx="1"
            className="animate-[voice-bar-pulse_0.8s_ease-in-out_infinite]"
            style={{ animationDelay: "0.2s" }}
          />
          <rect
            x="17"
            y="8"
            width="3"
            height="8"
            rx="1"
            className="animate-[voice-bar-pulse_0.8s_ease-in-out_infinite]"
            style={{ animationDelay: "0.4s" }}
          />
        </svg>
      ) : (
        // Microphone icon
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );

  // If showing status text, wrap in container; otherwise just return the button
  if (showStatusText && isListening) {
    return (
      <div className="flex items-center gap-1">
        {button}
        <span
          className={`min-w-20 whitespace-nowrap text-xs transition-colors ${statusLabelClasses}`}
        >
          {statusLabel}
        </span>
      </div>
    );
  }

  return button;
});
