# Provider Dynamic Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a dynamic theme system where the entire App's visual style switches based on the currently selected project's AI provider (Claude, Codex, Gemini, OpenCode).

**Architecture:** CSS variable-driven theming via `data-provider` HTML attribute. Each provider defines a complete color palette, typography, spacing, and animation token set. A React Context manages provider inference from the current route's `projectId`. Provider-specific micro-components (send button, loading spinner) use conditional rendering.

**Tech Stack:** React + CSS variables + Google Fonts + existing Vite build system.

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `packages/client/src/styles/provider-themes.css` | All provider CSS variable definitions (5 providers × light/dark = 10 theme blocks) |
| `packages/client/src/styles/provider-animations.css` | Provider-specific animation keyframes and transition classes |
| `packages/client/src/hooks/useActiveProvider.ts` | Infer active provider from current route's projectId via API |
| `packages/client/src/contexts/ProviderThemeContext.tsx` | React Context that sets `data-provider` and `data-provider-anim` on `<html>` |
| `packages/client/src/components/provider-styled/ProviderSendButton.tsx` | Provider-styled send button with conditional rendering |
| `packages/client/src/components/provider-styled/ProviderLoadingSpinner.tsx` | Provider-styled loading spinner with conditional rendering |
| `packages/client/src/components/provider-styled/index.ts` | Barrel export for provider-styled components |

### Modified Files

| File | Change |
|------|--------|
| `packages/client/src/types.ts` | Add `provider` field to `Project` interface |
| `packages/client/src/styles/index.css` | Add base color transition + import new CSS files |
| `packages/client/src/App.tsx` | Wrap with `ProviderThemeProvider`, use `useActiveProvider` |
| `packages/client/index.html` | Add Google Fonts preconnect + font links |
| `packages/client/src/components/ProviderBadge.tsx` | Update color references to use CSS variables |

---

## Task 1: Add `provider` field to client Project type

**Files:**
- Modify: `packages/client/src/types.ts:155-163`

The server already returns `provider: ProviderName` on Project objects, but the client type is missing it.

- [ ] **Step 1: Add provider field to Project interface**

```typescript
// In packages/client/src/types.ts, add to the Project interface:
export interface Project {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  activeOwnedCount: number;
  activeExternalCount: number;
  lastActivity: string | null;
  provider?: ProviderName; // ADD THIS LINE
}
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm typecheck`
Expected: PASS (adding optional field is non-breaking)

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/types.ts
git commit -m "feat(theme): add provider field to Project type"
```

---

## Task 2: Create provider CSS variable themes

**Files:**
- Create: `packages/client/src/styles/provider-themes.css`

- [ ] **Step 1: Create the CSS file with all provider themes**

```css
/* packages/client/src/styles/provider-themes.css */
/* ============================================================
   Provider Dynamic Theme System
   Each provider defines a complete visual palette.
   Light/dark variants use [data-theme="light"] / default dark.
   ============================================================ */

/* ---------- CLAUDE (Anthropic) ---------- */

[data-provider="claude"] {
  /* Typography */
  --font-display: 'Source Serif 4', Georgia, serif;
  --font-body: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  /* Spacing & Shape */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;

  /* Animation Tokens */
  --anim-duration-fast: 150ms;
  --anim-duration-normal: 300ms;
  --anim-easing: cubic-bezier(0.4, 0, 0.2, 1);
}

