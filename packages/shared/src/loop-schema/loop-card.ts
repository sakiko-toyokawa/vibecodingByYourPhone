import { z } from "zod";
import { ApprovalModeSchema } from "./policy.js";
import { VerificationRuleSchema } from "./verification-rules.js";

/**
 * 人工閘門 SLA：進入 blocking 狀態後無人回應的催辦/降級策略。
 * - keep：只催辦，不自動處置（安全預設）。
 * - auto_abandon：超時自動失敗，適合可重建、不需人工裁定的任務。
 * - auto_approve_low_risk：僅對 human_reasons 白名單中的低風險
 *   verification inconclusive 自動 approve；policy gate、tool call、
 *   execution_failed、duplicate_pr 等一律保留人工。
 */
export const HumanGateSlaPolicySchema = z.enum([
  "keep",
  "auto_abandon",
  "auto_approve_low_risk",
]);
export type HumanGateSlaPolicy = z.infer<typeof HumanGateSlaPolicySchema>;

export const HumanGateSlaSchema = z.object({
  /** 進入等待多久後發出催辦事件。 */
  reminder_after_minutes: z
    .number()
    .nonnegative()
    .default(24 * 60),
  /** 進入等待多久後執行降級策略。 */
  abandon_after_minutes: z
    .number()
    .positive()
    .default(7 * 24 * 60),
  /** 超時降級策略；`keep` 是安全預設。 */
  policy: HumanGateSlaPolicySchema.default("keep"),
});
export type HumanGateSla = z.infer<typeof HumanGateSlaSchema>;

/**
 * LoopCard — trigger 层为每个长期 loop 维护的产品规格。
 * 权威定义：docs/spec/02-schema契约.md §1。
 * YAML 是权威文本格式；本 schema 用于服务端加载与 API 写入时校验。
 */
export const VerificationPhaseSchema = z.enum([
  "static",
  "runtime",
  // P0 (layered-verifier plan): L2 规则检查与 L3 结构检查的挂载点;
  // 策略实现见 Phase 2 (rule) / Phase 3 (structural), 此前由
  // PhaseNotImplementedStrategy 兜底为 inconclusive, 不静默通过。
  "rule",
  "structural",
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
        // github_prompt 循环的对外发布形态：默认 "pr"（本地修复 + PR-PUBLISH
        // 交接）；"issue" 用于调研/复现类任务，产出 ISSUE-PROPOSAL 提案块，
        // 人工批准后由 server 用 gh issue create 发布（适配 openai/codex 这类
        // PR 邀请制仓库——它们要的是带分析的 issue，不是外部 PR）。
        publish_mode: z.enum(["pr", "issue"]).optional(),
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
          /** Files that must exist in the workspace for verification to pass. */
          file_exists: z.array(z.string()).optional(),
          /** Files that must contain specific patterns for verification to pass. */
          file_contains: z
            .array(
              z.object({
                file: z.string(),
                pattern: z.string(),
              }),
            )
            .optional(),
        })
        .optional(),
      /**
       * P2: L2 規則檢查的 card 內嵌規則（rule phase 消費）。
       * 與 workspace 的 .verifier/rules.json 合併執行；兩者皆缺時 rule
       * phase 回 inconclusive + escalate（宣告了檢查卻無規則 = 配置缺口，
       * 不静默通過）。
       */
      rules: z.array(VerificationRuleSchema).optional(),
      /**
       * Interaction verifier configuration. When `interaction` is present in
       * required phases, the server can ask a read-only agent to generate a
       * Playwright script and then execute it deterministically.
       */
      interaction: z
        .object({
          enabled: z.boolean().optional(),
          url: z.string().optional(),
          start_command: z.string().optional(),
          ready_url: z.string().optional(),
          timeout_ms: z.number().int().positive().optional(),
          install_command: z.string().optional(),
        })
        .optional(),
      /**
       * P7: judge-only review mode. When true, the Verifier Agent performs
       * evidence collection and verdict in one call instead of running the
       * separate collector first.
       */
      review: z
        .object({
          judge_only: z.boolean().default(false),
        })
        .optional(),
    }),
    // eval 配置块:
    // - regression_scope 消费者: server loop/learning/pipeline.ts regression
    //   档 —— 按提案 target 关联的 loop 读 card, 非空时作为 case id 白名单
    //   传给 eval-runner 只复跑白名单内 case (未知 id 跳过并记入
    //   scorecard.scope.unknown_ids; 过滤后 0 个 case fail-closed 不通过)。
    // - eval_plan / baseline / canary_rule 【无消费者，待 06 登记】per-loop
    //   eval 计划/基线/canary 规则均未排期。
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
        // 【无消费者，待 06 登记】signals 无告警/看板通道消费。
        signals: z.array(z.string()).optional(),
        // 消费者：server loop/run-service.ts judgment 落账前的产物存在性
        // 校验 (verification/required-artifacts.ts)——缺失项以
        // `missing_required_artifact:<name>` 标注进 judgment evidence,
        // 不改 verdict 语义。
        required_artifacts: z.array(z.string()).optional(),
        // 【无消费者，待 06 登记】dashboard_tags 无看板通道消费。
        dashboard_tags: z.array(z.string()).optional(),
        // 【无消费者，待 06 登记】alert_triggers 无告警通道消费。
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
        /** 超時語義：不設定時由 server 使用保守預設（只催辦、不自動處置）。 */
        sla: HumanGateSlaSchema.optional(),
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
    /**
     * LOOP-PROPOSAL 閘門（loop-self-proposal-gate 計劃 P1）：顯式授權該
     * loop 的 agent 在報告中輸出 LOOP-PROPOSAL 提案塊（提議創建子 loop，
     * 人工批准後才落地）。缺省/缺字段 = 不能提案——能提案是顯式授權，
     * 向後兼容：既有卡片無此字段一律視為關閉。
     */
    can_propose_loops: z.boolean().optional(),
    /**
     * 血緣：由 LOOP-PROPOSAL 閘門創建的子 loop 記錄其父 loop id。
     * agent 建的 loop 默認不能再提議 loop（depth>1 拒絕），除非人類
     * 在其卡上顯式開 can_propose_loops。
     */
    parent_loop_id: z.string().optional(),
    /**
     * P5: 意圖理解 Agent 開關。開啟後合約構建順序為：
     * task_type 範本命中（免 agent、視為已確認）→ 否則意圖理解 Agent
     * 產生合約草案（confirmed_by_human=false，run 在首輪執行前泊入
     * needs_human，人工 approve 視為確認）。缺省不開啟，保持既有
     * 確定性合約裝配行為。
     */
    intent_understanding: z
      .object({
        use_agent: z.boolean().default(false),
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
      // 消费者: server loop/state/state-md-projection.ts —— control-plane
      // 每次状态迁移后把该文件整体重写为人可读投影 (04-存储约定,
      // 06 偏差 #27 待翻账)。
      state_file: z.string(),
    }),
    stop_rules: StopRulesSchema,
  }),
});
export type LoopCard = z.infer<typeof LoopCardSchema>;
