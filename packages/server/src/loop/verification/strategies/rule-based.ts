import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  VerificationRule,
  VerifierIssue,
  VerifierReport,
} from "@yep-anywhere/shared";
import { VerificationRuleSetSchema } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";

/** workspace scope 掃描時排除的目錄。 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  "target",
]);

/** 規則未指定 files 過濾時的預設文字副檔名。 */
const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".sh",
  ".vue",
  ".svelte",
  ".css",
  ".html",
]);

/** workspace 掃描上限（防巨型倉庫拖垮驗證）。 */
const MAX_WORKSPACE_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

/** workspace 規則庫的約定位置。 */
const WORKSPACE_RULES_FILE = path.join(".verifier", "rules.json");

/**
 * RuleBasedStrategy — L2 規則檢查（layered-verifier 計畫 Phase 2）。
 *
 * 規則來源：card 內嵌 `verification.rules` + workspace
 * `.verifier/rules.json`，兩者合併執行。規則即資料（正則 source），
 * 新增規則不需要改程式碼。
 *
 * 誠實口徑：
 * - 兩個來源都沒有規則 → inconclusive + escalate（宣告了 rule phase 卻
 *   無規則可跑是配置缺口，不 vacuous pass）。
 * - 規則檔案存在但 JSON / schema 非法 → inconclusive + escalate（配置
 *   錯誤不是被驗代碼的錯，failed 會誤導 retry）。
 * - scope=changed 但拿不到 diff 也沒有 targets → 該規則無候選檔案，
 *   對該規則視為「無法評估」：記一條 warning issue，不影響 status。
 */
export class RuleBasedStrategy implements VerificationStrategy {
  readonly name = "rule_based";

  constructor(private readonly cardRules: VerificationRule[] = []) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    const workspaceRules = await this.loadWorkspaceRules(input.workspacePath);
    if (workspaceRules.kind === "invalid") {
      return {
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [],
        unresolved_risks: [
          `.verifier/rules.json 存在但解析失敗: ${workspaceRules.error}`,
        ],
        recommendation: "escalate",
        confidence: 0.3,
        requires_human: false,
      };
    }
    const rules = [...this.cardRules, ...workspaceRules.rules];
    if (rules.length === 0) {
      return {
        verifier_phase: input.phase,
        status: "inconclusive",
        evidence_refs: [],
        unresolved_risks: [
          "rule phase 在 verifier chain 中但沒有任何規則可執行（card.verification.rules 與 .verifier/rules.json 皆缺）",
        ],
        recommendation: "escalate",
        confidence: 0.3,
        requires_human: false,
      };
    }

    const issues: VerifierIssue[] = [];
    const errorRisks: string[] = [];
    const evidenceRefs = new Set<string>();
    let evaluated = 0;

    for (const rule of rules) {
      const candidates = await this.candidatesFor(rule, input);
      if (candidates.length === 0) {
        issues.push({
          id: `${rule.name}#no-candidates`,
          severity: "info",
          layer: input.phase,
          message: `rule '${rule.name}' 無候選檔案可檢查（scope=${rule.scope}）`,
        });
        continue;
      }
      for (const candidate of candidates) {
        evaluated += 1;
        const regex = this.compile(rule);
        if (!regex) {
          issues.push({
            id: `${rule.name}#invalid-regex`,
            severity: "info",
            layer: input.phase,
            message: `rule '${rule.name}' 的正則無法編譯: /${rule.pattern}/`,
          });
          continue;
        }
        for (const match of candidate.content.matchAll(regex)) {
          const line = this.lineOf(candidate.content, match.index ?? 0);
          const severity = rule.severity === "error" ? "major" : "minor";
          issues.push({
            id: `${rule.name}@${candidate.file}:${line}`,
            severity,
            layer: input.phase,
            location: { file: candidate.file, line },
            message: rule.message,
            suggestion: rule.suggestion,
          });
          evidenceRefs.add(candidate.ref);
          if (rule.severity === "error") {
            errorRisks.push(
              `${rule.message}（${candidate.file}:${line}, rule=${rule.name}）`,
            );
          }
        }
      }
    }

