import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

/**
 * Fallback renderer for unknown block types - displays formatted JSON
 */
function FallbackRendererComponent({
  block,
}: {
  block: ContentBlock;
  context: RenderContext;
}) {
  return (
    <div className="fallback-block">
      <div className="fallback-type">{block.type}</div>
      <pre className="fallback-content">
        <code>{JSON.stringify(block, null, 2)}</code>
      </pre>
    </div>
  );
}

export const fallbackRenderer: ContentRenderer = {
  type: [], // Doesn't match any type - used as registry fallback
  render(block, context) {
    return <FallbackRendererComponent block={block} context={context} />;
  },
};
