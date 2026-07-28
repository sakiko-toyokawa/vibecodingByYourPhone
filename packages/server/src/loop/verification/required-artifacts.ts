/**
 * LoopCard observability.required_artifacts 的产物存在性校验
 * (spec: docs/spec/02-schema契约.md §1)。
 *
 * card 声明 required_artifacts 后, run-service 在每轮 judgment 落账前
 * 对 artifacts/<run_id>/ 逐项检查该轮应有的产物是否存在; 缺失项以
 * `missing_required_artifact:<name>` 标注进 judgment evidence ——
 * 只标注, 不改 verdict 语义 (无告警/看板通道, 先做到可查)。
 */

import { readdir } from "node:fs/promises";

/** 目录读不到时的占位标注: 检查本身不可用, 跳过逐项判定避免误报。 */
export const CHECK_UNAVAILABLE_ANNOTATION =
  "required_artifacts_check_unavailable";

/**
 * 本轮后缀名: 与 04/06 #29 的 per-turn 命名口径一致 —— turn > 1 的
 * 产物在最后一个扩展名前插 `-turn<N>` (stdout.log → stdout-turn2.log,
 * executor-summary.md → executor-summary-turn2.md); 无扩展名直接追加。
 */
export function turnSuffixedArtifactName(base: string, turn: number): string {
  if (turn <= 1) {
    return base;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return `${base}-turn${turn}`;
  }
  return `${base.slice(0, dot)}-turn${turn}${base.slice(dot)}`;
}

/**
 * 逐项检查 required_artifacts 在产物目录中是否存在, 返回追加到
 * judgment evidence 的标注列表 (与现有 evidence 条目同为字符串形态)。
 *
 * 匹配口径: required_artifacts 写的是规范名; 该轮 >1 时先查本轮
 * `-turn<N>` 后缀变体, 再回落规范名 —— 两种命名都算命中。
 *
 * 容错口径: 目录读不到 (不存在 / 权限等) 时不能当作"全部缺失"误报,
 * 返回单条 CHECK_UNAVAILABLE_ANNOTATION 标注检查本身不可用。
 */
export async function checkRequiredArtifacts(options: {
  artifactsDir: string;
  required: string[];
  turn: number;
}): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(options.artifactsDir);
  } catch {
    return [CHECK_UNAVAILABLE_ANNOTATION];
  }
  const present = new Set(entries);
  const annotations: string[] = [];
  for (const name of options.required) {
    const candidates =
      options.turn > 1
        ? [turnSuffixedArtifactName(name, options.turn), name]
        : [name];
    if (!candidates.some((candidate) => present.has(candidate))) {
      annotations.push(`missing_required_artifact:${name}`);
    }
  }
  return annotations;
}
