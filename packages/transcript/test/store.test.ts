import { describe, expect, it } from 'vitest';

import { AgentTranscript } from '#/store/agentTranscript';
import { TranscriptStore } from '#/store/transcriptStore';
import { appendAtOffset } from '#/ops/apply';
import type {
  FrameUpsertOp,
  TurnUpsertOp,
  TranscriptOperation,
} from '#/ops/operation';
import type { ThinkingFrame, ToolCallFrame } from '#/model/frame';
import type { TranscriptInteraction } from '#/model/interaction';
import type { TranscriptItem } from '#/model/item';

function itemLabel(item: TranscriptItem): string {
  if (item.kind === 'turn') return item.turnId;
  if (item.kind === 'marker') return item.markerId;
  return item.refId;
}

const turn1: TurnUpsertOp = {
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: 'hi' },
};

const doneThinking: FrameUpsertOp = {
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'thinking', frameId: 't1.1.f1', text: 'ponder' } satisfies ThinkingFrame,
};

function toolFrame(state: ToolCallFrame['state'], output?: unknown): TranscriptOperation[] {
  return [
    turn1,
    {
      op: 'step.upsert',
      turnId: 't1',
      step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
    },
    {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool',
        frameId: 't1.1.call_1',
        toolCallId: 'call_1',
        name: 'Read',
        state,
        input: { path: '/a' },
        output,
      } satisfies ToolCallFrame,
    },
  ];
}

