/**
 * 意圖合約範本庫（P5）。
 *
 * 常見 task_type 的既定合約形狀：命中範本時不走意圖理解 Agent，
 * 且視為已人工確認（範本本身就是人審過的）—— 省一次 LLM 調用，
 * 也避免 agent 對標準任務型別產生幻覺。
 *
 * 資料即程式碼（TS 常量）：server runtime 不依賴倉庫相對路徑讀檔；
 * `templates/intent-contracts/*.json` 是給使用者參考的鏡像副本，
 * 兩者內容應保持一致。
 */

export interface IntentContractTemplate {
  task_type: string;
  outcome: string;
  success_criteria: string[];
  constraints: string[];
}

export const INTENT_CONTRACT_TEMPLATES: IntentContractTemplate[] = [
  {
    task_type: "read_only_report",
    outcome:
      "一份只讀掃描報告：列出發現與建議，不對工作區做任何修改（報告即結果）",
    success_criteria: ["只讀掃描完成並產出報告文本", "工作區未產生任何寫改動"],
    constraints: ["read_only"],
  },
  {
    task_type: "dependency_update",
    outcome: "升級指定依賴到安全/目標版本，保證構建與測試通過，產出變更報告",
    success_criteria: [
      "依賴版本更新到目標版本",
      "lint / typecheck / test 全部通過",
      "產出變更摘要報告",
    ],
    constraints: ["workspace_bounded", "不改公共 API（除非任務明確要求）"],
  },
  {
    task_type: "maintenance",
    outcome: "完成維護任務並產出結果報告：允許在工作區內做有邊界的修改",
    success_criteria: [
      "任務目標完成並產出報告文本",
      "修改不超出工作區邊界",
      "未嘗試硬閘門動作",
    ],
    constraints: ["workspace_bounded"],
  },
  {
    task_type: "bugfix",
    outcome:
      "在已 clone 的 GitHub issue workspace 中完成最小修復、通過相關檢查、建立本地 commit，並產出報告",
    success_criteria: [
      "issue 所述問題被最小範圍修復",
      "相關 lint / typecheck / test 通過",
      "建立本地 git commit",
      "未 push / fork / 開 PR / 評論 / 關閉 issue",
    ],
    constraints: [
      "workspace_bounded",
      "不 push / fork / 開 PR / 評論 / 關閉 issue / release / deploy",
    ],
  },
];

/** 按 task_type 匹配範本；無命中返回 null。 */
export function matchIntentTemplate(
  taskType: string | undefined,
): IntentContractTemplate | null {
  if (!taskType) {
    return null;
  }
  return (
    INTENT_CONTRACT_TEMPLATES.find(
      (template) => template.task_type === taskType,
    ) ?? null
  );
}
