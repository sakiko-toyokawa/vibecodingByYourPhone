import { toolRegistry } from "../tools";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ToolUseBlock extends ContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * Tool use renderer - dispatches to tool-specific renderer
 */
function ToolUseRendererComponent({
  block,
  context,
}: {
  block: ToolUseBlock;
  context: RenderContext;
}) {
  return (
    <div className="my-2 rounded-lg border border-[var(--border-color)] overflow-hidden bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
        <span className="font-mono text-[var(--text-dimmed)]">{">"}</span>
        <span className="font-medium uppercase tracking-wide">
          {block.name}
        </span>
      </div>
      <div className="p-3">
        {toolRegistry.renderToolUse(block.name, block.input, context)}
      </div>
    </div>
  );
}

export const toolUseRenderer: ContentRenderer<ToolUseBlock> = {
  type: "tool_use",
  render(block, context) {
    return (
      <ToolUseRendererComponent
        block={block as ToolUseBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const toolBlock = block as ToolUseBlock;
    const renderer = toolRegistry.get(toolBlock.name);
    return renderer.getUseSummary?.(toolBlock.input) || toolBlock.name;
  },
};
