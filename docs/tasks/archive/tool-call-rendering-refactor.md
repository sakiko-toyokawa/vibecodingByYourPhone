# Task: Tool Call Rendering Refactor

## Goal

Refactor message rendering to display tool calls as single, compact rows (VS Code style) instead of separate tool_use/tool_result blocks. Support streaming where tool_use appears before tool_result without layout jumps.

## Problem

Currently:
```
┌─────────────────────────┐
│ > Read                  │  ← tool_use block (separate)
│   types.ts              │
└─────────────────────────┘
┌─────────────────────────┐
│ < Read                  │  ← tool_result block (separate)
│   [45 lines of code]    │
└─────────────────────────┘
```

Desired:
```
● Read  types.ts (45 lines)  ▸   ← single row, expandable
```

## Architecture

### Core Concept: RenderItem Preprocessing

Instead of rendering `Message[]` directly, preprocess into `RenderItem[]` that pairs tool_use with tool_result:

```
Messages (from API)          RenderItems (for rendering)
─────────────────────        ─────────────────────────────
assistant:                   
  - thinking        ───────► ThinkingItem { block, status }
  - tool_use #1     ───────► ToolCallItem { toolUse, toolResult?, status }
user:                        
  - tool_result #1  ───────► (attached to ToolCallItem #1)
assistant:
  - text            ───────► TextItem { block }
```

### RenderItem Types

```typescript
// packages/client/src/types/renderItems.ts

export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem;

export interface TextItem {
  type: 'text';
  id: string;
  text: string;
}

export interface ThinkingItem {
  type: 'thinking';
  id: string;
  thinking: string;
  signature?: string;
  status: 'streaming' | 'complete';
}

export interface ToolCallItem {
  type: 'tool_call';
  id: string;                    // tool_use.id
  toolName: string;              // tool_use.name
  toolInput: unknown;            // tool_use.input
  toolResult?: ToolResultData;   // undefined while pending
  status: 'pending' | 'complete' | 'error';
}

export interface ToolResultData {
  content: string;
  isError: boolean;
  /** Structured result from JSONL toolUseResult field */
  structured?: unknown;
}

export interface UserPromptItem {
  type: 'user_prompt';
  id: string;
  content: string | ContentBlock[];
}
```

## Implementation Plan

### Phase 1: Preprocessing Layer

Create a pure function that transforms messages into render items.

**File: `packages/client/src/lib/preprocessMessages.ts`**

```typescript
import type { Message, ContentBlock } from '../types';
import type { RenderItem, ToolCallItem, ToolResultData } from '../types/renderItems';

/**
 * Preprocess messages into render items, pairing tool_use with tool_result.
 * 
 * This is a pure function - given the same messages, returns the same items.
 * Safe to call on every render (use useMemo).
 */
export function preprocessMessages(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  const pendingToolCalls = new Map<string, number>(); // tool_use_id → index in items

  for (const msg of messages) {
    processMessage(msg, items, pendingToolCalls);
  }

  return items;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>
): void {
  const content = msg.content;

  // String content = user prompt
  if (typeof content === 'string') {
    items.push({
      type: 'user_prompt',
      id: msg.id,
      content,
    });
    return;
  }

  // Check if this is a user message with only tool_result blocks
  const isToolResultMessage = msg.role === 'user' && 
    Array.isArray(content) &&
    content.every(b => b.type === 'tool_result');

  if (isToolResultMessage) {
    // Attach results to pending tool calls
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        attachToolResult(block, msg.toolUseResult, items, pendingToolCalls);
      }
    }
    return;
  }

  // Check if this is a real user prompt (not tool results)
  if (msg.role === 'user') {
    items.push({
      type: 'user_prompt',
      id: msg.id,
      content,
    });
    return;
  }

  // Assistant message - process each block
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      const blockId = `${msg.id}-${i}`;

      switch (block.type) {
        case 'text':
          if (block.text?.trim()) {
            items.push({
              type: 'text',
              id: blockId,
              text: block.text,
            });
          }
          break;

        case 'thinking':
          if (block.thinking?.trim()) {
            items.push({
              type: 'thinking',
              id: blockId,
              thinking: block.thinking,
              signature: block.signature,
              status: 'complete', // TODO: detect streaming
            });
          }
          break;

        case 'tool_use':
          if (block.id && block.name) {
            const toolCall: ToolCallItem = {
              type: 'tool_call',
              id: block.id,
              toolName: block.name,
              toolInput: block.input,
              toolResult: undefined,
              status: 'pending',
            };
            pendingToolCalls.set(block.id, items.length);
            items.push(toolCall);
          }
          break;
      }
    }
  }
}

function attachToolResult(
  block: ContentBlock,
  structuredResult: unknown,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const index = pendingToolCalls.get(toolUseId);
  if (index === undefined) {
    // Orphan result - shouldn't happen normally
    console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
    return;
  }

  const item = items[index];
  if (item.type !== 'tool_call') return;

  // Attach result to existing tool call
  item.toolResult = {
    content: block.content || '',
    isError: block.is_error || false,
    structured: structuredResult,
  };
  item.status = block.is_error ? 'error' : 'complete';
  
  pendingToolCalls.delete(toolUseId);
}
```

