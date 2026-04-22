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
    <div className="tool-block tool-use">
      <div className="tool-header">
        <span className="tool-icon">{">"}</span>
        <span className="tool-name">{block.name}</span>
      </div>
      <div className="tool-content">
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
