import { describe, expect, it, vi } from 'vitest';

import type { MessageContent, Session, SessionSnapshotResponse } from '@kiki/protocol';

import type {
  AgentTranscriptResponse,
  SessionTransport as KikiClient,
} from '../transport';
import { resolveSelectedEffort } from '../settings/agentSettings';
import { resolveEffectiveModel } from '../settings/settings';
import type { SessionEventFrame } from '../wire';
import type { TranscriptEvent } from '@kiki/transcript';

import { assertSessionWritable, RESYNC_PAUSED_ERROR, SessionController } from './sessionController';
import type { SubagentBlock, ToolBlock, UserBlock } from './transcript';
import { ASSISTANT_FRAME_ID, emptySnapshot, opsEvent, resetEvent, userTurnSnapshot } from './__fixtures__/canonicalTranscript';

import type { SessionViewFacade } from '@kiki/klient/session-view';

function fakeView(client: object, socket: object, sessionId = 'session_test'): SessionViewFacade {
  const reads = client as {
    snapshot(sessionId: string, options: { transcript: boolean }): Promise<SessionSnapshotResponse>;
    getAgentTranscript(sessionId: string, agentId: string, options: object): Promise<AgentTranscriptResponse>;
    getTranscriptOps(sessionId: string, agentId: string, since: object, grade?: string): ReturnType<SessionViewFacade['transcript']['catchUp']>;
  };
  const controls = socket as Record<string, (...args: unknown[]) => void>;
  return {
    snapshot: () => reads.snapshot(sessionId, { transcript: true }),
    transcript: {
      page: ({ agentId, ...options }) => reads.getAgentTranscript(sessionId, agentId, options) as ReturnType<SessionViewFacade['transcript']['page']>,
      catchUp: ({ agentId, since, grade }) => reads.getTranscriptOps(sessionId, agentId, since, grade) as ReturnType<SessionViewFacade['transcript']['catchUp']>,
    },
    subscribe: (input) => {
      controls['subscribe']?.(sessionId, input.sessionCursor, input.transcriptGrades);
      return {
        updateSessionCursor: (cursor) => { controls['updateCursor']?.(sessionId, cursor); },
        setTranscriptGrades: (grades) => { controls['setTranscriptGrades']?.(sessionId, grades); },
        updateTranscriptCursor: (agentId, cursor) => { controls['updateTranscriptSince']?.(sessionId, agentId, cursor); },
        restart: () => { controls['restartGeneration']?.(); },
        nudge: () => {},
        close: () => { controls['unsubscribe']?.(sessionId); },
      };
    },
  };
}

function deliverFrame(controller: SessionController, frame: SessionEventFrame): void {
  if (frame.session_id !== controller.sessionId) return;
  const cursor = { seq: frame.seq, epoch: frame.epoch };
  if (frame.payload.type === 'event.session.history_rewritten') {
    controller.handleSignal({ type: 'historyRewritten', cursor, generation: 0, reason: 'regenerate', targetMessageId: 'message-test' });
  } else if (frame.volatile !== true) {
    controller.handleSignal({ type: 'sessionCursorAdvanced', cursor, generation: 0 });
  }
}

function deliverResync(controller: SessionController, payload: { session_id: string; reason: 'history_rewritten' | 'epoch_changed' | 'session_recreated' | 'buffer_overflow'; current_seq: number; epoch?: string }): void {
  if (payload.session_id !== controller.sessionId) return;
  controller.handleSignal({ type: 'resyncRequired', generation: 0, reason: payload.reason, currentSessionCursor: { seq: payload.current_seq, epoch: payload.epoch } });
}

function asTranscriptEvent(event: Record<string, unknown>): TranscriptEvent {
  const sessionId = typeof event['session_id'] === 'string' ? event['session_id'] : 'session_test';
  const seq = typeof event['seq'] === 'number' ? event['seq'] : 0;
  const cursor =
    event['cursor'] !== undefined && typeof event['cursor'] === 'object'
      ? (event['cursor'] as { seq: number; epoch?: string })
      : { seq, epoch: 'epoch-1' };
  if (event['type'] === 'transcript.reset') {
    const hasMoreOlder = event['has_more_older'] === true;
    return {
      type: 'transcript.reset',
      session_id: sessionId,
      agent_id: event['agent_id'],
      snapshot: event['snapshot'],
      grade: 'delta',
      coverage: hasMoreOlder
        ? { kind: 'tail', hasMoreOlder: true }
        : { kind: 'full', hasMoreOlder: false },
      cursor,
    } as TranscriptEvent;
  }
  return {
    type: 'transcript.ops',
    session_id: sessionId,
    agent_id: event['agent_id'],
    ops: event['ops'] ?? [],
    cursor,
    through_seq: event['through_seq'] ?? seq,
  } as TranscriptEvent;
}

const session: Session = {
  id: 'session_test',
  workspace_id: 'wd_test_000000000000',
  title: 'Test',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  busy: false,
  metadata: { cwd: 'C:/tmp' },
  agent_config: { model: '' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  },
  permission_rules: [],
  message_count: 0,
  last_seq: 0,
};

function snapshot(overrides: Partial<SessionSnapshotResponse> = {}): SessionSnapshotResponse {
  return {
    as_of_seq: 10,
    epoch: 'epoch-1',
    session,
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
    ...overrides,
  };
}

