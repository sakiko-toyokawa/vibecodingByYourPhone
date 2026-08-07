import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Regex-based import graph (Phase 3 MVP).
 *
 * 刻意不用 ts-morph / dependency-cruiser：不新增 runtime 依賴。誠實限制
 * （註釋釘死，寫進 report 的 note）：
 * - 只解析相對路徑 import（./ ../）；package import 與 tsconfig paths
 *   alias 不進圖。
 * - 動態 import() / require 變數、re-export 鏈的間接循環可能漏判。
 * - 適合做「明顯循環依賴」的硬地板檢查，不適合完整架構分析。
 */

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "target",
]);

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const MAX_GRAPH_FILES = 2000;

export interface ImportGraph {
  /** 相對 workspace 的檔案 -> 它引用的相對檔案（已解析、僅相對路徑）。 */
  edges: Map<string, string[]>;
  /** 掃描到的 TS 檔案總數。 */
  fileCount: number;
}

export async function buildImportGraph(
  workspacePath: string,
): Promise<ImportGraph> {
  const files = await collectTsFiles(workspacePath);
  const fileSet = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(workspacePath, file), "utf-8");
    } catch {
      continue;
    }
    const deps: string[] = [];
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || !specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelative(file, specifier, fileSet);
      if (resolved) {
        deps.push(resolved);
      }
    }
    edges.set(file, [...new Set(deps)]);
  }
  return { edges, fileCount: files.length };
}

async function collectTsFiles(workspacePath: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_GRAPH_FILES || depth > 12) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_GRAPH_FILES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(full, depth + 1);
        }
        continue;
      }
      if (TS_EXTENSIONS.includes(path.extname(entry.name))) {
        out.push(path.relative(workspacePath, full));
      }
    }
  };
  await walk(workspacePath, 0);
  return out;
}

/** 解析相對 import：試 <specifier>.<ext> 與 <specifier>/index.<ext>。 */
function resolveRelative(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  const base = path
    .relative(".", path.resolve(path.dirname(fromFile), specifier))
    .replace(/\\/g, "/");
  const candidates: string[] = [];
  if (path.extname(base)) {
    candidates.push(base);
  } else {
    for (const ext of TS_EXTENSIONS) {
      candidates.push(`${base}${ext}`);
    }
    for (const ext of TS_EXTENSIONS) {
      candidates.push(`${base}/index${ext}`);
    }
  }
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** DFS 找循環；回傳循環路徑列表（每條是檔案鏈，首尾相同）。 */
export function findCycles(graph: ImportGraph): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of graph.edges.get(node) ?? []) {
      const depState = state.get(dep);
      if (depState === "visiting") {
        const start = stack.indexOf(dep);
        if (start !== -1) {
          cycles.push([...stack.slice(start), dep]);
        }
        continue;
      }
      if (depState !== "done") {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of graph.edges.keys()) {
    if (!state.has(node)) {
      visit(node);
    }
  }
  // 去重：同一環從不同起點進入會產生旋轉副本，用排序鍵去重。
  const seen = new Set<string>();
  return cycles.filter((cycle) => {
    const key = [...cycle.slice(0, -1)].sort().join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
