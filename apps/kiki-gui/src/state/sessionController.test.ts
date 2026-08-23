import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import { resolveSelectedEffort } from '../components/Composer';
import type { AgentTranscriptResponse, KikiClient } from '../lib/client';
import type { SessionEventFrame } from '../lib/types';
import type { KikiSocket } from '../lib/ws';
import { assertSessionWritable, RESYNC_PAUSED_ERROR, SessionController } from './sessionController';
import type { SteerBlock, SubagentBlock, ToolBlock, UserBlock } from './transcript';

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
  };
  const socket = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    updateCursor: vi.fn(),
    abort: vi.fn(),
    timelineMode: 'legacy' as const,
    setTranscriptGrades: vi.fn(),
    restartGeneration: vi.fn(),
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
  it('publishes at most once per flush no matter how many frames arrived', async () => {
    const { controller, flushAll, mainPublishes } = await openController();
    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'hel' } as never, { volatile: true, offset: 0 }),
    );
    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'lo ' } as never, { volatile: true, offset: 3 }),
    );
    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'world' } as never, { volatile: true, offset: 6 }),
    );
    expect(mainPublishes()).toBe(0);
    flushAll();
    expect(mainPublishes()).toBe(1);
    const block = controller.getState().blocks.find((b) => b.kind === 'assistant');
    expect(block).toMatchObject({ text: 'hello world', streaming: true });
    controller.close();
  });

  it('publishes visible thinking deltas at microtask cadence instead of waiting for rAF', async () => {
    const { controller, mainPublishes } = await openController();

    controller.handleFrame(
      frame(
        { type: 'thinking.delta', turnId: 1, delta: 'one' } as never,
        { volatile: true, offset: 0 },
      ),
    );
    expect(mainPublishes()).toBe(0);
    await Promise.resolve();
    expect(mainPublishes()).toBe(1);
    expect(
      controller.getState().blocks.find((block) => block.kind === 'thinking'),
    ).toMatchObject({ text: 'one', streaming: true });

    controller.handleFrame(
      frame(
        { type: 'thinking.delta', turnId: 1, delta: ' two' } as never,
        { volatile: true, offset: 3 },
      ),
    );
    await Promise.resolve();
    expect(mainPublishes()).toBe(2);
    expect(
      controller.getState().blocks.find((block) => block.kind === 'thinking'),
    ).toMatchObject({ text: 'one two', streaming: true });

    controller.close();
  });

  it('replaces an older rAF flush and leaves later frames schedulable', async () => {
    const { controller, flushAll, mainPublishes } = await openController();

    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'before' } as never, {
        volatile: true,
        offset: 0,
      }),
    );
    controller.handleFrame(
      frame({ type: 'thinking.delta', turnId: 1, delta: 'fast' } as never, {
        volatile: true,
        offset: 0,
      }),
    );

    await Promise.resolve();
    expect(mainPublishes()).toBe(1);
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'before',
      streaming: true,
    });

    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: ' after' } as never, {
        volatile: true,
        offset: 6,
      }),
    );
    flushAll();
    expect(mainPublishes()).toBe(2);
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      text: 'before after',
      streaming: true,
    });
    controller.close();
  });

  it('coalesces a synchronous thinking burst into one microtask publication', async () => {
    const { controller, mainPublishes } = await openController();

    controller.handleFrame(
      frame({ type: 'thinking.delta', turnId: 1, delta: 'a' } as never, {
        volatile: true,
        offset: 0,
      }),
    );
    controller.handleFrame(
      frame({ type: 'thinking.delta', turnId: 1, delta: 'b' } as never, {
        volatile: true,
        offset: 1,
      }),
    );
    controller.handleFrame(
      frame({ type: 'thinking.delta', turnId: 1, delta: 'c' } as never, {
        volatile: true,
        offset: 2,
      }),
    );
    expect(mainPublishes()).toBe(0);

    await Promise.resolve();

    expect(mainPublishes()).toBe(1);
    expect(
      controller.getState().blocks.find((block) => block.kind === 'thinking'),
    ).toMatchObject({ text: 'abc', streaming: true });
    controller.close();
  });

  it('keeps hidden-tab thinking deltas on the scheduled buffering path', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    let controller: SessionController | undefined;
    try {
      const harness = await openController();
      controller = harness.controller;
      controller.handleFrame(
        frame(
          { type: 'thinking.delta', turnId: 1, delta: 'hidden' } as never,
          { volatile: true, offset: 0 },
        ),
      );

      await Promise.resolve();
      expect(harness.mainPublishes()).toBe(0);
      harness.flushAll();
      expect(harness.mainPublishes()).toBe(1);
      expect(
        controller.getState().blocks.find((block) => block.kind === 'thinking'),
      ).toMatchObject({ text: 'hidden', streaming: true });
    } finally {
      controller?.close();
      vi.unstubAllGlobals();
    }
  });

  it('publishes hidden default-scheduler intake on bounded timers and returns to rAF', async () => {
    vi.useFakeTimers();
    const visibility = visibilityDocument('hidden');
    const animationFrames = fakeAnimationFrames();
    vi.stubGlobal('document', visibility.target);
    vi.stubGlobal('requestAnimationFrame', animationFrames.request);
    vi.stubGlobal('cancelAnimationFrame', animationFrames.cancel);
    let controller: SessionController | undefined;
    try {
      const harness = await openController({ defaultScheduler: true });
      controller = harness.controller;
      for (let i = 0; i < 250; i += 1) {
        controller.handleFrame(
          frame({ type: 'session.meta.updated', title: `hidden-${i}` } as never, { seq: 11 + i }),
        );
      }

      expect(animationFrames.request).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(harness.mainPublishes()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(controller.getState().session?.title).toBe('hidden-199');
      expect(harness.mainPublishes()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(controller.getState().session?.title).toBe('hidden-249');
      expect(harness.mainPublishes()).toBe(2);
      expect(harness.client.snapshot).toHaveBeenCalledTimes(1);

      controller.handleFrame(
        frame({ type: 'session.meta.updated', title: 'last-hidden' } as never, { seq: 261 }),
      );
      visibility.set('visible');
      expect(animationFrames.pending()).toBe(1);
      vi.advanceTimersByTime(5000);
      expect(controller.getState().session?.title).toBe('hidden-249');
      animationFrames.flushOne();
      expect(controller.getState().session?.title).toBe('last-hidden');

      controller.close();
      const requestsAfterClose = animationFrames.request.mock.calls.length;
      visibility.set('hidden');
      vi.advanceTimersByTime(5000);
      expect(animationFrames.request).toHaveBeenCalledTimes(requestsAfterClose);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller?.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('coalesced frames preserve wire order across durable barriers', async () => {
    const { controller, flushAll } = await openController();
    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'one' } as never, { volatile: true, offset: 0 }),
    );
    controller.handleFrame(
      frame({ type: 'turn.step.started', turnId: 1, step: 2 } as never, { seq: 11 }),
    );
    controller.handleFrame(
      frame({ type: 'assistant.delta', turnId: 1, delta: 'two' } as never, { volatile: true, offset: 0 }),
    );
    flushAll();
    const assistants = controller
      .getState()
      .blocks.filter((b) => b.kind === 'assistant')
      .map((b) => (b as { text: string }).text);
    expect(assistants).toEqual(['one', 'two']);
    controller.close();
  });

  it('routes child-agent deltas to the scoped store without touching main', async () => {
    const { controller, flushAll, mainPublishes } = await openController();
    let agentPublishes = 0;
    controller.subscribeAgent('agent-x', () => {
      agentPublishes += 1;
    });
    for (let i = 0; i < 50; i += 1) {
      controller.handleFrame(
        frame(
          {
            type: 'tool.call.delta',
            turnId: 1,
            toolCallId: 'c1',
            name: 'Write',
            argumentsPart: `chunk-${i} `,
            agentId: 'agent-x',
            sessionId: 'session_test',
          } as never,
          { volatile: true },
        ),
      );
    }
    flushAll();
    expect(mainPublishes()).toBe(0);
    expect(agentPublishes).toBe(1);
    const tool = controller
      .getAgentState('agent-x')
      .blocks.find((b): b is ToolBlock => b.kind === 'tool');
    expect(tool?.toolCallId).toBe('c1');
    expect(tool?.argsText).toContain('chunk-49');
    expect(controller.getAgentState('agent-x').loaded).toBe(true);
    // No subagent card was minted on the main transcript for a bare delta.
    expect(controller.getState().blocks.some((b) => b.kind === 'subagent')).toBe(false);
    controller.close();
  });

  it('increments the main subagent card once per child tool call', async () => {
    const { controller, flushAll } = await openController();
    // Seed a subagent card through the durable lifecycle event.
    controller.handleFrame(
      frame({
        type: 'subagent.spawned',
        subagentId: 'agent-x',
        subagentName: 'Explorer',
        parentToolCallId: 'parent-call',
        description: 'Explore',
        runInBackground: false,
      } as never, { seq: 11 }),
    );
    flushAll();
    const started = (toolCallId: string, seq: number) =>
      frame({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId,
        name: 'Read',
        args: {},
        agentId: 'agent-x',
        sessionId: 'session_test',
      } as never, { seq });
    controller.handleFrame(started('c1', 12));
    controller.handleFrame(started('c1', 13)); // duplicate must not double-count
    controller.handleFrame(started('c2', 14));
    flushAll();
    const card = controller
      .getState()
      .blocks.find((b): b is SubagentBlock => b.kind === 'subagent' && b.subagentId === 'agent-x');
    expect(card?.toolCallCount).toBe(2);
    controller.close();
  });

  it('keeps an immediately sent prompt at the tail of a freshly opened session', async () => {
    const { controller, client } = await openController();
    client.snapshot.mockResolvedValue(
      snapshot({
        messages: {
          items: [
            {
              id: 'm-old-user',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'earlier question' }],
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'm-old-assistant',
              session_id: 'session_test',
              role: 'assistant',
              content: [{ type: 'text', text: 'earlier answer' }],
              created_at: '2026-01-01T00:00:01.000Z',
            },
          ],
          has_more: false,
        },
      }),
    );
    await controller.retryOpen();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-new',
      user_message_id: 'm-new',
      status: 'running',
      content: [{ type: 'text', text: 'new question' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });

    await controller.sendPrompt({ text: 'new question', permissionMode: 'manual' });

    expect(controller.getState().blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(controller.getState().blocks.at(-1)).toMatchObject({
      kind: 'user',
      promptId: 'p-new',
      text: 'new question',
    });
    controller.close();
  });

  it('does not duplicate a locally echoed user message after snapshot resync', async () => {
    const { controller, client } = await openController();
    const prompt = {
      prompt_id: 'p-resync',
      user_message_id: 'm-live',
      status: 'running' as const,
      content: [{ type: 'text' as const, text: 'keep one bubble' }],
      created_at: '2026-01-01T00:00:02.000Z',
    };
    client.submitPrompt.mockResolvedValue(prompt);
    await controller.sendPrompt({ text: 'keep one bubble', permissionMode: 'manual' });

    client.snapshot.mockResolvedValue(
      snapshot({
        messages: {
          items: [
            {
              id: 'm-rest-1',
              session_id: 'session_test',
              role: 'user',
              content: prompt.content,
              created_at: prompt.created_at,
              prompt_id: prompt.prompt_id,
            },
            {
              id: 'm-rest-2',
              session_id: 'session_test',
              role: 'user',
              content: prompt.content,
              created_at: prompt.created_at,
              prompt_id: prompt.prompt_id,
            },
          ],
          has_more: false,
        },
        in_flight_turn: {
          turn_id: 1,
          current_prompt_id: prompt.prompt_id,
          assistant_text: '',
          thinking_text: '',
          running_tools: [],
        },
      }),
    );
    client.listPrompts.mockResolvedValue({ active: prompt, queued: [] });

    await controller.resync();

    const users = controller
      .getState()
      .blocks.filter((block): block is UserBlock => block.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'user-m-live',
      userMessageId: 'm-live',
      promptId: 'p-resync',
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

  it('forwards a profile rebind with the prompt and omits it otherwise', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-profile',
      user_message_id: 'm-profile',
      status: 'running',
      content: [{ type: 'text', text: 'switch gears' }],
      created_at: '2026-01-02T00:00:00.000Z',
    });

    await controller.sendPrompt({
      text: 'switch gears',
      profile: 'reviewer',
      permissionMode: 'manual',
    });
    expect(client.submitPrompt).toHaveBeenCalledWith(
      'session_test',
      expect.objectContaining({ profile: 'reviewer' }),
    );

    await controller.sendPrompt({ text: 'plain follow-up', permissionMode: 'manual' });
    expect(client.submitPrompt).toHaveBeenLastCalledWith(
      'session_test',
      expect.objectContaining({ profile: undefined }),
    );
    controller.close();
  });

  it('queues a prompt behind a busy turn and promotes it from the server list', async () => {
    const { controller, client } = await openController();
    client.submitPrompt
      .mockResolvedValueOnce({
        prompt_id: 'p1',
        user_message_id: 'm1',
        status: 'running',
        content: [{ type: 'text', text: 'A' }],
        created_at: '2026-01-01T00:00:02.000Z',
      })
      .mockResolvedValueOnce({
        prompt_id: 'p2',
        user_message_id: 'm2',
        status: 'queued',
        content: [{ type: 'text', text: 'B' }],
        created_at: '2026-01-01T00:00:03.000Z',
      });
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    await controller.sendPrompt({ text: 'B', permissionMode: 'manual' });
    let state = controller.getState();
    expect(state.activePromptId).toBe('p1');
    expect(state.queuedPromptIds).toEqual(['p2']);
    const queuedBlock = state.blocks.find(
      (b): b is UserBlock => b.kind === 'user' && b.promptId === 'p2',
    );
    expect(queuedBlock?.promptStatus).toBe('queued');

    // Scheduler truth catches up: B is now the active prompt.
    client.listPrompts.mockResolvedValue({
      active: {
        prompt_id: 'p2',
        user_message_id: 'm2',
        status: 'running',
        content: [{ type: 'text', text: 'B' }],
        created_at: '2026-01-01T00:00:03.000Z',
      },
      queued: [],
    });
    await controller.refreshPrompts();
    state = controller.getState();
    expect(state.activePromptId).toBe('p2');
    expect(state.queuedPromptIds).toEqual([]);
    const promoted = state.blocks.find(
      (b): b is UserBlock => b.kind === 'user' && b.promptId === 'p2',
    );
    expect(promoted?.promptStatus).toBe('running');
    expect(state.blocks.filter((b) => b.kind === 'user')).toHaveLength(2);

    // Cancelling a parked prompt goes straight at its id.
    await controller.abortPrompt('p9');
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', 'p9');
    controller.close();
  });

  it('atomically replaces a queued prompt without aborting or resubmitting', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p2',
      user_message_id: 'm2',
      status: 'queued',
      content: [{ type: 'text', text: 'old text' }],
      created_at: '2026-01-01T00:00:03.000Z',
    });
    await controller.sendPrompt({ text: 'old text', permissionMode: 'manual' });
    client.replacePrompt.mockResolvedValue({
      prompt_id: 'p2',
      user_message_id: 'm2',
      status: 'queued',
      content: [{ type: 'text', text: 'new text' }],
      created_at: '2026-01-01T00:00:03.000Z',
    });

    await controller.replaceQueued('p2', 'new text');

    expect(client.replacePrompt).toHaveBeenCalledExactlyOnceWith('session_test', 'p2', {
      content: [{ type: 'text', text: 'new text' }],
    });
    expect(client.submitPrompt).toHaveBeenCalledOnce();
    expect(client.abortPrompt).not.toHaveBeenCalled();
    const users = controller.getState().blocks.filter(
      (block): block is UserBlock => block.kind === 'user',
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      promptId: 'p2',
      userMessageId: 'm2',
      promptStatus: 'queued',
      text: 'new text',
    });
    controller.close();
  });

  it('keeps the original queued block when replacement fails', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p2',
      user_message_id: 'm2',
      status: 'queued',
      content: [{ type: 'text', text: 'old text' }],
      created_at: '2026-01-01T00:00:03.000Z',
    });
    await controller.sendPrompt({ text: 'old text', permissionMode: 'manual' });
    client.replacePrompt.mockRejectedValue(new Error('replace failed'));

    await expect(controller.replaceQueued('p2', 'new text')).rejects.toThrow('replace failed');

    expect(client.abortPrompt).not.toHaveBeenCalled();
    expect(controller.getState().blocks.filter((block) => block.kind === 'user')).toEqual([
      expect.objectContaining({ promptId: 'p2', promptStatus: 'queued', text: 'old text' }),
    ]);
    controller.close();
  });

  it('submits bound prompts, queues them, and steers one into the running turn', async () => {
    const { controller, client, flushAll } = await openController();
    const item = (
      promptId: string,
      text: string,
      status: 'running' | 'queued',
      second: number,
    ) => ({
      prompt_id: promptId,
      user_message_id: `m-${promptId}`,
      status,
      content: [{ type: 'text' as const, text }],
      created_at: `2026-01-01T00:00:0${second}.000Z`,
    });
    client.submitPrompt
      .mockResolvedValueOnce(item('p1', 'A', 'running', 2))
      .mockResolvedValueOnce(item('p2', 'B', 'queued', 3))
      .mockResolvedValueOnce(item('p3', 'C', 'queued', 4));
    const execution = { model: 'stub', thinking: 'high', permissionMode: 'manual' as const };
    await controller.sendPrompt({ text: 'A', ...execution });
    await controller.sendPrompt({ text: 'B', ...execution });
    await controller.sendPrompt({ text: 'C', ...execution });
    expect(client.submitPrompt).toHaveBeenNthCalledWith(
      2,
      'session_test',
      expect.objectContaining({ model: 'stub', thinking: 'high', profile: undefined }),
    );
    controller.handleFrame(
      frame(
        { type: 'assistant.delta', turnId: 1, delta: 'working' } as never,
        { volatile: true, offset: 0 },
      ),
    );
    flushAll();
    expect(controller.getState().queuedPromptIds).toEqual(['p2', 'p3']);
    expect(controller.getState().blocks.map((block) => block.kind)).toEqual([
      'user',
      'user',
      'user',
      'assistant',
    ]);

    // Send now = wire steer: straight at the prompt id, then the follow-up
    // reconcile repaints the queue without the steered prompt.
    client.steerPrompt.mockResolvedValue({ steered: true, prompt_ids: ['p2'] });
    client.listPrompts.mockResolvedValue({
      active: item('p1', 'A', 'running', 2),
      queued: [item('p3', 'C', 'queued', 4)],
    });
    await controller.steerQueued('p2');
    expect(client.steerPrompt).toHaveBeenCalledWith('session_test', 'p2');
    expect(controller.getState().queuedPromptIds).toEqual(['p3']);
    expect(
      controller.getState().blocks.find((b): b is UserBlock => b.kind === 'user' && b.promptId === 'p2')
        ?.promptStatus,
    ).toBeUndefined();
    controller.handleFrame(
      frame(
        {
          type: 'prompt.steered',
          activePromptId: 'p1',
          promptIds: ['p2'],
          content: [{ type: 'text', text: 'B' }],
          steeredAt: '2026-01-01T00:00:05.000Z',
        } as never,
        { seq: 11 },
      ),
    );
    flushAll();
    expect(
      controller.getState().blocks.find((b): b is UserBlock => b.kind === 'user' && b.promptId === 'p2'),
    ).toBeUndefined();
    expect(
      controller.getState().blocks.find((b): b is SteerBlock => b.kind === 'steer' && b.promptId === 'p2'),
    ).toMatchObject({ text: 'B', activePromptId: 'p1' });
    expect(
      controller.getState().blocks.map((block) =>
        block.kind === 'user' || block.kind === 'steer'
          ? `${block.kind}:${block.promptId}`
          : block.kind,
      ),
    ).toEqual(['user:p1', 'steer:p2', 'user:p3', 'assistant']);

    // Clear all: one abort per parked prompt, then the queue drains empty.
    client.listPrompts.mockResolvedValue({ active: item('p1', 'A', 'running', 2), queued: [] });
    await controller.clearQueue();
    expect(client.abortPrompt).toHaveBeenCalledTimes(1);
    expect(client.abortPrompt).toHaveBeenCalledWith('session_test', 'p3');
    expect(controller.getState().queuedPromptIds).toEqual([]);
    controller.close();
  });

  it('reports partial clearQueue failures and keeps the failed prompt queued', async () => {
    const { controller, client } = await openController();
    const item = (
      promptId: string,
      text: string,
      status: 'running' | 'queued',
      second: number,
    ) => ({
      prompt_id: promptId,
      user_message_id: `m-${promptId}`,
      status,
      content: [{ type: 'text' as const, text }],
      created_at: `2026-01-01T00:00:0${second}.000Z`,
    });
    client.submitPrompt
      .mockResolvedValueOnce(item('p1', 'A', 'running', 2))
      .mockResolvedValueOnce(item('p2', 'B', 'queued', 3))
      .mockResolvedValueOnce(item('p3', 'C', 'queued', 4));
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    await controller.sendPrompt({ text: 'B', permissionMode: 'manual' });
    await controller.sendPrompt({ text: 'C', permissionMode: 'manual' });

    client.abortPrompt.mockImplementation(async (_sid: string, promptId: string) => {
      if (promptId === 'p3') throw new Error('abort failed');
      return { aborted: true, at_seq: 1 };
    });
    client.listPrompts.mockResolvedValue({
      active: item('p1', 'A', 'running', 2),
      queued: [item('p3', 'C', 'queued', 4)],
    });
    await expect(controller.clearQueue()).resolves.toEqual({ total: 2, failed: 1 });
    expect(controller.getState().queuedPromptIds).toEqual(['p3']);
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
    expect(controller.getState().blocks.some((block) => block.kind === 'user')).toBe(false);
    held.reject(new Error('snapshot down'));
    await waitFor(() => controller.getState().resyncFailed);
    await expect(controller.sendPrompt({ text: 'still nope', permissionMode: 'manual' })).rejects.toThrow(
      /resync/i,
    );
    expect(client.submitPrompt).not.toHaveBeenCalled();
    await expect(controller.steerQueued('p9')).rejects.toThrow(/resync/i);
    expect(client.steerPrompt).not.toHaveBeenCalled();
    controller.close();
  });

  it('refuses steerQueued during an in-flight resync without REST', async () => {
    const { controller, client } = await openController();
    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValue(held.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    await expect(controller.steerQueued('p2')).rejects.toThrow(/resync/i);
    expect(client.steerPrompt).not.toHaveBeenCalled();
    held.resolve(snapshot());
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });

  it('merges a list-poll record without flattening live busy or pending fields', async () => {
    const { controller, client, flushAll } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p1',
      user_message_id: 'm1',
      status: 'running',
      content: [{ type: 'text', text: 'A' }],
      created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    controller.handleFrame(
      frame({
        type: 'event.approval.requested',
        agentId: 'main',
        sessionId: 'session_test',
        approval_id: 'a1',
        session_id: 'session_test',
        tool_call_id: 'tc1',
        tool_name: 'Bash',
        action: 'Run echo',
        tool_input_display: { kind: 'command', command: 'echo hi' },
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T00:05:00.000Z',
      } as never, { seq: 11 }),
    );
    flushAll();
    expect(controller.getState().busy).toBe(true);
    expect(controller.getState().pendingInteraction).toBe('approval');
    expect(controller.getState().activePromptId).toBe('p1');

    controller.handleSessionRecord({
      ...session,
      title: 'Polled title',
      updated_at: '2026-01-01T00:05:00.000Z',
      busy: false,
      pending_interaction: 'none',
    });
    const state = controller.getState();
    expect(state.session?.title).toBe('Polled title');
    expect(state.busy).toBe(true);
    expect(state.pendingInteraction).toBe('approval');
    expect(state.activePromptId).toBe('p1');
    controller.close();
  });

  it('records an older-history error without treating it as the beginning', async () => {
    const { controller, client } = await openController();
    client.snapshot.mockResolvedValue(
      snapshot({
        messages: {
          items: [
            {
              id: 'm3',
              session_id: 'session_test',
              role: 'user',
              content: [{ type: 'text', text: 'three' }],
              created_at: '2026-01-01T00:00:02.000Z',
            },
          ],
          has_more: true,
        },
      }),
    );
    await controller.retryOpen();
    expect(controller.getState().hasMoreHistory).toBe(true);
    client.listMessages.mockRejectedValueOnce(new Error('history down'));
    await expect(controller.loadOlderMessages()).resolves.toBe(false);
    const failed = controller.getState();
    expect(failed.olderError).toBe('history down');
    expect(failed.hasMoreHistory).toBe(true);
    expect(failed.fetchedOlder).toBe(false);
    expect(failed.loadingOlder).toBe(false);

    client.listMessages.mockResolvedValueOnce({
      items: [
        {
          id: 'm2',
          session_id: 'session_test',
          role: 'user',
          content: [{ type: 'text', text: 'two' }],
          created_at: '2026-01-01T00:00:01.500Z',
        },
      ],
      has_more: false,
    });
    await expect(controller.loadOlderMessages()).resolves.toBe(true);
    expect(controller.getState().olderError).toBeUndefined();
    expect(controller.getState().fetchedOlder).toBe(true);
    controller.close();
  });

  it('steer failures propagate so the view can surface them', async () => {
    const { controller, client } = await openController();
    client.steerPrompt.mockRejectedValue(new Error('prompt.not_found (code 40402)'));
    await expect(controller.steerQueued('p9')).rejects.toThrow('40402');
    controller.close();
  });

  it('quarantines frames during a held resync and replays them after', async () => {
    const { controller, client, flushAll, mainPublishes } = await openController();
    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValue(held.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    const publishesBeforeFrames = mainPublishes();
    controller.handleFrame(
      frame({ type: 'session.meta.updated', title: 'Renamed' } as never, { seq: 11 }),
    );
    flushAll();
    // The quarantined frame must not publish while the resync is in flight.
    expect(mainPublishes()).toBe(publishesBeforeFrames);
    held.resolve(snapshot({ as_of_seq: 10 }));
    await waitFor(() => controller.getState().session?.title === 'Renamed');
    expect(controller.getState().resyncing).toBe(false);
    controller.close();
  });

  it('discards an overflowing quarantine and refetches instead of wedging', async () => {
    const { controller, client } = await openController();
    const held = deferred<SessionSnapshotResponse>();
    client.snapshot.mockReturnValueOnce(held.promise);
    void controller.resync();
    await waitFor(() => controller.getState().resyncing);
    // 1001 durable frames exceed the quarantine's 1000-frame bound.
    for (let i = 0; i < 1001; i += 1) {
      controller.handleFrame(
        frame({ type: 'session.meta.updated', title: `t${i}` } as never, { seq: 11 + i }),
      );
    }
    client.snapshot.mockResolvedValue(snapshot({ as_of_seq: 2000 }));
    held.resolve(snapshot({ as_of_seq: 2000 }));
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    // open + held resync + the post-overflow refetch: at least three fetches.
    expect(client.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    controller.close();
  });

  it('routes a child-origin approval into BOTH the main list and the child store', async () => {
    const { controller, flushAll, mainPublishes } = await openController();
    let agentPublishes = 0;
    controller.subscribeAgent('agent-x', () => {
      agentPublishes += 1;
    });
    controller.handleFrame(
      frame({
        type: 'event.approval.requested',
        agentId: 'agent-x',
        sessionId: 'session_test',
        approval_id: 'a-child',
        session_id: 'session_test',
        turn_id: 1,
        tool_call_id: 'tc-child',
        tool_name: 'Bash',
        action: 'Run: rm -rf build',
        tool_input_display: { kind: 'command', command: 'rm -rf build' },
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z',
      } as never, { seq: 11 }),
    );
    flushAll();
    // Main transcript: an actionable, origin-tagged card.
    const mainBlock = controller
      .getState()
      .blocks.find((b) => b.kind === 'approval') as
      | { originAgentId?: string; request: { approval_id: string } }
      | undefined;
    expect(mainBlock?.request.approval_id).toBe('a-child');
    expect(mainBlock?.originAgentId).toBe('agent-x');
    expect(controller.getState().pendingInteraction).toBe('approval');
    expect(mainPublishes()).toBeGreaterThan(0);
    // Child sub-store: the agent page's live copy.
    const childBlock = controller
      .getAgentState('agent-x')
      .blocks.find((b) => b.kind === 'approval');
    expect(childBlock).toBeDefined();
    expect(agentPublishes).toBeGreaterThan(0);
    controller.close();
  });

  it('resyncs after a reconnect ack only when the drop hit live work', async () => {
    const { controller, client, flushAll } = await openController();
    const snapshotCalls = () => client.snapshot.mock.calls.length;

    // Idle drop: no resync after the ack.
    controller.handleWsDrop();
    controller.handleReconnectAck();
    expect(snapshotCalls()).toBe(1); // only open()

    // Busy drop: the ack triggers a snapshot resync.
    controller.handleFrame(
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'work' } as never, { seq: 11 }),
    );
    flushAll();
    expect(controller.getState().busy).toBe(true);
    controller.handleWsDrop();
    controller.handleReconnectAck();
    await waitFor(() => snapshotCalls() >= 2);
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
    expect(controller.getState().resyncing).toBe(false);
    // The 250ms first backoff step fires the retry, which succeeds.
    await waitFor(() => !controller.getState().resyncFailed && !controller.getState().resyncing);
    expect(client.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    controller.close();
  });

  it('drops an intake burst beyond 1000 frames and resyncs instead of growing it', async () => {
    const { controller, client, flushAll } = await openController();
    const snapshotCalls = () => client.snapshot.mock.calls.length;
    const before = snapshotCalls(); // open()
    // The manual scheduler holds the burst so it exceeds the frame-count bound.
    for (let i = 0; i < 1001; i += 1) {
      controller.handleFrame(
        frame({ type: 'session.meta.updated', title: `t${i}` } as never, { seq: 11 + i }),
      );
    }
    flushAll();
    // The overflow discarded the buffer and demanded a snapshot resync.
    await waitFor(() => snapshotCalls() > before);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    expect(snapshotCalls()).toBeGreaterThan(before);
    expect(controller.getState().resyncFailed).toBe(false);
    controller.close();
  });

  it('drops an intake burst beyond 2 MiB and resyncs', async () => {
    const { controller, client } = await openController();
    const snapshotCalls = () => client.snapshot.mock.calls.length;
    const before = snapshotCalls();
    const largeTitle = 'x'.repeat(600_000);
    controller.handleFrame(
      frame({ type: 'session.meta.updated', title: largeTitle } as never, { seq: 11 }),
    );
    controller.handleFrame(
      frame({ type: 'session.meta.updated', title: largeTitle } as never, { seq: 12 }),
    );
    await waitFor(() => snapshotCalls() > before);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    expect(snapshotCalls()).toBeGreaterThan(before);
    expect(controller.getState().resyncFailed).toBe(false);
    controller.close();
  });

  it('applies a large intake in bounded chunks, publishing once per tick', async () => {
    const { controller, mainPublishes } = await openController();
    // 250 durable frames land before the manual scheduler runs.
    for (let i = 0; i < 250; i += 1) {
      controller.handleFrame(
        frame({ type: 'session.meta.updated', title: `t${i}` } as never, { seq: 11 + i }),
      );
    }
    // One flush applies at most FLUSH_CHUNK_FRAMES (200) frames; the rest are
    // re-queued for the next tick (flushFrames is the public scheduler seam).
    const publishesBeforeChunk = mainPublishes();
    controller.flushFrames();
    expect(controller.getState().session?.title).toBe('t199');
    expect(mainPublishes()).toBe(publishesBeforeChunk + 1);
    controller.flushFrames();
    expect(controller.getState().session?.title).toBe('t249');
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
    expect(socket.subscribe).toHaveBeenLastCalledWith('session_test', { seq: 12, epoch: 'epoch-1' });
    expect(
      controller.getState().blocks.some((b) => b.kind === 'user' && b.text.includes('kept')),
    ).toBe(true);
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

  it('follows up with one resync when a turn lived and settled inside the resync window', async () => {
    const { controller, client } = await openController();
    const calls = () => client.snapshot.mock.calls.length;
    const before = calls(); // open()
    void controller.resync(); // the quarantine window opens synchronously
    // The whole rewritten turn arrives while the snapshot fetch is in flight:
    // durable bookends replay afterwards, the volatile delta is dropped by
    // design — its content exists only in the journal.
    controller.handleFrame(
      frame({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'rerun' } as never, { seq: 11 }),
    );
    controller.handleFrame(
      frame(
        { type: 'assistant.delta', turnId: 1, delta: 'content the snapshot missed', agentId: 'main' } as never,
        { seq: 11, volatile: true, offset: 0 },
      ),
    );
    controller.handleFrame(
      frame({ type: 'turn.ended', turnId: 1, reason: 'completed', agentId: 'main' } as never, { seq: 12 }),
    );
    // Idle after the replay (turn.ended landed) → exactly one follow-up
    // snapshot picks up the committed content.
    await waitFor(() => calls() >= before + 2);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    // Converges — no resync loop.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls()).toBe(before + 2);
    expect(controller.getState().busy).toBe(false);
    controller.close();
  });

  it('marks captured subagent cards orphaned when the rewrite drops their branch', async () => {
    const { controller, client, flushAll } = await openController();
    controller.handleFrame(
      frame(
        {
          type: 'subagent.spawned',
          subagentId: 'agent-x',
          subagentName: 'Explorer',
          parentToolCallId: 'parent-call',
          description: 'Explore',
          runInBackground: false,
        } as never,
        { seq: 11 },
      ),
    );
    flushAll();
    expect(
      controller.getState().blocks.some((b) => b.kind === 'subagent' && b.subagentId === 'agent-x'),
    ).toBe(true);
    // The post-rewrite snapshot no longer contains the card's branch.
    controller.handleFrame(
      frame(
        {
          type: 'event.session.history_rewritten',
          reason: 'regenerate',
          target_message_id: 'm1',
        } as never,
        { seq: 12 },
      ),
    );
    await waitFor(() => !controller.getState().resyncing && client.snapshot.mock.calls.length >= 2);
    const card = controller
      .getState()
      .blocks.find((b): b is SubagentBlock => b.kind === 'subagent' && b.subagentId === 'agent-x');
    expect(card?.orphaned).toBe(true);
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
      plan_mode: undefined,
      swarm_mode: undefined,
    });
    await waitFor(() => calls() > before);
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
  async function openTranscriptController() {
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
    };
    const socket = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      updateCursor: vi.fn(),
      abort: vi.fn(),
      timelineMode: 'transcript' as const,
      setTranscriptGrades: vi.fn(),
      restartGeneration: vi.fn(),
    };
    const { scheduler, flushAll } = manualScheduler();
    const controller = new SessionController(
      client as unknown as KikiClient,
      socket as unknown as KikiSocket,
      'session_test',
      { scheduler },
    );
    await controller.open();
    return { controller, client, socket, flushAll };
  }

  it('does not adopt snapshot messages or in-flight text on open', async () => {
    const { controller, client, socket } = await openTranscriptController();
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
    controller.handleTranscript({
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
    });
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
    const forest = controller.getForest();
    expect(forest?.byId['child-1']?.status).toBe('running');
    expect(
      controller.getState().blocks.find((block) => block.kind === 'tool' && block.toolCallId === 'tc-agent'),
    ).toMatchObject({ agentRefs: [{ agentId: 'child-1', role: 'child' }] });

    controller.handleTranscript({
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
    });
    flushAll();
    expect(controller.getForest()?.byId['child-1']?.status).toBe('completed');
    controller.close();
  });

  it('does not paint queued replace/steer as aborted or stopped', async () => {
    const { controller } = await openTranscriptController();
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
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

    controller.handleTranscript({
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
    });
    expect(controller.getState().blocks.some((block) => block.id.includes('t1'))).toBe(false);
    expect(controller.getState().blocks.some((block) => block.id.includes('t9'))).toBe(true);
    controller.close();
  });

  it('coalesces high-frequency appends into one publication and skips forest rebuilds', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript({
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
    });
    const forests = controller.forestPublishCount;
    let publishes = 0;
    controller.subscribe(() => {
      publishes += 1;
    });
    for (let i = 0; i < 8; i += 1) {
      controller.handleTranscript({
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
      });
    }
    expect(publishes).toBe(0);
    flushAll();
    expect(publishes).toBe(1);
    expect(controller.forestPublishCount).toBe(forests);
    controller.close();
  });

  it('clears plan/swarm/queue/active/pending from the current AgentState', async () => {
    const { controller } = await openTranscriptController();
    controller.handleTranscript({
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
    });
    expect(controller.getState()).toMatchObject({
      planMode: true,
      swarmMode: true,
      queuedPromptIds: ['p-q'],
      activePromptId: 'p-run',
      pendingInteraction: 'approval',
      permissionMode: 'yolo',
    });
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
    let release!: (value: AgentTranscriptResponse) => void;
    client.getAgentTranscript.mockReturnValueOnce(
      new Promise<AgentTranscriptResponse>((resolve) => {
        release = resolve;
      }),
    );
    const pending = controller.loadOlderMessages('main');
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
    expect(controller.getState().blocks.find((block) => block.kind === 'tool')).toMatchObject({
      status: 'running',
    });
    expect(controller.getState().pendingInteraction).toBe('approval');

    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
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
    controller.handleTranscript({
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
    });
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
    });
    controller.handleTranscript({
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
    });
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: true,
      text: 'Hello',
    });
    controller.handleTranscript({
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
    });
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'assistant')).toMatchObject({
      streaming: false,
      text: 'Hello',
    });
    controller.close();
  });
});
