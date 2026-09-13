import { z } from 'zod';

import { defineDelegationProcedure } from './types.js';

const taskNameSchema = z.string().regex(/^(?!root$)[a-z0-9_]+$/u);
const emptySchema = z.object({}).strict();
const dispatchStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const failureCategorySchema = z.enum([
  'auth_expired',
  'quota_exceeded',
  'model_not_supported',
  'network',
  'invalid_input',
  'internal',
]);
const usageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  })
  .strict();
const alternativeModelSchema = z
  .object({
    alias: z.string().min(1),
    when: z.string(),
    thinkingEffort: z.string().optional(),
  })
  .strict();
const dispatchableSchema = z
  .object({
    kind: z.enum(['main', 'named']),
    profileName: z.string().optional(),
    description: z.string().optional(),
    whenToUse: z.string().optional(),
    modelAlias: z.string().optional(),
    thinkingEffort: z.string().optional(),
    allowedModels: z.array(z.string()).optional(),
    alternativeModels: z.array(alternativeModelSchema).optional(),
    tools: z.string().optional(),
  })
  .strict();
const profileSchema = dispatchableSchema.extend({
  kind: z.literal('named'),
  profileName: z.string().min(1),
  alternativeModels: z.array(alternativeModelSchema),
}).strict();
const childSchema = z
  .object({
    taskName: z.string(),
    profileName: z.string(),
    latestDispatchId: z.string().optional(),
    status: dispatchStatusSchema.optional(),
    usage: usageSchema.optional(),
  })
  .strict();
export const externalDispatchSchema = z
  .object({
    dispatchId: z.string().min(1),
    target: z.enum(['main', 'named']),
    taskName: z.string().optional(),
    profileName: z.string().optional(),
    actualProfile: z.string().optional(),
    modelAlias: z.string().optional(),
    thinkingEffort: z.string().optional(),
    status: dispatchStatusSchema,
    nextStep: z.string().optional(),
    continueHint: z.string().optional(),
    createdAt: z.number(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    continuationOf: z.string().optional(),
    activity: z
      .object({
        activeToolCalls: z.array(z.object({
          toolCallId: z.string(),
          name: z.string(),
          since: z.number(),
        }).strict()),
      })
      .strict()
      .optional(),
    usage: usageSchema.optional(),
    errorCode: failureCategorySchema.optional(),
  })
  .strict();
const seatBindingSchema = z
  .object({
    version: z.literal(1),
    seatId: z.string().min(1),
    sessionId: z.string().min(1),
    principalId: z.string().min(1),
    workspacePath: z.string().optional(),
  })
  .strict();
const profilesOutputSchema = z
  .object({ profiles: z.array(profileSchema), binding: seatBindingSchema })
  .strict();
const listOutputSchema = z
  .object({
    version: z.literal(1),
    delegationId: z.string(),
    lifecycle: z.enum(['active', 'closed']),
    dispatchables: z.array(dispatchableSchema),
    children: z.array(childSchema),
    continuations: z.array(externalDispatchSchema),
    binding: seatBindingSchema,
  })
  .strict();
const dispatchInputSchema = z
  .object({
    target: z.enum(['main', 'named']),
    taskName: taskNameSchema.optional(),
    profileName: z.string().trim().min(1).optional(),
    modelAlias: z.string().trim().min(1).optional(),
    thinkingEffort: z.string().trim().min(1).optional(),
    dispatchKey: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.target === 'main' &&
      (value.taskName !== undefined ||
        value.profileName !== undefined ||
        value.modelAlias !== undefined ||
        value.thinkingEffort !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Named-child fields require target named.' });
    }
  })
  .strict();
const continueInputSchema = z
  .object({
    dispatchId: z.string().min(1),
    dispatchKey: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .strict();
const sendInputSchema = z
  .object({
    taskName: taskNameSchema,
    message: z.string().trim().min(1).max(1_000_000),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();
const interactionsInputSchema = z.object({ cursor: z.number().int().nonnegative().optional() }).strict();
const approvalResponseSchema = z
  .object({
    decision: z.enum(['approved', 'rejected', 'cancelled']),
    scope: z.literal('session').optional(),
    feedback: z.string().optional(),
    selectedLabel: z.string().optional(),
    selectedOptionId: z.string().optional(),
  })
  .strict();
const questionAnswersSchema = z.record(z.string(), z.union([z.string(), z.literal(true)]));
const questionResponseSchema = z
  .object({
    answers: questionAnswersSchema,
    method: z.enum(['enter', 'space', 'number_key']).optional(),
  })
  .strict();
const respondInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      interactionId: z.string().min(1),
      kind: z.literal('approval'),
      response: approvalResponseSchema,
    })
    .strict(),
  z
    .object({
      interactionId: z.string().min(1),
      kind: z.literal('question'),
      response: z.union([questionResponseSchema, questionAnswersSchema, z.null()]),
    })
    .strict(),
]);
const lookupInputSchema = z.object({ dispatchId: z.string().min(1) }).strict();
const waitInputSchema = z
  .object({
    dispatchId: z.string().min(1).optional(),
    timeoutMs: z.number().int().nonnegative().max(600_000).optional(),
  })
  .strict();
const pageInputSchema = lookupInputSchema
  .extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).optional() })
  .strict();
