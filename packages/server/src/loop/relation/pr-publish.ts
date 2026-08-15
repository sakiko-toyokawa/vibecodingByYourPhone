/**
 * Structured PR publish payload extraction.
 *
 * GitHub prompt loops are allowed to prepare a local fix and PR description,
 * but must not push or create a PR. When the executor wants to hand off a PR
 * for human approval it can emit a marked JSON block in the final report.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PR_PUBLISH_BEGIN = "<<<PR-PUBLISH>>>";
export const PR_PUBLISH_END = "<<<END-PR-PUBLISH>>>";

export const ISSUE_PROPOSAL_BEGIN = "<<<ISSUE-PROPOSAL>>>";
export const ISSUE_PROPOSAL_END = "<<<END-ISSUE-PROPOSAL>>>";

export interface ExtractedPrPublishPayload {
  repository: string;
  branch: string;
  title: string;
  body: string;
  /** Absolute path to the cloned repository the agent prepared. */
  cwd: string;
}

/**
 * Issue 提案负载（调研/复现类任务）。与 PR 发布不同，提案没有本地产物——
 * 价值全在 title/body 的分析文本里，发布动作（gh issue create）不需要 cwd。
 * action 缺省 = 新建 issue；"comment_on_existing_issue" + target_issue 表示
 * 查重后发现已有 issue，批准后在目标 issue 下发表评论而非新建。
 */
export interface ExtractedIssueProposalPayload {
  repository: string;
  title: string;
  body: string;
  action?: "comment_on_existing_issue";
  target_issue?: number;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Read the configured git identity from a prepared checkout, if present. */
export async function readGitIdentity(
  cwd: string,
): Promise<GitIdentity | null> {
  try {
    const [name, email] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "config", "user.name"], {
        timeout: 10_000,
      }),
      execFileAsync("git", ["-C", cwd, "config", "user.email"], {
        timeout: 10_000,
      }),
    ]);
    const identity = {
      name: name.stdout.trim(),
      email: email.stdout.trim(),
    };
    return identity.name && identity.email ? identity : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

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
 * Extract the marked PR publish payload from a turn's final text.
 * Returns null when the executor did not produce a valid block.
 */
export function extractPrPublishPayload(
  finalText: string,
): ExtractedPrPublishPayload | null {
  const start = finalText.indexOf(PR_PUBLISH_BEGIN);
  if (start === -1) {
    return null;
  }
  const contentStart = start + PR_PUBLISH_BEGIN.length;
  const end = finalText.indexOf(PR_PUBLISH_END, contentStart);
  if (end === -1) {
    return null;
  }
  const raw = finalText.slice(contentStart, end).trim();
  const object = parseObject(raw);
  if (!object) {
    return null;
  }
  const repository = nonEmptyString(object.repository);
  const branch = nonEmptyString(object.branch);
  const title = nonEmptyString(object.title);
  const body = nonEmptyString(object.body);
  const cwd = nonEmptyString(object.cwd);
  if (!repository || !branch || !title || !body || !cwd) {
    return null;
  }
  if (!path.isAbsolute(cwd)) {
    return null;
  }
  return { repository, branch, title, body, cwd };
}

/**
 * Extract the marked issue proposal payload from a turn's final text.
 * Returns null when the executor did not produce a valid block.
 */
export function extractIssueProposalPayload(
  finalText: string,
): ExtractedIssueProposalPayload | null {
  const start = finalText.indexOf(ISSUE_PROPOSAL_BEGIN);
  if (start === -1) {
    return null;
  }
  const contentStart = start + ISSUE_PROPOSAL_BEGIN.length;
  const end = finalText.indexOf(ISSUE_PROPOSAL_END, contentStart);
  if (end === -1) {
    return null;
  }
  const raw = finalText.slice(contentStart, end).trim();
  const object = parseObject(raw);
  if (!object) {
    return null;
  }
  const repository = nonEmptyString(object.repository);
  const title = nonEmptyString(object.title);
  const body = nonEmptyString(object.body);
  if (!repository || !title || !body) {
    return null;
  }
  const payload: ExtractedIssueProposalPayload = { repository, title, body };
  if (object.action === "comment_on_existing_issue") {
    const target = object.target_issue;
    if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
      return null;
    }
    payload.action = "comment_on_existing_issue";
    payload.target_issue = Math.trunc(target);
  }
  return payload;
}
