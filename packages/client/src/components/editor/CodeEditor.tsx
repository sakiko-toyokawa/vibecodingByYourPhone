import { css as cssLanguage } from "@codemirror/lang-css";
import { html as htmlLanguage } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json as jsonLanguage } from "@codemirror/lang-json";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  type TagStyle,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTabSize } from "../../hooks/useTabSize";
import { useResolvedTheme } from "../../hooks/useTheme";

interface CodeEditorProps {
  projectId: string;
  filePath: string;
  value: string;
  savedValue?: string;
  onChange: (value: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSelectionChange?: (selectedText: string | null) => void;
  onAiEditSelection?: (selectedText: string) => void;
  onDraftPersistenceUnavailable?: () => void;
  readOnly?: boolean;
  className?: string;
}

interface SelectionToolbarState {
  text: string;
  left: number;
  top: number;
}

function getDraftKey(projectId: string, filePath: string): string {
  return `editor-draft-${projectId}-${filePath}`;
}

function getFileExtension(filePath: string): string {
  const parts = filePath.toLowerCase().split(".");
  return parts.length > 1 ? (parts.at(-1) ?? "") : "";
}

function getLanguageExtension(filePath: string): Extension[] {
  const ext = getFileExtension(filePath);

  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: ext === "jsx" })];
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return [
        javascript({
          typescript: true,
          jsx: ext === "tsx",
        }),
      ];
    case "json":
      return [jsonLanguage()];
    case "py":
      return [python()];
    case "css":
    case "scss":
    case "less":
      return [cssLanguage()];
    case "html":
    case "htm":
      return [htmlLanguage()];
    case "md":
    case "markdown":
      return [markdownLanguage()];
    default:
      return [];
  }
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.25" y="4.25" width="7" height="7" rx="1.2" />
      <path d="M9.75 4.25V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v5.75a1 1 0 0 0 1 1h1.25" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 1.5l1.15 3.35L11.5 6 8.15 7.15 7 10.5 5.85 7.15 2.5 6l3.35-1.15L7 1.5z" />
      <path d="M11.25 9.5l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45.45-1.3z" />
    </svg>
  );
}

