import type { ReactNode } from "react";
import type { ContentBlock, ContentRenderer, RenderContext } from "./types";

/**
 * Registry for content block renderers with fallback support
 */
export class RendererRegistry {
  private renderers = new Map<string, ContentRenderer>();
  private fallback: ContentRenderer;

  constructor(fallback: ContentRenderer) {
    this.fallback = fallback;
  }

  /**
   * Register a renderer for one or more block types
   */
  register(renderer: ContentRenderer): void {
    const types = Array.isArray(renderer.type)
      ? renderer.type
      : [renderer.type];
    for (const type of types) {
      this.renderers.set(type, renderer);
    }
  }

  /**
   * Get the renderer for a block type
   */
  getRenderer(block: ContentBlock): ContentRenderer {
    return this.renderers.get(block.type) || this.fallback;
  }

  /**
   * Render a content block
   */
  render(block: ContentBlock, context: RenderContext): ReactNode {
    return this.getRenderer(block).render(block, context);
  }
}
