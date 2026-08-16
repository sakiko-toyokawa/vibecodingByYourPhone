/**
 * LOOP-PROPOSAL 标记块解析 + 提案卡钳制层（loop-self-proposal-gate 计划 P1-1/P1-2）。
 *
 * 带 can_propose_loops 授权的 loop 可以在最终报告中输出
 * <<<LOOP-PROPOSAL>>> { card: LoopCard JSON, reason } <<<END-LOOP-PROPOSAL>>>
 * 提议创建子 loop。解析只负责容错抽取与 schema 校验；钳制层是纯函数、
 * 确定性规则（不用模型判断），把提案卡压回安全包线：server 管理的
 * managed:// 工作区、trigger 白名单、approval_mode 不低于父 loop、
 * stop_rules 封顶、血缘写入、depth>1 拒绝。不过即拒绝入闸。
 */

import {
  type ApprovalMode,
  type LoopCard,
  LoopCardSchema,
} from "@yep-anywhere/shared";

export const LOOP_PROPOSAL_BEGIN = "<<<LOOP-PROPOSAL>>>";
export const LOOP_PROPOSAL_END = "<<<END-LOOP-PROPOSAL>>>";

/** 提案卡的 stop_rules 封顶（全局上限，钳制不拒绝）。 */
export const LOOP_PROPOSAL_MAX_TURNS = 10;
export const LOOP_PROPOSAL_MAX_TIME_MINUTES = 120;
/** 配额硬顶（P1-4）：每日提案数上限 / 全局活跃 loop 数上限。 */
export const LOOP_PROPOSAL_DAILY_LIMIT = 5;
export const LOOP_PROPOSAL_MAX_ACTIVE_LOOPS = 20;

/** LOOP-PROPOSAL 块负载：提案卡 + 提案理由。 */
export interface ExtractedLoopProposalPayload {
  card: LoopCard;
  reason: string;
}

/** approval_mode 严格度排序：manual 最严，bypass 最宽。子 loop 不许比父 loop 更宽。 */
const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  manual: 0,
  assisted: 1,
  full_auto: 2,
  bypass: 3,
};

/** trigger 白名单：cron（schedule+cron）与 manual；webhook/resume 无真实点火路径，拒绝。 */
const TRIGGER_TYPE_WHITELIST = new Set(["manual", "schedule"]);
/** publish_mode 白名单（schema 已枚举约束，此处防绕过钳制层直调）。 */
const PUBLISH_MODE_WHITELIST = new Set(["pr", "issue"]);
/**
 * 提案卡 id 必须是 kebab-case：id 会被拼进 managed:// 工作区路径与各类
 * on-disk 目录，放任任意字符串等于放开路径穿越（如 "../../x"）。
 */
