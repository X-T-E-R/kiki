import { z } from 'zod';

export const turnIdSchema = z.string().min(1);
export const stepIdSchema = z.string().min(1);
export const frameIdSchema = z.string().min(1);
export const taskIdSchema = z.string().min(1);
export const agentIdSchema = z.string().min(1);

export const transcriptProvenanceSchema = z.object({
  source: z.enum(['engine', 'legacy-wire']),
  recordOrdinal: z.number().int().nonnegative().optional(),
  partOrdinal: z.number().int().nonnegative().optional(),
});

export const transcriptLineageSchema = z.object({
  replacesMessageId: z.string().optional(),
  parentMessageId: z.string().optional(),
  rewriteId: z.string().optional(),
});

export const transcriptMessageIdentitySchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  revision: z.number().int().nonnegative(),
  provenance: transcriptProvenanceSchema,
  lineage: transcriptLineageSchema.optional(),
});

export const transcriptPartIdentitySchema = z.object({
  partId: z.string().min(1),
  messageId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  provenance: transcriptProvenanceSchema,
});

export const transcriptAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), turnId: turnIdSchema }),
  z.object({ kind: z.literal('step'), turnId: turnIdSchema, stepId: stepIdSchema }),
  z.object({
    kind: z.literal('frame'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frameId: frameIdSchema,
  }),
  z.object({ kind: z.literal('tool_call'), toolCallId: z.string().min(1) }),
]);

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Whether an agent id is a single plain name. Ids are joined into filesystem
 * paths server-side (`<sessionDir>/agents/<agentId>/`), so anything
 * path-hostile must be rejected before it can escape the agents directory
 * or crash the read.
 */
export function isPlainAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId) && agentId !== '.' && agentId !== '..';
}

export const turnOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), payload: z.unknown().optional() }),
  z.object({
    kind: z.literal('cron'),
    taskId: taskIdSchema.optional(),
    payload: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('task'), taskId: taskIdSchema, payload: z.unknown().optional() }),
  z.object({ kind: z.literal('hook'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('compaction'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('side'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('other'), payload: z.unknown().optional() }),
]);

export const transcriptUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  cost: z.number().optional(),
});

export const transcriptTurnExecutionSchema = z.object({
  executorId: z.string(),
  protocol: z.string(),
  resumeMode: z.enum(['live', 'resume', 'load', 'new', 'handoff']),
  profileDelivery: z.enum(['native', 'first_prompt_preamble']),
  fidelity: z.enum(['full', 'degraded']),
  losses: z.array(z.string()).readonly(),
});

/** Step token usage — the engine's `TokenUsage` wire shape, verbatim. */
export const stepUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

export const stepTimingSchema = z.object({
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
});

export const stepRetrySchema = z.object({
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
});

export const turnStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const stepStateSchema = z.enum(['running', 'completed', 'interrupted', 'failed']);

export const messageDeliverySchema = z.object({
  deliveryId: z.string(),
  messageId: z.string(),
  turnId: turnIdSchema.optional(),
  stepId: stepIdSchema.optional(),
  step: z.number().int().nonnegative().optional(),
  deliveredAt: z.string().optional(),
  origin: z.enum(['user', 'queue', 'mailbox', 'recovery', 'injection']),
});

export const textFrameSchema = z.object({
  kind: z.literal('text'),
  delivery: messageDeliverySchema.optional(),
  frameId: frameIdSchema,
  part: transcriptPartIdentitySchema.optional(),
  role: z.enum(['assistant', 'user']),
  text: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  taskId: taskIdSchema.optional(),
  origin: z.unknown().optional(),
});

export const thinkingFrameSchema = z.object({
  kind: z.literal('thinking'),
  frameId: frameIdSchema,
  part: transcriptPartIdentitySchema.optional(),
  text: z.string(),
});

export const agentRefSchema = z.object({
  agentId: agentIdSchema,
  role: z.enum(['child', 'member']).optional(),
});

export const toolFrameProgressSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
});

