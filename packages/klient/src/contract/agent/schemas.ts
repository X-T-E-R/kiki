/**
 * Shared agent-scope wire schemas — the payload/result vocabulary reused by
 * the per-domain contracts in `agent/services.ts` and pinned against the
 * engine types by `test/contract-parity.ts`. `PromptPayload.input` mirrors the
 * `PromptPart` subset of `ContentPart` (text / image_url / video_url) from
 * `agent-core-v2/kosong/contract/message.ts`. Task wire shapes mirror the
 * `TaskInfo` union in `protocol/src/events.ts`.
 */

import { z } from 'zod';
import { taskReceiptSchema } from '@kiki/protocol';

// ── prompt parts ────────────────────────────────────────────────────────────

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  imageUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

const videoUrlPartSchema = z.object({
  type: z.literal('video_url'),
  videoUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

/** `PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>`. */
export const promptPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imageUrlPartSchema,
  videoUrlPartSchema,
]);

// ── payloads / results ──────────────────────────────────────────────────────

export const emptyPayloadSchema = z.object({});

export const promptExecutionBindingSchema = z.object({
  profile: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  planMode: z.boolean().optional(),
  swarmMode: z.boolean().optional(),
  goalObjective: z.string().optional(),
  goalFollowUpTiming: z.enum(['subagents_done', 'tasks_done']).optional(),
  goalInitialStatus: z.enum(['active', 'paused']).optional(),
  goalControl: z.enum(['pause', 'resume', 'cancel']).optional(),
});

export const promptPayloadSchema = z.object({
  input: z.array(promptPartSchema),
  execution: promptExecutionBindingSchema.optional(),
  appendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']).optional(),
  // Mirrors `PromptPayload.disabledTools` in the engine (client-managed
  // session denylist, full-replace).
  disabledTools: z.array(z.string()).optional(),
  // Mirrors `PromptPayload.promptId` in the engine (client-chosen prompt
  // record id, echoed on the consuming turn's `turn.started`).
  promptId: z.string().min(1).optional(),
});

/** Same shape as `PromptSkillActivation` in the engine. */
export const promptSkillActivationSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

/** Same shape as `PromptWithSkillsInput` in the engine. */
export const promptWithSkillsPayloadSchema = promptPayloadSchema.extend({
  skills: z.array(promptSkillActivationSchema).min(1),
});

/** Same shape as `PromptWithSkillsResult` in the engine. */
export const promptWithSkillsResultSchema = z.object({
  turn_id: z.number().optional(),
  prompt_id: z.string(),
  created_at: z.string(),
  state: z.enum(['running', 'queued', 'blocked']),
  append_timing: z.enum(['agent_idle', 'subagents_done', 'tasks_done']),
  revision: z.number().int().nonnegative(),
});

/** Same shape as `SteerPayload` in the engine. */
export const steerPayloadSchema = z.object({
  input: z.array(promptPartSchema),
});

/** Same shape as `SkillActivationInput`'s wire subset in the engine. */
export const activateSkillPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

export const promptLaunchResultSchema = z.object({
  turn_id: z.number(),
});

const promptErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  name: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
  get cause(): z.ZodOptional<typeof promptErrorSchema> {
    return promptErrorSchema.optional();
  },
});

export const promptTerminalResultSchema = z.object({
  promptId: z.string(),
  turnId: z.number().optional(),
  state: z.enum(['completed', 'failed', 'cancelled', 'blocked']),
  result: z.discriminatedUnion('type', [
    z.object({ type: z.literal('completed'), steps: z.number(), truncated: z.boolean() }),
    z.object({ type: z.literal('failed'), steps: z.number(), error: promptErrorSchema }),
    z.object({ type: z.literal('cancelled'), steps: z.number(), reason: promptErrorSchema }),
  ]).optional(),
});

export const cancelPayloadSchema = z.object({
  turnId: z.number().optional(),
});

