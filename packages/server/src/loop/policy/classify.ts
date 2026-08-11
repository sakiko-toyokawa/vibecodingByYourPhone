/**
 * 工具 → 动作分类（05 阶段 2 policy projection 的分类层）。
 *
 * 集中一处、纯函数、可测试：输入一次工具调用（toolName + input），输出
 * 动作类别、命中的硬闸门（若有）、风险等级与"本地可回滚"判定。裁决逻辑
 * （allow / deny / hard_gate）在 arbiter.ts；这里只做分类，不做决策。
 *
 * 权威依据：
 *  - 硬闸门七项：docs/loop-engineering/policy-engine/风险模型.md；
 *  - 风险四级：同上（low 只读 / medium 本地可回滚 / high 更大范围本地修改
 *    或敏感访问 / critical 不可逆外部后果）。
 *
 * 误报边界（本文件定义，宁可误报升级人工，不可漏报自动放开）：
 *  - `git merge --abort` 不算 merge：它是取消一次进行中的合并、把工作区
 *    恢复到合并前，属于本地可回滚操作的逆操作，分类为普通本地 git 命令；
 *  - `git push --force` / `--force-with-lease` 算 merge（改写受保护分支
 *    历史，等价于强行合并）；普通 `git push` 不算硬闸门，分类为 high
 *    （外部可见但可追踪，走 risk_rules 升级，不在七项清单内）；
 *  - `rm -rf` 一律算 delete（即使是 workspace 内路径）：破坏性删除不可
 *    回滚程度太高，按 delete 升级人工；
 *  - `npm publish` 算 publish（对外发布），deploy 脚本（npm run deploy /
 *    vercel / netlify deploy / kubectl apply）算 deploy；
 *  - curl / wget / mail / gh * comment 算 notify（一切对外沟通）；
 *    只读 HTTP 探测请用 WebFetch（分类为 low 只读），不经 Bash；
 *  - 复合命令（a && b; c | d）按段拆分，任一段命中硬闸门即整体命中
 *    （第一段命中的硬闸门胜出）；
 *  - 策略采用黑名单口径：Bash 默认 medium（本地可回滚、bypass 可自批准），
 *    只有硬闸门、workspace 越界写、以及显式高风险黑名单才升级；
 *    powershell / pwsh / cmd / bash -c 等 wrapper 会先解包，再用内层
 *    命令分类，避免 `powershell -Command "New-Item ..."` 这类 workspace
 *    内命令被误判成 unknown high；
 *  - 命令通道的 workspace 边界：写目标（重定向 / tee / cp / mv / dd of=
 *    / sed -i / node -e 内联绝对路径）越出 workspace 时按 high 记——
 *    `echo x > /etc/x`、`node -e "fs.writeFileSync('/etc/x',..)"` 不再
 *    借 medium 档被 bypass 自批准。启发式只认明确写形态，未知形态
 *    保持黑名单默认（不因未识别而升级）。
 */

import { tmpdir } from "node:os";
import path from "node:path";
import type { HardGateAction, RiskLevel } from "@yep-anywhere/shared";

/** 非硬闸门的动作类别；硬闸门命中时 action 就是硬闸门动作本身。 */
export type ToolActionKind = "read" | "write" | "execute" | HardGateAction;

export interface ToolCallClassification {
  /** 动作类别；命中硬闸门时等于该硬闸门动作。 */
  action: ToolActionKind;
  /** 命中的硬闸门（七项之一）；未命中为 null。 */
  hardGate: HardGateAction | null;
  /** 风险四级。 */
  risk: RiskLevel;
  /** 本地且可回滚（bypass 自批准的必要条件，人工闸门与Bypass.md）。 */
  locallyRollbackable: boolean;
  /** 关键参数摘要（截断），进审计记录。 */
  summary: string;
  /** Explicit write targets extracted from the tool call. */
  writeTargets?: string[];
}