const LOOP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parseObject(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Extract the marked loop proposal payload from a turn's final text.
 * card 必须过 LoopCardSchema 校验，不过即丢弃（返回 null）。
 */
export function extractLoopProposalPayload(
  finalText: string,
): ExtractedLoopProposalPayload | null {
  const start = finalText.indexOf(LOOP_PROPOSAL_BEGIN);
  if (start === -1) {
    return null;
  }
  const contentStart = start + LOOP_PROPOSAL_BEGIN.length;
  const end = finalText.indexOf(LOOP_PROPOSAL_END, contentStart);
  if (end === -1) {
    return null;
  }
  const raw = finalText.slice(contentStart, end).trim();
  const object = parseObject(raw);
  if (!object) {
    return null;
  }
  const reason =
    typeof object.reason === "string" && object.reason.trim().length > 0
      ? object.reason.trim()
      : null;
  if (!reason) {
    return null;
  }
  const parsedCard = LoopCardSchema.safeParse(object.card);
  if (!parsedCard.success) {
    return null;
  }
  return { card: parsedCard.data, reason };
}

export interface ClampProposedCardResult {
  ok: boolean;
  /** 钳制后的卡片（ok=true 时必有）；血缘与封顶已写入。 */
  card?: LoopCard;
  /** 拒绝原因（ok=false 时的硬违规；钳制类规则不产生违规）。 */
  violations: string[];
}

/**
 * 钳制层（纯函数，确定性）：把 agent 提议的 loop card 压回安全包线。
 * - workspace：path 一律改写为 managed://loop-workspaces/<id>（不信 agent
 *   自带后缀），strategy 强制 direct（managed 工作区由 server 解析落盘，
 *   worktree 语义不适用）——agent 不许把工作区钉到任意本地 checkout。
 * - id 必须 kebab-case（会拼进 on-disk 路径，放任任意字符串 = 路径穿越）。
 * - trigger.type 白名单（manual / schedule），其余拒绝。
 * - approval_mode 不许低于父 loop（更宽则钳到父 loop 的档位；父 loop 未
 *   声明时按最严的 manual 计）。
 * - publish_mode 白名单（pr / issue）。
 * - stop_rules 封顶：max_turns / max_time_minutes 钳到全局上限。
 * - 血缘：parent_loop_id 写入父 loop id；can_propose_loops 强制关闭
 *   （只有人类能在卡上显式开启，agent 不许自我授予提案权）。
 * - depth>1 拒绝：父 loop 本身是 agent 建的（带 parent_loop_id）且未获
 *   人类显式授权时，提案直接拒绝。
 */
export function clampProposedCard(
  card: LoopCard,
  parentCard: LoopCard,
): ClampProposedCardResult {
  const violations: string[] = [];

  if (
    parentCard.loop.parent_loop_id &&
    parentCard.loop.can_propose_loops !== true
  ) {
    violations.push(
      `depth_exceeded: parent loop '${parentCard.loop.id}' is itself agent-created and lacks an explicit can_propose_loops grant`,
    );
  }
  if (!LOOP_ID_PATTERN.test(card.loop.id)) {
    violations.push(
      `loop_id_not_kebab: '${card.loop.id}' (must match ${LOOP_ID_PATTERN.source})`,
    );
  }
  if (!TRIGGER_TYPE_WHITELIST.has(card.loop.trigger.type)) {
    violations.push(
      `trigger_type_not_allowed: '${card.loop.trigger.type}' (whitelist: manual, schedule)`,
    );
  }
  const publishMode = card.loop.handoff?.publish_mode;
  if (publishMode !== undefined && !PUBLISH_MODE_WHITELIST.has(publishMode)) {
    violations.push(`publish_mode_not_allowed: '${publishMode}'`);
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // managed 路径一律由钳制层生成，不信任 agent 自带的 managed:// 后缀
  // （id 已过 kebab 校验，拼接结果不可能越出 dataDir）。
  const managedPath = `managed://loop-workspaces/${card.loop.id}`;

  const parentApprovalMode =
    parentCard.loop.policy?.approval_mode ?? ("manual" as const);
  const proposedApprovalMode = card.loop.policy?.approval_mode;
  const clampedApprovalMode =
    proposedApprovalMode &&
    APPROVAL_MODE_RANK[proposedApprovalMode] >
      APPROVAL_MODE_RANK[parentApprovalMode]
      ? parentApprovalMode
      : proposedApprovalMode;

  const clamped: LoopCard = {
    ...card,
    loop: {
      ...card.loop,
      trigger: { ...card.loop.trigger },
      workspace: {
        ...card.loop.workspace,
        strategy: "direct",
        path: managedPath,
      },
      ...(card.loop.policy || clampedApprovalMode
        ? {
            policy: {
              ...card.loop.policy,
              ...(clampedApprovalMode
                ? { approval_mode: clampedApprovalMode }
                : {}),
            },
          }
        : {}),
      stop_rules: {
        ...card.loop.stop_rules,
        max_turns: Math.min(
          card.loop.stop_rules.max_turns,
          LOOP_PROPOSAL_MAX_TURNS,
        ),
        max_time_minutes: Math.min(
          card.loop.stop_rules.max_time_minutes,
          LOOP_PROPOSAL_MAX_TIME_MINUTES,
        ),
      },
      parent_loop_id: parentCard.loop.id,
      can_propose_loops: false,
    },
  };
  return { ok: true, card: clamped, violations: [] };
}
