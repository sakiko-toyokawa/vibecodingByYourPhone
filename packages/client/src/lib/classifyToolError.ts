/**
 * Classify tool errors for appropriate UI rendering.
 *
 * Based on analysis of real error patterns from Claude session files.
 * See scripts/classify-tool-errors.ts for the analysis script.
 */

export type ErrorClassification =
  | "user_rejection" // User explicitly rejected the tool call
  | "user_rejection_with_reason" // User rejected with a custom reason
  | "command_failure" // Exit code non-zero, shell errors
  | "file_error" // File not found, permission denied, modified since read
  | "validation_error" // Schema validation, input validation, edit conflicts
  | "timeout" // Operation timed out
  | "network_error" // Network/fetch failures
  | "unknown"; // Can't classify

export interface ClassificationResult {
  classification: ErrorClassification;
  /** Cleaned error message (without "Error:" prefix, <tool_use_error> tags, etc.) */
  cleanedMessage: string;
  /** User's rejection reason if this is a user_rejection_with_reason */
  userReason?: string;
  /** Short label for badge display */
  label: string;
}

interface PatternDef {
  pattern: RegExp;
  classification: ErrorClassification;
  label: string;
  /** If true, extract the user's reason from the message */
  extractReason?: boolean;
}

/**
 * Patterns for classifying error messages.
 * Order matters - first match wins.
 */
