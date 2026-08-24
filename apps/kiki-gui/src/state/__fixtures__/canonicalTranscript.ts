import type { AgentTranscriptSnapshot, TranscriptEvent, TranscriptOperation } from '@moonshot-ai/transcript';

export const FIXED_AT = '2026-01-01T00:00:00.000Z';
export const FIXED_AT_1 = '2026-01-01T00:00:01.000Z';
export const FIXED_AT_2 = '2026-01-01T00:00:02.000Z';
export const SESSION_A = 'session_canonical_a';
export const SESSION_B = 'session_canonical_b';
export const USER_MESSAGE_ID = 'um-canonical-1';
export const PROMPT_ID = 'p-canonical-1';
export const ASSISTANT_FRAME_ID = 'asst-t1-t1.1';
export const TOOL_CALL_ID = 'tc-agent-research';
export const CHILD_AGENT_ID = 'agent-research';
export const NESTED_AGENT_ID = 'agent-nested';
export const ATTACHMENT_ID = 'att-canonical-1';

export function emptySnapshot(
  overrides: Partial<AgentTranscriptSnapshot> = {},
): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    ...overrides,
  };
}

export function resetEvent(
  agentId: string,
  snapshot: AgentTranscriptSnapshot,
  seq: number,
  hasMoreOlder = false,
  sessionId = 'session_test',
): TranscriptEvent {
  return {
    type: 'transcript.reset',
    session_id: sessionId,
    agent_id: agentId,
    snapshot: { ...snapshot, hasMoreOlder },
    grade: 'delta',
    coverage: hasMoreOlder
      ? { kind: 'tail', hasMoreOlder: true }
      : { kind: 'full', hasMoreOlder: false },
    cursor: { seq, epoch: 'epoch-canonical' },
  };
}

export function opsEvent(
  agentId: string,
  ops: readonly TranscriptOperation[],
  seq: number,
  sessionId = 'session_test',
): TranscriptEvent {
  return {
    type: 'transcript.ops',
    session_id: sessionId,
    agent_id: agentId,
    ops,
    cursor: { seq, epoch: 'epoch-canonical' },
    through_seq: seq,
  };
}

export function userTurnSnapshot(options: {
  readonly prompt?: string;
  readonly userMessageId?: string;
  readonly promptId?: string;
  readonly assistantText?: string;
  readonly streaming?: boolean;
  readonly attachmentIds?: readonly string[];
} = {}): AgentTranscriptSnapshot {
  const turnId = 't1';
  const stepId = 't1.1';
  const prompt = options.prompt ?? 'canonical user prompt';
  return emptySnapshot({
    items: [
      {
        kind: 'turn',
        turnId,
        ordinal: 1,
        state: options.streaming === true ? 'running' : 'completed',
        origin: {
          kind: 'user',
          payload: {
            promptId: options.promptId ?? PROMPT_ID,
            userMessageId: options.userMessageId ?? USER_MESSAGE_ID,
          },
        },
        prompt,
        attachmentIds: options.attachmentIds === undefined ? undefined : [...options.attachmentIds],
        startedAt: FIXED_AT,
        endedAt: options.streaming === true ? undefined : FIXED_AT_2,
        durationMs: options.streaming === true ? undefined : 1800,
        usage: options.streaming === true ? undefined : { inputTokens: 12, outputTokens: 34, cost: 0.01 },
        steps: [
          {
            kind: 'step',
            stepId,
            turnId,
            ordinal: 1,
            state: options.streaming === true ? 'running' : 'completed',
            startedAt: FIXED_AT,
            endedAt: options.streaming === true ? undefined : FIXED_AT_2,
            usage:
              options.streaming === true
                ? undefined
                : { inputOther: 12, output: 34, inputCacheRead: 0, inputCacheCreation: 0 },
            timing:
              options.streaming === true
                ? undefined
                : { llmFirstTokenLatencyMs: 120, llmStreamDurationMs: 400 },
            frames: [
              {
                kind: 'text',
                frameId: ASSISTANT_FRAME_ID,
                role: 'assistant',
                text: options.assistantText ?? 'canonical assistant reply',
                attachmentIds: options.attachmentIds === undefined ? undefined : [...options.attachmentIds],
                part: {
                  partId: 'part-asst-canonical',
                  messageId: 'msg-asst-canonical',
                  revision: 1,
                  provenance: { source: 'engine' },
                },
              },
            ],
          },
        ],
      },
    ],
    prompts: [
      {
        promptId: options.promptId ?? PROMPT_ID,
        status: options.streaming === true ? 'running' : 'completed',
        userMessageId: options.userMessageId ?? USER_MESSAGE_ID,
        content: [{ type: 'text', text: prompt }],
        createdAt: FIXED_AT,
        finishedAt: options.streaming === true ? undefined : FIXED_AT_2,
      },
    ],
    meta: {
      activity: options.streaming === true ? 'turn' : 'idle',
      agent: {
        phase:
          options.streaming === true
            ? {
                kind: 'streaming',
                turnId: 1,
                step: 1,
                stepId,
                stream: 'assistant',
                since: 0,
              }
            : { kind: 'idle' },
      },
    },
  });
}