**Tests: `packages/client/src/lib/__tests__/preprocessMessages.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { preprocessMessages } from '../preprocessMessages';

describe('preprocessMessages', () => {
  it('pairs tool_use with tool_result', () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'test.ts' } }
        ]
      },
      {
        id: 'msg-2',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }
        ]
      }
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'tool_call',
      id: 'tool-1',
      toolName: 'Read',
      status: 'complete',
      toolResult: { content: 'file contents', isError: false }
    });
  });

  it('marks tool_use as pending when result not yet received', () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }
        ]
      }
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'tool_call',
      status: 'pending',
      toolResult: undefined
    });
  });

  it('handles multiple tool calls in sequence', () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'b.ts' } }
        ]
      },
      {
        id: 'msg-2',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'contents a' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'contents b' }
        ]
      }
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0].status).toBe('complete');
    expect(items[1].status).toBe('complete');
  });

  it('preserves thinking blocks', () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me analyze this...' },
          { type: 'text', text: 'Here is my response.' }
        ]
      }
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('thinking');
    expect(items[1].type).toBe('text');
  });
});
```

### Phase 2: Update MessageList

Replace message-based iteration with render-item-based iteration.

**File: `packages/client/src/components/MessageList.tsx`**

```typescript
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../types';
import type { RenderItem } from '../types/renderItems';
import { preprocessMessages } from '../lib/preprocessMessages';
import { RenderItemComponent } from './RenderItemComponent';

interface Props {
  messages: Message[];
  isStreaming?: boolean;
}

export const MessageList = memo(function MessageList({
  messages,
  isStreaming = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  // Preprocess messages into render items
  const renderItems = useMemo(
    () => preprocessMessages(messages),
    [messages]
  );

  // Track scroll position
  const handleScroll = useCallback(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;
    const threshold = 100;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }, []);

  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [renderItems]);

  return (
    <div className="message-list" ref={containerRef}>
      {renderItems.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
});
```

### Phase 3: RenderItem Components

Create the new component that renders each item type.

**File: `packages/client/src/components/RenderItemComponent.tsx`**

```typescript
import { memo } from 'react';
import type { RenderItem } from '../types/renderItems';
import { TextBlock } from './blocks/TextBlock';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolCallRow } from './blocks/ToolCallRow';
import { UserPromptBlock } from './blocks/UserPromptBlock';

interface Props {
  item: RenderItem;
  isStreaming: boolean;
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
}: Props) {
  switch (item.type) {
    case 'text':
      return <TextBlock text={item.text} />;

    case 'thinking':
      return (
        <ThinkingBlock
          thinking={item.thinking}
          status={item.status}
        />
      );

    case 'tool_call':
      return (
        <ToolCallRow
          id={item.id}
          toolName={item.toolName}
          toolInput={item.toolInput}
          toolResult={item.toolResult}
          status={item.status}
        />
      );

    case 'user_prompt':
      return <UserPromptBlock content={item.content} />;

    default:
      return null;
  }
});
```

### Phase 4: ToolCallRow Component (The Key Component)

This is the main visual component that achieves the VS Code look.

**File: `packages/client/src/components/blocks/ToolCallRow.tsx`**

```typescript
import { memo, useState, useMemo } from 'react';
import type { ToolResultData } from '../../types/renderItems';
import { getToolIcon, getToolSummary, ToolExpandedContent } from '../tools';

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: 'pending' | 'complete' | 'error';
}

export const ToolCallRow = memo(function ToolCallRow({
  id,
  toolName,
  toolInput,
  toolResult,
  status,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  // Generate summary based on status
  const summary = useMemo(() => {
    return getToolSummary(toolName, toolInput, toolResult, status);
  }, [toolName, toolInput, toolResult, status]);

  const icon = getToolIcon(toolName);
  
  const handleToggle = () => {
    // Only allow expansion if we have content to show
    if (status !== 'pending' || expanded) {
      setExpanded(!expanded);
    }
  };

  return (
    <div className={`tool-row ${expanded ? 'expanded' : 'collapsed'} status-${status}`}>
      {/* Fixed-height header row - NEVER changes height */}
      <div 
        className="tool-row-header"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleToggle()}
      >
        <span className={`timeline-dot ${status}`} />
        
        {status === 'pending' && (
          <span className="tool-spinner" aria-label="Running">
            <Spinner />
          </span>
        )}
        
        <span className="tool-icon" aria-hidden="true">{icon}</span>
        <span className="tool-name">{toolName}</span>
        <span className="tool-summary">{summary}</span>
        
        {status === 'error' && (
          <span className="tool-error-badge">error</span>
        )}
        
        <span className="expand-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* Expandable content */}
      {expanded && (
        <div className="tool-row-content">
          {status === 'pending' ? (
            <div className="tool-pending-message">Running...</div>
          ) : (
            <ToolExpandedContent
              toolName={toolName}
              toolInput={toolInput}
              toolResult={toolResult}
            />
          )}
        </div>
      )}
    </div>
  );
});

function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 16 16" width="12" height="12">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}
```