export interface ClassifyContext {
  /** workspace 绝对路径（run 的 cwd）；用于判定写入是否在 workspace 内。 */
  workspacePath?: string;
  /** Direct-mode task-scoped allowlist from IntentContract.target.files. */
  directWriteAllowlist?: string[];
  /** Codex commandAction structural hints; used after deterministic checks. */
  commandActions?: CommandActionHint[];
}

/** Minimal projection of Codex CommandAction used by the classifier. */
export interface CommandActionHint {
  type: "read" | "listFiles" | "search" | "unknown";
  command: string;
}

/** 只读工具（与 Process.handleToolApproval 的 plan 白名单保持一致）。 */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TaskOutput",
]);

/** 文件写工具。 */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** 交互工具：无人值守 run 无法回答，分类为 high（走升级 / 拒绝）。 */
const INTERACTIVE_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

/** 本地只读命令 → low。 */
const READ_ONLY_COMMAND =
  /^(ls|cat|head|tail|pwd|echo|grep|rg|find|wc|which|where|env|printenv|date|uname|hostname|whoami|file|stat|du|df|tree|type)\b/;
/** 高风险黑名单：不满足硬闸门七项，但也不允许 bypass 自批准。 */
const HIGH_RISK_BASH_PATTERNS: Array<{ test: (segment: string) => boolean }> = [
  // 外部可见或不可逆的非硬闸门操作
  { test: (s) => /\bgit\s+push\b/.test(s) },
  { test: (s) => /\bgit\s+reset\s+--hard\b/.test(s) },
  { test: (s) => /^git\s+clean\b/.test(s) },
  { test: (s) => /^rm\b/.test(s) },
  { test: (s) => /\brm\s+-[rf]+\b/.test(s) },
  {
    test: (s) =>
      /\b(?:curl|wget|mail|sendmail)\b/.test(s) ||
      /\bgh\s+(?:pr|issue)\s+(?:create|close|comment)\b/.test(s),
  },
  // Windows / PowerShell 破坏性或系统级操作
  {
    test: (s) => /\bRemove-Item\b[\s\S]*\b-Recurse\b[\s\S]*\b-Force\b/i.test(s),
  },
  {
    test: (s) =>
      /^(Remove-Item|rmdir|rd)\b/.test(s) &&
      /(?:-Recurse\b|\/s\b|\s-r\b)/.test(s),
  },
  { test: (s) => /^del\b.*\/(?:s|q)/i.test(s) },
  { test: (s) => /^reg\s+(?:delete|add)\b/i.test(s) },
  { test: (s) => /^(sudo|runas)\b/i.test(s) },
  { test: (s) => /^chmod\b/i.test(s) },
  { test: (s) => /^chown\b/i.test(s) },
  { test: (s) => /^(icacls|takeown)\b/i.test(s) },
  { test: (s) => /^sc\.exe\b/i.test(s) },
  { test: (s) => /^net\s+user\b/i.test(s) },
  { test: (s) => /^netsh\b/i.test(s) },
  { test: (s) => /^Set-ExecutionPolicy\b/i.test(s) },
  { test: (s) => /^(New|Stop|Restart)-Service\b/i.test(s) },
  { test: (s) => /^(Start|Stop)-Process\b/i.test(s) },
  { test: (s) => /^Invoke-(WebRequest|RestMethod)\b/i.test(s) },
  { test: (s) => /^(ssh|scp|sftp)\b/i.test(s) },
  {
    test: (s) =>
      /^(?:shutdown|reboot|mkfs|fdisk|diskpart)\b|^format\s+[A-Za-z]:/i.test(s),
  },
];

/**
 * 解包常见 shell wrapper，让策略看内层真实命令。只处理带引号的
 * -Command / -c 形式，解不开时原样返回（黑名单仍按外层兜底）。
 */
function unwrapCommandWrappers(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const wrapped =
      /^(?:powershell(?:\.exe)?|pwsh|cmd(?:\.exe)?|bash|sh)\s+(?:-Command|-command|-c)\s+["']([\s\S]*?)["']$/i.exec(
        current,
      );
    if (!wrapped?.[1]) break;
    current = wrapped[1].trim();
  }
  return current;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 路径是否位于 workspace 内；相对路径视为 workspace 内（相对 cwd 解析）。 */