export const toolCallFrameSchema = z.object({
  kind: z.literal('tool'),
  frameId: frameIdSchema,
  part: transcriptPartIdentitySchema.optional(),
  toolCallId: z.string(),
  name: z.string(),
  view: z.string().optional(),
  state: z.enum(['running', 'done', 'error', 'interrupted']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  display: z.unknown().optional(),
  error: z.string().optional(),
  inputText: z.string().optional(),
  progress: toolFrameProgressSchema.optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  taskId: taskIdSchema.optional(),
  approvalId: z.string().optional(),
  todoId: z.string().optional(),
  agentRefs: z.array(agentRefSchema).optional(),
});

export const interactionSchema = z.object({
  interactionId: z.string(),
  interactionKind: z.enum(['approval', 'question']),
  toolCallId: z.string().optional(),
  origin: z.unknown().optional(),
  anchor: transcriptAnchorSchema.optional(),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'answered', 'dismissed']),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
});

export const noticeFrameSchema = z.object({
  kind: z.literal('notice'),
  frameId: frameIdSchema,
  part: transcriptPartIdentitySchema.optional(),
  level: z.enum(['error', 'warning', 'info']),
  source: z.string().optional(),
  message: z.string(),
  detail: z.unknown().optional(),
});

export const transcriptFrameSchema = z.discriminatedUnion('kind', [
  textFrameSchema,
  thinkingFrameSchema,
  toolCallFrameSchema,
  noticeFrameSchema,
]);

export const transcriptStepSchema = z.object({
  kind: z.literal('step'),
  stepId: stepIdSchema,
  turnId: turnIdSchema,
  ordinal: z.number().int(),
  state: stepStateSchema,
  frames: z.array(transcriptFrameSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: stepUsageSchema.optional(),
  finishReason: z.string().optional(),
  timing: stepTimingSchema.optional(),
  retry: stepRetrySchema.optional(),
  endReason: z.string().optional(),
  endMessage: z.string().optional(),
});

export const transcriptTurnSchema = z.object({
  kind: z.literal('turn'),
  turnId: turnIdSchema,
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  message: transcriptMessageIdentitySchema.optional(),
  delivery: messageDeliverySchema.optional(),
  prompt: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  steps: z.array(transcriptStepSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: transcriptUsageSchema.optional(),
  execution: transcriptTurnExecutionSchema.optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

export const transcriptMarkerSchema = z.object({
  kind: z.literal('marker'),
  markerId: z.string(),
  marker: z.string(),
  payload: z.unknown().optional(),
  at: z.string().optional(),
});

export const transcriptTaskRefSchema = z.object({
  kind: z.literal('taskref'),
  refId: z.string(),
  taskId: taskIdSchema,
  at: z.string().optional(),
});

export const transcriptItemSchema = z.discriminatedUnion('kind', [
  transcriptTurnSchema,
  transcriptMarkerSchema,
  transcriptTaskRefSchema,
]);

export const transcriptTaskSchema = z.object({
  taskId: taskIdSchema,
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  lifetime: z.enum(['finite', 'service']).optional(),
  ownerAgentId: agentIdSchema.optional(),
  ownerTurnId: z.number().int().nonnegative().optional(),
  goalId: z.string().optional(),
  name: z.string().optional(),
  subagentName: z.string().optional(),
  description: z.string().optional(),
  agentId: agentIdSchema.optional(),
  outputTail: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  stateReason: z.string().optional(),
  usage: stepUsageSchema.optional(),
});

export const goalMetaSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completionCriterion: z.string().optional(),
  followUpTiming: z.enum(['subagents_done', 'tasks_done']).optional(),
  controlRevision: z.number().int().nonnegative().optional(),
  budgetUsed: z.number().optional(),
  budgetLimit: z.number().optional(),
});

export const modesMetaSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional(), version: z.number().optional() }).optional(),
  swarm: z.object({ trigger: z.string().optional() }).optional(),
});

/** `meta.merge` contract shape: a mode key set to `null` clears that badge. */
export const modesMetaMergeSchema = z.object({
  plan: z
    .object({ reviewPath: z.string().optional(), version: z.number().optional() })
    .nullable()
    .optional(),
  swarm: z.object({ trigger: z.string().optional() }).nullable().optional(),
});

