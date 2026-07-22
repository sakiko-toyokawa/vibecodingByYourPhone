import { toolRegistry } from "../tools";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ToolResultBlock extends ContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

/**
 * Tool result renderer - correlates with tool_use and dispatches to tool-specific renderer
 */
function ToolResultRendererComponent({
  block,
  context,
}: {
  block: ToolResultBlock;
  context: RenderContext;
}) {
  // Look up the corresponding tool_use to get the tool name
  const toolUse = context.getToolUse?.(block.tool_use_id);
  const toolName = toolUse?.name || "Unknown";
  const isError = block.is_error === true;

  // Prefer structured toolUseResult if available, otherwise try to parse content
  let result: unknown = context.toolUseResult;
  if (!result && block.content) {
    try {
      result = JSON.parse(block.content);
    } catch {
      // Content is not JSON, use as-is
      result = { content: block.content };
    }
  }

  return (
    <div
      className={`my-2 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_1px_0_rgba(20,20,19,0.03)] ${isError ? "border-[var(--error-color)]/20" : ""}`}
    >
      <div
        className={`flex items-center gap-2 border-b px-4 py-2.5 text-xs ${isError ? "border-[var(--error-color)]/10 bg-[var(--error-color)]/[0.03] text-[var(--error-color)]" : "border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-[var(--text-muted)]"}`}
      >
        <span className="font-mono text-[10px] opacity-50">{"<"}</span>
        <span className="text-[11px] font-medium uppercase tracking-[0.16em]">
          {toolName}
        </span>
        {isError ? (
          <span className="ml-auto inline-flex items-center rounded-full border border-[var(--error-color)]/20 bg-[var(--error-color)]/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--error-color)]">
            Error
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center rounded-full border border-[var(--border-color)] bg-[var(--bg-surface)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Complete
          </span>
        )}
      </div>
      <div className="p-4">
        {toolRegistry.renderToolResult(
          toolName,
          result,
          isError,
          context,
          toolUse?.input,
        )}
      </div>
    </div>
  );
}

export const toolResultRenderer: ContentRenderer<ToolResultBlock> = {
  type: "tool_result",
  render(block, context) {
    return (
      <ToolResultRendererComponent
        block={block as ToolResultBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const resultBlock = block as ToolResultBlock;
    if (resultBlock.is_error) return "Error";
    return "Result";
  },
};