export function isInsideWorkspace(
  filePath: string,
  workspacePath: string | undefined,
): boolean {
  if (!filePath) return false;
  if (!workspacePath) return false;
  const resolved = path.resolve(workspacePath, filePath);
  const relative = path.relative(path.resolve(workspacePath), resolved);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

type ShellKind = "bash" | "powershell";

/** 识别 wrapper 所属 shell，用于只对 PowerShell 的块级语法保持分段语义。 */
function detectWrappedShell(command: string): ShellKind {
  return /^(?:powershell(?:\.exe)?|pwsh)\b/i.test(command.trim())
    ? "powershell"
    : "bash";
}

/**
 * 按 shell 复合结构拆段；硬闸门按段判定，避免 `git merge --abort | ...`
 * 类误判。
 *
 * PowerShell 的分号在 `if (...) { ...; ... }` 块内不是顶层命令分隔符，
 * 不能裸拆。否则 `Stop-Process` 这类 cleanup 会被误当成高风险的顶层命令。
 */
function splitCommandSegments(
  command: string,
  shell: ShellKind = "bash",
): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  const flush = (): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] as string;

    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" || ch === "`") {
        escaped = true;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (shell === "powershell") {
      if (ch === "{") {
        braceDepth += 1;
        current += ch;
        continue;
      }
      if (ch === "}" && braceDepth > 0) {
        braceDepth -= 1;
        current += ch;
        continue;
      }
      if (ch === "(") {
        parenDepth += 1;
        current += ch;
        continue;
      }
      if (ch === ")" && parenDepth > 0) {
        parenDepth -= 1;
        current += ch;
        continue;
      }
      if (ch === "[") {
        bracketDepth += 1;
        current += ch;
        continue;
      }
      if (ch === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
        current += ch;
        continue;
      }
    }

    if (braceDepth > 0 || parenDepth > 0 || bracketDepth > 0) {
      current += ch;
      continue;
    }

    if (ch === "|" && command[index + 1] === "|") {
      flush();
      index += 1;
      continue;
    }
    if (ch === "&" && command[index + 1] === "&") {
      flush();
      index += 1;
      continue;
    }
    if (ch === "|" || ch === ";") {
      flush();
      continue;
    }
    // `2>&1` / `>file` 中的 `&` 是重定向，不是命令分隔符。
    if (ch === "&") {
      const previous = command[index - 1];
      if (previous === ">" || previous === "<" || /\d/.test(previous ?? "")) {
        current += ch;
        continue;
      }
      flush();
      continue;
    }

    current += ch;
  }

  flush();
  return segments;
}

/**
 * 提取命令段的写目标路径（启发式，宁可漏报不可误报——只认明确的写
 * 形态，未知形态不拦截）：
 * - 重定向 `>` / `>>`（含 `2>` `&>` 前缀）目标；
 * - `tee` / `cp` / `mv` / `rsync` / `install` 的文件参数（cp 类取目标位）；
 * - `dd of=`；`sed -i` 的文件；
 * - `node/python -e` 内联脚本字符串里出现的绝对路径（受限启发：只在内
 *   联代码内找绝对路径，不扫任意命令参数——`node /usr/lib/x.js` 这类
 *   合法读取不受影响）。
 * 相对路径交由调用方按 workspace 解析判定。
 */
function extractWriteTargets(segment: string): string[] {
  const targets: string[] = [];
  // 重定向目标（>` >>` 2> &> 前缀都算; 目标 token 到空白/分隔符为止）
  for (const match of segment.matchAll(/(?:\d+|&)?>>?\s*([^\s;&|]+)/g)) {
    targets.push(match[1] as string);
  }
  // dd of=<path>
  for (const match of segment.matchAll(/\bdd\b[^;&|]*\bof=([^\s;&|]+)/g)) {
    targets.push(match[1] as string);
  }
  // tee <path>
  for (const match of segment.matchAll(/\btee\s+(?:-\S+\s+)*([^\s;&|]+)/g)) {
    targets.push(match[1] as string);
  }
  // cp / mv / rsync / install: 最后一个非选项参数是写目标
  for (const match of segment.matchAll(
    /\b(?:cp|mv|rsync|install)\s+([^;&|]+)/g,
  )) {
    const args = (match[1] as string)
      .split(/\s+/)
      .filter((arg) => arg.length > 0 && !arg.startsWith("-"));
    const dest = args[args.length - 1];
    if (args.length >= 2 && dest) {
      targets.push(dest);
    }
  }
  // sed -i [expression] <file>
  for (const match of segment.matchAll(
    /\bsed\s+[^;&|]*-i\S*\s+(?:'[^']*'\s+)?([^\s;&|]+)/g,
  )) {
    targets.push(match[1] as string);
  }
  // node/python/bun/deno -e 内联脚本里的绝对路径
  const inline =
    /^(?:node|python|python3|bun|deno)\s+-e\s+(["'])([\s\S]*)\1/.exec(segment);
  if (inline) {
    for (const match of (inline[2] as string).matchAll(
      /([A-Za-z]:[\\/][^\s"';|]+|\/[^\s"';|]+)/g,
    )) {
      targets.push(match[1] as string);
    }
  }
  return targets.filter(
    (target) => target.length > 0 && !target.startsWith("-"),
  );
}

/**
 * 写目标是否越出 workspace（绝对路径在外, 或相对路径经 .. 逃逸）;
 * 无 workspace 上下文时不判 (保持原行为, 不误报)。
 */
function isOutsideWorkspace(
  target: string,
  workspacePath: string | undefined,
): boolean {
  if (!workspacePath) {
    return false;
  }
  // 去掉包裹引号
  const clean = target.replace(/^["']|["']$/g, "");
  if (!clean) {
    return false;
  }
  const tempRoot = path.resolve(tmpdir());
  const resolvedTarget = path.resolve(clean);
  const tempRelative = path.relative(tempRoot, resolvedTarget);
  if (
    tempRelative !== "" &&
    !tempRelative.startsWith("..") &&
    !path.isAbsolute(tempRelative)
  ) {
    return false;
  }
  return !isInsideWorkspace(clean, workspacePath);
}

interface HardGatePattern {
  action: HardGateAction;
  test: (segment: string) => boolean;
}

/** rm 同时带递归与强制旗标（-rf / -fr / -r -f …）即破坏性删除。 */
function isDestructiveRm(segment: string): boolean {
  const tokens = segment.split(/\s+/);
  if (tokens[0] !== "rm") return false;
  const flags = tokens
    .filter((token) => token.startsWith("-") && !token.startsWith("--"))
    .join("");
  return flags.includes("r") && flags.includes("f");
}

/**
 * Bash 命令段 → 硬闸门。顺序即优先级（同段命中多个时取前者）。
 * 每个 test 针对单个命令段匹配。
 */
const HARD_GATE_PATTERNS: HardGatePattern[] = [
  // merge: 合并到受保护分支；--abort 是取消合并，不算（见文件头边界说明）
  {
    action: "merge",
    test: (s) => /^git\s+merge\s+(?!--abort\b)/.test(s),
  },
  // merge: force push 改写远端历史（含 --force-with-lease）
  {
    action: "merge",
    test: (s) => /^git\s+push\b.*\s--force(?:-with-lease)?\b/.test(s),
  },
  // deploy: 部署到生产环境
  {
    action: "deploy",
    test: (s) =>
      /^(npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/.test(s) ||
      /^(vercel|netlify)\s+.*\bdeploy\b/.test(s) ||
      /^kubectl\s+apply\b/.test(s),
  },
  // publish: 对外发布内容
  {
    action: "publish",
    test: (s) =>
      /^(npm|pnpm|yarn)\s+publish\b/.test(s) ||
      /^gh\s+release\s+create\b/.test(s) ||
      /^gh\s+repo\s+fork\b/.test(s) ||
      /^gh\s+pr\s+create\b/.test(s),
  },
  // delete: 删除外部资源 / 破坏性删除。git branch -D 是 managed
  // workspace 内的本地分支清理, 不在此列 —— 默认 medium 自批准。
  { action: "delete", test: isDestructiveRm },
  {
    action: "delete",
    test: (s) => /^git\s+push\b.*\s--delete\b/.test(s),
  },
  // notify: 一切对外沟通（HTTP 调用、邮件、IM webhook、issue/PR 评论）
  {
    action: "notify",
    test: (s) =>
      /^(curl|wget|mail|sendmail)\b/.test(s) ||
      /^gh\s+(?:pr|issue)\s+comment\b/.test(s),
  },
  // close: 关闭 issue / PR 等状态变更
  { action: "close", test: (s) => /^gh\s+(?:issue|pr)\s+close\b/.test(s) },
  // bill: 计费类动作（支付、退款、扣费）
  {
    action: "bill",
    test: (s) =>
      /^(stripe|paypal|alipay)\b/.test(s) || /\b(?:refund|payout)\b/.test(s),
  },
];

/** 只读 git 子命令。 */
const LOCAL_GIT_READONLY =
  /^git\s+(status|log|diff|show|rev-parse|blame|fetch|remote|describe)\b/;

/** Bash 命令分类：硬闸门优先，其次 workspace 边界 / 高风险黑名单，默认 medium。 */
function classifyBashCommand(
  command: string,
  ctx: ClassifyContext,
): ToolCallClassification {
  const unwrapped = unwrapCommandWrappers(command);
  const summary = truncate(unwrapped || command.trim());
  const segments = splitCommandSegments(unwrapped, detectWrappedShell(command));
  if (segments.length === 0) {
    return {
      action: "execute",
      hardGate: null,
      risk: "medium",
      locallyRollbackable: true,
      summary: summary || "(empty command)",
    };
  }

  for (const segment of segments) {
    for (const { action, test } of HARD_GATE_PATTERNS) {
      if (test(segment)) {
        return {
          action,
          hardGate: action,
          risk: "critical",
          locallyRollbackable: false,
          summary,
        };
      }
    }
  }

  // workspace 边界（bypass 不可移除项）：命令通道的写目标越出 workspace
  // 时按"更大范围本地修改"记 high —— 不再让 `node -e fs.writeFileSync
  // ('/etc/...')` / `echo x > /etc/x` 这类命令借 medium 档被自批准。
  // 启发式（extractWriteTargets）：只认明确写形态, 未知形态不拦截。
  for (const segment of segments) {
    for (const target of extractWriteTargets(segment)) {
      if (isOutsideWorkspace(target, ctx.workspacePath)) {
        return {
          action: "write",
          hardGate: null,
          risk: "high",
          locallyRollbackable: false,
          summary: `${summary} [write target outside workspace: ${target}]`,
        };
      }
    }
  }

  // 记录 workspace 内写目标，供 direct-mode allowlist 裁决使用。
  const writeTargets: string[] = [];
  if (ctx.workspacePath) {
    for (const segment of segments) {
      for (const target of extractWriteTargets(segment)) {
        const clean = target.replace(/^["']|["']$/g, "");
        if (clean && !writeTargets.includes(clean)) {
          writeTargets.push(clean);
        }
      }
    }
  }

  // 黑名单：显式高风险操作不因默认 medium 被自批准。
  for (const segment of segments) {
    for (const { test } of HIGH_RISK_BASH_PATTERNS) {
      if (test(segment)) {
        return {
          action: "execute",
          hardGate: null,
          risk: "high",
          locallyRollbackable: false,
          summary,
          ...(writeTargets.length > 0 ? { writeTargets } : {}),
        };
      }
    }
  }

  // Codex 結構化提示只在確定性檢查之後使用：若原生 runtime 把整個命令
  // 標成 read/listFiles/search，則視為只讀。unknown 或混入 unknown 時
  // 不降級，仍走黑名單默認 medium。
  const structuredRead =
    (ctx.commandActions?.length ?? 0) > 0 &&
    ctx.commandActions?.every(
      (action) =>
        action.type === "read" ||
        action.type === "listFiles" ||
        action.type === "search",
    ) === true;
  if (structuredRead) {
    return {
      action: "execute",
      hardGate: null,
      risk: "low",
      locallyRollbackable: true,
      summary,
      ...(writeTargets.length > 0 ? { writeTargets } : {}),
    };
  }

  // 黑名单口径：所有段都是只读才 low；未命中高风险黑名单一律 medium。
  if (
    segments.every(
      (segment) =>
        READ_ONLY_COMMAND.test(segment) || LOCAL_GIT_READONLY.test(segment),
    )
  ) {
    return {
      action: "execute",
      hardGate: null,
      risk: "low",
      locallyRollbackable: true,
      summary,
      ...(writeTargets.length > 0 ? { writeTargets } : {}),
    };
  }
  return {
    action: "execute",
    hardGate: null,
    risk: "medium",
    locallyRollbackable: true,
    summary,
    ...(writeTargets.length > 0 ? { writeTargets } : {}),
  };
}

/** 从写工具 input 提取目标路径（Codex applyPatch / fileChange 形态）。 */
function extractWritePaths(input: unknown): string[] {
  const record = (input ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      paths.push(value);
    }
  }
  if (typeof record.grantRoot === "string" && record.grantRoot.trim()) {
    paths.push(record.grantRoot);
  }
  const changes = record.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const changePath =
        change &&
        typeof change === "object" &&
        "path" in change &&
        typeof (change as { path?: unknown }).path === "string"
          ? (change as { path: string }).path
          : null;
      if (changePath?.trim()) {
        paths.push(changePath);
      }
    }
  }
  const fileChanges = record.fileChanges;
  if (fileChanges && typeof fileChanges === "object") {
    paths.push(...Object.keys(fileChanges as Record<string, unknown>));
  }
  return [...new Set(paths.filter((p) => p.trim().length > 0))];
}