/** Same shape as the wire `agentPhaseSchema`, re-declared (this package must not import the server). */
export const agentPhaseMetaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('running'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('streaming'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    stream: z.enum(['assistant', 'thinking', 'tool_call']),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    turnId: z.number(),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('retrying'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    failedAttempt: z.number(),
    nextAttempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorName: z.string().optional(),
    statusCode: z.number().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turnId: z.number(),
    step: z.number().optional(),
    approval: z.unknown().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('interrupted'),
    turnId: z.number(),
    step: z.number().optional(),
    reason: z.enum(['aborted', 'max_steps', 'error']),
    message: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('ended'),
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    durationMs: z.number().optional(),
    at: z.number(),
  }),
]);

export const agentUsageMetaSchema = z.object({
  byModel: z.record(z.string(), stepUsageSchema).optional(),
  currentTurn: stepUsageSchema.optional(),
  total: stepUsageSchema.optional(),
});

export const agentStatusMetaSchema = z.object({
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  usage: agentUsageMetaSchema.optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  permission: z.enum(['manual', 'yolo', 'auto']).optional(),
  phase: agentPhaseMetaSchema.optional(),
});

export const promptQueueHoldMetaSchema = z.object({
  reason: z.literal('recovery'),
  count: z.number().int().nonnegative(),
});

export const transcriptMetaSchema = z.object({
  goal: goalMetaSchema.optional(),
  modes: modesMetaSchema.optional(),
  activity: z.enum(['idle', 'turn', 'disposing', 'unknown']).optional(),
  agent: agentStatusMetaSchema.optional(),
  promptQueueHold: promptQueueHoldMetaSchema.optional(),
});

/** Clearable fields set to `null` in a merge are removed from the materialized meta. */
export const transcriptMetaMergeSchema = transcriptMetaSchema.extend({
  goal: goalMetaSchema.nullable().optional(),
  modes: modesMetaMergeSchema.optional(),
  promptQueueHold: promptQueueHoldMetaSchema.nullable().optional(),
});

export const attachmentSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('url'), url: z.string() }),
      z.object({ kind: z.literal('file'), fileId: z.string() }),
      z.object({ kind: z.literal('session_media'), fileId: z.string() }),
    ])
    .optional(),
  owner: transcriptAnchorSchema.optional(),
  placeholder: z.string().optional(),
});

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const todoSchema = z.object({
  todoId: z.string(),
  items: z.array(todoItemSchema),
  updatedAt: z.string().optional(),
});

export const transcriptPromptSchema = z.object({
  promptId: z.string(),
  status: z.enum(['running', 'queued', 'blocked', 'completed', 'failed', 'aborted']),
  userMessageId: z.string().optional(),
  content: z.unknown().optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  queuePosition: z.number().int().nonnegative().optional(),
  abortedBeforeStart: z.boolean().optional(),
  steeredAt: z.string().optional(),
  appendTiming: z.enum(['agent_idle', 'subagents_done', 'tasks_done']).optional(),
  revision: z.number().int().nonnegative().optional(),
});

export const agentTranscriptSnapshotSchema = z.object({
  items: z.array(transcriptItemSchema),
  tasks: z.array(transcriptTaskSchema),
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  prompts: z.array(transcriptPromptSchema).default([]),
  toolCallCount: z.number().int().nonnegative().optional(),
  toolCallCountKnown: z.boolean().optional(),
  meta: transcriptMetaSchema,
  hasMoreOlder: z.boolean().optional(),
});

export const turnHeaderSchema = transcriptTurnSchema.omit({ steps: true });
export const stepHeaderSchema = transcriptStepSchema.omit({ frames: true });

export const appendTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('frame'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frameId: frameIdSchema,
  }),
  z.object({ type: z.literal('task'), taskId: taskIdSchema }),
]);

