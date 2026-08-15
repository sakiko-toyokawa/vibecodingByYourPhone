/** Single source of truth for relation wake vocabulary and repair limits. */
export const RELATION_TRIGGER_TYPES = [
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "ci_failure",
  "head_moved",
] as const;

export const RELATION_MAX_REPAIRS = 3;
