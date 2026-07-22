# Claude VSCode Extension Style Guide

> **Purpose**: Comprehensive visual design reference extracted from the official Claude Code VSCode extension. Use this guide when building UI components for claude-anywhere to match VSCode's visual styles.

**Source**: Extracted from `claude-vscode-extension/` (HTML, CSS, screenshots)

---

## Table of Contents
1. [Design Tokens](#design-tokens)
2. [Component Patterns](#component-patterns)
3. [HTML Structure](#html-structure)
4. [Tool-Specific Rendering](#tool-specific-rendering)
5. [Interaction States](#interaction-states)

---

## Design Tokens

### Brand Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--app-claude-orange` | `#d97757` | Loading spinner, working states |
| `--app-claude-clay-button-orange` | `#c6613f` | Light theme buttons/spinner |
| `--app-claude-ivory` | `#faf9f5` | Light backgrounds |
| `--app-claude-slate` | `#141413` | Deep charcoal, dark backgrounds |

### Timeline Dot Colors

The timeline dots use different colors based on state (via `.o:before` pseudo-element):

| State | Color | CSS Class |
|-------|-------|-----------|
| Tool call | `#74c991` (green) | `.o.rr:before` |
| Error | `#c74e39` (red) | `.o.ir:before` |
| Warning | `#e1c08d` (amber) | `.o.tr:before` |
| Default/text | `var(--app-secondary-foreground)` | `.o:before` |
| Loading | `#d97757` (orange, animated) | `.o.nr:before` |

### Semantic Colors

| Token | Value | Usage |
|-------|-------|-------|
| Success green | `#74c991` | Tool call dots, passed tests |
| Error red | `#c74e39` | Error dots, deletions, failures |
| Warning yellow | `#e1c08d` | Warning dots, modified files |
| Link blue | `#4daafc` | Links, interactive text |
| VSCode blue | `#007acc` | Focus states, progress bars |
| Muted text | `#888888` | Secondary/dimmed text |

### Spacing Scale

| Token | Value | CSS Variable |
|-------|-------|--------------|
| XS | `2px` | - |
| Small | `4px` | `--app-spacing-small` |
| Medium | `8px` | `--app-spacing-medium` |
| Large | `12px` | `--app-spacing-large` |
| XL | `16px` | `--app-spacing-xlarge` |

### Border Radius

| Token | Value | CSS Variable |
|-------|-------|--------------|
| Small | `4px` | `--corner-radius-small` |
| Medium | `6px` | `--corner-radius-medium` |
| Large | `8px` | `--corner-radius-large` |
| Circular | `50%` | - |

### Typography

#### Font Families
```css
/* UI Text */
font-family: var(--vscode-chat-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif);

/* Monospace/Code */
font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace);
/* Or via token: */
font-family: var(--app-monospace-font-family);
```

#### Font Sizes
| Use Case | Value |
|----------|-------|
| Base UI | `13px` (`var(--vscode-chat-font-size)`) |
| Code/Mono | `12px` (`var(--vscode-editor-font-size)`) |
| Small mono | `10px` (`calc(var(--vscode-editor-font-size) - 2px)`) |
| Large text | `14px` |
| Relative small | `.85em`, `.9em` |

#### Font Weights
| Weight | Value | Usage |
|--------|-------|-------|
| Normal | `400` | Body text |
| Medium | `500` | Emphasis |
| Semi-bold | `600` | Headings, labels |
| Bold | `700` | Strong emphasis, tool names |

### Shadows

```css
/* Subtle */
box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);

/* Medium */
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);

/* Large */
box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);

/* Inner border glow (dark theme) */
box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);

/* Inner border glow (light theme) */
box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.07);
```

---

## Component Patterns

### Class Name Mapping

Minified class names from the extension mapped to semantic equivalents:

| Minified | Semantic Name | Description |
|----------|---------------|-------------|
| `.Ve` | `.app-container` | Root app wrapper, flex column |
| `.V` | `.message-row` | Message container |
| `.V.o` | `.message-row--assistant` | Assistant message variant |
| `.V.D` | `.message-row--user` | User message variant |
| `.V.o.rr` | `.message-row--tool` | Tool call message |
| `.Kt` | `.collapsible` | Expandable details wrapper |
| `.M` | `.collapsible__summary` | Clickable header (summary) |
| `.Qt` | `.collapsible__content` | Hidden/expandable content |
| `.Jt` | `.collapsible__icon` | Expand/collapse chevron |
| `.Ut` | `.tool-container` | Outer tool call container |
| `.xr` | `.tool-inner` | Inner tool container |
| `.fr` | `.tool-summary` | Tool summary row styling |
| `.vr` | `.tool-name` | Tool name label (bold) |
| `.O` | `.tool-description` | Tool description text |
| `.kr` | `.code-block` | Code/output container |
| `.yr` | `.code-block__grid` | Grid layout for code |
| `.zr` | `.code-block__label` | Label column (IN/OUT) |
| `.b` | `.code-block__value` | Value/content column |
| `.bo` | `.code-block__row` | Grid row |
| `.e` | `.text-content` | Prose text block |
| `.n` | `.tool-input` | Tool input container |
| `.u` | `.button-group` | Action button container |
| `.d` | `.btn--primary` | Primary action button |
| `.P` | `.btn--secondary` | Secondary button |
| `.Oe` | `.header-bar` | Top navigation bar |
| `.De`, `.co` | `.layout-wrapper` | Layout containers |
| `.Ge` | `.layout-grid` | Content grid |
| `.Ke` | `.message-list` | Message list container |
| `.A` | `.scroll-container` | Scrollable area |

### Button Styles

```css
/* Primary button */
.btn--primary {
  padding: 6px 8px;
  font-size: var(--vscode-chat-font-size, 13px);
  font-weight: 500;
  background: var(--app-button-background);
  color: var(--app-button-foreground);
  border: none;
  border-radius: var(--corner-radius-small); /* 4px */
  cursor: pointer;
}

.btn--primary:hover {
  filter: brightness(1.1);
}

.btn--primary:active {
  opacity: 0.7;
}

.btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Secondary button */
.btn--secondary {
  padding: 6px 8px;
  background: transparent;
  color: var(--app-primary-foreground);
  border: 1px solid var(--app-input-border);
  border-radius: var(--corner-radius-small);
}
```

### List Items

```css
.list-item {
  padding: 4px 8px; /* var(--app-list-item-padding) */
  border-radius: 4px; /* var(--app-list-border-radius) */
  gap: 2px; /* var(--app-list-gap) */
}

.list-item:hover {
  background: var(--app-list-hover-background);
}

.list-item--active {
  background: var(--app-list-active-background);
  color: var(--app-list-active-foreground);
}
```

### Input Fields

```css
.input {
  padding: 4px 8px;
  font-size: var(--vscode-chat-font-size, 13px);
  color: var(--app-input-foreground);
  background: var(--app-input-background);
  border: 1px solid var(--app-input-border);
  border-radius: var(--corner-radius-small);
}

.input:focus {
  border-color: var(--app-input-active-border);
  outline: none;
}

.input::placeholder {
  color: var(--app-input-placeholder-foreground);
}
```

---

## HTML Structure

### Message Row (Assistant)

```html
<div class="message-row message-row--assistant">
  <span class="text-content">
    <p>Message text content here...</p>
  </span>
</div>
```

**CSS Class**: `.V.o` → `.message-row--assistant`

### Message Row (Tool Call)

```html
<div class="message-row message-row--tool">
  <div class="tool-container">
    <div class="tool-inner">
      <summary class="tool-summary">
        <span>
          <span class="tool-name">Read</span>
          <span class="tool-description">filename.tsx</span>
        </span>
      </summary>
      <div class="code-block">
        <!-- Tool output content -->
      </div>
    </div>
  </div>
</div>
```

**CSS Classes**: `.V.o.rr` → `.message-row--tool`

### Collapsible Section (Thinking)

```html
<details class="collapsible">
  <summary class="collapsible__summary">
    <span>Thinking</span>
    <span class="collapsible__icon">▸</span>
  </summary>
  <div class="collapsible__content">
    <span class="text-content">
      Thinking content here...
    </span>
  </div>
</details>
```

**CSS Classes**: `.Kt` + `.M` + `.Qt` + `.Jt`

### Code Block with Labels

```html
<div class="code-block">
  <div class="code-block__grid">
    <div class="code-block__row">
      <div class="code-block__label">IN</div>
      <div class="code-block__value">
        <pre>input content</pre>
      </div>
    </div>
    <div class="code-block__row">
      <div class="code-block__label">OUT</div>
      <div class="code-block__value">
        <pre>output content</pre>
      </div>
    </div>
  </div>
</div>
```

**CSS Classes**: `.kr` + `.yr` + `.bo` + `.zr` + `.b`

---

## Tool-Specific Rendering

### Read Tool
```
● Read  filename.tsx
```
- **Tool name**: Bold, 13px
- **Filename**: Monospace, link color (`#4daafc`)
- **Collapsed**: Single line with file path
- **Expanded**: Shows file contents with line numbers

### Grep Tool
```
● Grep  "searchPattern" (glob: **/*.ts)
        4 lines of output
```
- **Pattern**: Monospace, in quotes
- **Glob filter**: Muted text in parentheses
- **Result count**: Small muted text below

### Glob Tool
```
● Glob pattern: "**/*.tsx"
        Found 12 files
```
- **Pattern label**: Normal weight
- **Pattern value**: Monospace
- **Result**: Muted "Found X files" or "No files found"

### Bash Tool
```
● Bash  pnpm typecheck && pnpm lint
        Exit code: 0
```
- **Command**: Monospace
- **Expanded**: Shows stdout/stderr output
- **Exit code**: Muted, shown in summary

### Edit Tool
```
● Edit  filename.tsx (lines 40-54)
```
- **Filename**: Monospace, link color
- **Line range**: Muted parenthetical
- **Expanded**: Shows diff with syntax highlighting

### Task Tool
```
● Task: Find settings and test files
```
- **Label**: "Task:" with colon
- **Description**: Normal text after label
- **Expanded**: Shows agent input/output

---

## Interaction States

### Hover
```css
/* Background change */
background: var(--app-list-hover-background);

/* Brightness for buttons */
filter: brightness(1.1);

/* Transition */
transition: background-color 0.15s ease;
```

### Focus
```css
border-color: var(--app-input-active-border);
outline: 1px solid var(--vscode-focusBorder);
outline-offset: -1px;
```

### Active/Pressed
```css
opacity: 0.7;
```

### Disabled
```css
opacity: 0.5;
cursor: not-allowed;
```

### Loading/Spinner
```css
/* Spinner color matches Claude orange */
color: var(--app-spinner-foreground); /* #d97757 in dark theme */

/* Light theme uses clay button orange */
color: var(--app-claude-clay-button-orange); /* #c6613f */
```

---

## VSCode Theme Integration

The extension uses VSCode CSS variables for seamless theme integration:

### Key VSCode Variables Used

```css
/* Colors */
--vscode-foreground
--vscode-descriptionForeground
--vscode-focusBorder
--vscode-textLink-foreground

/* Backgrounds */
--vscode-sideBar-background
--vscode-editor-background
--vscode-input-background
--vscode-menu-background
--vscode-list-hoverBackground
--vscode-list-activeSelectionBackground

/* Borders */
--vscode-input-border
--vscode-widget-border
--vscode-sideBarActivityBarTop-border
--vscode-inlineChatInput-border

/* Interactive */
--vscode-button-background
--vscode-button-foreground
--vscode-progressBar-background
--vscode-inputOption-activeBorder
```

### Theme Detection

```html
<!-- Theme attributes on root element -->
<html data-vscode-theme-kind="vscode-dark"
      data-vscode-theme-name="Default Dark Modern">
```

---

## Reference Screenshots

Visual examples are available in `claude-vscode-extension/`:
- `Screenshot From 2025-12-29 18-14-59.png` - Message list with tool calls
- `Screenshot From 2025-12-29 18-15-27.png` - Edit tool with code diff
- `Screenshot From 2025-12-29 18-15-36.png` - Bash commands and output
- `Screenshot From 2025-12-29 18-16-14.png` - Write tool and markdown content