/* Claude Dark (default) */
[data-provider="claude"] {
  --bg-surface: #1C1917;
  --bg-secondary: #292524;
  --bg-tertiary: #312E2B;
  --bg-hover: #3A3633;
  --bg-code: #23201E;
  --bg-input: #352F2C;
  --bg-overlay: rgba(28, 25, 23, 0.75);
  --bg-user-message: #3D3834;

  --text-primary: #FAF9F6;
  --text-secondary: #A8A29E;
  --text-danger: #EF4444;

  --accent-primary: #E57035;
  --accent-secondary: #FDBA74;
  --accent-hover: #F97316;

  --border-color: #44403C;
  --border-subtle: #3A3633;
  --border-input: #57534E;
  --focus-border: #E57035;

  --shadow-card: 0 2px 8px rgba(229, 112, 53, 0.08);
  --shadow-elevated: 0 4px 20px rgba(0, 0, 0, 0.3);

  --provider-gradient: linear-gradient(135deg, #292524 0%, #1C1917 100%);
  --provider-glow: 0 0 40px rgba(229, 112, 53, 0.12);
}

/* Claude Light */
[data-theme="light"] [data-provider="claude"],
[data-provider="claude"][data-theme="light"] {
  --bg-surface: #F5F0EB;
  --bg-secondary: #FFFFFF;
  --bg-tertiary: #EDE8E3;
  --bg-hover: #E8E2DC;
  --bg-code: #F0EBE5;
  --bg-input: #FFFFFF;
  --bg-overlay: rgba(45, 41, 38, 0.4);
  --bg-user-message: #E8E2DC;

  --text-primary: #2D2926;
  --text-secondary: #78716C;
  --text-danger: #DC2626;

  --accent-primary: #C2410C;
  --accent-secondary: #EA580C;
  --accent-hover: #9A3412;

  --border-color: #D6D0CA;
  --border-subtle: #E8E2DC;
  --border-input: #C4BEB8;
  --focus-border: #C2410C;

  --shadow-card: 0 2px 8px rgba(194, 65, 12, 0.06);
  --shadow-elevated: 0 4px 20px rgba(0, 0, 0, 0.08);

  --provider-gradient: linear-gradient(135deg, #FFFFFF 0%, #F5F0EB 100%);
  --provider-glow: 0 0 30px rgba(194, 65, 12, 0.08);
}

/* ---------- CODEX (OpenAI) ---------- */

[data-provider="codex"] {
  --font-display: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --anim-duration-fast: 100ms;
  --anim-duration-normal: 200ms;
  --anim-easing: cubic-bezier(0.34, 1.56, 0.64, 1);
}

[data-provider="codex"] {
  --bg-surface: #1A1A1A;
  --bg-secondary: #2D2D2D;
  --bg-tertiary: #353535;
  --bg-hover: #404040;
  --bg-code: #252525;
  --bg-input: #3D3D3D;
  --bg-overlay: rgba(26, 26, 26, 0.75);
  --bg-user-message: #404040;

  --text-primary: #ECECF1;
  --text-secondary: #8E8EA0;
  --text-danger: #EF4444;

  --accent-primary: #19C37D;
  --accent-secondary: #10A37F;
  --accent-hover: #0D8C6D;

  --border-color: #4A4A4A;
  --border-subtle: #3D3D3D;
  --border-input: #5A5A5A;
  --focus-border: #19C37D;

  --shadow-card: 0 2px 8px rgba(25, 195, 125, 0.08);
  --shadow-elevated: 0 4px 20px rgba(0, 0, 0, 0.4);

  --provider-gradient: linear-gradient(135deg, #2D2D2D 0%, #1A1A1A 100%);
  --provider-glow: 0 0 40px rgba(25, 195, 125, 0.12);
}

[data-theme="light"] [data-provider="codex"],
[data-provider="codex"][data-theme="light"] {
  --bg-surface: #FFFFFF;
  --bg-secondary: #F7F7F8;
  --bg-tertiary: #EFEFF1;
  --bg-hover: #E7E7EA;
  --bg-code: #F7F7F8;
  --bg-input: #FFFFFF;
  --bg-overlay: rgba(0, 0, 0, 0.3);
  --bg-user-message: #E7E7EA;

  --text-primary: #1A1A1A;
  --text-secondary: #6E6E80;
  --text-danger: #DC2626;

  --accent-primary: #19C37D;
  --accent-secondary: #10A37F;
  --accent-hover: #0D8C6D;

  --border-color: #D9D9E3;
  --border-subtle: #E7E7EA;
  --border-input: #C5C5D3;
  --focus-border: #19C37D;

  --shadow-card: 0 2px 8px rgba(25, 195, 125, 0.06);
  --shadow-elevated: 0 4px 20px rgba(0, 0, 0, 0.08);

  --provider-gradient: linear-gradient(135deg, #F7F7F8 0%, #FFFFFF 100%);
  --provider-glow: 0 0 30px rgba(25, 195, 125, 0.08);
}

/* ---------- GEMINI (Google) ---------- */

[data-provider="gemini"] {
  --font-display: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-body: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Roboto Mono', monospace;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;

  --anim-duration-fast: 150ms;
  --anim-duration-normal: 400ms;
  --anim-easing: cubic-bezier(0.2, 0, 0, 1);
}

[data-provider="gemini"] {
  --bg-surface: #1F1F1F;
  --bg-secondary: #303030;
  --bg-tertiary: #3A3A3A;
  --bg-hover: #454545;
  --bg-code: #282828;
  --bg-input: #3D3D3D;
  --bg-overlay: rgba(31, 31, 31, 0.75);
  --bg-user-message: #454545;

  --text-primary: #FFFFFF;
  --text-secondary: #9AA0A6;
  --text-danger: #F28B82;

  --accent-primary: #8AB4F8;
  --accent-secondary: #F28B82;
  --accent-hover: #AECBFA;

  --border-color: #5F6368;
  --border-subtle: #454545;
  --border-input: #5F6368;
  --focus-border: #8AB4F8;

  --shadow-card: 0 2px 12px rgba(138, 180, 248, 0.1);
  --shadow-elevated: 0 4px 24px rgba(0, 0, 0, 0.4);

  --provider-gradient: linear-gradient(135deg, #303030 0%, #1F1F1F 100%);
  --provider-glow: 0 0 40px rgba(138, 180, 248, 0.15);
}

[data-theme="light"] [data-provider="gemini"],
[data-provider="gemini"][data-theme="light"] {
  --bg-surface: #FFFFFF;
  --bg-secondary: #F8F9FA;
  --bg-tertiary: #F1F3F4;
  --bg-hover: #E8EAED;
  --bg-code: #F8F9FA;
  --bg-input: #FFFFFF;
  --bg-overlay: rgba(0, 0, 0, 0.3);
  --bg-user-message: #E8EAED;

  --text-primary: #1F1F1F;
  --text-secondary: #5F6368;
  --text-danger: #EA4335;

  --accent-primary: #4285F4;
  --accent-secondary: #EA4335;
  --accent-hover: #1A73E8;

  --border-color: #DADCE0;
  --border-subtle: #E8EAED;
  --border-input: #DADCE0;
  --focus-border: #4285F4;

  --shadow-card: 0 2px 12px rgba(66, 133, 244, 0.08);
  --shadow-elevated: 0 4px 24px rgba(0, 0, 0, 0.1);

  --provider-gradient: linear-gradient(135deg, #F8F9FA 0%, #FFFFFF 100%);
  --provider-glow: 0 0 30px rgba(66, 133, 244, 0.1);
}

/* ---------- OPENCODE (Minimal Tool) ---------- */

[data-provider="opencode"] {
  --font-display: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;

  --anim-duration-fast: 50ms;
  --anim-duration-normal: 100ms;
  --anim-easing: linear;
}

[data-provider="opencode"] {
  --bg-surface: #0A0A0A;
  --bg-secondary: #141414;
  --bg-tertiary: #1A1A1A;
  --bg-hover: #1F1F1F;
  --bg-code: #0D0D0D;
  --bg-input: #1A1A1A;
  --bg-overlay: rgba(0, 0, 0, 0.8);
  --bg-user-message: #1A1A1A;

  --text-primary: #E5E5E5;
  --text-secondary: #A3A3A3;
  --text-danger: #EF4444;

  --accent-primary: #60A5FA;
  --accent-secondary: #3B82F6;
  --accent-hover: #93C5FD;

  --border-color: #262626;
  --border-subtle: #1A1A1A;
  --border-input: #333333;
  --focus-border: #60A5FA;

  --shadow-card: none;
  --shadow-elevated: none;

  --provider-gradient: none;
  --provider-glow: none;
}

[data-theme="light"] [data-provider="opencode"],
[data-provider="opencode"][data-theme="light"] {
  --bg-surface: #FFFFFF;
  --bg-secondary: #FAFAFA;
  --bg-tertiary: #F5F5F5;
  --bg-hover: #EEEEEE;
  --bg-code: #FAFAFA;
  --bg-input: #FFFFFF;
  --bg-overlay: rgba(0, 0, 0, 0.3);
  --bg-user-message: #F5F5F5;

  --text-primary: #0A0A0A;
  --text-secondary: #737373;
  --text-danger: #DC2626;

  --accent-primary: #3B82F6;
  --accent-secondary: #2563EB;
  --accent-hover: #1D4ED8;

  --border-color: #E5E5E5;
  --border-subtle: #F0F0F0;
  --border-input: #D4D4D4;
  --focus-border: #3B82F6;

  --shadow-card: none;
  --shadow-elevated: none;

  --provider-gradient: none;
  --provider-glow: none;
}

/* ---------- PROVIDER-AGNOSTIC FALLBACKS ---------- */
/* These apply when NO data-provider is set (default Yep Anywhere brand) */

/* Smooth transition for all theme-affected properties */
html {
  transition: background-color 400ms ease-out,
              color 400ms ease-out,
              border-color 400ms ease-out,
              box-shadow 400ms ease-out;
}

/* Disable transitions on first load to prevent flash */
html[data-first-load="true"] {
  transition: none !important;
}

/* Provider color references for badges/icons */
:root {
  --provider-claude: #E57035;
  --provider-codex: #19C37D;
  --provider-gemini: #4285F4;
  --provider-opencode: #3B82F6;
}
```

- [ ] **Step 2: Verify CSS syntax**

Run: `pnpm lint`
Expected: PASS (Biome doesn't lint CSS, but check for obvious issues)

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/styles/provider-themes.css
git commit -m "feat(theme): add provider CSS variable themes"
```

---

## Task 3: Create provider animation styles

**Files:**
- Create: `packages/client/src/styles/provider-animations.css`

- [ ] **Step 1: Create the animation CSS file**

```css
/* packages/client/src/styles/provider-animations.css */
/* ============================================================
   Provider-specific animations
   Applied via .provider-anim-{name} class on <html>
   ============================================================ */

/* ---------- CLAUDE — Soft Breathing ---------- */
.provider-anim-claude .message-enter {
  animation: claudeFadeIn 400ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes claudeFadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.provider-anim-claude .thinking-dot {
  animation: claudeBreath 2s ease-in-out infinite;
}

@keyframes claudeBreath {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* Claude send button glow */
.provider-anim-claude .send-button:hover {
  box-shadow: 0 0 20px rgba(229, 112, 53, 0.3);
}

/* ---------- CODEX — Snappy Pop ---------- */
.provider-anim-codex .message-enter {
  animation: codexPopIn 250ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

@keyframes codexPopIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.provider-anim-codex .thinking-dot {
  animation: codexPulse 1.2s ease-in-out infinite;
}

@keyframes codexPulse {
  0%, 100% { transform: scale(1); opacity: 0.5; }
  50% { transform: scale(1.3); opacity: 1; }
}

/* Codex send button lift */
.provider-anim-codex .send-button {
  transition: transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 150ms ease;
}
.provider-anim-codex .send-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(25, 195, 125, 0.25);
}

/* ---------- GEMINI — Shimmer Flow ---------- */
.provider-anim-gemini .message-enter {
  animation: geminiShimmer 500ms cubic-bezier(0.2, 0, 0, 1) forwards;
}

@keyframes geminiShimmer {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.provider-anim-gemini .thinking-dot {
  animation: geminiOrbit 1.5s linear infinite;
}

@keyframes geminiOrbit {
  0% { transform: rotate(0deg) translateX(4px) rotate(0deg); }
  100% { transform: rotate(360deg) translateX(4px) rotate(-360deg); }
}

/* Gemini gradient border for send button */
.provider-anim-gemini .send-button {
  background: linear-gradient(135deg, #4285F4, #EA4335);
  position: relative;
  overflow: hidden;
}
.provider-anim-gemini .send-button::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #FBBC04, #34A853, #4285F4);
  opacity: 0;
  transition: opacity 300ms ease;
}
.provider-anim-gemini .send-button:hover::before {
  opacity: 1;
}

/* ---------- OPENCODE — No Animation ---------- */
.provider-anim-opencode .message-enter {
  animation: none;
}

.provider-anim-opencode .thinking-dot {
  animation: none;
}

.provider-anim-opencode .send-button {
  transition: none;
}
.provider-anim-opencode .send-button:hover {
  background-color: var(--accent-primary);
  color: var(--bg-surface);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/styles/provider-animations.css
git commit -m "feat(theme): add provider animation keyframes"
```

---

## Task 4: Create useActiveProvider hook

**Files:**
- Create: `packages/client/src/hooks/useActiveProvider.ts`

- [ ] **Step 1: Create the hook**

```typescript
// packages/client/src/hooks/useActiveProvider.ts
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { ProviderName } from "../types";
import { useProject } from "./useProjects";

/**
 * Infer the active AI provider from the current route.
 *
 * Rules:
 * - /projects/:projectId/* → use that project's provider
 * - All other routes → null (default Yep Anywhere brand)
 *
 * This hook fetches the project data to get its provider field.
 * The result is cached per projectId to avoid redundant fetches.
 */
export function useActiveProvider(): ProviderName | null {
  const { projectId } = useParams<{ projectId?: string }>();
  const { project } = useProject(projectId);

  return useMemo(() => {
    if (project?.provider) {
      return project.provider;
    }
    return null;
  }, [project?.provider]);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/useActiveProvider.ts
git commit -m "feat(theme): add useActiveProvider hook"
```

---

## Task 5: Create ProviderThemeContext

**Files:**
- Create: `packages/client/src/contexts/ProviderThemeContext.tsx`

- [ ] **Step 1: Create the context**

```tsx
// packages/client/src/contexts/ProviderThemeContext.tsx
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { ProviderName } from "../types";

interface ProviderThemeContextValue {
  activeProvider: ProviderName | null;
}

const ProviderThemeContext = createContext<ProviderThemeContextValue>({
  activeProvider: null,
});

interface ProviderThemeProviderProps {
  activeProvider: ProviderName | null;
  children: ReactNode;
}

/**
 * ProviderThemeProvider — manages the visual theme based on active AI provider.
 *
 * Sets `data-provider` on <html> for CSS variable theming.
 * Sets `provider-anim-{name}` class for provider-specific animations.
 * Removes `data-first-load` after initial mount to enable transitions.
 */
export function ProviderThemeProvider({
  activeProvider,
  children,
}: ProviderThemeProviderProps) {
  const isFirstMount = useRef(true);

  useEffect(() => {
    const html = document.documentElement;

    // Set or remove data-provider attribute
    if (activeProvider) {
      html.setAttribute("data-provider", activeProvider);
    } else {
      html.removeAttribute("data-provider");
    }

    // Update animation class
    const animClasses = [
      "provider-anim-claude",
      "provider-anim-codex",
      "provider-anim-gemini",
      "provider-anim-opencode",
    ];
    for (const cls of animClasses) {
      html.classList.remove(cls);
    }
    if (activeProvider) {
      html.classList.add(`provider-anim-${activeProvider}`);
    }

    // Remove first-load flag after initial mount (enables transitions)
    if (isFirstMount.current) {
      isFirstMount.current = false;
      // Use requestAnimationFrame to ensure styles are applied before removing flag
      requestAnimationFrame(() => {
        html.removeAttribute("data-first-load");
      });
    }
  }, [activeProvider]);

  // Set first-load flag on initial render (prevents transition flash)
  useEffect(() => {
    document.documentElement.setAttribute("data-first-load", "true");
  }, []);

  return (
    <ProviderThemeContext.Provider value={{ activeProvider }}>
      {children}
    </ProviderThemeContext.Provider>
  );
}

/**
 * Hook to access the current active provider theme.
 */
export function useProviderTheme(): ProviderThemeContextValue {
  return useContext(ProviderThemeContext);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/contexts/ProviderThemeContext.tsx
git commit -m "feat(theme): add ProviderThemeContext"
```

---

## Task 6: Wire up App.tsx

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Import and integrate ProviderThemeProvider**

```tsx
// packages/client/src/App.tsx
// ADD THESE IMPORTS at the top:
import { ProviderThemeProvider } from "./contexts/ProviderThemeContext";
import { useActiveProvider } from "./hooks/useActiveProvider";

// MODIFY the AppContent function:
function AppContent({ children }: Props) {
  const activeProvider = useActiveProvider(); // ADD THIS LINE

  // ... existing hooks ...

  return (
    <ProviderThemeProvider activeProvider={activeProvider}> {/* WRAP children */}
      <>
        <ConnectionBar />
        {/* ... existing banners ... */}
        {children}
        <FloatingActionButton />
      </>
    </ProviderThemeProvider>
  );
}
```

The full modified `AppContent` should look like:

```tsx
function AppContent({ children }: Props) {
  const activeProvider = useActiveProvider();

  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Desktop native notifications when AI output completes
  useDesktopNativeNotifications();

  // Mobile native notifications when AI completes or needs approval
  useMobileNativeNotifications();

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge();

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    dismiss,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();

  return (
    <ProviderThemeProvider activeProvider={activeProvider}>
      <>
        <ConnectionBar />
        {isManualReloadMode && pendingReloads.backend && (
          <ReloadBanner
            target="backend"
            onReload={reloadBackend}
            onDismiss={() => dismiss("backend")}
            unsafeToRestart={unsafeToRestart}
            activeWorkers={workerActivity.activeWorkers}
          />
        )}
        {isManualReloadMode && pendingReloads.frontend && (
          <ReloadBanner
            target="frontend"
            onReload={reloadFrontend}
            onDismiss={() => dismiss("frontend")}
          />
        )}
        {children}
        <FloatingActionButton />
      </>
    </ProviderThemeProvider>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(theme): wire ProviderThemeContext into App"
```

---

## Task 7: Import new CSS files in index.css

**Files:**
- Modify: `packages/client/src/styles/index.css`

- [ ] **Step 1: Add imports at the top of index.css**

```css
/* packages/client/src/styles/index.css */
/* Add these two lines at the very top of the file, before any other rules: */
@import './provider-themes.css';
@import './provider-animations.css';
```

- [ ] **Step 2: Verify build**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/styles/index.css
git commit -m "feat(theme): import provider CSS files"
```

---

## Task 8: Add Google Fonts to index.html

**Files:**
- Modify: `packages/client/index.html`

- [ ] **Step 1: Add font preconnect and stylesheet links**

```html
<!-- In packages/client/index.html, inside <head>,
     add these BEFORE the existing <link rel="stylesheet"> -->

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&family=Source+Sans+3:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Verify the HTML is valid**

Open `packages/client/index.html` and confirm the links are properly placed inside `<head>`.

- [ ] **Step 3: Commit**

```bash
git add packages/client/index.html
git commit -m "feat(theme): add Google Fonts for provider themes"
```

---

## Task 9: Update ProviderBadge to use CSS variables

**Files:**
- Modify: `packages/client/src/components/ProviderBadge.tsx`

- [ ] **Step 1: Update PROVIDER_COLORS to use CSS variables**

```tsx
// packages/client/src/components/ProviderBadge.tsx
// Replace the existing PROVIDER_COLORS object:

const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--provider-claude)",
  "claude-ollama": "var(--provider-claude)",
  codex: "var(--provider-codex)",
  "codex-oss": "var(--provider-codex)",
  gemini: "var(--provider-gemini)",
  "gemini-acp": "var(--provider-gemini)",
  opencode: "var(--provider-opencode)",
};
```

This is already in the file — verify it matches. No code change needed if it already uses CSS variables.

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit (if changes were made)**

If the file already uses CSS variables, skip this commit.

---

## Task 10: Create provider-styled components

**Files:**
- Create: `packages/client/src/components/provider-styled/ProviderSendButton.tsx`
- Create: `packages/client/src/components/provider-styled/ProviderLoadingSpinner.tsx`
- Create: `packages/client/src/components/provider-styled/index.ts`

- [ ] **Step 1: Create ProviderSendButton**

```tsx
// packages/client/src/components/provider-styled/ProviderSendButton.tsx
import { useProviderTheme } from "../../contexts/ProviderThemeContext";

interface ProviderSendButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

/**
 * Send button that adapts its style based on the active AI provider.
 */
export function ProviderSendButton({
  onClick,
  disabled,
  children,
}: ProviderSendButtonProps) {
  const { activeProvider } = useProviderTheme();

  // Base styles shared across all providers
  const baseStyles: React.CSSProperties = {
    padding: "10px 20px",
    borderRadius: activeProvider === "opencode" ? "4px" : "8px",
    border: activeProvider === "opencode" ? "1px solid var(--accent-primary)" : "none",
    background: activeProvider === "gemini"
      ? "linear-gradient(135deg, #4285F4, #EA4335)"
      : activeProvider === "opencode"
        ? "transparent"
        : "var(--accent-primary)",
    color: activeProvider === "opencode" ? "var(--accent-primary)" : "#FFFFFF",
    fontFamily: "var(--font-body)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: activeProvider === "opencode" ? "none" : "all 200ms ease",
  };

  return (
    <button
      type="button"
      className="send-button"
      style={baseStyles}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? "Send"}
    </button>
  );
}
```

- [ ] **Step 2: Create ProviderLoadingSpinner**

```tsx
// packages/client/src/components/provider-styled/ProviderLoadingSpinner.tsx
import { useProviderTheme } from "../../contexts/ProviderThemeContext";

interface ProviderLoadingSpinnerProps {
  size?: number;
}

/**
 * Loading spinner that adapts its animation based on the active AI provider.
 */
export function ProviderLoadingSpinner({
  size = 24,
}: ProviderLoadingSpinnerProps) {
  const { activeProvider } = useProviderTheme();

  const dotColor = "var(--accent-primary)";

  if (activeProvider === "gemini") {
    // Multi-color rotating dots for Gemini
    return (
      <div
        style={{
          display: "flex",
          gap: "4px",
          alignItems: "center",
          justifyContent: "center",
          height: size,
        }}
      >
        {["#4285F4", "#EA4335", "#FBBC04", "#34A853"].map((color, i) => (
          <span
            key={i}
            className="thinking-dot"
            style={{
              width: size * 0.25,
              height: size * 0.25,
              borderRadius: "50%",
              backgroundColor: color,
              display: "inline-block",
            }}
          />
        ))}
      </div>
    );
  }

  if (activeProvider === "opencode") {
    // Minimal blue bar for OpenCode
    return (
      <div
        style={{
          width: size * 1.5,
          height: 3,
          backgroundColor: "var(--border-subtle)",
          borderRadius: "2px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "40%",
            height: "100%",
            backgroundColor: dotColor,
            animation: "opencodeProgress 1s linear infinite",
          }}
        />
      </div>
    );
  }

  // Default: 3 pulsing dots (Claude/Codex)
  return (
    <div
      style={{
        display: "flex",
        gap: "4px",
        alignItems: "center",
        justifyContent: "center",
        height: size,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="thinking-dot"
          style={{
            width: size * 0.25,
            height: size * 0.25,
            borderRadius: "50%",
            backgroundColor: dotColor,
            display: "inline-block",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create barrel export**

```tsx
// packages/client/src/components/provider-styled/index.ts
export { ProviderSendButton } from "./ProviderSendButton";
export { ProviderLoadingSpinner } from "./ProviderLoadingSpinner";
```

- [ ] **Step 4: Add keyframe for OpenCode progress bar**

Add to `packages/client/src/styles/provider-animations.css`:

```css
@keyframes opencodeProgress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/provider-styled/
git commit -m "feat(theme): add provider-styled send button and loading spinner"
```

---

## Task 11: Apply font-family CSS rules

**Files:**
- Modify: `packages/client/src/styles/index.css`

- [ ] **Step 1: Add font-family rules that use CSS variables**

Add these rules to `packages/client/src/styles/index.css` (after the `@import` lines):

```css
/* Apply provider-specific fonts */
body {
  font-family: var(--font-body), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display), var(--font-body), -apple-system, BlinkMacSystemFont, sans-serif;
}

code, pre, .mono {
  font-family: var(--font-mono), 'Courier New', monospace;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/styles/index.css
git commit -m "feat(theme): apply provider-specific font families"
```

---

## Task 12: Integration verification

**Files:**
- No file changes — manual testing

- [ ] **Step 1: Start dev server**

```bash
pnpm dev
```

- [ ] **Step 2: Verify default brand (no provider)**

Navigate to `/projects`. The page should show the default dark theme (no provider-specific colors).

- [ ] **Step 3: Verify Claude theme**

Click on a Claude project. The page should transition to warm Anthropic tones (orange accents, serif fonts in headings).

- [ ] **Step 4: Verify Codex theme**

Navigate to a Codex project. The page should transition to OpenAI green accents.

- [ ] **Step 5: Verify Gemini theme**

Navigate to a Gemini project. The page should show Google blue/red gradient accents.

- [ ] **Step 6: Verify OpenCode theme**

Navigate to an OpenCode project. The page should show minimal blue accents with sharp corners.

- [ ] **Step 7: Verify light/dark toggle works**

In Settings, switch between light/dark. Each provider's light/dark variant should display correctly.

- [ ] **Step 8: Run full test suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
```
Expected: ALL PASS

- [ ] **Step 9: Final commit**

```bash
git commit -m "feat(theme): complete provider dynamic theme system"
```

---

## Plan Self-Review

### Spec Coverage Check

| Spec Requirement | Implementing Task |
|-----------------|-------------------|
| CSS variable system per provider | Task 2 |
| Provider-specific animations | Task 3 |
| Active provider inference from route | Task 4 |
| ProviderThemeContext | Task 5 |
| Wire into App.tsx | Task 6 |
| Google Fonts loading | Task 8 |
| ProviderBadge CSS variables | Task 9 |
| Provider-styled components (send button, spinner) | Task 10 |
| Font family application | Task 11 |
| Light/dark per provider | Task 2 (CSS selectors) |
| Transition animation (400ms) | Task 2 (html transition) |
| Default brand when no provider | Task 4 (returns null) |
| Integration verification | Task 12 |

**No gaps found.**

### Placeholder Scan

- No "TBD", "TODO", "implement later" found.
- No vague requirements like "add appropriate error handling".
- All steps include actual code.

### Type Consistency

- `ProviderName` type used consistently across all files.
- `Project.provider?: ProviderName` added in Task 1, used in Task 4.
- Context interface matches between creation (Task 5) and consumption (Task 10).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-provider-dynamic-theme.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**