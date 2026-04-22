import { z } from "zod";

const SessionIdSchema = z.string().uuid();

const CustomTitleEntrySchema = z.object({
  type: z.literal("custom-title"),
  sessionId: SessionIdSchema,
  customTitle: z.string(),
});

const AiTitleEntrySchema = z.object({
  type: z.literal("ai-title"),
  sessionId: SessionIdSchema,
  aiTitle: z.string(),
});

const LastPromptEntrySchema = z.object({
  type: z.literal("last-prompt"),
  sessionId: SessionIdSchema,
  lastPrompt: z.string(),
});

const TaskSummaryEntrySchema = z.object({
  type: z.literal("task-summary"),
  sessionId: SessionIdSchema,
  summary: z.string(),
  timestamp: z.string(),
});

const TagEntrySchema = z.object({
  type: z.literal("tag"),
  sessionId: SessionIdSchema,
  tag: z.string(),
});

const AgentNameEntrySchema = z.object({
  type: z.literal("agent-name"),
  sessionId: SessionIdSchema,
  agentName: z.string(),
});

const AgentColorEntrySchema = z.object({
  type: z.literal("agent-color"),
  sessionId: SessionIdSchema,
  agentColor: z.string(),
});

const AgentSettingEntrySchema = z.object({
  type: z.literal("agent-setting"),
  sessionId: SessionIdSchema,
  agentSetting: z.string(),
});

const PrLinkEntrySchema = z.object({
  type: z.literal("pr-link"),
  sessionId: SessionIdSchema,
  prNumber: z.number(),
  prUrl: z.string(),
  prRepository: z.string(),
  timestamp: z.string(),
});

const ModeEntrySchema = z.object({
  type: z.literal("mode"),
  sessionId: SessionIdSchema,
  mode: z.enum(["coordinator", "normal"]),
});

const PersistedWorktreeSessionSchema = z.object({
  originalCwd: z.string(),
  worktreePath: z.string(),
  worktreeName: z.string(),
  worktreeBranch: z.string().optional(),
  originalBranch: z.string().optional(),
  originalHeadCommit: z.string().optional(),
  sessionId: z.string(),
  tmuxSessionName: z.string().optional(),
  hookBased: z.boolean().optional(),
});

const WorktreeStateEntrySchema = z.object({
  type: z.literal("worktree-state"),
  sessionId: SessionIdSchema,
  worktreeSession: PersistedWorktreeSessionSchema.nullable(),
});

const ContentReplacementEntrySchema = z.object({
  type: z.literal("content-replacement"),
  sessionId: SessionIdSchema,
  agentId: z.string().optional(),
  replacements: z.array(z.unknown()),
});

const FileAttributionStateSchema = z.object({
  contentHash: z.string(),
  claudeContribution: z.number(),
  mtime: z.number(),
});

const AttributionSnapshotEntrySchema = z.object({
  type: z.literal("attribution-snapshot"),
  messageId: z.string(),
  surface: z.string(),
  fileStates: z.record(z.string(), FileAttributionStateSchema),
  promptCount: z.number().optional(),
  promptCountAtLastCommit: z.number().optional(),
  permissionPromptCount: z.number().optional(),
  permissionPromptCountAtLastCommit: z.number().optional(),
  escapeCount: z.number().optional(),
  escapeCountAtLastCommit: z.number().optional(),
});

const SpeculationAcceptEntrySchema = z.object({
  type: z.literal("speculation-accept"),
  timestamp: z.string(),
  timeSavedMs: z.number(),
});

const ContextCollapseCommitEntrySchema = z.object({
  type: z.literal("marble-origami-commit"),
  sessionId: SessionIdSchema,
  collapseId: z.string(),
  summaryUuid: z.string(),
  summaryContent: z.string(),
  summary: z.string(),
  firstArchivedUuid: z.string(),
  lastArchivedUuid: z.string(),
});

const ContextCollapseSnapshotEntrySchema = z.object({
  type: z.literal("marble-origami-snapshot"),
  sessionId: SessionIdSchema,
  staged: z.array(
    z.object({
      startUuid: z.string(),
      endUuid: z.string(),
      summary: z.string(),
      risk: z.number(),
      stagedAt: z.number(),
    }),
  ),
  armed: z.boolean(),
  lastSpawnTokens: z.number(),
});

export const MetadataEntrySchema = z.union([
  CustomTitleEntrySchema,
  AiTitleEntrySchema,
  LastPromptEntrySchema,
  TaskSummaryEntrySchema,
  TagEntrySchema,
  AgentNameEntrySchema,
  AgentColorEntrySchema,
  AgentSettingEntrySchema,
  PrLinkEntrySchema,
  ModeEntrySchema,
  WorktreeStateEntrySchema,
  ContentReplacementEntrySchema,
  AttributionSnapshotEntrySchema,
  SpeculationAcceptEntrySchema,
  ContextCollapseCommitEntrySchema,
  ContextCollapseSnapshotEntrySchema,
]);

export type MetadataEntry = z.infer<typeof MetadataEntrySchema>;
