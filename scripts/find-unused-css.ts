#!/usr/bin/env npx tsx
/**
 * Find and optionally remove unused CSS class selectors.
 *
 * Extracts class selectors from CSS files and searches for their usage
 * in source files. Reports classes that appear to be unused.
 *
 * Usage:
 *   npx tsx scripts/find-unused-css.ts [options]
 *
 * Options:
 *   --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
 *   --src-dir <dir>  Directory to scan for source files (default: packages/client/src)
 *   --verbose        Show which files each class was found in
 *   --json           Output as JSON
 *   --remove         Remove unused CSS rules (writes changes to files)
 *   --dry-run        Show what would be removed without making changes
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface Options {
  cssDir: string;
  srcDir: string;
  verbose: boolean;
  json: boolean;
  remove: boolean;
  dryRun: boolean;
}

interface ClassInfo {
  name: string;
  cssFile: string;
  line: number;
  usedIn: string[];
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    cssDir: "packages/client/src",
    srcDir: "packages/client/src",
    verbose: false,
    json: false,
    remove: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--css-dir":
        options.cssDir = args[++i];
        break;
      case "--src-dir":
        options.srcDir = args[++i];
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--remove":
        options.remove = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
        console.log(`
Find and optionally remove unused CSS class selectors.

Usage:
  npx tsx scripts/find-unused-css.ts [options]

Options:
  --css-dir <dir>  Directory to scan for CSS (default: packages/client/src)
  --src-dir <dir>  Directory to scan for source files (default: packages/client/src)
  --verbose        Show which files each class was found in
  --json           Output as JSON
  --remove         Remove unused CSS rules (writes changes to files)
  --dry-run        Show what would be removed without making changes
  --help           Show this help
`);
        process.exit(0);
    }
  }

  return options;
}

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

function extractClassSelectors(
  cssContent: string,
  filename: string,
): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const lines = cssContent.split("\n");

  // Match class selectors like .foo, .foo-bar, .foo_bar
  // Handles: .class, .class:hover, .class::before, .class.other, .class > child
  const classRegex = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // Skip lines that are inside comments or are likely property values
    if (line.trim().startsWith("*") || line.trim().startsWith("/*")) continue;
    if (line.includes(":") && !line.includes("{") && !line.includes(","))
      continue;

    for (const match of line.matchAll(classRegex)) {
      const className = match[1];

      // Skip likely false positives
      if (className.match(/^[0-9]/)) continue; // .5em etc
      if (className.length < 2) continue; // Single char classes

      // Check if already added from this file
      if (
        !classes.some((c) => c.name === className && c.cssFile === filename)
      ) {
        classes.push({
          name: className,
          cssFile: filename,
          line: lineNum + 1,
          usedIn: [],
        });
      }
    }
  }

  return classes;
}

/**
 * Extract dynamic class prefixes from template literals like `mode-${m}` or `status-${status}`.
 * Returns an array of prefixes found (e.g., ["mode-", "status-"]).
 */
