/**
 * 02 §8.1 运行账本 runtime 块与 02 §3 native_invocation 的真实投影：
 * 从 provider 推导 adapter 标识 / bridge / runtime 原生 mode / interrupt
 * 能力（00 bridge 映射：Claude=agent_sdk、Codex=app_server；06 偏差 #17：
 * Codex 无优雅 interrupt → kill-only；只有 Claude SDK 的 AgentSession
 * 暴露 interrupt() → graceful）。
 */

import { DEFAULT_PROVIDER, type ProviderName } from "@yep-anywhere/shared";

export interface AdapterInfo {
  adapter: string;
  bridge: string;
  /** runtime 原生模式（02 §3 native_invocation.mode：claude=print /
   *  codex=exec，与 bridge 两层字段不得混用）。 */
  mode: string;
  /** 调用面（02 §3 native_invocation.surface）。 */
  surface: string;
  interrupt: "graceful" | "kill-only";
}

export function describeAdapter(provider?: string): AdapterInfo {
  const p = (provider as ProviderName | undefined) ?? DEFAULT_PROVIDER;
  switch (p) {
    case "claude":
    case "claude-ollama":
      return {
        adapter: p,
        bridge: "agent_sdk",
        mode: "print",
        surface: "sdk",
        interrupt: "graceful",
      };
    case "codex":
    case "codex-oss":
      return {
        adapter: p,
        bridge: "app_server",
        mode: "exec",
        surface: "json_rpc",
        interrupt: "kill-only",
      };
    case "gemini":
    case "gemini-acp":
      return {
        adapter: p,
        bridge: "acp",
        mode: "acp",
        surface: "acp",
        interrupt: "kill-only",
      };
    default:
      // 未知 provider 如实记录标识，能力按最保守口径（只能杀进程）。
      return {
        adapter: p,
        bridge: "unknown",
        mode: "unknown",
        surface: "unknown",
        interrupt: "kill-only",
      };
  }
}
