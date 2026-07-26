import {
  ALL_PERMISSION_MODES,
  type ProviderName,
  type UploadedFile,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../api/client";
import {
  MessageInput,
  type SlashCommandOption,
  type UploadProgress,
} from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoModal } from "../components/ProcessInfoModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { RollbackPanel } from "../components/RollbackPanel";
import { SessionMenu } from "../components/SessionMenu";
import { SplitSessionPicker } from "../components/SplitSessionPicker";
import { SplitSessionView } from "../components/SplitSessionView";
import { SplitViewButton } from "../components/SplitViewButton";
import { ThemeToggle } from "../components/ThemeToggle";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useConnection } from "../hooks/useConnection";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProject } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { recordSessionVisit } from "../hooks/useRecentSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import {
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { type FileChangeEvent, activityBus } from "../lib/activityBus";
import { buildEditorPath } from "../lib/editorNavigation";
import { preprocessMessages } from "../lib/preprocessMessages";
import { generateUUID } from "../lib/uuid";
import { getSessionDisplayTitle } from "../utils";

type SessionPathBuilder = (projectId: string, sessionId: string) => string;

interface SessionPageContentProps {
  projectId: string;
  sessionId: string;
  isSecondaryPane?: boolean;
  layout?: "page" | "embedded";
  sessionPathBuilder?: SessionPathBuilder;
  onSendMessageReady?:
    | ((sendMessage: SessionMessageSender | null) => void)
    | null;
}

export type SessionMessageSender = (text: string) => Promise<void>;

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();
  const [searchParams] = useSearchParams();
  const splitSessionId = searchParams.get("splitSession");
  const splitProjectId = searchParams.get("splitProject");

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <SessionPageInvalidRoute />;
  }

  // If split view is requested, render two sessions side by side
  if (splitSessionId && splitProjectId) {
    return (
      <SplitSessionView
        left={{ projectId, sessionId }}
        right={{ projectId: splitProjectId, sessionId: splitSessionId }}
      />
    );
  }

  // Key ensures component remounts on session change, resetting all state
  // Wrap with StreamingMarkdownProvider for server-rendered markdown streaming
  return (
    <StreamingMarkdownProvider>
      <SessionPageContent
        key={sessionId}
        projectId={projectId}
        sessionId={sessionId}
      />
    </StreamingMarkdownProvider>
  );
}

function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return (
    <div className="flex h-screen items-center justify-center text-sm text-red-600 dark:text-red-400">
      {t("sessionInvalidUrl")}
    </div>
  );
}