export const transcriptOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('reset'),
    agentId: agentIdSchema,
    snapshot: agentTranscriptSnapshotSchema,
    grade: z.enum(['turn', 'block', 'delta']).optional(),
    coverage: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('full'), hasMoreOlder: z.literal(false) }),
        z.object({
          kind: z.literal('tail'),
          fromTurnId: turnIdSchema.optional(),
          throughTurnId: turnIdSchema.optional(),
          hasMoreOlder: z.boolean(),
        }),
      ])
      .optional(),
  }),
  z.object({ op: z.literal('turn.upsert'), turn: turnHeaderSchema }),
  z.object({ op: z.literal('step.upsert'), turnId: turnIdSchema, step: stepHeaderSchema }),
  z.object({
    op: z.literal('frame.upsert'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frame: transcriptFrameSchema,
  }),
  z.object({
    op: z.literal('tool.count.set'),
    count: z.number().int().nonnegative().optional(),
  }),
  z.object({
    op: z.literal('append'),
    target: appendTargetSchema,
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    op: z.literal('marker.upsert'),
    item: transcriptMarkerSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({
    op: z.literal('taskref.upsert'),
    item: transcriptTaskRefSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({ op: z.literal('task.upsert'), task: transcriptTaskSchema }),
  z.object({ op: z.literal('interaction.upsert'), interaction: interactionSchema }),
  z.object({ op: z.literal('attachment.upsert'), attachment: attachmentSchema }),
  z.object({ op: z.literal('todo.upsert'), todo: todoSchema }),
  z.object({ op: z.literal('prompt.upsert'), prompt: transcriptPromptSchema }),
  z.object({ op: z.literal('meta.merge'), meta: transcriptMetaMergeSchema }),
  z.object({ op: z.literal('items.remove'), ids: z.array(z.string()) }),
]);

export const transcriptOpBatchSchema = z.object({
  agentId: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
});

export const transcriptGradeSchema = z.enum(['off', 'turn', 'block', 'delta']);

export const transcriptSeqSchema = z.number().int().nonnegative();

export const transcriptCursorSchema = z.object({
  epoch: z.string().min(1).optional(),
  seq: transcriptSeqSchema,
});

export const transcriptCoverageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full'), hasMoreOlder: z.literal(false) }),
  z.object({
    kind: z.literal('tail'),
    fromTurnId: turnIdSchema.optional(),
    throughTurnId: turnIdSchema.optional(),
    hasMoreOlder: z.boolean(),
  }),
]);

const transcriptCursorInputSchema = z.preprocess(
  (value) => (typeof value === 'number' ? { epoch: undefined, seq: value } : value),
  transcriptCursorSchema,
);

export const transcriptGradeSpecSchema = z.record(z.string(), transcriptGradeSchema);

export const transcriptSubscribeV2PayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript: transcriptGradeSpecSchema,
  transcript_since: z.record(z.string(), transcriptCursorInputSchema).optional(),
});

export type TranscriptSubscribeV2Payload = z.infer<typeof transcriptSubscribeV2PayloadSchema>;

export const transcriptOpsQuerySchema = z
  .object({
    agent_id: agentIdSchema,
    epoch: z.string().min(1).optional(),
    since_seq: z.coerce.number().int().min(0),
    grade: z.enum(['turn', 'block', 'delta']).default('delta'),
  })
  .superRefine((value, ctx) => {
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
      });
    }
  });

/**
 * `GET /v1/sessions/{session_id}/transcript` contract shape, owned by this
 * package: `agent_id` (required) + turn cursor (`before_turn` / `after_turn`,
 * mutually exclusive) + `page_size` (default 20, max 100). The page unit is
 * the turn (contiguous turn slice plus segment markers/taskrefs); `tasks`,
 * `interactions`, `meta`, `agents` and `pending_interactions` are global
 * state and ship unpaginated with every response.
 */
export const transcriptQuerySchema = z
  .object({
    agent_id: agentIdSchema,
    before_turn: z.string().min(1).optional(),
    after_turn: z.string().min(1).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_turn !== undefined && value.after_turn !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_turn and after_turn are mutually exclusive',
        path: ['before_turn'],
      });
    }
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
      });
    }
  });

export const agentDescriptorSchema = z.object({
  agentId: agentIdSchema,
  type: z.enum(['main', 'sub', 'independent']).optional(),
  parentAgentId: agentIdSchema.optional(),
  delegator: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('agent'), agentId: agentIdSchema }),
      z.object({ kind: z.literal('external'), delegationId: z.string().min(1) }),
    ])
    .optional(),
  label: z.string().optional(),
  createdAt: z.string().optional(),
  disposedAt: z.string().optional(),
});

