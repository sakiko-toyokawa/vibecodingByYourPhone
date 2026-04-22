/**
 * OpenCode Schema
 *
 * Zod schemas for parsing OpenCode server SSE events and session storage.
 * Based on the event types from `opencode serve` HTTP/SSE API.
 *
 * Event types:
 * - server.connected: Initial connection established
 * - session.status: Session busy/idle state changes
 * - session.updated: Session metadata updated
 * - session.idle: Session finished processing
 * - message.updated: Message metadata updated
 * - message.part.updated: Message content streaming (with delta)
 * - session.diff: File diff information
 *
 * Session storage:
 * - OpenCode stores sessions in ~/.local/share/opencode/storage/
 * - Directory-based structure with JSON files for projects, sessions, messages, and parts
 */

export * from "./events.js";
export * from "./session.js";
export * from "./types.js";
