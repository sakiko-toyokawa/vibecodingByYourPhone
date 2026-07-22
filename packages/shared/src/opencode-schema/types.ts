/**
 * Type-only exports for OpenCode schema.
 * Import from here to avoid pulling in Zod runtime.
 */

// SSE event types
export type {
  OpenCodeSessionStatus,
  OpenCodeTokens,
  OpenCodeTime,
  OpenCodePart,
  OpenCodeMessageInfo,
  OpenCodeSessionInfo,
  OpenCodeServerConnectedEvent,
  OpenCodeSessionStatusEvent,
  OpenCodeSessionUpdatedEvent,
  OpenCodeSessionIdleEvent,
  OpenCodeSessionDiffEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeSSEEvent,
} from "./events.js";

// Session storage types
export type {
  OpenCodeProject,
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeStoredPart,
  OpenCodeSessionEntry,
  OpenCodeSessionContent,
} from "./session.js";
