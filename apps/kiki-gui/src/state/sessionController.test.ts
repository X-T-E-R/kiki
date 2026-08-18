import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import { resolveSelectedEffort } from '../components/Composer';
import type { KikiClient } from '../lib/client';
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

interface Harness {
  controller: SessionController;
  client: {
    snapshot: ReturnType<typeof vi.fn>;
    listPrompts: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    submitPrompt: ReturnType<typeof vi.fn>;
    abortPrompt: ReturnType<typeof vi.fn>;
    steerPrompt: ReturnType<typeof vi.fn>;
  };
  socket: { subscribe: ReturnType<typeof vi.fn>; updateCursor: ReturnType<typeof vi.fn> };
  flushAll: () => void;
  /** Count of main-store publications after subscription. */
  mainPublishes: () => number;
}

async function openController(): Promise<Harness> {
  const client = {
    snapshot: vi.fn(async () => snapshot()),
    listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
    listTasks: vi.fn(async () => ({ items: [] })),
    getSessionGoal: vi.fn(async () => null),
    listMessages: vi.fn(async () => ({ items: [], has_more: false })),
    submitPrompt: vi.fn(),
    abortPrompt: vi.fn(async () => ({ aborted: true, at_seq: 1 })),
    steerPrompt: vi.fn(async () => ({ steered: true as const, prompt_ids: [] as string[] })),
  };
  const socket = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    updateCursor: vi.fn(),
    abort: vi.fn(),
  };
  const { scheduler, flushAll } = manualScheduler();
  const controller = new SessionController(
    client as unknown as KikiClient,
    socket as unknown as KikiSocket,
    'session_test',
    { scheduler },
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

  it('steers a queued prompt into the running turn, then clears the rest', async () => {
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
    await controller.sendPrompt({ text: 'A', permissionMode: 'manual' });
    await controller.sendPrompt({ text: 'B', permissionMode: 'manual' });
    await controller.sendPrompt({ text: 'C', permissionMode: 'manual' });
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

  it('drops an overflowing hidden-tab buffer and resyncs instead of growing it', async () => {
    const { controller, client, flushAll } = await openController();
    const snapshotCalls = () => client.snapshot.mock.calls.length;
    const before = snapshotCalls(); // open()
    // 1001 durable frames exceed the inbound buffer's 1000-frame bound while
    // the flush scheduler never runs (document hidden).
    for (let i = 0; i < 1001; i += 1) {
      controller.handleFrame(
        frame({ type: 'session.meta.updated', title: `t${i}` } as never, { seq: 11 + i }),
      );
    }
    flushAll();
    // The overflow discarded the buffer and demanded a snapshot resync.
    await waitFor(() => snapshotCalls() > before);
    await waitFor(() => !controller.getState().resyncing && !controller.getState().resyncFailed);
    controller.close();
  });

  it('applies a large intake in bounded chunks, publishing once per tick', async () => {
    const { controller, mainPublishes } = await openController();
    // 250 durable frames land while hidden (all below the overflow bound).
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
