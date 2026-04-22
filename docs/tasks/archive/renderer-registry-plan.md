# Message Renderer Registry — Plan & Interface

## Goal

Build an extensible rendering system for claude-anywhere that:
1. Handles all message types and content blocks from Claude Code sessions
2. Is easy to extend when new tools/types appear
3. Keeps rendering logic encapsulated and testable
4. Supports streaming (partial content updates)

---

## Analysis Phase

Run the script against your full `.claude` folder:

```bash
node analyze-claude-messages.js ~/.claude/projects
```

This produces:
- `schema-report.json` — Full field-level schema for every message type, content block, and tool
- `schema-summary.md` — Human-readable summary

**What we need from the analysis:**

1. **Complete tool list** — Every tool name that appears
2. **Input shapes** — What fields each tool receives (for rendering "Claude wants to run X")
3. **Result shapes** — What fields each tool returns (for rendering results/errors)
4. **Optional vs required fields** — Which fields are always present vs sometimes missing
5. **Edge cases** — Any weird structures, array-indexed fields, nested data

---

## Registry Architecture

### Core Interface

```typescript
// types/renderers.ts

import { ReactNode } from 'react';

/**
 * Content block from Claude message
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * Context passed to every renderer
 */
export interface RenderContext {
  isStreaming: boolean;        // True if message is still being received
  isCollapsed: boolean;        // User preference for this block
  onToggleCollapse: () => void;
  theme: 'light' | 'dark';
}

/**
 * What a renderer must implement
 */
export interface ContentRenderer<T extends ContentBlock = ContentBlock> {
  /** Which content block type(s) this handles */
  type: string | string[];
  
  /** Render the block */
  render(block: T, context: RenderContext): ReactNode;
  
  /** Optional: custom logic for "can I handle this?" beyond type matching */
  canHandle?(block: ContentBlock): block is T;
  
  /** Optional: extract a summary for collapsed view */
  getSummary?(block: T): string;
}
```

### Registry

```typescript
// renderers/registry.ts

import { ContentBlock, ContentRenderer, RenderContext } from '../types/renderers';

class RendererRegistry {
  private renderers = new Map<string, ContentRenderer>();
  private fallback: ContentRenderer;

  constructor(fallback: ContentRenderer) {
    this.fallback = fallback;
  }

  register(renderer: ContentRenderer): void {
    const types = Array.isArray(renderer.type) ? renderer.type : [renderer.type];
    for (const type of types) {
      this.renderers.set(type, renderer);
    }
  }

  getRenderer(block: ContentBlock): ContentRenderer {
    const renderer = this.renderers.get(block.type);
    
    // Check canHandle for polymorphic renderers
    if (renderer?.canHandle && !renderer.canHandle(block)) {
      return this.fallback;
    }
    
    return renderer || this.fallback;
  }

  render(block: ContentBlock, context: RenderContext): ReactNode {
    return this.getRenderer(block).render(block, context);
  }
}

export const registry = new RendererRegistry(new FallbackRenderer());
```

### Tool-Specific Subregistry

For `tool_use` and `tool_result` blocks, we need a second level of dispatch:

```typescript
// renderers/tools/registry.ts

export interface ToolRenderer {
  /** Tool name (e.g., "Bash", "Edit", "Read") */
  tool: string;
  
  /** Render the tool_use block (what Claude wants to do) */
  renderToolUse(input: unknown, context: RenderContext): ReactNode;
  
  /** Render the tool_result block (what happened) */
  renderToolResult(result: unknown, context: RenderContext): ReactNode;
  
  /** Summary for collapsed view */
  getUseSummary?(input: unknown): string;
  getResultSummary?(result: unknown): string;
}

class ToolRendererRegistry {
  private tools = new Map<string, ToolRenderer>();
  private fallback: ToolRenderer;

  register(renderer: ToolRenderer): void {
    this.tools.set(renderer.tool, renderer);
  }

  get(toolName: string): ToolRenderer {
    return this.tools.get(toolName) || this.fallback;
  }
}
```

---

## Renderer Implementations (Sketches)

### Text Renderer

