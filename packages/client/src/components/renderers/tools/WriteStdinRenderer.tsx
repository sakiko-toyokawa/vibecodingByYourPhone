import { useState } from "react";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer, WriteStdinInput, WriteStdinResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionId(input: unknown): string {
  if (!isRecord(input)) {
    return "unknown";
  }
  const value = input.session_id;
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "unknown";
}

function getChars(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.chars !== "string") {
    return undefined;
  }
  return input.chars;
}

function getLinkedCommand(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (
    typeof input.linked_command === "string" &&
    input.linked_command.trim().length > 0
  ) {
    return input.linked_command;
  }
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }
  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }
  return undefined;
}

function getLinkedFilePath(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.linked_file_path !== "string") {
    return undefined;
  }
  const filePath = input.linked_file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getLinkedToolName(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.linked_tool_name !== "string") {
    return undefined;
  }
  const toolName = input.linked_tool_name.trim();
  return toolName.length > 0 ? toolName : undefined;
}

function getInputTargetLabel(input: unknown): string | undefined {
  const filePath = getLinkedFilePath(input);
  if (filePath) {
    return getFileName(filePath);
  }
  return getLinkedCommand(input);
}

function getOriginLabel(input: unknown): string | undefined {
  const linkedToolName = getLinkedToolName(input);
  const target = getInputTargetLabel(input);
  const prefix =
    linkedToolName === "Read"
      ? "Read via PTY"
      : linkedToolName === "Write"
        ? "Write via PTY"
        : linkedToolName === "Edit"
          ? "Edit via PTY"
          : linkedToolName === "Bash"
            ? "Command via PTY"
            : undefined;

  if (prefix && target) {
    return `${prefix}: ${target}`;
  }
  if (prefix) {
    return prefix;
  }
  return target;
}

function formatChars(chars: string | undefined): string {
  if (chars === undefined || chars.length === 0) {
    return "(poll)";
  }

  const escapedJson = JSON.stringify(chars);
  if (!escapedJson || escapedJson.length < 2) {
    return chars;
  }

  const escaped = escapedJson.slice(1, -1);
  if (escaped.length <= 80) {
    return escaped;
  }
  return `${escaped.slice(0, 77)}...`;
}

function getResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (isRecord(result) && typeof result.content === "string") {
    return result.content;
  }

  if (result === null || result === undefined) {
    return "";
  }

  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }

  return JSON.stringify(result, null, 2);
}

function extractExitCode(text: string): number | undefined {
  const match = text.match(
    /(?:^|\n)\s*(?:Process exited with code|Exit code:)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function extractWallTime(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*Wall time:\s*([^\n]+)\s*(?:\n|$)/i);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].trim();
}

function parseResultEnvelope(text: string): {
  output: string;
  exitCode?: number;
  wallTime?: string;
} {
  const outputMatch = text.match(/(?:^|\n)\s*Output:\s*\n([\s\S]*)$/i);
  const output = outputMatch?.[1] ?? text;
  return {
    output: output.trimEnd(),
    exitCode: extractExitCode(text),
    wallTime: extractWallTime(text),
  };
}

function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split("\n").filter(Boolean).length;
}