/**
 * 工具调用分类入口。纯函数，不做 IO。
 */
export function classifyToolCall(
  toolName: string,
  input: unknown,
  ctx: ClassifyContext = {},
): ToolCallClassification {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      action: "read",
      hardGate: null,
      risk: "low",
      locallyRollbackable: true,
      summary: toolName,
    };
  }

  if (INTERACTIVE_TOOLS.has(toolName)) {
    return {
      action: "execute",
      hardGate: null,
      risk: "high",
      locallyRollbackable: false,
      summary: toolName,
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const writeTargets = extractWritePaths(input);
    const inside =
      writeTargets.length > 0 &&
      writeTargets.every((target) =>
        isInsideWorkspace(target, ctx.workspacePath),
      );
    return {
      action: "write",
      hardGate: null,
      risk: inside ? "medium" : "high",
      locallyRollbackable: inside,
      summary: truncate(
        writeTargets.length > 0 ? writeTargets.join(", ") : "(unknown path)",
      ),
      writeTargets,
    };
  }

  if (toolName === "Bash") {
    const record = (input ?? {}) as {
      command?: unknown;
      commandActions?: unknown;
    };
    const command =
      typeof (input as { command?: unknown })?.command === "string"
        ? (record.command as string)
        : "";
    const commandActions = Array.isArray(record.commandActions)
      ? record.commandActions.filter(
          (action): action is CommandActionHint =>
            typeof action === "object" &&
            action !== null &&
            typeof (action as { type?: unknown }).type === "string" &&
            ["read", "listFiles", "search", "unknown"].includes(
              (action as { type: string }).type,
            ),
        )
      : undefined;
    return classifyBashCommand(command, {
      ...ctx,
      ...(commandActions ? { commandActions } : {}),
    });
  }

  // 未知工具（含 MCP 工具）：保守分类为 high，走 risk_rules 升级。
  return {
    action: "execute",
    hardGate: null,
    risk: "high",
    locallyRollbackable: false,
    summary: truncate(toolName),
  };
}
