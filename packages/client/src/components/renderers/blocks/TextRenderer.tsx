import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface TextBlock extends ContentBlock {
  type: "text";
  text: string;
  /** Server-rendered HTML (if available) */
  _renderedHtml?: string;
}

/**
 * Text renderer - displays text content with markdown rendering
 */
function TextRendererComponent({ block }: { block: TextBlock }) {
  // Prefer server-rendered HTML if available
  if (block._renderedHtml) {
    return (
      <div
        className="my-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 text-[13px] leading-6 text-[var(--text-primary)] shadow-[0_1px_0_rgba(20,20,19,0.03)]"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown
        dangerouslySetInnerHTML={{ __html: block._renderedHtml }}
      />
    );
  }

  // Fallback to plain text when server-rendered HTML is not available
  return (
    <div className="my-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 shadow-[0_1px_0_rgba(20,20,19,0.03)]">
      <pre className="m-0 whitespace-pre-wrap font-inherit text-[13px] leading-6 text-[var(--text-primary)]">
        {block.text}
      </pre>
    </div>
  );
}

export const textRenderer: ContentRenderer<TextBlock> = {
  type: "text",
  render(block, _context) {
    return <TextRendererComponent block={block as TextBlock} />;
  },
  getSummary(block) {
    const text = (block as TextBlock).text;
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  },
};