describe('AgentTranscript', () => {
  it('applies turn/step/frame and keeps a self-consistent snapshot', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));

    const items = tx.getItems();
    expect(items).toHaveLength(1);
    const turn = items[0];
    expect(turn?.kind).toBe('turn');
    if (turn?.kind !== 'turn') return;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.frames.map((f) => f.kind)).toEqual(['tool']);
  });

  it('keeps a bounded resident tail without emitting history-removal operations', () => {
    const tx = new AgentTranscript('main', { tailTurns: 20, maxBytes: 16 << 20 });
    const emitted: TranscriptOperation[][] = [];
    tx.onChange((event) => emitted.push([...event.ops]));
    for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
      tx.apply([{
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: `t${ordinal}`,
          ordinal,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: `prompt-${ordinal}`,
        },
      }]);
    }

    expect(tx.getItems().filter((item) => item.kind === 'turn')).toHaveLength(20);
    expect(tx.getItems().filter((item) => item.kind === 'turn').at(0)?.turnId).toBe('t9980');
    expect(tx.hasMoreOlder).toBe(true);
    expect(tx.residentReport()).toMatchObject({ turns: 20, trimmedTurns: 9_980, overBudget: false });
    expect(emitted.flat().some((operation) => operation.op === 'items.remove')).toBe(false);
  });

  it('never trims a running turn to satisfy the resident byte target', () => {
    const tx = new AgentTranscript('main', { tailTurns: 1, maxBytes: 1_024 });
    tx.apply([{
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't0',
        ordinal: 0,
        state: 'running',
        origin: { kind: 'user' },
        prompt: 'x'.repeat(10_000),
      },
    }]);

    expect(tx.getTurn('t0')).toBeDefined();
    expect(tx.residentReport().overBudget).toBe(true);
  });

  it('auto-vivifies missing parents so any op order stays self-consistent', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'frame.upsert',
        turnId: 't9',
        stepId: 't9.2',
        frame: { kind: 'thinking', frameId: 't9.2.f1', text: 'x' },
      },
    ]);
    const turn = tx.getTurn('t9');
    expect(turn?.ordinal).toBe(9);
    expect(turn?.steps[0]?.stepId).toBe('t9.2');
  });

  it('upserts are idempotent under duplication in causal order', () => {
    const ops: TranscriptOperation[] = [
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
      },
      doneThinking,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed' },
      },
      { op: 'turn.upsert', turn: { ...turn1.turn, state: 'completed' } },
    ];
    const a = new AgentTranscript('main');
    a.apply(ops);
    const b = new AgentTranscript('main');
    b.apply([...ops, ...ops]);
    b.apply(ops);
    expect(b.getItems()).toEqual(a.getItems());
  });

  it('appends text chunks by offset; gaps stay un-applied and signalled', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: '' },
      },
    ]);
    const gap = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 5, text: 'late' },
    ]);
    expect(gap.gap).toEqual({
      target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
      expected: 0,
      got: 5,
    });

    const ok = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 0, text: 'hello ' },
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 6, text: 'world' },
    ]);
    expect(ok.gap).toBeUndefined();
    const turn = tx.getTurn('t1');
    const frame = turn?.steps[0]?.frames[0];
    expect(frame?.kind === 'text' && frame.text).toBe('hello world');

    const dup = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 6, text: 'world' },
    ]);
    expect(dup.accepted).toHaveLength(0);

    const convergence = tx.apply([
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'hello world' },
      },
    ]);
    expect(convergence.accepted).toHaveLength(1);
    expect(tx.apply(convergence.accepted).accepted).toHaveLength(0);
  });

  it('reuses unchanged entity arrays across text-only snapshots', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: '' },
      },
    ]);
    const before = tx.snapshot();

    tx.apply([
      {
        op: 'append',
        target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
        offset: 0,
        text: 'x',
      },
    ]);
    const after = tx.snapshot();

    expect(after.items).not.toBe(before.items);
    expect(after.tasks).toBe(before.tasks);
    expect(after.interactions).toBe(before.interactions);
    expect(after.attachments).toBe(before.attachments);
    expect(after.todos).toBe(before.todos);
    expect(after.prompts).toBe(before.prompts);
  });

  it('applies a large contiguous append burst as one convergent state transition', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: '' },
      },
    ]);
    const chunks = Array.from({ length: 2_000 }, (_, offset) => ({
      op: 'append' as const,
      target: { type: 'frame' as const, turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
      offset,
      text: 'x',
    }));
    const events: TranscriptOperation[][] = [];
    tx.onChange((event) => events.push([...event.ops]));

    const result = tx.apply(chunks);

    const frame = tx.getTurn('t1')?.steps[0]?.frames[0];
    expect(frame?.kind === 'text' && frame.text).toBe('x'.repeat(2_000));
    expect(result.accepted).toEqual(chunks);
    expect(events).toEqual([chunks]);
  });

  it('appendAtOffset matches web alignDelta semantics', () => {
    expect(appendAtOffset('abc', 3, 'd')).toEqual({ text: 'abcd', changed: true });
    expect(appendAtOffset('abc', 1, 'bc').changed).toBe(false);
    expect(appendAtOffset('abc', 1, 'bcd')).toEqual({ text: 'abcd', changed: true });
    expect(appendAtOffset('abc', 5, 'x').gap).toEqual({ expected: 3, got: 5 });
  });

  it('appendAtOffset treats a mismatched overlap as a gap, never a rewrite', () => {
    const result = appendAtOffset('hello', 2, ' world');
    expect(result.text).toBe('hello');
    expect(result.gap).toEqual({ expected: 5, got: 2 });
    expect(appendAtOffset('hello wo', 6, 'world')).toEqual({ text: 'hello world', changed: true });
  });

  it('tracks pending interactions as a derived index (entity channel)', () => {
    const tx = new AgentTranscript('main');
    const interaction = (state: TranscriptInteraction['state']): TranscriptInteraction => ({
      interactionId: 'appr-1',
      interactionKind: 'approval',
      toolCallId: 'call-1',
      state,
    });
    tx.apply([turn1, { op: 'interaction.upsert', interaction: interaction('pending') }]);
    expect(tx.listPendingInteractions()).toEqual(['appr-1']);
    tx.apply([{ op: 'interaction.upsert', interaction: interaction('approved') }]);
    expect(tx.listPendingInteractions()).toEqual([]);

    const unanchored = (state: TranscriptInteraction['state']): TranscriptInteraction => ({
      interactionId: 'appr-2',
      interactionKind: 'question',
      state,
    });
    tx.apply([{ op: 'interaction.upsert', interaction: unanchored('pending') }]);
    expect(tx.listPendingInteractions()).toEqual(['appr-2']);
    tx.apply([{ op: 'interaction.upsert', interaction: unanchored('answered') }]);
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('upserts attachment and todo entities idempotently', () => {
    const tx = new AgentTranscript('main');
    const attachment = {
      attachmentId: 'att_1',
      mediaType: 'image/png',
      source: { kind: 'url' as const, url: 'https://example.com/a.png' },
    };
    const todo = { todoId: 'todo', items: [{ title: 'x', status: 'pending' as const }] };
    const first = tx.apply([
      { op: 'attachment.upsert', attachment },
      { op: 'todo.upsert', todo },
    ]);
    expect(first.accepted).toHaveLength(2);
    const second = tx.apply([
      { op: 'attachment.upsert', attachment },
      { op: 'todo.upsert', todo },
    ]);
    expect(second.accepted).toHaveLength(0);
    expect(tx.getAttachment('att_1')?.mediaType).toBe('image/png');
    expect(tx.getTodo('todo')?.items).toHaveLength(1);
    tx.apply([{ op: 'todo.upsert', todo: { ...todo, items: [] } }]);
    expect(tx.getTodo('todo')?.items).toHaveLength(0);
  });

  it('upserts prompt queue entities by id, idempotently', () => {
    const tx = new AgentTranscript('main');
    const queued = {
      promptId: 'p1',
      status: 'queued' as const,
      userMessageId: 'u1',
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    expect(tx.apply([{ op: 'prompt.upsert', prompt: queued }]).accepted).toHaveLength(1);
    expect(tx.apply([{ op: 'prompt.upsert', prompt: queued }]).accepted).toHaveLength(0);
    const running = { ...queued, status: 'running' as const, steeredAt: '2026-07-22T00:00:01.000Z' };
    expect(tx.apply([{ op: 'prompt.upsert', prompt: running }]).accepted).toHaveLength(1);
    expect(tx.getPrompt('p1')?.status).toBe('running');
    expect(tx.getPrompt('p1')?.steeredAt).toBe('2026-07-22T00:00:01.000Z');

    const snapshot = tx.snapshot();
    expect(snapshot.prompts).toEqual([running]);
    const fresh = new AgentTranscript('main');
    fresh.receive([{ op: 'reset', agentId: 'main', snapshot }]);
    expect(fresh.getPrompt('p1')).toEqual(running);
    expect([...fresh.getPrompts().keys()]).toEqual(['p1']);
  });

  it('step upserts carry usage/timing and the terminal header clears retry', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running',
          retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'RateLimit', errorMessage: 'slow down' },
        },
      },
    ]);
    expect(tx.getTurn('t1')?.steps[0]?.retry?.errorName).toBe('RateLimit');

    const completed = tx.apply([
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed',
          usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
          finishReason: 'stop',
          timing: { llmFirstTokenLatencyMs: 120 },
        },
      },
    ]);
    expect(completed.accepted).toHaveLength(1);
    const step = tx.getTurn('t1')?.steps[0];
    expect(step?.usage?.output).toBe(5);
    expect(step?.timing?.llmFirstTokenLatencyMs).toBe(120);
    expect(step?.retry).toBeUndefined();
  });

  it('turn upserts carry durationMs and the terminal error', () => {
    const tx = new AgentTranscript('main');
    tx.apply([turn1]);
    const failed = tx.apply([
      { op: 'turn.upsert', turn: { ...turn1.turn, state: 'failed', durationMs: 1500, error: 'boom' } },
    ]);
    expect(failed.accepted).toHaveLength(1);
    const turn = tx.getTurn('t1');
    expect(turn?.durationMs).toBe(1500);
    expect(turn?.error).toBe('boom');
  });

  it('tool frames keep streamed inputText, progress, timestamps, and interrupted state', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    const streamed = (frame: Partial<ToolCallFrame> & Pick<ToolCallFrame, 'inputText' | 'state'>): TranscriptOperation => ({
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool', frameId: 't1.1.call_1', toolCallId: 'call_1', name: 'Read',
        ...frame,
      },
    });
    expect(tx.apply([streamed({ inputText: '{"path"', state: 'running' })]).accepted).toHaveLength(1);
    tx.apply([streamed({ inputText: '{"path":"/a"}', state: 'running' })]);
    tx.apply([
      streamed({ inputText: '{"path":"/a"}', state: 'running', input: { path: '/a' } }),
      streamed({
        inputText: '{"path":"/a"}',
        state: 'running',
        input: { path: '/a' },
        progress: { kind: 'progress', percent: 50 },
      }),
    ]);
    tx.apply([
      streamed({
        inputText: '{"path":"/a"}',
        state: 'interrupted',
        input: { path: '/a' },
        progress: { kind: 'progress', percent: 50 },
        startedAt: '2026-08-31T00:00:00.000Z',
        endedAt: '2026-08-31T00:00:02.000Z',
      }),
    ]);
    const frame = tx.getTurn('t1')?.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: '/a' });
    expect(frame?.kind === 'tool' && frame.inputText).toBe('{"path":"/a"}');
    expect(frame?.kind === 'tool' && frame.progress).toEqual({ kind: 'progress', percent: 50 });
    expect(frame?.kind === 'tool' && frame.state).toBe('interrupted');
    expect(frame?.kind === 'tool' && frame.startedAt).toBe('2026-08-31T00:00:00.000Z');
    expect(frame?.kind === 'tool' && frame.endedAt).toBe('2026-08-31T00:00:02.000Z');
  });

  it('task upserts carry resultSummary/error/stateReason/usage', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'subagent', state: 'running', detached: false, outputTail: '' } },
    ]);
    const done = tx.apply([
      {
        op: 'task.upsert',
        task: {
          taskId: 'task1', kind: 'subagent', state: 'completed', detached: false, outputTail: '',
          resultSummary: 'scanned 12 files',
          usage: { inputOther: 100, output: 40, inputCacheRead: 10, inputCacheCreation: 5 },
        },
      },
    ]);
    expect(done.accepted).toHaveLength(1);
    const task = tx.getTask('task1');
    expect(task?.resultSummary).toBe('scanned 12 files');
    expect(task?.usage?.inputOther).toBe(100);
  });

  it('items.remove clears anchored interactions and their pending entries', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool',
          frameId: 't1.1.call-9',
          toolCallId: 'call-9',
          name: 'Bash',
          state: 'running',
        },
      },
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'appr-9',
          interactionKind: 'approval',
          toolCallId: 'call-9',
          state: 'pending',
        },
      },
    ]);
    expect(tx.listPendingInteractions()).toEqual(['appr-9']);
    tx.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(tx.getItems()).toHaveLength(0);
    expect(tx.getInteraction('appr-9')).toBeUndefined();
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('receive() equals full reset seed; snapshot windowing keeps newest turns', () => {
    const tx = new AgentTranscript('main');
    for (let n = 1; n <= 5; n += 1) {
      tx.apply([
        { op: 'marker.upsert', item: { kind: 'marker', markerId: `m${n}`, marker: 'goal' } },
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'completed', origin: { kind: 'user' } },
        },
      ]);
    }
    const snapshot = tx.snapshot({ tailTurns: 2 });
    expect(snapshot.hasMoreOlder).toBe(true);
    expect(snapshot.items.filter((i) => i.kind === 'turn').map((i) => i.kind === 'turn' && i.turnId)).toEqual(['t4', 't5']);
    expect(snapshot.items.filter((i) => i.kind === 'marker').length).toBeGreaterThan(0);

    const fresh = new AgentTranscript('main');
    fresh.receive([{ op: 'reset', agentId: 'main', snapshot }]);
    expect(fresh.getItems()).toEqual(snapshot.items);
    expect(fresh.hasMoreOlder).toBe(true);
  });

  it('onChange emits accepted ops once per apply batch', () => {
    const tx = new AgentTranscript('main');
    const seen: string[] = [];
    tx.onChange((event) => {
      seen.push(...event.ops.map((op) => op.op));
    });
    tx.apply([turn1, turn1]);
    expect(seen).toEqual(['turn.upsert']);
  });

  it('rejects structurally equal facts and preserves unchanged references', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: {
          ...turn1.turn,
          origin: { kind: 'user', payload: { promptId: 'p1' } },
          attachmentIds: ['a1'],
          usage: { inputTokens: 1 },
        },
      },
    ]);
    const before = tx.getTurn('t1');
    const accepted = tx.apply([
      {
        op: 'turn.upsert',
        turn: {
          ...turn1.turn,
          origin: { kind: 'user', payload: { promptId: 'p1' } },
          attachmentIds: ['a1'],
          usage: { inputTokens: 1 },
        },
      },
    ]);
    expect(accepted.accepted).toEqual([]);
    expect(tx.getTurn('t1')).toBe(before);
  });

  it('rejects structurally equal marker and taskref upserts without notifying', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm1', marker: 'goal', payload: { status: 'active' } },
      },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: 'r1', taskId: 'task-1', at: '2026-01-01T00:00:00.000Z' },
      },
    ]);
    const [marker, taskref] = tx.getItems();
    const seen: TranscriptOperation[][] = [];
    tx.onChange((event) => seen.push([...event.ops]));
    const result = tx.apply([
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm1', marker: 'goal', payload: { status: 'active' } },
      },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: 'r1', taskId: 'task-1', at: '2026-01-01T00:00:00.000Z' },
      },
    ]);
    expect(result.accepted).toEqual([]);
    expect(tx.getItems()[0]).toBe(marker);
    expect(tx.getItems()[1]).toBe(taskref);
    expect(seen).toEqual([]);
  });

  it('reconciles a tail reset in place and clears detail on grade downgrade', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' } },
      },
      turn1,
      doneThinking,
    ]);
    const older = tx.getTurn('t0');
    tx.apply([
      {
        op: 'reset',
        agentId: 'main',
        grade: 'turn',
        coverage: { kind: 'tail', fromTurnId: 't1', throughTurnId: 't1', hasMoreOlder: true },
        snapshot: {
          items: [{ ...turn1.turn, kind: 'turn', steps: [] }],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: {},
          hasMoreOlder: true,
        },
      },
    ]);
    expect(tx.getTurn('t0')).toBe(older);
    expect(tx.getTurn('t1')?.steps).toEqual([]);
    expect(tx.hasMoreOlder).toBe(true);
  });

  it('keeps a global tool-call count across windows and partial reset pages', () => {
    const source = new AgentTranscript('main');
    source.apply([
      {
        op: 'turn.upsert',
        turn: { ...turn1.turn, turnId: 't0', ordinal: 0 },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: { kind: 'tool', frameId: 't0.1.call_0', toolCallId: 'call_0', name: 'Read', state: 'done' },
      },
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'tool', frameId: 't1.1.call_2', toolCallId: 'call_2', name: 'Bash', state: 'done' },
      },
    ]);
    expect(source.snapshot().toolCallCount).toBe(2);
    const tail = source.snapshot({ tailTurns: 1 });
    expect(tail.toolCallCount).toBe(2);

    const client = new AgentTranscript('main');
    const tailReset: TranscriptOperation = {
      op: 'reset',
      agentId: 'main',
      coverage: { kind: 'tail', fromTurnId: 't1', throughTurnId: 't1', hasMoreOlder: true },
      snapshot: { ...tail, toolCallCount: 5 },
    };
    client.receive([tailReset]);
    expect(client.snapshot().toolCallCount).toBe(5);
    expect(client.receive([tailReset]).accepted).toEqual([]);

    const olderReset: TranscriptOperation = {
      op: 'reset',
      agentId: 'main',
      coverage: { kind: 'tail', fromTurnId: 't0', throughTurnId: 't0', hasMoreOlder: true },
      snapshot: { ...tail, items: [source.getTurn('t0')!], toolCallCount: 5 },
    };
    client.receive([olderReset]);
    expect(client.snapshot().toolCallCount).toBe(5);
    expect(client.receive([olderReset]).accepted).toEqual([]);

    client.apply([
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: { kind: 'tool', frameId: 't0.1.call_1', toolCallId: 'call_1', name: 'Write', state: 'running' },
      },
    ]);
    expect(client.snapshot().toolCallCount).toBe(6);
    client.receive([olderReset]);
    expect(client.snapshot().toolCallCount).toBe(5);
  });

  it('distinguishes a genuine empty count from an unknown partial tail', () => {
    const empty = new AgentTranscript('main');
    expect(empty.snapshot().toolCallCount).toBe(0);
    empty.receive([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: {},
        },
      },
    ]);
    expect(empty.snapshot().toolCallCount).toBe(0);

    const redacted = new AgentTranscript('main');
    redacted.receive([{
      op: 'reset',
      agentId: 'main',
      grade: 'turn',
      coverage: { kind: 'full', hasMoreOlder: false },
      snapshot: { ...empty.snapshot(), toolCallCount: undefined, toolCallCountKnown: false },
    }]);
    expect(redacted.snapshot().toolCallCount).toBeUndefined();

    const visible = new AgentTranscript('main');
    visible.apply(toolFrame('running'));
    const tail = visible.snapshot({ tailTurns: 1 });
    const derived = new AgentTranscript('main');
    derived.receive([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: {
          items: tail.items,
          tasks: tail.tasks,
          interactions: tail.interactions,
          attachments: tail.attachments,
          todos: tail.todos,
          prompts: tail.prompts,
          meta: tail.meta,
        },
      },
    ]);
    expect(derived.snapshot().toolCallCount).toBe(1);

    const unknownTail = new AgentTranscript('main');
    unknownTail.receive([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'tail', fromTurnId: 't1', throughTurnId: 't1', hasMoreOlder: true },
        snapshot: {
          items: tail.items,
          tasks: tail.tasks,
          interactions: tail.interactions,
          attachments: tail.attachments,
          todos: tail.todos,
          prompts: tail.prompts,
          meta: tail.meta,
          hasMoreOlder: true,
        },
      },
    ]);
    expect(unknownTail.snapshot().toolCallCount).toBeUndefined();

    const unknownRemoval = unknownTail.apply([{ op: 'items.remove', ids: ['t0'] }]);
    expect(unknownRemoval.toolCallCountDelta).toBeUndefined();
    expect(unknownTail.snapshot().toolCallCount).toBeUndefined();
  });

  it('updates known counts only for tool transitions and visible removals', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    expect(tx.snapshot().toolCallCount).toBe(1);

    tx.apply([toolFrame('done')[2]!]);
    expect(tx.snapshot().toolCallCount).toBe(1);
    tx.apply([
      { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: { kind: 'text', frameId: 'non-tool', role: 'assistant', text: 'text' } },
      { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: { kind: 'thinking', frameId: 'non-tool', text: 'thinking' } },
    ]);
    expect(tx.snapshot().toolCallCount).toBe(1);

    tx.apply([
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.call_1', role: 'assistant', text: 'replacement' },
      },
    ]);
    expect(tx.snapshot().toolCallCount).toBe(0);

    tx.apply([toolFrame('running')[2]!]);
    expect(tx.snapshot().toolCallCount).toBe(1);
    tx.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(tx.snapshot().toolCallCount).toBe(0);
    expect(tx.apply([{ op: 'items.remove', ids: ['t1'] }]).accepted).toEqual([]);

    const partial = new AgentTranscript('main');
    const partialSnapshot = new AgentTranscript('main');
    partialSnapshot.apply(toolFrame('running'));
    partial.receive([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'tail', fromTurnId: 't1', throughTurnId: 't1', hasMoreOlder: true },
        snapshot: { ...partialSnapshot.snapshot({ tailTurns: 1 }), toolCallCount: 3 },
      },
    ]);
    partial.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(partial.snapshot().toolCallCount).toBe(2);
    partial.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(partial.snapshot().toolCallCount).toBe(2);
  });

  it('STAT-R2 applies authoritative count sets and keeps frame deltas exact', () => {
    const tx = new AgentTranscript('main');
    expect(tx.apply([{ op: 'tool.count.set', count: undefined }]).toolCallCountDelta).toBeUndefined();
    expect(tx.snapshot()).toMatchObject({ toolCallCount: undefined, toolCallCountKnown: false });
    const set = tx.apply([{ op: 'tool.count.set', count: 7 }]);
    expect(set.toolCallCountDelta).toBeUndefined();
    expect(tx.snapshot()).toMatchObject({ toolCallCount: 7, toolCallCountKnown: true });
    expect(tx.getItems()).toEqual([]);
    const repeatedSet = tx.apply([{ op: 'tool.count.set', count: 7 }]);
    expect(repeatedSet.toolCallCountDelta).toBeUndefined();
    expect(repeatedSet.accepted).toEqual([]);

    const added = tx.apply(toolFrame('running'));
    expect(added.toolCallCountDelta).toBe(1);
    expect(tx.snapshot().toolCallCount).toBe(8);
    const repeated = tx.apply([toolFrame('running')[2]!]);
    expect(repeated.toolCallCountDelta).toBe(0);
    expect(repeated.accepted).toEqual([]);

    const removed = tx.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(removed.toolCallCountDelta).toBe(-1);
    expect(tx.snapshot().toolCallCount).toBe(7);
    const repeatedRemoval = tx.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(repeatedRemoval.toolCallCountDelta).toBe(0);
    expect(repeatedRemoval.accepted).toEqual([]);
    expect(tx.snapshot().toolCallCount).toBe(7);

    const transitions = new AgentTranscript('main');
    expect(transitions.apply(toolFrame('running')).toolCallCountDelta).toBe(1);
    expect(transitions.apply([toolFrame('done')[2]!]).toolCallCountDelta).toBe(0);
    expect(
      transitions.apply([
        {
          op: 'frame.upsert',
          turnId: 't1',
          stepId: 't1.1',
          frame: { kind: 'text', frameId: 't1.1.call_1', role: 'assistant', text: 'text' },
        },
      ]).toolCallCountDelta,
    ).toBe(-1);
    expect(
      transitions.apply([
        { op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: { kind: 'thinking', frameId: 't1.1.call_1', text: 'thinking' } },
      ]).toolCallCountDelta,
    ).toBe(0);
    expect(transitions.apply([toolFrame('running')[2]!]).toolCallCountDelta).toBe(1);
  });

  it('STAT-R2 remembers unknown removals across a later authoritative baseline', () => {
    const tx = new AgentTranscript('main');
    tx.apply([{ op: 'reset', agentId: 'main', coverage: { kind: 'tail', hasMoreOlder: true },
      snapshot: { ...tx.snapshot(), toolCallCount: undefined, toolCallCountKnown: false, hasMoreOlder: true } }]);
    expect(tx.apply([{ op: 'items.remove', ids: ['hidden'] }]).toolCallCountDelta).toBeUndefined();
    expect(tx.apply([{ op: 'items.remove', ids: ['hidden'] }]).toolCallCountDelta).toBe(0);
    tx.apply([{ op: 'tool.count.set', count: 7 }]);
    expect(tx.apply([{ op: 'items.remove', ids: ['hidden'] }]).accepted).toEqual([]);
    expect(tx.snapshot().toolCallCount).toBe(7);
    tx.apply([{ op: 'items.remove', ids: Array.from({ length: 2049 }, (_, i) => `removed-${i}`) }]);
    tx.apply([{ op: 'tool.count.set', count: 7 }]);
    expect(tx.apply([{ op: 'items.remove', ids: ['removed-2048'] }]).toolCallCountDelta).toBe(0);
    expect(tx.snapshot().toolCallCount).toBe(7);
    tx.apply([{ op: 'items.remove', ids: ['hidden'] }]);
    expect(tx.snapshot().toolCallCount).toBeUndefined();
  });

  it('STAT-R3 keeps unknown resets unknown and poisons mixed batch deltas', () => {
    const unknown = new AgentTranscript('main');
    const unknownReset = unknown.apply([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: { ...unknown.snapshot(), toolCallCount: undefined, toolCallCountKnown: false },
      },
    ]);
    expect(unknownReset.toolCallCountDelta).toBeUndefined();
    expect(unknown.snapshot()).toMatchObject({ toolCallCount: undefined, toolCallCountKnown: false });

    const realEmpty = new AgentTranscript('main');
    realEmpty.apply([{ op: 'tool.count.set', count: undefined }]);
    const emptyReset = realEmpty.apply([
      {
        op: 'reset',
        agentId: 'main',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: { ...new AgentTranscript('main').snapshot(), toolCallCount: 0, toolCallCountKnown: true },
      },
    ]);
    expect(emptyReset.toolCallCountDelta).toBeUndefined();
    expect(realEmpty.snapshot()).toMatchObject({ toolCallCount: 0, toolCallCountKnown: true });

    const mixed = new AgentTranscript('main');
    const mixedResult = mixed.apply([
      { op: 'tool.count.set', count: 7 },
      ...toolFrame('running'),
    ]);
    expect(mixedResult.toolCallCountDelta).toBeUndefined();
    expect(mixed.snapshot()).toMatchObject({ toolCallCount: 8, toolCallCountKnown: true });
  });

  it('task upsert + append keeps output tail globally, detached flips freely', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      { op: 'append', target: { type: 'task', taskId: 'task1' }, offset: 0, text: 'line1\n' },
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: true, outputTail: 'line1\n' } },
    ]);
    const task = tx.getTask('task1');
    expect(task?.detached).toBe(true);
    expect(task?.outputTail).toBe('line1\n');
  });

  it('meta.merge merges goal/modes shallowly', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'meta.merge', meta: { goal: { objective: 'ship it', status: 'active' } } },
      { op: 'meta.merge', meta: { modes: { plan: { reviewPath: '/p' } } } },
    ]);
    expect(tx.getMeta().goal?.status).toBe('active');
    expect(tx.getMeta().modes?.plan?.reviewPath).toBe('/p');
  });

  it('meta.merge clears a mode badge on null and keeps absent keys', () => {
    const tx = new AgentTranscript('main');
    tx.apply([{ op: 'meta.merge', meta: { modes: { plan: {}, swarm: {} } } }]);
    tx.apply([{ op: 'meta.merge', meta: { modes: { plan: null } } }]);
    expect(tx.getMeta().modes).toEqual({ swarm: {} });
    tx.apply([{ op: 'meta.merge', meta: { modes: { swarm: null } } }]);
    expect(tx.getMeta().modes).toBeUndefined();
  });

  it('meta.merge projects and clears the recovery queue hold', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'meta.merge', meta: { promptQueueHold: { reason: 'recovery', count: 2 } } },
    ]);
    expect(tx.getMeta().promptQueueHold).toEqual({ reason: 'recovery', count: 2 });
    tx.apply([{ op: 'meta.merge', meta: { promptQueueHold: null } }]);
    expect(tx.getMeta().promptQueueHold).toBeUndefined();
  });

  it('meta.merge shallow-merges the agent status key one level deep', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'meta.merge', meta: { agent: { model: 'k2', permission: 'auto' } } },
      { op: 'meta.merge', meta: { agent: { contextTokens: 1234 } } },
    ]);
    expect(tx.getMeta().agent).toEqual({ model: 'k2', permission: 'auto', contextTokens: 1234 });

    tx.apply([
      { op: 'meta.merge', meta: { agent: { model: 'k3', phase: { kind: 'idle' } } } },
    ]);
    expect(tx.getMeta().agent).toEqual({
      model: 'k3',
      permission: 'auto',
      contextTokens: 1234,
      phase: { kind: 'idle' },
    });

    tx.apply([{ op: 'meta.merge', meta: { activity: 'turn' } }]);
    expect(tx.getMeta().agent?.model).toBe('k3');
    expect(tx.getMeta().activity).toBe('turn');
  });

  it('snapshot immutability: later applies do not mutate earlier reads', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    const before = tx.getItems();
    tx.apply(toolFrame('done', 'content'));
    const beforeFrame = before[0]?.kind === 'turn' ? before[0].steps[0]?.frames[0] : undefined;
    expect(beforeFrame?.kind === 'tool' && beforeFrame.state).toBe('running');
  });

  it('places anchored standalone items before their following turn, not at the end', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'user' } },
      },
    ]);
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm1', marker: 'skill' },
        beforeTurn: 1,
      },
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: 'r1', taskId: 'bash-1' },
        beforeTurn: 2,
      },
    ]);
    expect(tx.getItems().map(itemLabel)).toEqual(['t0', 'm1', 't1', 'r1', 't2']);
  });

  it('anchors a standalone item before the very first turn; re-applies stay in place', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm0', marker: 'compaction' },
        beforeTurn: 0,
      },
    ]);
    expect(tx.getItems()[0]?.kind).toBe('marker');
    tx.apply([
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm0', marker: 'compaction', payload: { v: 1 } },
        beforeTurn: 0,
      },
    ]);
    const items = tx.getItems();
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('marker');
  });

  it('appends standalone items without an anchor at the end (live order)', () => {
    const tx = new AgentTranscript('main');
    tx.apply([turn1, { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm9', marker: 'notice' } }]);
    const items = tx.getItems();
    expect(items.at(-1)?.kind).toBe('marker');
  });

  it('re-applies tool frames when metadata-only fields change', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    const corrected: TranscriptOperation[] = [
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool',
          frameId: 't1.1.call_1',
          toolCallId: 'call_1',
          name: 'Read',
          state: 'running',
          input: { path: '/b' },
        } satisfies ToolCallFrame,
      },
    ];
    tx.apply(corrected);
    const turn = tx.getTurn('t1');
    const frame = turn?.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: '/b' });
  });
});

