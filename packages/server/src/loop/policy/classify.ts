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
 *  - 命令通道的 workspace 边界：写目标（重定向 / tee / cp / mv / dd of=
 *    / sed -i / node -e 内联绝对路径）越出 workspace 时按 high 记——
 *    `echo x > /etc/x`、`node -e "fs.writeFileSync('/etc/x',..)"` 不再
 *    借 medium 档被 bypass 自批准。启发式只认明确写形态，未知形态
 *    保持原分级（误报边界宁严不宽）。
 */

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
}

export interface ClassifyContext {
  /** workspace 绝对路径（run 的 cwd）；用于判定写入是否在 workspace 内。 */
  workspacePath?: string;
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
/** 本地可回滚命令（测试 / 构建 / lint / 本地 git 操作）→ medium。 */
const LOCAL_ROLLBACK_COMMAND =
  /^(npm|pnpm|yarn|npx|pnpm dlx|bun|deno|node|python|pip|pytest|vitest|jest|tsc|tsx|make|cargo|go|mvn|gradle)\b/;
const LOCAL_GIT_COMMAND =
  /^git\s+(add|commit|status|log|diff|show|branch|checkout|switch|restore|stash|tag|rev-parse|blame|fetch|merge\s+--abort)\b/;

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
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** 按 shell 复合结构拆段；硬闸门按段判定，避免 `git merge --abort | ...` 类误判。 */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|&]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
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
  // sed -i <file>
  for (const match of segment.matchAll(/\bsed\s+[^;&|]*-i\S*\s+([^\s;&|]+)/g)) {
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
  // delete: 删除外部资源 / 破坏性删除
  { action: "delete", test: isDestructiveRm },
  {
    action: "delete",
    test: (s) =>
      /^git\s+push\b.*\s--delete\b/.test(s) || /^git\s+branch\s+-D\b/.test(s),
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

/** 只读 git 子命令（独立于 LOCAL_GIT_COMMAND 便于组合判定）。 */
const LOCAL_GIT_READONLY =
  /^git\s+(status|log|diff|show|branch|rev-parse|blame|fetch|remote|describe)\b/;

/** Bash 命令分类：硬闸门优先，其次本地只读 / 本地可回滚，默认 high。 */
function classifyBashCommand(
  command: string,
  ctx: ClassifyContext,
): ToolCallClassification {
  const summary = truncate(command.trim());
  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return {
      action: "execute",
      hardGate: null,
      risk: "high",
      locallyRollbackable: false,
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

  // 非硬闸门段：取全命令中最保守的一个分级依据——所有段都是只读才 low，
  // 全部属于本地可回滚才 medium，否则 high。
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
    };
  }
  if (
    segments.every(
      (segment) =>
        LOCAL_ROLLBACK_COMMAND.test(segment) ||
        LOCAL_GIT_COMMAND.test(segment) ||
        READ_ONLY_COMMAND.test(segment) ||
        LOCAL_GIT_READONLY.test(segment),
    )
  ) {
    return {
      action: "execute",
      hardGate: null,
      risk: "medium",
      locallyRollbackable: true,
      summary,
    };
  }
  return {
    action: "execute",
    hardGate: null,
    risk: "high",
    locallyRollbackable: false,
    summary,
  };
}

/** 从写工具 input 提取目标路径。 */
function extractFilePath(toolName: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const value =
    record.file_path ?? record.notebook_path ?? record.path ?? record.filePath;
  return typeof value === "string" ? value : "";
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
    const filePath = extractFilePath(toolName, input);
    const inside = isInsideWorkspace(filePath, ctx.workspacePath);
    // workspace 内写：本地可回滚（medium）；workspace 外或无路径上下文：
    // 范围更大的本地修改（high），bypass 不得自批准。
    return {
      action: "write",
      hardGate: null,
      risk: inside ? "medium" : "high",
      locallyRollbackable: inside,
      summary: truncate(filePath || "(unknown path)"),
    };
  }

  if (toolName === "Bash") {
    const command =
      typeof (input as { command?: unknown })?.command === "string"
        ? (input as { command: string }).command
        : "";
    return classifyBashCommand(command, ctx);
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