const PATTERNS: PatternDef[] = [
  // User rejections - explicit patterns
  {
    pattern: /^User denied permission\.?$/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^User did not (approve|allow|permit)/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^Permission denied by user/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^Rejected by user/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^The user doesn't want to proceed/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^The user doesn't want to take this action/i,
    classification: "user_rejection",
    label: "Declined",
  },
  {
    pattern: /^\[Request interrupted by user/i,
    classification: "user_rejection",
    label: "Interrupted",
  },
  {
    pattern: /^User cancelled/i,
    classification: "user_rejection",
    label: "Cancelled",
  },
  {
    pattern: /^Plan mode - tools not executed/i,
    classification: "user_rejection",
    label: "Plan mode",
  },

  // Command failures
  {
    pattern: /^Exit code [1-9]\d*/,
    classification: "command_failure",
    label: "Exit code",
  },
  {
    pattern: /ELIFECYCLE.*Command failed/,
    classification: "command_failure",
    label: "Command failed",
  },
  {
    pattern: /command not found/i,
    classification: "command_failure",
    label: "Not found",
  },
  {
    pattern: /Shell \d+ is not running/i,
    classification: "command_failure",
    label: "Shell stopped",
  },
  {
    pattern: /<tool_use_error>.*No shell found/i,
    classification: "command_failure",
    label: "Shell not found",
  },
  {
    pattern: /<tool_use_error>.*No task found/i,
    classification: "command_failure",
    label: "Task not found",
  },

  // File errors
  {
    pattern: /<tool_use_error>.*File has been modified since read/i,
    classification: "file_error",
    label: "File changed",
  },
  {
    pattern: /^File has been unexpectedly modified/i,
    classification: "file_error",
    label: "File changed",
  },
  {
    pattern: /<tool_use_error>.*File has not been read yet/i,
    classification: "file_error",
    label: "Not read yet",
  },
  {
    pattern: /<tool_use_error>.*File does not exist/i,
    classification: "file_error",
    label: "Not found",
  },
  {
    pattern: /<tool_use_error>.*No such file or directory/i,
    classification: "file_error",
    label: "Not found",
  },
  {
    pattern: /<tool_use_error>.*Permission denied/i,
    classification: "file_error",
    label: "Permission denied",
  },
  {
    pattern: /ENOENT/,
    classification: "file_error",
    label: "Not found",
  },
  {
    pattern: /EACCES/,
    classification: "file_error",
    label: "Permission denied",
  },
  {
    pattern: /No plan file found/i,
    classification: "file_error",
    label: "Plan not found",
  },
  {
    pattern: /<tool_use_error>.*Path does not exist/i,
    classification: "file_error",
    label: "Path not found",
  },

  // Validation errors
  {
    pattern: /<tool_use_error>.*old_string.*not found/i,
    classification: "validation_error",
    label: "Not found",
  },
  {
    pattern: /<tool_use_error>.*not unique/i,
    classification: "validation_error",
    label: "Not unique",
  },
  {
    pattern: /<tool_use_error>.*Found \d+ matches.*replace_all is false/i,
    classification: "validation_error",
    label: "Multiple matches",
  },
  {
    pattern: /<tool_use_error>.*InputValidationError/i,
    classification: "validation_error",
    label: "Invalid input",
  },
  {
    pattern: /Invalid (input|parameter|argument)/i,
    classification: "validation_error",
    label: "Invalid input",
  },
  {
    pattern:
      /<tool_use_error>.*No changes to make.*old_string and new_string are exactly the same/i,
    classification: "validation_error",
    label: "No changes",
  },
  {
    pattern: /<tool_use_error>.*String to replace not found/i,
    classification: "validation_error",
    label: "Not found",
  },
  {
    pattern: /File content.*exceeds maximum/i,
    classification: "validation_error",
    label: "Too large",
  },
  {
    pattern: /<tool_use_error>.*exceeds maximum allowed/i,
    classification: "validation_error",
    label: "Too large",
  },
  {
    pattern: /Agent type .* not found/i,
    classification: "validation_error",
    label: "Unknown agent",
  },

  // Network/API errors
  {
    pattern: /^Request failed with status code/i,
    classification: "network_error",
    label: "Request failed",
  },
  {
    pattern: /ECONNREFUSED/,
    classification: "network_error",
    label: "Connection refused",
  },
  {
    pattern: /ENOTFOUND/,
    classification: "network_error",
    label: "Not found",
  },
  {
    pattern: /fetch failed/i,
    classification: "network_error",
    label: "Fetch failed",
  },
  {
    pattern: /Tool permission request failed/i,
    classification: "network_error",
    label: "Connection lost",
  },

  // Timeout errors
  {
    pattern: /timed? ?out/i,
    classification: "timeout",
    label: "Timeout",
  },
  {
    pattern: /ETIMEDOUT/,
    classification: "timeout",
    label: "Timeout",
  },
];

/**
 * Clean an error message by removing common prefixes and wrappers.
 */
function cleanErrorMessage(content: string): string {
  let cleaned = content;

  // Remove "Error: " prefix
  cleaned = cleaned.replace(/^Error:\s*/i, "");

  // Remove <tool_use_error> tags
  cleaned = cleaned.replace(/<\/?tool_use_error>/gi, "");

  // Trim whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Extract user rejection reason from a rejection message.
 */
function extractUserReason(content: string): string | undefined {
  // Pattern: "The user doesn't want to proceed... provided the following reason for the rejection: <reason>"
  const reasonMatch = content.match(
    /provided the following reason[^:]*:\s*(.+)/is,
  );
  if (reasonMatch?.[1]) {
    return reasonMatch[1].trim();
  }

  return undefined;
}

/**
 * Check if a message looks like a user rejection with a custom reason.
 * These are short, human-written messages that don't match system error patterns.
 */
function looksLikeUserRejection(content: string): boolean {
  const cleaned = cleanErrorMessage(content);

  // Very short messages that don't match system patterns are likely user rejections
  if (cleaned.length > 200) return false;

  // Check it's not a system error pattern
  const hasSystemPattern =
    /exit code|ENOENT|EACCES|<tool_use_error>|command failed|permission denied|not found|does not exist/i.test(
      cleaned,
    );
  if (hasSystemPattern) return false;

  // Check if it looks like human-written text
  const looksHuman =
    /^[a-zA-Z]/.test(cleaned) && // Starts with letter
    cleaned.includes(" ") && // Has spaces (is a phrase)
    !/^[A-Z_]+:/.test(cleaned) && // Doesn't start with ERROR: or similar
    !/\n.*\n/.test(cleaned); // Single line or simple

  return looksHuman;
}

/**
 * Classify a tool error message for appropriate UI rendering.
 *
 * @param content - The error content (from block.content or toolResult.content)
 * @returns Classification result with cleaned message and label
 */
export function classifyToolError(content: string): ClassificationResult {
  // Check patterns first
  for (const { pattern, classification, label } of PATTERNS) {
    if (pattern.test(content)) {
      const cleanedMessage = cleanErrorMessage(content);

      // For user rejections, try to extract the reason
      if (classification === "user_rejection") {
        const userReason = extractUserReason(content);
        if (userReason) {
          return {
            classification: "user_rejection_with_reason",
            cleanedMessage,
            userReason,
            label,
          };
        }
      }

      return {
        classification,
        cleanedMessage,
        label,
      };
    }
  }

  // Check heuristics for user rejections with custom reasons
  if (looksLikeUserRejection(content)) {
    const cleanedMessage = cleanErrorMessage(content);
    return {
      classification: "user_rejection_with_reason",
      cleanedMessage,
      userReason: cleanedMessage,
      label: "Declined",
    };
  }

  // Unknown error type
  return {
    classification: "unknown",
    cleanedMessage: cleanErrorMessage(content),
    label: "Error",
  };
}

/**
 * Get CSS class suffix for an error classification.
 * Use with classes like "badge-{suffix}" or "tool-error-{suffix}".
 */
export function getErrorClassSuffix(
  classification: ErrorClassification,
): string {
  switch (classification) {
    case "user_rejection":
    case "user_rejection_with_reason":
      return "muted"; // Gray, non-alarming
    default:
      return "warning"; // Amber/orange, not red
  }
}

/**
 * Check if an error is a user rejection (with or without reason).
 */
export function isUserRejection(classification: ErrorClassification): boolean {
  return (
    classification === "user_rejection" ||
    classification === "user_rejection_with_reason"
  );
}