export function spawnChildOps(): readonly TranscriptOperation[] {
  return [
    {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool',
        frameId: `tool-${TOOL_CALL_ID}`,
        toolCallId: TOOL_CALL_ID,
        name: 'Agent',
        state: 'running',
        input: { description: 'Inspect the protocol', instruction: 'Map every event.' },
        agentRefs: [{ agentId: CHILD_AGENT_ID, role: 'child' }],
      },
    },
    {
      op: 'task.upsert',
      task: {
        taskId: `task-${CHILD_AGENT_ID}`,
        kind: 'subagent',
        state: 'running',
        detached: false,
        description: 'Inspect the protocol',
        agentId: CHILD_AGENT_ID,
        outputTail: '',
        startedAt: FIXED_AT_1,
      },
    },
    {
      op: 'taskref.upsert',
      item: { kind: 'taskref', refId: `ref-${CHILD_AGENT_ID}`, taskId: `task-${CHILD_AGENT_ID}`, at: FIXED_AT_1 },
    },
  ];
}

export function childResetSnapshot(): AgentTranscriptSnapshot {
  return emptySnapshot({
    items: [
      {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user', payload: { promptId: 'p-child', userMessageId: 'um-child' } },
        prompt: 'Map every event.',
        startedAt: FIXED_AT_1,
        steps: [
          {
            kind: 'step',
            stepId: 't1.1',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            frames: [{ kind: 'text', frameId: 'child-asst', role: 'assistant', text: 'child working' }],
          },
        ],
      },
    ],
    tasks: [
      {
        taskId: `task-${NESTED_AGENT_ID}`,
        kind: 'subagent',
        state: 'running',
        detached: false,
        description: 'nested reviewer',
        agentId: NESTED_AGENT_ID,
        outputTail: '',
        startedAt: FIXED_AT_1,
      },
    ],
    meta: {
      agent: {
        model: 'fixture/kiki-pro',
        thinkingEffort: 'high',
        phase: { kind: 'streaming', turnId: 1, step: 1, stepId: 't1.1', stream: 'assistant', since: 0 },
      },
    },
  });
}

