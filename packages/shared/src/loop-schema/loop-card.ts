import { z } from "zod";
import { ApprovalModeSchema } from "./policy.js";

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
        // Phase-2 Yep extension (not in 02-schema契约.md §1): free-form task
        // description. Without it the contract can only generate a generic
        // goal, which is unusable for write-capable (policy) loops.
        task: z.string().optional(),
      })
      .optional(),
    workspace: z.object({
      strategy: z.enum(["worktree", "direct"]),
      // Phase-0 Yep extension (not in 02-schema契约.md §1): absolute path of
      // the target project, used as the run's cwd. The spec's LoopCard has no
      // field that pins a loop to a local checkout; without it a run cannot
      // start a session. Optional so spec-shaped cards still validate.
      path: z.string().optional(),
    }),
    verification: z.object({
      required: z.array(VerificationPhaseSchema),
      // Phase-1 Yep extension (not in 02-schema契约.md §1): explicit
      // verification commands per phase. The spec's verification block only
      // names required phases; without commands the verifier probes the
      // workspace package.json scripts (lint/typecheck → static, test →
      // runtime). Optional so phase-0 cards still validate.
      // 偏差待登记到 06-项目规定.md。
      commands: z
        .object({
          static: z.array(z.string()).optional(),
          runtime: z.array(z.string()).optional(),
        })
        .optional(),
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
    // Phase-2 Yep extension (not in 02-schema契约.md §1): policy 开关。
    // 声明后 run 的 canUseTool 规则来源从硬编码改为策略投影（05 阶段 2
    // "policy projection"）；缺省（无此块）保持阶段 0/1 的只读 plan 行为，
    // 交互会话完全不受影响。profile 名 / approval_mode 在此选择，完整
    // PolicyProfile（risk_rules / hard_gates / bypass 允许范围）由服务端
    // 装配层解析内置默认值。偏差待登记到 06-项目规定.md。
    policy: z
      .object({
        profile: z.string().optional(),
        approval_mode: ApprovalModeSchema.optional(),
      })
      .optional(),
    persistence: z.object({
      state_file: z.string(),
    }),
    stop_rules: StopRulesSchema,
  }),
});
export type LoopCard = z.infer<typeof LoopCardSchema>;
