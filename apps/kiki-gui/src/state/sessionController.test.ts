import { describe, expect, it, vi } from 'vitest';

import type { Session, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import type { KikiClient } from '../lib/client';
import type { SessionEventFrame } from '../lib/types';
import type { KikiSocket } from '../lib/ws';
import { SessionController } from './sessionController';
import type { SubagentBlock, ToolBlock, UserBlock } from './transcript';

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
    submitPrompt: ReturnType<typeof vi.fn>;
    abortPrompt: ReturnType<typeof vi.fn>;
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
});
