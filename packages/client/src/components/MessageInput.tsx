import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";
import type { ContextUsage, PermissionMode } from "../types";
import { MessageInputToolbar } from "./MessageInputToolbar";
import type { VoiceInputButtonRef } from "./VoiceInputButton";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

/** Format file size in human-readable form */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface Props {
  onSend: (text: string) => void | Promise<void>;
  /** Queue a deferred message (sent when agent's turn ends). Only provided when agent is running. */
  onQueue?: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  draftKey: string; // localStorage key for draft persistence
  /** Collapse to single-line but keep visible and focusable (for when approval panel is showing) */
  collapsed?: boolean;
  /** Callback to receive draft controls for success/failure handling */
  onDraftControlsReady?: (controls: DraftControls) => void;
  /** Context usage for displaying usage indicator */
  contextUsage?: ContextUsage;
  /** Project ID for uploads (required to enable attach button) */
  projectId?: string;
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: UploadedFile[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Progress info for in-flight uploads */
  uploadProgress?: UploadProgress[];
  /** Whether the provider supports permission modes (default: true) */
  supportsPermissionMode?: boolean;
  /** Specific permission modes the provider supports */
  supportedPermissionModes?: readonly PermissionMode[];
  /** Whether the provider supports thinking toggle (default: true) */
  supportsThinkingToggle?: boolean;
  /** Available slash commands (without "/" prefix) */
  slashCommands?: string[];
  /** Callback for custom client-side commands (e.g., "model"). Return true if handled. */
  onCustomCommand?: (command: string) => boolean;
}

export function MessageInput({
  onSend,
  onQueue,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  isHeld,
  onHoldChange,
  isRunning,
  isThinking,
  onStop,
  draftKey,
  collapsed: externalCollapsed,
  onDraftControlsReady,
  contextUsage,
  projectId,
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  supportedPermissionModes,
  supportsThinkingToggle = true,
  slashCommands = [],
  onCustomCommand,
}: Props) {
  const { t } = useI18n();
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? text + (text.trimEnd() ? " " : "") + interimTranscript
    : text;

  // Auto-scroll textarea when voice input updates (interim transcript changes)
  // Browser handles scrolling for normal typing, but programmatic updates need explicit scroll
  useEffect(() => {
    if (interimTranscript) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }
  }, [interimTranscript]);

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;

  const canAttach = !!(projectId && sessionId && onAttach);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(controls);
  }, [controls, onDraftControlsReady]);

  const handleSubmit = useCallback(() => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled) {
      const message = finalText.trim();
      // Clear input state but keep localStorage for failure recovery
      controls.clearInput();
      setInterimTranscript("");
      void Promise.resolve(onSend(message)).catch(() => {});
      // Refocus the textarea so user can continue typing
      textareaRef.current?.focus();
    }
  }, [text, disabled, controls, onSend, attachments.length]);

  const handleQueue = useCallback(() => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled && onQueue) {
      const message = finalText.trim();
      controls.clearInput();
      setInterimTranscript("");
      void Promise.resolve(onQueue(message)).catch(() => {});
      textareaRef.current?.focus();
    }
  }, [text, disabled, controls, onQueue, attachments.length]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+Space toggles voice input
    if (e.key === " " && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (voiceButtonRef.current?.isAvailable) {
        voiceButtonRef.current.toggle();
      }
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Enter queues a deferred message when agent is running
      if (onQueue && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        handleQueue();
        return;
      }

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        // Allow default behavior (newline)
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        // Desktop: Enter sends, Ctrl+Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          // Allow default behavior (newline)
          return;
        }
        e.preventDefault();
        handleSubmit();
      } else {
        // Ctrl+Enter sends, Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      // Append transcript to existing text with space separator
      // Trim the transcript since mobile speech API includes leading/trailing spaces
      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) return;

      const trimmedText = text.trimEnd();
      if (trimmedText) {
        setText(`${trimmedText} ${trimmedTranscript}`);
      } else {
        setText(trimmedTranscript);
      }
      setInterimTranscript("");
      // Scroll to bottom after committing voice transcript
      // Use setTimeout to ensure state update has rendered
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 0);
    },
    [text, setText],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  // Handle slash command selection - insert command into text
  const handleSlashCommand = useCallback(
    (command: string) => {
      // Check if this is a custom client-side command (strip leading "/")
      const bare = command.startsWith("/") ? command.slice(1) : command;
      if (onCustomCommand?.(bare)) {
        return; // Custom command handled, don't insert text
      }
      // If text is empty or ends with whitespace, just append the command
      // Otherwise, add a space before it
      const trimmed = text.trimEnd();
      if (trimmed) {
        setText(`${trimmed} ${command} `);
      } else {
        setText(`${command} `);
      }
      // Focus the textarea so user can continue typing
      textareaRef.current?.focus();
    },
    [text, setText, onCustomCommand],
  );

  return (
    <div className="relative">
      {/* Floating toggle button - only show when user can control collapse (not externally collapsed) */}
      {!externalCollapsed && (
        <button
          type="button"
          className="absolute -top-3 left-1/2 -translate-x-1/2 z-[1] w-8 h-6 flex items-center justify-center bg-[var(--bg-code)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)]"
          onClick={() => setUserCollapsed(!userCollapsed)}
          aria-label={
            userCollapsed ? t("messageInputExpand") : t("messageInputCollapse")
          }
          aria-expanded={!userCollapsed}
        >
          <span
            className={`text-xs transition-transform duration-200 ease ${userCollapsed ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
      )}
      <div
        className={`flex flex-col gap-0 ${collapsed ? "mt-[var(--space-2)] opacity-70 transition-opacity duration-150 focus-within:opacity-100" : ""} ${interimTranscript ? "relative before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-0.5 before:bg-red-500 before:animate-[voice-pulse_1s_ease-in-out_infinite] before:rounded-t-[20px] before:z-[1]" : ""}`}
      >
        {/* Unified card container */}
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_1px_0_rgba(20,20,19,0.03)] overflow-hidden">
          <textarea
            ref={textareaRef}
            value={displayText}
            onChange={(e) => {
              // If user edits while recording, only update committed text
              // This clears interim since they're now typing
              setInterimTranscript("");
              setText(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              externalCollapsed ? t("messageInputContinueAbove") : placeholder
            }
            disabled={disabled}
            rows={collapsed ? 1 : 3}
            className={`flex-1 bg-transparent border-none text-inherit [font-family:var(--font-sans)] [font-size:var(--font-size-base)] resize-none outline-none placeholder:text-[var(--text-dimmed)] ${collapsed ? "px-3 py-2 [font-size:var(--font-size-sm)] min-h-0" : "px-4 py-3"}`}
          />

          {/* Attachment chips - show below textarea when not collapsed */}
          {!collapsed &&
            (attachments.length > 0 || uploadProgress.length > 0) && (
              <div className="flex flex-wrap gap-[var(--space-2)] px-4 pb-2">
                {attachments.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-[var(--space-1)] px-[var(--space-2)] pl-[var(--space-2)] pr-[var(--space-1)] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl [font-size:var(--font-size-xs)]"
                  >
                    <span
                      className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)] max-sm:max-w-20"
                      title={file.path}
                    >
                      {file.originalName}
                    </span>
                    <span className="text-[var(--text-dimmed)] shrink-0">
                      {formatSize(file.size)}
                    </span>
                    <button
                      type="button"
                      className="flex items-center justify-center w-[18px] h-[18px] p-0 ml-[var(--space-1)] bg-transparent border-none rounded-full text-[var(--text-dimmed)] [font-size:var(--font-size-sm)] cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      onClick={() => onRemoveAttachment?.(file.id)}
                      aria-label={t("messageInputRemoveAttachment", {
                        name: file.originalName,
                      })}
                    >
                      x
                    </button>
                  </div>
                ))}
                {uploadProgress.map((progress) => (
                  <div
                    key={progress.fileId}
                    className="flex items-center gap-[var(--space-1)] px-[var(--space-2)] pl-[var(--space-2)] pr-[var(--space-1)] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl [font-size:var(--font-size-xs)] opacity-70"
                  >
                    <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)] max-sm:max-w-20">
                      {progress.fileName}
                    </span>
                    <span className="text-[var(--success-color)] font-medium shrink-0">
                      {progress.percent}%
                    </span>
                  </div>
                ))}
              </div>
            )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />

          {!collapsed && (
            <MessageInputToolbar
              mode={mode}
              onModeChange={onModeChange}
              isHeld={isHeld}
              onHoldChange={onHoldChange}
              supportsPermissionMode={supportsPermissionMode}
              supportedPermissionModes={supportedPermissionModes}
              supportsThinkingToggle={supportsThinkingToggle}
              canAttach={canAttach}
              attachmentCount={attachments.length}
              onAttachClick={() => fileInputRef.current?.click()}
              voiceButtonRef={voiceButtonRef}
              onVoiceTranscript={handleVoiceTranscript}
              onInterimTranscript={handleInterimTranscript}
              onListeningStart={() => textareaRef.current?.focus()}
              voiceDisabled={disabled}
              slashCommands={slashCommands}
              onSelectSlashCommand={handleSlashCommand}
              contextUsage={contextUsage}
              isRunning={isRunning}
              isThinking={isThinking}
              onStop={onStop}
              onSend={handleSubmit}
              onQueue={onQueue ? handleQueue : undefined}
              canSend={!!(text.trim() || attachments.length > 0)}
              disabled={disabled}
            />
          )}
        </div>

        {/* Disclaimer */}
        {!collapsed && (
          <p className="mx-auto text-center text-[11px] text-[var(--text-dimmed)] mt-2">
            AI-generated content may be inaccurate. Please verify important
            information.
          </p>
        )}
      </div>
    </div>
  );
}