function extractDynamicPrefixes(srcFiles: Map<string, string>): string[] {
  const prefixes = new Set<string>();

  // Match patterns like: `prefix-${variable}`
  // Captures the prefix before ${...}
  const templateLiteralRegex = /`([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  // Match patterns like: `something ${prefix}-${var}` (space before prefix)
  const spacePrefixRegex = /\s([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  // Match patterns like: className={`something ${prefix}-${var}`}
  const nestedTemplateRegex = /\$\{[^}]*\}\s*([a-zA-Z][a-zA-Z0-9-]*)-\$\{/g;

  for (const content of srcFiles.values()) {
    for (const match of content.matchAll(templateLiteralRegex)) {
      prefixes.add(`${match[1]}-`);
    }
    for (const match of content.matchAll(spacePrefixRegex)) {
      prefixes.add(`${match[1]}-`);
    }
    for (const match of content.matchAll(nestedTemplateRegex)) {
      prefixes.add(`${match[1]}-`);
    }
  }

  return Array.from(prefixes);
}

/**
 * Check if a class name matches any dynamic prefix pattern.
 */
function matchesDynamicPrefix(className: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => className.startsWith(prefix));
}

function searchForClass(
  className: string,
  srcFiles: Map<string, string>,
  dynamicPrefixes: string[],
): string[] {
  const foundIn: string[] = [];

  // Check if this class matches a dynamic prefix pattern
  // e.g., "mode-default" matches prefix "mode-" from `mode-${m}`
  if (matchesDynamicPrefix(className, dynamicPrefixes)) {
    // Consider it "used" via dynamic construction
    return ["<dynamic>"];
  }

  // Patterns to search for:
  // - className="foo" or className="... foo ..."
  // - className={`foo`} or className={`... foo ...`}
  // - "foo" in ternary like isActive ? "foo" : ""
  // - classList.add("foo")
  // - class="foo" (HTML)

  // Escape special regex chars in class name
  const escaped = className.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  // Match the class name as a whole word in string contexts
  const patterns = [
    new RegExp(`["'\`]${escaped}["'\`]`, "g"), // Exact match in quotes
    new RegExp(`["'\`][^"'\`]*\\b${escaped}\\b[^"'\`]*["'\`]`, "g"), // Part of a string
    new RegExp(`\\b${escaped}\\b`, "g"), // As identifier (for CSS modules, though we don't use them)
  ];

  for (const [filename, content] of srcFiles) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        foundIn.push(filename);
        break;
      }
    }
  }

  return foundIn;
}

interface CssRule {
  startLine: number; // 0-indexed
  endLine: number; // 0-indexed, inclusive
  selector: string;
  isPartOfGroup: boolean; // true if selector is comma-separated with others
}

/**
 * Find the CSS rule that contains the given class on the given line.
 * Returns the line range to delete, or null if it can't be safely removed.
 */
function findRuleForClass(
  lines: string[],
  className: string,
  lineNum: number,
): CssRule | null {
  // lineNum is 1-indexed from ClassInfo, convert to 0-indexed
  const lineIdx = lineNum - 1;

  // Find the start of the selector (scan backwards for { or })
  let selectorStart = lineIdx;
  for (let i = lineIdx; i >= 0; i--) {
    if (lines[i].includes("{")) {
      // This line has the opening brace, selector starts here or before
      selectorStart = i;
      break;
    }
    if (lines[i].includes("}") && i !== lineIdx) {
      // Previous rule ends here, selector starts after
      selectorStart = i + 1;
      break;
    }
    selectorStart = i;
  }

  // Find the opening brace
  let braceLineIdx = -1;
  for (let i = selectorStart; i < lines.length; i++) {
    if (lines[i].includes("{")) {
      braceLineIdx = i;
      break;
    }
  }

  if (braceLineIdx === -1) return null;

  // Get the full selector text
  const selectorLines = lines.slice(selectorStart, braceLineIdx + 1);
  const selectorText = selectorLines.join("\n").replace(/\{.*$/, "").trim();

  // Check if it's a grouped selector (has commas at the top level)
  // Simple heuristic: if there's a comma not inside parens/brackets
  const isGrouped = /,(?![^(]*\))/.test(selectorText);

  if (isGrouped) {
    // Can't safely remove just one selector from a group
    return {
      startLine: selectorStart,
      endLine: braceLineIdx,
      selector: selectorText,
      isPartOfGroup: true,
    };
  }

  // Find the closing brace by counting braces
  let braceCount = 0;
  let ruleEndIdx = -1;

  for (let i = braceLineIdx; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === "{") braceCount++;
      if (char === "}") braceCount--;
    }
    if (braceCount === 0) {
      ruleEndIdx = i;
      break;
    }
  }

  if (ruleEndIdx === -1) return null;

  // Check for preceding comment (look for lines starting with /* or *)
  let commentStart = selectorStart;
  for (let i = selectorStart - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed === "") {
      commentStart = i;
    } else if (trimmed.endsWith("*/")) {
      // End of a previous comment, don't include
      break;
    } else {
      break;
    }
  }

  // Don't include standalone comments that aren't directly attached
  // (i.e., there's a blank line between comment and selector)
  if (commentStart < selectorStart) {
    let hasBlankBetween = false;
    for (let i = commentStart; i < selectorStart; i++) {
      if (lines[i].trim() === "") {
        hasBlankBetween = true;
        break;
      }
    }
    if (hasBlankBetween) {
      commentStart = selectorStart;
    }
  }

  return {
    startLine: commentStart,
    endLine: ruleEndIdx,
    selector: selectorText,
    isPartOfGroup: false,
  };
}