```typescript
export const textRenderer: ContentRenderer = {
  type: 'text',
  render(block, ctx) {
    return <Markdown content={block.text} />;
  },
  getSummary(block) {
    return block.text.slice(0, 100) + '...';
  },
};
```

### Thinking Renderer

```typescript
export const thinkingRenderer: ContentRenderer = {
  type: 'thinking',
  render(block, ctx) {
    if (ctx.isCollapsed) {
      return <CollapsedThinking summary={this.getSummary(block)} onExpand={ctx.onToggleCollapse} />;
    }
    return (
      <ThinkingBlock>
        <Markdown content={block.thinking} />
      </ThinkingBlock>
    );
  },
  getSummary(block) {
    const firstLine = block.thinking.split('\n')[0];
    return firstLine.slice(0, 80);
  },
};
```

### Tool Use Renderer (Dispatcher)

```typescript
export const toolUseRenderer: ContentRenderer = {
  type: 'tool_use',
  render(block, ctx) {
    const toolRenderer = toolRegistry.get(block.name);
    return (
      <ToolUseWrapper tool={block.name} id={block.id}>
        {toolRenderer.renderToolUse(block.input, ctx)}
      </ToolUseWrapper>
    );
  },
  getSummary(block) {
    const toolRenderer = toolRegistry.get(block.name);
    return toolRenderer.getUseSummary?.(block.input) || `${block.name}`;
  },
};
```

### Example Tool: Bash

```typescript
export const bashToolRenderer: ToolRenderer = {
  tool: 'Bash',
  
  renderToolUse(input, ctx) {
    return <CodeBlock language="bash">{input.command}</CodeBlock>;
  },
  
  renderToolResult(result, ctx) {
    const { stdout, stderr, interrupted } = result;
    return (
      <div>
        {stdout && <CodeBlock language="text">{stdout}</CodeBlock>}
        {stderr && <CodeBlock language="text" variant="error">{stderr}</CodeBlock>}
        {interrupted && <Badge variant="warning">Interrupted</Badge>}
      </div>
    );
  },
  
  getUseSummary(input) {
    const cmd = input.command;
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  },
  
  getResultSummary(result) {
    if (result.interrupted) return 'Interrupted';
    if (result.stderr) return 'Error';
    return `${result.stdout?.split('\n').length || 0} lines`;
  },
};
```

---

## Implementation Order

Based on usage frequency from analysis:

### Phase 1: Core (MVP)
1. `text` renderer
2. `thinking` renderer  
3. `tool_use` / `tool_result` dispatcher
4. `Bash` tool (most common)
5. `Read` tool
6. `Edit` tool
7. Fallback renderer (raw JSON)

### Phase 2: Complete Tool Coverage
8. `Write` tool
9. `TodoWrite` tool
10. `Glob` / `Grep` tools
11. `WebSearch` / `WebFetch` tools
12. `Task` / `TaskOutput` tools
13. `AskUserQuestion` tool

### Phase 3: Polish
14. Streaming states (partial content, loading indicators)
15. Collapse/expand persistence
16. Error state styling
17. Image rendering (for tools that return images)

---

## Agent Task

Here's what to tell the agent:

> Run `node analyze-claude-messages.js ~/.claude/projects` and share back:
> 
> 1. The `schema-summary.md` output
> 2. Any tools not in our expected list (Bash, Edit, Read, Write, TodoWrite, Glob, Grep, WebSearch, WebFetch, Task, TaskOutput, AskUserQuestion, ExitPlanMode)
> 3. Any fields that appear in result schemas but seem unusual or unexpected
> 4. The total count of messages analyzed
>
> Don't share the full JSON report — just the markdown summary and any surprises.

---

## Questions the Analysis Should Answer

1. Are there message types beyond `assistant`, `user`, `file-history-snapshot`, `queue-operation`?
2. Are there content block types beyond `text`, `thinking`, `tool_use`, `tool_result`?
3. What's the full list of tools? Are there any we haven't seen?
4. For each tool, what input fields are always present vs optional?
5. For each tool, what result fields are always present vs optional?
6. Are there any tools that return images (base64 data)?
7. Do any tool results have deeply nested structures we need to handle?