export const runShellCommandPayloadSchema = z.object({
  command: z.string(),
  commandId: z.string().optional(),
});

export const shellCommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  isError: z.boolean().optional(),
  backgrounded: z.boolean().optional(),
});

export const cancelShellCommandPayloadSchema = z.object({
  commandId: z.string(),
});

export const setModelPayloadSchema = z.object({
  model: z.string(),
});

export const setModelResultSchema = z.object({
  model: z.string(),
  providerName: z.string().optional(),
});

export const setEffortPayloadSchema = z.object({
  effort: z.string().min(1),
});

export const setEffortResultSchema = z.object({
  effort: z.string(),
});

export const contextRebuildResultSchema = z.object({
  rebuilt: z.array(z.enum(['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'injections'])),
  changed: z.boolean(),
  changes: z.object({
    profile: z.boolean(),
    promptFields: z.boolean(),
    skills: z.boolean(),
    instructions: z.boolean(),
    plugins: z.boolean(),
    injections: z.boolean(),
  }),
});

export const runtimeBindingSchema = z.object({
  workspaceId: z.string(),
  runtimeId: z.string(),
});

export const modelCapabilitySchema = z.object({
  image_in: z.boolean(),
  video_in: z.boolean(),
  audio_in: z.boolean(),
  thinking: z.boolean(),
  tool_use: z.boolean(),
  max_context_tokens: z.number(),
  max_input_tokens: z.number().optional(),
  dynamically_loaded_tools: z.boolean().optional(),
});

export const permissionModeSchema = z.enum(['manual', 'yolo', 'auto']);

export const setPermissionPayloadSchema = z.object({
  mode: permissionModeSchema,
});

export const agentLoopStatusSchema = z.object({
  state: z.enum(['idle', 'running']),
  activeTurnId: z.number().optional(),
  pendingTurnIds: z.array(z.number()),
  hasPendingRequests: z.boolean(),
  activeTraceId: z.string().optional(),
});

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
});

/**
 * `AgentContextData` — `history` items are full `ContextMessage`s (deep
 * `Message` / `Tool` / `PromptOrigin` unions); mirrored as `unknown` entries.
 */
export const agentContextDataSchema = z.object({
  history: z.array(z.unknown()),
  tokenCount: z.number(),
});

/** `AgentCommandInfo` (`agent-core-v2/agent/command/agentCommand.ts`). */
export const agentCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
});

/** The facade's `runCommand` input shape. */
export const runCommandPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

/** `PlanData = null | { id, content, path }` — null is JSON-representable. */
export const planDataSchema = z.union([
  z.null(),
  z.object({
    id: z.string(),
    content: z.string(),
    path: z.string(),
  }),
]);

export const cancelPlanPayloadSchema = z.object({
  id: z.string().optional(),
});

export const getTasksPayloadSchema = z.object({
  activeOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const taskInfoBaseFields = {
  taskId: z.string(),
  description: z.string(),
  status: taskLifecycleStatusSchema,
  detached: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.union([z.number(), z.null()]),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  receipt: taskReceiptSchema.optional(),
  receiptVerification: z.enum(['verified', 'legacy_unverified', 'invalid']).optional(),
} as const;

/** Protocol `TaskInfo` union (`protocol/src/events.ts`). */
export const agentTaskInfoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('process'),
    command: z.string(),
    pid: z.number(),
    exitCode: z.union([z.number(), z.null()]),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().optional(),
    profile: z.string().optional(),
    model: z.string().optional(),
    thinkingEffort: z.string().optional(),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('question'),
    questionCount: z.number(),
    toolCallId: z.string().optional(),
    ...taskInfoBaseFields,
  }),
]);

export type AgentTaskInfo = z.infer<typeof agentTaskInfoSchema>;

export const stopTaskPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});

export const getTaskOutputPayloadSchema = z.object({
  taskId: z.string(),
  tail: z.number().optional(),
});
