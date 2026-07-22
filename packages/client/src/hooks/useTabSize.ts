import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type TabSize = "2" | "4" | "8";

const tabSizeLabels: Record<TabSize, string> = {
  "2": "2",
  "4": "4",
  "8": "8",
};

export const TAB_SIZES: TabSize[] = ["2", "4", "8"];

export function getTabSizeLabel(size: TabSize): string {
  return tabSizeLabels[size];
}

function applyTabSize(size: TabSize) {
  document.documentElement.style.setProperty("--tab-size", size);
}

function loadTabSize(): TabSize {
  const stored = localStorage.getItem(UI_KEYS.tabSize);
  if (stored && TAB_SIZES.includes(stored as TabSize)) {
    return stored as TabSize;
  }
  return "2";
}

function saveTabSize(size: TabSize) {
  localStorage.setItem(UI_KEYS.tabSize, size);
}

export function useTabSize() {
  const [tabSize, setTabSizeState] = useState<TabSize>(loadTabSize);

  useEffect(() => {
    applyTabSize(tabSize);
  }, [tabSize]);

  const setTabSize = useCallback((size: TabSize) => {
    setTabSizeState(size);
    saveTabSize(size);
  }, []);

  return { tabSize, setTabSize };
}

export function initializeTabSize() {
  const size = loadTabSize();
  applyTabSize(size);
}
