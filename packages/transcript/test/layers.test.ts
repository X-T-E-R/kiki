import { describe, expect, it } from 'vitest';

import { filterOpsForGrade, isAppendOnly, redactSnapshotForGrade } from '#/granularity/filterOps';
import { detachGrades, gradeFor, needsResetOnTransition } from '#/granularity/grade';
import { paginateTurns } from '#/pagination/paginate';
import { ViewRegistry } from '#/view/registry';
import { TranscriptFactReducer } from '#/facts/reducer';
import { TranscriptWireAdapter, type TranscriptWireRecord } from '#/facts/wireAdapter';
import { AgentTranscript } from '#/store/agentTranscript';
import {
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
      meta: {},
    };
    const turnGrade = redactSnapshotForGrade('turn', snapshot);
    expect(turnGrade.interactions).toHaveLength(1);
    expect(turnGrade.attachments).toHaveLength(1);
    expect(turnGrade.todos).toHaveLength(1);
    expect(turnGrade.prompts).toHaveLength(1);
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
          kind: 'tool', frameId: 't1.1.c1', toolCallId: 'c1', name: 'Bash', state: 'running',
          inputText: '{"command":"ls',
          progress: { kind: 'progress', text: 'half', percent: 50, customKind: 'bar', customData: { x: 1 } },
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
    });
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
        request: { questions: [] },
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
      expect.objectContaining({ interactionId: 'question-1', state: 'dismissed', response: null }),
      expect.objectContaining({
        interactionId: 'pending-1',
        state: 'cancelled',
        anchor: { kind: 'tool_call', toolCallId: 'call-2' },
      }),
    ]);
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
  });
});