export function SessionPageContent({
  projectId,
  sessionId,
  isSecondaryPane = false,
  layout = "page",
  sessionPathBuilder,
  onSendMessageReady = null,
}: SessionPageContentProps) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const { project } = useProject(projectId);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEmbedded = layout === "embedded";
  const isEmbeddedMobile = isEmbedded && !isWideScreen;
  const buildSessionPath = useCallback<SessionPathBuilder>(
    (targetProjectId, targetSessionId) =>
      sessionPathBuilder
        ? sessionPathBuilder(targetProjectId, targetSessionId)
        : `${basePath}/projects/${targetProjectId}/sessions/${targetSessionId}`,
    [basePath, sessionPathBuilder],
  );
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get model/provider so ProviderBadge can render immediately
  const navState = location.state as {
    initialStatus?: { owner: "self"; processId: string };
    initialTitle?: string;
    initialModel?: string;
    initialProvider?: ProviderName;
  } | null;
  const initialStatus = navState?.initialStatus;
  const initialTitle = navState?.initialTitle;
  const initialModel = navState?.initialModel;
  const initialProvider = navState?.initialProvider;

  // Get streaming markdown context for server-rendered markdown streaming
  const streamingMarkdownContext = useStreamingMarkdownContext();

  // Memoize the callbacks object to avoid recreating on every render
  const streamingMarkdownCallbacks = useMemo<
    StreamingMarkdownCallbacks | undefined
  >(() => {
    if (!streamingMarkdownContext) return undefined;
    return {
      onAugment: streamingMarkdownContext.dispatchAugment,
      onPending: streamingMarkdownContext.dispatchPending,
      onStreamEnd: streamingMarkdownContext.dispatchStreamEnd,
      setCurrentMessageId: streamingMarkdownContext.setCurrentMessageId,
      captureHtml: streamingMarkdownContext.captureStreamingHtml,
    };
  }, [streamingMarkdownContext]);

  const {
    session,
    messages,
    agentContent,
    setAgentContent,
    toolUseToAgent,
    markdownAugments,
    status,
    processState,
    isCompacting,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    loading,
    error,
    connected,
    sessionUpdatesConnected,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold,
    isHeld,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    deferredMessages,
    slashCommands,
    setSessionModel,
    sessionTools,
    mcpServers,
    pagination,
    loadingOlder,
    loadOlderMessages,
    reconnectStream,
    setMessages,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
  );

  // Developer mode settings
  const { holdModeEnabled, showConnectionBars } = useDeveloperMode();

  // Session connection bar state for active session update streams
  const { connectionState } = useActivityBusState();
  const hasSessionUpdateStream =
    status.owner === "self" || status.owner === "external";
  const sessionConnectionStatus =
    !showConnectionBars || !hasSessionUpdateStream
      ? "idle"
      : sessionUpdatesConnected
        ? "connected"
        : connectionState === "reconnecting"
          ? "connecting"
          : "disconnected";

  // Effective provider/model for immediate display before session data loads
  const effectiveProvider = session?.provider ?? initialProvider;
  const effectiveModel = session?.model ?? initialModel;

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { showToast } = useToastContext();

  // Sharing: check if configured (hidden unless sharing.json exists on server)
  const [sharingConfigured, setSharingConfigured] = useState(false);
  useEffect(() => {
    api
      .getSharingStatus()
      .then((res) => setSharingConfigured(res.configured))
      .catch(() => {});
  }, []);

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Get provider capabilities based on session's provider
  const { providers } = useProviders();
  const currentProviderInfo = useMemo(() => {
    if (!effectiveProvider) return null;
    return providers.find((p) => p.name === effectiveProvider) ?? null;
  }, [effectiveProvider, providers]);
  // Default to true for backwards compatibility (except slash commands)
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportedPermissionModes =
    currentProviderInfo?.supportedPermissionModes ?? ALL_PERMISSION_MODES;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;
  const supportsSlashCommands =
    currentProviderInfo?.supportsSlashCommands ?? false;
  const isCodexSession =
    effectiveProvider === "codex" || effectiveProvider === "codex-oss";
  const availableSlashCommands = useMemo<SlashCommandOption[]>(() => {
    const dynamicCommands =
      status.owner === "self" && supportsSlashCommands
        ? slashCommands.map((command) => ({
            value: command.name,
            description: command.description,
            source: "provider" as const,
          }))
        : [];

    if (dynamicCommands.length > 0) {
      return dynamicCommands;
    }

    if (!isCodexSession) {
      return [];
    }

    return [
      {
        value: "model",
        description: "choose what model and reasoning effort to use",
        source: "codex-source",
      },
      {
        value: "fast",
        description:
          "toggle Fast mode to enable fastest inference with increased plan usage",
        source: "codex-source",
      },
      {
        value: "ide",
        description:
          "include current selection, open files, and other context from your IDE",
        source: "codex-source",
      },
      {
        value: "approvals",
        description: "choose what Codex is allowed to do",
        source: "codex-source",
      },
      {
        value: "permissions",
        description: "choose what Codex is allowed to do",
        source: "codex-source",
      },
      {
        value: "keymap",
        description: "remap TUI shortcuts",
        source: "codex-source",
      },
      {
        value: "vim",
        description: "toggle Vim mode for the composer",
        source: "codex-source",
      },
      {
        value: "skills",
        description: "use skills to improve how Codex performs specific tasks",
        source: "codex-source",
      },
      {
        value: "hooks",
        description: "view and manage lifecycle hooks",
        source: "codex-source",
      },
      {
        value: "review",
        description: "review my current changes and find issues",
        source: "codex-source",
      },
      {
        value: "rename",
        description: "rename the current thread",
        source: "codex-source",
      },
      {
        value: "new",
        description: "start a new chat during a conversation",
        source: "codex-source",
      },
      {
        value: "resume",
        description: "resume a saved chat",
        source: "codex-source",
      },
      {
        value: "fork",
        description: "fork the current chat",
        source: "codex-source",
      },
      {
        value: "init",
        description: "create an AGENTS.md file with instructions for Codex",
        source: "codex-source",
      },
      {
        value: "compact",
        description:
          "summarize conversation to prevent hitting the context limit",
        source: "codex-source",
      },
      {
        value: "plan",
        description: "switch to Plan mode",
        source: "codex-source",
      },
      {
        value: "goal",
        description: "set or view the goal for a long-running task",
        source: "codex-source",
      },
      {
        value: "collab",
        description: "change collaboration mode (experimental)",
        source: "codex-source",
      },
      {
        value: "agent",
        description: "switch the active agent thread",
        source: "codex-source",
      },
      {
        value: "subagents",
        description: "switch the active agent thread",
        source: "codex-source",
      },
      {
        value: "side",
        description: "start a side conversation in an ephemeral fork",
        source: "codex-source",
      },
      {
        value: "copy",
        description: "copy last response as markdown",
        source: "codex-source",
      },
      {
        value: "diff",
        description: "show git diff (including untracked files)",
        source: "codex-source",
      },
      {
        value: "mention",
        description: "mention a file",
        source: "codex-source",
      },
      {
        value: "status",
        description: "show current session configuration and token usage",
        source: "codex-source",
      },
      {
        value: "mcp",
        description: "list configured MCP tools; use /mcp verbose for details",
        source: "codex-source",
      },
      {
        value: "apps",
        description: "manage apps",
        source: "codex-source",
      },
      {
        value: "plugins",
        description: "browse plugins",
        source: "codex-source",
      },
      {
        value: "logout",
        description: "log out of Codex",
        source: "codex-source",
      },
      {
        value: "quit",
        description: "exit Codex",
        source: "codex-source",
      },
      {
        value: "exit",
        description: "exit Codex",
        source: "codex-source",
      },
      {
        value: "feedback",
        description: "send logs to maintainers",
        source: "codex-source",
      },
      {
        value: "stop",
        description: "stop all background terminals",
        source: "codex-source",
      },
      {
        value: "clear",
        description: "clear the terminal and start a new chat",
        source: "codex-source",
      },
      {
        value: "personality",
        description: "choose a communication style for Codex",
        source: "codex-source",
      },
      {
        value: "realtime",
        description: "toggle realtime voice mode (experimental)",
        source: "codex-source",
      },
      {
        value: "settings",
        description: "configure realtime microphone/speaker",
        source: "codex-source",
      },
    ];
  }, [isCodexSession, slashCommands, status.owner, supportsSlashCommands]);

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingTitleRef = useRef(false);

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  // Split view picker state (mobile: triggered from SessionMenu)
  const [showSplitPicker, setShowSplitPicker] = useState(false);
  const splitSessionId = searchParams.get("splitSession");
  const isSplitActive = !!splitSessionId;

  const handleCloseSplit = useCallback(() => {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete("splitSession");
    newParams.delete("splitProject");
    setSearchParams(newParams, { replace: true });
  }, [searchParams, setSearchParams]);

  // Local metadata state (for optimistic updates)
  // Reset when session changes to avoid showing stale data from previous session
  const [localCustomTitle, setLocalCustomTitle] = useState<string | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );

  // Reset local metadata state when sessionId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on sessionId change
  useEffect(() => {
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalHasUnread(undefined);
  }, [sessionId]);

  // Record session visit for recents tracking
  useEffect(() => {
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  // Skip for secondary pane to avoid URL conflicts in split view
  useEffect(() => {
    if (isSecondaryPane) return;
    if (actualSessionId && actualSessionId !== sessionId) {
      // Use replace to avoid creating a history entry for the temp ID
      navigate(
        {
          pathname: buildSessionPath(projectId, actualSessionId),
          search: location.search,
        },
        {
          replace: true,
          state: location.state, // Preserve initial state for seamless transition
        },
      );
    }
  }, [
    actualSessionId,
    sessionId,
    projectId,
    navigate,
    location.state,
    location.search,
    buildSessionPath,
    isSecondaryPane,
  ]);

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<Map<string, Promise<UploadedFile | null>>>(
    new Map(),
  );

  // Abort handler - defined early so useEffect can reference it
  const handleAbort = useCallback(async () => {
    if (status.owner === "self" && "processId" in status) {
      // Try interrupt first (graceful stop), fall back to abort if not supported
      try {
        const result = await api.interruptProcess(status.processId);
        if (result.interrupted) {
          // Successfully interrupted - process is still alive
          return;
        }
        // Interrupt not supported or failed, fall back to abort
      } catch {
        // Interrupt endpoint failed (404 = old server, or other error)
      }
      // Fall back to abort (kills the process)
      await api.abortProcess(status.processId);
    }
  }, [status]);

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  // Process info modal state
  const [showProcessInfoModal, setShowProcessInfoModal] = useState(false);

  // Model switch modal state
  const [showModelSwitchModal, setShowModelSwitchModal] = useState(false);

  // Rollback panel state
  const [showRollbackPanel, setShowRollbackPanel] = useState(false);

  // Track file changes during agent "in-turn" for rollback
  const agentFileChangesRef = useRef<Map<string, FileChangeEvent>>(new Map());
  const lastProcessStateRef = useRef<string>(processState);

  // Subscribe to file-change events during agent runs
  useEffect(() => {
    const unsub = activityBus.on("file-change", (event: FileChangeEvent) => {
      // Only track changes when our session's agent is actively running
      if (processState === "in-turn" && status.owner === "self") {
        agentFileChangesRef.current.set(event.relativePath, event);
      }
    });
    return unsub;
  }, [processState, status.owner]);

  // Clear file changes when a new agent turn starts
  useEffect(() => {
    const prev = lastProcessStateRef.current;
    lastProcessStateRef.current = processState;
    // If transitioning from idle/waiting-input to in-turn, clear previous changes
    if (processState === "in-turn" && prev !== "in-turn") {
      agentFileChangesRef.current.clear();
    }
  }, [processState]);

  // Double-Esc keyboard handler
  const lastEscTimeRef = useRef<number>(0);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;

      const now = Date.now();
      const timeSinceLastEsc = now - lastEscTimeRef.current;
      lastEscTimeRef.current = now;

      // Double-esc: within 400ms
      if (timeSinceLastEsc <= 400) {
        // Only trigger if agent is running
        if (status.owner === "self" && processState === "in-turn") {
          e.preventDefault();
          e.stopPropagation();
          // Abort the agent
          void handleAbort();
          showToast(t("agentInterrupted"), "info");
          // Show rollback panel with accumulated changes
          setShowRollbackPanel(true);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [status.owner, processState, handleAbort, showToast, t]);

  // Track user engagement to mark session as "seen"
  // Only enabled when not in external session (we own or it's idle)
  //
  // We use two timestamps:
  // - activityAt: max(file mtime, SSE activity) - triggers the mark-seen action
  // - updatedAt: file mtime only - the timestamp we record
  //
  // This separation prevents a race condition where SSE timestamps (client clock)
  // could be ahead of file mtime (server disk write time), causing sessions to
  // never become unread again after viewing.
  const sessionUpdatedAt = session?.updatedAt ?? null;
  const activityAt = useMemo(() => {
    if (!sessionUpdatedAt && !lastStreamActivityAt) return null;
    if (!sessionUpdatedAt) return lastStreamActivityAt;
    if (!lastStreamActivityAt) return sessionUpdatedAt;
    // Return the more recent timestamp
    return sessionUpdatedAt > lastStreamActivityAt
      ? sessionUpdatedAt
      : lastStreamActivityAt;
  }, [sessionUpdatedAt, lastStreamActivityAt]);

  useEngagementTracking({
    sessionId,
    activityAt,
    updatedAt: sessionUpdatedAt,
    lastSeenAt: session?.lastSeenAt,
    hasUnread: session?.hasUnread,
    enabled: status.owner !== "external",
  });

  const handleSend = useCallback<SessionMessageSender>(
    async (text: string) => {
      // Add to pending queue and get tempId to pass to server
      const tempId = addPendingMessage(text);
      setProcessState("in-turn"); // Optimistic: show processing indicator immediately
      setScrollTrigger((prev) => prev + 1); // Force scroll to bottom

      // Capture already-completed attachments
      const currentAttachments = [...attachments];

      // Wait for any in-flight uploads to complete before sending
      const pendingAtSendTime = [...pendingUploadsRef.current.values()];
      if (pendingAtSendTime.length > 0) {
        updatePendingMessage(tempId, { status: t("sessionUploading") });
        setAttachments([]); // Clear input area immediately
        const results = await Promise.all(pendingAtSendTime);
        for (const result of results) {
          if (result) currentAttachments.push(result);
        }
        // Remove uploaded files that handleAttach added to state during the wait
        // (they're already captured in currentAttachments). Preserve any new uploads
        // started after send was clicked.
        const sentIds = new Set(currentAttachments.map((a) => a.id));
        setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
        updatePendingMessage(tempId, { status: undefined });
      } else {
        setAttachments([]);
      }

      try {
        if (status.owner === "none") {
          // Resume the session with current permission mode and model settings
          // Use session's existing model if available (important for non-Claude providers),
          // otherwise fall back to user's model preference for new Claude sessions
          const model = session?.model ?? getModelSetting();
          const thinking = getThinkingSetting();
          // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
          // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
          const result = await api.resumeSession(
            projectId,
            sessionId,
            text,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
          );
          // Update status to trigger SSE connection
          setStatus({ owner: "self", processId: result.processId });
        } else {
          // Queue to existing process with current permission mode and thinking setting
          const thinking = getThinkingSetting();
          const result = await api.queueMessage(
            sessionId,
            text,
            permissionMode,
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
            thinking,
          );
          // If process was restarted due to thinking mode change, reconnect stream
          if (result.restarted && result.processId) {
            setStatus({ owner: "self", processId: result.processId });
            reconnectStream();
          }
        }
        // Success - clear the draft from localStorage
        draftControlsRef.current?.clearDraft();
      } catch (err) {
        console.error("Failed to send:", err);

        // Check if process is dead (404) - auto-retry with resumeSession
        const is404 =
          err instanceof Error &&
          (err.message.includes("404") ||
            err.message.includes("No active process"));
        if (is404) {
          try {
            const model = session?.model ?? getModelSetting();
            const thinking = getThinkingSetting();
            const result = await api.resumeSession(
              projectId,
              sessionId,
              text,
              {
                mode: permissionMode,
                model,
                thinking,
                provider: effectiveProvider,
                executor: session?.executor,
              },
              currentAttachments.length > 0 ? currentAttachments : undefined,
              tempId,
            );
            setStatus({ owner: "self", processId: result.processId });
            draftControlsRef.current?.clearDraft();
            return;
          } catch (retryErr) {
            console.error("Failed to resume session:", retryErr);
            // Fall through to error handling below
          }
        }

        // Remove from pending queue and restore draft on error
        removePendingMessage(tempId);
        draftControlsRef.current?.restoreFromStorage();
        setAttachments(currentAttachments); // Restore attachments on error
        setProcessState("idle");
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionSendFailed", { message: errorMsg }), "error");
        throw err instanceof Error ? err : new Error(errorMsg);
      }
    },
    [
      addPendingMessage,
      attachments,
      effectiveProvider,
      permissionMode,
      projectId,
      reconnectStream,
      removePendingMessage,
      session?.executor,
      session?.model,
      sessionId,
      setProcessState,
      setStatus,
      showToast,
      status.owner,
      t,
      updatePendingMessage,
    ],
  );

  useEffect(() => {
    onSendMessageReady?.(handleSend);
    return () => {
      onSendMessageReady?.(null);
    };
  }, [handleSend, onSendMessageReady]);

  const handleQueue = async (text: string) => {
    const tempId = addPendingMessage(text);
    setScrollTrigger((prev) => prev + 1);

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before queuing
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]);
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    try {
      const thinking = getThinkingSetting();
      await api.queueMessage(
        sessionId,
        text,
        permissionMode,
        currentAttachments.length > 0 ? currentAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
      );
      removePendingMessage(tempId);
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments);
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
    }
  };

  const handleModelChanged = useCallback(
    (model: string) => {
      setSessionModel(model);
      showToast(t("sessionSwitchedModel", { model }), "success");
    },
    [setSessionModel, showToast, t],
  );

  const handleCustomCommand = useCallback(
    (command: string) => {
      if (command === "model") {
        setShowModelSwitchModal(true);
        return true;
      }
      if (command === "clear") {
        setMessages([]);
        setAgentContent({});
        showToast(t("sessionCleared"), "success");
        return true;
      }
      return false;
    },
    [setAgentContent, setMessages, showToast, t],
  );

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "approve");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast, t]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        // Approve and switch to acceptEdits mode
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_accept_edits",
        );
        // Update local permission mode
        setPermissionMode("acceptEdits");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, setPermissionMode, showToast, t]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : t("sessionDenyFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast, t]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "deny",
            undefined,
            feedback,
          );
        } catch (err) {
          const status = (err as { status?: number }).status;
          const msg = status ? `Error ${status}` : t("sessionFeedbackFailed");
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast, t],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "approve",
            answers,
          );
        } catch (err) {
          const status = (err as { status?: number }).status;
          const msg = status ? `Error ${status}` : t("sessionAnswerFailed");
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast, t],
  );

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const handleAttach = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = generateUUID();

        // Add to progress tracking
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);

        // Start upload and track promise for handleSend to await
        const uploadPromise = connection
          .upload(projectId, sessionId, file, {
            onProgress: (bytesUploaded) => {
              setUploadProgress((prev) =>
                prev.map((p) =>
                  p.fileId === tempId
                    ? {
                        ...p,
                        bytesUploaded,
                        percent: Math.round((bytesUploaded / file.size) * 100),
                      }
                    : p,
                ),
              );
            },
          })
          .then(
            (uploaded) => {
              setAttachments((prev) => [...prev, uploaded]);
              return uploaded;
            },
            (err) => {
              console.error("Upload failed:", err);
              const errorMsg =
                err instanceof Error ? err.message : t("sessionShareFailed");
              showToast(
                t("sessionUploadFailed", {
                  file: file.name,
                  message: errorMsg,
                }),
                "error",
              );
              return null as UploadedFile | null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((p) => p.fileId !== tempId),
            );
            pendingUploadsRef.current.delete(tempId);
          });

        pendingUploadsRef.current.set(tempId, uploadPromise);
      }
    },
    [projectId, sessionId, showToast, connection, t],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";

  // If process is actively in-turn or waiting for input, don't mark tools as orphaned.
  // "orphanedToolUseIds" from server just means "no result yet" - but if the process is
  // in-turn (e.g., executing a Task subagent) or waiting for approval, they're not orphaned.
  // Also suppress orphan marking when the session stream is disconnected - we can't trust
  // processState without the stream, so show tools as pending (spinner) rather than
  // incorrectly marking them as interrupted.
  const activeToolApproval =
    processState === "in-turn" ||
    processState === "waiting-input" ||
    (hasSessionUpdateStream && !sessionUpdatesConnected);

  // Detect if session has pending tool calls without results
  // This can happen when the session is unowned but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const hasPendingToolCalls = useMemo(() => {
    if (status.owner !== "none") return false;
    const items = preprocessMessages(messages);
    return items.some(
      (item) => item.type === "tool_call" && item.status === "pending",
    );
  }, [messages, status.owner]);

  // Compute display title - priority:
  // 1. Local custom title (user renamed in this session)
  // 2. Session title from server
  // 3. Initial title from navigation state (optimistic, before server responds)
  // 4. "Untitled" as final fallback
  const sessionTitle = getSessionDisplayTitle(session);
  const displayTitle =
    localCustomTitle ??
    (sessionTitle !== "Untitled" ? sessionTitle : null) ??
    initialTitle ??
    t("sessionUntitled");
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;

  // Update browser tab title (skip for secondary pane in split view)
  if (!isSecondaryPane) {
    useDocumentTitle(project?.name, displayTitle);
  }

  const handleStartEditingTitle = () => {
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    // Focus the input and select all text after it renders
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const handleCancelEditingTitle = () => {
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    setIsEditingTitle(false);
    setRenameValue("");
  };

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = () => {
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = async () => {
    if (!renameValue.trim() || isRenaming) return;
    isSavingTitleRef.current = true;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: renameValue.trim() });
      setLocalCustomTitle(renameValue.trim());
      setIsEditingTitle(false);
      showToast(t("sessionRenamed"), "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
    } finally {
      setIsRenaming(false);
      isSavingTitleRef.current = false;
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditingTitle();
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      setLocalIsArchived(newArchived);
      showToast(
        newArchived ? t("sessionArchived") : t("sessionUnarchived"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(t("sessionArchiveFailed"), "error");
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? t("sessionStarred") : t("sessionUnstarred"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast(t("sessionStarFailed"), "error");
    }
  };

  const hasUnread = localHasUnread ?? session?.hasUnread ?? false;

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      showToast(
        newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
      showToast(t("sessionReadFailed"), "error");
    }
  };

  const handleTerminate = async () => {
    if (status.owner === "self" && status.processId) {
      try {
        await api.abortProcess(status.processId);
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleShare = useCallback(async () => {
    try {
      const { snapshotSession } = await import(
        "../lib/sharing/snapshotSession"
      );
      const html = snapshotSession(displayTitle);
      const result = await api.shareSession(html, displayTitle);
      await navigator.clipboard.writeText(result.url);
      showToast(t("sessionLinkCopied"), "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("sessionShareFailed");
      showToast(msg, "error");
    }
  }, [displayTitle, showToast, t]);

  if (error)
    return (
      <div className="flex h-screen items-center justify-center text-sm text-red-600 dark:text-red-400">
        {t("sessionErrorPrefix")} {error.message}
      </div>
    );

  return (
    <div
      className={
        isEmbedded
          ? isEmbeddedMobile
            ? "flex h-full min-h-0 min-w-0 flex-1 overflow-visible bg-[var(--bg-surface)]"
            : "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--bg-surface)]"
          : isWideScreen
            ? "flex min-w-0 justify-center overflow-hidden bg-[var(--bg-surface)]"
            : "flex flex-1 flex-col overflow-hidden bg-[var(--bg-surface)]"
      }
      style={
        isEmbedded
          ? { height: "100%" }
          : isWideScreen && !isEmbedded
            ? { height: "100dvh" }
            : undefined
      }
    >
      <div
        className={
          isEmbedded
            ? isEmbeddedMobile
              ? "flex min-h-0 w-full flex-1 flex-col overflow-visible"
              : "flex min-h-0 w-full flex-1 flex-col overflow-hidden"
            : isWideScreen
              ? "flex w-full flex-col overflow-hidden"
              : "flex flex-1 flex-col overflow-hidden"
        }
        style={isWideScreen && !isEmbedded ? { height: "100dvh" } : undefined}
      >
        <header className="relative z-10 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] pt-[env(safe-area-inset-top,0px)]">
          <div className="flex min-h-[56px] items-center justify-between px-6 py-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {/* Sidebar toggle - on mobile: opens sidebar, on desktop: collapses/expands */}
              {/* Hide on desktop when collapsed (sidebar has its own toggle) */}
              {!isEmbedded && !(isWideScreen && isSidebarCollapsed) && (
                <button
                  type="button"
                  className="btn-icon h-8 w-8 shrink-0"
                  onClick={isWideScreen ? toggleSidebar : openSidebar}
                  title={
                    isWideScreen
                      ? t("sessionToggleSidebar")
                      : t("sessionOpenSidebar")
                  }
                  aria-label={
                    isWideScreen
                      ? t("sessionToggleSidebar")
                      : t("sessionOpenSidebar")
                  }
                >
                  <span className="text-sm font-medium">☰</span>
                </button>
              )}
              {/* Project breadcrumb */}
              {project?.name && (
                <Link
                  to={`${basePath}/sessions?project=${projectId}`}
                  className={`shrink-0 whitespace-nowrap px-0 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] ${
                    isEmbedded
                      ? isWideScreen
                        ? "inline-flex h-5 items-center py-0 leading-none"
                        : "relative z-[1] inline-flex min-h-[16px] items-center py-px leading-[1.25]"
                      : "py-1"
                  }`}
                  title={project.name}
                >
                  {project.name.length > 12
                    ? `${project.name.slice(0, 12)}...`
                    : project.name}
                </Link>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {isStarred && (
                  <span
                    className={`shrink-0 text-amber-500 ${
                      isEmbedded
                        ? "mr-0.5 self-center text-[10px] leading-none"
                        : "mr-1 text-xs"
                    }`}
                    aria-label={t("sessionStarredLabel")}
                    title={t("sessionStarredLabel")}
                  >
                    ★
                  </span>
                )}
                {loading ? (
                  <span className="inline-block h-[1em] w-[120px] animate-pulse rounded bg-[var(--bg-secondary)]" />
                ) : isEditingTitle ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="min-w-[120px] max-w-[calc(100vw-150px)] rounded border border-[var(--border-input)] bg-[var(--bg-input)] px-1.5 py-0.5 text-sm font-medium text-[var(--text-primary)] focus:border-[var(--focus-border)] focus:outline-none"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleTitleBlur}
                    disabled={isRenaming}
                  />
                ) : (
                  <>
                    <button
                      ref={titleButtonRef}
                      type="button"
                      className={`inline-flex max-w-[calc(100vw-150px)] bg-transparent p-0 text-left text-sm font-medium text-[var(--text-primary)] hover:text-[var(--text-secondary)] ${
                        isEmbedded
                          ? isWideScreen
                            ? "h-5 items-center gap-0.5 overflow-hidden py-0"
                            : "min-h-[22px] items-start gap-0.5 overflow-visible py-px"
                          : "items-center gap-1 overflow-hidden"
                      }`}
                      onClick={() => setShowRecentSessions(!showRecentSessions)}
                      title={session?.fullTitle ?? displayTitle}
                    >
                      <span
                        className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${
                          isEmbedded
                            ? isWideScreen
                              ? "[font-family:var(--font-display)] text-sm leading-[1.2]"
                              : "[font-family:var(--font-body)] text-sm leading-[1.3]"
                            : "[font-family:var(--font-display)] text-[1.05rem] leading-none"
                        }`}
                      >
                        {displayTitle}
                      </span>
                      <span className="shrink-0 text-xs opacity-60">▼</span>
                    </button>
                    <RecentSessionsDropdown
                      currentSessionId={sessionId}
                      isOpen={showRecentSessions}
                      onClose={() => setShowRecentSessions(false)}
                      onNavigate={() => setShowRecentSessions(false)}
                      triggerRef={titleButtonRef}
                      basePath={basePath}
                      getSessionPath={buildSessionPath}
                    />
                  </>
                )}
                {!loading && isArchived && (
                  <span
                    className={`ml-1 shrink-0 whitespace-nowrap rounded bg-[var(--bg-secondary)] px-1.5 text-[10px] text-[var(--text-dimmed)] ${
                      isEmbedded
                        ? "inline-flex h-5 items-center py-0 leading-none"
                        : "py-0.5"
                    }`}
                  >
                    {t("sessionArchivedBadge")}
                  </span>
                )}
                {!loading && (
                  <SessionMenu
                    sessionId={sessionId}
                    projectId={projectId}
                    isStarred={isStarred}
                    isArchived={isArchived}
                    hasUnread={hasUnread}
                    provider={session?.provider}
                    processId={
                      status.owner === "self" ? status.processId : undefined
                    }
                    onToggleStar={handleToggleStar}
                    onToggleArchive={handleToggleArchive}
                    onToggleRead={handleToggleRead}
                    onRename={handleStartEditingTitle}
                    onClone={(newSessionId) => {
                      if (isSecondaryPane) {
                        showToast(t("sessionCloneInSplitNotSupported"), "info");
                        return;
                      }
                      navigate(buildSessionPath(projectId, newSessionId));
                    }}
                    onTerminate={handleTerminate}
                    sharingConfigured={sharingConfigured}
                    onShare={handleShare}
                    className={isEmbedded && isWideScreen ? "self-center" : ""}
                    useFixedPositioning
                    useEllipsisIcon
                    onOpenEditor={
                      !isWideScreen && !isSecondaryPane && !isEmbedded
                        ? () =>
                            navigate(
                              buildEditorPath({
                                basePath,
                                projectId,
                                sessionId,
                              }) ?? `${basePath}/projects`,
                            )
                        : undefined
                    }
                    isSplitActive={isSplitActive}
                    onToggleSplitView={
                      !isWideScreen && !isSecondaryPane && !isEmbedded
                        ? () => {
                            if (isSplitActive) {
                              handleCloseSplit();
                            } else {
                              setShowSplitPicker(true);
                            }
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            </div>
            <div className="ml-0.5 flex shrink-0 items-center gap-2">
              {isWideScreen && !isSecondaryPane && !isEmbedded && (
                <Link
                  to={
                    buildEditorPath({
                      basePath,
                      projectId,
                      sessionId,
                    }) ?? `${basePath}/projects`
                  }
                  className="inline-flex items-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
                  title="Editor"
                  aria-label="Editor"
                >
                  Editor
                </Link>
              )}
              {isWideScreen && !isSecondaryPane && !isEmbedded && (
                <SplitViewButton currentSessionId={sessionId} />
              )}
              <ThemeToggle />
              {!loading && effectiveProvider && (
                <button
                  type="button"
                  className="inline-flex rounded-sm bg-transparent p-0 opacity-100 transition-opacity hover:opacity-80 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  onClick={() => setShowProcessInfoModal(true)}
                  title={t("sessionViewInfo")}
                >
                  <ProviderBadge
                    provider={effectiveProvider}
                    model={effectiveModel}
                    isThinking={processState === "in-turn"}
                  />
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Mobile split view picker (triggered from SessionMenu) */}
        {showSplitPicker && (
          <SplitSessionPicker
            currentSessionId={sessionId}
            onSelect={(sid: string, pid: string) => {
              const newParams = new URLSearchParams(searchParams);
              newParams.set("splitSession", sid);
              newParams.set("splitProject", pid);
              setSearchParams(newParams, { replace: true });
              setShowSplitPicker(false);
            }}
            onClose={() => setShowSplitPicker(false)}
          />
        )}

        {/* Process Info Modal */}
        {showProcessInfoModal && session && (
          <ProcessInfoModal
            sessionId={actualSessionId}
            provider={session.provider}
            model={session.model}
            status={status}
            processState={processState}
            contextUsage={session.contextUsage}
            originator={session.originator}
            cliVersion={session.cliVersion}
            sessionSource={session.source}
            approvalPolicy={session.approvalPolicy}
            sandboxPolicy={session.sandboxPolicy}
            createdAt={session.createdAt}
            sessionStreamConnected={sessionUpdatesConnected}
            lastSessionEventAt={lastStreamActivityAt}
            onClose={() => setShowProcessInfoModal(false)}
          />
        )}

        {/* Model Switch Modal */}
        {showModelSwitchModal &&
          status.owner === "self" &&
          status.processId && (
            <ModelSwitchModal
              processId={status.processId}
              currentModel={session?.model}
              onModelChanged={handleModelChanged}
              onClose={() => setShowModelSwitchModal(false)}
            />
          )}

        {status.owner === "external" && (
          <div className="border border-[var(--warning-color)] bg-[rgba(154,103,0,0.06)] px-4 py-3 text-center text-sm font-medium text-[var(--warning-color)]">
            {t("sessionExternalWarning")}
          </div>
        )}

        {hasPendingToolCalls && (
          <div className="border border-[var(--attention-color)] bg-[rgba(0,102,204,0.06)] px-4 py-3 text-center text-sm font-medium text-[var(--attention-color)]">
            {t("sessionPendingElsewhereWarning")}
          </div>
        )}

        <main
          data-session-messages
          className={
            isEmbedded
              ? "min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4"
              : "min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-8 md:px-10 md:py-10"
          }
          style={isEmbedded ? { scrollbarWidth: "none" } : undefined}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
              {t("sessionLoading")}
            </div>
          ) : (
            <SessionMetadataProvider
              projectId={projectId}
              projectPath={project?.path ?? null}
              sessionId={sessionId}
            >
              <AgentContentProvider
                agentContent={agentContent}
                setAgentContent={setAgentContent}
                toolUseToAgent={toolUseToAgent}
                projectId={projectId}
                sessionId={sessionId}
              >
                <div
                  className={
                    isEmbedded ? "w-full min-w-0" : "mx-auto max-w-[52rem]"
                  }
                >
                  <MessageList
                    messages={messages}
                    provider={session?.provider}
                    isProcessing={
                      status.owner === "self" && processState === "in-turn"
                    }
                    isCompacting={isCompacting}
                    scrollTrigger={scrollTrigger}
                    pendingMessages={pendingMessages}
                    deferredMessages={deferredMessages}
                    onCancelDeferred={(tempId) =>
                      api.cancelDeferredMessage(sessionId, tempId)
                    }
                    markdownAugments={markdownAugments}
                    activeToolApproval={activeToolApproval}
                    hasOlderMessages={pagination?.hasOlderMessages}
                    loadingOlder={loadingOlder}
                    onLoadOlderMessages={loadOlderMessages}
                  />
                </div>
              </AgentContentProvider>
            </SessionMetadataProvider>
          )}
        </main>

        <footer className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
          <div
            className={`pointer-events-none mb-0.5 h-px transition-colors duration-300 ${
              sessionConnectionStatus === "connected"
                ? "bg-green-500"
                : sessionConnectionStatus === "connecting"
                  ? "animate-pulse bg-amber-500"
                  : sessionConnectionStatus === "disconnected"
                    ? "bg-red-500"
                    : "bg-[var(--border-subtle)]"
            }`}
          />
          <div
            className={isEmbedded ? "w-full min-w-0" : "mx-auto max-w-[52rem]"}
          >
            {/* User question panel */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              isAskUserQuestion && (
                <QuestionAnswerPanel
                  request={pendingInputRequest}
                  sessionId={actualSessionId}
                  onSubmit={handleQuestionSubmit}
                  onDeny={handleDeny}
                />
              )}

            {/* Tool approval: show panel + always-visible toolbar */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion && (
                <>
                  <ToolApprovalPanel
                    request={pendingInputRequest}
                    sessionId={actualSessionId}
                    onApprove={handleApprove}
                    onDeny={handleDeny}
                    onApproveAcceptEdits={handleApproveAcceptEdits}
                    onDenyWithFeedback={handleDenyWithFeedback}
                    collapsed={approvalCollapsed}
                    onCollapsedChange={setApprovalCollapsed}
                  />
                  <MessageInputToolbar
                    mode={permissionMode}
                    onModeChange={setPermissionMode}
                    isHeld={holdModeEnabled ? isHeld : undefined}
                    onHoldChange={holdModeEnabled ? setHold : undefined}
                    supportsPermissionMode={supportsPermissionMode}
                    supportedPermissionModes={supportedPermissionModes}
                    supportsThinkingToggle={supportsThinkingToggle}
                    contextUsage={session?.contextUsage}
                    isRunning={status.owner === "self"}
                    isThinking={processState === "in-turn"}
                    onStop={handleAbort}
                    pendingApproval={
                      approvalCollapsed
                        ? {
                            type: "tool-approval",
                            onExpand: () => setApprovalCollapsed(false),
                          }
                        : undefined
                    }
                  />
                </>
              )}

            {/* No pending approval: show full message input */}
            {!(
              pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion
            ) && (
              <MessageInput
                onSend={handleSend}
                onQueue={
                  status.owner !== "none" && processState !== "idle"
                    ? handleQueue
                    : undefined
                }
                placeholder={
                  status.owner === "external"
                    ? t("sessionPlaceholderExternal")
                    : processState === "idle"
                      ? t("sessionPlaceholderResume")
                      : t("sessionPlaceholderQueue")
                }
                mode={permissionMode}
                onModeChange={setPermissionMode}
                isHeld={holdModeEnabled ? isHeld : undefined}
                onHoldChange={holdModeEnabled ? setHold : undefined}
                supportsPermissionMode={supportsPermissionMode}
                supportedPermissionModes={supportedPermissionModes}
                supportsThinkingToggle={supportsThinkingToggle}
                isRunning={status.owner === "self"}
                isThinking={processState === "in-turn"}
                onStop={handleAbort}
                draftKey={`draft-message-${sessionId}`}
                onDraftControlsReady={handleDraftControlsReady}
                collapsed={
                  !!(
                    pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId
                  )
                }
                contextUsage={session?.contextUsage}
                projectId={projectId}
                sessionId={sessionId}
                attachments={attachments}
                onAttach={handleAttach}
                onRemoveAttachment={handleRemoveAttachment}
                uploadProgress={uploadProgress}
                slashCommands={availableSlashCommands}
                onCustomCommand={handleCustomCommand}
              />
            )}
          </div>
        </footer>

        {/* Rollback panel */}
        {showRollbackPanel && (
          <RollbackPanel
            changes={Array.from(agentFileChangesRef.current.values())}
            projectId={projectId}
            onClose={() => setShowRollbackPanel(false)}
            onRestoreSuccess={() => {
              agentFileChangesRef.current.clear();
              setShowRollbackPanel(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
