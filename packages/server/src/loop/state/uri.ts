/**
 * 统一 URI 解析 (04-存储约定.md URI scheme 解析表 + L113: "解析规则统一
 * 在 loop/state/ 实现一个 resolveUri, API 与 learning worker 共用, 不
 * 允许各处手写路径拼接"; 修复 docs/plans/loop-spec-gap-fix-plan.md #23)。
 *
 * 覆盖账本与报告里实际产生的 scheme:
 * - artifact://<run_id>/<file>    → loops/artifacts/<run_id>/<file>
 * - ledger://<run_id>             → loops/runs/<run_id>.jsonl 全文件
 * - ledger://decision-<run_id>    → 同文件, 仅 type=="decision_entry" 的行
 * - intent://<loop_id>            → 注册表查询 (非文件, 只解析不读)
 * - policy://<profile>            → 策略档名 (非文件, 只解析不读)
 * - workspace://<loop_id>/<run_id> → 工作区 (worktrees 未实现, 只解析)
 *
 * 安全: run_id / 文件名做白名单校验并拒绝 `..` 与路径分隔符, 解析结果
 * 必然落在 loops/ 子树内 (防路径逃逸, 同 RunLedgerStore.SAFE_NAME 口径)。
 */

import * as path from "node:path";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class UriResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UriResolutionError";
  }
}

export type ResolvedLoopUri =
  | { kind: "artifact"; runId: string; file: string; filePath: string }
  | { kind: "ledger"; runId: string; decisionsOnly: boolean; filePath: string }
  | { kind: "intent"; loopId: string }
  | { kind: "policy"; profile: string }
  | { kind: "workspace"; loopId: string; runId: string };

export interface ResolveUriOptions {
  /** Yep data directory (loops/ 子树在其下) */
  dataDir: string;
}

function assertSafeName(value: string, what: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new UriResolutionError(
      `unsafe ${what} in loop URI: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * 解析 loop 账本/报告引用 URI。文件类 scheme (artifact/ledger) 返回
 * loops/ 子树内的绝对路径; 非文件类 scheme 返回结构化解析结果。
 * 未知 scheme 或非法形式抛 UriResolutionError。
 */
export function resolveUri(
  uri: string,
  options: ResolveUriOptions,
): ResolvedLoopUri {
  const loopsDir = path.join(options.dataDir, "loops");

  const artifact = /^artifact:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (artifact) {
    const [, runId, file] = artifact as unknown as [string, string, string];
    assertSafeName(runId, "run_id");
    // 文件名允许 per-turn 命名 (name-turn2.json), 仍是单段文件名
    assertSafeName(file, "artifact name");
    return {
      kind: "artifact",
      runId,
      file,
      filePath: path.join(loopsDir, "artifacts", runId, file),
    };
  }

  const decisionLedger = /^ledger:\/\/decision-(.+)$/.exec(uri);
  if (decisionLedger) {
    const runId = decisionLedger[1] as string;
    assertSafeName(runId, "run_id");
    return {
      kind: "ledger",
      runId,
      decisionsOnly: true,
      filePath: path.join(loopsDir, "runs", `${runId}.jsonl`),
    };
  }

  const ledger = /^ledger:\/\/(.+)$/.exec(uri);
  if (ledger) {
    const runId = ledger[1] as string;
    assertSafeName(runId, "run_id");
    return {
      kind: "ledger",
      runId,
      decisionsOnly: false,
      filePath: path.join(loopsDir, "runs", `${runId}.jsonl`),
    };
  }

  const intent = /^intent:\/\/(.+)$/.exec(uri);
  if (intent) {
    const loopId = intent[1] as string;
    assertSafeName(loopId, "loop_id");
    return { kind: "intent", loopId };
  }

  const policy = /^policy:\/\/(.+)$/.exec(uri);
  if (policy) {
    const profile = policy[1] as string;
    assertSafeName(profile, "policy profile");
    return { kind: "policy", profile };
  }

  const workspace = /^workspace:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (workspace) {
    const [, loopId, runId] = workspace as unknown as [string, string, string];
    assertSafeName(loopId, "loop_id");
    assertSafeName(runId, "run_id");
    return { kind: "workspace", loopId, runId };
  }

  throw new UriResolutionError(`unrecognized loop URI: ${uri}`);
}