const resultInputSchema = lookupInputSchema
  .extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(4).optional() })
  .strict();
const eventsInputSchema = pageInputSchema
  .extend({ detail: z.enum(['lifecycle', 'turn']).optional() })
  .strict();
const transcriptInputSchema = pageInputSchema
  .extend({ detail: z.enum(['text', 'items']).optional() })
  .strict();
const toolInputDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    description: z.string().optional(),
    language: z.literal('bash').optional(),
  }).strict(),
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
    detail: z.string().optional(),
    content: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.number().optional(),
  }).strict(),
  z.object({ kind: z.literal('search'), query: z.string(), scope: z.string().optional() }).strict(),
  z.object({ kind: z.literal('url_fetch'), url: z.string(), method: z.string().optional() }).strict(),
  z.object({
    kind: z.literal('agent_call'),
    agent_name: z.string(),
    prompt: z.string(),
    background: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal('skill_call'), skill_name: z.string(), args: z.string().optional() }).strict(),
  z.object({
    kind: z.literal('todo_list'),
    items: z.array(z.object({ title: z.string(), status: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal('task'),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
    task_kind: z.string().optional(),
  }).strict(),
  z.object({ kind: z.literal('task_stop'), task_id: z.string(), task_description: z.string() }).strict(),
  z.object({
    kind: z.literal('plan_review'),
    plan: z.string(),
    path: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string() }).strict()).optional(),
  }).strict(),
  z.object({ kind: z.literal('plan_enter') }).strict(),
  z.object({
    kind: z.literal('goal_start'),
    objective: z.string(),
    completionCriterion: z.string().optional(),
    mode: z.enum(['manual', 'yolo']),
  }).strict(),
  z.object({
    kind: z.literal('external_permission'),
    summary: z.string(),
    detail: z.unknown().optional(),
    options: z.array(z.object({
      id: z.string(),
      label: z.string(),
      kind: z.string(),
      changes: z.array(z.unknown()).optional(),
    }).strict()),
  }).strict(),
  z.object({ kind: z.literal('generic'), summary: z.string(), detail: z.unknown().optional() }).strict(),
]);
const approvalPayloadSchema = z.object({
  toolName: z.string(),
  action: z.string(),
  display: toolInputDisplaySchema,
}).strict();
const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
}).strict();
const questionItemSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  body: z.string().optional(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean().optional(),
  otherLabel: z.string().optional(),
  otherDescription: z.string().optional(),
}).strict();
const questionPayloadSchema = z.object({ questions: z.array(questionItemSchema) }).strict();
const interactionBaseSchema = z.object({
  interactionId: z.string(),
  taskName: z.string(),
  createdAt: z.number(),
});
const interactionSchema = z.discriminatedUnion('kind', [
  interactionBaseSchema.extend({ kind: z.literal('approval'), payload: approvalPayloadSchema }).strict(),
  interactionBaseSchema.extend({ kind: z.literal('question'), payload: questionPayloadSchema }).strict(),
]);
const interactionPageSchema = z
  .object({ items: z.array(interactionSchema), nextCursor: z.number().optional() })
  .strict();
const respondOutputSchema = z
  .object({ interactionId: z.string(), status: z.literal('resolved') })
  .strict();
const publicMessageSchema = z
  .object({
    messageId: z.string(),
    sourceTaskName: z.string(),
    targetTaskName: z.string(),
    content: z.string(),
    acceptedAt: z.number(),
    targetSeq: z.number(),
  })
  .strict();
const sendOutputSchema = z
  .object({
    message: publicMessageSchema,
    deduplicated: z.boolean(),
    delivery: z.enum(['queued', 'delivered']),
    payloadConflict: z.boolean(),
  })
  .strict();