export const transcriptResponseSchema = z.object({
  session_id: z.string().min(1),
  agent_id: agentIdSchema,
  items: z.array(transcriptItemSchema),
  has_more: z.boolean(),
  tool_call_count: z.number().int().nonnegative().optional(),
  tasks: z.array(transcriptTaskSchema),
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  prompts: z.array(transcriptPromptSchema).default([]),
  meta: transcriptMetaSchema,
  agents: z.array(agentDescriptorSchema),
  pending_interactions: z.array(z.string()),
  cursor: transcriptCursorSchema.optional(),
  coverage: transcriptCoverageSchema,
});
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export const transcriptOpsCatchupResponseSchema = z.object({
  session_id: z.string().min(1),
  agent_id: agentIdSchema,
  epoch: z.string().min(1),
  batches: z.array(
    z.object({
      seq: transcriptSeqSchema,
      ops: z.array(transcriptOperationSchema),
    }),
  ),
  through_seq: transcriptSeqSchema,
  complete: z.boolean(),
});
export type TranscriptOpsCatchupResponse = z.infer<typeof transcriptOpsCatchupResponseSchema>;

/**
 * One turn-opening input, projected out of a transcript for the
 * user-messages read: every turn whose `prompt` is defined (real user text,
 * user-slash skill/plugin commands, cron prompts, …). `origin` stays on the
 * entry so the caller can tell those kinds apart.
 */
export const transcriptUserMessageSchema = z.object({
  turn_id: turnIdSchema,
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  prompt: z.string(),
  attachment_ids: z.array(z.string()).optional(),
  started_at: z.string().optional(),
});

/**
 * `GET /v1/sessions/{session_id}/transcript/user-messages` contract shape:
 * per-agent user messages (agents are separate transcripts — user input is
 * each agent's own). `agent_id` optional on the query: present reads one
 * agent, absent reads every rostered agent. `attachments` carries the
 * entities referenced by the listed messages (metadata only, never bytes).
 */
export const transcriptUserMessagesResponseSchema = z.object({
  agents: z.array(
    z.object({
      agent_id: agentIdSchema,
      messages: z.array(transcriptUserMessageSchema),
      attachments: z.array(attachmentSchema).default([]),
    }),
  ),
});

/**
 * The review round-trip of one ExitPlanMode call, projected from the linked
 * approval interaction. Absent when the call never went through an
 * interactive review (auto permission mode, or a configured allow rule).
 */
export const transcriptPlanReviewSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  selected_option: z.string().optional(),
  feedback: z.string().optional(),
});

/**
 * One ExitPlanMode call's plan information. `source` records which fact the
 * content was projected from — the linked approval interaction's `request`
 * display (interactive review), the live tool frame's display (auto mode),
 * or the tool result output text (cold rebuilds without an interaction).
 */
export const transcriptPlanEntrySchema = z.object({
  tool_call_id: z.string(),
  turn_id: turnIdSchema,
  source: z.enum(['interaction', 'display', 'output']),
  plan: z.string(),
  path: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .optional(),
  review: transcriptPlanReviewSchema.optional(),
});

/**
 * `GET /v1/sessions/{session_id}/transcript/plan` contract shape: the plans
 * of one agent's ExitPlanMode calls, in timeline order. `tool_call_id`
 * optional on the query: present narrows the read to that one call (unknown
 * id → 40416), absent lists every call with recoverable plan content.
 */
export const transcriptPlanResponseSchema = z.object({
  agent_id: agentIdSchema,
  plans: z.array(transcriptPlanEntrySchema),
});

export const transcriptResetPayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_id: agentIdSchema,
  snapshot: agentTranscriptSnapshotSchema,
  grade: z.enum(['turn', 'block', 'delta']),
  coverage: transcriptCoverageSchema,
  cursor: transcriptCursorSchema,
});

export const transcriptOpsPayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_id: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
  cursor: transcriptCursorSchema,
  through_seq: transcriptSeqSchema,
});
