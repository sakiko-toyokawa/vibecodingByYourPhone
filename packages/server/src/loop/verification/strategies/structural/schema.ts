import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { VerifierIssue } from "@yep-anywhere/shared";

/**
 * JSON Schema 配對驗證（Phase 3 MVP）。
 *
 * 約定：`<name>.schema.json` 驗證同目錄的 `<name>.json`。
 * 刻意不引入 ajv：實作 JSON Schema 的最小誠實子集 ——
 * type / properties / required / items / enum / additionalProperties:false。
 * 遠端 $ref、$schema meta、format、pattern 等不支援，遇到時記 info
 * issue（不阻塞），不偽造驗證能力。需要完整 JSON Schema 語義時應引入
 * ajv 並在 card 配置中顯式開啟 —— 那是一次有意的依賴決策，不偷渡。
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

const MAX_SCHEMA_FILES = 200;

export interface SchemaCheckerOutcome {
  issues: VerifierIssue[];
  risks: string[];
  applicable: boolean;
}

interface MiniSchema {
  type?: string;
  properties?: Record<string, MiniSchema>;
  required?: string[];
  items?: MiniSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  $ref?: string;
  $schema?: string;
}

export class SchemaChecker {
  readonly name = "json-schema";

  async run(input: {
    workspacePath: string;
    phase: VerifierIssue["layer"];
  }): Promise<SchemaCheckerOutcome> {
    const schemaFiles = await this.findSchemaFiles(input.workspacePath);
    if (schemaFiles.length === 0) {
      return { issues: [], risks: [], applicable: false };
    }

    const issues: VerifierIssue[] = [];
    const risks: string[] = [];

    for (const schemaFile of schemaFiles) {
      const schemaPath = path.join(input.workspacePath, schemaFile);
      let schema: MiniSchema;
      try {
        schema = JSON.parse(await readFile(schemaPath, "utf-8"));
      } catch (error) {
        issues.push({
          id: `schema-parse@${schemaFile}`,
          severity: "major",
          layer: input.phase,
          location: { file: schemaFile },
          message: `schema 檔案本身不是合法 JSON: ${(error as Error).message}`,
        });
        risks.push(`schema 檔案非法 JSON: ${schemaFile}`);
        continue;
      }

      if (schema.$ref || schema.$schema) {
        issues.push({
          id: `schema-unsupported@${schemaFile}`,
          severity: "info",
          layer: input.phase,
          location: { file: schemaFile },
          message:
            "遠端 $ref / $schema meta 超出 Phase 3 MVP 的最小 JSON Schema 子集，跳過該檔驗證",
        });
        continue;
      }

      const dataFile = schemaFile.replace(/\.schema\.json$/, ".json");
      const dataPath = path.join(input.workspacePath, dataFile);
      let data: unknown;
      try {
        data = JSON.parse(await readFile(dataPath, "utf-8"));
      } catch {
        // 沒有對應資料檔不算錯（schema 可能先於資料存在）
        continue;
      }

      for (const error of validateMini(schema, data, "$")) {
        issues.push({
          id: `schema-violation@${dataFile}`,
          severity: "major",
          layer: input.phase,
          location: { file: dataFile },
          message: `${dataFile} 違反 ${schemaFile}: ${error}`,
        });
        risks.push(`${dataFile} 違反 ${schemaFile}: ${error}`);
      }
    }

    return { issues, risks, applicable: true };
  }

  private async findSchemaFiles(workspacePath: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= MAX_SCHEMA_FILES || depth > 12) {
        return;
      }
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_SCHEMA_FILES) {
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            await walk(full, depth + 1);
          }
          continue;
        }
        if (entry.name.endsWith(".schema.json")) {
          out.push(path.relative(workspacePath, full));
        }
      }
    };
    await walk(workspacePath, 0);
    return out;
  }
}

/** 最小 JSON Schema 子集驗證；回傳人讀錯誤列表。 */
function validateMini(schema: MiniSchema, data: unknown, at: string): string[] {
  const errors: string[] = [];

  if (schema.enum && !schema.enum.some((value) => value === data)) {
    errors.push(`${at} 不在 enum 允許值內`);
    return errors;
  }

  if (schema.type) {
    const actual = Array.isArray(data)
      ? "array"
      : data === null
        ? "null"
        : typeof data === "number" && Number.isInteger(data)
          ? "integer"
          : typeof data;
    const matches =
      schema.type === actual ||
      (schema.type === "number" && actual === "integer");
    if (!matches) {
      errors.push(`${at} 型別應為 ${schema.type}，實際為 ${actual}`);
      return errors;
    }
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${at} 缺少必填欄位 '${key}'`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        errors.push(...validateMini(subSchema, obj[key], `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(
            `${at} 含未宣告欄位 '${key}'（additionalProperties=false）`,
          );
        }
      }
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(data)) {
    data.forEach((item, index) => {
      errors.push(
        ...validateMini(schema.items as MiniSchema, item, `${at}[${index}]`),
      );
    });
  }

  return errors;
}