### Phase 5: Tool Summary Functions

Each tool provides its own summary generation.

**File: `packages/client/src/components/tools/summaries.ts`**

```typescript
import type { ToolResultData } from '../../types/renderItems';

type ToolSummaryFn = (
  input: unknown,
  result: ToolResultData | undefined,
  status: 'pending' | 'complete' | 'error'
) => string;

const toolSummaries: Record<string, ToolSummaryFn> = {
  Read: (input, result, status) => {
    const i = input as { file_path?: string; offset?: number; limit?: number };
    const filename = i.file_path?.split('/').pop() || i.file_path || '';
    
    if (status === 'pending') {
      return filename;
    }
    
    if (result) {
      const lineCount = (result.content?.split('\n').length || 0);
      if (i.offset !== undefined) {
        return `${filename} (lines ${i.offset}-${i.offset + lineCount})`;
      }
      return `${filename} (${lineCount} lines)`;
    }
    
    return filename;
  },

  Bash: (input, result, status) => {
    const i = input as { command?: string; description?: string };
    const cmd = truncate(i.command || '', 40);
    
    if (status === 'pending') {
      return cmd;
    }
    
    if (result) {
      // Try to extract exit code from result
      const exitMatch = result.content?.match(/exit code:?\s*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : '0';
      return `${cmd} → exit ${exitCode}`;
    }
    
    return cmd;
  },

  Grep: (input, result, status) => {
    const i = input as { pattern?: string };
    const pattern = `"${i.pattern || ''}"`;
    
    if (status === 'pending') {
      return pattern;
    }
    
    if (result) {
      const lines = result.content?.split('\n').filter(Boolean).length || 0;
      return `${pattern} → ${lines} matches`;
    }
    
    return pattern;
  },

  Glob: (input, result, status) => {
    const i = input as { pattern?: string };
    const pattern = i.pattern || '*';
    
    if (status === 'pending') {
      return pattern;
    }
    
    if (result) {
      const files = result.content?.split('\n').filter(Boolean).length || 0;
      return `${pattern} → ${files} files`;
    }
    
    return pattern;
  },

  Edit: (input, result, status) => {
    const i = input as { file_path?: string };
    const filename = i.file_path?.split('/').pop() || i.file_path || '';
    
    if (status === 'pending') {
      return filename;
    }
    
    // TODO: Parse diff to get +/- counts
    return `${filename} (modified)`;
  },

  Write: (input, result, status) => {
    const i = input as { file_path?: string; content?: string };
    const filename = i.file_path?.split('/').pop() || i.file_path || '';
    
    if (status === 'pending') {
      return filename;
    }
    
    const lines = i.content?.split('\n').length || 0;
    return `${filename} (${lines} lines)`;
  },

  Task: (input, result, status) => {
    const i = input as { description?: string };
    const desc = truncate(i.description || '', 30);
    
    if (status === 'pending') {
      return desc;
    }
    
    return `${desc} → done`;
  },
};

export function getToolSummary(
  toolName: string,
  input: unknown,
  result: ToolResultData | undefined,
  status: 'pending' | 'complete' | 'error'
): string {
  const fn = toolSummaries[toolName];
  if (fn) {
    return fn(input, result, status);
  }
  
  // Default summary
  if (status === 'pending') {
    return '...';
  }
  return status === 'error' ? 'failed' : 'done';
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
```

### Phase 6: CSS for VS Code Style

**File: `packages/client/src/styles/tool-rows.css`**