function ReadViaPtyFile({
  filePath,
  output,
  inline = false,
}: {
  filePath: string;
  output: string;
  inline?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(filePath);
  const lines = output.split("\n");
  const lineCount = countContentLines(output);
  const buttonClass = inline
    ? "inline-flex items-center gap-2 bg-transparent border-none p-0 font-mono text-inherit text-[var(--link-color)] cursor-pointer underline underline-transparent hover:underline-current"
    : "inline-flex items-center gap-3 bg-transparent border border-[var(--border-color)] rounded-lg px-3 py-2 font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] cursor-pointer text-left transition-colors hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)]";
  const lineCountClass = inline
    ? "text-[var(--text-muted)] text-[0.85em] no-underline"
    : "text-[var(--text-muted)] ml-auto";
  const wrapperClass = inline ? undefined : "flex flex-col gap-2";

  return (
    <>
      <div className={wrapperClass}>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setShowModal(true)}
        >
          {fileName}
          <span className={lineCountClass}>{lineCount} lines</span>
        </button>
      </div>
      {showModal && (
        <Modal
          title={
            <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
              {fileName}
            </span>
          }
          onClose={() => setShowModal(false)}
        >
          <div className="bg-[var(--bg-code)] rounded overflow-auto">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] font-mono [font-size:var(--font-size-base)] bg-[var(--bg-code)] tab-[var(--tab-size)] border border-[var(--border-color)] rounded-md">
              <div className="text-right py-3 px-2 text-[var(--text-muted)] select-none border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="py-3 px-3 m-0 overflow-x-auto leading-relaxed">
                <code>{output}</code>
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export const writeStdinRenderer: ToolRenderer<
  WriteStdinInput,
  WriteStdinResult
> = {
  tool: "WriteStdin",
  displayName: "Shell",

  renderToolUse(input, _context) {
    const sessionId = getSessionId(input);
    const chars = getChars(input);
    const command = getLinkedCommand(input);
    const filePath = getLinkedFilePath(input);
    const originLabel = getOriginLabel(input);
    const action =
      chars === undefined || chars.length === 0
        ? "waiting for output"
        : `input: ${formatChars(chars)}`;

    const originLine = originLabel ? `origin: ${originLabel}\n` : "";
    const fileLine = filePath ? `file: ${filePath}\n` : "";
    const commandLine = command ? `command: ${command}\n` : "";

    return (
      <div className="flex flex-col gap-2">
        <pre className="bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)]">
          <code>{`${originLine}${fileLine}${commandLine}command session ${sessionId}\n${action}`}</code>
        </pre>
      </div>
    );
  },

  renderToolResult(result, isError, _context, input) {
    const text = getResultText(result);
    const parsed = parseResultEnvelope(text);
    const linkedToolName = getLinkedToolName(input);
    const linkedFilePath = getLinkedFilePath(input);

    if (!parsed.output.trim()) {
      if (parsed.exitCode !== undefined) {
        return (
          <div className="text-[var(--text-muted)] italic [font-size:var(--font-size-lg)]">{`Command exited with code ${parsed.exitCode}`}</div>
        );
      }
      return (
        <div className="text-[var(--text-muted)] italic [font-size:var(--font-size-lg)]">
          No output
        </div>
      );
    }

    if (linkedToolName === "Read" && linkedFilePath) {
      return (
        <ReadViaPtyFile filePath={linkedFilePath} output={parsed.output} />
      );
    }

    return (
      <div className={`flex flex-col gap-2 ${isError ? "" : ""}`}>
        <pre
          className={`bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)] ${isError ? "border-[var(--error-color)] bg-[var(--bg-error,rgba(207,34,46,0.1))]" : ""}`}
        >
          <code>{parsed.output}</code>
        </pre>
      </div>
    );
  },

  getUseSummary(input) {
    const sessionId = getSessionId(input);
    const chars = getChars(input);
    const inputSummary = getOriginLabel(input);

    if (chars === undefined || chars.length === 0) {
      if (inputSummary) {
        return inputSummary;
      }
      return "waiting for output";
    }
    if (inputSummary) {
      return `${inputSummary} (input)`;
    }
    return `sent input (${sessionId})`;
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }

    const text = getResultText(result);
    const parsed = parseResultEnvelope(text);
    if (parsed.exitCode !== undefined && parsed.wallTime) {
      return `exit ${parsed.exitCode} in ${parsed.wallTime}`;
    }

    if (parsed.exitCode !== undefined) {
      return `exit ${parsed.exitCode}`;
    }

    if (!parsed.output.trim()) {
      return "No output";
    }

    const lineCount = parsed.output.split("\n").filter(Boolean).length;
    return `${lineCount} lines`;
  },

  renderInteractiveSummary(input, result, isError, _context) {
    if (isError) {
      return null;
    }

    const linkedToolName = getLinkedToolName(input);
    const linkedFilePath = getLinkedFilePath(input);
    if (linkedToolName !== "Read" || !linkedFilePath) {
      return null;
    }

    const text = getResultText(result);
    const parsed = parseResultEnvelope(text);
    if (!parsed.output.trim()) {
      return null;
    }

    return (
      <ReadViaPtyFile filePath={linkedFilePath} output={parsed.output} inline />
    );
  },
};