export function CodeEditor({
  projectId,
  filePath,
  value,
  savedValue,
  onChange,
  onDirtyChange,
  onSelectionChange,
  onAiEditSelection,
  onDraftPersistenceUnavailable,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);
  const originalValueRef = useRef(value);
  const previousDraftKeyRef = useRef<string | null>(null);
  const restoredDraftKeyRef = useRef<string | null>(null);
  const draftPersistenceFailedRef = useRef(false);
  const [selectionToolbar, setSelectionToolbar] =
    useState<SelectionToolbarState | null>(null);
  const theme = useResolvedTheme();
  const { tabSize } = useTabSize();
  const draftKey = useMemo(
    () => getDraftKey(projectId, filePath),
    [filePath, projectId],
  );

  const editorTheme = useMemo(() => {
    const isDark = theme === "codex";
    const baseTheme = isDark ? "dark" : "light";

    const selectionColor = isDark
      ? "rgba(152,212,172,0.24)"
      : theme === "gemini"
        ? "rgba(0,91,192,0.18)"
        : "rgba(37,99,235,0.18)";
    const selectionMatchColor = isDark
      ? "rgba(152,212,172,0.16)"
      : theme === "gemini"
        ? "rgba(0,91,192,0.12)"
        : "rgba(37,99,235,0.12)";
    const lineHighlightColor = isDark
      ? "rgba(255,255,255,0.03)"
      : theme === "gemini"
        ? "rgba(25,28,29,0.035)"
        : "rgba(27,28,24,0.035)";

    const syntaxStyles: TagStyle[] = (() => {
      switch (theme) {
        case "codex":
          return [
            { tag: tags.comment, color: "#6e6c82", fontStyle: "italic" },
            { tag: tags.keyword, color: "#98d4ac" },
            { tag: tags.typeName, color: "#b4f0c7" },
            {
              tag: tags.function(tags.variableName),
              color: "#79c0ff",
            },
            { tag: tags.string, color: "#a5d6ff" },
            { tag: tags.number, color: "#fbbc04" },
            { tag: tags.bool, color: "#fbbc04" },
            { tag: tags.operator, color: "#c4c2d6" },
            { tag: tags.propertyName, color: "#9492a8" },
            { tag: tags.tagName, color: "#98d4ac" },
            { tag: tags.attributeName, color: "#b4f0c7" },
            { tag: tags.attributeValue, color: "#a5d6ff" },
            { tag: tags.escape, color: "#fbbc04" },
            { tag: tags.meta, color: "#c4c2d6" },
            {
              tag: tags.heading,
              color: "#f1efff",
              fontWeight: "bold",
            },
            {
              tag: tags.link,
              color: "#98d4ac",
              textDecoration: "underline",
            },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: tags.strong, fontWeight: "bold" },
          ];
        case "gemini":
          return [
            { tag: tags.comment, color: "#727785", fontStyle: "italic" },
            { tag: tags.keyword, color: "#841dd7" },
            { tag: tags.typeName, color: "#6900b2" },
            {
              tag: tags.function(tags.variableName),
              color: "#1a73e8",
            },
            { tag: tags.string, color: "#005bc0" },
            { tag: tags.number, color: "#b32800" },
            { tag: tags.bool, color: "#b32800" },
            { tag: tags.operator, color: "#414754" },
            { tag: tags.propertyName, color: "#004493" },
            { tag: tags.tagName, color: "#005bc0" },
            { tag: tags.attributeName, color: "#1a73e8" },
            { tag: tags.attributeValue, color: "#005bc0" },
            { tag: tags.escape, color: "#1a73e8" },
            { tag: tags.meta, color: "#414754" },
            {
              tag: tags.heading,
              color: "#191c1d",
              fontWeight: "bold",
            },
            {
              tag: tags.link,
              color: "#005bc0",
              textDecoration: "underline",
            },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: tags.strong, fontWeight: "bold" },
          ];
        default:
          return [
            { tag: tags.comment, color: "#8a8a8a", fontStyle: "italic" },
            { tag: tags.keyword, color: "#99462a" },
            { tag: tags.typeName, color: "#7a2f15" },
            {
              tag: tags.function(tags.variableName),
              color: "#762c12",
            },
            { tag: tags.string, color: "#c46a3e" },
            { tag: tags.number, color: "#ba1a1a" },
            { tag: tags.bool, color: "#ba1a1a" },
            { tag: tags.operator, color: "#444748" },
            { tag: tags.propertyName, color: "#5a5a5a" },
            { tag: tags.tagName, color: "#762c12" },
            { tag: tags.attributeName, color: "#7a2f15" },
            { tag: tags.attributeValue, color: "#c46a3e" },
            { tag: tags.escape, color: "#ba1a1a" },
            { tag: tags.meta, color: "#444748" },
            {
              tag: tags.heading,
              color: "#1b1c18",
              fontWeight: "bold",
            },
            {
              tag: tags.link,
              color: "#99462a",
              textDecoration: "underline",
            },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: tags.strong, fontWeight: "bold" },
          ];
      }
    })();

    return createTheme({
      theme: baseTheme,
      settings: {
        background: "var(--bg-code)",
        foreground: "var(--text-primary)",
        caret: "var(--text-primary)",
        selection: selectionColor,
        selectionMatch: selectionMatchColor,
        lineHighlight: lineHighlightColor,
        gutterBackground: "var(--bg-secondary)",
        gutterForeground: "var(--text-dimmed)",
        gutterActiveForeground: "var(--text-primary)",
        gutterBorder: "var(--border-color)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--font-size-base)",
      },
      styles: syntaxStyles,
    });
  }, [theme]);

  const languageExtensions = useMemo(
    () => getLanguageExtension(filePath),
    [filePath],
  );

  const editorExtensions = useMemo(
    () => [
      EditorState.tabSize.of(Number(tabSize)),
      EditorView.theme({
        "&": {
          height: "100%",
          minHeight: "0",
          fontFamily: "var(--font-mono)",
        },
        ".cm-editor": {
          height: "100%",
          minHeight: "0",
        },
        ".cm-scroller, .cm-gutters": {
          height: "100%",
          minHeight: "0",
        },
        ".cm-scroller": {
          overflow: "auto",
          overflowX: "auto",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          fontFamily: "var(--font-mono)",
        },
        ".cm-content": {
          minHeight: "100%",
          paddingTop: "12px",
          paddingBottom: "24px",
          tabSize: "var(--tab-size)",
        },
        ".cm-gutters": {
          minHeight: "100%",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
        },
        ".cm-focused": {
          outline: "none",
        },
        ".cm-tooltip": {
          border: "1px solid var(--border-color)",
          backgroundColor: "var(--bg-surface)",
          color: "var(--text-primary)",
        },
      }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ...languageExtensions,
    ],
    [languageExtensions, tabSize],
  );

  const notifyDraftPersistenceUnavailable = useCallback(() => {
    if (draftPersistenceFailedRef.current) {
      return;
    }
    draftPersistenceFailedRef.current = true;
    onDraftPersistenceUnavailable?.();
  }, [onDraftPersistenceUnavailable]);

  useEffect(() => {
    if (previousDraftKeyRef.current === draftKey) return;

    previousDraftKeyRef.current = draftKey;
    originalValueRef.current = savedValue ?? value;
    restoredDraftKeyRef.current = null;
    setSelectionToolbar(null);
  }, [draftKey, savedValue, value]);

  useEffect(() => {
    originalValueRef.current = savedValue ?? value;
  }, [savedValue, value]);

  useEffect(() => {
    if (restoredDraftKeyRef.current === draftKey) return;

    try {
      const storedDraft = localStorage.getItem(draftKey);
      restoredDraftKeyRef.current = draftKey;
      if (
        storedDraft !== null &&
        storedDraft !== value &&
        storedDraft !== originalValueRef.current
      ) {
        onChange(storedDraft);
      }
    } catch {
      restoredDraftKeyRef.current = draftKey;
      notifyDraftPersistenceUnavailable();
    }
  }, [draftKey, notifyDraftPersistenceUnavailable, onChange, value]);

  useEffect(() => {
    const draftKey = getDraftKey(projectId, filePath);
    const isDirty = value !== originalValueRef.current;
    onDirtyChange?.(isDirty);

    try {
      if (isDirty) {
        localStorage.setItem(draftKey, value);
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      notifyDraftPersistenceUnavailable();
    }
  }, [
    filePath,
    notifyDraftPersistenceUnavailable,
    onDirtyChange,
    projectId,
    value,
  ]);

  function updateSelectionToolbar(view: EditorView) {
    const wrapper = wrapperRef.current;
    const selection = view.state.selection.main;
    const selectedText = selection.empty
      ? null
      : view.state.sliceDoc(selection.from, selection.to);

    onSelectionChange?.(selectedText);

    if (!wrapper || !selectedText || selectedText.length === 0) {
      startTransition(() => setSelectionToolbar(null));
      return;
    }

    const startCoords = view.coordsAtPos(selection.from);
    const endCoords = view.coordsAtPos(selection.to);
    if (!startCoords || !endCoords) {
      startTransition(() => setSelectionToolbar(null));
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const left = (startCoords.left + endCoords.right) / 2 - wrapperRect.left;
    const top = Math.min(startCoords.top, endCoords.top) - wrapperRect.top - 8;
    const clampedLeft = Math.max(72, Math.min(left, wrapperRect.width - 72));

    startTransition(() =>
      setSelectionToolbar({
        text: selectedText,
        left: clampedLeft,
        top: Math.max(16, top),
      }),
    );
  }

  function handleEditorUpdate(update: ViewUpdate) {
    if (
      update.selectionSet ||
      update.docChanged ||
      update.viewportChanged ||
      update.focusChanged
    ) {
      updateSelectionToolbar(update.view);
    }
  }

  async function copySelection(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard failures.
    }
  }

  return (
    <div
      ref={wrapperRef}
      className={[
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-code)]",
        className ?? "",
      ].join(" ")}
    >
      {selectionToolbar && !readOnly && (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: `${selectionToolbar.left}px`,
            top: `${selectionToolbar.top}px`,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] p-1 shadow-lg">
            {onAiEditSelection && (
              <button
                type="button"
                onClick={() => onAiEditSelection(selectionToolbar.text)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <SparkIcon />
                AI Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => copySelection(selectionToolbar.text)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <CopyIcon />
              Copy
            </button>
          </div>
        </div>
      )}

      <CodeMirror
        ref={editorRef}
        value={value}
        height="100%"
        theme={editorTheme}
        editable={!readOnly}
        readOnly={readOnly}
        indentWithTab
        className="min-h-0 h-full flex-1 overflow-hidden"
        basicSetup={{
          foldGutter: false,
          searchKeymap: true,
        }}
        extensions={editorExtensions}
        onChange={onChange}
        onUpdate={handleEditorUpdate}
      />
    </div>
  );
}