export function capabilityMatrixSnapshot(): AgentTranscriptSnapshot {
  return emptySnapshot({
    items: [
      {
        kind: 'marker',
        markerId: 'plan-1',
        marker: 'plan.revision',
        payload: { version: 2, path: 'agents/main/plan/p1/v2.md' },
        at: FIXED_AT,
      },
      {
        kind: 'marker',
        markerId: 'swarm-1',
        marker: 'swarm',
        payload: { trigger: 'release' },
        at: FIXED_AT,
      },
      {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user', payload: { promptId: PROMPT_ID, userMessageId: USER_MESSAGE_ID } },
        prompt: 'canonical user prompt',
        attachmentIds: [ATTACHMENT_ID],
        startedAt: FIXED_AT,
        endedAt: FIXED_AT_2,
        durationMs: 1800,
        usage: { inputTokens: 12, outputTokens: 34 },
        steps: [
          {
            kind: 'step',
            stepId: 't1.1',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            startedAt: FIXED_AT,
            endedAt: FIXED_AT_2,
            timing: { llmFirstTokenLatencyMs: 120, llmStreamDurationMs: 400 },
            usage: { inputOther: 12, output: 34, inputCacheRead: 0, inputCacheCreation: 0 },
            frames: [
              {
                kind: 'text',
                frameId: ASSISTANT_FRAME_ID,
                role: 'assistant',
                text: 'canonical assistant reply',
                attachmentIds: [ATTACHMENT_ID],
                part: {
                  partId: 'part-asst-canonical',
                  messageId: 'msg-asst-canonical',
                  revision: 1,
                  provenance: { source: 'engine' },
                },
              },
              {
                kind: 'tool',
                frameId: `tool-${TOOL_CALL_ID}`,
                toolCallId: TOOL_CALL_ID,
                name: 'Agent',
                state: 'done',
                input: { instruction: 'Map every event.' },
                agentRefs: [{ agentId: CHILD_AGENT_ID, role: 'child' }],
              },
              {
                kind: 'tool',
                frameId: 'tool-bash-1',
                toolCallId: 'bash-1',
                name: 'Bash',
                state: 'done',
                input: { command: 'ls' },
                output: 'diagram.png',
              },
            ],
          },
        ],
      },
      {
        kind: 'taskref',
        refId: `ref-${CHILD_AGENT_ID}`,
        taskId: `task-${CHILD_AGENT_ID}`,
        at: FIXED_AT_1,
      },
    ],
    tasks: [
      {
        taskId: `task-${CHILD_AGENT_ID}`,
        kind: 'subagent',
        state: 'completed',
        detached: false,
        description: 'Inspect the protocol',
        agentId: CHILD_AGENT_ID,
        outputTail: 'Protocol map complete.',
        resultSummary: 'Protocol map complete.',
        startedAt: FIXED_AT_1,
        endedAt: FIXED_AT_2,
        usage: { inputOther: 4, output: 8, inputCacheRead: 0, inputCacheCreation: 0 },
      },
    ],
    attachments: [
      {
        attachmentId: ATTACHMENT_ID,
        mediaType: 'image/png',
        name: 'diagram.png',
        size: 2048,
        source: { kind: 'url', url: 'https://example.test/diagram.png' },
      },
    ],
    interactions: [
      {
        interactionId: 'apr-child',
        interactionKind: 'approval',
        toolCallId: 'child-rm',
        state: 'pending',
        origin: { agentId: CHILD_AGENT_ID },
        request: { turnId: 2, toolName: 'Bash', action: 'Run: rm -rf build' },
      },
    ],
    prompts: [
      {
        promptId: PROMPT_ID,
        status: 'completed',
        userMessageId: USER_MESSAGE_ID,
        content: [{ type: 'text', text: 'canonical user prompt' }],
        createdAt: FIXED_AT,
        finishedAt: FIXED_AT_2,
      },
      {
        promptId: 'p-steer',
        status: 'running',
        userMessageId: 'um-steer',
        content: [{ type: 'text', text: 'steer this turn' }],
        createdAt: FIXED_AT_1,
        steeredAt: FIXED_AT_1,
      },
    ],
    meta: {
      modes: { plan: { version: 2, reviewPath: 'agents/main/plan/p1/v2.md' }, swarm: { trigger: 'release' } },
      agent: { model: 'fixture/kiki-pro', thinkingEffort: 'high', phase: { kind: 'idle' } },
    },
  });
}

export function olderTurnSnapshot(): AgentTranscriptSnapshot {
  return emptySnapshot({
    items: [
      {
        kind: 'turn',
        turnId: 't0',
        ordinal: 0,
        state: 'completed',
        origin: { kind: 'user', payload: { promptId: 'p-old', userMessageId: 'um-old' } },
        prompt: 'older prompt',
        startedAt: '2025-12-31T23:59:00.000Z',
        steps: [
          {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'completed',
            frames: [{ kind: 'text', frameId: 'asst-old', role: 'assistant', text: 'older reply' }],
          },
        ],
      },
    ],
    hasMoreOlder: false,
  });
}

export function appendOps(offset: number, text: string): readonly TranscriptOperation[] {
  return [
    {
      op: 'append',
      target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: ASSISTANT_FRAME_ID },
      offset,
      text,
    },
  ];
}

export function completeTurnOps(): readonly TranscriptOperation[] {
  return [
    {
      op: 'step.upsert',
      turnId: 't1',
      step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed', endedAt: FIXED_AT_2 },
    },
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user', payload: { promptId: PROMPT_ID, userMessageId: USER_MESSAGE_ID } },
        endedAt: FIXED_AT_2,
        durationMs: 1800,
      },
    },
    { op: 'meta.merge', meta: { activity: 'idle', agent: { phase: { kind: 'idle' } } } },
  ];
}

export function childAppendOps(): readonly TranscriptOperation[] {
  return [
    {
      op: 'append',
      target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'child-asst' },
      offset: 13,
      text: ' more',
    },
  ];
}
