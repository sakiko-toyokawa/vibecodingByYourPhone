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
    // 【webhook / resume 无消费者·已挂账 06 偏差 #27】两种触发源在 05
    // 各阶段均未排期, 目前只有 manual / schedule 有真实点火路径。
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

const StopRulesSchema = z.object({
  // 总轮次上限，含首轮
  max_turns: z.number(),
  max_time_minutes: z.number(),
  // retry 次数上限，不含首轮；与 max_turns 同时生效、先触者停
  // (无严格小于约束 —— 先触者停语义下 max_retries >= max_turns 合法,
  // 06 偏差 #31)
  max_retries: z.number(),
  stop_on_repeated_failure: z.number().optional(),
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
      // 04 容量与清理: worktree 清理口径。max_age_days 覆盖默认 7 天保留线;
      // 无论阈值如何, 活跃/阻塞 run (active/retry/paused/needs_human) 的
      // worktree 始终保留 (恢复依赖该目录)。缺省整块回退默认 7 天。
      cleanup_rule: z
        .object({
          max_age_days: z.number().positive().optional(),
        })
        .optional(),
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
    // 【无消费者·已挂账 06 偏差 #27】eval 配置块: eval runner 只读全局
    // cases.json, 不读任何 card 配置; per-loop eval 计划未排期。
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
        // 【无消费者·已挂账 06 偏差 #27】resume 触发源未排期 (05 各阶段
        // 均未覆盖), resume_rule 随之无消费。
        resume_rule: z.string().optional(),
      })
      .optional(),
    // human_gate.required_for 消费者：server loop/policy/profiles.ts
    // resolvePolicyProfile——解析时并入 hard_gates，与硬闸门同路径升级人工。
    human_gate: z
      .object({
        required_for: z.array(z.string()).optional(),
      })
      .optional(),
    // Yep extension: runtime model selection for unattended loop runs.
    // Empty/absent values mean "use Supervisor/provider defaults".
    runtime: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
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
      // 【仅有约定无投影·已挂账 06 偏差 #27】04-存储约定.md 要求
      // .loop/STATE.md 人可读投影, 但 05 各阶段未排期, 运行时无读写;
      // 该字段当前仅作声明 (测试 fixture 填充)。
      state_file: z.string(),
    }),
    stop_rules: StopRulesSchema,
  }),
});
export type LoopCard = z.infer<typeof LoopCardSchema>;
