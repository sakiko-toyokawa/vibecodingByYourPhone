import { z } from "zod";

/**
 * VerificationRule — L2 規則檢查的單條規則（layered-verifier 計畫 Phase 2）。
 *
 * 規則即資料：pattern 是正則 source（JSON 可承載），不承載函數 ——
 * 函數型規則無法序列化進 card / .verifier/rules.json，違反「新增規則只改
 * 配置」的目標。複雜檢查應升級為 L3 structural 策略，不是塞進正則。
 *
 * scope 決定掃描範圍（預設 changed —— 對既有違規不溯及既往，避免
 * 存量債務擋住新 run）：
 * - changed：本輪 diff.patch 觸及的檔案（無 diff 時回落 targets）
 * - targets：合約 target.files 指定的檔案
 * - workspace：全工作區（如 no-hardcoded-secrets 這類存量也重要的規則）
 */
export const VerificationRuleSchema = z.object({
  /** 規則唯一名（kebab-case），同時作為 issue id 前綴。 */
  name: z.string(),
  /** 正則 source（不含 / 分隔符）。 */
  pattern: z.string(),
  /** 正則 flags；預設 "i"。全域匹配由執行器強制加 g，不需在此宣告。 */
  flags: z.string().optional(),
  /** error = 命中即 failed；warning = 記錄進 issues 但不阻塞。 */
  severity: z.enum(["error", "warning"]).default("error"),
  /** 人讀訊息（命中時進 unresolved_risks / issues.message）。 */
  message: z.string(),
  /** 修復建議（可選，進 issues.suggestion）。 */
  suggestion: z.string().optional(),
  /** 掃描範圍（見檔頭說明）。 */
  scope: z.enum(["changed", "targets", "workspace"]).default("changed"),
  /**
   * 檔案過濾（後綴匹配，如 [".ts", "src/routes/"]）；缺省 = 常見文字
   * 副檔名集合。僅在 workspace scope 下需要顯式收窄時使用。
   */
  files: z.array(z.string()).optional(),
});
export type VerificationRule = z.infer<typeof VerificationRuleSchema>;

/** .verifier/rules.json 的檔案格式（規則陣列 + 可選版本標記）。 */
export const VerificationRuleSetSchema = z.object({
  version: z.number().optional(),
  rules: z.array(VerificationRuleSchema),
});
export type VerificationRuleSet = z.infer<typeof VerificationRuleSetSchema>;
