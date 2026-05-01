import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { ToolRenderer, WebSearchInput, WebSearchResult } from "./types";

/**
 * WebSearch tool use - shows search query
 */
function WebSearchToolUse({ input }: { input: WebSearchInput }) {
  return (
    <div className="flex items-center gap-2">
      <span className="[font-family:var(--font-mono)] text-lg text-[var(--link-color)]">
        {input.query}
      </span>
    </div>
  );
}

/**
 * WebSearch tool result - shows search results as links
 */
function WebSearchToolResult({
  result,
  isError,
}: {
  result: WebSearchResult;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebSearch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebSearch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebSearch");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Search failed"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">No results</div>
    );
  }

  // Flatten results from potentially nested structure
  const allResults =
    result.results?.flatMap((r) => r.content || []).filter(Boolean) || [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="italic text-[var(--text-secondary,var(--text-muted))]">
          "{result.query}"
        </span>
        {result.durationSeconds !== undefined && (
          <span className="inline-block rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-sm font-medium text-[var(--text-muted)]">
            {result.durationSeconds.toFixed(2)}s
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
      </div>
      {allResults.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {allResults.map((item, i) => (
            <li
              key={`${item.url}-${i}`}
              className="flex cursor-pointer flex-col gap-0.5 rounded bg-[var(--bg-code)] p-2 hover:bg-[var(--bg-tertiary)]"
            >
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-[var(--link-color)] no-underline hover:underline"
              >
                {item.title}
              </a>
              <span className="break-all text-sm text-[var(--text-muted)]">
                {item.url}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-lg italic text-[var(--text-muted)]">
          No results found
        </div>
      )}
    </div>
  );
}

export const webSearchRenderer: ToolRenderer<WebSearchInput, WebSearchResult> =
  {
    tool: "WebSearch",

    renderToolUse(input, _context) {
      return <WebSearchToolUse input={input as WebSearchInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <WebSearchToolResult
          result={result as WebSearchResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      return (input as WebSearchInput).query;
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as WebSearchResult;
      const count = r?.results?.flatMap((res) => res.content || []).length || 0;
      return `${count} results`;
    },
  };
