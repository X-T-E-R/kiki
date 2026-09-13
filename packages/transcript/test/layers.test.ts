import { describe, expect, it } from 'vitest';

import { filterOpsForGrade, isAppendOnly, redactSnapshotForGrade } from '#/granularity/filterOps';
import { detachGrades, gradeFor, needsResetOnTransition } from '#/granularity/grade';
import { paginateTurns } from '#/pagination/paginate';
import { ViewRegistry } from '#/view/registry';
import { TranscriptFactReducer } from '#/facts/reducer';
import { TranscriptWireAdapter, type TranscriptWireRecord } from '#/facts/wireAdapter';
import { AgentTranscript } from '#/store/agentTranscript';
import {
  agentTranscriptSnapshotSchema,
  transcriptGradeSpecSchema,
  transcriptOperationSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptOpsPayloadSchema,
  transcriptOpsQuerySchema,
  transcriptQuerySchema,
  transcriptResetPayloadSchema,
  transcriptResponseSchema,
  transcriptSubscribeV2PayloadSchema,
} from '#/contract/schema';
import type { TranscriptItem } from '#/model/item';
import type { AgentTranscriptSnapshot, TranscriptOperation } from '#/ops/operation';

const idLabel = (i: TranscriptItem): string =>
  i.kind === 'turn' ? i.turnId : i.kind === 'marker' ? i.markerId : i.refId;

const turnOp = (n: number): TranscriptOperation => ({
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'running', origin: { kind: 'user' } },
});

const stepOp: TranscriptOperation = {
  op: 'step.upsert',
  turnId: 't1',
  step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
};

const frameOp: TranscriptOperation = {
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'full' },
};

const appendOp: TranscriptOperation = {
  op: 'append',
  target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
  offset: 0,
  text: 'chunk',
};

const promptOp: TranscriptOperation = {
  op: 'prompt.upsert',
  prompt: { promptId: 'p1', status: 'queued', createdAt: '2026-07-22T00:00:00.000Z' },
};

describe('granularity', () => {
  const ops: TranscriptOperation[] = [
    turnOp(1),
    stepOp,
    frameOp,
    appendOp,
    promptOp,
    { op: 'meta.merge', meta: { activity: 'turn' } },
  ];

  it('off admits nothing', () => {
    expect(filterOpsForGrade('off', ops)).toEqual([]);
  });

  it('turn admits headers and global state only', () => {
    expect(filterOpsForGrade('turn', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('forwards tool count sets at turn grade', () => {
    const op = { op: 'tool.count.set', count: 7 } as const;
    expect(filterOpsForGrade('turn', [op])).toEqual([op]);
  });

  it('block admits step/frame upserts but no appends', () => {
    expect(filterOpsForGrade('block', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'step.upsert',
      'frame.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('delta admits everything', () => {
    expect(filterOpsForGrade('delta', ops)).toHaveLength(ops.length);
  });

  it('gradeFor resolves agent override over wildcard default', () => {
    const spec = { '*': 'turn', main: 'delta' } as const;
    expect(gradeFor(spec, 'main')).toBe('delta');
    expect(gradeFor(spec, 'sub-1')).toBe('turn');
    expect(gradeFor(undefined, 'main')).toBe('off');
  });

  it('upgrade needs reset, downgrade does not', () => {
    expect(needsResetOnTransition('turn', 'delta')).toBe(true);
    expect(needsResetOnTransition('delta', 'turn')).toBe(false);
  });

  it('detachGrades writes explicit off so a wildcard default cannot resurrect the agent', () => {
    expect(detachGrades({ '*': 'delta' }, ['main'])).toEqual({ '*': 'delta', main: 'off' });
    expect(detachGrades({ '*': 'delta', main: 'turn' }, ['main'])).toEqual({
      '*': 'delta',
      main: 'off',
    });
  });

  it('detachGrades deletes a listed wildcard entry', () => {
    expect(detachGrades({ '*': 'delta', main: 'turn' }, ['*'])).toEqual({ main: 'turn' });
  });

  it('detachGrades collapses an all-off spec to undefined', () => {
    expect(detachGrades({ main: 'delta' }, ['main'])).toBeUndefined();
    expect(detachGrades({ '*': 'delta', main: 'off' }, ['*'])).toBeUndefined();
    expect(detachGrades(undefined, ['main'])).toBeUndefined();
  });

  it('append-only batches are volatile-safe', () => {
    expect(isAppendOnly([appendOp])).toBe(true);
    expect(isAppendOnly([appendOp, frameOp])).toBe(false);
  });

  it('redactSnapshotForGrade strips step detail below block, keeps it at block+', () => {
    const snapshot: AgentTranscriptSnapshot = {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'hi',
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'body' }],
            },
          ],
        },
        { kind: 'marker', markerId: 'm1', marker: 'skill' },
      ],
      tasks: [],
      interactions: [
        {
          interactionId: 'appr-1',
          interactionKind: 'approval' as const,
          toolCallId: 'c1',
          state: 'pending' as const,
        },
      ],
      attachments: [
        { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'url' as const, url: 'https://example.com/a.png' } },
      ],
      todos: [{ todoId: 'todo', items: [{ title: 'write tests', status: 'in_progress' as const }] }],
      prompts: [{ promptId: 'p1', status: 'running' as const, createdAt: '2026-07-22T00:00:00.000Z' }],
      toolCallCount: 3,
      meta: {},
    };
    const turnGrade = redactSnapshotForGrade('turn', snapshot);
    expect(turnGrade.interactions).toHaveLength(1);
    expect(turnGrade.attachments).toHaveLength(1);
    expect(turnGrade.todos).toHaveLength(1);
    expect(turnGrade.prompts).toHaveLength(1);
    expect(turnGrade.toolCallCount).toBe(3);
    const turn = turnGrade.items[0];
    expect(turn?.kind === 'turn' && turn.steps).toEqual([]);
    expect(turn?.kind === 'turn' && turn.prompt).toBe('hi');
    expect(turnGrade.items[1]?.kind).toBe('marker');
    expect(redactSnapshotForGrade('block', snapshot)).toBe(snapshot);
    expect(redactSnapshotForGrade('delta', snapshot)).toBe(snapshot);
  });
});

