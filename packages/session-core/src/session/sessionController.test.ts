import { describe, expect, it, vi } from 'vitest';

import type { MessageContent, Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import type {
  AgentTranscriptResponse,
  SessionSocket as KikiSocket,
  SessionTransport as KikiClient,
} from '../transport';
import { resolveSelectedEffort } from '../settings/agentSettings';
import type { SessionEventFrame } from '../wire';
import type { TranscriptEvent } from '@moonshot-ai/transcript';

import { assertSessionWritable, RESYNC_PAUSED_ERROR, SessionController } from './sessionController';
import type { SubagentBlock, ToolBlock, UserBlock } from './transcript';

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
    socket as unknown as KikiSocket,
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


describe('SessionController pipeline', () => {
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
      socket as unknown as KikiSocket,
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
    controller.handleFrame(
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
    controller.handleResyncRequired({
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
    controller.handleFrame({
      type: 'assistant.delta',
      seq: 10,
      epoch: 'epoch-1',
      volatile: true,
      session_id: 'session_test',
      timestamp: '2026-01-01T00:00:03.000Z',
      payload: { type: 'assistant.delta', turnId: 1, delta: 'x' },
    } as SessionEventFrame);
    expect(controller.getState().cursor).toEqual({ seq: 10, epoch: 'epoch-1' });
    controller.handleFrame({
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
      socket as unknown as KikiSocket,
      'session_test',
      { scheduler, rewriteResetTimeoutMs: options.rewriteResetTimeoutMs },
    );
    await controller.open();
    return { controller, client, socket, flushAll };
  }

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

    controller.handleFrame(
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
    Object.assign(socket, { connectionGeneration: 7 });
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
    Object.assign(socket, { connectionGeneration: 4 });
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
    Object.assign(socket, { connectionGeneration: 9 });
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
      {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        updateCursor: vi.fn(),
        abort: vi.fn(),
        setTranscriptGrades: vi.fn(),
        restartGeneration: vi.fn(),
        updateTranscriptSince: vi.fn(),
        clearTranscriptSince: vi.fn(),
      } as unknown as KikiSocket,
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
