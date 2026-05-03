import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import {
  getDisplayBashCommandFromInput,
  isCodexProvider,
} from "../../../lib/bashCommand";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { BashInput, BashResult, ToolRenderer } from "./types";

const MAX_LINES_COLLAPSED = 20;
const MAX_LINES_TOOL_USE = 12;
const DEFAULT_PREVIEW_LINES = 4;
const DEFAULT_PREVIEW_MAX_CHARS = 400;
const CODEX_PREVIEW_LINES = 2;
const CODEX_PREVIEW_MAX_CHARS = 220;

const CODEX_NOISE_PATTERNS = [
  /^npm warn (?:unknown env config|config)\s+["']recursive["']/i,
  /^this will stop working in the next major version of npm\.?$/i,
];

const terminalFrameClasses =
  "rounded-[16px] border border-[var(--border-color)] bg-[var(--bg-code)] px-4 py-3 [font-family:var(--font-mono)] text-[13px] leading-6 text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]";

const subtleButtonClasses =
  "min-h-[40px] rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";

function StatusPill({
  tone,
  children,
}: {
  tone: "amber" | "blue";
  children: ReactNode;
}) {
  const tones = {
    amber:
      "border-[var(--warning-color)] bg-[var(--bg-warning)] text-[var(--warning-color)]",
    blue: "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
  };

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function normalizeBashResult(
  result: BashResult | string | undefined,
  isError: boolean,
): BashResult {
  if (!result) {
    return { stdout: "", stderr: "", interrupted: false, isImage: false };
  }
  if (typeof result === "string") {
    return {
      stdout: isError ? "" : result,
      stderr: isError ? result : "",
      interrupted: false,
      isImage: false,
    };
  }
  return result;
}

function getBashCommand(input: BashInput): string {
  return getDisplayBashCommandFromInput(input);
}

function sanitizeOutputForPreview(output: string, provider?: string): string {
  const normalized = output.replace(/\r\n/g, "\n");
  if (!isCodexProvider(provider)) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    return !CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });

  return filtered.length === 0 ? normalized : filtered.join("\n");
}

function getPreviewLimits(provider?: string): {
  maxLines: number;
  maxChars: number;
} {
  if (isCodexProvider(provider)) {
    return {
      maxLines: CODEX_PREVIEW_LINES,
      maxChars: CODEX_PREVIEW_MAX_CHARS,
    };
  }

  return {
    maxLines: DEFAULT_PREVIEW_LINES,
    maxChars: DEFAULT_PREVIEW_MAX_CHARS,
  };
}

function CodePanel({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <pre
      className={`${terminalFrameClasses} overflow-x-auto whitespace-pre-wrap break-words ${tone === "error" ? "border-[var(--error-color)] text-[var(--error-color)]" : ""}`}
    >
      <code>{children}</code>
    </pre>
  );
}

function BashModalContent({
  input,
  result: rawResult,
  isError,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
}) {
  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;
  const command = getBashCommand(input);
  const stdout = result?.stdout || "";
  const stderr = result?.stderr || "";

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Command
        </div>
        <CodePanel>{command}</CodePanel>
      </section>
      {stdout && (
        <section className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Output
          </div>
          <CodePanel>{stdout}</CodePanel>
        </section>
      )}
      {stderr && (
        <section className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--error-color)]">
            {isError ? "Error" : "Stderr"}
          </div>
          <CodePanel tone="error">{stderr}</CodePanel>
        </section>
      )}
      {!stdout && !stderr && result && !result.interrupted && (
        <div className="text-sm italic text-[var(--text-muted)]">No output</div>
      )}
      {result?.interrupted && <StatusPill tone="amber">Interrupted</StatusPill>}
      {result?.backgroundTaskId && (
        <StatusPill tone="blue">
          Background: {result.backgroundTaskId}
        </StatusPill>
      )}
    </div>
  );
}

