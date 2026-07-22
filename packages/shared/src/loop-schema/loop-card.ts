import { z } from "zod";

/**
 * LoopCard — trigger 层为每个长期 loop 维护的产品规格。
 * 权威定义：docs/spec/02-schema契约.md §1。
 * YAML 是权威文本格式；本 schema 用于服务端加载与 API 写入时校验。
 */
export const VerificationPhaseSchema = z.enum([
  "static",
  "runtime",
  "interaction",
  "review",
]);
export type VerificationPhase = z.infer<typeof VerificationPhaseSchema>;

const TriggerSchema = z
  .object({
    type: z.enum(["manual", "webhook", "schedule", "resume"]),
    cron: z.string().optional(),
  })
  .superRefine((trigger, ctx) => {
    if (trigger.type === "schedule" && !trigger.cron) {
      ctx.addIssue({
        code: "custom",
        message: "cron is required when trigger.type is schedule",
        path: ["cron"],
      });
    }
  });

const StopRulesSchema = z
  .object({
    // 总轮次上限，含首轮
    max_turns: z.number(),
    max_time_minutes: z.number(),
    // retry 次数上限，不含首轮；与 max_turns 同时生效、先触者停
    max_retries: z.number(),
    stop_on_repeated_failure: z.number().optional(),
  })
  .refine((rules) => rules.max_retries < rules.max_turns, {
    message: "max_retries must be less than max_turns",
  });

export const LoopCardSchema = z.object({
  loop: z.object({
    // loop 唯一标识，kebab-case
    id: z.string(),
    trigger: TriggerSchema,
    discovery: z
      .object({
        source: z.string().optional(),
        query: z.string().optional(),
      })
      .optional(),
    handoff: z
      .object({
        default_task_type: z.string().optional(),
        max_items_per_run: z.number().optional(),
      })
      .optional(),
    workspace: z.object({
      strategy: z.enum(["worktree", "direct"]),
    }),
    verification: z.object({
      required: z.array(VerificationPhaseSchema),
    }),
    eval: z
      .object({
        eval_plan: z.string().optional(),
        regression_scope: z.array(z.string()).optional(),
        baseline: z.string().optional(),
        canary_rule: z.string().optional(),
      })
      .optional(),
    observability: z
      .object({
        signals: z.array(z.string()).optional(),
        required_artifacts: z.array(z.string()).optional(),
        dashboard_tags: z.array(z.string()).optional(),
        alert_triggers: z.array(z.string()).optional(),
      })
      .optional(),
    schedule: z
      .object({
        queue: z.enum(["urgent", "normal", "background"]).optional(),
        resume_rule: z.string().optional(),
      })
      .optional(),
    human_gate: z
      .object({
        required_for: z.array(z.string()).optional(),
      })
      .optional(),
    persistence: z.object({
      state_file: z.string(),
    }),
    stop_rules: StopRulesSchema,
  }),
});
export type LoopCard = z.infer<typeof LoopCardSchema>;