describe('paginateTurns', () => {
  const items: TranscriptItem[] = [
    { kind: 'marker', markerId: 'm0', marker: 'goal' },
    ...[1, 2, 3, 4, 5].flatMap((n): TranscriptItem[] => [
      {
        kind: 'turn',
        turnId: `t${n}`,
        ordinal: n,
        state: 'completed',
        origin: { kind: 'user' },
        steps: [],
      },
      { kind: 'marker', markerId: `m${n}`, marker: 'skill' },
    ]),
  ];

  it('default page is the newest N turns with trailing segment items', () => {
    const page = paginateTurns(items, { pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(true);
  });

  it('before_turn pages toward older turns; head marker rides the oldest segment', () => {
    const page = paginateTurns(items, { beforeTurn: 't4', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t2', 'm2', 't3', 'm3']);
    expect(page.hasMore).toBe(true);

    const oldest = paginateTurns(items, { beforeTurn: 't2', pageSize: 5 });
    expect(oldest.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(oldest.hasMore).toBe(false);
  });

  it('after_turn pages toward newer turns without the head unit', () => {
    const page = paginateTurns(items, { afterTurn: 't3', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps head non-turn items with the newest page when turns exactly fill it', () => {
    const page = paginateTurns(items, { pageSize: 5 });
    expect(page.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(page.items.map(idLabel)).toEqual(['m0', 't1', 'm1', 't2', 'm2', 't3', 'm3', 't4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('returns a marker-only timeline as one page with nothing older', () => {
    const only = paginateTurns([{ kind: 'marker', markerId: 'm0', marker: 'goal' }], { pageSize: 3 });
    expect(only.items.map(idLabel)).toEqual(['m0']);
    expect(only.hasMore).toBe(false);
  });
});

describe('ViewRegistry', () => {
  it('dispatches on view ?? name, origin.kind and marker keys', () => {
    const registry = new ViewRegistry<string>({ fallbackTool: 'generic' });
    registry.registerTool('read', 'readRenderer');
    registry.registerTool('swarm', 'swarmRenderer');
    registry.registerInput('cron', 'cronInput');
    registry.registerMarker('goal', 'goalMarker');

    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c1', name: 'Read', state: 'done' }),
    ).toBe('readRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c2', name: 'AgentSwarm', view: 'swarm', state: 'running' }),
    ).toBe('swarmRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c3', name: 'Bash', state: 'running' }),
    ).toBe('generic');
    expect(registry.resolveInput({ kind: 'cron' })).toBe('cronInput');
    expect(registry.resolveInput({ kind: 'user' })).toBeUndefined();
    expect(registry.resolveMarker('goal')).toBe('goalMarker');
  });
});

describe('contract schemas', () => {
  it('normalizes legacy transcript cursors and emits epoch cursors with coverage', () => {
    expect(
      transcriptSubscribeV2PayloadSchema.parse({
        session_id: 's1',
        transcript: { '*': 'delta' },
        transcript_since: { main: 7, '*': { epoch: 'e1', seq: 3 } },
      }).transcript_since,
    ).toEqual({ main: { epoch: undefined, seq: 7 }, '*': { epoch: 'e1', seq: 3 } });
    expect(
      transcriptOpsQuerySchema.parse({
        agent_id: 'main',
        epoch: 'e1',
        since_seq: '7',
      }),
    ).toEqual({ agent_id: 'main', epoch: 'e1', since_seq: 7, grade: 'delta' });
    expect(
      transcriptOpsQuerySchema.safeParse({
        agent_id: '../main',
        since_seq: '0',
        grade: 'turn',
      }).success,
    ).toBe(false);
    const snapshot = {
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
    const cursor = { epoch: 'e1', seq: 7 };
    const coverage = { kind: 'tail' as const, hasMoreOlder: false };
    expect(
      transcriptResetPayloadSchema.safeParse({
        session_id: 's1',
        agent_id: 'main',
        snapshot,
        grade: 'delta',
        coverage,
        cursor,
      }).success,
    ).toBe(true);
    expect(agentTranscriptSnapshotSchema.parse({ ...snapshot, toolCallCount: 7 }).toolCallCount).toBe(7);
    expect(
      agentTranscriptSnapshotSchema.safeParse({ ...snapshot, toolCallCount: -1 }).success,
    ).toBe(false);
    expect(
      agentTranscriptSnapshotSchema.parse({ ...snapshot, toolCallCount: undefined, toolCallCountKnown: false }).toolCallCountKnown,
    ).toBe(false);
    const invalidateCount = { op: 'tool.count.set', count: undefined } as const;
    expect(transcriptOperationSchema.safeParse(invalidateCount).success).toBe(true);
    expect(transcriptOperationSchema.safeParse({ op: 'tool.count.set', count: 0 }).success).toBe(true);
    expect(transcriptOperationSchema.safeParse({ op: 'tool.count.set', count: -1 }).success).toBe(false);
    expect(
      transcriptOpsPayloadSchema.safeParse({
        session_id: 's1',
        agent_id: 'main',
        ops: [],
        cursor,
        through_seq: 9,
      }).success,
    ).toBe(true);
    expect(
      transcriptOpsCatchupResponseSchema.safeParse({
        session_id: 's1',
        agent_id: 'main',
        epoch: 'e1',
        batches: [{ seq: 7, ops: [] }],
        through_seq: 9,
        complete: true,
      }).success,
    ).toBe(true);
  });

  it('roundtrips every op kind', () => {
    const ops: TranscriptOperation[] = [
      { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, hasMoreOlder: true } },
      turnOp(1),
      stepOp,
      frameOp,
      appendOp,
      { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'goal' } },
      { op: 'taskref.upsert', item: { kind: 'taskref', refId: 'r1', taskId: 'task1' } },
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      {
        op: 'interaction.upsert',
        interaction: { interactionId: 'appr-1', interactionKind: 'approval', toolCallId: 'c1', state: 'pending' },
      },
      {
        op: 'attachment.upsert',
        attachment: { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'file', fileId: 'f1' } },
      },
      { op: 'todo.upsert', todo: { todoId: 'todo', items: [{ title: 'x', status: 'done' }] } },
      promptOp,
      { op: 'meta.merge', meta: { goal: { objective: 'x', status: 'active' } } },
      { op: 'items.remove', ids: ['t1'] },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toBeDefined();
    }
  });

  it('roundtrips ops carrying the extended wire detail', () => {
    const usage = { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 };
    const ops: TranscriptOperation[] = [
      {
        op: 'reset',
        agentId: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [
            {
              promptId: 'p1',
              status: 'completed',
              userMessageId: 'u1',
              content: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-07-22T00:00:00.000Z',
              finishedAt: '2026-07-22T00:01:00.000Z',
              steeredAt: '2026-07-22T00:00:30.000Z',
            },
          ],
          meta: {
            agent: {
              model: 'k2',
              thinkingEffort: 'high',
              usage: { byModel: { k2: usage }, currentTurn: usage, total: usage },
              contextTokens: 1234,
              maxContextTokens: 128000,
              contextUsage: 0.01,
              permission: 'auto',
              phase: { kind: 'retrying', turnId: 1, step: 1, stepId: 't1.1', failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, since: 1000 },
            },
          },
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn', turnId: 't1', ordinal: 1, state: 'failed', origin: { kind: 'user' },
          usage: { inputTokens: 12, outputTokens: 5, cachedTokens: 3 },
          durationMs: 1500,
          error: 'boom',
        },
      },
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'interrupted',
          usage,
          finishReason: 'stop',
          timing: {
            llmFirstTokenLatencyMs: 120,
            llmStreamDurationMs: 900,
            llmRequestBuildMs: 5,
            llmServerFirstTokenMs: 110,
            llmServerDecodeMs: 700,
            llmClientConsumeMs: 950,
          },
          retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'RateLimit', errorMessage: 'slow down', statusCode: 429 },
          endReason: 'aborted',
          endMessage: 'user pressed escape',
        },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool', frameId: 't1.1.c1', toolCallId: 'c1', name: 'Bash', state: 'interrupted',
          inputText: '{"command":"ls',
          progress: { kind: 'progress', text: 'half', percent: 50, customKind: 'bar', customData: { x: 1 } },
          startedAt: '2026-08-31T00:00:00.000Z',
          endedAt: '2026-08-31T00:00:01.000Z',
        },
      },
      {
        op: 'task.upsert',
        task: {
          taskId: 'task1', kind: 'subagent', state: 'completed', detached: false, outputTail: '',
          resultSummary: 'scanned 12 files',
          error: 'partial failure',
          stateReason: 'waiting for input',
          usage,
        },
      },
      {
        op: 'meta.merge',
        meta: { agent: { model: 'k2', phase: { kind: 'ended', turnId: 1, reason: 'completed', durationMs: 1500, at: 2000 } } },
      },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toEqual(op);
    }
  });

  it('rejects mutually exclusive cursors and bad grades', () => {
    expect(() => transcriptGradeSpecSchema.parse({ '*': 'stream' })).toThrow();
    const ok = transcriptResponseSchema.safeParse({
      session_id: 's1',
      agent_id: 'main',
      items: [],
      has_more: false,
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      agents: [{ agentId: 'main', type: 'main' }],
      pending_interactions: [],
      coverage: { kind: 'full', hasMoreOlder: false },
    });
    expect(ok.success).toBe(true);
    expect(transcriptResponseSchema.parse({ ...ok.data, tool_call_count: 3 }).tool_call_count).toBe(3);
    expect(
      transcriptResponseSchema.safeParse({ ...ok.data, tool_call_count: -1 }).success,
    ).toBe(false);
    expect(
      transcriptResponseSchema.safeParse({
        ...ok.data,
        agents: [
          {
            agentId: 'external-child',
            type: 'independent',
            delegator: { kind: 'external', delegationId: 'delegation_test' },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects path-hostile agent ids in the transcript query', () => {
    const base = { agent_id: 'main', before_turn: undefined, after_turn: undefined, page_size: undefined };
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: 'sub-1' }).success).toBe(true);
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: '01HF7YAT31J7SMRT1QXGJWKR8D' }).success).toBe(true);
    for (const hostile of ['../main', '..\\main', '..', 'a/b', 'a\\b', '.', 'a\0b', 'x'.repeat(200)]) {
      expect(transcriptQuerySchema.safeParse({ ...base, agent_id: hostile }).success).toBe(false);
    }
  });
});