function BashToolUse({ input }: { input: BashInput }) {
  const command = getBashCommand(input);
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = command.split("\n");
  const needsCollapse = lines.length > MAX_LINES_TOOL_USE;
  const displayCommand =
    needsCollapse && !isExpanded
      ? `${lines.slice(0, MAX_LINES_TOOL_USE).join("\n")}\n...`
      : command;

  return (
    <div className="flex flex-col gap-3">
      <CodePanel>{displayCommand}</CodePanel>
      {needsCollapse && (
        <button
          type="button"
          className={subtleButtonClasses}
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function BashToolResult({
  result: rawResult,
  isError,
}: {
  result: BashResult | string;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  const result = normalizeBashResult(rawResult, isError);

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const stdoutLines = stdout.split("\n");
  const needsCollapse = stdoutLines.length > MAX_LINES_COLLAPSED;
  const displayStdout =
    needsCollapse && !isExpanded
      ? `${stdoutLines.slice(0, MAX_LINES_COLLAPSED).join("\n")}\n...`
      : stdout;

  return (
    <div className="flex flex-col gap-3">
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Bash" errors={validationErrors} />
      )}
      {result.interrupted && <StatusPill tone="amber">Interrupted</StatusPill>}
      {result.backgroundTaskId && (
        <StatusPill tone="blue">
          Background: {result.backgroundTaskId}
        </StatusPill>
      )}
      {stdout && <CodePanel>{displayStdout}</CodePanel>}
      {needsCollapse && (
        <button
          type="button"
          className={subtleButtonClasses}
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "Show less" : `Show all ${stdoutLines.length} lines`}
        </button>
      )}
      {stderr && <CodePanel tone="error">{stderr}</CodePanel>}
      {!stdout && !stderr && !result.interrupted && (
        <div className="text-sm italic text-[var(--text-muted)]">No output</div>
      )}
    </div>
  );
}

function truncateOutput(
  text: string,
  limits: { maxLines: number; maxChars: number },
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let result = "";
  let charCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (lineCount >= limits.maxLines || charCount >= limits.maxChars) {
      return { text: result.trimEnd(), truncated: true };
    }
    const remaining = limits.maxChars - charCount;
    if (line.length > remaining) {
      result += `${line.slice(0, remaining)}...`;
      return { text: result.trimEnd(), truncated: true };
    }
    result += `${line}\n`;
    charCount += line.length + 1;
    lineCount++;
  }

  return { text: result.trimEnd(), truncated: false };
}

function BashCollapsedPreview({
  input,
  result: rawResult,
  isError,
  provider,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
  provider?: string;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const output = sanitizeOutputForPreview(
    result?.stdout || result?.stderr || "",
    provider,
  );
  const command = getBashCommand(input);
  const { text: previewText, truncated } = truncateOutput(
    output,
    getPreviewLimits(provider),
  );
  const hasOutput = previewText.length > 0;

  const handleClick = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        className="group w-full overflow-hidden rounded-[16px] border border-[var(--border-color)] bg-[var(--bg-code)] text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-[var(--border-input)]"
        onClick={handleClick}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            className="text-[var(--text-muted)]"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Bash Output
          </span>
          <span className="ml-auto text-[10px] text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100">
            Click to expand
          </span>
        </div>
        <div className="flex gap-3 border-b border-[var(--border-color)] px-3 py-2">
          <span className="w-8 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            In
          </span>
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap [font-family:var(--font-mono)] text-[13px] text-[var(--text-primary)]">
            {command}
          </code>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Bash" errors={validationErrors} />
          )}
        </div>
        {hasOutput && (
          <div className="flex gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Out
            </span>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              <pre
                className={`m-0 whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-[13px] leading-6 ${isError || result?.stderr ? "text-[var(--error-color)]" : "text-[var(--text-secondary)]"}`}
              >
                <code>{previewText}</code>
              </pre>
              {truncated && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--bg-code)] to-transparent" />
              )}
            </div>
          </div>
        )}
        {!hasOutput && result && !result.interrupted && (
          <div className="flex gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Out
            </span>
            <span className="text-sm italic text-[var(--text-muted)]">
              No output
            </span>
          </div>
        )}
        {result?.interrupted && (
          <div className="flex gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Out
            </span>
            <span className="text-sm italic text-[var(--warning-color)]">
              Interrupted
            </span>
          </div>
        )}
      </button>
      {isModalOpen && (
        <Modal
          title={input.description || "Bash Command"}
          onClose={handleClose}
        >
          <BashModalContent input={input} result={result} isError={isError} />
        </Modal>
      )}
    </>
  );
}

export const bashRenderer: ToolRenderer<BashInput, BashResult> = {
  tool: "Bash",

  renderToolUse(input, _context) {
    return <BashToolUse input={input as BashInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <BashToolResult result={result as BashResult} isError={isError} />;
  },

  getUseSummary(input) {
    const i = input as BashInput;
    const command = getBashCommand(i);
    if (i.description) {
      return i.description;
    }
    if (!command) {
      return "Bash command";
    }
    const firstLine = command.split("\n")[0] ?? command;
    if (firstLine.length > 200) {
      return `${firstLine.slice(0, 200)}...`;
    }
    if (command.includes("\n")) {
      return `${firstLine}...`;
    }
    return command;
  },

  getResultSummary(result, isError) {
    const r = result as BashResult;
    if (r?.interrupted) return "Interrupted";
    if (isError || r?.stderr) return "Error";
    return "";
  },

  renderCollapsedPreview(input, result, isError, context) {
    return (
      <BashCollapsedPreview
        input={input as BashInput}
        result={result as BashResult | string | undefined}
        isError={isError}
        provider={context.provider}
      />
    );
  },
};