const waitOutputSchema = z
  .object({
    waitStatus: z.enum(['completed', 'timed_out', 'no_items', 'interaction_pending']),
    waitedMs: z.number(),
    dispatch: externalDispatchSchema.optional(),
    completedDuringWait: z.array(externalDispatchSchema),
    interactions: z.array(interactionSchema),
  })
  .strict();
const resultOutputSchema = z
  .object({ dispatch: externalDispatchSchema, text: z.string(), nextCursor: z.number().optional() })
  .strict();
const lifecycleEventSchema = z
  .object({
    seq: z.number(),
    dispatchId: z.string(),
    type: z.enum(['queued', 'started', 'completed', 'failed', 'cancelled', 'interrupted']),
    at: z.number(),
    message: z.string().optional(),
  })
  .strict();
const normalizedExecutorContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }).strict(),
  z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string().optional() }).strict(),
  z.object({ type: z.literal('opaque'), contentType: z.string() }).strict(),
]);
const normalizedExecutorEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.delta'),
    role: z.enum(['user', 'assistant']),
    messageId: z.string().optional(),
    content: normalizedExecutorContentSchema,
  }).strict(),
  z.object({
    type: z.literal('thought.delta'),
    messageId: z.string().optional(),
    content: normalizedExecutorContentSchema,
  }).strict(),
  z.object({
    type: z.literal('tool.call'),
    toolCallId: z.string(),
    title: z.string(),
    kind: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
    content: z.array(z.unknown()).optional(),
    locations: z.array(z.unknown()).optional(),
  }).strict(),
  z.object({
    type: z.literal('tool.update'),
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.array(z.unknown()).optional(),
    locations: z.array(z.unknown()).optional(),
  }).strict(),
  z.object({ type: z.literal('plan.update'), plan: z.unknown(), unstable: z.boolean() }).strict(),
  z.object({ type: z.literal('plan.remove'), planId: z.string().optional(), unstable: z.literal(true) }).strict(),
  z.object({ type: z.literal('commands.update'), commands: z.array(z.unknown()) }).strict(),
  z.object({ type: z.literal('mode.update'), currentModeId: z.string() }).strict(),
  z.object({ type: z.literal('config.update'), configOptions: z.array(z.unknown()) }).strict(),
  z.object({ type: z.literal('session.info'), title: z.string().optional(), meta: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('usage'), used: z.number(), size: z.number(), cost: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('unknown'), updateType: z.string() }).strict(),
]);
const turnEventSchema = z
  .object({ seq: z.number(), dispatchId: z.string(), at: z.number(), event: normalizedExecutorEventSchema })
  .strict();
const eventsOutputSchema = z
  .object({
    items: z.array(z.union([lifecycleEventSchema, turnEventSchema])),
    nextCursor: z.number().optional(),
    truncated_before_seq: z.number().optional(),
  })
  .strict();
const transcriptTextItemSchema = z
  .object({ index: z.number(), role: z.enum(['user', 'assistant', 'system', 'tool']), text: z.string() })
  .strict();