describe('TranscriptStore', () => {
  it('lazily creates agent transcripts and tracks the roster', () => {
    const store = new TranscriptStore('s1');
    expect(store.getAgent('main')).toBeUndefined();
    const tx = store.ensureAgent('main', { agentId: 'main', type: 'main' });
    expect(store.getAgent('main')).toBe(tx);
    const rosters: number[] = [];
    store.onRosterChange((agents) => rosters.push(agents.length));
    store.ensureAgent('sub-1', { agentId: 'sub-1', type: 'sub', parentAgentId: 'main' });
    store.removeAgent('sub-1');
    expect(rosters).toEqual([2, 1]);
    expect(store.agents().map((a) => a.agentId)).toEqual(['main']);
  });

  it('markDisposed stamps disposedAt on the existing descriptor only', () => {
    const store = new TranscriptStore('s1');
    store.ensureAgent('main', { agentId: 'main', type: 'main' });

    store.markDisposed('ghost', '2026-07-20T00:00:00.000Z');
    expect(store.agents().map((a) => a.agentId)).toEqual(['main']);

    const rosters: Array<readonly string[]> = [];
    store.onRosterChange((agents) => rosters.push(agents.map((a) => a.agentId)));
    store.markDisposed('main', '2026-07-20T01:00:00.000Z');
    expect(rosters).toEqual([['main']]);
    expect(store.agents()[0]).toMatchObject({
      agentId: 'main',
      type: 'main',
      disposedAt: '2026-07-20T01:00:00.000Z',
    });

    store.markDisposed('main', '2026-07-20T02:00:00.000Z');
    expect(store.agents()[0]?.disposedAt).toBe('2026-07-20T01:00:00.000Z');
    expect(rosters).toHaveLength(1);
  });

  it('keeps an external delegation descriptor independent of main', () => {
    const store = new TranscriptStore('s1');
    store.ensureAgent('external-child', {
      agentId: 'external-child',
      type: 'independent',
      delegator: { kind: 'external', delegationId: 'delegation_test' },
    });

    expect(store.agents()).toEqual([
      {
        agentId: 'external-child',
        type: 'independent',
        delegator: { kind: 'external', delegationId: 'delegation_test' },
      },
    ]);
    expect(store.agents()[0]?.parentAgentId).toBeUndefined();
  });
});