describe('TranscriptWireAdapter', () => {
  const records: TranscriptWireRecord[] = [
    {
      type: 'turn.prompt',
      turnId: 0,
      promptId: 'prompt-1',
      input: [{ type: 'text', text: 'run it' }],
      origin: { kind: 'user' },
      time: 1_000,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
      time: 2_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: 0,
        stepUuid: 'step-1',
        uuid: 'part-a',
        part: { type: 'text', text: 'before' },
      },
      time: 3_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        turnId: 0,
        stepUuid: 'step-1',
        uuid: 'part-tool',
        toolCallId: 'call-1',
        name: 'Bash',
        args: { command: 'pwd' },
      },
      time: 4_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 'call-1',
        result: { output: '/repo', isError: false },
      },
      time: 5_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: 0,
        stepUuid: 'step-1',
        uuid: 'part-b',
        part: { type: 'text', text: 'after' },
      },
      time: 6_000,
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        turnId: 0,
        step: 1,
        uuid: 'step-1',
        usage: { inputOther: 2, output: 3, inputCacheRead: 4, inputCacheCreation: 5 },
      },
      time: 7_000,
    },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 8_000 },
  ];

  const replay = (
    all: readonly TranscriptWireRecord[],
    agentId: string = 'main',
  ): AgentTranscript => {
    const transcript = new AgentTranscript(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId, {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => {
        for (const item of transcript.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            const frame = step.frames.find(
              (candidate) => candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
            );
            if (frame?.kind === 'tool') return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
        return undefined;
      },
      task: (taskId) => transcript.getTask(taskId),
    });
    for (const record of all) reducer.apply(adapter.add(record));
    reducer.apply(adapter.finish());
    return transcript;
  };

  it('produces identical cold and incremental snapshots with engine identities and stable order', () => {
    const cold = replay(records);
    const live = replay(records);
    expect(live.snapshot()).toEqual(cold.snapshot());
    const turn = live.getTurn('t0');
    expect(turn?.message?.messageId).toBe('prompt-1');
    expect(turn?.state).toBe('completed');
    expect(turn?.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedTokens: 4 });
    expect(turn?.steps[0]?.stepId).toBe('step-1');
    expect(turn?.steps[0]?.frames.map((frame) => frame.frameId)).toEqual([
      'part-a',
      'step-1.call-1',
      'part-b',
    ]);
    expect(turn?.steps[0]?.frames.find((frame) => frame.kind === 'tool')).toMatchObject({
      state: 'done',
      output: '/repo',
      startedAt: new Date(4_000).toISOString(),
      endedAt: new Date(5_000).toISOString(),
    });
  });

  it('preserves projected agent references when a durable tool result replaces the frame', () => {
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => {
        for (const item of transcript.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            const frame = step.frames.find(
              (candidate) => candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
            );
            if (frame?.kind === 'tool') return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
        return undefined;
      },
    });
    for (const record of records.slice(0, 4)) reducer.apply(adapter.add(record));
    const turn = transcript.getTurn('t0')!;
    const step = turn.steps[0]!;
    const frame = step.frames.find((candidate) => candidate.kind === 'tool');
    if (frame?.kind !== 'tool') throw new Error('tool frame not found');
    reducer.apply([
      {
        factId: 'transient:subagent-ref',
        durability: 'transient',
        operations: [
          {
            op: 'frame.upsert',
            turnId: turn.turnId,
            stepId: step.stepId,
            frame: { ...frame, agentRefs: [{ agentId: 'agent-1', role: 'child' }] },
          },
        ],
      },
    ]);
    reducer.apply(
      adapter.add({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'call-1',
          result: { output: '/repo', isError: false },
        },
        time: 5_000,
      }),
    );

    expect(transcript.getTurn('t0')?.steps[0]?.frames.find((candidate) => candidate.kind === 'tool')).toMatchObject({
      state: 'done',
      output: '/repo',
      agentRefs: [{ agentId: 'agent-1', role: 'child' }],
    });
  });

  it('projects external execution metadata and plans additively', () => {
    const transcript = replay([
      ...records.slice(0, -1),
      {
        type: 'executor.plan.update',
        turnId: 0,
        plan: { entries: [{ content: 'Ship bridge', status: 'in_progress' }] },
        unstable: false,
      },
      {
        type: 'executor.turn.metadata',
        turnId: 0,
        executorId: 'example-acp',
        protocol: 'acp-v1',
        resumeMode: 'handoff',
        profileDelivery: 'first_prompt_preamble',
        fidelity: 'degraded',
        losses: ['resume_new_session_handoff'],
      },
      records.at(-1)!,
    ]);

    expect(transcript.getTurn('t0')?.execution).toEqual({
      executorId: 'example-acp',
      protocol: 'acp-v1',
      resumeMode: 'handoff',
      profileDelivery: 'first_prompt_preamble',
      fidelity: 'degraded',
      losses: ['resume_new_session_handoff'],
    });
    expect(transcript.getTodo('external-plan')?.items).toEqual([
      { title: 'Ship bridge', status: 'in_progress' },
    ]);
    expect(replay(records).getTurn('t0')?.execution).toBeUndefined();
  });

  it('normalizes bundled skill prompts and gives media and markers stable identities', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        revision: 2,
        lineage: { replacesMessageId: 'old-1', rewriteId: 'rewrite-1' },
        input: [
          { type: 'text', text: '<skill>review</skill>' },
          { type: 'text', text: '<skill>security</skill>' },
          { type: 'text', text: 'inspect this' },
          { type: 'image_url', imageUrl: { id: 'file-1' } },
        ],
        origin: {
          kind: 'user',
          skillActivations: [
            { activationId: 'act-review', skillName: 'review' },
            { activationId: 'act-security', skillName: 'security' },
          ],
        },
        time: 1_000,
      },
    ]);
    expect(transcript.getTurn('t0')).toMatchObject({
      prompt: 'inspect this',
      attachmentIds: ['t0.att1'],
      message: {
        messageId: 'prompt-1',
        revision: 2,
        lineage: { replacesMessageId: 'old-1', rewriteId: 'rewrite-1' },
      },
    });
    expect(transcript.getAttachment('t0.att1')).toMatchObject({
      source: { kind: 'session_media', fileId: 'file-1' },
    });
    expect(
      transcript.getItems().filter((item) => item.kind === 'marker').map((item) => item.markerId),
    ).toEqual(['wire:v2:skill:act-review', 'wire:v2:skill:act-security']);
  });

  it('keeps hidden legacy reservations sparse and projects canonical attachment ids', () => {
    const transcript = replay([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first' }],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hidden' }],
          origin: { kind: 'system_trigger', name: 'subagent' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'third' },
            { type: 'image_url', imageUrl: { id: 'file-1' } },
          ],
          origin: { kind: 'user' },
        },
      },
    ]);
    expect(
      transcript.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0', 't2']);
    expect(transcript.getTurn('t2')?.attachmentIds).toEqual(['t2.att1']);
    expect(transcript.getAttachment('t2.att1')).toMatchObject({
      source: { kind: 'session_media', fileId: 'file-1' },
      owner: { kind: 'turn', turnId: 't2' },
    });
  });

  it('maps undo and clear records to structural removals', () => {
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => transcript.getTurn(turnId),
    });
    for (const record of [
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'one' }] },
      },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'two' }] },
      },
    ]) {
      reducer.apply(adapter.add(record));
    }
    const undo = reducer.apply(adapter.add({ type: 'context.undo', count: 1 }));
    expect(undo.acceptedOperations).toEqual([{ op: 'items.remove', ids: ['t1'] }]);
    expect(transcript.getItems().map((item) => item.kind === 'turn' && item.turnId)).toEqual(['t0']);
    const clear = reducer.apply(adapter.add({ type: 'context.clear' }));
    expect(clear.acceptedOperations).toEqual([{ op: 'items.remove', ids: ['t0'] }]);
    expect(transcript.getItems()).toEqual([]);
  });

  it('undoes the full suffix from the requested conversation anchor', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-old',
        input: [{ type: 'text', text: 'old prompt' }],
        origin: { kind: 'user' },
      },
      { type: 'turn.ended', turnId: 0, reason: 'failed' },
      {
        type: 'turn.prompt',
        turnId: 1,
        promptId: 'prompt-retry',
        input: [{ type: 'text', text: 'retry continuation' }],
        origin: { kind: 'retry' },
      },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
      { type: 'context.undo', count: 1 },
      {
        type: 'turn.prompt',
        turnId: 2,
        promptId: 'prompt-old',
        revision: 1,
        lineage: { replacesMessageId: 'prompt-old' },
        input: [{ type: 'text', text: 'replacement' }],
        origin: { kind: 'user' },
      },
    ]);
    expect(transcript.getTurn('t0')).toBeUndefined();
    expect(transcript.getTurn('t1')).toBeUndefined();
    expect(transcript.getTurn('t2')).toMatchObject({
      prompt: 'replacement',
      message: { messageId: 'prompt-old', revision: 1 },
    });
  });

  it('projects legacy origins, injected frames, and child run prompts without collapsing ordinals', () => {
    const transcript = replay([
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'start' }], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'mode reminder' }],
          origin: { kind: 'injection', variant: 'permission_mode' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hidden parent run' }],
          origin: { kind: 'system_trigger', name: 'subagent' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'continue' }],
          origin: { kind: 'system_trigger', name: 'goal_continuation' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run report' }],
          origin: { kind: 'cron_job', jobId: 'job-1' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'task output' }],
          origin: { kind: 'background_task', taskId: 'task-1' },
        },
      },
    ]);
    expect(
      transcript.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0', 't2', 't3', 't4']);
    expect(transcript.getTurn('t0')?.steps[0]?.frames.at(-1)).toMatchObject({
      role: 'user',
      text: 'mode reminder',
    });
    expect(transcript.getTurn('t2')).toMatchObject({ prompt: 'continue', origin: { kind: 'other' } });
    expect(transcript.getTurn('t3')?.origin).toMatchObject({ kind: 'cron', taskId: 'job-1' });
    expect(transcript.getTurn('t4')?.origin).toMatchObject({ kind: 'task', taskId: 'task-1' });

    const child = replay(
      [
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'scan the repo' }],
            origin: { kind: 'system_trigger', name: 'subagent' },
          },
        },
      ],
      'child-1',
    );
    expect(child.getTurn('t0')).toMatchObject({ prompt: 'scan the repo', origin: { kind: 'other' } });
  });

  it('folds todo, goal, plan, swarm, task, and interruption facts through the shared reducer', () => {
    const transcript = replay([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'old', status: 'pending' }], time: 1 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'test', status: 'in_progress' },
          { title: 'ship', status: 'pending' },
          { title: 'invalid' },
        ],
        time: 2,
      },
      { type: 'goal.create', goalId: 'goal-1', objective: 'ship', completionCriterion: 'green', time: 3 },
      { type: 'goal.update', status: 'blocked', tokensUsed: 120, budgetLimits: { tokenBudget: 500 }, time: 4 },
      { type: 'plan_mode.enter', id: 'plan-1', time: 5 },
      { type: 'plan.revision', id: 'plan-1', path: 'agents/main/plan/v2.md', version: 2, time: 6 },
      { type: 'swarm_mode.enter', time: 7 },
      { type: 'swarm_mode.exit', time: 8 },
      {
        type: 'task.started',
        info: { taskId: 'shell-1', kind: 'process', status: 'running', description: 'test', startedAt: 9 },
        time: 9,
      },
      {
        type: 'task.started',
        info: { taskId: 'agent-1', kind: 'agent', status: 'running', agentId: 'child-1', startedAt: 10 },
        time: 10,
      },
      {
        type: 'task.terminated',
        info: { taskId: 'shell-1', kind: 'process', status: 'completed', startedAt: 9, endedAt: 11 },
        outputTail: 'passed',
        time: 11,
      },
      { type: 'turn.cancel', turnId: 0, target: 'active', reason: 'user_cancelled', time: 12 },
    ]);
    expect(transcript.getTodos().get('todo')).toMatchObject({
      items: [
        { title: 'test', status: 'in_progress' },
        { title: 'ship', status: 'pending' },
      ],
      updatedAt: new Date(2).toISOString(),
    });
    expect(transcript.getMeta()).toMatchObject({
      goal: {
        objective: 'ship',
        status: 'blocked',
        completionCriterion: 'green',
        budgetUsed: 120,
        budgetLimit: 500,
      },
      modes: { plan: { reviewPath: 'agents/main/plan/v2.md', version: 2 } },
    });
    expect(transcript.getTasks().get('shell-1')).toMatchObject({
      kind: 'shell',
      state: 'completed',
      outputTail: 'passed',
    });
    expect(transcript.getTasks().has('agent-1')).toBe(false);
    expect(
      transcript.getItems().filter((item) => item.kind === 'taskref').map((item) => item.taskId),
    ).toEqual(['shell-1', 'agent-1']);
    expect(
      transcript.getItems().filter((item) => item.kind === 'marker').map((item) => item.marker),
    ).toEqual(['goal', 'goal', 'plan.enter', 'plan.revision', 'swarm.enter', 'swarm.exit', 'interruption']);
  });

  it('resolves interaction outcomes and cancels pending interactions at cold replay completion', () => {
    const transcript = replay([
      {
        type: 'interaction.request',
        id: 'approval-1',
        kind: 'approval',
        toolCallId: 'call-1',
        request: { toolName: 'Bash' },
        origin: { agentId: 'main', turnId: 1 },
      },
      {
        type: 'interaction.resolved',
        id: 'approval-1',
        response: { decision: 'approved', scope: 'session' },
      },
      {
        type: 'interaction.request',
        id: 'question-1',
        kind: 'question',
        request: {
          questions: [
            { question: 'Choose?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
          ],
        },
      },
      { type: 'interaction.resolved', id: 'question-1', response: null },
      {
        type: 'interaction.request',
        id: 'pending-1',
        kind: 'approval',
        request: { toolCallId: 'call-2', toolName: 'Write' },
      },
      { type: 'interaction.request', id: 'ignored-1', kind: 'user_tool', request: {} },
    ]);
    expect([...transcript.getInteractions().values()]).toEqual([
      expect.objectContaining({
        interactionId: 'approval-1',
        state: 'approved',
        anchor: { kind: 'tool_call', toolCallId: 'call-1' },
      }),
      expect.objectContaining({
        interactionId: 'question-1',
        state: 'dismissed',
        response: null,
        request: {
          question_id: 'question-1',
          questions: [
            expect.objectContaining({
              id: 'q_0',
              options: [
                expect.objectContaining({ id: 'opt_0_0' }),
                expect.objectContaining({ id: 'opt_0_1' }),
              ],
            }),
          ],
        },
      }),
      expect.objectContaining({
        interactionId: 'pending-1',
        state: 'cancelled',
        anchor: { kind: 'tool_call', toolCallId: 'call-2' },
      }),
    ]);
  });

  it('restores durable step interruption reasons and ignores retry progress', () => {
    const records: TranscriptWireRecord[] = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'turn.step.retrying',
        turnId: 0,
        step: 1,
        stepId: 'step-1',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 100,
        errorName: 'Error',
        errorMessage: 'retry',
        time: 3_000,
      },
      {
        type: 'turn.step.interrupted',
        turnId: 0,
        step: 1,
        stepId: 'step-1',
        reason: 'error',
        message: 'failed permanently',
        time: 4_000,
      },
    ];
    const withoutRetry = replay(records.filter((record) => record.type !== 'turn.step.retrying'));
    const withRetry = replay(records);

    expect(withRetry.snapshot()).toEqual(withoutRetry.snapshot());
    expect(withRetry.getTurn('t0')?.steps[0]).toMatchObject({
      stepId: 'step-1',
      state: 'interrupted',
      endReason: 'error',
      endMessage: 'failed permanently',
      endedAt: new Date(4_000).toISOString(),
    });
  });

  it('creates a missing interrupted step from a durable record', () => {
    const store = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'turn.step.interrupted',
        turnId: 0,
        step: 1,
        reason: 'user_cancelled',
        time: 2_000,
      },
    ]);

    expect(store.getTurn('t0')?.steps).toEqual([
      {
        kind: 'step',
        stepId: 't0.1',
        turnId: 't0',
        ordinal: 1,
        state: 'interrupted',
        frames: [],
        endedAt: new Date(2_000).toISOString(),
        endReason: 'user_cancelled',
      },
    ]);
  });

  it('pairs turn.steer with the following append_message and anchors the frame on the next step', () => {
    const coldRecords: TranscriptWireRecord[] = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-1',
          uuid: 'part-a',
          part: { type: 'text', text: 'working' },
        },
        time: 3_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 4_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        promptId: 'steer-1',
        input: [{ type: 'text', text: 'steer this' }],
        origin: { kind: 'user' },
        time: 5_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-1',
          role: 'user',
          content: [{ type: 'text', text: 'steer this' }],
          origin: { kind: 'user' },
        },
        time: 5_100,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 6_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: 0,
          stepUuid: 'step-2',
          uuid: 'part-b',
          part: { type: 'text', text: 'after steer' },
        },
        time: 7_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 2, uuid: 'step-2' },
        time: 8_000,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 9_000 },
    ];
    const liveRecords = coldRecords.filter((record) => record.type !== 'context.append_message');
    const cold = replay(coldRecords);
    const live = replay(liveRecords);
    expect(cold.snapshot()).toEqual(live.snapshot());
    expect(
      cold.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0']);
    const turn = cold.getTurn('t0');
    expect(turn?.steps.map((step) => step.stepId)).toEqual(['step-1', 'step-2']);
    expect(turn?.steps[0]?.frames.map((frame) => frame.frameId)).toEqual(['part-a']);
    expect(turn?.steps[1]?.frames.map((frame) => ({
      frameId: frame.frameId,
      kind: frame.kind,
      role: frame.kind === 'text' ? frame.role : undefined,
      text: frame.kind === 'text' || frame.kind === 'thinking' ? frame.text : undefined,
    }))).toEqual([
      { frameId: 'steer-1', kind: 'text', role: 'user', text: 'steer this' },
      { frameId: 'part-b', kind: 'text', role: 'assistant', text: 'after steer' },
    ]);
  });

  it('preserves sanitized user provenance on a steered frame', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        promptId: 'steer-1',
        input: [{ type: 'text', text: 'follow the skill' }],
        origin: {
          kind: 'user',
          skillActivations: [
            {
              activationId: 'activation-1',
              skillName: 'review',
              skillArgs: 'focused',
              path: 'C:/private/skill.md',
            },
          ],
        },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
    ]);

    const frame = transcript.getTurn('t0')?.steps[0]?.frames[0];
    expect(frame).toMatchObject({
      kind: 'text',
      role: 'user',
      origin: {
        kind: 'user',
        skillActivations: [{ skillName: 'review', skillArgs: 'focused' }],
      },
    });
    expect(JSON.stringify(frame)).not.toContain('C:/private/skill.md');
    expect(JSON.stringify(frame)).not.toContain('activation-1');
  });

  it('does not let a marker-origin message consume a user steer credit', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        input: [{ type: 'text', text: 'same content' }],
        origin: { kind: 'user' },
        time: 2_000,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'same content' }],
          toolCalls: [],
          origin: { kind: 'skill_activation', trigger: 'auto', skillName: 'review' },
        },
        time: 3_000,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'same content' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: 4_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 5_000,
      },
    ]);

    expect(transcript.getItems().filter((item) => item.kind === 'turn')).toHaveLength(1);
    expect(transcript.getTurn('t0')?.steps[0]?.frames[0]).toMatchObject({
      kind: 'text',
      role: 'user',
      text: 'same content',
    });
  });

  it('drops a steer frame when no later step begins and still suppresses the paired append_message', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        promptId: 'steer-1',
        input: [{ type: 'text', text: 'steer this' }],
        origin: { kind: 'user' },
        time: 2_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-1',
          role: 'user',
          content: [{ type: 'text', text: 'steer this' }],
          origin: { kind: 'user' },
        },
        time: 2_100,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 3_000 },
    ]);
    expect(
      transcript.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0']);
    expect(transcript.getTurn('t0')?.steps).toEqual([]);
  });

  it('does not create a ghost turn when the paired append_message is replayed twice', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        promptId: 'steer-1',
        input: [{ type: 'text', text: 'steer this' }],
        origin: { kind: 'user' },
        time: 4_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-1',
          role: 'user',
          content: [{ type: 'text', text: 'steer this' }],
          origin: { kind: 'user' },
        },
        time: 4_100,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-1',
          role: 'user',
          content: [{ type: 'text', text: 'steer this' }],
          origin: { kind: 'user' },
        },
        time: 4_200,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
    ]);
    expect(
      transcript.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0']);
    expect(transcript.getTurn('t0')?.steps[1]?.frames[0]).toMatchObject({
      frameId: 'steer-1',
      role: 'user',
      text: 'steer this',
    });
  });

  it('pairs a promptId-less steer with the next compatible user append without a ghost turn', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        input: [{ type: 'text', text: 'legacy steer' }],
        origin: { kind: 'user' },
        time: 4_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-legacy',
          role: 'user',
          content: [{ type: 'text', text: 'legacy steer' }],
          origin: { kind: 'user' },
        },
        time: 4_100,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-legacy',
          role: 'user',
          content: [{ type: 'text', text: 'legacy steer' }],
          origin: { kind: 'user' },
        },
        time: 4_200,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
    ]);
    expect(
      transcript.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0']);
    expect(transcript.getTurn('t0')?.steps[1]?.frames[0]).toMatchObject({
      role: 'user',
      text: 'legacy steer',
    });
  });

  it('keeps media-only steer text and attachments on the next step', () => {
    const coldRecords: TranscriptWireRecord[] = [
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'start' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
      {
        type: 'turn.steer',
        turnId: 0,
        promptId: 'steer-1',
        input: [{ type: 'image_url', imageUrl: { id: 'file-steer' } }],
        origin: { kind: 'user' },
        time: 4_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'steer-1',
          role: 'user',
          content: [{ type: 'image_url', imageUrl: { id: 'file-steer' } }],
          origin: { kind: 'user' },
        },
        time: 4_100,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
    ];
    const liveRecords = coldRecords.filter((record) => record.type !== 'context.append_message');
    const cold = replay(coldRecords);
    const live = replay(liveRecords);
    expect(cold.snapshot()).toEqual(live.snapshot());
    expect(
      cold.getItems().filter((item) => item.kind === 'turn').map((item) => item.turnId),
    ).toEqual(['t0']);
    expect(cold.getTurn('t0')?.steps[1]?.frames[0]).toMatchObject({
      frameId: 'steer-1',
      role: 'user',
      text: '',
      attachmentIds: ['steer-1.att1'],
    });
    expect(cold.getAttachment('steer-1.att1')).toMatchObject({
      source: { kind: 'session_media', fileId: 'file-steer' },
      owner: { kind: 'frame', turnId: 't0', stepId: 'step-2', frameId: 'steer-1' },
    });
  });

  it('closes every running step and tool at turn end and closes an open tail at finish', () => {
    const ended = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        input: [{ type: 'text', text: 'run' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Bash',
          args: { command: 'sleep 1' },
        },
        time: 3_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 3_500,
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 4_000 },
    ]);
    const endedTurn = ended.getTurn('t0');
    expect(endedTurn?.state).toBe('completed');
    expect(endedTurn?.steps.map((step) => step.state)).toEqual(['interrupted', 'interrupted']);
    expect(endedTurn?.steps[0]?.frames[0]).toMatchObject({
      kind: 'tool',
      state: 'interrupted',
      startedAt: new Date(3_000).toISOString(),
      endedAt: new Date(4_000).toISOString(),
    });
    expect(ended.getMeta()).toMatchObject({
      activity: 'idle',
      agent: {
        phase: {
          kind: 'ended',
          turnId: 0,
          reason: 'completed',
          at: 4_000,
        },
      },
    });

    const unfinished = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        input: [{ type: 'text', text: 'run' }],
        origin: { kind: 'user' },
        time: 10_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 11_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Read',
          args: { path: '/tmp/a' },
        },
        time: 12_000,
      },
    ]);
    expect(unfinished.getTurn('t0')).toMatchObject({
      state: 'cancelled',
      endedAt: new Date(12_000).toISOString(),
      steps: [
        expect.objectContaining({
          state: 'interrupted',
          endedAt: new Date(12_000).toISOString(),
          frames: [
            expect.objectContaining({
              state: 'interrupted',
              startedAt: new Date(12_000).toISOString(),
              endedAt: new Date(12_000).toISOString(),
            }),
          ],
        }),
      ],
    });

    const untimed = replay([
      { type: 'turn.prompt', turnId: 0, input: [], origin: { kind: 'user' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Read',
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'call-1', result: { output: 'ok' } },
      },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
    ]);
    expect(untimed.getTurn('t0')?.steps[0]?.frames[0]).toMatchObject({
      state: 'done',
      startedAt: undefined,
      endedAt: undefined,
    });
  });

  it.each(['interrupted', 'error'] as const)(
    'keeps durable step.end finishReason=%s aligned with the live interrupted state',
    (finishReason) => {
      const transcript = replay([
        { type: 'turn.prompt', turnId: 0, input: [], origin: { kind: 'user' }, time: 1_000 },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
          time: 2_000,
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1', finishReason },
          time: 3_000,
        },
        {
          type: 'turn.ended',
          turnId: 0,
          reason: finishReason === 'error' ? 'failed' : 'cancelled',
          time: 4_000,
        },
      ]);
      expect(transcript.getTurn('t0')?.steps[0]).toMatchObject({
        state: 'interrupted',
        finishReason,
        endReason: finishReason,
      });
    },
  );

  it('deduplicates a projected task notification from its legacy context message', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'Run the fixture suite in the background.' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
        time: 3_000,
      },
      {
        type: 'task.notified',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'pnpm test — 42 passed',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'task-1',
        time: 4_000,
      },
      {
        type: 'context.append_message',
        message: {
          id: 'notification-message',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<notification id="task:task-1:completed" category="task" type="task.completed" source_kind="background_task" source_id="task-1">\nTitle: Background process completed\npnpm test — 42 passed\n</notification>',
            },
          ],
          toolCalls: [],
          origin: {
            kind: 'task',
            taskId: 'task-1',
            status: 'completed',
            notificationId: 'task:task-1:completed',
          },
        },
        time: 4_100,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
        time: 5_000,
      },
    ]);

    expect(transcript.getTurn('t1')).toBeUndefined();
    expect(transcript.getTurn('t0')?.steps[1]?.frames).toEqual([
      expect.objectContaining({
        frameId: 'task-notified:task-1',
        role: 'user',
        taskId: 'task-1',
        text: 'Background process completed\npnpm test — 42 passed',
      }),
    ]);
  });

  it('deduplicates an inline question answer from its task notification summary', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        promptId: 'prompt-1',
        input: [{ type: 'text', text: 'Ask in the background.' }],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: 0, step: 1, uuid: 'step-1' },
      },
      {
        type: 'task.notified',
        notificationType: 'task.completed',
        title: 'Background question answered',
        body: 'The user answered "Which database?".',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'question-1',
      },
      {
        type: 'context.append_message',
        message: {
          id: 'notification-message',
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<notification id="task:question-1:completed" category="task" type="task.completed" source_kind="background_task" source_id="question-1">',
                'Title: Background question answered',
                'Severity: info',
                'The user answered "Which database?".',
                '<answer>',
                '{"answers":{"Which database?":"Postgres"}}',
                '</answer>',
                '</notification>',
              ].join('\n'),
            },
          ],
          toolCalls: [],
          origin: {
            kind: 'task',
            taskId: 'question-1',
            status: 'completed',
            notificationId: 'task:question-1:completed',
          },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 2, uuid: 'step-2' },
      },
    ]);

    expect(transcript.getTurn('t1')).toBeUndefined();
    expect(transcript.getTurn('t0')?.steps[1]?.frames).toEqual([
      expect.objectContaining({
        frameId: 'task-notified:question-1',
        taskId: 'question-1',
        text: 'Background question answered\nThe user answered "Which database?".',
      }),
    ]);
  });

  it('projects forward-compatible task notifications and subagent lifecycle records', () => {
    const transcript = replay([
      {
        type: 'turn.prompt',
        turnId: 0,
        input: [{ type: 'text', text: 'delegate' }],
        origin: { kind: 'user' },
        time: 1_000,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: 0, step: 1, uuid: 'step-1' },
        time: 2_000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: 0,
          stepUuid: 'step-1',
          toolCallId: 'agent-call',
          name: 'Agent',
          args: { prompt: 'scan' },
        },
        time: 3_000,
      },
      {
        type: 'task.notified',
        notificationType: 'completed',
        title: 'Task finished',
        body: 'Output is ready',
        severity: 'info',
        sourceKind: 'process',
        sourceId: 'shell-1',
        time: 3_500,
      },
      {
        type: 'task.started',
        info: {
          taskId: 'agent-task',
          kind: 'agent',
          status: 'running',
          agentId: 'child-1',
          startedAt: 4_000,
        },
        time: 4_000,
      },
      {
        type: 'subagent.spawned',
        subagentId: 'child-1',
        subagentName: 'explore',
        name: 'smoke_explore',
        parentToolCallId: 'agent-call',
        description: 'scan files',
        swarmIndex: 0,
        runInBackground: true,
        taskId: 'agent-task',
        time: 4_100,
      },
      { type: 'subagent.started', subagentId: 'child-1', time: 4_200 },
      { type: 'subagent.suspended', subagentId: 'child-1', reason: 'approval', time: 4_300 },
      {
        type: 'subagent.completed',
        subagentId: 'child-1',
        resultSummary: 'scanned 12 files',
        usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
        time: 5_000,
      },
      {
        type: 'task.terminated',
        info: {
          taskId: 'agent-task',
          kind: 'agent',
          status: 'completed',
          agentId: 'child-1',
          profile: 'explore',
          collaborationTaskName: 'smoke_explore',
          description: 'scan files',
          detached: true,
          startedAt: 4_000,
          endedAt: 5_000,
        },
        outputTail: 'scanned 12 files',
        time: 5_000,
      },
      {
        type: 'subagent.spawned',
        subagentId: 'child-1',
        subagentName: 'explore',
        name: 'smoke_explore',
        parentToolCallId: 'agent-call',
        description: 'scan files',
        swarmIndex: 0,
        runInBackground: true,
        taskId: 'agent-task',
        time: 4_100,
      },
      {
        type: 'subagent.spawned',
        subagentId: 'child-2',
        subagentName: 'explore',
        parentToolCallId: 'agent-call',
        runInBackground: false,
        time: 5_100,
      },
      { type: 'subagent.failed', subagentId: 'child-2', error: 'boom', time: 5_200 },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: 6_000 },
      {
        type: 'task.notified',
        notificationType: 'completed',
        title: 'Later task',
        body: 'Handled by a new turn',
        severity: 'info',
        sourceKind: 'process',
        sourceId: 'shell-2',
        time: 7_000,
      },
      {
        type: 'turn.prompt',
        turnId: 1,
        input: [{ type: 'text', text: 'Handled by a new turn' }],
        origin: { kind: 'background_task', taskId: 'shell-2' },
        time: 8_000,
      },
    ]);
    const frames = transcript.getTurn('t0')?.steps.flatMap((step) => step.frames) ?? [];
    expect(frames.filter((frame) => frame.kind === 'text' && frame.role === 'user')).toEqual([
      expect.objectContaining({
        frameId: 'task-notified:shell-1',
        text: 'Task finished\nOutput is ready',
        taskId: 'shell-1',
        origin: { kind: 'task', taskId: 'shell-1' },
      }),
    ]);
    expect(frames.find((frame) => frame.kind === 'tool')).toMatchObject({
      agentRefs: [
        { agentId: 'child-1', role: 'member' },
        { agentId: 'child-2', role: 'child' },
      ],
    });
    expect(transcript.getTask('agent-task')).toMatchObject({
      kind: 'subagent',
      state: 'completed',
      detached: true,
      name: 'smoke_explore',
      subagentName: 'explore',
      description: 'scan files',
      agentId: 'child-1',
      resultSummary: 'scanned 12 files',
      outputTail: 'scanned 12 files',
      stateReason: 'approval',
      usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
      startedAt: new Date(4_100).toISOString(),
      endedAt: new Date(5_000).toISOString(),
    });
    expect(transcript.getTask('child-2')).toMatchObject({
      kind: 'subagent',
      state: 'failed',
      detached: false,
      name: undefined,
      subagentName: 'explore',
      agentId: 'child-2',
      error: 'boom',
      startedAt: new Date(5_100).toISOString(),
      endedAt: new Date(5_200).toISOString(),
    });
    expect(transcript.getTurn('t1')?.origin).toMatchObject({ kind: 'task', taskId: 'shell-2' });
  });

  it('projects a terminated AgentRun as killed instead of failed', () => {
    const transcript = replay([
      {
        type: 'subagent.spawned',
        subagentId: 'child-terminated',
        subagentName: 'explore',
        parentToolCallId: 'agent-call',
        runInBackground: false,
        time: 1_000,
      },
      { type: 'subagent.started', subagentId: 'child-terminated', time: 1_100 },
      {
        type: 'subagent.failed',
        subagentId: 'child-terminated',
        error: 'terminated',
        time: 1_200,
      },
    ]);
    expect(transcript.getTask('child-terminated')).toMatchObject({
      state: 'killed',
      error: undefined,
      stateReason: 'terminated',
      endedAt: new Date(1_200).toISOString(),
    });
  });

  it('resets terminal fields when one agent starts a second run without a task id', () => {
    const transcript = replay([
      {
        type: 'subagent.spawned',
        subagentId: 'child-1',
        subagentName: 'worker',
        parentToolCallId: 'call-1',
        description: 'First run',
        runInBackground: true,
        time: 1_000,
      },
      { type: 'subagent.started', subagentId: 'child-1', time: 1_100 },
      { type: 'subagent.suspended', subagentId: 'child-1', reason: 'approval', time: 1_200 },
      {
        type: 'subagent.completed',
        subagentId: 'child-1',
        resultSummary: 'done',
        usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
        time: 1_300,
      },
      { type: 'subagent.failed', subagentId: 'child-1', error: 'boom', time: 1_400 },
      {
        type: 'subagent.spawned',
        subagentId: 'child-1',
        subagentName: 'worker',
        parentToolCallId: 'call-2',
        description: 'Second run',
        runInBackground: false,
        time: 2_000,
      },
      { type: 'subagent.started', subagentId: 'child-1', time: 2_100 },
    ]);

    expect(transcript.getTask('child-1')).toEqual({
      taskId: 'child-1',
      kind: 'subagent',
      state: 'running',
      detached: false,
      name: undefined,
      subagentName: 'worker',
      description: 'Second run',
      agentId: 'child-1',
      outputTail: '',
      startedAt: new Date(2_000).toISOString(),
    });
  });

  it('anchors task references after the current turn and leaves context-free references unanchored', () => {
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter('main', {
      turn: (turnId) => transcript.getTurn(turnId),
    });
    const contextFree = adapter.add({
      type: 'task.started',
      info: { taskId: 'before', kind: 'process', status: 'running', startedAt: 1 },
      time: 1,
    });
    expect(contextFree[0]?.operations[0]).toMatchObject({ op: 'taskref.upsert', beforeTurn: undefined });
    reducer.apply(contextFree);
    reducer.apply(
      adapter.add({
        type: 'turn.prompt',
        turnId: 0,
        input: [{ type: 'text', text: 'run' }],
        origin: { kind: 'user' },
        time: 2,
      }),
    );
    const anchored = adapter.add({
      type: 'task.started',
      info: { taskId: 'during', kind: 'process', status: 'running', startedAt: 3 },
      time: 3,
    });
    expect(anchored[0]?.operations[0]).toMatchObject({ op: 'taskref.upsert', beforeTurn: 1 });
    reducer.apply(anchored);
    reducer.apply(
      adapter.add({
        type: 'turn.prompt',
        turnId: 1,
        input: [{ type: 'text', text: 'next' }],
        origin: { kind: 'user' },
        time: 4,
      }),
    );
    expect(transcript.getItems().map(idLabel)).toEqual(['ref-before', 't0', 'ref-during', 't1']);
  });

  it('updates known turns from turn.ended without materializing unknown turn ids', () => {
    const transcript = replay([
      { type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'run' }], origin: { kind: 'user' } },
      {
        type: 'turn.ended',
        turnId: 0,
        reason: 'failed',
        durationMs: 25,
        error: { message: 'boom' },
        time: 20,
      },
      { type: 'turn.ended', turnId: 9, reason: 'cancelled', time: 30 },
    ]);
    expect(transcript.getTurn('t0')).toMatchObject({
      state: 'failed',
      durationMs: 25,
      error: 'boom',
      endedAt: new Date(20).toISOString(),
    });
    expect(transcript.getTurn('t9')).toBeUndefined();
  });

  it('deduplicates durable facts and reports changed ids from accepted operations', () => {
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    const fact = {
      factId: 'fact-1',
      durability: 'durable' as const,
      operations: [turnOp(0)],
    };
    const first = reducer.apply([fact]);
    const duplicate = reducer.apply([fact]);
    expect(first.acceptedOperations).toHaveLength(1);
    expect(first.changedIds).toEqual(new Set(['t0']));
    expect(duplicate.acceptedFacts).toHaveLength(0);
    expect(duplicate.acceptedOperations).toHaveLength(0);

    const countResult = reducer.apply([
      {
        factId: 'fact-count',
        durability: 'durable',
        operations: [{ op: 'tool.count.set', count: 7 }],
      },
    ]);
    expect(countResult.changedIds).toEqual(new Set(['toolCallCount']));
  });
});
