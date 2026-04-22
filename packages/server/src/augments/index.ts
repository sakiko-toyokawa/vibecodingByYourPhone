/**
 * Augments module - Server-side rendering for streaming content
 *
 * This module provides components for:
 * - Rendering markdown blocks as they stream in from Claude
 * - Computing edit augments with unified diff and syntax highlighting
 * - Transport-agnostic stream augmentation for WebSocket subscriptions
 */

// Block detection
export { BlockDetector, type CompletedBlock } from "./block-detector.js";

// Augment generation
export {
  type Augment,
  type AugmentGenerator,
  type AugmentGeneratorConfig,
  createAugmentGenerator,
} from "./augment-generator.js";

// Stream coordination (combines block detection and augment generation)
export {
  type StreamChunkResult,
  type StreamCoordinator,
  createStreamCoordinator,
} from "./stream-coordinator.js";

// Edit augments (unified diff computation and highlighting)
export {
  computeEditAugment,
  computeStructuredPatchDiffHtml,
  type EditInput,
} from "./edit-augments.js";

// Write augments (syntax highlighting for written files)
export {
  computeWriteAugment,
  type WriteInput,
  type WriteAugmentResult,
} from "./write-augments.js";

// Read augments (syntax highlighting for read file content)
export {
  computeReadAugment,
  type ReadAugmentInput,
  type ReadAugmentResult,
} from "./read-augments.js";

// Shared types for augmentation
export type {
  EditInputWithAugment,
  ExitPlanModeInput,
  ExitPlanModeResult,
  ReadResultWithAugment,
  SDKMessageLike,
  WriteInputWithAugment,
} from "./types.js";

// Message parsing utilities
export {
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextForFinalRender,
  extractTextFromAssistant,
  getMessageContent,
  isMessageStop,
  isResultMessage,
  isStreamingComplete,
  markSubagent,
} from "./message-utils.js";

// Stream augmenter (transport-agnostic)
export {
  createStreamAugmenter,
  type MarkdownAugmentData,
  type PendingData,
  type StreamAugmenter,
  type StreamAugmenterConfig,
} from "./stream-augmenter.js";
