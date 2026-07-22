#!/usr/bin/env node

/**
 * Claude Message Schema Analyzer
 *
 * Scans all JSONL files in a directory to build a complete catalog of:
 * - Message types and their structures
 * - Content block types
 * - Tool names and their input/result schemas
 *
 * Usage: node analyze-claude-messages.js /path/to/.claude/projects
 * Output: schema-report.json (detailed) + schema-summary.md (human-readable)
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { join, extname } from "path";

// Schema inference helpers
function getType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function mergeFieldInfo(existing, newType, newValue) {
  if (!existing) {
    return {
      types: new Set([newType]),
      occurrences: 1,
      examples: newType === "string" && newValue.length < 100 ? [newValue] : [],
      arrayItemTypes:
        newType === "array" ? new Set(newValue.map((v) => getType(v))) : null,
    };
  }

  existing.types.add(newType);
  existing.occurrences++;

  if (
    newType === "string" &&
    newValue.length < 100 &&
    existing.examples.length < 3
  ) {
    if (!existing.examples.includes(newValue)) {
      existing.examples.push(newValue);
    }
  }

  if (newType === "array" && existing.arrayItemTypes) {
    newValue.forEach((v) => existing.arrayItemTypes.add(getType(v)));
  }

  return existing;
}

function inferSchema(obj, schema = {}, path = "") {
  if (obj === null || obj === undefined) return schema;

  if (typeof obj !== "object" || Array.isArray(obj)) {
    return schema;
  }

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const valueType = getType(value);

    schema[fieldPath] = mergeFieldInfo(schema[fieldPath], valueType, value);

    // Recurse into objects (but not arrays - we just note item types)
    if (valueType === "object") {
      inferSchema(value, schema, fieldPath);
    }
  }

  return schema;
}

// Main analysis state
const analysis = {
  filesScanned: 0,
  totalMessages: 0,
  messageTypes: {}, // type -> count
  contentBlockTypes: {}, // type -> count
  toolUsage: {}, // toolName -> { count, inputSchema, resultSchema }
  messageSchemas: {}, // messageType -> schema
  errors: [],
};

function recordMessageType(type) {
  analysis.messageTypes[type] = (analysis.messageTypes[type] || 0) + 1;
}

function recordContentBlock(block) {
  const type = block.type;
  analysis.contentBlockTypes[type] =
    (analysis.contentBlockTypes[type] || 0) + 1;

  if (type === "tool_use") {
    const toolName = block.name;
    if (!analysis.toolUsage[toolName]) {
      analysis.toolUsage[toolName] = {
        count: 0,
        inputSchema: {},
        resultSchema: {},
      };
    }
    analysis.toolUsage[toolName].count++;
    inferSchema(block.input, analysis.toolUsage[toolName].inputSchema);
  }

  if (type === "tool_result") {
    // Tool results reference tool_use by id - we need to find the matching tool
    // For now, infer schema generically; we'll correlate later
    const content = block.content;
    if (typeof content === "string") {
      try {
        const parsed = JSON.parse(content);
        // We'll need to correlate this with tool_use blocks
        // Store under a generic key for now
        if (block.tool_use_id) {
          // Mark for correlation
          block._parsedContent = parsed;
        }
      } catch {
        // Plain text result
      }
    }
  }
}

function processMessage(msg, lineNum, filePath) {
  analysis.totalMessages++;

  const msgType = msg.type;
  if (!msgType) {
    analysis.errors.push({
      file: filePath,
      line: lineNum,
      error: "Missing type field",
    });
    return;
  }

  recordMessageType(msgType);

  // Infer message-level schema
  if (!analysis.messageSchemas[msgType]) {
    analysis.messageSchemas[msgType] = {};
  }
  inferSchema(msg, analysis.messageSchemas[msgType]);

  // Process content blocks for assistant/user messages
  if (msg.message?.content && Array.isArray(msg.message.content)) {
    // Build tool_use id -> name map for correlating results
    const toolUseMap = {};

    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        toolUseMap[block.id] = block.name;
      }
      recordContentBlock(block);
    }

    // Second pass: correlate tool_result with tool_use
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const toolName = toolUseMap[block.tool_use_id];
        if (toolName && analysis.toolUsage[toolName]) {
          // Parse and infer result schema
          let resultData = block.content;
          if (typeof resultData === "string") {
            try {
              resultData = JSON.parse(resultData);
            } catch {
              // Keep as string
              resultData = { _raw: "string" };
            }
          }
          if (Array.isArray(resultData)) {
            // Handle array results (common for some tools)
            resultData = { _items: resultData[0] || {} };
          }
          inferSchema(resultData, analysis.toolUsage[toolName].resultSchema);
        }
      }
    }
  }
}

async function processFile(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        processMessage(msg, i + 1, filePath);
      } catch (e) {
        analysis.errors.push({ file: filePath, line: i + 1, error: e.message });
      }
    }

    analysis.filesScanned++;
  } catch (e) {
    analysis.errors.push({ file: filePath, error: e.message });
  }
}

async function findJsonlFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await findJsonlFiles(fullPath, files);
    } else if (entry.isFile() && extname(entry.name) === ".jsonl") {
      files.push(fullPath);
    }
  }

  return files;
}

function serializeSchema(schema) {
  const result = {};
  for (const [path, info] of Object.entries(schema)) {
    result[path] = {
      types: Array.from(info.types),
      occurrences: info.occurrences,
      examples: info.examples?.slice(0, 3),
      arrayItemTypes: info.arrayItemTypes
        ? Array.from(info.arrayItemTypes)
        : undefined,
    };
  }
  return result;
}

function generateReport() {
  const report = {
    summary: {
      filesScanned: analysis.filesScanned,
      totalMessages: analysis.totalMessages,
      messageTypes: analysis.messageTypes,
      contentBlockTypes: analysis.contentBlockTypes,
      toolCount: Object.keys(analysis.toolUsage).length,
    },
    tools: {},
    messageSchemas: {},
    errors: analysis.errors.slice(0, 20), // First 20 errors only
  };

  // Serialize tool schemas
  for (const [toolName, data] of Object.entries(analysis.toolUsage)) {
    report.tools[toolName] = {
      count: data.count,
      inputFields: serializeSchema(data.inputSchema),
      resultFields: serializeSchema(data.resultSchema),
    };
  }

  // Serialize message schemas
  for (const [msgType, schema] of Object.entries(analysis.messageSchemas)) {
    report.messageSchemas[msgType] = serializeSchema(schema);
  }

  return report;
}

function generateMarkdownSummary(report) {
  const lines = [
    "# Claude Message Schema Analysis",
    "",
    "## Summary",
    "",
    `- Files scanned: ${report.summary.filesScanned}`,
    `- Total messages: ${report.summary.totalMessages}`,
    `- Unique tools: ${report.summary.toolCount}`,
    "",
    "## Message Types",
    "",
    "| Type | Count |",
    "|------|-------|",
  ];

  for (const [type, count] of Object.entries(report.summary.messageTypes).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${type} | ${count} |`);
  }

  lines.push(
    "",
    "## Content Block Types",
    "",
    "| Type | Count |",
    "|------|-------|",
  );

  for (const [type, count] of Object.entries(
    report.summary.contentBlockTypes,
  ).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${type} | ${count} |`);
  }

  lines.push("", "## Tools", "");

  const sortedTools = Object.entries(report.tools).sort(
    (a, b) => b[1].count - a[1].count,
  );

  for (const [toolName, data] of sortedTools) {
    lines.push(`### ${toolName} (${data.count} uses)`, "");

    const inputFields = Object.keys(data.inputFields).filter(
      (k) => !k.includes("."),
    );
    const resultFields = Object.keys(data.resultFields).filter(
      (k) => !k.includes("."),
    );

    if (inputFields.length > 0) {
      lines.push("**Input fields:**", "");
      for (const field of inputFields) {
        const info = data.inputFields[field];
        const types = info.types.join(" | ");
        lines.push(
          `- \`${field}\`: ${types}${info.examples?.length ? ` (e.g., "${info.examples[0]}")` : ""}`,
        );
      }
      lines.push("");
    }

    if (resultFields.length > 0) {
      lines.push("**Result fields:**", "");
      for (const field of resultFields) {
        const info = data.resultFields[field];
        const types = info.types.join(" | ");
        lines.push(`- \`${field}\`: ${types}`);
      }
      lines.push("");
    }
  }

  if (report.errors.length > 0) {
    lines.push(
      "## Errors",
      "",
      `Found ${report.errors.length} parsing errors (showing first 20):`,
      "",
    );
    for (const err of report.errors) {
      lines.push(
        `- ${err.file}${err.line ? `:${err.line}` : ""}: ${err.error}`,
      );
    }
  }

  return lines.join("\n");
}

// Main
async function main() {
  const targetDir = process.argv[2];

  if (!targetDir) {
    console.error(
      "Usage: node analyze-claude-messages.js /path/to/.claude/projects",
    );
    process.exit(1);
  }

  console.log(`Scanning ${targetDir} for JSONL files...`);

  const files = await findJsonlFiles(targetDir);
  console.log(`Found ${files.length} JSONL files`);

  for (const file of files) {
    await processFile(file);
    process.stdout.write(".");
  }
  console.log();

  const report = generateReport();
  const markdown = generateMarkdownSummary(report);

  await writeFile("schema-report.json", JSON.stringify(report, null, 2));
  await writeFile("schema-summary.md", markdown);

  console.log(
    `\nDone! Analyzed ${analysis.totalMessages} messages from ${analysis.filesScanned} files.`,
  );
  console.log(
    "Output: schema-report.json (detailed), schema-summary.md (summary)",
  );
}

main().catch(console.error);
