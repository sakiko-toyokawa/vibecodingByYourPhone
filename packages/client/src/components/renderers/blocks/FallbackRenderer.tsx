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
    <div className="my-2 overflow-hidden rounded-md border border-dashed border-[var(--border-color)]">
      <div className="border-b border-dashed border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-sm text-[var(--text-muted)]">
        {block.type}
      </div>
      <pre className="m-0 overflow-x-auto bg-[var(--bg-code)] p-2 [font-size:var(--font-size-base)]">
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