const transcriptTextFrameSchema = z.object({
  kind: z.literal('text'),
  frameId: z.string(),
  role: z.enum(['assistant', 'user']),
  text: z.string(),
}).strict();
const transcriptThinkingFrameSchema = z.object({
  kind: z.literal('thinking'),
  frameId: z.string(),
  text: z.string(),
}).strict();
const transcriptToolFrameSchema = z.object({
  kind: z.literal('tool'),
  frameId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  state: z.enum(['running', 'done', 'error', 'interrupted']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  display: z.unknown().optional(),
  progress: z.unknown().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict();
const transcriptFrameSchema = z.discriminatedUnion('kind', [
  transcriptTextFrameSchema,
  transcriptThinkingFrameSchema,
  transcriptToolFrameSchema,
]);
const transcriptStepSchema = z.object({
  kind: z.literal('step'),
  stepId: z.string(),
  turnId: z.string(),
  ordinal: z.number(),
  state: z.enum(['running', 'completed', 'interrupted', 'failed']),
  frames: z.array(transcriptFrameSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: z.object({
    inputOther: z.number(),
    output: z.number(),
    inputCacheRead: z.number(),
    inputCacheCreation: z.number(),
  }).strict().optional(),
}).strict();
const bundledSkillActivationSchema = z.object({
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  skillType: z.string().optional(),
  skillPath: z.string().optional(),
  skillSource: z.enum(['project', 'user', 'extra', 'builtin']).optional(),
}).strict();
const threadRefSchema = z.object({
  hostId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
}).strict();
export const publicPromptOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), skillActivations: z.array(bundledSkillActivationSchema).optional() }).strict(),
  z.object({
    kind: z.literal('skill_activation'),
    activationId: z.string(),
    skillName: z.string(),
    skillArgs: z.string().optional(),
    trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
    skillType: z.string().optional(),
    skillPath: z.string().optional(),
    skillSource: z.enum(['project', 'user', 'extra', 'builtin']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('plugin_command'),
    activationId: z.string(),
    pluginId: z.string(),
    commandName: z.string(),
    commandArgs: z.string().optional(),
    trigger: z.literal('user-slash'),
  }).strict(),
  z.object({
    kind: z.literal('injection'),
    variant: z.string(),
    ownerPromptId: z.string().optional(),
    disclosure: z.unknown().optional(),
  }).strict(),
  z.object({ kind: z.literal('shell_command'), phase: z.enum(['input', 'output']), isError: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('compaction_summary') }).strict(),
  z.object({ kind: z.literal('system_trigger'), name: z.string() }).strict(),
  z.object({
    kind: z.literal('task'),
    taskId: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
    notificationId: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('cron_job'),
    jobId: z.string(),
    cron: z.string(),
    recurring: z.boolean(),
    coalescedCount: z.number(),
    stale: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('cron_missed'), count: z.number() }).strict(),
  z.object({ kind: z.literal('hook_result'), event: z.string(), blocked: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('retry'), trigger: z.string().optional() }).strict(),
  z.object({
    kind: z.literal('peer_thread'),
    source: threadRefSchema,
    messageId: z.string(),
    acceptedAt: z.number(),
  }).strict(),
  z.object({
    kind: z.literal('agent_message'),
    messageId: z.string(),
    senderTaskName: z.string(),
  }).strict(),
]);
const transcriptTurnSchema = z.object({
  kind: z.literal('turn'),
  turnId: z.string(),
  ordinal: z.number(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  origin: publicPromptOriginSchema,
  prompt: z.string().optional(),
  steps: z.array(transcriptStepSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: z.unknown().optional(),
}).strict();
const transcriptMarkerSchema = z.object({
  kind: z.literal('marker'),
  markerId: z.string(),
  marker: z.string(),
  payload: z.unknown().optional(),
  at: z.string().optional(),
}).strict();
const transcriptTaskRefSchema = z.object({
  kind: z.literal('taskref'),
  refId: z.string(),
  taskId: z.string(),
  at: z.string().optional(),
}).strict();
const transcriptL1ItemSchema = z.discriminatedUnion('kind', [
  transcriptTurnSchema,
  transcriptMarkerSchema,
  transcriptTaskRefSchema,
]);
const transcriptTextPageSchema = z.object({
  items: z.array(transcriptTextItemSchema),
  nextCursor: z.number().optional(),
}).strict();
const transcriptItemsPageSchema = z.object({
  items: z.array(transcriptL1ItemSchema),
  cursor: z.number(),
  nextCursor: z.number().optional(),
}).strict();
const transcriptOutputSchema = z.union([transcriptTextPageSchema, transcriptItemsPageSchema]);

const dispatchMcpInput = z
  .object({
    target: z.enum(['main', 'named']),
    task_name: taskNameSchema.optional(),
    profile_name: z.string().trim().min(1).optional(),
    model_alias: z.string().trim().min(1).optional(),
    thinking_effort: z.string().trim().min(1).optional(),
    dispatch_key: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.target === 'main' &&
      (value.task_name !== undefined ||
        value.profile_name !== undefined ||
        value.model_alias !== undefined ||
        value.thinking_effort !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Named-child fields require target named.' });
    }
  })
  .strict();
const continueMcpInput = z
  .object({
    dispatch_id: z.string().min(1),
    dispatch_key: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).max(1_000_000),
  })
  .strict();
const sendMcpInput = z
  .object({
    task_name: taskNameSchema,
    message: z.string().trim().min(1).max(1_000_000),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();
const interactionsMcpInput = z.object({ cursor: z.number().int().nonnegative().optional() }).strict();
const respondMcpInput = z.discriminatedUnion('kind', [
  z
    .object({
      interaction_id: z.string().min(1),
      kind: z.literal('approval'),
      response: z
        .object({
          decision: z.enum(['approved', 'rejected', 'cancelled']),
          scope: z.literal('session').optional(),
          feedback: z.string().optional(),
          selected_label: z.string().optional(),
          selected_option_id: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      interaction_id: z.string().min(1),
      kind: z.literal('question'),
      response: z.union([questionResponseSchema, questionAnswersSchema, z.null()]),
    })
    .strict(),
]);
const lookupMcpInput = z.object({ dispatch_id: z.string().min(1) }).strict();
const waitMcpInput = z
  .object({
    dispatch_id: z.string().min(1).optional(),
    timeout_s: z.number().int().nonnegative().max(600).optional(),
  })
  .strict();
const pageMcpInput = lookupMcpInput
  .extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() })
  .strict();
const resultMcpInput = lookupMcpInput
  .extend({ cursor: z.number().int().nonnegative().optional(), max_bytes: z.number().int().min(4).optional() })
  .strict();
const eventsMcpInput = pageMcpInput.extend({ detail: z.enum(['lifecycle', 'turn']).optional() }).strict();
const transcriptMcpInput = pageMcpInput.extend({ detail: z.enum(['text', 'items']).optional() }).strict();
const pageLegacyInput = lookupMcpInput
  .extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() })
  .strict();
const eventsLegacyInput = pageLegacyInput.extend({ detail: z.enum(['lifecycle', 'turn']).optional() }).strict();
const transcriptLegacyInput = pageLegacyInput.extend({ detail: z.enum(['text', 'items']).optional() }).strict();

const identityCodec = <T>(schema: z.ZodType<T>) => ({
  schema,
  decode: (value: T): T => value,
  encode: (value: T): unknown => value,
});
const emptyCodec = identityCodec(emptySchema);
const lookupCodec = {
  schema: lookupMcpInput,
  decode: (value: z.infer<typeof lookupMcpInput>) => ({ dispatchId: value.dispatch_id }),
  encode: (value: z.infer<typeof lookupInputSchema>) => ({ dispatch_id: value.dispatchId }),
};
const INTERACTION_PENDING_NEXT_STEP =
  'Call kiki_interactions to inspect pending requests, call kiki_respond to answer each one, then call kiki_wait again.';
const TIMED_OUT_NEXT_STEP =
  'The dispatch is still running; call kiki_wait again to keep waiting.';
const LIST_DESCRIPTION = 'List owned children and continuations.';
const PROFILES_DESCRIPTION =
  'List named agent profiles (whenToUse, models, tools). Clients may cache this catalog.';
const DISPATCH_DESCRIPTION =
  'Dispatch main-agent work or one stable named child asynchronously. task_name (named children only) must be lowercase [a-z0-9_] and must not be "root" (uppercase letters, hyphens, and other scripts are rejected). Exact model_alias and thinking_effort bindings apply only when the named child is first created.';
const WAIT_DESCRIPTION =
  'Wait for one owned dispatch or the next owned dispatch to finish or request an external interaction response. Honor the client timeout budget (Cursor ≈ 60 s → timeout_s ≤ 45).';

function randomKey(): string {
  return globalThis.crypto.randomUUID();
}

function bindingForMcp(binding: z.infer<typeof seatBindingSchema>) {
  return {
    version: binding.version,
    sessionId: binding.sessionId,
    workspacePath: binding.workspacePath,
  };
}

function dispatchReceipt(value: z.infer<typeof externalDispatchSchema>, dispatchKey: string) {
  const continueHint = value.target === 'named'
    ? `Call kiki_dispatch with task_name "${value.taskName}" and a new message to reuse this agent with its memory.`
    : `Call kiki_continue with dispatch_id "${value.dispatchId}" and a new message to continue this agent with its memory.`;
  return {
    ...value,
    dispatch_key: dispatchKey,
    receipt: {
      dispatch_id: value.dispatchId,
      dispatch_key: dispatchKey,
      task_name: value.taskName,
      actual_profile: value.actualProfile,
      status: value.status,
      next_step: `Call kiki_wait with dispatch_id "${value.dispatchId}" to block until done. If it returns interaction_pending, ${INTERACTION_PENDING_NEXT_STEP}`,
      continue_hint: continueHint,
    },
  };
}

const profiles = defineDelegationProcedure({
  name: 'profiles',
  inputSchema: emptySchema,
  outputSchema: profilesOutputSchema,
  mcp: {
    toolName: 'kiki_profiles',
    description: PROFILES_DESCRIPTION,
    input: emptyCodec,
    encodeOutput: (value) => ({ profiles: value.profiles, binding: bindingForMcp(value.binding) }),
  },
  legacy: { input: emptyCodec, encodeOutput: (value) => ({ profiles: value.profiles }) },
});
const list = defineDelegationProcedure({
  name: 'list',
  inputSchema: emptySchema,
  outputSchema: listOutputSchema,
  mcp: {
    toolName: 'kiki_list',
    description: LIST_DESCRIPTION,
    input: emptyCodec,
    encodeOutput: (value) => ({
      children: value.children,
      continuations: value.continuations,
      binding: bindingForMcp(value.binding),
    }),
  },
  legacy: {
    input: emptyCodec,
    encodeOutput: ({ binding: _binding, ...value }) => value,
  },
});
const dispatch = defineDelegationProcedure({
  name: 'dispatch',
  inputSchema: dispatchInputSchema,
  outputSchema: externalDispatchSchema,
  mcp: {
    toolName: 'kiki_dispatch',
    description: DISPATCH_DESCRIPTION,
    input: {
      schema: dispatchMcpInput,
      decode: (value) => ({
        target: value.target,
        taskName: value.task_name,
        profileName: value.profile_name,
        modelAlias: value.model_alias,
        thinkingEffort: value.thinking_effort,
        dispatchKey: value.dispatch_key ?? randomKey(),
        message: value.message,
      }),
      encode: (value) => ({
        target: value.target,
        task_name: value.taskName,
        profile_name: value.profileName,
        model_alias: value.modelAlias,
        thinking_effort: value.thinkingEffort,
        dispatch_key: value.dispatchKey,
        message: value.message,
      }),
    },
    encodeOutput: (value, input) => dispatchReceipt(value, input.dispatchKey!),
  },
  legacy: {
    input: {
      schema: dispatchMcpInput,
      decode: (value) => ({
        target: value.target,
        taskName: value.task_name,
        profileName: value.profile_name,
        modelAlias: value.model_alias,
        thinkingEffort: value.thinking_effort,
        dispatchKey: value.dispatch_key,
        message: value.message,
      }),
      encode: (value) => ({
        target: value.target,
        task_name: value.taskName,
        profile_name: value.profileName,
        model_alias: value.modelAlias,
        thinking_effort: value.thinkingEffort,
        dispatch_key: value.dispatchKey,
        message: value.message,
      }),
    },
    encodeOutput: (value) => value,
  },
});
const continuation = defineDelegationProcedure({
  name: 'continue',
  inputSchema: continueInputSchema,
  outputSchema: externalDispatchSchema,
  mcp: {
    toolName: 'kiki_continue',
    description: 'Continue an owned terminal main or named-child dispatch.',
    input: {
      schema: continueMcpInput,
      decode: (value) => ({
        dispatchId: value.dispatch_id,
        dispatchKey: value.dispatch_key ?? randomKey(),
        message: value.message,
      }),
      encode: (value) => ({
        dispatch_id: value.dispatchId,
        dispatch_key: value.dispatchKey,
        message: value.message,
      }),
    },
    encodeOutput: (value, input) => dispatchReceipt(value, input.dispatchKey!),
  },
  legacy: {
    input: {
      schema: continueMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, dispatchKey: value.dispatch_key, message: value.message }),
      encode: (value) => ({ dispatch_id: value.dispatchId, dispatch_key: value.dispatchKey, message: value.message }),
    },
    encodeOutput: (value) => value,
  },
});
const send = defineDelegationProcedure({
  name: 'send',
  inputSchema: sendInputSchema,
  outputSchema: sendOutputSchema,
  mcp: {
    toolName: 'kiki_send',
    description: 'Queue a message for an owned named child at its next run boundary.',
    input: {
      schema: sendMcpInput,
      decode: (value) => ({
        taskName: value.task_name,
        message: value.message,
        idempotencyKey: value.idempotency_key ?? randomKey(),
      }),
      encode: (value) => ({ task_name: value.taskName, message: value.message, idempotency_key: value.idempotencyKey }),
    },
    encodeOutput: (value, input) => ({ ...value, idempotency_key: input.idempotencyKey }),
  },
  legacy: {
    input: {
      schema: sendMcpInput.extend({ idempotency_key: z.string().trim().min(1) }).strict(),
      decode: (value) => ({ taskName: value.task_name, message: value.message, idempotencyKey: value.idempotency_key }),
      encode: (value) => ({ task_name: value.taskName, message: value.message, idempotency_key: value.idempotencyKey }),
    },
    encodeOutput: (value) => value,
  },
});
const interactions = defineDelegationProcedure({
  name: 'interactions',
  inputSchema: interactionsInputSchema,
  outputSchema: interactionPageSchema,
  mcp: {
    toolName: 'kiki_interactions',
    description: 'List pending approvals and questions from owned children for external answering with kiki_respond.',
    input: identityCodec(interactionsMcpInput),
    encodeOutput: (value) => value,
  },
  legacy: { input: identityCodec(interactionsMcpInput), encodeOutput: (value) => value },
});
const respond = defineDelegationProcedure({
  name: 'respond',
  inputSchema: respondInputSchema,
  outputSchema: respondOutputSchema,
  mcp: {
    toolName: 'kiki_respond',
    description: 'Answer an owned child approval or question on behalf of the external caller.',
    input: {
      schema: respondMcpInput,
      decode: (value) => value.kind === 'approval'
        ? {
            interactionId: value.interaction_id,
            kind: value.kind,
            response: {
              decision: value.response.decision,
              scope: value.response.scope,
              feedback: value.response.feedback,
              selectedLabel: value.response.selected_label,
              selectedOptionId: value.response.selected_option_id,
            },
          }
        : { interactionId: value.interaction_id, kind: value.kind, response: value.response },
      encode: (value) => value.kind === 'approval'
        ? {
            interaction_id: value.interactionId,
            kind: value.kind,
            response: {
              decision: value.response.decision,
              scope: value.response.scope,
              feedback: value.response.feedback,
              selected_label: value.response.selectedLabel,
              selected_option_id: value.response.selectedOptionId,
            },
          }
        : { interaction_id: value.interactionId, kind: value.kind, response: value.response },
    },
    encodeOutput: (value) => value,
  },
  legacy: {
    input: {
      schema: respondMcpInput,
      decode: (value) => value.kind === 'approval'
        ? {
            interactionId: value.interaction_id,
            kind: value.kind,
            response: {
              decision: value.response.decision,
              scope: value.response.scope,
              feedback: value.response.feedback,
              selectedLabel: value.response.selected_label,
              selectedOptionId: value.response.selected_option_id,
            },
          }
        : { interactionId: value.interaction_id, kind: value.kind, response: value.response },
      encode: (value) => value.kind === 'approval'
        ? {
            interaction_id: value.interactionId,
            kind: value.kind,
            response: {
              decision: value.response.decision,
              scope: value.response.scope,
              feedback: value.response.feedback,
              selected_label: value.response.selectedLabel,
              selected_option_id: value.response.selectedOptionId,
            },
          }
        : { interaction_id: value.interactionId, kind: value.kind, response: value.response },
    },
    encodeOutput: (value) => value,
  },
});
const status = defineDelegationProcedure({
  name: 'status',
  inputSchema: lookupInputSchema,
  outputSchema: externalDispatchSchema,
  mcp: { toolName: 'kiki_status', description: 'Read status for an owned dispatch handle.', input: lookupCodec, encodeOutput: (value) => value },
  legacy: { input: lookupCodec, encodeOutput: (value) => value },
});
const wait = defineDelegationProcedure({
  name: 'wait',
  inputSchema: waitInputSchema,
  outputSchema: waitOutputSchema,
  mcp: {
    toolName: 'kiki_wait',
    description: WAIT_DESCRIPTION,
    input: {
      schema: waitMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, timeoutMs: value.timeout_s === undefined ? undefined : value.timeout_s * 1_000 }),
      encode: (value) => ({ dispatch_id: value.dispatchId, timeout_s: value.timeoutMs === undefined ? undefined : value.timeoutMs / 1_000 }),
    },
    encodeOutput: (value) => value.waitStatus === 'interaction_pending'
      ? { ...value, next_step: INTERACTION_PENDING_NEXT_STEP }
      : value.waitStatus === 'timed_out'
        ? { ...value, next_step: value.dispatch === undefined
            ? TIMED_OUT_NEXT_STEP
            : `The dispatch is still running; call kiki_wait with dispatch_id "${value.dispatch.dispatchId}" to keep waiting.` }
        : value,
  },
  legacy: {
    input: {
      schema: waitMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, timeoutMs: value.timeout_s === undefined ? undefined : value.timeout_s * 1_000 }),
      encode: (value) => ({ dispatch_id: value.dispatchId, timeout_s: value.timeoutMs === undefined ? undefined : value.timeoutMs / 1_000 }),
    },
    encodeOutput: (value) => value,
  },
});
const result = defineDelegationProcedure({
  name: 'result',
  inputSchema: resultInputSchema,
  outputSchema: resultOutputSchema,
  mcp: {
    toolName: 'kiki_result',
    description: 'Read a UTF-8-bounded result page for an owned dispatch.',
    input: {
      schema: resultMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: Math.min(value.max_bytes ?? 65_536, 65_536) }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, max_bytes: value.limit }),
    },
    encodeOutput: (value) => value,
  },
  legacy: {
    input: {
      schema: lookupMcpInput.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(4).optional() }).strict(),
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: value.limit }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, limit: value.limit }),
    },
    encodeOutput: (value) => value,
  },
});
const events = defineDelegationProcedure({
  name: 'events',
  inputSchema: eventsInputSchema,
  outputSchema: eventsOutputSchema,
  mcp: {
    toolName: 'kiki_events',
    description: 'Read lifecycle or turn-detail events for an owned dispatch.',
    input: {
      schema: eventsMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: value.limit, detail: value.detail }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, limit: value.limit, detail: value.detail }),
    },
    encodeOutput: (value) => value,
  },
  legacy: {
    input: {
      schema: eventsLegacyInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: value.limit, detail: value.detail }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, limit: value.limit, detail: value.detail }),
    },
    encodeOutput: (value) => value,
  },
});
const transcript = defineDelegationProcedure({
  name: 'transcript',
  inputSchema: transcriptInputSchema,
  outputSchema: transcriptOutputSchema,
  mcp: {
    toolName: 'kiki_transcript',
    description: 'Read text or structured transcript items for an owned dispatch.',
    input: {
      schema: transcriptMcpInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: value.limit, detail: value.detail }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, limit: value.limit, detail: value.detail }),
    },
    encodeOutput: (value) => value,
  },
  legacy: {
    input: {
      schema: transcriptLegacyInput,
      decode: (value) => ({ dispatchId: value.dispatch_id, cursor: value.cursor, limit: value.limit, detail: value.detail }),
      encode: (value) => ({ dispatch_id: value.dispatchId, cursor: value.cursor, limit: value.limit, detail: value.detail }),
    },
    encodeOutput: (value) => value,
  },
});
const cancel = defineDelegationProcedure({
  name: 'cancel',
  inputSchema: lookupInputSchema,
  outputSchema: externalDispatchSchema,
  mcp: { toolName: 'kiki_cancel', description: 'Idempotently cancel an owned active dispatch.', input: lookupCodec, encodeOutput: (value) => value },
  legacy: { input: lookupCodec, encodeOutput: (value) => value },
});

