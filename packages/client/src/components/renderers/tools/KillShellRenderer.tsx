import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { KillShellInput, KillShellResult, ToolRenderer } from "./types";

/**
 * KillShell tool use - shows shell_id being killed
 */
function KillShellToolUse({ input }: { input: KillShellInput }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--text-secondary,var(--text-muted))]">
        Killing shell
      </span>
      <code className="rounded-[3px] bg-[var(--bg-code)] px-1 py-0.5 [font-family:var(--font-mono)] text-base text-[var(--text-muted)]">
        {input.shell_id}
      </code>
    </div>
  );
}

/**
 * KillShell tool result - shows confirmation message
 */
function KillShellToolResult({
  result,
  isError,
}: {
  result: KillShellResult;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("KillShell", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("KillShell", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("KillShell");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="KillShell" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to kill shell"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">No result</div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="KillShell" errors={validationErrors} />
      )}
      <span className="text-[var(--text-secondary,var(--text-muted))]">
        {result.message}
      </span>
      {result.shell_id && (
        <code className="rounded-[3px] bg-[var(--bg-code)] px-1 py-0.5 [font-family:var(--font-mono)] text-base text-[var(--text-muted)]">
          {result.shell_id}
        </code>
      )}
    </div>
  );
}

export const killShellRenderer: ToolRenderer<KillShellInput, KillShellResult> =
  {
    tool: "KillShell",

    renderToolUse(input, _context) {
      return <KillShellToolUse input={input as KillShellInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <KillShellToolResult
          result={result as KillShellResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      return (input as KillShellInput).shell_id;
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as KillShellResult;
      return r?.message || "Killed";
    },
  };
