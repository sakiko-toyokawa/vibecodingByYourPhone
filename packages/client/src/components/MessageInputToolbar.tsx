import type { UploadedFile } from "@yep-anywhere/shared";
import type { RefObject } from "react";
import { useModelSettings } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportedPermissionModes?: readonly PermissionMode[];
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  voiceDisabled?: boolean;

  // Slash commands
  slashCommands?: string[];
  onSelectSlashCommand?: (command: string) => void;

  // Context usage
  contextUsage?: ContextUsage;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  canSend?: boolean;
  disabled?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  isHeld,
  onHoldChange,
  supportsPermissionMode = true,
  supportedPermissionModes,
  supportsThinkingToggle = true,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  voiceDisabled,
  slashCommands = [],
  onSelectSlashCommand,
  contextUsage,
  isRunning,
  isThinking,
  onStop,
  onSend,
  onQueue,
  canSend,
  disabled,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const { thinkingMode, cycleThinkingMode, thinkingLevel } = useModelSettings();

  return (
    <div className="flex items-center justify-between gap-2 px-4 pb-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {onModeChange && supportsPermissionMode && (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            availableModes={supportedPermissionModes}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
          />
        )}
        <button
          type="button"
          className="relative flex items-center justify-center w-7 h-7 bg-transparent border border-[var(--border-subtle)] rounded-lg text-[var(--text-muted)] text-sm cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onAttachClick}
          disabled={!canAttach}
          title={
            canAttach ? t("toolbarAttachFiles") : t("toolbarAttachDisabled")
          }
        >
          <span className="text-sm">&#x1f4ce;</span>
          {attachmentCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 bg-[var(--text-primary)] text-white rounded-lg text-[10px] flex items-center justify-center font-medium">
              {attachmentCount}
            </span>
          )}
        </button>
        {supportsThinkingToggle && (
          <button
            type="button"
            className={`flex items-center justify-center w-7 h-7 bg-transparent border border-[var(--border-subtle)] rounded-lg text-[var(--text-muted)] cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)] ${thinkingMode !== "off" ? (thinkingMode === "auto" ? "bg-[rgba(180,140,60,0.12)] border-[rgba(180,140,60,0.5)] text-[rgb(180,140,60)] hover:bg-[rgba(180,140,60,0.2)]" : "bg-[rgba(59,130,246,0.15)] border-[rgb(59,130,246)] text-[rgb(59,130,246)] hover:bg-[rgba(59,130,246,0.25)]") : ""}`}
            onClick={cycleThinkingMode}
            title={
              thinkingMode === "off"
                ? t("newSessionThinkingOff")
                : thinkingMode === "auto"
                  ? t("newSessionThinkingAuto")
                  : t("newSessionThinkingOn", { level: thinkingLevel })
            }
            aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
          >
            <span className="text-sm">&#x23f1;</span>
          </button>
        )}
        {voiceButtonRef && onVoiceTranscript && onInterimTranscript && (
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={onVoiceTranscript}
            onInterimTranscript={onInterimTranscript}
            onListeningStart={onListeningStart}
            disabled={voiceDisabled}
          />
        )}
        {onSelectSlashCommand && (
          <SlashCommandButton
            commands={slashCommands}
            onSelectCommand={onSelectSlashCommand}
            disabled={voiceDisabled}
          />
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {/* Pending approval indicator */}
        {pendingApproval && (
          <button
            type="button"
            className={`flex items-center gap-1.5 px-2.5 py-1 bg-[var(--status-badge-input-bg)] border-none rounded-md text-[var(--status-badge-input-text)] text-[10px] cursor-pointer transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--status-badge-input-bg)_80%,white_20%)] active:scale-[0.97] ${pendingApproval.type}`}
            onClick={pendingApproval.onExpand}
            title={
              pendingApproval.type === "tool-approval"
                ? t("toolbarPendingApprovalExpand")
                : t("toolbarPendingQuestionExpand")
            }
          >
            <span className="w-2 h-2 rounded-full bg-[var(--status-badge-input-text)] animate-[pulse-indicator_1.5s_ease-in-out_infinite]" />
            <span className="font-medium">
              {pendingApproval.type === "tool-approval"
                ? t("toolbarApproval")
                : t("toolbarQuestion")}
            </span>
          </button>
        )}
        <ContextUsageIndicator usage={contextUsage} size={16} />
        {/* Queue button - shown when agent is running and there's content to queue */}
        {onQueue && canSend && (
          <button
            type="button"
            onClick={onQueue}
            className="w-8 h-8 flex items-center justify-center border border-[var(--border-color)] rounded-lg bg-transparent text-[var(--text-primary)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] shrink-0"
            title={t("toolbarQueueTitle")}
            aria-label={t("toolbarQueueLabel")}
          >
            <span className="text-sm">&#x2630;</span>
          </button>
        )}
        {/* Show stop button when thinking and nothing to send, otherwise show send */}
        {isRunning && onStop && isThinking && !canSend ? (
          <button
            type="button"
            onClick={onStop}
            className="w-8 h-8 flex items-center justify-center border-none rounded-lg bg-[var(--error-color)] text-white cursor-pointer transition-opacity duration-150 hover:opacity-85 shrink-0"
            aria-label={t("toolbarStop")}
          >
            <span className="w-2.5 h-2.5 bg-white rounded-sm" />
          </button>
        ) : onSend ? (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            className="w-8 h-8 flex items-center justify-center border border-[var(--border-color)] rounded-lg bg-transparent text-[var(--text-primary)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t("toolbarSend")}
          >
            <span className="text-base font-bold leading-none">↑</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
