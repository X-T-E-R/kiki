import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentTaskService,
  IEventBus,
  ISessionIndex,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionLifecycleService,
  ISessionManager,
  IWorkspaceInstanceManager,
  LifecycleScope,
  SessionInteractionService,
  StateRegistry,
  type Event2,
  type ISessionScopeHandle,
  type ISessionStateService,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  type AgentTranscriptSnapshot,
  type AppendOp,
  type FrameUpsertOp,
  type InteractionUpsertOp,
  type TranscriptFrame,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTurn,
  type TranscriptWireRecord,
} from '@kiki/transcript';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentTranscriptLiveAdapter,
  bindSessionTranscript,
  type LiveAdapterBusEvent,
} from '../src';

function ev(payload: Record<string, unknown>): LiveAdapterBusEvent {
  return payload as unknown as LiveAdapterBusEvent;
}

class TestSessionStateService extends StateRegistry implements ISessionStateService {
  declare readonly _serviceBrand: undefined;
}

function turnOps(turnId: string, items: ReturnType<AgentTranscript['getItems']>): TranscriptTurn {
  const turn = items.find(
    (item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId,
  );
  if (turn === undefined) throw new Error(`turn ${turnId} not found`);
  return turn;
}

describe('AgentTranscriptLiveAdapter', () => {
  it('maps queued and replaced prompts onto prompt.upsert facts', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const queued = liveAdapter.map(
      ev({ type: 'prompt.queued', promptId: 'p1', content: [{ type: 'text', text: 'later' }], queueLength: 1 }),
    );
    expect(queued).toEqual([
      expect.objectContaining({
        op: 'prompt.upsert',
        prompt: expect.objectContaining({ promptId: 'p1', status: 'queued' }),
      }),
    ]);
    const replaced = liveAdapter.map(
      ev({
        type: 'prompt.replaced',
        promptId: 'p1',
        content: [{ type: 'text', text: 'now' }],
        replacedAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    expect(replaced[0]).toMatchObject({
      op: 'prompt.upsert',
      prompt: { promptId: 'p1', status: 'queued' },
    });
  });

  it('maps recovery hold changes onto transcript meta', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    expect(
      liveAdapter.map(
        ev({
          type: 'prompt.queue_hold_changed',
          hold: { reason: 'recovery', count: 2 },
        }),
      ),
    ).toEqual([
      { op: 'meta.merge', meta: { promptQueueHold: { reason: 'recovery', count: 2 } } },
    ]);
    expect(liveAdapter.map(ev({ type: 'prompt.queue_hold_changed', hold: null }))).toEqual([
      { op: 'meta.merge', meta: { promptQueueHold: null } },
    ]);
  });

  it('carries deferred-append timing and revision through the queue lifecycle', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'prompt.queued',
        promptId: 'p1',
        content: [{ type: 'text', text: 'later' }],
        queueLength: 1,
        appendTiming: 'tasks_done',
        revision: 1,
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({ status: 'queued', appendTiming: 'tasks_done', revision: 1 });

    feed(
      ev({
        type: 'prompt.timing_changed',
        promptId: 'p1',
        appendTiming: 'subagents_done',
        revision: 2,
        changedAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({
      status: 'queued',
      appendTiming: 'subagents_done',
      revision: 2,
      content: [{ type: 'text', text: 'later' }],
    });

    const replaced = tx.apply(
      liveAdapter.map(
        ev({
          type: 'prompt.replaced',
          promptId: 'p1',
          content: [{ type: 'text', text: 'now' }],
          replacedAt: '2026-01-01T00:00:02.000Z',
          appendTiming: 'subagents_done',
          revision: 3,
        }),
      ),
    );
    expect(replaced.accepted.length).toBe(1);
    expect(tx.getPrompt('p1')).toMatchObject({ appendTiming: 'subagents_done', revision: 3 });

    feed(ev({ type: 'prompt.started', promptId: 'p1' }));
    expect(tx.getPrompt('p1')).toMatchObject({ status: 'running', appendTiming: 'subagents_done', revision: 3 });
  });

  it('projects a full turn: headers, delta appends, flush, tool frames', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const ops: TranscriptOperation[] = [];
    const feed = (event: LiveAdapterBusEvent): void => {
      const mapped = liveAdapter.map(event);
      ops.push(...mapped);
      tx.apply(mapped);
    };

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'u1' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
    feed(
      ev({
        type: 'tool.call.started',
        time: 1_700_000_001_000,
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        args: '{"command":"ls"}',
        display: { kind: 'command', command: 'ls' },
      }),
    );
    feed(
      ev({
        type: 'tool.result',
        time: 1_700_000_003_000,
        turnId: 1,
        toolCallId: 'call_1',
        output: 'file.txt',
      }),
    );
    feed(ev({ type: 'turn.step.completed', turnId: 1, step: 1, stepId: 'u1' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const appends = ops.filter((op): op is AppendOp => op.op === 'append');
    expect(appends.map((op) => [op.offset, op.text])).toEqual([
      [0, 'Hello'],
      [5, ' world'],
    ]);
    const upserts = ops.filter((op): op is FrameUpsertOp => op.op === 'frame.upsert');
    const flushUpsert = upserts.find(
      (op) => op.frame.kind === 'text' && op.frame.text === 'Hello world',
    );
    expect(flushUpsert).toBeDefined();

    const turn = turnOps('t1', tx.getItems());
    expect(turn.state).toBe('completed');
    expect(turn.origin).toEqual({ kind: 'user', payload: { kind: 'user' } });
    expect(turn.endedAt).toBeTypeOf('string');
    expect(turn.steps).toHaveLength(1);
    const step = turn.steps[0]!;
    expect(step.state).toBe('completed');
    const text = step.frames.find((frame) => frame.kind === 'text');
    expect(text).toMatchObject({ role: 'assistant', text: 'Hello world' });
    const tool = step.frames.find((frame) => frame.kind === 'tool');
    expect(tool).toMatchObject({
      frameId: 'u1.call_1',
      toolCallId: 'call_1',
      name: 'Bash',
      state: 'done',
      input: { command: 'ls' },
      output: 'file.txt',
      display: { kind: 'command', command: 'ls' },
      startedAt: '2023-11-14T22:13:21.000Z',
      endedAt: '2023-11-14T22:13:23.000Z',
    });
  });

  it('projects the live prompt from turn.started and keeps it through turn.ended', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => {
      tx.apply(liveAdapter.map(event));
    };

    feed(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'fix the bug' }));
    feed(ev({ type: 'assistant.delta', turnId: 0, delta: 'on it' }));
    feed(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

    const turn = turnOps('t0', tx.getItems());
    expect(turn.prompt).toBe('fix the bug');
    expect(turn.state).toBe('completed');
  });

  it('projects a parent-agent message on a subagent turn', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('agent-1');
    const tx = new AgentTranscript('agent-1');

    tx.apply(
      liveAdapter.map(
        ev({
          type: 'turn.started',
          turnId: 0,
          origin: { kind: 'system_trigger', name: 'subagent' },
          prompt: 'inspect the renderer',
        }),
      ),
    );

    expect(turnOps('t0', tx.getItems())).toMatchObject({
      prompt: 'inspect the renderer',
      origin: {
        kind: 'other',
        payload: { kind: 'system_trigger', name: 'subagent' },
      },
    });
  });

  it('projects turn.started promptAttachments into attachment entities and turn.attachmentIds', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const ops: TranscriptOperation[] = [];
    const feed = (event: LiveAdapterBusEvent): void => {
      const mapped = liveAdapter.map(event);
      ops.push(...mapped);
      tx.apply(mapped);
    };

    feed(
      ev({
        type: 'turn.started',
        turnId: 0,
        origin: { kind: 'user' },
        prompt: 'what is this?',
        promptAttachments: [{ kind: 'image', fileId: 'file_1', name: 'photo.png' }],
      }),
    );
    feed(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

    expect(ops.filter((op) => op.op === 'attachment.upsert')).toEqual([
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: 't0.att1',
          mediaType: 'image/*',
          name: 'photo.png',
          source: { kind: 'session_media', fileId: 'file_1' },
          owner: { kind: 'turn', turnId: 't0' },
        },
      },
    ]);

    const turn = turnOps('t0', tx.getItems());
    expect(turn.prompt).toBe('what is this?');
    expect(turn.attachmentIds).toEqual(['t0.att1']);
    expect(tx.getAttachment('t0.att1')).toEqual({
      attachmentId: 't0.att1',
      mediaType: 'image/*',
      name: 'photo.png',
      source: { kind: 'session_media', fileId: 'file_1' },
      owner: { kind: 'turn', turnId: 't0' },
    });
  });

  it('places late-attach deltas into the engine-reported active step', () => {
    const tx = new AgentTranscript('main');
    const liveAdapter = new AgentTranscriptLiveAdapter('main', {
      stepOrdinal: (turnId) => (turnId === 't0' ? 2 : undefined),
    });

    const ops = liveAdapter.map(ev({ type: 'assistant.delta', turnId: 0, delta: 'late' }));
    tx.apply(ops);

    const turn = turnOps('t0', tx.getItems());
    expect(turn.steps.map((s) => s.stepId)).toEqual(['t0.2']);
    expect(turn.steps[0]?.frames[0]).toMatchObject({ kind: 'text', text: 'late' });
  });

  it('adopts a backfilled stream frame on mid-turn attach instead of clobbering it', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: { kind: 'text', frameId: 't0.1.f1', role: 'assistant', text: 'Hello ' },
      },
    ]);
    const liveAdapter = new AgentTranscriptLiveAdapter('main', {
      stepFrames: (turnId, stepId) =>
        tx.getTurn(turnId)?.steps.find((s) => s.stepId === stepId)?.frames,
    });

    const ops = liveAdapter.map(ev({ type: 'assistant.delta', turnId: 0, delta: 'world' }));
    tx.apply(ops);
    expect(ops.some((op) => op.op === 'frame.upsert')).toBe(false);
    const append = ops.find((op): op is AppendOp => op.op === 'append');
    expect(append && [append.offset, append.text]).toEqual([6, 'world']);
    const turn = turnOps('t0', tx.getItems());
    const text = turn.steps[0]?.frames.find((frame) => frame.kind === 'text');
    expect(text).toMatchObject({ text: 'Hello world' });

    const next = liveAdapter.map(ev({ type: 'thinking.delta', turnId: 0, delta: 'hmm' }));
    const created = next.find((op): op is FrameUpsertOp => op.op === 'frame.upsert');
    expect(created?.frame.frameId).toBe('t0.1.f2');
  });

  it('adopts a backfilled tool frame when the result arrives after a mid-bind attach', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: {
          kind: 'tool',
          frameId: 't0.1.call_1',
          toolCallId: 'call_1',
          name: 'Bash',
          state: 'running',
          input: { command: 'ls' },
        },
      },
    ]);
    const liveAdapter = new AgentTranscriptLiveAdapter('main', {
      toolFrame: (toolCallId) => {
        for (const item of tx.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            for (const frame of step.frames) {
              if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
                return { turnId: item.turnId, stepId: step.stepId, frame };
              }
            }
          }
        }
        return undefined;
      },
    });

    const ops = liveAdapter.map(ev({ type: 'tool.result', toolCallId: 'call_1', output: 'file.txt' }));
    expect(ops).toHaveLength(1);
    tx.apply(ops);
    const turn = turnOps('t0', tx.getItems());
    const tool = turn.steps[0]?.frames.find((frame) => frame.kind === 'tool');
    expect(tool).toMatchObject({ toolCallId: 'call_1', state: 'done', output: 'file.txt' });
  });

  it('adopts a seeded parent tool frame when subagent.spawned links the child', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: {
          kind: 'tool',
          frameId: 't0.1.call_agent',
          toolCallId: 'call_agent',
          name: 'Agent',
          state: 'running',
          input: { prompt: 'scan' },
        },
      },
    ]);
    const liveAdapter = new AgentTranscriptLiveAdapter('main', {
      toolFrame: (toolCallId) => {
        for (const item of tx.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            for (const frame of step.frames) {
              if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
                return { turnId: item.turnId, stepId: step.stepId, frame };
              }
            }
          }
        }
        return undefined;
      },
    });

    const ops = liveAdapter.map(
      ev({
        type: 'subagent.spawned',
        time: 1_700_000_000_000,
        subagentId: 'agent-1',
        subagentName: 'explore',
        name: 'smoke_explore',
        parentToolCallId: 'call_agent',
        runInBackground: false,
      }),
    );
    tx.apply(ops);
    const turn = turnOps('t0', tx.getItems());
    const tool = turn.steps[0]?.frames.find((frame) => frame.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.agentRefs).toEqual([{ agentId: 'agent-1', role: 'child' }]);
    expect(tx.getTask('agent-1')).toMatchObject({
      name: 'smoke_explore',
      subagentName: 'explore',
    });
  });

  it('keeps anonymous subagent profile names display-only', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      liveAdapter.map(
        ev({
          type: 'subagent.spawned',
          time: 1_700_000_000_000,
          subagentId: 'agent-named',
          subagentName: 'coder',
          name: 'coder',
          parentToolCallId: 'call-named',
          runInBackground: false,
          taskId: 'task-named',
        }),
      ),
    );
    tx.apply(
      liveAdapter.map(
        ev({
          type: 'subagent.spawned',
          time: 1_700_000_001_000,
          subagentId: 'agent-anonymous',
          subagentName: 'coder',
          parentToolCallId: 'call-anonymous',
          runInBackground: false,
          taskId: 'task-anonymous',
        }),
      ),
    );

    expect(tx.getTask('task-named')).toMatchObject({
      name: 'coder',
      subagentName: 'coder',
      agentId: 'agent-named',
    });
    expect(tx.getTask('task-anonymous')).toMatchObject({
      name: undefined,
      subagentName: 'coder',
      agentId: 'agent-anonymous',
    });
  });

  it('gives live markers their own namespace so they never collide with backfilled markers', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    tx.apply([{ op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'skill' } }]);

    const ops = liveAdapter.map(ev({ type: 'compaction.started', trigger: 'auto' }));
    tx.apply(ops);

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers.map((m) => [m.markerId, m.marker])).toEqual([
      ['m1', 'skill'],
      ['live-m1', 'compaction'],
    ]);
  });

  it('flushes open frames on turn.ended even without step completion', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(ev({ type: 'thinking.delta', turnId: 1, delta: 'hmm' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: 'partial' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'cancelled' }));

    const turn = turnOps('t1', tx.getItems());
    expect(turn.state).toBe('cancelled');
    const step = turn.steps[0]!;
    expect(step.state).toBe('interrupted');
    expect(step.frames).toContainEqual(
      expect.objectContaining({ kind: 'thinking', text: 'hmm' }),
    );
    expect(step.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'partial' }),
    );
  });

  it('closes every running tool frame in the turn when turn.ended arrives', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'c1', name: 'Read', args: {} }));
    feed(ev({ type: 'turn.step.completed', turnId: 1, step: 1 }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    feed(ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'c2', name: 'Bash', args: {} }));
    feed(ev({ type: 'turn.ended', time: 1_700_000_005_000, turnId: 1, reason: 'cancelled' }));

    const tools = turnOps('t1', tx.getItems()).steps.flatMap((step) =>
      step.frames.filter((frame) => frame.kind === 'tool'),
    );
    expect(tools).toHaveLength(2);
    expect(tools).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        state: 'interrupted',
        endedAt: '2023-11-14T22:13:25.000Z',
      }),
      expect.objectContaining({
        toolCallId: 'c2',
        state: 'interrupted',
        endedAt: '2023-11-14T22:13:25.000Z',
      }),
    ]);
  });

  it('marks a user-cancelled turn with an interruption marker, but not programmatic aborts', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }));
    feed(
      ev({ type: 'turn.ended', turnId: 0, reason: 'cancelled', interruptReason: 'user_cancelled' }),
    );
    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'again' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'cancelled', interruptReason: 'aborted' }));
    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'legacy' }));
    feed(ev({ type: 'turn.ended', turnId: 2, reason: 'cancelled' }));

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      marker: 'interruption',
      payload: { turnId: 0, reason: 'user_cancelled' },
    });
  });

  it('carries usage / finishReason / the full timing breakdown on turn.step.completed', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 1,
        usage: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 40 },
        rawFinishReason: 'tool_calls',
        llmFirstTokenLatencyMs: 120,
        llmStreamDurationMs: 900,
        llmRequestBuildMs: 10,
        llmServerFirstTokenMs: 110,
        llmServerDecodeMs: 800,
        llmClientConsumeMs: 100,
      }),
    );

    const step = turnOps('t1', tx.getItems()).steps[0]!;
    expect(step.state).toBe('completed');
    expect(step.usage).toEqual({
      inputOther: 100,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    expect(step.finishReason).toBe('tool_calls');
    expect(step.timing).toEqual({
      llmFirstTokenLatencyMs: 120,
      llmStreamDurationMs: 900,
      llmRequestBuildMs: 10,
      llmServerFirstTokenMs: 110,
      llmServerDecodeMs: 800,
      llmClientConsumeMs: 100,
    });

    feed(ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 2,
        finishReason: 'stop',
        rawFinishReason: 'raw_stop',
        providerFinishReason: 'provider_stop',
      }),
    );
    expect(turnOps('t1', tx.getItems()).steps[1]!.finishReason).toBe('stop');
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 3 }));
    feed(
      ev({ type: 'turn.step.completed', turnId: 1, step: 3, providerFinishReason: 'length' }),
    );
    expect(turnOps('t1', tx.getItems()).steps[2]!.finishReason).toBe('length');
  });

  it('carries endReason / endMessage on turn.step.interrupted', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.interrupted',
        turnId: 1,
        step: 1,
        reason: 'aborted',
        message: 'user cancelled',
      }),
    );

    const step = turnOps('t1', tx.getItems()).steps[0]!;
    expect(step.state).toBe('interrupted');
    expect(step.endReason).toBe('aborted');
    expect(step.endMessage).toBe('user cancelled');
  });

  it('sets retry on turn.step.retrying and clears it at the terminal upsert', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));
    const step = (): TranscriptTurn['steps'][number] => turnOps('t1', tx.getItems()).steps[0]!;

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 2000,
        errorName: 'ProviderRateLimitError',
        errorMessage: '429 too many requests',
        statusCode: 429,
      }),
    );

    expect(step().state).toBe('running');
    expect(step().retry).toEqual({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
      errorName: 'ProviderRateLimitError',
      errorMessage: '429 too many requests',
      statusCode: 429,
    });

    feed(ev({ type: 'turn.step.completed', turnId: 1, step: 1 }));
    expect(step().state).toBe('completed');
    expect(step().retry).toBeUndefined();
  });

  it('fills durationMs / error / accumulated step usage on turn.ended', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 1,
        usage: { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 50 },
      }),
    );
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 2,
        usage: { inputOther: 200, output: 20, inputCacheRead: 0, inputCacheCreation: 25 },
      }),
    );
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 4200 }));

    const turn = turnOps('t1', tx.getItems());
    expect(turn.durationMs).toBe(4200);
    expect(turn.usage).toEqual({ inputTokens: 375, cachedTokens: 5, outputTokens: 30 });

    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
    feed(
      ev({
        type: 'turn.ended',
        turnId: 2,
        reason: 'failed',
        durationMs: 50,
        error: { code: 'internal', message: 'kaboom', retryable: false },
      }),
    );
    const failed = turnOps('t2', tx.getItems());
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('kaboom');
    expect(failed.usage).toBeUndefined();
  });

  it('takes the turn header endedAt from the turn.ended event time', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 1_700_000_000_000 }));
    expect(turnOps('t1', tx.getItems()).endedAt).toBe(new Date(1_700_000_000_000).toISOString());

    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.ended', turnId: 2, reason: 'completed' }));
    expect(turnOps('t2', tx.getItems()).endedAt).toBeTypeOf('string');
  });

  it('accumulates tool.call.delta into inputText, kept across tool.call.started', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));
    const toolFrame = (toolCallId: string): TranscriptFrame | undefined =>
      turnOps('t1', tx.getItems())
        .steps.flatMap((step) => step.frames)
        .find((frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Bash',
        argumentsPart: '{"comm',
      }),
    );
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c1', argumentsPart: 'and":"ls"}' }));
    expect(toolFrame('c1')).toMatchObject({
      kind: 'tool',
      frameId: 't1.1.c1',
      name: 'Bash',
      state: 'running',
      inputText: '{"command":"ls"}',
    });
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c2', argumentsPart: '{}' }));
    expect(toolFrame('c2')).toMatchObject({ name: '', inputText: '{}' });

    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Bash',
        args: { command: 'ls' },
      }),
    );
    expect(toolFrame('c1')).toMatchObject({
      input: { command: 'ls' },
      inputText: '{"command":"ls"}',
    });
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c1', argumentsPart: '\n' }));
    expect(toolFrame('c1')).toMatchObject({ inputText: '{"command":"ls"}\n' });
    feed(ev({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'file.txt' }));
    expect(toolFrame('c1')).toMatchObject({ state: 'done', inputText: '{"command":"ls"}\n' });
  });

  it('overwrites tool frame progress and drops progress for unknown calls', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    expect(
      liveAdapter.map(
        ev({
          type: 'tool.progress',
          turnId: 1,
          toolCallId: 'ghost',
          update: { kind: 'stdout', text: 'x' },
        }),
      ),
    ).toEqual([]);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'c1', name: 'Bash', args: {} }),
    );
    feed(
      ev({
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'c1',
        update: { kind: 'stdout', text: 'line1' },
      }),
    );
    const tool = (): TranscriptFrame | undefined =>
      turnOps('t1', tx.getItems()).steps[0]!.frames.find((frame) => frame.kind === 'tool');
    expect(tool()).toMatchObject({ progress: { kind: 'stdout', text: 'line1' } });

    feed(
      ev({
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'c1',
        update: { kind: 'progress', percent: 40 },
      }),
    );
    expect(tool()).toMatchObject({ progress: { kind: 'progress', percent: 40 } });
    expect((tool() as { progress?: Record<string, unknown> }).progress?.['text']).toBeUndefined();
  });

  it('marks tool.result errors and keeps the display payload', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Read',
        args: { path: '/x' },
        display: { kind: 'file', path: '/x' },
      }),
    );
    feed(ev({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'ENOENT', isError: true }));

    const tool = turnOps('t1', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({
      state: 'error',
      output: 'ENOENT',
      error: 'ENOENT',
      display: { kind: 'file', path: '/x' },
    });
  });

  it('projects process tasks as shell tasks with streaming output', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const ops: TranscriptOperation[] = [];
    const feed = (event: LiveAdapterBusEvent): void => {
      const mapped = liveAdapter.map(event);
      ops.push(...mapped);
      tx.apply(mapped);
    };

    const started = {
      taskId: 'bash-1',
      kind: 'process',
      description: 'ls -la',
      status: 'running',
      detached: false,
      lifetime: 'service' as const,
      ownerAgentId: 'main',
      ownerTurnId: 7,
      goalId: 'goal-1',
      startedAt: 1_700_000_000_000,
      endedAt: null,
    };
    feed(ev({ type: 'task.started', info: started }));
    feed(ev({ type: 'shell.started', commandId: 'cmd-1', taskId: 'bash-1' }));
    feed(ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'stdout', text: 'a\n' } }));
    feed(ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'stderr', text: 'b\n' } }));
    feed(
      ev({
        type: 'task.terminated',
        info: { ...started, status: 'completed', endedAt: 1_700_000_001_000 },
      }),
    );

    expect(ops.some((op) => op.op === 'taskref.upsert' && op.item.taskId === 'bash-1')).toBe(true);
    const appends = ops.filter((op): op is AppendOp => op.op === 'append');
    expect(appends.map((op) => [op.offset, op.text])).toEqual([
      [0, 'a\n'],
      [2, 'b\n'],
    ]);

    const task = tx.getTask('bash-1');
    expect(task).toMatchObject({
      kind: 'shell',
      state: 'completed',
      detached: false,
      lifetime: 'service',
      ownerAgentId: 'main',
      ownerTurnId: 7,
      goalId: 'goal-1',
      description: 'ls -la',
      outputTail: 'a\nb\n',
    });
    expect(
      liveAdapter.map(
        ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'progress', percent: 50 } }),
      ),
    ).toEqual([]);
  });

  it('fills the shell task output from late stderr chunks before completing', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(liveAdapter.map(ev({ type: 'shell.started', commandId: 'c1', taskId: 'task-1' })));
    tx.apply(
      liveAdapter.map(ev({ type: 'shell.output', commandId: 'c1', update: { kind: 'stderr', text: 'boom' } })),
    );
    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c1', isError: true })));

    expect(tx.getTask('task-1')).toMatchObject({ state: 'failed', outputTail: 'boom' });
  });

  it('routes shell output/completion via the event taskId when shell.started was missed', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      liveAdapter.map(
        ev({ type: 'shell.output', commandId: 'c1', taskId: 'task-1', update: { kind: 'stdout', text: 'hello' } }),
      ),
    );
    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'running', outputTail: 'hello' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'task-1' }));

    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c1', taskId: 'task-1', isError: false })));
    expect(tx.getTask('task-1')).toMatchObject({ state: 'completed', outputTail: 'hello' });
  });

  it('emits a taskref when only shell.completed arrives for a command', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c1', taskId: 'task-1', isError: true })));

    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'failed' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'task-1' }));
  });

  it('projects no-taskId shell failures under a synthetic per-command task id', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      liveAdapter.map(ev({ type: 'shell.output', commandId: 'c1', update: { kind: 'stderr', text: 'boom' } })),
    );
    expect(tx.getTask('shell-c1')).toMatchObject({ kind: 'shell', state: 'running', outputTail: 'boom' });

    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c1', isError: true })));
    expect(tx.getTask('shell-c1')).toMatchObject({ state: 'failed', outputTail: 'boom' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'shell-c1' }));
  });

  it('marks a foreground shell task terminal on shell.completed', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(liveAdapter.map(ev({ type: 'shell.started', commandId: 'c1', taskId: 'task-1' })));
    expect(tx.getTask('task-1')?.state).toBe('running');

    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c1', isError: false })));
    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'completed' });
    expect(tx.getTask('task-1')?.endedAt).toBeTypeOf('string');

    tx.apply(liveAdapter.map(ev({ type: 'shell.started', commandId: 'c2', taskId: 'task-2' })));
    tx.apply(liveAdapter.map(ev({ type: 'shell.completed', commandId: 'c2', isError: true })));
    expect(tx.getTask('task-2')?.state).toBe('failed');
  });

  it('ignores task.notified (it re-surfaces as an origin:task turn)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    expect(liveAdapter.map(ev({ type: 'task.notified', taskId: 't' }))).toEqual([]);
  });

  it('links spawned subagents to the spawning tool frame (member for swarm)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {},
      }),
    );
    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_700_000_000_000,
        subagentId: 'agent-0',
        subagentName: 'worker',
        parentToolCallId: 'call_swarm',
        description: 'scan the repo',
        swarmIndex: 0,
        runInBackground: false,
      }),
    );
    feed(ev({ type: 'subagent.completed', subagentId: 'agent-0', resultSummary: 'done' }));

    const tool = turnOps('t1', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({
      agentRefs: [{ agentId: 'agent-0', role: 'member' }],
    });
    const task = tx.getTask('agent-0');
    expect(task).toMatchObject({
      kind: 'subagent',
      state: 'completed',
      agentId: 'agent-0',
      description: 'scan the repo',
      detached: false,
    });
  });

  it('keys an Agent-tool subagent row by its registered task id and folds the lifecycle', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_700_000_000_000,
        subagentId: 'agent-1',
        subagentName: 'explore',
        parentToolCallId: 'call-1',
        description: 'Inspect files',
        runInBackground: true,
        taskId: 'task-9',
      }),
    );
    feed(
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-9',
          kind: 'agent',
          description: 'Inspect files',
          status: 'running',
          detached: true,
          agentId: 'agent-1',
          profile: 'explore',
          collaborationTaskName: 'inspect_files',
          startedAt: 1_700_000_000_000,
          endedAt: null,
        },
      }),
    );
    feed(ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }));
    feed(
      ev({
        type: 'task.terminated',
        info: {
          taskId: 'task-9',
          kind: 'agent',
          description: 'Inspect files',
          status: 'completed',
          detached: true,
          agentId: 'agent-1',
          profile: 'explore',
          collaborationTaskName: 'inspect_files',
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_001_000,
          receiptVerification: 'verified',
          receipt: {
            schemaVersion: 1, path: 'tasks/task-9/output.log',
            mediaType: 'text/plain; charset=utf-8', bytes: 200,
            sha256: 'a'.repeat(64), contentState: 'final',
            committedAt: '2026-06-04T10:01:00.000Z',
          },
        },
      }),
    );

    expect(tx.getTask('task-9')).toMatchObject({
      receiptVerification: 'verified',
      receipt: { path: 'tasks/task-9/output.log', bytes: 200 },
      kind: 'subagent',
      state: 'completed',
      agentId: 'agent-1',
      name: 'inspect_files',
      subagentName: 'explore',
      description: 'Inspect files',
      detached: true,
      resultSummary: 'done',
    });
    expect(tx.getTask('agent-1')).toBeUndefined();
  });

  it('drops the stale task mapping when a child respawns without a task id', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_700_000_000_000,
        subagentId: 'agent-1',
        subagentName: 'explore',
        parentToolCallId: 'call-1',
        description: 'Inspect files',
        runInBackground: true,
        taskId: 'task-9',
      }),
    );
    feed(ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }));
    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_700_000_000_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-2',
        description: 'scan again',
        runInBackground: false,
      }),
    );
    feed(ev({ type: 'subagent.started', subagentId: 'agent-1' }));

    expect(tx.getTask('task-9')).toMatchObject({ state: 'completed', resultSummary: 'done' });
    expect(tx.getTask('agent-1')).toMatchObject({ kind: 'subagent', state: 'running' });
  });

  it('resets terminal fields when one agent starts a second run without a task id', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-1',
        description: 'First run',
        runInBackground: true,
      }),
    );
    feed(ev({ type: 'subagent.started', time: 1_100, subagentId: 'agent-1' }));
    feed(ev({ type: 'subagent.suspended', time: 1_200, subagentId: 'agent-1', reason: 'approval' }));
    feed(
      ev({
        type: 'subagent.completed',
        time: 1_300,
        subagentId: 'agent-1',
        resultSummary: 'done',
        usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
      }),
    );
    feed(ev({ type: 'subagent.failed', time: 1_400, subagentId: 'agent-1', error: 'boom' }));
    feed(
      ev({
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-2',
        description: 'Second run',
        runInBackground: false,
      }),
    );
    feed(ev({ type: 'subagent.started', time: 2_100, subagentId: 'agent-1' }));

    expect(tx.getTask('agent-1')).toEqual({
      taskId: 'agent-1',
      kind: 'subagent',
      state: 'running',
      detached: false,
      name: undefined,
      subagentName: 'worker',
      description: 'Second run',
      agentId: 'agent-1',
      outputTail: '',
      startedAt: new Date(2_000).toISOString(),
    });
  });

  it('recovers the agent → task association from a backfilled task.started', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-9',
          kind: 'agent',
          description: 'Inspect files',
          status: 'running',
          detached: true,
          agentId: 'agent-1',
          startedAt: 1_700_000_000_000,
          endedAt: null,
        },
      }),
    );
    feed(ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }));

    expect(tx.getTask('task-9')).toMatchObject({ state: 'completed', resultSummary: 'done' });
    expect(tx.getTask('agent-1')).toBeUndefined();
  });

  it('keeps the newer run of one agent running when an earlier run completes with its own task id', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-1',
        description: 'First run',
        runInBackground: false,
        taskId: 'task-1',
      }),
    );
    feed(ev({ type: 'subagent.started', time: 1_100, subagentId: 'agent-1', taskId: 'task-1' }));
    feed(
      ev({
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-2',
        description: 'Second run',
        runInBackground: true,
        taskId: 'task-2',
      }),
    );
    feed(ev({ type: 'subagent.started', time: 2_100, subagentId: 'agent-1', taskId: 'task-2' }));
    feed(
      ev({
        type: 'subagent.completed',
        time: 3_000,
        subagentId: 'agent-1',
        resultSummary: 'first done',
        taskId: 'task-1',
      }),
    );

    expect(tx.getTask('task-1')).toMatchObject({
      kind: 'subagent',
      state: 'completed',
      agentId: 'agent-1',
      description: 'First run',
      resultSummary: 'first done',
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(3_000).toISOString(),
    });
    expect(tx.getTask('task-2')).toMatchObject({
      kind: 'subagent',
      state: 'running',
      detached: true,
      agentId: 'agent-1',
      description: 'Second run',
      startedAt: new Date(2_000).toISOString(),
    });
    expect(tx.getTask('task-2')?.endedAt).toBeUndefined();
    expect(tx.getTask('task-2')?.resultSummary).toBeUndefined();
    expect(tx.getTask('agent-1')).toBeUndefined();
  });

  it('folds a task-less terminal event into the latest run (legacy producers)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'subagent.spawned',
        time: 1_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-1',
        description: 'First run',
        runInBackground: false,
      }),
    );
    feed(
      ev({
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        parentToolCallId: 'call-2',
        description: 'Second run',
        runInBackground: true,
        taskId: 'task-2',
      }),
    );
    feed(ev({ type: 'subagent.completed', time: 3_000, subagentId: 'agent-1', resultSummary: 'done' }));

    expect(tx.getTask('task-2')).toMatchObject({ state: 'completed', resultSummary: 'done' });
  });

  it('projects two runs of one agent identically live and from the wire', () => {
    const records: Record<string, unknown>[] = [
      {
        type: 'subagent.spawned',
        time: 1_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        name: 'worker',
        parentToolCallId: 'call-1',
        description: 'First run',
        runInBackground: false,
        taskId: 'task-1',
      },
      { type: 'subagent.started', time: 1_100, subagentId: 'agent-1', taskId: 'task-1' },
      {
        type: 'subagent.spawned',
        time: 2_000,
        subagentId: 'agent-1',
        subagentName: 'worker',
        name: 'worker',
        parentToolCallId: 'call-2',
        description: 'Second run',
        runInBackground: true,
        taskId: 'task-2',
      },
      { type: 'subagent.started', time: 2_100, subagentId: 'agent-1', taskId: 'task-2' },
      {
        type: 'subagent.completed',
        time: 3_000,
        subagentId: 'agent-1',
        resultSummary: 'first done',
        taskId: 'task-1',
      },
    ];

    const liveTx = new AgentTranscript('main');
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    for (const record of records) liveTx.apply(liveAdapter.map(record as unknown as LiveAdapterBusEvent));

    const wireTx = new AgentTranscript('main');
    const wireReducer = new TranscriptFactReducer(wireTx);
    const wireAdapter = new TranscriptWireAdapter('main');
    for (const record of records) {
      wireReducer.apply(wireAdapter.add(record as unknown as TranscriptWireRecord));
    }

    expect(liveTx.getTask('task-1')).toEqual(wireTx.getTask('task-1'));
    expect(liveTx.getTask('task-2')).toEqual(wireTx.getTask('task-2'));
    expect(wireTx.getTask('task-2')).toMatchObject({ state: 'running' });
    expect(wireTx.getTask('task-1')).toMatchObject({ state: 'completed' });
  });

  it('projects goal updates into meta.goal plus an inline marker', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const snapshot = {
      goalId: 'g1',
      objective: 'ship it',
      status: 'active',
      completionCriterion: 'tests green',
      followUpTiming: 'tasks_done' as const,
      controlRevision: 4,
      turnsUsed: 3,
      tokensUsed: 1234,
      wallClockMs: 5000,
      budget: { tokenBudget: 50000 },
    };
    const ops = liveAdapter.map(ev({ type: 'goal.updated', snapshot, change: { kind: 'lifecycle' } }));
    tx.apply(ops);

    expect(tx.getMeta().goal).toEqual({
      objective: 'ship it',
      status: 'active',
      completionCriterion: 'tests green',
      followUpTiming: 'tasks_done',
      controlRevision: 4,
      budgetUsed: 1234,
      budgetLimit: 50000,
    });
    const marker = tx.getItems().find((item) => item.kind === 'marker');
    expect(marker).toMatchObject({ marker: 'goal', payload: { snapshot } });

    const clearedOps = liveAdapter.map(ev({ type: 'goal.updated', snapshot: null }));
    expect(clearedOps[0]).toEqual({ op: 'meta.merge', meta: { goal: null } });
    tx.apply(clearedOps);
    expect(tx.getMeta().goal).toBeUndefined();
  });

  it('mirrors plan / swarm mode slices into meta.modes (only when provided)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', planMode: true })));
    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', swarmMode: true })));
    expect(tx.getMeta().modes).toEqual({ plan: {}, swarm: {} });

    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', planMode: false })));
    expect(tx.getMeta().modes).toEqual({ swarm: {} });
    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', swarmMode: false })));
    expect(tx.getMeta().modes).toBeUndefined();
  });

  it('mirrors status slices into meta.agent (shallow-merged across slices)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    const usageOnly = liveAdapter.map(ev({ type: 'agent.status.updated', usage: {} }));
    expect(usageOnly).toEqual([{ op: 'meta.merge', meta: { agent: { usage: {} } } }]);

    feed(ev({ type: 'agent.status.updated', model: 'k2', thinkingEffort: 'high' }));
    feed(
      ev({
        type: 'agent.status.updated',
        usage: {
          total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        },
      }),
    );
    feed(
      ev({
        type: 'agent.status.updated',
        contextTokens: 1000,
        maxContextTokens: 200000,
        contextUsage: 0.5,
      }),
    );
    feed(ev({ type: 'agent.status.updated', permission: 'yolo' }));

    expect(tx.getMeta().agent).toEqual({
      model: 'k2',
      thinkingEffort: 'high',
      usage: { total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } },
      contextTokens: 1000,
      maxContextTokens: 200000,
      contextUsage: 0.5,
      permission: 'yolo',
    });

    feed(ev({ type: 'agent.status.updated', model: 'k3' }));
    expect(tx.getMeta().agent).toMatchObject({ model: 'k3', thinkingEffort: 'high' });
  });

  it('maps agent.activity.updated into meta.agent.phase', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));
    const turn = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      turnId: 1,
      origin: { kind: 'user' },
      phase: 'running',
      step: 1,
      ending: false,
      pendingApprovals: [],
      activeToolCalls: [],
      since: 1000,
      ...overrides,
    });

    feed(ev({ type: 'agent.activity.updated', lifecycle: 'ready', turn: turn({}), background: [] }));
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'running',
      turnId: 1,
      step: 1,
      stepId: '',
      since: 1000,
    });

    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        turn: turn({ phase: 'streaming', stream: 'assistant' }),
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toMatchObject({ kind: 'streaming', stream: 'assistant' });

    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        turn: turn({ pendingApprovals: [{ approvalId: 'ap1', toolCallId: 'c1', since: 1500 }] }),
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'awaiting_approval',
      turnId: 1,
      step: 1,
      approval: { approvalId: 'ap1', toolCallId: 'c1' },
      since: 1500,
    });

    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        lastTurn: { turnId: 1, reason: 'completed', durationMs: 100, at: 2000 },
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'ended',
      turnId: 1,
      reason: 'completed',
      durationMs: 100,
      at: 2000,
    });
    feed(ev({ type: 'agent.activity.updated', lifecycle: 'ready', background: [] }));
    expect(tx.getMeta().agent?.phase).toEqual({ kind: 'idle' });

    expect(
      liveAdapter.map(ev({ type: 'agent.activity.updated', lifecycle: 'disposed', background: [] })),
    ).toEqual([]);
  });

  it('projects plan.revision as a marker and refines the active plan badge', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    const revision = {
      type: 'plan.revision',
      id: 'plan-1',
      version: 1,
      path: 'agents/main/plan/plan-1/v1.md',
      sha256: 'deadbeef',
      bytes: 128,
    };

    tx.apply(liveAdapter.map(ev(revision)));
    expect(tx.getMeta().modes).toBeUndefined();

    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', planMode: true })));
    expect(tx.getMeta().modes).toEqual({ plan: {} });
    tx.apply(
      liveAdapter.map(ev({ ...revision, version: 2, path: 'agents/main/plan/plan-1/v2.md' })),
    );
    expect(tx.getMeta().modes).toEqual({
      plan: { reviewPath: 'agents/main/plan/plan-1/v2.md', version: 2 },
    });

    const markers = tx
      .getItems()
      .filter((item) => item.kind === 'marker' && item.marker === 'plan.revision');
    expect(markers.map((item) => item.kind === 'marker' && item.markerId)).toEqual([
      'live-m1',
      'live-m2',
    ]);
    expect(markers[1]).toMatchObject({
      payload: {
        id: 'plan-1',
        version: 2,
        path: 'agents/main/plan/plan-1/v2.md',
        sha256: 'deadbeef',
        bytes: 128,
      },
    });

    tx.apply(liveAdapter.map(ev({ type: 'agent.status.updated', planMode: false })));
    expect(tx.getMeta().modes).toBeUndefined();
    expect(
      tx.getItems().filter((item) => item.kind === 'marker' && item.marker === 'plan.revision'),
    ).toHaveLength(2);
  });

  it('projects skill / plugin-command / cron / compaction / hook / undo markers', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'skill.activated', activationId: 'a1', skillName: 'gen-docs', trigger: 'user-slash' }));
    feed(
      ev({
        type: 'plugin_command.activated',
        activationId: 'a2',
        pluginId: 'p',
        commandName: 'c',
        trigger: 'user-slash',
      }),
    );
    feed(ev({ type: 'cron.fired', origin: { kind: 'cron_job', jobId: 'j1' }, prompt: 'ping' }));
    feed(ev({ type: 'compaction.started', trigger: 'auto' }));
    feed(ev({ type: 'compaction.completed', result: { kept: 3 } }));
    feed(ev({ type: 'hook.result', hookEvent: 'SessionStart', content: 'hook says hi' }));
    feed(
      ev({
        type: 'hook.result',
        turnId: 3,
        hookEvent: 'UserPromptSubmit',
        content: 'blocked by hook',
        blocked: true,
      }),
    );
    feed(ev({ type: 'context.spliced', start: 1, deleteCount: 2, messages: [] }));

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers.map((m) => m.marker)).toEqual([
      'skill',
      'skill',
      'cron.fired',
      'compaction',
      'compaction',
      'hook',
      'hook',
      'undo',
    ]);
    expect(markers[1]!.payload).toMatchObject({ variant: 'plugin_command' });
    expect(markers[3]!.payload).toMatchObject({ phase: 'started' });
    expect(markers[4]!.payload).toMatchObject({ phase: 'completed' });
    expect(markers[5]!.payload).toEqual({ hookEvent: 'SessionStart', content: 'hook says hi' });
    expect(markers[6]!.payload).toEqual({
      turnId: 3,
      hookEvent: 'UserPromptSubmit',
      content: 'blocked by hook',
      blocked: true,
    });
    expect(markers[7]!.payload).toMatchObject({ start: 1, deleteCount: 2 });
  });

  it('projects error / warning events as notice markers outside any step', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      liveAdapter.map(ev({ type: 'error', code: 'mcp.failed', message: 'boom', retryable: false })),
    );
    tx.apply(liveAdapter.map(ev({ type: 'warning', message: 'AGENTS.md oversized' })));

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      marker: 'notice',
      payload: { level: 'error', message: 'boom', event: { code: 'mcp.failed' } },
    });
    expect(markers[1]).toMatchObject({
      marker: 'notice',
      payload: { level: 'warning', message: 'AGENTS.md oversized' },
    });
  });

  it('emits interactions as global entities only (no inline frame), back-links on resolve', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 2, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 2,
        toolCallId: 'call_9',
        name: 'Bash',
        args: {},
      }),
    );

    const request = {
      toolCallId: 'call_9',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'rm -rf /tmp/x' },
    };
    tx.apply(
      liveAdapter.mapInteractionRequested({
        id: 'apr-1',
        kind: 'approval',
        payload: request,
        origin: { agentId: 'main', turnId: 2 },
      }),
    );

    expect(turnOps('t2', tx.getItems()).steps[0]!.frames.map((f) => f.kind)).toEqual(['tool']);
    expect(tx.getInteraction('apr-1')).toMatchObject({
      interactionId: 'apr-1',
      interactionKind: 'approval',
      toolCallId: 'call_9',
      state: 'pending',
      request,
    });
    expect(tx.listPendingInteractions()).toEqual(['apr-1']);

    tx.apply(liveAdapter.mapInteractionResolved('apr-1', { decision: 'approved', scope: 'session' }));

    const tool = turnOps('t2', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({ approvalId: 'apr-1' });
    expect(turnOps('t2', tx.getItems()).steps[0]!.frames.map((f) => f.kind)).toEqual(['tool']);
    expect(tx.getInteraction('apr-1')).toMatchObject({
      state: 'approved',
      response: { decision: 'approved', scope: 'session' },
    });
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('surfaces a mid-turn task notification as a user input frame linked to the task', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    const notified = (): LiveAdapterBusEvent =>
      ev({
        type: 'task.notified',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'pnpm test — 42 passed',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'task_1',
      });

    tx.apply(liveAdapter.map(notified()));
    expect(tx.getItems()).toHaveLength(0);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    tx.apply(liveAdapter.map(notified()));

    const frames = turnOps('t1', tx.getItems()).steps[0]!.frames;
    const frame = frames.find((f) => f.kind === 'text' && f.role === 'user');
    expect(frame).toMatchObject({ kind: 'text', role: 'user', taskId: 'task_1' });
    // The origin rides the frame so view-layer lane classification cannot
    // mistake the injection for a typed user prompt (You bubble).
    expect(frame?.kind === 'text' && frame.origin).toEqual({ kind: 'task', taskId: 'task_1' });
    expect(frame?.kind === 'text' && frame.text).toContain('Background process completed');
  });

  it('replaces the global todo document on a confirmed TodoList write', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));

    feed(ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_read', name: 'TodoList', args: {} }));
    feed(ev({ type: 'tool.result', toolCallId: 'call_read', output: '2 todos' }));
    expect(tx.getTodo('todo')).toBeUndefined();

    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_write',
        name: 'TodoList',
        args: { todos: [{ title: 'write tests', status: 'in_progress' }, { title: 'ship', status: 'pending' }] },
      }),
    );
    const writeFrame = turnOps('t1', tx.getItems()).steps[0]!.frames.find(
      (f) => f.kind === 'tool' && f.toolCallId === 'call_write',
    );
    expect(writeFrame?.kind === 'tool' && writeFrame.todoId).toBe('todo');

    feed(ev({ type: 'tool.result', toolCallId: 'call_write', output: 'updated' }));
    expect(tx.getTodo('todo')?.items).toEqual([
      { title: 'write tests', status: 'in_progress' },
      { title: 'ship', status: 'pending' },
    ]);

    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_fail',
        name: 'TodoList',
        args: { todos: [] },
      }),
    );
    feed(ev({ type: 'tool.result', toolCallId: 'call_fail', output: 'boom', isError: true }));
    expect(tx.getTodo('todo')?.items).toHaveLength(2);
  });

  it('emits an unanchored entity when the payload has no toolCallId', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      liveAdapter.mapInteractionRequested({
        id: 'q1',
        kind: 'question',
        payload: { questions: [{ question: 'Pick', options: [] }] },
        origin: { agentId: 'main', turnId: 3 },
      }),
    );
    expect(tx.getItems()).toHaveLength(0);
    const entity = tx.getInteraction('q1');
    expect(entity).toMatchObject({ interactionKind: 'question', state: 'pending' });
    expect(entity?.toolCallId).toBeUndefined();
    expect(tx.listPendingInteractions()).toEqual(['q1']);

    tx.apply(liveAdapter.mapInteractionResolved('q1', null));
    expect(tx.getInteraction('q1')).toMatchObject({ state: 'dismissed' });
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('projects prompt submitted/completed/aborted/steered as global queue entities', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'prompt.submitted',
        promptId: 'p1',
        userMessageId: 'm1',
        status: 'running',
        content: [{ type: 'text', text: 'first' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    feed(
      ev({
        type: 'prompt.submitted',
        promptId: 'p2',
        userMessageId: 'm2',
        status: 'queued',
        content: [{ type: 'text', text: 'second' }],
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({ status: 'running', userMessageId: 'm1' });
    expect(tx.getPrompt('p2')).toMatchObject({ status: 'queued' });

    feed(ev({ type: 'prompt.started', promptId: 'p2' }));
    expect(tx.getPrompt('p2')).toMatchObject({
      status: 'running',
      userMessageId: 'm2',
      content: [{ type: 'text', text: 'second' }],
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    feed(
      ev({
        type: 'prompt.steered',
        activePromptId: 'p1',
        promptIds: ['p2'],
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        steeredAt: '2026-01-01T00:00:02.000Z',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({
      status: 'running',
      steeredAt: '2026-01-01T00:00:02.000Z',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    expect(tx.getPrompt('p2')).toMatchObject({
      status: 'completed',
      userMessageId: 'm2',
      steeredAt: '2026-01-01T00:00:02.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
    });

    feed(
      ev({
        type: 'prompt.completed',
        promptId: 'p1',
        finishedAt: '2026-01-01T00:00:10.000Z',
        reason: 'completed',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({
      status: 'completed',
      finishedAt: '2026-01-01T00:00:10.000Z',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });

    feed(ev({ type: 'prompt.aborted', promptId: 'p3', abortedAt: '2026-01-01T00:00:03.000Z' }));
    expect(tx.getPrompt('p3')).toEqual({
      promptId: 'p3',
      status: 'aborted',
      createdAt: '2026-01-01T00:00:03.000Z',
      finishedAt: '2026-01-01T00:00:03.000Z',
    });
    feed(
      ev({
        type: 'prompt.completed',
        promptId: 'p4',
        finishedAt: '2026-01-01T00:00:04.000Z',
        reason: 'failed',
      }),
    );
    expect(tx.getPrompt('p4')).toEqual({
      promptId: 'p4',
      status: 'failed',
      createdAt: '2026-01-01T00:00:04.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z',
    });
  });

  it('projects prompt moves as queue positions and preserves before-start aborts', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    for (const [index, promptId] of ['p1', 'p2', 'p3'].entries()) {
      feed(
        ev({
          type: 'prompt.submitted',
          promptId,
          userMessageId: `m${index + 1}`,
          status: 'queued',
          content: [{ type: 'text', text: promptId }],
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
        }),
      );
      feed(ev({
        type: 'prompt.queued',
        promptId,
        content: [{ type: 'text', text: promptId }],
        queueLength: index + 1,
      }));
    }
    feed(ev({
      type: 'prompt.moved',
      promptId: 'p3',
      targetIndex: 0,
      queuedPromptIds: ['p3', 'p1', 'p2'],
      movedAt: '2026-01-01T00:00:04.000Z',
    }));

    expect(tx.getPrompt('p3')).toMatchObject({ status: 'queued', queuePosition: 0 });
    expect(tx.getPrompt('p1')).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(tx.getPrompt('p2')).toMatchObject({ status: 'queued', queuePosition: 2 });

    feed(ev({
      type: 'prompt.aborted',
      promptId: 'p2',
      abortedAt: '2026-01-01T00:00:05.000Z',
      beforeStart: true,
    }));
    expect(tx.getPrompt('p2')).toMatchObject({ status: 'aborted', abortedBeforeStart: true });
  });

  it('projects prompt.steered media content to the wire shape (no daemon ref or path leak)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'prompt.steered',
        activePromptId: 'p1',
        promptIds: ['p2'],
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image_url',
            imageUrl: { url: 'kimi-file://f_img1?path=%2Fabs%2Fsession%2Fmedia%2Ff_img1.png' },
          },
        ],
        steeredAt: '2026-01-01T00:00:02.000Z',
      }),
    );

    const prompt = tx.getPrompt('p1');
    expect(prompt?.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { kind: 'session_media', file_id: 'f_img1' } },
    ]);
  });

  it('folds blocked turn endings into failed (engine wire contract)', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    tx.apply(liveAdapter.map(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } })));
    tx.apply(liveAdapter.map(ev({ type: 'turn.ended', turnId: 0, reason: 'blocked' })));
    expect(turnOps('t0', tx.getItems()).state).toBe('failed');
  });

  it('maps cron / task origins onto the turn header', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(
      ev({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'cron_job', jobId: 'job-9', cron: '* * * * *' },
      }),
    );
    feed(
      ev({
        type: 'turn.started',
        turnId: 2,
        origin: { kind: 'task', taskId: 'bash-1', status: 'completed', notificationId: 'n1' },
      }),
    );

    expect(turnOps('t1', tx.getItems()).origin).toEqual({
      kind: 'cron',
      taskId: 'job-9',
      payload: { kind: 'cron_job', jobId: 'job-9', cron: '* * * * *' },
    });
    expect(turnOps('t2', tx.getItems()).origin).toEqual({
      kind: 'task',
      taskId: 'bash-1',
      payload: { kind: 'task', taskId: 'bash-1', status: 'completed', notificationId: 'n1' },
    });
  });

  it('treats subagent.started/failed/suspended within the running→failed vocabulary', () => {
    const liveAdapter = new AgentTranscriptLiveAdapter('main');
    const tx = new AgentTranscript('main');
    const feed = (event: LiveAdapterBusEvent): void => void tx.apply(liveAdapter.map(event));

    feed(ev({ type: 'subagent.started', time: 1_700_000_001_000, subagentId: 'agent-1' }));
    expect(tx.getTask('agent-1')).toMatchObject({
      kind: 'subagent',
      state: 'running',
      startedAt: '2023-11-14T22:13:21.000Z',
    });
    feed(ev({ type: 'subagent.suspended', time: 1_700_000_002_000, subagentId: 'agent-1', reason: 'approval' }));
    expect(tx.getTask('agent-1')).toMatchObject({
      state: 'running',
      stateReason: 'approval',
      startedAt: '2023-11-14T22:13:21.000Z',
    });
    feed(ev({ type: 'subagent.failed', time: 1_700_000_004_000, subagentId: 'agent-1', error: 'boom' }));
    expect(tx.getTask('agent-1')).toMatchObject({
      state: 'failed',
      error: 'boom',
      startedAt: '2023-11-14T22:13:21.000Z',
      endedAt: '2023-11-14T22:13:24.000Z',
    });

    feed(
      ev({
        type: 'subagent.failed',
        time: 1_700_000_005_000,
        subagentId: 'agent-3',
        error: 'terminated',
      }),
    );
    expect(tx.getTask('agent-3')).toMatchObject({
      state: 'killed',
      error: undefined,
      stateReason: 'terminated',
      endedAt: '2023-11-14T22:13:25.000Z',
    });

    feed(
      ev({
        type: 'subagent.completed',
        subagentId: 'agent-2',
        resultSummary: 'found 3 files',
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
      }),
    );
    expect(tx.getTask('agent-2')).toMatchObject({
      state: 'completed',
      resultSummary: 'found 3 files',
      usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
    });
  });
});

describe('AgentTranscript transcript task vocabulary', () => {
  it('documents the task states used by the liveAdapter', () => {
    const states: Array<TranscriptTask['state']> = [
      'running',
      'completed',
      'failed',
      'timed_out',
      'killed',
      'lost',
    ];
    expect(states).toHaveLength(6);
  });
});