interface RemovalResult {
  file: string;
  removed: number;
  skipped: number;
  skippedClasses: string[];
}

/**
 * Remove unused CSS rules from files.
 */
function removeUnusedRules(
  unusedByFile: Map<string, ClassInfo[]>,
  dryRun: boolean,
): RemovalResult[] {
  const results: RemovalResult[] = [];

  for (const [file, classes] of unusedByFile) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");

    // Find all rules to remove, sorted by line number descending
    // (so we can remove from bottom to top without messing up line numbers)
    const rulesToRemove: CssRule[] = [];
    const skippedClasses: string[] = [];

    for (const cls of classes) {
      const rule = findRuleForClass(lines, cls.name, cls.line);
      if (rule && !rule.isPartOfGroup) {
        // Check if we already have a rule that overlaps
        const overlaps = rulesToRemove.some(
          (r) =>
            (rule.startLine >= r.startLine && rule.startLine <= r.endLine) ||
            (rule.endLine >= r.startLine && rule.endLine <= r.endLine),
        );
        if (!overlaps) {
          rulesToRemove.push(rule);
        }
      } else if (rule?.isPartOfGroup) {
        skippedClasses.push(cls.name);
      }
    }

    // Sort by startLine descending
    rulesToRemove.sort((a, b) => b.startLine - a.startLine);

    if (rulesToRemove.length === 0) {
      results.push({
        file,
        removed: 0,
        skipped: skippedClasses.length,
        skippedClasses,
      });
      continue;
    }

    // Remove rules from bottom to top
    for (const rule of rulesToRemove) {
      // Remove lines from startLine to endLine inclusive
      lines.splice(rule.startLine, rule.endLine - rule.startLine + 1);
    }

    // Clean up multiple consecutive blank lines
    const cleanedLines: string[] = [];
    let prevBlank = false;
    for (const line of lines) {
      const isBlank = line.trim() === "";
      if (isBlank && prevBlank) continue;
      cleanedLines.push(line);
      prevBlank = isBlank;
    }

    if (!dryRun) {
      fs.writeFileSync(file, cleanedLines.join("\n"));
    }

    results.push({
      file,
      removed: rulesToRemove.length,
      skipped: skippedClasses.length,
      skippedClasses,
    });
  }

  return results;
}