function frame(
  payload: SessionEventFrame['payload'],
  options: { seq?: number; volatile?: boolean; offset?: number } = {},
): SessionEventFrame {
  return {
    type: payload.type,
    seq: options.seq ?? 11,
    epoch: 'epoch-1',
    volatile: options.volatile,
    offset: options.offset,
    session_id: 'session_test',
    timestamp: '2026-01-01T00:00:01.000Z',
    payload,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Manual publication scheduler: callbacks queue up and run only when the
 * test flushes, standing in for rAF without depending on a real clock. */
function manualScheduler() {
  const pending: (() => void)[] = [];
  return {
    scheduler: {
      schedule(callback: () => void) {
        pending.push(callback);
        return pending.length;
      },
      cancel: () => {
        pending.length = 0;
      },
    },
    flushOne() {
      pending.shift()?.();
    },
    flushAll() {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

function fakeAnimationFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  const request = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    pending.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: number) => {
    pending.delete(handle);
  });
  return {
    request,
    cancel,
    pending: () => pending.size,
    flushOne() {
      const entry = pending.entries().next().value;
      if (entry === undefined) return;
      pending.delete(entry[0]);
      entry[1](performance.now());
    },
  };
}

function visibilityDocument(initial: 'hidden' | 'visible') {
  const target = new EventTarget() as EventTarget & { readonly visibilityState: string };
  let visibilityState = initial;
  Object.defineProperty(target, 'visibilityState', {
    get: () => visibilityState,
  });
  return {
    target,
    set(next: 'hidden' | 'visible') {
      visibilityState = next;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

interface Harness {
  controller: SessionController;
  client: {
    snapshot: ReturnType<typeof vi.fn>;
    listPrompts: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
    replacePrompt: ReturnType<typeof vi.fn>;
    abortPrompt: ReturnType<typeof vi.fn>;
    movePrompt: ReturnType<typeof vi.fn>;
    steerPrompt: ReturnType<typeof vi.fn>;
    editMessage: ReturnType<typeof vi.fn>;
    regenerateMessage: ReturnType<typeof vi.fn>;
    forkSession: ReturnType<typeof vi.fn>;
    getTranscriptOps: ReturnType<typeof vi.fn>;
  };
  socket: { subscribe: ReturnType<typeof vi.fn>; updateCursor: ReturnType<typeof vi.fn> };
  flushAll: () => void;
  /** Count of main-store publications after subscription. */
  mainPublishes: () => number;
}

async function openController(options: { defaultScheduler?: boolean } = {}): Promise<Harness> {
  const client = {
    snapshot: vi.fn(async () => snapshot()),
    listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
    listTasks: vi.fn(async () => ({ items: [] })),
    getSessionGoal: vi.fn(async () => null),
    listMessages: vi.fn(async () => ({ items: [], has_more: false })),
    submitPrompt: vi.fn(),
    replacePrompt: vi.fn(),
    abortPrompt: vi.fn(async () => ({ aborted: true, at_seq: 1 })),
    movePrompt: vi.fn(async (_sessionId: string, promptId: string, body: { target_index: number }) => ({
      moved: true as const,
      prompt_id: promptId,
      target_index: body.target_index,
      queued_prompt_ids: [],
    })),
    steerPrompt: vi.fn(async () => ({ steered: true as const, prompt_ids: [] as string[] })),
    editMessage: vi.fn(async () => ({
      prompt_id: 'p-edit',
      user_message_id: 'm-edit',
      status: 'running',
      content: [],
      created_at: '2026-01-01T00:00:02.000Z',
    })),
    regenerateMessage: vi.fn(async () => ({
      prompt_id: 'p-regen',
      user_message_id: 'm-user',
      status: 'running',
      content: [],
      created_at: '2026-01-01T00:00:02.000Z',
    })),
    forkSession: vi.fn(async () => ({ ...session, id: 'session_fork' })),
    getTranscriptOps: vi.fn(async () => ({
      session_id: 'session_test',
      agent_id: 'main',
      epoch: 'epoch-1',
      batches: [],
      through_seq: 0,
      complete: true,
    })),
    getAgentTranscript: vi.fn(async () => ({
      agent_id: 'main',
      items: [],
      has_more: false,
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    })),
  };
  const socket = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    updateCursor: vi.fn(),
    abort: vi.fn(),
    setTranscriptGrades: vi.fn(),
    restartGeneration: vi.fn(),
    updateTranscriptSince: vi.fn(),
    clearTranscriptSince: vi.fn(),
  };
  const { scheduler, flushAll } = manualScheduler();
  const controller = new SessionController(
    client as unknown as KikiClient,
    fakeView(client, socket),
    'session_test',
    options.defaultScheduler === true ? undefined : { scheduler },
  );
  let publishes = 0;
  controller.subscribe(() => {
    publishes += 1;
  });
  await controller.open();
  const opened = publishes;
  return {
    controller,
    client,
    socket,
    flushAll,
    mainPublishes: () => publishes - opened,
  };
}

describe('assertSessionWritable', () => {
  it('throws the shared paused error while resyncing or after a failed resync', () => {
    expect(() => assertSessionWritable({ resyncing: true, resyncFailed: false })).toThrow(
      RESYNC_PAUSED_ERROR,
    );
    expect(() => assertSessionWritable({ resyncing: false, resyncFailed: true })).toThrow(
      RESYNC_PAUSED_ERROR,
    );
    expect(() => assertSessionWritable({ resyncing: false, resyncFailed: false })).not.toThrow();
  });
});


describe('SessionController prompt runtime projection', () => {
  it.each([true, false, undefined])('preserves GUI plan/swarm selections including false and omission: %s', async (enabled) => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'runtime-projection', user_message_id: 'runtime-message', status: 'queued',
      content: [{ type: 'text', text: 'follow-up' }], created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'follow-up', permissionMode: 'manual',
      planMode: enabled, swarmMode: enabled, goalObjective: 'same objective' });
    expect(client.submitPrompt).toHaveBeenCalledWith('session_test', expect.objectContaining({
      plan_mode: enabled, swarm_mode: enabled, goal_objective: 'same objective',
    }));
    controller.close();
  });
});

describe('SessionController pipeline', () => {
  it('aborts the in-flight snapshot when the session closes', async () => {
    let signal: AbortSignal | undefined;
    const view: SessionViewFacade = {
      ...fakeView({ snapshot: vi.fn() }, {}),
      snapshot: vi.fn(({ signal: requestedSignal } = {}) => {
        signal = requestedSignal;
        return new Promise<SessionSnapshotResponse>((_resolve, reject) => {
          requestedSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    };
    const controller = new SessionController({} as KikiClient, view, 'session_test');
    const opening = controller.open();
    expect(signal?.aborted).toBe(false);
    controller.close();
    expect(signal?.aborted).toBe(true);
    await opening;
    expect(controller.getState().loaded).toBe(false);
  });

  it('refreshes a waking child on creation and removes it on disposal without unrelated events', async () => {
    const previous = {
      id: 'child', session_id: 'session_test', kind: 'subagent' as const,
      parent_agent_id: 'main', description: 'Child', status: 'completed' as const,
      subagent_phase: 'completed' as const, live: false, model: 'provider/old',
      created_at: '2026-01-01T00:00:01.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      completed_at: '2026-01-01T00:00:02.000Z',
    };
    const refreshingUntil = new Date(Date.now() + 120_000).toISOString();
    const reads = vi.fn()
      .mockResolvedValueOnce(snapshot({ subagents: [previous] }))
      .mockResolvedValueOnce(snapshot({ as_of_seq: 11, subagents: [{
        ...previous, live: undefined, refreshing: true, refreshing_until: refreshingUntil,
      }] }))
      .mockResolvedValueOnce(snapshot({ as_of_seq: 12, subagents: [previous] }));
    const controller = new SessionController(
      {} as KikiClient, fakeView({ snapshot: reads }, {}), 'session_test',
    );
    await controller.open();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 1));
    controller.flushFrames();
    expect(controller.getForest()?.byId['child']).toBeUndefined();

    controller.handleSignal({
      type: 'sessionCursorAdvanced', rosterAgentId: 'child', generation: 0,
      cursor: { seq: 11, epoch: 'epoch-1' },
    });
    await waitFor(() => controller.getForest()?.byId['child']?.refreshing === true);
    expect(controller.getForest()?.byId['child']).toMatchObject({
      status: 'completed', refreshingUntil, model: 'provider/old',
      endedAt: '2026-01-01T00:00:02.000Z',
    });
    expect(reads).toHaveBeenCalledTimes(2);
    controller.handleSignal({
      type: 'sessionCursorAdvanced', rosterAgentId: 'child', generation: 0,
      cursor: { seq: 12, epoch: 'epoch-1' },
    });
    await waitFor(() => controller.getForest()?.byId['child'] === undefined);
    expect(reads).toHaveBeenCalledTimes(3);
    controller.handleSignal({
      type: 'sessionCursorAdvanced', rosterAgentId: 'new-child', generation: 0,
      cursor: { seq: 13, epoch: 'epoch-1' },
    });
    expect(reads).toHaveBeenCalledTimes(3);
    controller.close();
  });

  it('removes a terminal waking child when its lease expires without any event', async () => {
    const reads = vi.fn(async () => snapshot({ subagents: [{
      id: 'child', session_id: 'session_test', kind: 'subagent',
      parent_agent_id: 'main', description: 'Child', status: 'completed',
      subagent_phase: 'completed', live: undefined, refreshing: true,
      refreshing_until: new Date(Date.now() + 150).toISOString(),
      created_at: '2026-01-01T00:00:01.000Z',
      completed_at: '2026-01-01T00:00:02.000Z',
    }] }));
    const controller = new SessionController(
      {} as KikiClient, fakeView({ snapshot: reads }, {}), 'session_test',
    );
    await controller.open();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 1));
    controller.flushFrames();
    expect(controller.getForest()?.byId['child']).toMatchObject({ refreshing: true });
    await waitFor(() => controller.getForest()?.byId['child'] === undefined);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(controller.getState().snapshotSubagents[0]).toMatchObject({ live: false });
    controller.close();
  });

  it('retries a delayed roster read for the latest of two waking children', async () => {
    const child = (id: string) => ({
      id, session_id: 'session_test', kind: 'subagent' as const,
      parent_agent_id: 'main', description: id, status: 'completed' as const,
      subagent_phase: 'completed' as const, live: false,
      created_at: '2026-01-01T00:00:01.000Z',
      completed_at: '2026-01-01T00:00:02.000Z',
    });
    const previous = [child('child-a'), child('child-b')];
    const firstRefresh = deferred<SessionSnapshotResponse>();
    const refreshingUntil = new Date(Date.now() + 120_000).toISOString();
    const reads = vi.fn()
      .mockResolvedValueOnce(snapshot({ subagents: previous }))
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(snapshot({ as_of_seq: 12, subagents: previous.map((row) => ({
        ...row, live: undefined, refreshing: true, refreshing_until: refreshingUntil,
      })) }));
    const controller = new SessionController(
      {} as KikiClient, fakeView({ snapshot: reads }, {}), 'session_test',
    );
    await controller.open();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 1));
    controller.flushFrames();
    for (const agentId of ['child-a', 'child-b']) {
      expect(controller.getForest()?.byId[agentId]).toBeUndefined();
    }
    controller.handleSignal({ type: 'sessionCursorAdvanced', rosterAgentId: 'child-a',
      generation: 0, cursor: { seq: 11, epoch: 'epoch-1' } });
    expect(reads).toHaveBeenCalledTimes(2);
    controller.handleSignal({ type: 'sessionCursorAdvanced', rosterAgentId: 'child-b',
      generation: 0, cursor: { seq: 12, epoch: 'epoch-1' } });
    expect(reads).toHaveBeenCalledTimes(2);
    firstRefresh.resolve(snapshot({ as_of_seq: 11, subagents: [{
      ...previous[0]!, live: undefined, refreshing: true, refreshing_until: refreshingUntil,
    }, previous[1]!] }));
    await waitFor(() => reads.mock.calls.length === 3);
    await waitFor(() => ['child-a', 'child-b'].every((id) => controller.getForest()?.byId[id]?.refreshing === true));
    expect(controller.getState().snapshotSubagents).toHaveLength(2);
    controller.close();
  });

  it('recovers one malformed view baseline and stops on a terminal protocol error', async () => {
    const read = vi.fn(async () => snapshot());
    const callbacks: Parameters<SessionViewFacade['subscribe']>[1][] = [];
    const closes = vi.fn();
    const view: SessionViewFacade = {
      ...fakeView({ snapshot: read }, {}),
      subscribe: (_input, callback) => {
        callbacks.push(callback);
        return {
          close: closes, restart: vi.fn(), nudge: vi.fn(),
          updateSessionCursor: vi.fn(), updateTranscriptCursor: vi.fn(), setTranscriptGrades: vi.fn(),
        };
      },
    };
    const controller = new SessionController({} as KikiClient, view, 'session_test');
    await controller.open();
    callbacks[0]!({ type: 'protocolError', generation: 1, recoverable: true, detail: 'Invalid session view signal.' });
    await waitFor(() => callbacks.length === 2);
    expect(read).toHaveBeenCalledTimes(2);
    callbacks[0]!({ type: 'sessionCursorAdvanced', generation: 1, cursor: { seq: 999, epoch: 'stale' } });
    expect(controller.getState().cursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    const pending = deferred<SessionSnapshotResponse>();
    read.mockImplementationOnce(() => pending.promise);
    const restoring = controller.resync();
    callbacks[1]!({ type: 'protocolError', generation: 1, recoverable: false, detail: 'Invalid session view signal.' });
    expect(controller.getState()).toMatchObject({
      resyncing: false, resyncFailed: true,
      resyncError: { message: 'Invalid session view signal.', retryable: false },
    });
    pending.resolve(snapshot({ as_of_seq: 999 }));
    await restoring;
    callbacks[1]!({ type: 'ready', generation: 1, currentSessionCursor: { seq: 999 }, reconnected: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(read).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(2);
    expect(controller.getState().cursor.seq).toBe(10);
    expect(controller.getState().resyncError?.retryable).toBe(false);
    expect(closes).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('admits observed cold agents at turn grade without taking focus or closing the main view', async () => {
    const client = { snapshot: vi.fn(async () => snapshot()) };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn(), setTranscriptGrades: vi.fn() };
    const controller = new SessionController(client as unknown as KikiClient, fakeView(client, socket), 'session_test');
    const releaseFirst = controller.subscribeAgent('cold-child', vi.fn());
    await controller.open();
    expect(socket.subscribe).toHaveBeenCalledWith('session_test', expect.any(Object), {
      '*': 'turn', main: 'delta', 'cold-child': 'turn',
    });
    const releaseSecond = controller.subscribeAgent('cold-child', vi.fn());
    expect(socket.setTranscriptGrades).not.toHaveBeenCalled();
    controller.setFocusedAgent('focused-child');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'focused-child': 'delta', 'cold-child': 'turn',
    });
    releaseFirst();
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(1);
    releaseSecond();
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'focused-child': 'delta',
    });
    const releaseLate = controller.subscribeAgent('late-child', vi.fn());
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'focused-child': 'delta', 'late-child': 'turn',
    });
    controller.setFocusedAgent('late-child');
    releaseLate();
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'late-child': 'delta',
    });
    expect(socket.unsubscribe).not.toHaveBeenCalled();
    controller.close();
  });

  it('collects view leases during initial sync without additional transcript initialization', async () => {
    const held = deferred<SessionSnapshotResponse>();
    const client = { snapshot: vi.fn(async () => held.promise) };
    const socket = { subscribe: vi.fn(), setTranscriptGrades: vi.fn() };
    const controller = new SessionController(client as unknown as KikiClient, fakeView(client, socket), 'session_test');
    const opening = controller.open();
    controller.retainAgentView('route', 'child-1', 'delta');
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.retainAgentView('discarded', 'child-2', 'delta');
    controller.releaseAgentView('discarded');
    held.resolve(snapshot());
    await opening;
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect(socket.subscribe).toHaveBeenCalledExactlyOnceWith('session_test', expect.any(Object), {
      '*': 'turn', main: 'delta', 'child-1': 'delta',
    });
    expect(socket.setTranscriptGrades).not.toHaveBeenCalled();
    controller.close();
  });

  it('preserves an agent focus set before the initial snapshot finishes', async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot()),
    };
    const socket = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      setTranscriptGrades: vi.fn(),
    };
    const controller = new SessionController(
      client as unknown as KikiClient,
      fakeView(client, socket),
      'session_test',
    );

    controller.setFocusedAgent('child-1');
    await controller.open();

    expect(socket.subscribe).toHaveBeenCalledWith(
      'session_test',
      expect.any(Object),
      { '*': 'turn', main: 'delta', 'child-1': 'delta' },
    );
    controller.close();
  });

  it('keeps an immediately sent prompt at the tail of a freshly opened session', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-new',
      user_message_id: 'm-new',
      status: 'running',
      content: [{ type: 'text', text: 'new question' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'new question', permissionMode: 'manual' });
    expect(controller.getState().blocks.at(-1)).toMatchObject({
      kind: 'user',
      promptId: 'p-new',
      text: 'new question',
    });
    controller.close();
  });

  it('uses server-normalized session media in the optimistic local prompt', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-media',
      user_message_id: 'm-media',
      status: 'running',
      content: [
        { type: 'text', text: 'inspect these' },
        { type: 'image', source: { kind: 'session_media', file_id: 'f-image' } },
        {
          type: 'file',
          file_id: 'f-report',
          name: 'report.pdf',
          media_type: 'application/pdf',
          size: 4096,
        },
      ],
      created_at: '2026-01-01T00:00:02.000Z',
    });

    await controller.sendPrompt({ text: 'inspect these', permissionMode: 'manual' });

    expect(controller.getState().blocks.at(-1)).toMatchObject({
      kind: 'user',
      promptId: 'p-media',
      text: 'inspect these',
      media: [
        { kind: 'image', fileId: 'f-image' },
        {
          kind: 'file',
          fileId: 'f-report',
          name: 'report.pdf',
          mime: 'application/pdf',
          size: 4096,
        },
      ],
    });
    controller.close();
  });

  it('forwards the effort selected in Composer with the next prompt request', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-effort',
      user_message_id: 'm-effort',
      status: 'running',
      content: [{ type: 'text', text: 'use more reasoning' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    const selectedEffort = resolveSelectedEffort(['low', 'high'], 'high', 'low');
    await controller.sendPrompt({
      text: 'use more reasoning',
      thinking: selectedEffort,
      permissionMode: 'manual',
    });
    expect(client.submitPrompt).toHaveBeenCalledWith(
      'session_test',
      expect.objectContaining({ thinking: 'high' }),
    );
    controller.close();
  });

  it('forwards the plan gate picked in Composer with the next prompt request', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-gate',
      user_message_id: 'm-gate',
      status: 'running',
      content: [{ type: 'text', text: 'gate this' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({
      text: 'gate this',
      permissionMode: 'manual',
      planGate: 'gated',
    });
    expect(client.submitPrompt).toHaveBeenCalledWith(
      'session_test',
      expect.objectContaining({ plan_gate: 'gated' }),
    );
    controller.close();
  });

  it('refuses sendPrompt during resync without REST or local echo', async () => {
    const { controller, client } = await openController();
    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValue(held.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    await expect(controller.sendPrompt({ text: 'nope', permissionMode: 'manual' })).rejects.toThrow(
      /resync/i,
    );
    expect(client.submitPrompt).not.toHaveBeenCalled();
    held.reject(new Error('snapshot down'));
    await waitFor(() => controller.getState().resyncFailed);
    await expect(controller.sendPrompt({ text: 'still nope', permissionMode: 'manual' })).rejects.toThrow(
      /resync/i,
    );
    controller.close();
  });

  it('publishes pending transcript ops after a hidden-visible transition', async () => {
    const animationFrames = fakeAnimationFrames();
    const visibility = visibilityDocument('visible');
    vi.stubGlobal('requestAnimationFrame', animationFrames.request);
    vi.stubGlobal('cancelAnimationFrame', animationFrames.cancel);
    vi.stubGlobal('document', visibility.target);

    let controller: SessionController | undefined;
    try {
      ({ controller } = await openController({ defaultScheduler: true }));
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.reset',
        agent_id: 'main',
        seq: 1,
        snapshot: {
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user' },
              prompt: 'hi',
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'running',
                  frames: [
                    { kind: 'text', frameId: 'f-visible', role: 'assistant', text: 'A' },
                  ],
                },
              ],
            },
          ],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: { activity: 'turn' },
        },
      }));
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.ops',
        agent_id: 'main',
        seq: 2,
        ops: [
          {
            op: 'frame.upsert',
            turnId: 't1',
            stepId: 't1.1',
            frame: { kind: 'text', frameId: 'f-visible', role: 'assistant', text: 'AB' },
          },
        ],
      }));
      expect(animationFrames.pending()).toBe(1);

      visibility.set('hidden');
      expect(animationFrames.pending()).toBe(0);
      visibility.set('visible');
      expect(animationFrames.pending()).toBe(1);
      animationFrames.flushOne();

      expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
        text: 'AB',
      });
    } finally {
      controller?.close();
      vi.unstubAllGlobals();
    }
  });

  it('resyncs after a reconnect ack only when the drop hit live work', async () => {
    const { controller, client } = await openController();
    const snapshotCalls = () => client.snapshot.mock.calls.length;
    controller.handleWsDrop();
    controller.handleReconnectAck();
    expect(snapshotCalls()).toBe(1);
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p1',
      user_message_id: 'm1',
      status: 'running',
      content: [{ type: 'text', text: 'A' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    expect(controller.getState().busy).toBe(true);
    controller.handleWsDrop();
    controller.handleReconnectAck();
    await waitFor(() => client.getTranscriptOps.mock.calls.length > 0 || snapshotCalls() >= 2);
    await waitFor(() => !controller.getState().resyncing);
    controller.close();
  });

  it('exposes terminal restore errors without retrying and allows manual recovery', async () => {
    vi.useFakeTimers();
    const { ApiError } = await import('../transport');
    const { controller, client } = await openController();
    try {
      client.snapshot.mockRejectedValueOnce(new ApiError({
        code: 40401, msg: 'Session was not found', data: null, request_id: 'request-example',
      }));
      await controller.resync();
      expect(controller.getState()).toMatchObject({
        resyncFailed: true, resyncing: false, resyncAttempt: 1,
        resyncError: { code: 40401, requestId: 'request-example', retryable: false, message: 'Session was not found (code 40401)' },
      });
      controller.handleSubscribeRejected();
      deliverResync(controller, { session_id: 'session_test', reason: 'history_rewritten', current_seq: 10 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      await controller.resync();
      expect(client.snapshot).toHaveBeenCalledTimes(3);
      expect(controller.getState().resyncFailed).toBe(false);
      expect(controller.getState().resyncError).toBeUndefined();
    } finally {
      controller.close();
      vi.useRealTimers();
    }
  });

  it('marks a failed resync and retries with backoff until a snapshot lands', async () => {
    const { controller, client } = await openController();
    client.snapshot
      .mockRejectedValueOnce(new Error('held forever'))
      .mockResolvedValueOnce(snapshot());
    void controller.resync();
    await waitFor(() => controller.getState().resyncFailed);
    expect(controller.getState().resyncAttempt).toBe(1);
    await waitFor(() => !controller.getState().resyncFailed && !controller.getState().resyncing);
    expect(client.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    controller.close();
  });
});

describe('SessionController message closure', () => {
  it('rebuilds from a snapshot on event.session.history_rewritten', async () => {
    const { controller, client, socket } = await openController();
    client.snapshot.mockResolvedValue(
      snapshot({
        as_of_seq: 12,
        messages: {
          items: [
            {
              id: 'm-kept',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'kept after the rewrite' }],
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
          has_more: false,
        },
      }),
    );
    const calls = () => client.snapshot.mock.calls.length;
    const before = calls();
    deliverFrame(controller,
      frame(
        {
          type: 'event.session.history_rewritten',
          reason: 'edit_resend',
          target_message_id: 'm-gone',
        } as never,
        { seq: 12 },
      ),
    );
    await waitFor(() => calls() > before);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    // Resubscribed at the snapshot watermark; the truncated block list is the
    // snapshot's, not the pre-rewrite one.
    expect(socket.subscribe).toHaveBeenLastCalledWith(
      'session_test',
      { seq: 12, epoch: 'epoch-1' },
      expect.objectContaining({ '*': 'turn', main: 'delta' }),
    );
    controller.close();
  });

  it('resyncs with rewrite marking on resync_required(history_rewritten)', async () => {
    const { controller, client } = await openController();
    const calls = () => client.snapshot.mock.calls.length;
    const before = calls();
    deliverResync(controller, {
      session_id: 'session_test',
      reason: 'history_rewritten',
      current_seq: 12,
      epoch: 'epoch-1',
    });
    await waitFor(() => calls() > before);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });

  it('editMessage posts full-replacement content with the cursor and resyncs', async () => {
    const { controller, client } = await openController();
    const calls = () => client.snapshot.mock.calls.length;
    const before = calls();
    await controller.editMessage('m-user', { text: 'rewritten' });
    expect(client.editMessage).toHaveBeenCalledWith('session_test', 'm-user', {
      content: [{ type: 'text', text: 'rewritten' }],
      expected_cursor: { seq: 10, epoch: 'epoch-1' },
      model: undefined,
      thinking: undefined,
      permission_mode: undefined,
      plan_gate: undefined,
      plan_mode: undefined,
      swarm_mode: undefined,
    });
    // Proactive local resync — the repaint does not wait on the WS frame.
    await waitFor(() => calls() > before);
    controller.close();
  });

  it('regenerateMessage posts the cursor and resyncs', async () => {
    const { controller, client } = await openController();
    const calls = () => client.snapshot.mock.calls.length;
    const before = calls();
    await controller.regenerateMessage('m-assistant');
    expect(client.regenerateMessage).toHaveBeenCalledWith('session_test', 'm-assistant', {
      expected_cursor: { seq: 10, epoch: 'epoch-1' },
      model: undefined,
      thinking: undefined,
      permission_mode: undefined,
      plan_gate: undefined,
      plan_mode: undefined,
      swarm_mode: undefined,
    });
    await waitFor(() => calls() > before);
    controller.close();
  });

  it('advances the message-closure cursor on durable session events, not volatile deltas', async () => {
    const { controller, client, socket } = await openController();
    expect(controller.getState().cursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    deliverFrame(controller, {
      type: 'assistant.delta',
      seq: 10,
      epoch: 'epoch-1',
      volatile: true,
      session_id: 'session_test',
      timestamp: '2026-01-01T00:00:03.000Z',
      payload: { type: 'assistant.delta', turnId: 1, delta: 'x' },
    } as SessionEventFrame);
    expect(controller.getState().cursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    deliverFrame(controller, {
      type: 'turn.ended',
      seq: 14,
      epoch: 'epoch-1',
      session_id: 'session_test',
      timestamp: '2026-01-01T00:00:04.000Z',
      payload: { type: 'turn.ended', turnId: 1, reason: 'completed' },
    } as SessionEventFrame);
    expect(controller.getState().cursor).toEqual({ seq: 14, epoch: 'epoch-1' });
    expect(socket.updateCursor).toHaveBeenCalledWith('session_test', { seq: 14, epoch: 'epoch-1' });
    await controller.regenerateMessage('m-assistant');
    expect(client.regenerateMessage).toHaveBeenCalledWith('session_test', 'm-assistant', {
      expected_cursor: { seq: 14, epoch: 'epoch-1' },
      model: undefined,
      thinking: undefined,
      permission_mode: undefined,
      plan_gate: undefined,
      plan_mode: undefined,
      swarm_mode: undefined,
    });
    controller.close();
  });

  it('forkFromMessage sends the truncation pair and returns the new session', async () => {
    const { controller, client } = await openController();
    const fork = await controller.forkFromMessage('m-user');
    expect(client.forkSession).toHaveBeenCalledWith('session_test', {
      through_message_id: 'm-user',
      expected_cursor: { seq: 10, epoch: 'epoch-1' },
    });
    expect(fork.id).toBe('session_fork');
    controller.close();
  });

  it('refuses edit/regenerate while a resync is in flight', async () => {
    const { controller, client } = await openController();
    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValueOnce(held.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    await expect(controller.editMessage('m1', { text: 'x' })).rejects.toThrow(/resync/i);
    await expect(controller.regenerateMessage('m1')).rejects.toThrow(/resync/i);
    expect(client.editMessage).not.toHaveBeenCalled();
    held.resolve(snapshot());
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });
});

describe('SessionController transcript authority', () => {
  async function openTranscriptController(options: { rewriteResetTimeoutMs?: number } = {}) {
    const client = {
      snapshot: vi.fn(async () => snapshot()),
      listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
      listTasks: vi.fn(async () => ({ items: [] })),
      getSessionGoal: vi.fn(async () => null),
      listMessages: vi.fn(async () => ({ items: [], has_more: false })),
      getAgentTranscript: vi.fn(async (): Promise<AgentTranscriptResponse> => ({
        agent_id: 'main',
        items: [],
        has_more: false,
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      })),
      submitPrompt: vi.fn(),
      replacePrompt: vi.fn(),
      abortPrompt: vi.fn(async () => ({ aborted: true, at_seq: 1 })),
      abortTurn: vi.fn(async () => ({ aborted: true })),
      movePrompt: vi.fn(),
      timingPrompt: vi.fn(),
      getTranscriptOps: vi.fn(async () => ({
        session_id: 'session_test',
        agent_id: 'main',
        epoch: 'epoch-1',
        batches: [],
        through_seq: 0,
        complete: true,
      })),
    };
    const socket = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      updateCursor: vi.fn(),
      abort: vi.fn(),
      setTranscriptGrades: vi.fn(),
      restartGeneration: vi.fn(),
      updateTranscriptSince: vi.fn(),
      clearTranscriptSince: vi.fn(),
    };
    const { scheduler, flushAll } = manualScheduler();
    const controller = new SessionController(
      client as unknown as KikiClient,
      fakeView(client, socket),
      'session_test',
      { scheduler, rewriteResetTimeoutMs: options.rewriteResetTimeoutMs },
    );
    await controller.open();
    return { controller, client, socket, flushAll };
  }

  it.each([
    { origin: { kind: 'cron' as const }, promptId: 'p-cron' },
    { origin: { kind: 'other' as const, payload: { kind: 'agent_message', senderAgentId: 'peer' } }, promptId: 'p-mailbox' },
  ])('aborts an in-flight $origin.kind turn with no visible prompt', async ({ origin, promptId }) => {
    const { controller, client } = await openTranscriptController();
    await controller.abortActive();
    expect(client.abortPrompt).not.toHaveBeenCalled();

    controller.handleTranscript(resetEvent('main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin, promptId, steps: [] }],
      prompts: [],
    }), 1));
    expect(controller.getState()).toMatchObject({
      busy: true,
      activePromptId: undefined,
      abortablePromptId: promptId,
    });
    await controller.abortActive();
    expect(client.abortPrompt).toHaveBeenCalledExactlyOnceWith('session_test', promptId);
    expect(client.listPrompts).not.toHaveBeenCalled();

    controller.handleTranscript(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().abortablePromptId).toBeUndefined();
    await controller.abortActive();
    expect(client.abortPrompt).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('aborts a task-notification turn without a prompt through its exact turn id', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't7', ordinal: 7, state: 'running', origin: { kind: 'other', payload: { kind: 'task_notification' } }, steps: [] }],
      prompts: [],
    }), 1));
    expect(controller.getState()).toMatchObject({ busy: true, activePromptId: undefined, abortablePromptId: undefined, abortableTurnId: 7 });
    await controller.abortActive();
    expect(client.abortTurn).toHaveBeenCalledExactlyOnceWith('session_test', 7);
    expect(client.abortPrompt).not.toHaveBeenCalled();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 2));
    expect(controller.getState().abortableTurnId).toBeUndefined();
    await controller.abortActive();
    expect(client.abortTurn).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('still aborts a visible user prompt through the same endpoint', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true }), 1));
    await controller.abortActive();
    expect(client.abortPrompt).toHaveBeenCalledExactlyOnceWith('session_test', 'p-canonical-1');
    controller.close();
  });

  it('retains independent delta views alongside the unchanged legacy focus baseline', async () => {
    const { controller, socket } = await openTranscriptController();
    controller.setFocusedAgent('legacy-child');
    controller.retainAgentView('left', 'child-1', 'delta');
    controller.retainAgentView('right', 'child-2', 'delta');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'legacy-child': 'delta', 'child-1': 'delta', 'child-2': 'delta',
    });
    controller.releaseAgentView('left');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'legacy-child': 'delta', 'child-2': 'delta',
    });
    controller.setFocusedAgent(undefined);
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'child-2': 'delta',
    });
    controller.updateAgentView('right', 'off');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'turn', main: 'delta' });
    controller.close();
  });

  it('uses the highest same-agent demand without reinitializing a second view', async () => {
    const { controller, client, socket } = await openTranscriptController();
    controller.retainAgentView('route', 'child-1', 'delta');
    controller.handleTranscript(resetEvent('child-1', userTurnSnapshot({ assistantText: 'shared' }), 1));
    const initialized = controller.getAgentState('child-1');
    const calls = socket.setTranscriptGrades.mock.calls.length;
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.updateAgentView('route', 'block');
    controller.releaseAgentView('route');
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(calls);
    expect(controller.getAgentState('child-1')).toBe(initialized);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect(socket.subscribe).toHaveBeenCalledTimes(1);
    expect(client.getAgentTranscript).not.toHaveBeenCalled();
    controller.retainAgentView('inspector', 'child-1', 'block');
    controller.releaseAgentView('tab');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'turn', main: 'delta', 'child-1': 'block' });
    controller.updateAgentView('inspector', 'turn');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'turn', main: 'delta', 'child-1': 'turn' });
    controller.releaseAgentView('inspector');
    const releasedCalls = socket.setTranscriptGrades.mock.calls.length;
    controller.releaseAgentView('inspector');
    controller.updateAgentView('inspector', 'delta');
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(releasedCalls);
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'turn', main: 'delta' });
    controller.close();
  });

  it('retargets a view without suppressing summary observers or main delta', async () => {
    const { controller, socket } = await openTranscriptController();
    const off = controller.subscribeAgent('child-1', vi.fn());
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.retainAgentView('tab', 'child-2', 'block');
    controller.retainAgentView('main-view', 'main', 'off');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'turn', main: 'delta', 'child-1': 'turn', 'child-2': 'block',
    });
    expect(() => controller.retainAgentView('wildcard', '*', 'off')).toThrow('concrete agent ID');
    expect(() => controller.retainAgentView('', 'child-1', 'delta')).toThrow('view ID');
    off();
    controller.close();
    const calls = socket.setTranscriptGrades.mock.calls.length;
    controller.retainAgentView('late', 'child-1', 'delta');
    controller.updateAgentView('tab', 'delta');
    controller.releaseAgentView('tab');
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(calls);
  });

  it('publishes per-agent transcript cursors with their blocks rather than the session cursor', async () => {
    const { controller, flushAll } = await openTranscriptController();
    expect(controller.getState().cursor.seq).toBe(10);
    expect(controller.getAgentTranscriptCursor('main')).toBeUndefined();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ assistantText: 'MAIN' }), 3));
    controller.handleTranscript(resetEvent('child-1', userTurnSnapshot({ assistantText: 'CHILD', streaming: true }), 1));
    controller.handleTranscript(opsEvent('child-1', [
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: ASSISTANT_FRAME_ID }, offset: 5, text: '!' },
    ], 2));
    expect(controller.getAgentTranscriptCursor('child-1')).toEqual({ seq: 1, epoch: 'epoch-canonical' });
    flushAll();
    expect(controller.getAgentTranscriptCursor('child-1')).toEqual({ seq: 2, epoch: 'epoch-canonical' });
    expect(controller.getAgentState('child-1').blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: 'CHILD!' });
    expect(controller.getAgentTranscriptCursor('main')).toEqual({ seq: 3, epoch: 'epoch-canonical' });
    expect(controller.getState().cursor.seq).toBe(10);
    controller.close();
  });

  it('shares a pending older-page request between two views of one agent', async () => {
    const { controller, client } = await openTranscriptController();
    controller.retainAgentView('route', 'child-1', 'delta');
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.handleTranscript(resetEvent('child-1', userTurnSnapshot({ assistantText: 'shared' }), 1, true));
    const held = deferred<AgentTranscriptResponse>();
    client.getAgentTranscript.mockImplementationOnce(async () => held.promise);
    const first = controller.loadOlderMessages('child-1');
    const second = controller.loadOlderMessages('child-1');
    controller.releaseAgentView('route');
    expect(client.getAgentTranscript).toHaveBeenCalledTimes(1);
    held.resolve({ agent_id: 'child-1', items: [{ kind: 'turn', turnId: 't0', prompt: 'older', steps: [] }], has_more: false });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(controller.getAgentState('child-1').blocks.some((block) => block.kind === 'user' && block.text === 'older')).toBe(true);
    controller.close();
  });

  it('retains the reopened bound model through sparse resets but accepts explicit transcript model changes', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    client.snapshot.mockResolvedValue(snapshot({ session: { ...session, agent_config: { model: 'bound-first', profile: 'pinned-profile' } } }));
    await controller.open();
    flushAll();
    expect(controller.getState().model).toBe('bound-first');
    const reset = (seq: number, meta: object) => {
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.reset', agent_id: 'main', seq,
        snapshot: { items: [], agents: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta },
      }));
      flushAll();
    };
    reset(1, {});
    expect(controller.getState().model).toBe('bound-first');
    expect(resolveEffectiveModel(undefined, controller.getState().model, 'unavailable-default')).toBe('bound-first');
    expect(resolveEffectiveModel('user-override', controller.getState().model, 'unavailable-default')).toBe('user-override');
    expect(controller.getState().profile).toBe('pinned-profile');
    reset(2, { agent: { model: 'explicit-second' } });
    expect(controller.getState().model).toBe('explicit-second');
    reset(3, { agent: { usage: { total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } } } });
    expect(controller.getState().model).toBe('explicit-second');
    controller.close();
  });

  it('does not adopt snapshot messages or in-flight text on open', async () => {
    const { controller, client, socket } = await openTranscriptController();
    expect(client.snapshot).toHaveBeenCalledWith('session_test', { transcript: true });
    expect(client.listMessages).not.toHaveBeenCalled();
    expect(socket.subscribe).toHaveBeenCalledWith(
      'session_test',
      { seq: 10, epoch: 'epoch-1' },
      expect.objectContaining({ '*': 'turn', main: 'delta' }),
    );
    expect(controller.getState().blocks).toEqual([]);
    controller.close();
  });

  it('converges reset then ops once and does not mix legacy timeline frames', async () => {
    const { controller, socket, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            prompt: 'hi',
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text: 'Hello' }],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'frame.upsert',
          turnId: 't1',
          stepId: 't1.1',
          frame: { kind: 'text', frameId: 'f1', role: 'assistant', text: 'Hello world' },
        },
      ],
    }));
    flushAll();
    const assistants = controller.getState().blocks.filter((block) => block.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ id: 'agent-frame-f1', text: 'Hello world' });

    deliverFrame(controller,
      frame({ type: 'assistant.delta', turnId: 1, delta: ' extra' } as never, { volatile: true, offset: 11 }),
    );
    flushAll();
    expect(controller.getState().blocks.filter((block) => block.kind === 'assistant')).toHaveLength(1);
    expect(socket.restartGeneration).not.toHaveBeenCalled();
    controller.close();
  });

  it('keeps a running child running until a terminal task op arrives', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'spawn',
                    toolCallId: 'tc-agent',
                    name: 'Agent',
                    state: 'running',
                    agentRefs: [{ agentId: 'child-1', role: 'child' }],
                  },
                ],
              },
            ],
          },
        ],
        tasks: [
          {
            taskId: 'task-1',
            kind: 'subagent',
            state: 'running',
            detached: false,
            agentId: 'child-1',
            outputTail: '',
            description: 'child-1',
          },
        ],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    const forest = controller.getForest();
    expect(forest?.byId['child-1']?.status).toBe('running');
    expect(
      controller.getState().blocks.find((block) => block.kind === 'tool' && block.toolCallId === 'tc-agent'),
    ).toMatchObject({ agentRefs: [{ agentId: 'child-1', role: 'child' }] });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'task.upsert',
          task: {
            taskId: 'task-1',
            kind: 'subagent',
            state: 'completed',
            detached: false,
            agentId: 'child-1',
            outputTail: '',
            description: 'child-1',
          },
        },
      ],
    }));
    flushAll();
    expect(controller.getForest()?.byId['child-1']?.status).toBe('completed');
    controller.close();
  });

  it('does not paint queued replace/steer as aborted or stopped', async () => {
    const { controller } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-queued',
            status: 'queued',
            createdAt: '2026-01-01T00:00:00.000Z',
            content: [{ type: 'text', text: 'later' }],
          },
        ],
        meta: {},
      },
    }));
    expect(controller.getState().queuedPromptIds).toEqual(['p-queued']);
    expect(controller.getState().blocks.some((block) => 'stopped' in block && block.stopped === true)).toBe(false);
    expect(controller.getState().blocks.some((block) => block.kind === 'notice' && block.text.includes('aborted'))).toBe(false);
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'later',
      promptId: 'p-queued',
      promptStatus: 'queued',
    });
    controller.close();
  });

  it('prepends older pages by entity id and clears them on reset', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: true,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'new',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: true,
      },
    }));
    const olderPage = {
      agent_id: 'main',
      has_more: true,
      items: [
        {
          kind: 'turn' as const,
          turnId: 't1',
          ordinal: 1,
          state: 'completed' as const,
          origin: { kind: 'user' as const },
          prompt: 'old',
          steps: [],
        },
        {
          kind: 'turn' as const,
          turnId: 't2',
          ordinal: 2,
          state: 'completed' as const,
          origin: { kind: 'user' as const },
          prompt: 'new',
          steps: [],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
    client.getAgentTranscript.mockResolvedValueOnce(olderPage);
    client.getAgentTranscript.mockResolvedValueOnce(olderPage);
    await expect(controller.loadOlderMessages('main')).resolves.toBe(true);
    const firstIds = controller.getState().blocks.map((block) => block.id);
    await expect(controller.loadOlderMessages('main')).resolves.toBe(true);
    expect(controller.getState().blocks.map((block) => block.id)).toEqual(firstIds);

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 3,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't9',
            ordinal: 9,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'fresh',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    expect(controller.getState().blocks.some((block) => block.id.includes('t1'))).toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t9'))).toBe(true);
    controller.close();
  });

  it.each([
    { agentId: 'main', initialCount: undefined },
    { agentId: 'child-1', initialCount: undefined },
    { agentId: 'main', initialCount: 10 },
    { agentId: 'child-1', initialCount: 10 },
  ])('publishes older REST aggregate for $agentId without rewinding $initialCount', async ({ agentId, initialCount }) => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset', agent_id: agentId, has_more_older: true, seq: 1,
      snapshot: {
        items: [{ kind: 'turn', turnId: 't2', ordinal: 2, state: 'completed', origin: { kind: 'user' }, prompt: 'new', steps: [] }],
        tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
        toolCallCount: initialCount, hasMoreOlder: true,
      },
    }));
    expect(controller.getForest()?.byId[agentId]).toMatchObject({
      toolCallCount: initialCount ?? 0,
      toolCallCountKnown: initialCount !== undefined,
    });
    let resolvePage!: (page: AgentTranscriptResponse) => void;
    client.getAgentTranscript.mockImplementationOnce(() => new Promise<AgentTranscriptResponse>((resolve) => { resolvePage = resolve; }));
    const pending = controller.loadOlderMessages(agentId);
    if (initialCount !== undefined) {
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.ops', agent_id: agentId, seq: 2,
        ops: [{ op: 'frame.upsert', turnId: 't2', stepId: 't2.1', frame: { kind: 'tool', frameId: 'late-tool', toolCallId: 'late-call', name: 'Read', state: 'done' } }],
      }));
      flushAll();
      expect(controller.getForest()?.byId[agentId]?.toolCallCount).toBe(11);
    }
    const olderTurn = { kind: 'turn' as const, turnId: 't1', ordinal: 1, state: 'completed' as const, origin: { kind: 'user' as const }, prompt: 'older', steps: [] };
    resolvePage({
      agent_id: agentId, has_more: false, tool_call_count: 7,
      cursor: { seq: 1, epoch: 'epoch-1' },
      items: [olderTurn],
    });
    await expect(pending).resolves.toBe(true);
    expect(controller.getForest()?.byId[agentId]).toMatchObject({
      toolCallCount: initialCount === undefined ? 7 : 11,
      toolCallCountKnown: true,
    });
    await expect(controller.loadOlderMessages(agentId)).resolves.toBe(false);
    expect(client.getAgentTranscript).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('coalesces high-frequency appends into one publication and skips forest rebuilds', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text: '' }],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    const forests = controller.forestPublishCount;
    let publishes = 0;
    controller.subscribe(() => {
      publishes += 1;
    });
    for (let i = 0; i < 8; i += 1) {
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.ops',
        agent_id: 'main',
        seq: 2 + i,
        ops: [
          {
            op: 'append',
            target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
            offset: i,
            text: 'x',
          },
        ],
      }));
    }
    expect(publishes).toBe(0);
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: '',
    });
    flushAll();
    expect(publishes).toBe(1);
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'xxxxxxxx',
    });
    expect(controller.forestPublishCount).toBe(forests);
    controller.close();
  });

  it('clears plan/swarm/queue/active/pending from the current AgentState', async () => {
    const { controller } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [],
        tasks: [],
        interactions: [
          { interactionId: 'apr-1', interactionKind: 'approval', state: 'pending' },
        ],
        attachments: [],
        todos: [],
        prompts: [
          { promptId: 'p-run', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' },
          { promptId: 'p-q', status: 'queued', createdAt: '2026-01-01T00:00:01.000Z' },
        ],
        meta: { modes: { plan: {}, swarm: {} }, agent: { permission: 'yolo' } },
      },
    }));
    expect(controller.getState()).toMatchObject({
      planMode: true,
      swarmMode: true,
      queuedPromptIds: ['p-q'],
      activePromptId: 'p-run',
      pendingInteraction: 'approval',
      permissionMode: 'yolo',
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 2,
      snapshot: {
        items: [],
        tasks: [],
        interactions: [
          { interactionId: 'apr-1', interactionKind: 'approval', state: 'approved' },
        ],
        attachments: [],
        todos: [],
        prompts: [],
        meta: { modes: {}, agent: {} },
      },
    }));
    expect(controller.getState()).toMatchObject({
      planMode: false,
      swarmMode: false,
      queuedPromptIds: [],
      activePromptId: undefined,
      pendingInteraction: 'none',
    });
    controller.close();
  });

  it('ignores an older page that lands after a reset', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: true,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'new',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: true,
      },
    }));
    let release!: (value: AgentTranscriptResponse) => void;
    client.getAgentTranscript.mockReturnValueOnce(
      new Promise<AgentTranscriptResponse>((resolve) => {
        release = resolve;
      }),
    );
    const pending = controller.loadOlderMessages('main');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 2,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't9',
            ordinal: 9,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'fresh',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    release({
      agent_id: 'main',
      has_more: false,
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          prompt: 'stale',
          steps: [],
        },
      ],
      attachments: [],
    });
    await expect(pending).resolves.toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t1'))).toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t9'))).toBe(true);
    controller.close();
  });

  it('publishes tool completion, interaction resolve, and equal-length text replacement', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [
                  { kind: 'text', frameId: 'f1', role: 'assistant', text: 'abcd' },
                  {
                    kind: 'tool',
                    frameId: 'tool-1',
                    toolCallId: 'tc-1',
                    name: 'Read',
                    state: 'running',
                    input: { path: 'a.ts' },
                  },
                ],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [{ interactionId: 'apr-1', interactionKind: 'approval', state: 'pending' }],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    expect(controller.getState().blocks.find((block) => block.kind === 'tool')).toMatchObject({
      status: 'running',
    });
    expect(controller.getState().pendingInteraction).toBe('approval');

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'frame.upsert',
          turnId: 't1',
          stepId: 't1.1',
          frame: {
            kind: 'tool',
            frameId: 'tool-1',
            toolCallId: 'tc-1',
            name: 'Read',
            state: 'done',
            output: 'file contents',
          },
        },
        {
          op: 'interaction.upsert',
          interaction: { interactionId: 'apr-1', interactionKind: 'approval', state: 'approved' },
        },
        {
          op: 'frame.upsert',
          turnId: 't1',
          stepId: 't1.1',
          frame: { kind: 'text', frameId: 'f1', role: 'assistant', text: 'wxyz' },
        },
      ],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'tool')).toMatchObject({
      status: 'done',
      output: 'file contents',
    });
    expect(controller.getState().pendingInteraction).toBe('none');
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'wxyz',
    });
    controller.close();
  });

  it('closes pagination loading after a successful older page and a mid-flight reset', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: true,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't2',
            ordinal: 2,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'new',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: true,
      },
    }));
    client.getAgentTranscript.mockResolvedValueOnce({
      agent_id: 'main',
      has_more: true,
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          prompt: 'old',
          steps: [],
        },
      ],
      attachments: [],
    });
    await expect(controller.loadOlderMessages('main')).resolves.toBe(true);
    expect(controller.getState()).toMatchObject({
      loadingOlder: false,
      fetchedOlder: true,
      olderError: undefined,
      hasMoreHistory: true,
    });
    client.getAgentTranscript.mockResolvedValueOnce({
      agent_id: 'main',
      has_more: true,
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          prompt: 'oldest',
          steps: [],
        },
      ],
      attachments: [],
    });
    await expect(controller.loadOlderMessages('main')).resolves.toBe(true);
    expect(controller.getState().loadingOlder).toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t0'))).toBe(true);

    let release!: (value: AgentTranscriptResponse) => void;
    client.getAgentTranscript.mockReturnValueOnce(
      new Promise<AgentTranscriptResponse>((resolve) => {
        release = resolve;
      }),
    );
    const pending = controller.loadOlderMessages('main');
    expect(controller.getState().loadingOlder).toBe(true);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 3,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't9',
            ordinal: 9,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'fresh',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    expect(controller.getState().loadingOlder).toBe(false);
    release({
      agent_id: 'main',
      has_more: false,
      items: [{ kind: 'turn', turnId: 't1', prompt: 'stale', steps: [] }],
      attachments: [],
    });
    await expect(pending).resolves.toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t1'))).toBe(false);
    controller.close();
  });

  it('does not resurrect a queued strip after a transcript delivery outruns the submit response', async () => {
    const { controller, client } = await openTranscriptController();
    let resolveSubmit!: (value: {
      prompt_id: string; user_message_id: string; status: 'queued';
      content: { type: 'text'; text: string }[]; created_at: string;
    }) => void;
    client.submitPrompt = vi.fn(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    const submitted = controller.sendPrompt({ text: 'canonical user prompt', permissionMode: 'manual' });
    controller.handleTranscript(resetEvent('main', userTurnSnapshot(), 1));
    expect(controller.getState().queuedPromptIds).toEqual([]);
    resolveSubmit({
      prompt_id: 'p-canonical-1', user_message_id: 'um-canonical-1', status: 'queued',
      content: [{ type: 'text', text: 'canonical user prompt' }], created_at: '2026-01-01T00:00:00.000Z',
    });
    await submitted;
    expect(controller.getState().queuedPromptIds).toEqual([]);
    expect(controller.getState().blocks.filter((block) => block.kind === 'user')).toEqual([
      expect.objectContaining({ turnId: 't1', promptStatus: undefined }),
    ]);
    controller.close();
  });

  it('keeps local prompt echo until the matching prompt op lands and updates replaced content', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    client.submitPrompt = vi.fn(async () => ({
      prompt_id: 'p-local',
      user_message_id: 'um-local',
      status: 'queued',
      content: [{ type: 'text', text: 'echo' }],
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    client.replacePrompt = vi.fn(async () => ({
      prompt_id: 'p-local',
      user_message_id: 'um-local',
      status: 'queued',
      content: [{ type: 'text', text: 'replaced' }],
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    await controller.sendPrompt({ text: 'echo', permissionMode: 'manual' });
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'echo',
      promptId: 'p-local',
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 1,
      ops: [
        {
          op: 'prompt.upsert',
          prompt: {
            promptId: 'p-local',
            status: 'queued',
            createdAt: '2026-01-01T00:00:00.000Z',
            userMessageId: 'um-local',
            content: [{ type: 'text', text: 'echo' }],
          },
        },
      ],
    }));
    flushAll();
    expect(controller.getState().blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    await controller.replaceQueued('p-local', 'replaced');
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'replaced',
    });
    controller.close();
  });

  it('keeps an attachment-only queued echo visible and explicitly removes its media in place', async () => {
    const { controller, client } = await openTranscriptController();
    const image = { type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/a.png' } };
    client.submitPrompt = vi.fn(async () => ({
      prompt_id: 'p-media', user_message_id: 'um-media', status: 'queued' as const,
      content: [image], created_at: '2026-01-01T00:00:00.000Z',
    }));
    client.replacePrompt = vi.fn(async () => ({
      prompt_id: 'p-media', user_message_id: 'um-media', status: 'queued' as const,
      content: [{ type: 'text' as const, text: 'keep text' }], created_at: '2026-01-01T00:00:00.000Z',
    }));
    await controller.sendPrompt({ text: '', content: [image], permissionMode: 'manual' });
    expect(controller.getState().blocks.find((block): block is UserBlock => block.kind === 'user'))
      .toMatchObject({ queuedContent: [image], media: [{ url: 'https://example.test/a.png' }] });
    await controller.replaceQueued('p-media', 'keep text', []);
    expect(client.replacePrompt).toHaveBeenCalledWith('session_test', 'p-media', {
      content: [{ type: 'text', text: 'keep text' }], replace_attachments: true,
    });
    expect(controller.getState().blocks.find((block): block is UserBlock => block.kind === 'user'))
      .toMatchObject({ text: 'keep text', queuedContent: [{ type: 'text', text: 'keep text' }] });
    controller.close();
  });

  it('moves a queued prompt through the transport and applies the returned order immediately', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 1,
      ops: ['p1', 'p2', 'p3'].map((promptId, index) => ({
        op: 'prompt.upsert' as const,
        prompt: {
          promptId,
          status: 'queued' as const,
          userMessageId: `m${index + 1}`,
          content: [{ type: 'text', text: promptId }],
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
          queuePosition: index,
        },
      })),
    }));
    flushAll();
    client.movePrompt.mockResolvedValueOnce({
      moved: true,
      prompt_id: 'p3',
      target_index: 0,
      queued_prompt_ids: ['p3', 'p1', 'p2'],
    });

    await controller.moveQueued('p3', 0);

    expect(client.movePrompt).toHaveBeenCalledWith('session_test', 'p3', { target_index: 0 });
    expect(controller.getState().queuedPromptIds).toEqual(['p3', 'p1', 'p2']);
    controller.close();
  });

  it('re-times a queued prompt with the known revision and applies the reply', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 1,
      ops: [
        {
          op: 'prompt.upsert' as const,
          prompt: {
            promptId: 'p1',
            status: 'queued' as const,
            userMessageId: 'm1',
            content: [{ type: 'text', text: 'parked' }],
            createdAt: '2026-01-01T00:00:00.000Z',
            queuePosition: 0,
            appendTiming: 'agent_idle' as const,
            revision: 3,
          },
        },
      ],
    }));
    flushAll();
    client.timingPrompt.mockResolvedValueOnce({
      prompt_id: 'p1',
      user_message_id: 'm1',
      status: 'queued',
      content: [{ type: 'text', text: 'parked' }],
      created_at: '2026-01-01T00:00:00.000Z',
      append_timing: 'tasks_done',
      revision: 4,
    });

    await controller.setQueuedTiming('p1', 'tasks_done');

    expect(client.timingPrompt).toHaveBeenCalledWith('session_test', 'p1', {
      append_timing: 'tasks_done',
      expected_revision: 3,
    });
    expect(controller.getState().queuedPromptMeta['p1']).toEqual({ appendTiming: 'tasks_done', revision: 4 });
    controller.close();
  });

  it('marks live assistant streaming during appends and clears it on a terminal step upsert', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text: 'He' }],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {
          agent: {
            phase: {
              kind: 'streaming',
              turnId: 1,
              step: 1,
              stepId: 't1.1',
              stream: 'assistant',
              since: 0,
            },
          },
        },
      },
    }));
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 2,
          text: 'llo',
        },
      ],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
      text: 'Hello',
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 3,
      ops: [
        {
          op: 'step.upsert',
          turnId: 't1',
          step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed' },
        },
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' } },
        },
        { op: 'meta.merge', meta: { agent: { phase: { kind: 'idle' } } } },
      ],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: false,
      text: 'Hello',
    });
    controller.close();
  });

  describe('canonical product gates via SessionController.handleTranscript', () => {
  it('keeps optimistic echo → prompt fact → turn completion as one stable user key', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    client.submitPrompt = vi.fn(async () => ({
      prompt_id: 'p-canonical-1',
      user_message_id: 'um-canonical-1',
      status: 'running',
      content: [{ type: 'text', text: 'canonical user prompt' }],
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    await controller.sendPrompt({ text: 'canonical user prompt', permissionMode: 'manual' });
    const echo = controller.getState().blocks.find((block) => block.kind === 'user');
    expect(echo).toMatchObject({ id: 'user-um-canonical-1', userMessageId: 'um-canonical-1', promptId: 'p-canonical-1' });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user', payload: { promptId: 'p-canonical-1', userMessageId: 'um-canonical-1' } },
            prompt: 'canonical user prompt',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-canonical-1',
            status: 'running',
            userMessageId: 'um-canonical-1',
            content: [{ type: 'text', text: 'canonical user prompt' }],
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      },
    }));
    expect(controller.getState().blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(controller.getState().blocks.find((block) => block.kind === 'user')?.id).toBe(echo?.id);

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-canonical-1', userMessageId: 'um-canonical-1' } },
          },
        },
        {
          op: 'prompt.upsert',
          prompt: {
            promptId: 'p-canonical-1',
            status: 'completed',
            userMessageId: 'um-canonical-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:02.000Z',
          },
        },
      ],
    }));
    flushAll();
    const users = controller.getState().blocks.filter((block) => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(echo?.id);
    expect(users[0]).toMatchObject({ userMessageId: 'um-canonical-1', promptId: 'p-canonical-1' });
    controller.close();
  });

  it('keeps edit/fork identity after a regenerate reset that only carries a running prompt', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-edit', userMessageId: 'um-anchor' } },
            prompt: 'First fixture question — edited resend.',
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                frames: [
                  {
                    kind: 'text',
                    frameId: 'asst-t1',
                    role: 'assistant',
                    text: 'EDITED-REPLY landed after the rewrite.',
                    part: { partId: 'part-asst', messageId: 'am-edit', revision: 1, provenance: { source: 'engine' } },
                  },
                ],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-edit',
            status: 'completed',
            userMessageId: 'um-anchor',
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:02.000Z',
          },
        ],
        meta: {},
      },
    }));
    const settled = controller.getState().blocks.find((block) => block.kind === 'user') as UserBlock | undefined;
    expect(settled).toMatchObject({ userMessageId: 'um-anchor', promptStatus: undefined });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 2,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user', payload: { promptId: 'p-regen', userMessageId: 'um-anchor' } },
            prompt: 'First fixture question — edited resend.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-regen',
            status: 'running',
            userMessageId: 'um-anchor',
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: '2026-01-01T00:00:03.000Z',
          },
        ],
        meta: {},
      },
    }));
    flushAll();
    const regenerating = controller.getState().blocks.find((block) => block.kind === 'user') as UserBlock | undefined;
    expect(regenerating).toMatchObject({
      id: settled?.id,
      userMessageId: 'um-anchor',
      promptStatus: undefined,
    });
    controller.close();
  });

  it('holds items.remove during a rewrite resync so the regenerate reset can keep the user bubble', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-edit', userMessageId: 'um-anchor' } },
            prompt: 'First fixture question — edited resend.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-edit',
            status: 'completed',
            userMessageId: 'um-anchor',
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:02.000Z',
          },
        ],
        meta: {},
      },
    }));
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      userMessageId: 'um-anchor',
      promptStatus: undefined,
    });

    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValueOnce(held.promise);
    void controller.resync({ rewrite: true });
    await waitFor(() => controller.getState().resyncing);

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [{ op: 'items.remove', ids: ['t1'] }],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      userMessageId: 'um-anchor',
      promptStatus: undefined,
    });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      cursor: { seq: 3, epoch: 'epoch-2' },
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user', payload: { promptId: 'p-regen', userMessageId: 'um-anchor' } },
            prompt: 'First fixture question — edited resend.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-regen',
            status: 'running',
            userMessageId: 'um-anchor',
            content: [{ type: 'text', text: 'First fixture question — edited resend.' }],
            createdAt: '2026-01-01T00:00:03.000Z',
          },
        ],
        meta: {},
      },
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      id: 'user-um-anchor',
      userMessageId: 'um-anchor',
      promptStatus: undefined,
    });
    held.resolve(snapshot({ as_of_seq: 12 }));
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });

  it('enters rewrite hold while a normal resync is in flight and reruns the queued rewrite', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't-overlap',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Keep me until the queued rewrite baseline arrives.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));

    const ordinary = deferred<SessionSnapshotResponse>();
    const rewrite = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValueOnce(ordinary.promise).mockReturnValueOnce(rewrite.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [{ op: 'items.remove', ids: ['t-overlap'] }],
    }));
    void controller.resync({ rewrite: true });
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'Keep me until the queued rewrite baseline arrives.',
    });

    ordinary.resolve(snapshot({ as_of_seq: 11 }));
    await waitFor(() => client.snapshot.mock.calls.length === 3);
    expect(controller.getState().resyncing).toBe(true);
    rewrite.resolve(snapshot({ as_of_seq: 12 }));
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    expect(client.snapshot).toHaveBeenCalledTimes(3);

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 3, epoch: 'epoch-2' },
      snapshot: {
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    expect(controller.getState().blocks).toEqual([]);
    controller.close();
  });

  it('keeps hold through an unrelated same-generation reset until the rewrite epoch changes', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 1, epoch: 'epoch-before-rewrite' },
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't-generation',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Generation-bound user body.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    controller.handleSignal({ type: 'status', status: 'open', generation: 7 });
    void controller.resync({ rewrite: true });
    await waitFor(() => client.snapshot.mock.calls.length === 2);
    await waitFor(() => !controller.getState().resyncing);

    const unrelatedSnapshot = {
      items: [
        {
          kind: 'turn' as const,
          turnId: 't-generation',
          ordinal: 1,
          state: 'completed' as const,
          origin: { kind: 'user' as const },
          prompt: 'Unrelated baseline still has the user body.',
          steps: [],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
    const emptySnapshot = {
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 2, epoch: 'epoch-before-rewrite' },
      snapshot: unrelatedSnapshot,
    }), 7);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      cursor: { seq: 3, epoch: 'epoch-before-rewrite' },
      ops: [{ op: 'items.remove', ids: ['t-generation'] }],
    }), 7);
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'Generation-bound user body.',
    });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 1, epoch: 'epoch-after-rewrite' },
      snapshot: emptySnapshot,
    }), 7);
    expect(controller.getState().blocks).toEqual([]);
    controller.close();
  });

  it('uses the armed rewrite subscription token when transcript epochs are unavailable', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 1 },
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't-token',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Token-bound user body.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    controller.handleSignal({ type: 'status', status: 'open', generation: 4 });
    void controller.resync({ rewrite: true });
    await waitFor(() => client.snapshot.mock.calls.length === 2);
    await waitFor(() => !controller.getState().resyncing);
    expect(socket.restartGeneration).toHaveBeenCalledTimes(1);

    const emptySnapshot = {
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 2 },
      snapshot: emptySnapshot,
    }), 4);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      cursor: { seq: 3 },
      ops: [{ op: 'items.remove', ids: ['t-token'] }],
    }), 5);
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'Token-bound user body.',
    });

    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      cursor: { seq: 1 },
      snapshot: emptySnapshot,
    }), 5);
    expect(controller.getState().blocks).toEqual([]);
    controller.close();
  });

  it('falls back to a hard resync when the rewrite snapshot succeeds without a main reset', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController({
      rewriteResetTimeoutMs: 20,
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't-timeout',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Release me through hard recovery.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));

    void controller.resync({ rewrite: true });
    await waitFor(() => client.snapshot.mock.calls.length >= 3);
    await waitFor(() => socket.restartGeneration.mock.calls.length === 1);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [{ op: 'items.remove', ids: ['t-timeout'] }],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toBeUndefined();
    controller.close();
  });

  it('hard resyncs when the rewrite subscription is rejected', async () => {
    const { controller, client, socket } = await openTranscriptController();
    controller.handleSignal({ type: 'status', status: 'open', generation: 9 });
    void controller.resync({ rewrite: true });
    await waitFor(() => client.snapshot.mock.calls.length === 2);
    await waitFor(() => !controller.getState().resyncing);
    await waitFor(() => socket.restartGeneration.mock.calls.length === 1);
    controller.handleSubscribeRejected(10);
    await waitFor(() => socket.restartGeneration.mock.calls.length === 2);
    await waitFor(() => client.snapshot.mock.calls.length === 3);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });

  it('releases deferred removals when the rewrite snapshot seed fails', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't-seed-failure',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'Seed failure body.',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    client.snapshot.mockRejectedValueOnce(new Error('snapshot seed failed'));
    void controller.resync({ rewrite: true });
    await waitFor(() => controller.getState().resyncFailed);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [{ op: 'items.remove', ids: ['t-seed-failure'] }],
    }));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toBeUndefined();
    controller.close();
  });

  function textTurnSnapshot(frameId: string, text: string) {
    return {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user' },
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'running',
              frames: [{ kind: 'text', frameId, role: 'assistant', text }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
    };
  }

  function seedTextAgent(
    controller: SessionController,
    agentId: string,
    frameId: string,
    text: string,
    seq = 1,
  ): void {
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: agentId,
      has_more_older: false,
      seq,
      snapshot: textTurnSnapshot(frameId, text),
    }));
  }

  it.each([
    { agentId: 'main', initialCount: undefined },
    { agentId: 'child-1', initialCount: undefined },
    { agentId: 'main', initialCount: 10 },
    { agentId: 'child-1', initialCount: 10 },
  ])('STAT-R2 owns a mutable canonical baseline for $agentId / $initialCount', async ({ agentId, initialCount }) => {
    const { controller, client, flushAll } = await openTranscriptController();
    const tool = { kind: 'tool', frameId: 'count-tool', toolCallId: 'count-call', name: 'Read', state: 'done' };
    const source = textTurnSnapshot('body', 'body');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset', agent_id: agentId, has_more_older: true, seq: 1,
      snapshot: {
        ...source, toolCallCount: initialCount, hasMoreOlder: true,
        items: initialCount === undefined ? source.items : source.items.map((turn) => ({
          ...turn, steps: turn.steps.map((step) => ({ ...step, frames: [...step.frames, tool] })),
        })),
      },
    }));
    const page = { agent_id: agentId, items: [{ kind: 'turn' as const, turnId: 't0', prompt: 'older', steps: [] }], has_more: false,
      tool_call_count: initialCount ?? 7, cursor: { epoch: 'epoch-1', seq: 1 } };
    client.getAgentTranscript.mockResolvedValueOnce(page);
    await controller.loadOlderMessages(agentId);
    expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: initialCount ?? 7, toolCallCountKnown: true });
    for (const seq of [2, 3]) {
      controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq,
        ops: [{ op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: tool }] }));
      flushAll();
      expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: initialCount === undefined ? 8 : 10, toolCallCountKnown: true });
    }
    for (const seq of [4, 5]) {
      controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq,
        ops: [{ op: 'items.remove', ids: ['t1'] }] }));
      flushAll();
      expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: initialCount === undefined ? 7 : 9, toolCallCountKnown: true });
    }
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: agentId, seq: 6,
      snapshot: { ...textTurnSnapshot('fresh', 'fresh'), toolCallCount: 0 } }));
    expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: 0, toolCallCountKnown: true });
    const state = agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
    expect(state.blocks.some((block) => block.id.includes('t0'))).toBe(false);
    controller.close();
  });

  it.each(['main', 'child-1'])('STAT-R2 aligns late and future REST watermarks for %s', async (agentId) => {
    for (const order of ['late', 'future'] as const) {
      const { controller, client, flushAll } = await openTranscriptController();
      controller.setFocusedAgent(agentId);
      controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: agentId, seq: 1, has_more_older: true,
        snapshot: { ...textTurnSnapshot('body', 'body'), hasMoreOlder: true } }));
      const held = deferred<AgentTranscriptResponse>();
      client.getAgentTranscript.mockImplementationOnce(() => held.promise);
      const pending = controller.loadOlderMessages(agentId);
      const live = () => {
        controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq: 2,
          ops: [{ op: 'frame.upsert', turnId: 't1', stepId: 't1.1', frame: { kind: 'tool', frameId: 'new', toolCallId: 'new', name: 'Read', state: 'done' } }] }));
        flushAll();
      };
      if (order === 'late') live();
      const page = { agent_id: agentId, items: [{ kind: 'turn' as const, turnId: 't0', prompt: 'older', steps: [] }], has_more: false,
        tool_call_count: order === 'late' ? 7 : 8, cursor: { epoch: 'epoch-1', seq: order === 'late' ? 1 : 2 } };
      held.resolve(page);
      await pending;
      if (order === 'future') {
        expect(controller.getForest()?.byId[agentId]?.toolCallCountKnown).toBe(false);
        live();
      }
      expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: 8, toolCallCountKnown: true });
      controller.close();
    }
  });

  it.each([
    { label: 'missing', count: undefined, known: false },
    { label: 'failed partial backfill', count: undefined, known: false },
    { label: 'readable empty wire', count: 0, known: true },
  ])('STAT-R3 keeps $label knowledge through full WS reset and forest', async ({ label, count, known }) => {
    const { controller } = await openTranscriptController();
    const source = textTurnSnapshot('body', 'body');
    const items = label === 'failed partial backfill' ? source.items.map((turn) => ({
      ...turn, steps: turn.steps.map((step) => ({ ...step, frames: [...step.frames,
        { kind: 'tool', frameId: 'partial-tool', toolCallId: 'partial-call', name: 'Read', state: 'done' },
      ] })),
    })) : source.items;
    for (const agentId of ['main', 'child-1']) {
      controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: agentId, seq: 1,
        snapshot: { ...source, items, toolCallCount: count, toolCallCountKnown: known } }));
      expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: 0, toolCallCountKnown: known });
    }
    controller.close();
  });

  it.each(['main', 'child-1'])('STAT-R3 publishes count-only authority and rejects replay for %s', async (agentId) => {
    const { controller, flushAll } = await openTranscriptController();
    seedTextAgent(controller, agentId, 'body', 'body');
    const mainBefore = controller.getState();
    const notifiedCounts: (number | undefined)[] = [];
    controller.subscribe(() => { notifiedCounts.push(controller.getForest()?.byId[agentId]?.toolCallCount); });
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq: 2,
      ops: [{ op: 'tool.count.set', count: 4 }] }));
    flushAll();
    expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: 4, toolCallCountKnown: true });
    expect(notifiedCounts.at(-1)).toBe(4);
    expect(controller.getState()).not.toBe(mainBefore);
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq: 3,
      ops: [{ op: 'tool.count.set' }] }));
    flushAll();
    expect(controller.getForest()?.byId[agentId]).toMatchObject({ toolCallCount: 0, toolCallCountKnown: false });
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: agentId, seq: 2,
      ops: [{ op: 'tool.count.set', count: 4 }] }));
    flushAll();
    expect(controller.getForest()?.byId[agentId]?.toolCallCountKnown).toBe(false);
    controller.close();
  });

  it.each([undefined, { epoch: 'wrong-epoch', seq: 1 }])('STAT-R2 does not guess an unaligned REST cursor %s', async (cursor) => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: 'main', seq: 1, has_more_older: true,
      snapshot: { ...textTurnSnapshot('body', 'body'), hasMoreOlder: true } }));
    const page = { agent_id: 'main', items: [], has_more: false, tool_call_count: 7, cursor };
    client.getAgentTranscript.mockResolvedValueOnce(page);
    await controller.loadOlderMessages('main');
    expect(controller.getForest()?.byId['main']?.toolCallCountKnown).toBe(false);
    controller.close();
  });

  it('STAT-R2 does not restore an older REST count across a fresh unavailable statement', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: 'main', seq: 1, has_more_older: true,
      snapshot: { ...textTurnSnapshot('body', 'body'), hasMoreOlder: true } }));
    const held = deferred<AgentTranscriptResponse>();
    client.getAgentTranscript.mockImplementationOnce(() => held.promise);
    const pending = controller.loadOlderMessages('main');
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', seq: 2,
      ops: [{ op: 'tool.count.set' }] }));
    flushAll();
    held.resolve({ agent_id: 'main', items: [], has_more: false, tool_call_count: 7, cursor: { seq: 1, epoch: 'epoch-1' } });
    await pending;
    expect(controller.getForest()?.byId['main']?.toolCallCountKnown).toBe(false);
    controller.close();
  });

  it('STAT-R2 does not treat filtered turn-grade history as a zero tool delta', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.reset', agent_id: 'child-1', seq: 1, has_more_older: true,
      snapshot: { ...textTurnSnapshot('body', 'body'), hasMoreOlder: true } }));
    const held = deferred<AgentTranscriptResponse>();
    client.getAgentTranscript.mockImplementationOnce(() => held.promise);
    const pending = controller.loadOlderMessages('child-1');
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'child-1', seq: 2, ops: [] }));
    flushAll();
    held.resolve({ agent_id: 'child-1', items: [], has_more: false, tool_call_count: 7, cursor: { seq: 1, epoch: 'epoch-1' } });
    await pending;
    expect(controller.getForest()?.byId['child-1']?.toolCallCountKnown).toBe(false);
    controller.close();
  });

  it('cancels a rewrite watchdog queued behind a terminally failed ordinary resync', async () => {
    vi.useFakeTimers();
    const { ApiError } = await import('../transport');
    const { controller, client, socket } = await openTranscriptController();
    try {
      seedTextAgent(controller, 'main', 'f1', 'Retained');
      const held = deferred<SessionSnapshotResponse>();
      client.snapshot.mockImplementationOnce(() => held.promise);
      const ordinary = controller.resync();
      await controller.resync({ rewrite: true });
      held.reject(new ApiError({ code: 40401, msg: 'Not found', data: null }));
      await ordinary;
      expect(controller.getState()).toMatchObject({ resyncing: false, resyncFailed: true, resyncError: { retryable: false } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      expect(socket.restartGeneration).not.toHaveBeenCalled();
      expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: 'Retained' });
      await controller.resync();
      expect(client.snapshot).toHaveBeenCalledTimes(3);
      expect(controller.getState()).toMatchObject({ resyncing: false, resyncFailed: false, resyncError: undefined });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.restartGeneration).not.toHaveBeenCalled();
    } finally {
      controller.close();
      vi.useRealTimers();
    }
  });

  it('stops every automatic recovery entry after a terminal restore error', async () => {
    const { ApiError } = await import('../transport');
    const { controller, client, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Retained');
    client.snapshot.mockRejectedValueOnce(new ApiError({ code: 40401, msg: 'Not found', data: null }));
    await controller.resync();
    deliverFrame(controller, frame({ type: 'event.session.history_rewritten' } as SessionEventFrame['payload']));
    controller.handleWsDrop();
    controller.handleReconnectAck();
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', cursor: { epoch: 'new-epoch', seq: 3 }, ops: [] }));
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', seq: 3,
      ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 100, text: 'gap' }],
    }));
    flushAll();
    await Promise.resolve();
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(client.getTranscriptOps).not.toHaveBeenCalled();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: 'Retained' });
    await controller.resync();
    expect(controller.getState().resyncError).toBeUndefined();
    controller.close();
  });

  it('applies grade-filtered seq skips for main and child without REST catchup or resync', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    seedTextAgent(controller, 'child-1', 'c1', 'Child');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 4,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 5,
          text: ' world',
        },
      ],
    }));
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'child-1',
      seq: 7,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
          offset: 5,
          text: ' more',
        },
      ],
    }));
    flushAll();
    expect(client.getTranscriptOps).not.toHaveBeenCalled();
    expect(socket.restartGeneration).not.toHaveBeenCalled();
    expect(controller.getState().resyncing).toBe(false);
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'Hello world',
    });
    expect(controller.getAgentState('child-1').blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'Child more',
    });
    expect(socket.updateTranscriptSince).toHaveBeenCalledWith('session_test', 'main', {
      seq: 4,
      epoch: 'epoch-1',
    });
    expect(socket.updateTranscriptSince).toHaveBeenCalledWith('session_test', 'child-1', {
      seq: 7,
      epoch: 'epoch-1',
    });
    controller.close();
  });

  it('resumes from through_seq when filtered-empty tail batches follow the last visible batch', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    // Last visible batch: one real op lands at seq 2.
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 2,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 5,
          text: ' world',
        },
      ],
    }));
    // The server then covered seq 3-5 with batches whose ops were all
    // filtered out: cursor stays on the last visible op while through_seq
    // moves on.
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      cursor: { seq: 2, epoch: 'epoch-1' },
      through_seq: 5,
      ops: [],
    }));
    flushAll();
    expect(client.getTranscriptOps).not.toHaveBeenCalled();
    expect(socket.updateTranscriptSince).toHaveBeenLastCalledWith('session_test', 'main', {
      seq: 5,
      epoch: 'epoch-1',
    });
    // A reconnect with live work in flight catch-ups per agent; it must
    // resume at the watermark instead of re-pulling the filtered 3-5 range.
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p1',
      user_message_id: 'm1',
      status: 'running',
      content: [{ type: 'text', text: 'A' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    expect(controller.getState().busy).toBe(true);
    controller.handleWsDrop();
    controller.handleReconnectAck();
    await waitFor(() => client.getTranscriptOps.mock.calls.length > 0);
    expect(client.getTranscriptOps).toHaveBeenCalledWith(
      'session_test',
      'main',
      { seq: 5, epoch: 'epoch-1' },
      'delta',
    );
    // No reset degradation: the only snapshot is the initial open.
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect(controller.getState().resyncing).toBe(false);
    controller.close();
  });

  it('catchup is per-agent, uses subscription grades, and still applies when the child has no later frame', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    const mainHeld = deferred<{
      session_id: string;
      agent_id: string;
      epoch: string;
      batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
      through_seq: number;
      complete: boolean;
    }>();
    const childHeld = deferred<{
      session_id: string;
      agent_id: string;
      epoch: string;
      batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
      through_seq: number;
      complete: boolean;
    }>();
    client.getTranscriptOps.mockImplementation((async (_sessionId: string, agentId: string) => {
      if (agentId === 'child-1') return childHeld.promise;
      return mainHeld.promise;
    }) as never);
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    seedTextAgent(controller, 'child-1', 'c1', 'Hello');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 3,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 11,
          text: '!',
        },
      ],
    }));
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'child-1',
      seq: 3,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
          offset: 11,
          text: '!',
        },
      ],
    }));
    flushAll();
    await waitFor(() => client.getTranscriptOps.mock.calls.length === 2);
    expect(client.getTranscriptOps).toHaveBeenCalledWith(
      'session_test',
      'main',
      { seq: 1, epoch: 'epoch-1' },
      'delta',
    );
    expect(client.getTranscriptOps).toHaveBeenCalledWith(
      'session_test',
      'child-1',
      { seq: 1, epoch: 'epoch-1' },
      'turn',
    );
    expect(socket.restartGeneration).not.toHaveBeenCalled();
    mainHeld.resolve({
      session_id: 'session_test',
      agent_id: 'main',
      epoch: 'epoch-1',
      batches: [
        {
          seq: 2,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
              offset: 5,
              text: ' world',
            },
          ],
        },
        {
          seq: 3,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
              offset: 11,
              text: '!',
            },
          ],
        },
      ],
      through_seq: 3,
      complete: true,
    });
    childHeld.resolve({
      session_id: 'session_test',
      agent_id: 'child-1',
      epoch: 'epoch-1',
      batches: [
        {
          seq: 2,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
              offset: 5,
              text: ' world',
            },
          ],
        },
        {
          seq: 3,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
              offset: 11,
              text: '!',
            },
          ],
        },
      ],
      through_seq: 3,
      complete: true,
    });
    await waitFor(() => {
      flushAll();
      const main = controller.getState().blocks.find((block) => block.kind === 'assistant');
      const child = controller.getAgentState('child-1').blocks.find((block) => block.kind === 'assistant');
      return main?.kind === 'assistant' && main.text === 'Hello world!'
        && child?.kind === 'assistant' && child.text === 'Hello world!';
    });
    expect(controller.getState().resyncing).toBe(false);
    expect(socket.restartGeneration).not.toHaveBeenCalled();
    controller.close();
  });

  it('requests the focused child subscription grade on catchup', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    const held = deferred<{
      session_id: string;
      agent_id: string;
      epoch: string;
      batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
      through_seq: number;
      complete: boolean;
    }>();
    client.getTranscriptOps.mockImplementation((async () => held.promise) as never);
    controller.setFocusedAgent('child-1');
    seedTextAgent(controller, 'child-1', 'c1', 'Child');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'child-1',
      seq: 3,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
          offset: 11,
          text: '!',
        },
      ],
    }));
    flushAll();
    await waitFor(() => client.getTranscriptOps.mock.calls.length === 1);
    expect(client.getTranscriptOps).toHaveBeenCalledWith(
      'session_test',
      'child-1',
      { seq: 1, epoch: 'epoch-1' },
      'delta',
    );
    held.resolve({
      session_id: 'session_test',
      agent_id: 'child-1',
      epoch: 'epoch-1',
      batches: [],
      through_seq: 1,
      complete: true,
    });
    controller.close();
  });

  it.each(['same-epoch', 'new-epoch', 'resync', 'rewrite', 'focus', 'view-grade', 'close'])(
    'discards catchup responses after %s invalidates their history',
    async (boundary) => {
      const { controller, client, socket, flushAll } = await openTranscriptController();
      const agentId = boundary === 'focus' || boundary === 'view-grade' ? 'child-1' : 'main';
      const held = deferred<Awaited<ReturnType<SessionViewFacade['transcript']['catchUp']>>>();
      client.getTranscriptOps.mockImplementationOnce((async () => held.promise) as never);
      seedTextAgent(controller, agentId, 'f1', 'OLD');
      const gap = () => {
        controller.handleTranscript(asTranscriptEvent({
          type: 'transcript.ops', agent_id: agentId, seq: 3,
          ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 20, text: '!' }],
        }));
        flushAll();
      };
      gap();
      expect(client.getTranscriptOps).toHaveBeenCalledTimes(1);
      const heldSnapshot = deferred<SessionSnapshotResponse>();
      let resync: Promise<void> | undefined;
      if (boundary === 'resync' || boundary === 'rewrite') {
        client.snapshot.mockImplementationOnce(async () => heldSnapshot.promise);
        resync = controller.resync({ rewrite: boundary === 'rewrite' });
      }
      if (boundary === 'focus') controller.setFocusedAgent(agentId);
      if (boundary === 'view-grade') controller.retainAgentView('timeline', agentId, 'delta');
      const reset = boundary === 'same-epoch' || boundary === 'new-epoch';
      if (reset) controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.reset', agent_id: agentId,
        cursor: { seq: 1, epoch: boundary === 'new-epoch' ? 'epoch-2' : 'epoch-1' },
        snapshot: textTurnSnapshot('f1', 'NEW'),
      }));
      if (boundary === 'close') controller.close();
      const calls = socket.updateTranscriptSince.mock.calls.length;
      held.resolve({
        session_id: 'session_test', agent_id: agentId, epoch: 'epoch-1', through_seq: 99, complete: true,
        batches: [{ seq: 2, ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 3, text: ' RECOVERED' }] }],
      });
      await held.promise;
      await Promise.resolve();
      flushAll();
      const view = agentId === 'main' ? controller.getState() : controller.getAgentState(agentId);
      expect(view.blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: reset ? 'NEW' : 'OLD' });
      expect(socket.updateTranscriptSince).toHaveBeenCalledTimes(calls);
      heldSnapshot.resolve(snapshot());
      await resync;
      controller.close();
    },
  );

  it('allows a new generation catchup while an obsolete request is unresolved', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    const old = deferred<Awaited<ReturnType<SessionViewFacade['transcript']['catchUp']>>>();
    const fresh = deferred<Awaited<ReturnType<SessionViewFacade['transcript']['catchUp']>>>();
    client.getTranscriptOps.mockImplementationOnce((async () => old.promise) as never)
      .mockImplementationOnce((async () => fresh.promise) as never);
    const gap = () => {
      controller.handleTranscript(asTranscriptEvent({
        type: 'transcript.ops', agent_id: 'main', seq: 3,
        ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 4, text: '!' }],
      }));
      flushAll();
    };
    seedTextAgent(controller, 'main', 'f1', 'OLD');
    gap();
    seedTextAgent(controller, 'main', 'f1', 'NEW');
    gap();
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(2);
    old.reject(new Error('obsolete transport failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    fresh.resolve({
      session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', through_seq: 2, complete: true,
      batches: [{ seq: 2, ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 3, text: '+' }] }],
    });
    await fresh.promise;
    await Promise.resolve();
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({ text: 'NEW+!' });
    expect(socket.updateTranscriptSince).toHaveBeenLastCalledWith('session_test', 'main', { seq: 3, epoch: 'epoch-1' });
    controller.close();
  });

  it('coalesces concurrent gaps on the same agent into one catchup', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    const held = deferred<{
      session_id: string;
      agent_id: string;
      epoch: string;
      batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
      through_seq: number;
      complete: boolean;
    }>();
    client.getTranscriptOps.mockImplementation((async () => held.promise) as never);
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 3,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 11,
          text: '!',
        },
      ],
    }));
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 3,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
          offset: 11,
          text: '!',
        },
      ],
    }));
    flushAll();
    await waitFor(() => client.getTranscriptOps.mock.calls.length === 1);
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(1);
    held.resolve({
      session_id: 'session_test',
      agent_id: 'main',
      epoch: 'epoch-1',
      batches: [
        {
          seq: 2,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
              offset: 5,
              text: ' world',
            },
          ],
        },
        {
          seq: 3,
          ops: [
            {
              op: 'append',
              target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' },
              offset: 11,
              text: '!',
            },
          ],
        },
      ],
      through_seq: 3,
      complete: true,
    });
    await waitFor(() => {
      flushAll();
      return controller.getState().blocks.some((block) => block.kind === 'assistant' && block.text === 'Hello world!');
    });
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('keeps pending prompts and unchanged keys across a transcript reset', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    client.submitPrompt = vi.fn(async () => ({
      prompt_id: 'p-pending',
      user_message_id: 'um-pending',
      status: 'queued',
      content: [{ type: 'text', text: 'queued later' }],
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    await controller.sendPrompt({ text: 'queued later', permissionMode: 'manual' });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-live', userMessageId: 'um-live' } },
            prompt: 'live prompt',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-live',
            status: 'completed',
            userMessageId: 'um-live',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      },
    }));
    const ids = controller.getState().blocks.map((block) => block.id);
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 2,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user', payload: { promptId: 'p-live', userMessageId: 'um-live' } },
            prompt: 'live prompt',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [
          {
            promptId: 'p-live',
            status: 'completed',
            userMessageId: 'um-live',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      },
    }));
    flushAll();
    expect(controller.getState().blocks.map((block) => block.id)).toEqual(ids);
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.promptId === 'p-pending')).toBe(true);
    controller.close();
  });

  it('does not mix transcript frames across two session controllers', async () => {
    const { controller, flushAll } = await openTranscriptController();
    const other = new SessionController(
      {
        snapshot: vi.fn(async () => snapshot({ session: { ...session, id: 'session_other' } })),
        listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
        listTasks: vi.fn(async () => ({ items: [] })),
        getSessionGoal: vi.fn(async () => null),
        getAgentTranscript: vi.fn(async () => ({
          agent_id: 'main',
          items: [],
          has_more: false,
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [],
          meta: {},
        })),
      } as unknown as KikiClient,
      fakeView({ snapshot: vi.fn(async () => snapshot({ session: { ...session, id: 'session_other' } })) }, {}, 'session_other'),
      'session_other',
      { scheduler: { schedule: (cb: () => void) => { cb(); return 0; }, cancel: () => {} } },
    );
    await other.open();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: 'session A only',
            steps: [],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    flushAll();
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'session A only')).toBe(true);
    expect(other.getState().blocks).toEqual([]);
    controller.close();
    other.close();
  });

  it('publishes forest only when child ops actually change the tree', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'main',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [
                  {
                    kind: 'tool',
                    frameId: 'spawn',
                    toolCallId: 'tc-agent',
                    name: 'Agent',
                    state: 'running',
                    agentRefs: [{ agentId: 'child-1', role: 'child' }],
                  },
                ],
              },
            ],
          },
        ],
        tasks: [
          {
            taskId: 'task-1',
            kind: 'subagent',
            state: 'running',
            detached: false,
            agentId: 'child-1',
            outputTail: '',
          },
        ],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.reset',
      agent_id: 'child-1',
      has_more_older: false,
      seq: 1,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'running',
            origin: { kind: 'user' },
            steps: [
              {
                kind: 'step',
                stepId: 't1.1',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                frames: [{ kind: 'text', frameId: 'c1', role: 'assistant', text: 'child' }],
              },
            ],
          },
        ],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
      },
    }));
    const forests = controller.forestPublishCount;
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops',
      agent_id: 'child-1',
      seq: 2,
      ops: [
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'c1' },
          offset: 5,
          text: ' more',
        },
      ],
    }));
    flushAll();
    expect(controller.forestPublishCount).toBe(forests);
    controller.close();
  });
  });
});