export const delegationProcedureTable = [
  profiles,
  list,
  dispatch,
  continuation,
  send,
  interactions,
  respond,
  status,
  wait,
  result,
  events,
  transcript,
  cancel,
] as const;

export type DelegationProcedureTable = typeof delegationProcedureTable;
export interface DelegationProcedureInputs {
  readonly profiles: z.infer<typeof emptySchema>;
  readonly list: z.infer<typeof emptySchema>;
  readonly dispatch: z.infer<typeof dispatchInputSchema>;
  readonly continue: z.infer<typeof continueInputSchema>;
  readonly send: z.infer<typeof sendInputSchema>;
  readonly interactions: z.infer<typeof interactionsInputSchema>;
  readonly respond: z.infer<typeof respondInputSchema>;
  readonly status: z.infer<typeof lookupInputSchema>;
  readonly wait: z.infer<typeof waitInputSchema>;
  readonly result: z.infer<typeof resultInputSchema>;
  readonly events: z.infer<typeof eventsInputSchema>;
  readonly transcript: z.infer<typeof transcriptInputSchema>;
  readonly cancel: z.infer<typeof lookupInputSchema>;
}
export interface DelegationProcedureOutputs {
  readonly profiles: z.infer<typeof profilesOutputSchema>;
  readonly list: z.infer<typeof listOutputSchema>;
  readonly dispatch: z.infer<typeof externalDispatchSchema>;
  readonly continue: z.infer<typeof externalDispatchSchema>;
  readonly send: z.infer<typeof sendOutputSchema>;
  readonly interactions: z.infer<typeof interactionPageSchema>;
  readonly respond: z.infer<typeof respondOutputSchema>;
  readonly status: z.infer<typeof externalDispatchSchema>;
  readonly wait: z.infer<typeof waitOutputSchema>;
  readonly result: z.infer<typeof resultOutputSchema>;
  readonly events: z.infer<typeof eventsOutputSchema>;
  readonly transcript: z.infer<typeof transcriptOutputSchema>;
  readonly cancel: z.infer<typeof externalDispatchSchema>;
}
export type DelegationProcedureName = keyof DelegationProcedureInputs;
export type DelegationProcedureInput<Name extends DelegationProcedureName> = DelegationProcedureInputs[Name];
export type DelegationProcedureOutput<Name extends DelegationProcedureName> = DelegationProcedureOutputs[Name];

export function delegationProcedure<Name extends DelegationProcedureName>(
  name: Name,
): Extract<DelegationProcedureTable[number], { name: Name }> {
  return delegationProcedureTable.find((procedure) => procedure.name === name) as Extract<
    DelegationProcedureTable[number],
    { name: Name }
  >;
}