function main() {
  const options = parseArgs();

  // Find CSS files
  const cssFiles = findFiles(options.cssDir, [".css"]);
  if (cssFiles.length === 0) {
    console.error(`No CSS files found in: ${options.cssDir}`);
    process.exit(1);
  }

  // Find source files
  const srcFiles = findFiles(options.srcDir, [".tsx", ".ts", ".jsx", ".js"]);
  if (srcFiles.length === 0) {
    console.error(`No source files found in: ${options.srcDir}`);
    process.exit(1);
  }

  // Load all source files into memory for faster searching
  const srcContents = new Map<string, string>();
  for (const file of srcFiles) {
    srcContents.set(file, fs.readFileSync(file, "utf-8"));
  }

  // Extract all class selectors from CSS
  const allClasses: ClassInfo[] = [];
  for (const cssFile of cssFiles) {
    const content = fs.readFileSync(cssFile, "utf-8");
    const classes = extractClassSelectors(content, cssFile);
    allClasses.push(...classes);
  }

  // Deduplicate by class name (keep first occurrence)
  const uniqueClasses = new Map<string, ClassInfo>();
  for (const cls of allClasses) {
    if (!uniqueClasses.has(cls.name)) {
      uniqueClasses.set(cls.name, cls);
    }
  }

  // Extract dynamic class prefixes from template literals
  const dynamicPrefixes = extractDynamicPrefixes(srcContents);

  if (!options.json) {
    console.log(
      `Found ${uniqueClasses.size} unique class selectors in ${cssFiles.length} CSS files`,
    );
    console.log(`Searching ${srcFiles.length} source files...`);
    if (dynamicPrefixes.length > 0) {
      console.log(`Detected dynamic prefixes: ${dynamicPrefixes.join(", ")}`);
    }
    console.log();
  }

  // Search for each class
  const unused: ClassInfo[] = [];
  const used: ClassInfo[] = [];

  for (const cls of uniqueClasses.values()) {
    cls.usedIn = searchForClass(cls.name, srcContents, dynamicPrefixes);
    if (cls.usedIn.length === 0) {
      unused.push(cls);
    } else {
      used.push(cls);
    }
  }

  // Output results
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          summary: {
            totalClasses: uniqueClasses.size,
            usedClasses: used.length,
            unusedClasses: unused.length,
            cssFiles: cssFiles.length,
            srcFiles: srcFiles.length,
          },
          unused: unused.map((c) => ({
            name: c.name,
            file: c.cssFile,
            line: c.line,
          })),
          ...(options.verbose
            ? {
                used: used.map((c) => ({
                  name: c.name,
                  file: c.cssFile,
                  line: c.line,
                  usedIn: c.usedIn,
                })),
              }
            : {}),
        },
        null,
        2,
      ),
    );
  } else {
    // Group unused by CSS file
    const byFile = new Map<string, ClassInfo[]>();
    for (const cls of unused) {
      const existing = byFile.get(cls.cssFile) || [];
      existing.push(cls);
      byFile.set(cls.cssFile, existing);
    }

    if (unused.length === 0) {
      console.log("No unused classes found!");
    } else {
      console.log(`Found ${unused.length} potentially unused classes:\n`);

      for (const [file, classes] of byFile) {
        const relPath = path.relative(process.cwd(), file);
        console.log(`${relPath} (${classes.length} unused):`);
        for (const cls of classes.sort((a, b) => a.line - b.line)) {
          console.log(`  Line ${cls.line}: .${cls.name}`);
        }
        console.log();
      }
    }

    console.log("---");
    console.log(
      `Summary: ${used.length} used, ${unused.length} unused out of ${uniqueClasses.size} total classes`,
    );

    if (options.verbose && used.length > 0) {
      console.log("\nUsed classes:");
      for (const cls of used) {
        console.log(
          `  .${cls.name} -> ${cls.usedIn.map((f) => path.relative(process.cwd(), f)).join(", ")}`,
        );
      }
    }

    // Handle removal if requested
    if ((options.remove || options.dryRun) && unused.length > 0) {
      console.log(
        options.dryRun
          ? "\n[DRY RUN] Would remove:"
          : "\nRemoving unused rules...",
      );

      const results = removeUnusedRules(byFile, options.dryRun);

      let totalRemoved = 0;
      let totalSkipped = 0;

      for (const result of results) {
        const relPath = path.relative(process.cwd(), result.file);
        if (result.removed > 0 || result.skipped > 0) {
          console.log(
            `  ${relPath}: ${result.removed} removed, ${result.skipped} skipped`,
          );
          if (result.skippedClasses.length > 0 && options.verbose) {
            console.log(
              `    Skipped (grouped selectors): ${result.skippedClasses.join(", ")}`,
            );
          }
        }
        totalRemoved += result.removed;
        totalSkipped += result.skipped;
      }

      console.log(
        `\n${options.dryRun ? "Would remove" : "Removed"} ${totalRemoved} rules, skipped ${totalSkipped} (grouped selectors)`,
      );
    }
  }

  // Exit with error code if unused classes found (and not removed)
  process.exit(unused.length > 0 && !options.remove ? 1 : 0);
}

main();
