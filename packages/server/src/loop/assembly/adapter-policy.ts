/**
 * adapter_policy 消费 (修复 docs/plans/loop-spec-gap-fix-plan.md #13:
 * RuntimeInput.adapterPolicy 曾全链路无消费者, runtime_adapter_proposal
 * 发布后纯记账)。
 *
 * RuntimeInput.adapterPolicy 来自 published / canary 的
 * runtime_adapter_proposal payload (自由键值对, 02 §8.5 扩展)。本模块是
 * 唯一权威的消费点: 把自由键值解析成 run-service 可执行的真实旋钮
 * —— model 覆盖、verifier 專屬 provider/model 与轮次超时
 * (02 §3 native_invocation.timeout_seconds: "所有 adapter 调用必须带
 * 超时, 不允许无限等待")。
 *
 * 已知键之外的键不生效但记入 ignoredKeys —— 不静默吞掉, 调用方如实
 * 记录 (账本能力快照), 避免"配置以为生效了其实没有"的假生效。
 */

import type { ProviderName } from "../../sdk/providers/types.js";

const PROVIDER_NAMES: ProviderName[] = [
  "claude",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "opencode",
];

export function isKnownProviderName(value: string): value is ProviderName {
  return PROVIDER_NAMES.includes(value as ProviderName);
}

/** adapter_policy 当前支持的消费键。 */
export interface ResolvedAdapterPolicy {
  /** 覆盖 card.loop.runtime.model 的模型名 (payload.model: string)。 */
  model?: string;
  /** L4 verifier 專屬模型；未設定時沿用通用 model / loop runtime。 */
  verifier_model?: string;
  /** L4 verifier 專屬 provider；未設定時沿用 loop runtime。 */
  verifier_provider?: ProviderName;
  /** 轮次超时毫秒 (payload.timeout_seconds: number > 0)。 */
  timeoutMs?: number;
  /** 未被消费的键 (未知键 / 类型不符)。 */
  ignoredKeys: string[];
}

export function resolveAdapterPolicy(
  raw: Record<string, unknown> | undefined,
): ResolvedAdapterPolicy {
  const resolved: ResolvedAdapterPolicy = { ignoredKeys: [] };
  if (!raw) {
    return resolved;
  }
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "model":
        if (typeof value === "string" && value.trim().length > 0) {
          resolved.model = value;
        } else {
          resolved.ignoredKeys.push(key);
        }
        break;
      case "verifier_model":
        if (typeof value === "string" && value.trim().length > 0) {
          resolved.verifier_model = value;
        } else {
          resolved.ignoredKeys.push(key);
        }
        break;
      case "verifier_provider":
        if (
          typeof value === "string" &&
          PROVIDER_NAMES.includes(value as ProviderName)
        ) {
          resolved.verifier_provider = value as ProviderName;
        } else {
          resolved.ignoredKeys.push(key);
        }
        break;
      case "timeout_seconds":
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          resolved.timeoutMs = Math.round(value * 1000);
        } else {
          resolved.ignoredKeys.push(key);
        }
        break;
      default:
        resolved.ignoredKeys.push(key);
    }
  }
  return resolved;
}