    if (errorRisks.length > 0) {
      return {
        verifier_phase: input.phase,
        status: "failed",
        evidence_refs: [...evidenceRefs],
        unresolved_risks: errorRisks,
        recommendation: "retry",
        confidence: 0.9,
        requires_human: false,
        issues,
      };
    }
    return {
      verifier_phase: input.phase,
      status: "passed",
      evidence_refs: [...evidenceRefs],
      unresolved_risks: [],
      recommendation: "stop",
      confidence: evaluated > 0 ? 0.9 : 0.5,
      requires_human: false,
      issues,
    };
  }

  private compile(rule: VerificationRule): RegExp | null {
    try {
      // 強制 g：需要 matchAll 枚舉所有命中以產生逐條 issue。
      const flags = rule.flags ?? "i";
      return new RegExp(
        rule.pattern,
        flags.includes("g") ? flags : `${flags}g`,
      );
    } catch {
      return null;
    }
  }

  private lineOf(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i += 1) {
      if (content.charCodeAt(i) === 10) {
        line += 1;
      }
    }
    return line;
  }

  private async loadWorkspaceRules(
    workspacePath: string,
  ): Promise<
    | { kind: "ok"; rules: VerificationRule[] }
    | { kind: "missing"; rules: [] }
    | { kind: "invalid"; error: string }
  > {
    const filePath = path.join(workspacePath, WORKSPACE_RULES_FILE);
    if (!existsSync(filePath)) {
      return { kind: "missing", rules: [] };
    }
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = VerificationRuleSetSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return { kind: "invalid", error: parsed.error.message };
      }
      return { kind: "ok", rules: parsed.data.rules };
    } catch (error) {
      return {
        kind: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 依 rule.scope 收集候選檔案（workspace 優先讀取，回落 artifacts）。 */
  private async candidatesFor(
    rule: VerificationRule,
    input: VerificationInput,
  ): Promise<{ file: string; content: string; ref: string }[]> {
    const files = await this.candidateFiles(rule, input);
    const out: { file: string; content: string; ref: string }[] = [];
    for (const file of files) {
      const target = await this.readTarget(file, input);
      if (target) {
        out.push({ file, ...target });
      }
    }
    return out;
  }

  private async candidateFiles(
    rule: VerificationRule,
    input: VerificationInput,
  ): Promise<string[]> {
    const targets = input.contract.target?.files ?? [];
    if (rule.scope === "targets") {
      return targets;
    }
    if (rule.scope === "workspace") {
      return this.walkWorkspace(input.workspacePath, rule.files);
    }
    // scope=changed：diff.patch 觸及的檔案；無 diff 回落 targets
    const changed = this.changedFilesFromDiff(input.artifacts["diff.patch"]);
    if (changed.length > 0) {
      return this.filterBySuffixes(changed, rule.files);
    }
    return targets;
  }

  /** 從 unified diff 提取 `+++ b/<path>` 觸及的檔案（/dev/null 略過）。 */
  private changedFilesFromDiff(diff: string | undefined): string[] {
    if (!diff) {
      return [];
    }
    const files: string[] = [];
    for (const line of diff.split("\n")) {
      const match = line.match(/^\+\+\+\s+b\/(.+)$/);
      if (match?.[1]) {
        files.push(match[1]);
      }
    }
    return [...new Set(files)];
  }

  private filterBySuffixes(files: string[], suffixes?: string[]): string[] {
    if (!suffixes || suffixes.length === 0) {
      return files;
    }
    return files.filter((file) =>
      suffixes.some((suffix) => file.endsWith(suffix)),
    );
  }

  private async walkWorkspace(
    workspacePath: string,
    suffixes?: string[],
  ): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= MAX_WORKSPACE_FILES || depth > 12) {
        return;
      }
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_WORKSPACE_FILES) {
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            await walk(full, depth + 1);
          }
          continue;
        }
        const rel = path.relative(workspacePath, full);
        const accept = suffixes?.length
          ? suffixes.some((suffix) => rel.endsWith(suffix))
          : DEFAULT_TEXT_EXTENSIONS.has(path.extname(entry.name));
        if (accept) {
          out.push(rel);
        }
      }
    };
    await walk(workspacePath, 0);
    return out;
  }

  private async readTarget(
    file: string,
    input: VerificationInput,
  ): Promise<{ content: string; ref: string } | null> {
    const workspaceFile = path.resolve(input.workspacePath, file);
    if (existsSync(workspaceFile)) {
      try {
        const info = await stat(workspaceFile);
        if (info.size > MAX_FILE_BYTES) {
          return null;
        }
        const content = await readFile(workspaceFile, "utf-8");
        return {
          content,
          ref: `workspace://${input.workspacePath}/${file}`,
        };
      } catch {
        // fall through to artifacts
      }
    }
    const artifact = input.artifacts[file];
    if (artifact !== undefined) {
      return {
        content: artifact,
        ref: `artifact://${input.contract.intent_id}/${file}`,
      };
    }
    return null;
  }
}
