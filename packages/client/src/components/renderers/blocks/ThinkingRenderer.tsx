import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ThinkingBlock extends ContentBlock {
  type: "thinking";
  thinking: string;
  signature?: string; // Never rendered
}

/**
 * Thinking renderer - collapsible block with shared expanded state across all blocks
 */
function ThinkingRendererComponent({
  block,
  context,
}: {
  block: ThinkingBlock;
  context: RenderContext;
}) {
  const thinking = block.thinking || "";
  const isExpanded = context.thinkingExpanded ?? false;

  if (isExpanded) {
    // Expanded: whole block is clickable to collapse
    return (
      <button
        type="button"
        className="block w-full text-left my-1 border-l-2 border-orange-400 bg-orange-50/50 rounded-r-md px-3 py-2.5 cursor-pointer transition-colors duration-150 hover:bg-orange-50/80"
        onClick={context.toggleThinkingExpanded}
        aria-expanded={true}
      >
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-xs font-medium text-orange-700 uppercase tracking-wider">
            THINKING PROCESS
          </span>
          <span className="text-[10px] text-orange-500">▲</span>
        </div>
        <div className="font-serif italic text-sm text-orange-800/80 whitespace-pre-wrap leading-relaxed pl-1">
          {thinking}
        </div>
      </button>
    );
  }

  // Collapsed: small inline button with pulsing when streaming
  const collapsedClass = context.isStreaming ? "my-1 animate-pulse" : "my-1";

  return (
    <div className={collapsedClass}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-transparent border border-orange-300/50 rounded text-xs text-orange-700 cursor-pointer transition-all duration-150 hover:bg-orange-50/50 hover:border-orange-400"
        onClick={context.toggleThinkingExpanded}
        aria-expanded={false}
      >
        <span className="font-medium uppercase tracking-wider">
          {context.isStreaming ? "THINKING..." : "THINKING PROCESS"}
        </span>
        <span className="text-[10px] text-orange-500">▼</span>
      </button>
    </div>
  );
}

export const thinkingRenderer: ContentRenderer<ThinkingBlock> = {
  type: "thinking",
  render(block, context) {
    return (
      <ThinkingRendererComponent
        block={block as ThinkingBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const thinking = (block as ThinkingBlock).thinking || "";
    const firstLine = thinking.split("\n")[0] || "";
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  },
};
