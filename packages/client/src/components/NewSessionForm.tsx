import {
  ALL_PERMISSION_MODES,
  type ModelInfo,
  type ProviderName,
  resolveModel,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type UploadedFile, api } from "../api/client";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useToastContext } from "../contexts/ToastContext";
import { useConnection } from "../hooks/useConnection";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import {
  getModelSetting,
  getThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useRemoteExecutors } from "../hooks/useRemoteExecutors";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";
import type { PermissionMode } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { clearFabPrefill, getFabPrefill } from "./FloatingActionButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

const MODE_ORDER: readonly PermissionMode[] = ALL_PERMISSION_MODES;

const sectionTitleClasses =
  "mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]";
const optionCardBaseClasses =
  "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors duration-150";
const optionCardSelectedClasses =
  "border-[var(--text-primary)] bg-[var(--bg-hover)]";
const optionCardUnselectedClasses =
  "border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]";
const mutedToolbarButtonClasses =
  "flex items-center justify-center rounded-md p-2 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50";
const providerDotColors: Record<string, string> = {
  claude: "var(--provider-claude)",
  codex: "var(--provider-codex)",
  gemini: "var(--provider-gemini)",
  opencode: "var(--provider-opencode)",
  local: "#8b5cf6",
};
const modeDotColors: Record<PermissionMode, string> = {
  default: "var(--timeline-dot-default)",
  acceptEdits: "var(--success-color)",
  plan: "var(--warning-color)",
  bypassPermissions: "var(--error-color)",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getPreferredModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
) {
  const configuredModelId = preferredModelId ?? resolveModel(getModelSetting());

  if (!configuredModelId) {
    return models.find((m) => m.id === "default")?.id ?? null;
  }

  if (configuredModelId) {
    const matchingPreferredModel = models.find(
      (m) => m.id === configuredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;
  }

  return models[0]?.id ?? null;
}

export interface NewSessionFormProps {
  projectId: string;
  /** Whether to focus the textarea on mount (default: true) */
  autoFocus?: boolean;
  /** Number of rows for the textarea (default: 6) */
  rows?: number;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Compact mode: no header, no mode selector (default: false) */
  compact?: boolean;
}

export function NewSessionForm({
  projectId,
  autoFocus = true,
  rows = 6,
  placeholder,
  compact = false,
}: NewSessionFormProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [message, setMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [mode, setMode] = useState<PermissionMode>("default");
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // null = local, string = remote host
  const [selectedExecutor, setSelectedExecutor] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const hasInitializedDefaultsRef = useRef(false);

  // Thinking toggle state
  const { thinkingMode, cycleThinkingMode, thinkingLevel } = useModelSettings();

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Toast for error messages
  const { showToast } = useToastContext();

  // Fetch available providers
  const { providers, loading: providersLoading } = useProviders();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting: updateServerSetting,
  } = useServerSettings();

  // Fetch remote executors
  const { executors: remoteExecutors, loading: executorsLoading } =
    useRemoteExecutors();
  const availableProviders = getAvailableProviders(providers);
  const resolvedPlaceholder = placeholder ?? t("newSessionPlaceholder");
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };
  const sectionWrapperClasses = compact
    ? "rounded-[var(--radius-lg)] border border-[var(--border-color)] bg-[var(--bg-surface)]/85 p-4 shadow-[0_4px_16px_rgba(0,0,0,0.04)] backdrop-blur-sm"
    : "mx-auto flex w-full max-w-[42rem] flex-col gap-6";
  const recordingIndicatorClasses = interimTranscript
    ? "relative before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-0.5 before:animate-[voice-pulse_1s_ease-in-out_infinite] before:rounded-t-[inherit] before:bg-[rgb(239,68,68)]"
    : "";

  // Get models and capabilities for the currently selected provider
  const selectedProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const availableModels: ModelInfo[] = selectedProviderInfo?.models ?? [];
  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportedPermissionModes =
    selectedProviderInfo?.supportedPermissionModes ?? ALL_PERMISSION_MODES;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;

  // Initialize provider/model/mode from saved defaults once settings and providers load.
  useEffect(() => {
    if (
      hasInitializedDefaultsRef.current ||
      providersLoading ||
      settingsLoading
    ) {
      return;
    }

    hasInitializedDefaultsRef.current = true;

    if (providers.length === 0) return;

    const availableProviderNames = new Set(
      availableProviders.map((p) => p.name),
    );
    const savedDefaults = settings?.newSessionDefaults;
    const savedProviderName =
      savedDefaults?.provider &&
      availableProviderNames.has(savedDefaults.provider)
        ? savedDefaults.provider
        : null;
    const initialProvider =
      providers.find((p) => p.name === savedProviderName) ??
      getDefaultProvider(providers);

    if (!initialProvider) return;

    setSelectedProvider(initialProvider.name);
    setSelectedModel(
      getPreferredModelId(initialProvider.models ?? [], savedDefaults?.model),
    );
    setMode(savedDefaults?.permissionMode ?? "default");
  }, [
    availableProviders,
    providers,
    providersLoading,
    settings,
    settingsLoading,
  ]);

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    setSelectedProvider(providerName);
    const provider = providers.find((p) => p.name === providerName);
    if (provider?.models && provider.models.length > 0) {
      setSelectedModel(getPreferredModelId(provider.models));
    } else {
      setSelectedModel(null);
    }
  };

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    return availableModels.map((model) => {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      let description = model.description;
      if (!description) {
        const parts: string[] = [];
        if (model.parameterSize) parts.push(model.parameterSize);
        if (model.contextWindow) {
          parts.push(`${Math.round(model.contextWindow / 1024)}K ctx`);
        }
        if (model.parentModel) parts.push(model.parentModel);
        if (model.quantizationLevel) parts.push(model.quantizationLevel);
        if (parts.length > 0) description = parts.join(" · ");
      }

      return { value: model.id, label, description };
    });
  }, [availableModels]);

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback((selected: string[]) => {
    setSelectedModel(selected[0] ?? null);
  }, []);

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

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

  // Focus textarea on mount if autoFocus is enabled
  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  // Check for FAB pre-fill on mount (when coming from FloatingActionButton)
  useEffect(() => {
    const prefill = getFabPrefill();
    if (prefill) {
      setMessage(prefill);
      clearFabPrefill();
      // Focus and move cursor to end
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(prefill.length, prefill.length);
      }
    }
  }, [setMessage]);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const newPendingFiles: PendingFile[] = Array.from(files).map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));

    setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    e.target.value = ""; // Reset for re-selection
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      return prev.filter((f) => f.id !== id);
    });
  };

  const handleModeSelect = (selectedMode: PermissionMode) => {
    setMode(selectedMode);
  };

  useEffect(() => {
    if (!supportsPermissionMode) return;
    if (supportedPermissionModes.includes(mode)) return;
    setMode(supportedPermissionModes[0] ?? "default");
  }, [mode, supportedPermissionModes, supportsPermissionMode]);

  const handleSaveDefaults = useCallback(async () => {
    setIsSavingDefaults(true);
    try {
      await updateServerSetting("newSessionDefaults", {
        provider: selectedProvider ?? undefined,
        model: selectedModel ?? undefined,
        permissionMode: mode,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      console.error("Failed to save new session defaults:", err);
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    } finally {
      setIsSavingDefaults(false);
    }
  }, [
    mode,
    selectedModel,
    selectedProvider,
    showToast,
    t,
    updateServerSetting,
  ]);

  const handleStartSession = async () => {
    // Stop voice recording and get any pending interim text
    const pendingVoice =
      (await voiceButtonRef.current?.stopAndFinalize()) ?? "";

    // Combine committed text with any pending voice text
    let finalMessage = message.trimEnd();
    if (pendingVoice) {
      finalMessage = finalMessage
        ? `${finalMessage} ${pendingVoice}`
        : pendingVoice;
    }

    const hasContent = finalMessage.trim() || pendingFiles.length > 0;
    if (!projectId || !hasContent || isStarting) return;

    const trimmedMessage = finalMessage.trim();

    setInterimTranscript("");
    setIsStarting(true);

    try {
      let sessionId: string;
      let processId: string;
      const uploadedFiles: UploadedFile[] = [];

      // Get model and thinking settings
      const thinking = getThinkingSetting();
      const sessionOptions = {
        mode,
        model: selectedModel ?? undefined,
        thinking,
        provider: selectedProvider ?? undefined,
        executor: selectedExecutor ?? undefined,
      };

      if (pendingFiles.length > 0) {
        // Two-phase flow: create session first, then upload to real session folder
        // Step 1: Create the session without sending a message
        const createResult = await api.createSession(projectId, sessionOptions);
        sessionId = createResult.sessionId;
        processId = createResult.processId;

        // Step 2: Upload files to the real session folder
        for (const pendingFile of pendingFiles) {
          try {
            const uploadedFile = await connection.upload(
              projectId,
              sessionId,
              pendingFile.file,
              {
                onProgress: (bytesUploaded) => {
                  setUploadProgress((prev) => ({
                    ...prev,
                    [pendingFile.id]: {
                      uploaded: bytesUploaded,
                      total: pendingFile.file.size,
                    },
                  }));
                },
              },
            );
            uploadedFiles.push(uploadedFile);
          } catch (uploadErr) {
            console.error("Failed to upload file:", uploadErr);
            const uploadMessage =
              uploadErr instanceof Error ? uploadErr.message : "";
            showToast(
              t("newSessionUploadError", { message: uploadMessage }),
              "error",
            );
            // Continue with other files
          }
        }

        // Step 3: Send the first message with attachments
        await api.queueMessage(
          sessionId,
          trimmedMessage,
          mode,
          uploadedFiles.length > 0 ? uploadedFiles : undefined,
          undefined, // tempId
          thinking, // Pass the captured thinking setting to avoid process restart
        );
      } else {
        // No files - use single-step flow for efficiency
        const result = await api.startSession(
          projectId,
          trimmedMessage,
          sessionOptions,
        );
        sessionId = result.sessionId;
        processId = result.processId;
      }

      // Clean up preview URLs
      for (const pf of pendingFiles) {
        if (pf.previewUrl) {
          URL.revokeObjectURL(pf.previewUrl);
        }
      }

      draftControls.clearDraft();
      // Pass initial status so SessionPage can connect SSE immediately
      // without waiting for getSession to complete
      // Also pass initial message as optimistic title (session name = first message)
      // Pass model/provider so ProviderBadge can render immediately
      navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`, {
        state: {
          initialStatus: { state: "owned", processId },
          initialTitle: trimmedMessage,
          initialModel: selectedModel,
          initialProvider: selectedProvider,
        },
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage();
      setIsStarting(false);

      // Show user-visible error message
      let errorMessage = t("newSessionStartError");
      if (err instanceof Error) {
        // Check for specific error types
        if (err.message.includes("Queue is full")) {
          errorMessage = t("newSessionServerBusy");
        } else if (err.message.includes("503")) {
          errorMessage = t("newSessionServerCapacity");
        } else if (err.message.includes("404")) {
          errorMessage = t("newSessionProjectNotFound");
        } else if (
          err.message.includes("fetch") ||
          err.message.includes("network")
        ) {
          errorMessage = t("newSessionNetworkError");
        } else {
          errorMessage = err.message;
        }
      }
      showToast(errorMessage, "error");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
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
      e.preventDefault();
      const newPendingFiles: PendingFile[] = files.map((file) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      }));
      setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const trimmed = message.trimEnd();
      if (trimmed) {
        setMessage(`${trimmed} ${transcript}`);
      } else {
        setMessage(transcript);
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
    [message, setMessage],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  const hasContent = message.trim() || pendingFiles.length > 0;
  const savedDefaults = settings?.newSessionDefaults;
  const defaultsMatchCurrent =
    (savedDefaults?.provider ?? undefined) ===
      (selectedProvider ?? undefined) &&
    (savedDefaults?.model ?? undefined) === (selectedModel ?? undefined) &&
    (savedDefaults?.permissionMode ?? "default") === mode;

  // Shared input area with toolbar (textarea + attach/voice on left, send on right)
  const inputArea = (
    <>
      <textarea
        ref={textareaRef}
        value={displayText}
        onChange={(e) => {
          setInterimTranscript("");
          setMessage(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={resolvedPlaceholder}
        disabled={isStarting}
        rows={rows}
        className="min-h-[9rem] w-full resize-y rounded-[1.5rem] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-4 text-[15px] leading-7 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-dimmed)] focus:border-[var(--focus-border)] focus:ring-2 focus:ring-[rgba(153,70,42,0.12)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
          <button
            type="button"
            className={mutedToolbarButtonClasses}
            onClick={() => fileInputRef.current?.click()}
            disabled={isStarting}
            aria-label={t("newSessionAttachFiles")}
          >
            <span className="text-sm">📎</span>
          </button>
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            disabled={isStarting}
            className={mutedToolbarButtonClasses}
          />
          {supportsThinkingToggle && (
            <button
              type="button"
              className={`${mutedToolbarButtonClasses} border ${thinkingMode !== "off" ? "border-[var(--focus-border)] text-[var(--focus-border)]" : "border-transparent"}`}
              onClick={cycleThinkingMode}
              disabled={isStarting}
              title={
                thinkingMode === "off"
                  ? t("newSessionThinkingOff")
                  : thinkingMode === "auto"
                    ? t("newSessionThinkingAuto")
                    : t("newSessionThinkingOn", { level: thinkingLevel })
              }
              aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
            >
              <span className="text-sm">💡</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleStartSession}
          disabled={isStarting || !hasContent}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--text-primary)] text-white shadow-[0_4px_12px_rgba(0,0,0,0.12)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t("newSessionStartAction")}
        >
          {isStarting ? (
            <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className="text-lg">↑</span>
          )}
        </button>
      </div>
      {pendingFiles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {pendingFiles.map((pf) => {
            const progress = uploadProgress[pf.id];
            return (
              <div
                key={pf.id}
                className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2"
              >
                {pf.previewUrl && (
                  <img
                    src={pf.previewUrl}
                    alt=""
                    className="h-8 w-8 rounded-md object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                    {pf.file.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-dimmed)]">
                    {progress
                      ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
                      : formatSize(pf.file.size)}
                  </span>
                </div>
                {!isStarting && (
                  <button
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-dimmed)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--error-color)]"
                    onClick={() => handleRemoveFile(pf.id)}
                    aria-label={t("newSessionRemoveFile", {
                      name: pf.file.name,
                    })}
                  >
                    <span className="text-sm">✕</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div className={`${sectionWrapperClasses} ${recordingIndicatorClasses}`}>
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div className={`${sectionWrapperClasses} ${recordingIndicatorClasses}`}>
      <div className="mb-2 text-center">
        <h1
          className="text-[2rem] leading-tight text-[var(--text-primary)] sm:text-[2.25rem]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("newSessionHeaderTitle")}
        </h1>
        <p className="mt-2 text-sm text-[var(--text-muted)] sm:text-base">
          {t("newSessionHeaderSubtitle")}
        </p>
      </div>

      <div className="mb-2">{inputArea}</div>

      {/* Provider Selection */}
      {!providersLoading && availableProviders.length > 1 && (
        <section>
          <h3 className={sectionTitleClasses}>
            {t("newSessionProviderTitle")}
          </h3>
          <div className="flex flex-col gap-2">
            {providers.map((p) => {
              const isAvailable = p.installed && (p.authenticated || p.enabled);
              const isSelected = selectedProvider === p.name;
              const dotColor =
                providerDotColors[p.name] ?? "var(--text-dimmed)";
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`${optionCardBaseClasses} ${isSelected ? optionCardSelectedClasses : optionCardUnselectedClasses} ${!isAvailable ? "cursor-not-allowed opacity-50" : ""}`}
                  onClick={() => isAvailable && handleProviderSelect(p.name)}
                  disabled={isStarting || !isAvailable}
                  title={
                    !isAvailable
                      ? t("newSessionProviderUnavailable", {
                          provider: p.displayName,
                          reason: !p.installed
                            ? t("newSessionProviderNotInstalled")
                            : t("newSessionProviderNotAuthenticated"),
                        })
                      : p.displayName
                  }
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: dotColor }}
                  />
                  <div className="flex flex-col flex-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {p.displayName}
                    </span>
                    {!isAvailable && (
                      <span className="text-xs text-[var(--text-dimmed)]">
                        {!p.installed
                          ? t("newSessionProviderStatusNotInstalled")
                          : t("newSessionProviderStatusNotAuthenticated")}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Model Selection */}
      {selectedProvider && modelOptions.length > 0 && (
        <section>
          <h3 className={sectionTitleClasses}>{t("newSessionModelTitle")}</h3>
          <FilterDropdown
            label={t("newSessionModelTitle")}
            options={modelOptions}
            selected={selectedModel ? [selectedModel] : []}
            onChange={handleModelSelect}
            multiSelect={false}
            placeholder={t("newSessionModelPlaceholder")}
          />
        </section>
      )}

      {/* Executor Selection - only show if remote executors are configured */}
      {!executorsLoading && remoteExecutors.length > 0 && (
        <section>
          <h3 className={sectionTitleClasses}>{t("newSessionRunOnTitle")}</h3>
          <div className="flex flex-col gap-2">
            <button
              key="local"
              type="button"
              className={`${optionCardBaseClasses} ${selectedExecutor === null ? optionCardSelectedClasses : optionCardUnselectedClasses}`}
              onClick={() => setSelectedExecutor(null)}
              disabled={isStarting}
            >
              <span className="w-3 h-3 rounded-full shrink-0 bg-[var(--text-primary)]" />
              <div className="flex flex-col flex-1">
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {t("newSessionRunOnLocal")}
                </span>
                <span className="text-xs text-[var(--text-dimmed)]">
                  {t("newSessionRunOnLocalDesc")}
                </span>
              </div>
            </button>
            {remoteExecutors.map((host) => (
              <button
                key={host}
                type="button"
                className={`${optionCardBaseClasses} ${selectedExecutor === host ? optionCardSelectedClasses : optionCardUnselectedClasses}`}
                onClick={() => setSelectedExecutor(host)}
                disabled={isStarting}
              >
                <span className="w-3 h-3 rounded-full shrink-0 bg-[var(--provider-codex)]" />
                <div className="flex flex-col flex-1">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {host}
                  </span>
                  <span className="text-xs text-[var(--text-dimmed)]">
                    {t("newSessionRunOnRemoteDesc")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Permission Mode Selection - only for providers that support it */}
      {supportsPermissionMode && (
        <section className="pb-4">
          <h3 className={sectionTitleClasses}>{t("newSessionModeTitle")}</h3>
          <div className="flex flex-col gap-2">
            {MODE_ORDER.filter((m) => supportedPermissionModes.includes(m)).map(
              (m) => (
                <button
                  key={m}
                  type="button"
                  className={`${optionCardBaseClasses} ${mode === m ? optionCardSelectedClasses : optionCardUnselectedClasses}`}
                  onClick={() => handleModeSelect(m)}
                  disabled={isStarting}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full sm:h-3 sm:w-3"
                    style={{ backgroundColor: modeDotColors[m] }}
                  />
                  <div className="flex flex-col flex-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {modeLabels[m]}
                    </span>
                    <span className="text-xs text-[var(--text-dimmed)]">
                      {modeDescriptions[m]}
                    </span>
                  </div>
                </button>
              ),
            )}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="m-0 text-sm text-[var(--text-muted)]">
              {t("newSessionDefaultsDescription")}
            </p>
            <button
              type="button"
              className="whitespace-nowrap rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              onClick={handleSaveDefaults}
              disabled={
                isStarting ||
                isSavingDefaults ||
                settingsLoading ||
                !selectedProvider ||
                defaultsMatchCurrent
              }
            >
              {isSavingDefaults
                ? t("newSessionDefaultsSaving")
                : t("newSessionDefaultsAction")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