```css
/* ==========================================================================
   Tool Call Rows - VS Code Style
   ========================================================================== */

.tool-row {
  position: relative;
  margin: 2px 0;
}

/* Fixed-height header - CRITICAL for no-jump during streaming */
.tool-row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;              /* Fixed height */
  padding: 0 8px 0 24px;     /* Left padding for timeline */
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.1s;
}

.tool-row-header:hover {
  background: var(--bg-hover, #2a2a2a);
}

.tool-row-header:focus {
  outline: 1px solid var(--focus-border, #007acc);
  outline-offset: -1px;
}

/* Timeline dot */
.timeline-dot {
  position: absolute;
  left: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--timeline-dot-idle, #3c3c3c);
  flex-shrink: 0;
}

.timeline-dot.pending {
  background: var(--timeline-dot-working, #0078d4);
  animation: pulse 1.5s ease-in-out infinite;
}

.timeline-dot.error {
  background: var(--timeline-dot-error, #f48771);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.9); }
}

/* Spinner (replaces dot during pending) */
.tool-spinner {
  flex-shrink: 0;
  color: var(--text-muted, #888);
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Tool icon */
.tool-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  color: var(--text-dimmed, #666);
  font-size: 12px;
}

/* Tool name */
.tool-name {
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary, #ccc);
}

/* Tool summary - takes remaining space, truncates */
.tool-summary {
  flex: 1;
  min-width: 0;              /* Allow truncation */
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--link-color, #4fc1ff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Error badge */
.tool-error-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  color: var(--error-color, #f48771);
  background: rgba(244, 135, 113, 0.15);
  border-radius: 3px;
}

/* Expand chevron */
.expand-chevron {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 10px;
  color: var(--text-dimmed, #666);
  transition: transform 0.15s;
}

.tool-row.expanded .expand-chevron {
  transform: rotate(0deg);
}

/* Expanded content area */
.tool-row-content {
  margin-left: 24px;         /* Align with content after timeline */
  padding: 8px;
  border-left: 1px solid var(--border-color, #333);
  animation: slideDown 0.15s ease-out;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.tool-pending-message {
  color: var(--text-muted, #888);
  font-style: italic;
  font-size: 13px;
}

/* ==========================================================================
   Status-specific styles
   ========================================================================== */

.tool-row.status-pending .tool-summary {
  color: var(--text-muted, #888);
}

.tool-row.status-error .tool-name {
  color: var(--error-color, #f48771);
}

/* ==========================================================================
   Timeline line (applied to container)
   ========================================================================== */

.message-list {
  position: relative;
}

/* Continuous timeline line */
.message-list::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--timeline-line, #3c3c3c);
  pointer-events: none;
}
```

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/client/src/types/renderItems.ts` | RenderItem type definitions |
| `packages/client/src/lib/preprocessMessages.ts` | Preprocessing function |
| `packages/client/src/lib/__tests__/preprocessMessages.test.ts` | Unit tests |
| `packages/client/src/components/RenderItemComponent.tsx` | Item dispatcher |
| `packages/client/src/components/blocks/ToolCallRow.tsx` | Main tool row component |
| `packages/client/src/components/tools/summaries.ts` | Per-tool summary functions |
| `packages/client/src/styles/tool-rows.css` | VS Code style CSS |

### Modified Files

| File | Changes |
|------|---------|
| `packages/client/src/components/MessageList.tsx` | Use preprocessMessages, render RenderItems |
| `packages/client/src/styles/index.css` | Import tool-rows.css |

### Files to Eventually Remove/Deprecate

| File | Reason |
|------|--------|
| `packages/client/src/components/renderers/blocks/ToolUseRenderer.tsx` | Replaced by ToolCallRow |
| `packages/client/src/components/renderers/blocks/ToolResultRenderer.tsx` | Replaced by ToolCallRow |

## Migration Strategy

1. **Phase 1-2**: Add preprocessing and new types alongside existing code
2. **Phase 3-4**: Add new components, but don't wire up yet
3. **Phase 5**: Add summaries and CSS
4. **Phase 6**: Switch MessageList to use new system
5. **Phase 7**: Remove old ToolUse/ToolResult renderers
6. **Phase 8**: Polish and test streaming behavior

## Testing Checklist

- [ ] Tool call with result renders as single row
- [ ] Pending tool call shows spinner, no result summary
- [ ] Result arriving doesn't cause layout jump (height stays constant)
- [ ] Click expands to show content
- [ ] Click again collapses
- [ ] Error state shows error badge
- [ ] Multiple sequential tool calls render correctly
- [ ] Streaming: tool_use appears, then result attaches smoothly
- [ ] Keyboard navigation works (Enter to toggle)
- [ ] Screen reader announces status changes

## Open Questions

1. **Expansion persistence**: Remember which rows user expanded? Reset on new message?
2. **Auto-expand errors**: Should error results auto-expand to show the error?
3. **Group sequential same-tool calls**: Show "Read: 5 files" with expandable list?
4. **Mobile touch targets**: 28px height might be too small for touch - adjust?

## Visual Reference

See `docs/design/vscode-ui-spec.md` for detailed visual specifications.

## Dependencies

No new dependencies required. Uses existing React patterns.
