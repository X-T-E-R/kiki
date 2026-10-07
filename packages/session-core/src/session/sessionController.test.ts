import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { MessageContent, Session, SessionSnapshotResponse } from '@kiki/protocol';
import { sessionViewSignalSchema } from '@kiki/klient/contract/session/view';

import type {
  AgentTranscriptResponse,
  SessionTransport as KikiClient,
} from '../transport';
import { ApiError, API_CODES } from '../transport';
import { readDraft, readComposerState, resetDraftMemoryForTests, resetComposerMemoryForTests, writeDraft, subscribeDraftAppends, restorePromptToDraft } from '../composer/drafts';
import { buildPromptContent } from '../composer/attachments';
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
    getAgentTranscript: ReturnType<typeof vi.fn>;
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
  it.each([true, false, undefined])('preserves GUI plan selections: %s', async (enabled) => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'runtime-projection', user_message_id: 'runtime-message', status: 'queued',
      content: [{ type: 'text', text: 'follow-up' }], created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'follow-up', permissionMode: 'manual',
      planMode: enabled, goalObjective: 'same objective' });
    expect(client.submitPrompt).toHaveBeenCalledWith('session_test', expect.objectContaining({
      plan_mode: enabled, goal_objective: 'same objective',
    }));
    controller.close();
  });
});

describe('SessionController pipeline', () => {
  it('keeps the shell snapshot separate from transcript readiness before sending', async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot()),
      submitPrompt: vi.fn(async () => ({
        prompt_id: 'p-ready', user_message_id: 'm-ready', status: 'running' as const,
        content: [{ type: 'text' as const, text: 'ready' }], created_at: '2026-01-01T00:00:02.000Z',
      })),
    };
    const controller = new SessionController(
      client as unknown as KikiClient,
      fakeView(client, {}),
      'session_test',
    );

    await controller.open();
    expect(controller.getState()).toMatchObject({ loaded: true, transcriptReady: false });

    controller.handleTranscript(resetEvent('main', emptySnapshot(), 11));
    controller.flushFrames();
    expect(controller.getState().transcriptReady).toBe(true);

    await controller.sendPrompt({ text: 'ready' });
    expect(client.submitPrompt).toHaveBeenCalledExactlyOnceWith('session_test', expect.objectContaining({
      content: [{ type: 'text', text: 'ready' }],
    }));

    await controller.resync();
    expect(controller.getState().transcriptReady).toBe(false);
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 12));
    controller.flushFrames();
    expect(controller.getState().transcriptReady).toBe(true);
    controller.close();
  });

  it('records serialized HTTP operation phases before and after the lease gate', async () => {
    type Stage = { readonly name: string; readonly at: number };
    type Result = { readonly stages: readonly Stage[]; readonly requests: Readonly<Record<string, number>> };
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const run = async (preflightBeforeOpen: boolean): Promise<Result> => {
      const stages: Stage[] = [];
      const requests: Record<string, number> = {};
      let operationTail = Promise.resolve();
      const mark = (name: string) => { stages.push({ name, at: performance.now() }); };
      const count = (path: string) => { requests[path] = (requests[path] ?? 0) + 1; };
      const respond = (response: import('node:http').ServerResponse, body: unknown) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };
      const operate = async (name: string, work: () => Promise<void>): Promise<void> => {
        const previous = operationTail;
        let release!: () => void;
        operationTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        mark(`${name}:start`);
        try { await work(); }
        finally { mark(`${name}:end`); release(); }
      };
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        count(path);
        request.resume();
        if (path === '/snapshot') {
          void operate('snapshot', async () => { await delay(2); respond(response, snapshot()); });
          return;
        }
        if (path === '/auto-compact') {
          void operate('preflight', async () => { await delay(40); respond(response, { tokens: 80 }); });
          return;
        }
        if (path === '/prompt') {
          void operate('prompt', async () => {
            await delay(2);
            respond(response, {
              prompt_id: 'http-prompt', user_message_id: 'http-message', status: 'running',
              content: [{ type: 'text', text: 'http send' }], created_at: '2026-01-01T00:00:02.000Z',
            });
          });
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP harness did not bind a port');
      const endpoint = `http://127.0.0.1:${address.port}`;
      const requestJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
        const response = await fetch(`${endpoint}${path}`, init);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
        return response.json();
      };
      const scheduled: (() => void)[] = [];
      const view = {
        snapshot: async ({ signal }: { signal?: AbortSignal } = {}) =>
          await requestJson('/snapshot', { signal }) as SessionSnapshotResponse,
        transcript: {
          page: async () => { throw new Error('history page is not part of this fixture'); },
          catchUp: async () => { throw new Error('catch-up is not part of this fixture'); },
        },
        subscribe: (_input: unknown, onSignal: Parameters<SessionViewFacade['subscribe']>[1]) => {
          let closed = false;
          queueMicrotask(() => {
            if (closed) return;
            onSignal({ type: 'transcript', event: resetEvent('main', emptySnapshot(), 11), generation: 0 });
            onSignal({ type: 'ready', currentSessionCursor: { seq: 10, epoch: 'epoch-1' }, reconnected: false, generation: 0 });
          });
          return {
            updateSessionCursor: () => {}, setTranscriptGrades: () => {}, updateTranscriptCursor: () => {},
            restart: () => {}, nudge: () => {}, close: () => { closed = true; },
          };
        },
      } as unknown as SessionViewFacade;
      const transport = {
        submitPrompt: (_sessionId: string, body: unknown) => requestJson('/prompt', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }),
      } as unknown as KikiClient;
      const controller = new SessionController(transport, view, 'session_test', {
        scheduler: {
          schedule: (callback) => { scheduled.push(callback); return callback; },
          cancel: (handle) => {
            const index = scheduled.indexOf(handle as () => void);
            if (index >= 0) scheduled.splice(index, 1);
          },
        },
      });
      const drain = () => { while (scheduled.length > 0) scheduled.shift()!(); controller.flushFrames(); };
      try {
        const started = performance.now();
        mark('scenario:start');
        let preflight: Promise<unknown> | undefined;
        if (preflightBeforeOpen) {
          preflight = requestJson('/auto-compact');
          await waitFor(() => stages.some((stage) => stage.name === 'preflight:start'));
        }
        await controller.open();
        mark('shell');
        mark('send');
        await controller.sendPrompt({ text: 'http send' });
        await waitFor(() => { drain(); return controller.getState().transcriptReady; });
        mark('seed:after-send');
        if (!preflightBeforeOpen) await requestJson('/auto-compact');
        await preflight;
        mark('scenario:end');
        return { stages: stages.map((stage) => ({ ...stage, at: stage.at - started })), requests };
      } finally {
        controller.close();
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      }
    };

    const before = await run(true);
    const after = await run(false);
    const beforeNames = before.stages.map((stage) => stage.name);
    const afterNames = after.stages.map((stage) => stage.name);
    expect(before.requests).toEqual({ '/auto-compact': 1, '/snapshot': 1, '/prompt': 1 });
    expect(after.requests).toEqual(before.requests);
    expect(beforeNames).toEqual([
      'scenario:start', 'preflight:start', 'preflight:end', 'snapshot:start', 'snapshot:end',
      'shell', 'send', 'prompt:start', 'prompt:end', 'seed:after-send', 'scenario:end',
    ]);
    expect(afterNames).toEqual([
      'scenario:start', 'snapshot:start', 'snapshot:end', 'shell', 'send',
      'prompt:start', 'prompt:end', 'seed:after-send', 'preflight:start', 'preflight:end', 'scenario:end',
    ]);
    const beforeShell = before.stages.find((stage) => stage.name === 'shell')!;
    const afterShell = after.stages.find((stage) => stage.name === 'shell')!;
    const beforePreflightEnd = before.stages.find((stage) => stage.name === 'preflight:end')!;
    const afterPreflightStart = after.stages.find((stage) => stage.name === 'preflight:start')!;
    expect(beforeShell.at).toBeGreaterThan(beforePreflightEnd.at);
    expect(afterShell.at).toBeLessThan(afterPreflightStart.at);
  });

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

  it('refreshes a waking child on creation, drops it on disposal, and reads a new agent row', async () => {
    const previous = {
      id: 'child', session_id: 'session_test', kind: 'subagent' as const,
      parent_agent_id: 'main', description: 'Child', status: 'completed' as const,
      subagent_phase: 'completed' as const, live: false, model: 'provider/old',
      created_at: '2026-01-01T00:00:01.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      completed_at: '2026-01-01T00:00:02.000Z',
    };
    const newChild = {
      id: 'new-child', agent_id: 'new-child', session_id: 'session_test', kind: 'subagent' as const,
      parent_agent_id: 'main', description: 'readme_kiki_worker', status: 'running' as const,
      subagent_phase: 'working' as const, live: true, profile: 'worker', model: 'axon/gpt-5.6-luna',
      created_at: '2026-01-01T00:00:03.000Z',
      started_at: '2026-01-01T00:00:03.000Z',
    };
    const refreshingUntil = new Date(Date.now() + 120_000).toISOString();
    const reads = vi.fn()
      .mockResolvedValueOnce(snapshot({ subagents: [previous] }))
      .mockResolvedValueOnce(snapshot({ as_of_seq: 11, subagents: [{
        ...previous, live: undefined, refreshing: true, refreshing_until: refreshingUntil,
      }] }))
      .mockResolvedValueOnce(snapshot({ as_of_seq: 12, subagents: [previous] }))
      .mockResolvedValueOnce(snapshot({ as_of_seq: 13, subagents: [previous, newChild] }));
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
    // An agent the roster has no row for is one this event just created: its
    // role profile and model live only in the session snapshot, so the viewer
    // reads the row instead of waiting for a later snapshot or a resync.
    controller.handleSignal({
      type: 'sessionCursorAdvanced', rosterAgentId: 'new-child', generation: 0,
      cursor: { seq: 13, epoch: 'epoch-1' },
    });
    await waitFor(() => controller.getState().snapshotSubagents.length === 2);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(controller.getState().snapshotSubagents[1]).toMatchObject({
      id: 'new-child', agent_id: 'new-child', profile: 'worker', model: 'axon/gpt-5.6-luna',
    });
    expect(controller.getForest()?.byId['new-child']?.model).toBe('axon/gpt-5.6-luna');
    controller.close();
  });

  it('reads a spawned agent row from the op stream and resolves its injected sender', async () => {
    const spawned = {
      id: 'agent-244', agent_id: 'agent-244', session_id: 'session_test', kind: 'subagent' as const,
      parent_agent_id: 'main', description: 'readme_kiki_worker', status: 'running' as const,
      subagent_phase: 'working' as const, live: true, profile: 'worker', model: 'axon/gpt-5.6-luna',
      created_at: '2026-01-01T00:00:01.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
    };
    const reads = vi.fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ as_of_seq: 12, subagents: [spawned] }));
    const controller = new SessionController(
      {} as KikiClient, fakeView({ snapshot: reads }, {}), 'session_test',
    );
    await controller.open();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 1));
    controller.flushFrames();
    expect(controller.getState().snapshotSubagents).toEqual([]);

    controller.handleTranscript(opsEvent('main', [
      {
        op: 'marker.upsert',
        item: {
          kind: 'marker',
          markerId: 'message-delivery:m1',
          marker: 'message.delivery',
          at: '2026-01-01T00:00:02.000Z',
          payload: {
            messageId: 'm1',
            text: 'start the slice',
            origin: { kind: 'agent_message', senderAgentId: 'agent-244', senderTaskName: 'readme_kiki_worker' },
          },
        },
      },
    ], 2));
    controller.flushFrames();
    // An injected message on its own asks for nothing: the roster is only read
    // when an op stream actually names an agent it has no row for.
    expect(reads).toHaveBeenCalledTimes(1);

    controller.handleTranscript(opsEvent('main', [
      {
        op: 'task.upsert',
        task: {
          taskId: 'agent-244', kind: 'subagent', state: 'running', detached: false,
          name: 'readme_kiki_worker', subagentName: 'worker', agentId: 'agent-244',
          outputTail: '', startedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    ], 3));
    controller.flushFrames();
    // The viewer's own op stream carried the spawn, so the row is read without
    // any fresh snapshot load or resync.
    await waitFor(() => controller.getState().snapshotSubagents.length === 1);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(controller.getState().snapshotSubagents[0]).toMatchObject({
      id: 'agent-244', profile: 'worker', model: 'axon/gpt-5.6-luna',
    });
    // The injected message names the same id the roster row is keyed by, which
    // is what the timeline label resolves the sender's role and model through.
    const injected = controller.getState().blocks.find(
      (block): block is UserBlock => block.kind === 'user' && block.agentMessage !== undefined,
    );
    expect(injected?.agentMessage).toEqual({
      senderAgentId: 'agent-244', senderTaskName: 'readme_kiki_worker',
    });
    controller.close();
  });

  it('stops reading the roster for an agent the session never gives a row', async () => {
    const reads = vi.fn(async () => snapshot({ as_of_seq: 20 }));
    const controller = new SessionController(
      {} as KikiClient, fakeView({ snapshot: reads }, {}), 'session_test',
    );
    await controller.open();
    controller.handleTranscript(resetEvent('main', emptySnapshot(), 1));
    controller.flushFrames();
    expect(reads).toHaveBeenCalledTimes(1);

    const spawn = (seq: number) => opsEvent('main', [{
      op: 'task.upsert',
      task: {
        taskId: 'agent-x', kind: 'subagent', state: 'running', detached: false,
        agentId: 'agent-x', outputTail: `tick ${seq}`,
      },
    }], seq);
    for (const seq of [2, 3, 4, 5, 6]) {
      controller.handleTranscript(spawn(seq));
      controller.flushFrames();
      // Each read has to settle before the next batch, or the in-flight read
      // coalesces them and the budget never gets spent.
      await waitFor(() => reads.mock.calls.length >= Math.min(seq, 4));
    }
    // An agent whose row never arrives costs a bounded number of reads, not one
    // per op batch: a delegation the roster does not model cannot keep the
    // viewer snapshotting the whole session.
    expect(reads).toHaveBeenCalledTimes(4);
    expect(controller.getState().snapshotSubagents).toEqual([]);
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
      '*': 'off', main: 'delta', 'cold-child': 'turn',
    });
    const releaseSecond = controller.subscribeAgent('cold-child', vi.fn());
    expect(socket.setTranscriptGrades).not.toHaveBeenCalled();
    controller.setFocusedAgent('focused-child');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'focused-child': 'delta', 'cold-child': 'turn',
    });
    releaseFirst();
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(1);
    releaseSecond();
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'focused-child': 'delta',
    });
    const releaseLate = controller.subscribeAgent('late-child', vi.fn());
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'focused-child': 'delta', 'late-child': 'turn',
    });
    controller.setFocusedAgent('late-child');
    releaseLate();
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'late-child': 'delta',
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
      '*': 'off', main: 'delta', 'child-1': 'delta',
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
      { '*': 'off', main: 'off', 'child-1': 'delta' },
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

  it('forwards a captured prompt identity on retries without assigning one to other callers', async () => {
    const { controller, client } = await openController();
    const receipt = { prompt_id: 'captured-x', user_message_id: 'captured-x', status: 'running',
      content: [{ type: 'text', text: 'X' }], created_at: '2026-01-01T00:00:02.000Z' };
    client.submitPrompt.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(receipt);
    try {
      await expect(controller.sendPrompt({ promptId: 'captured-x', text: 'X' })).rejects.toThrow('offline');
      await controller.sendPrompt({ promptId: 'captured-x', text: 'X' });
      expect(client.submitPrompt.mock.calls.slice(0, 2).map((call) => call[1].prompt_id)).toEqual(['captured-x', 'captured-x']);
      await controller.sendPrompt({ text: 'Y' });
      expect(client.submitPrompt.mock.calls[2]![1].prompt_id).toEqual(expect.any(String));
      expect(client.submitPrompt.mock.calls[2]![1].prompt_id).not.toBe('captured-x');
    } finally { controller.close(); }
  });

  it('forwards an explicit persona greeting reply without opting ordinary prompts in', async () => {
    const { controller, client } = await openController();
    client.submitPrompt.mockResolvedValue({
      prompt_id: 'p-greeting', user_message_id: 'm-greeting', status: 'running',
      content: [{ type: 'text', text: 'Hello' }], created_at: '2026-01-01T00:00:02.000Z',
    });
    await controller.sendPrompt({ text: 'Hello', permissionMode: 'manual', personaGreetingReply: true });
    expect(client.submitPrompt).toHaveBeenLastCalledWith('session_test', expect.objectContaining({ persona_greeting_reply: true }));
    await controller.sendPrompt({ text: 'Ordinary', permissionMode: 'manual' });
    expect(client.submitPrompt).toHaveBeenLastCalledWith('session_test', expect.objectContaining({ persona_greeting_reply: undefined }));
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
      expect.objectContaining({ '*': 'off', main: 'delta' }),
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
    expect(controller.getState().resyncFailed).toBe(false);
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
  async function openTranscriptController(options: { rewriteResetTimeoutMs?: number; historyPreviewBytes?: number } = {}) {
    const client = {
      snapshot: vi.fn(async () => snapshot()),
      listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
      listTasks: vi.fn(async () => ({ items: [] })),
      getSessionGoal: vi.fn(async () => null),
      listMessages: vi.fn(async () => ({ items: [], has_more: false })),
      getAgentTranscript: vi.fn(async (_sessionId: string, _agentId: string, _options: object): Promise<AgentTranscriptResponse> => ({
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
      holdPrompt: vi.fn(async (_id: string, target: string, body: { held: boolean }) => ({ prompt_id: target, held: body.held })),
      getTranscriptOps: vi.fn(async (): ReturnType<SessionViewFacade['transcript']['catchUp']> => ({
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
      { scheduler, rewriteResetTimeoutMs: options.rewriteResetTimeoutMs, historyPreviewBytes: options.historyPreviewBytes },
    );
    await controller.open();
    return { controller, client, socket, flushAll };
  }

  async function openEntityController(entities: NonNullable<SessionViewFacade['transcript']['entities']>) {
    let signal: Parameters<SessionViewFacade['subscribe']>[1] | undefined;
    const view = {
      snapshot: vi.fn(async () => snapshot()),
      transcript: { page: vi.fn(), catchUp: vi.fn(), entities },
      subscribe: (_input: unknown, onSignal: Parameters<SessionViewFacade['subscribe']>[1]) => {
        signal = onSignal;
        return { updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} };
      },
    } as unknown as SessionViewFacade;
    const { scheduler, flushAll } = manualScheduler();
    const controller = new SessionController({} as KikiClient, view, 'session_test', { scheduler });
    await controller.open();
    const deliver = (event: TranscriptEvent) => { signal!({ type: 'transcript', event, generation: 1 }); };
    return { controller, entities, deliver, flushAll };
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

  it('restores an unanswered prompt and its attachments once without replacing an existing draft', async () => {
    resetDraftMemoryForTests();
    resetComposerMemoryForTests();
    const { controller, client } = await openTranscriptController();
    const content: MessageContent[] = [
      { type: 'text', text: 'original prompt' },
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'file', file_id: 'example-file', name: 'report.txt', media_type: 'text/plain', size: 5 },
    ];
    const canonical = userTurnSnapshot({ streaming: true, assistantText: '', prompt: 'original prompt' });
    controller.handleTranscript(resetEvent('main', { ...canonical, prompts: canonical.prompts.map((prompt) => ({ ...prompt, content })) }, 1));
    writeDraft('session_test', 'unsent follow-up');
    const listener = vi.fn();
    const unsubscribe = subscribeDraftAppends(listener);
    const stopRestoring = controller.subscribeInterruptedPrompt((parts) => restorePromptToDraft('session_test', parts));
    try {
      await Promise.all([controller.abortActive(), controller.abortActive()]);
      await controller.abortActive();
      expect(readDraft('session_test')).toBe('unsent follow-up\n\noriginal prompt');
      expect(buildPromptContent('', readComposerState('session_test').attachments ?? [])).toEqual(content.slice(1));
      expect(listener).toHaveBeenCalledOnce();
      expect(client.abortPrompt).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      stopRestoring();
      controller.close();
      resetDraftMemoryForTests();
      resetComposerMemoryForTests();
    }
  });

  it.each(['answered', 'steered', 'tool-started', 'missing-content', 'abort-failed', 'completed-race', 'reply-race'] as const)('does not refill a %s prompt', async (condition) => {
    resetDraftMemoryForTests();
    const { controller, client } = await openTranscriptController();
    const canonical = userTurnSnapshot({ streaming: true, assistantText: condition === 'answered' ? 'reply' : '' });
    const turn = canonical.items[0];
    if (condition === 'tool-started' && turn?.kind === 'turn') turn.steps[0]!.frames.push({
      kind: 'tool', frameId: 'example-tool', toolCallId: 'example-call', name: 'Read', state: 'running',
    });
    const prepared = condition === 'steered'
      ? { ...canonical, prompts: canonical.prompts.map((prompt) => ({ ...prompt, steeredAt: '2026-01-01T00:00:01.000Z' })) }
      : condition === 'missing-content'
        ? { ...canonical, prompts: canonical.prompts.map((prompt) => ({ ...prompt, content: undefined })) }
        : canonical;
    controller.handleTranscript(resetEvent('main', prepared, 1));
    writeDraft('session_test', 'keep my edits');
    const restored = vi.fn();
    const unsubscribe = controller.subscribeInterruptedPrompt(restored);
    if (condition === 'abort-failed') client.abortPrompt.mockRejectedValueOnce(new Error('abort unavailable'));
    if (condition === 'completed-race') client.abortPrompt.mockResolvedValueOnce({ aborted: false, at_seq: 2 });
    if (condition === 'reply-race') client.abortPrompt.mockImplementationOnce(async () => {
      controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true, assistantText: 'late reply' }), 2));
      return { aborted: true, at_seq: 2 };
    });
    try {
      if (condition === 'abort-failed') await expect(controller.abortActive()).rejects.toThrow('abort unavailable');
      else await controller.abortActive();
      expect(readDraft('session_test')).toBe('keep my edits');
      expect(restored).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      controller.close();
      resetDraftMemoryForTests();
    }
  });

  it('retains independent delta views alongside the unchanged legacy focus baseline', async () => {
    const { controller, socket } = await openTranscriptController();
    controller.setFocusedAgent('legacy-child');
    controller.retainAgentView('left', 'child-1', 'delta');
    controller.retainAgentView('right', 'child-2', 'delta');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'legacy-child': 'delta', 'child-1': 'delta', 'child-2': 'delta',
    });
    controller.releaseAgentView('left');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'off', 'legacy-child': 'delta', 'child-2': 'delta',
    });
    controller.setFocusedAgent(undefined);
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'delta', 'child-2': 'delta',
    });
    controller.updateAgentView('right', 'off');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'delta', 'child-2': 'off',
    });
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
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'off', main: 'delta', 'child-1': 'block' });
    controller.updateAgentView('inspector', 'turn');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'off', main: 'delta', 'child-1': 'turn' });
    controller.releaseAgentView('inspector');
    const releasedCalls = socket.setTranscriptGrades.mock.calls.length;
    controller.releaseAgentView('inspector');
    controller.updateAgentView('inspector', 'delta');
    expect(socket.setTranscriptGrades).toHaveBeenCalledTimes(releasedCalls);
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', { '*': 'off', main: 'delta' });
    controller.close();
  });

  it('suppresses wildcard transcript history for 511 hidden tabs after their listeners release', async () => {
    const { controller, socket } = await openTranscriptController();
    const releases = Array.from({ length: 511 }, (_, index) => {
      const agentId = `child-${index}`;
      controller.retainAgentView(`tab-${index}`, agentId, 'delta');
      return controller.subscribeAgent(agentId, vi.fn());
    });
    for (let index = 0; index < 511; index++) {
      controller.updateAgentView(`tab-${index}`, 'off');
      releases[index]!();
    }
    const grades = socket.setTranscriptGrades.mock.lastCall?.[1] as Record<string, string>;
    expect(Object.entries(grades).filter(([key, grade]) => key.startsWith('child-') && grade === 'off')).toHaveLength(511);
    expect(grades).toMatchObject({ '*': 'off', main: 'delta' });
    controller.close();
  });

  it('retargets a view without suppressing summary observers or main delta', async () => {
    const { controller, socket } = await openTranscriptController();
    const off = controller.subscribeAgent('child-1', vi.fn());
    controller.retainAgentView('tab', 'child-1', 'delta');
    controller.retainAgentView('tab', 'child-2', 'block');
    controller.retainAgentView('main-view', 'main', 'off');
    expect(socket.setTranscriptGrades).toHaveBeenLastCalledWith('session_test', {
      '*': 'off', main: 'delta', 'child-1': 'turn', 'child-2': 'block',
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

  it('does not roll visible progress back on a stale or equal-cursor grade reset', async () => {
    const { controller, flushAll } = await openTranscriptController();
    controller.handleTranscript(resetEvent('child-1', userTurnSnapshot({ assistantText: 'earlier' }), 1));
    controller.handleTranscript(opsEvent('child-1', [
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: ASSISTANT_FRAME_ID }, offset: 7, text: ' latest' },
    ], 2));
    flushAll();
    const blocks = controller.getAgentState('child-1').blocks;
    const cursor = controller.getAgentTranscriptCursor('child-1');
    const earlierReset = resetEvent('child-1', userTurnSnapshot({ assistantText: 'earlier' }), 1);
    if (earlierReset.type !== 'transcript.reset') throw new Error('Expected reset');
    controller.handleTranscript({ ...earlierReset, grade: 'turn' });
    controller.handleTranscript(resetEvent('child-1', userTurnSnapshot({ assistantText: 'earlier' }), 2));
    expect(controller.getAgentState('child-1').blocks).toBe(blocks);
    expect(controller.getAgentTranscriptCursor('child-1')).toEqual(cursor);
    controller.close();
  });

  it('accepts an equal-cursor turn-to-delta reset with the missing frame details', async () => {
    const { controller } = await openTranscriptController();
    const full = userTurnSnapshot({ assistantText: 'full details' });
    const turnOnly = { ...full, items: full.items.map((item) => item.kind === 'turn' ? { ...item, steps: [] } : item) };
    const turnReset = resetEvent('child-1', turnOnly, 1);
    if (turnReset.type !== 'transcript.reset') throw new Error('Expected reset');
    controller.handleTranscript({ ...turnReset, grade: 'turn' });
    expect(controller.getAgentState('child-1').blocks.some((block) => block.kind === 'assistant')).toBe(false);
    controller.handleTranscript(resetEvent('child-1', full, 1));
    expect(controller.getAgentState('child-1').blocks.some((block) => block.kind === 'assistant' && block.text === 'full details')).toBe(true);
    controller.close();
  });

  const historyTurn = (ordinal: number) => ({ kind: 'turn' as const, turnId: `history-${ordinal}`, ordinal,
    state: 'completed' as const, origin: { kind: 'user' as const }, prompt: `History ${ordinal}`, steps: [] });
  const historyTexts = (controller: SessionController) => controller.getState().blocks
    .filter((block): block is UserBlock => block.kind === 'user').map((block) => block.text);
  const readHistoryToBoundary = async (controller: SessionController): Promise<void> => {
    while (controller.getState().hasMoreHistory) {
      if (!await controller.loadOlderMessages()) break;
    }
  };

  it('keeps requested history headers beyond the preview cache budget and restores a visible preview', async () => {
    const { controller, client } = await openTranscriptController({ historyPreviewBytes: 12000 });
    const turns = Array.from({ length: 80 }, (_, ordinal) => ({ ...historyTurn(ordinal), prompt: `History ${ordinal} ${'x'.repeat(2000)}`,
      contentRefs: [{ source: { kind: 'turn' as const, id: `history-${ordinal}` }, path: ['steps', 0, 'frames', 0, 'text'], revision: 'preview', kind: 'text' as const, offset: 2000, total: 4000 }],
      steps: [{ kind: 'step' as const, stepId: `history-${ordinal}.1`, turnId: `history-${ordinal}`, ordinal: 1, state: 'completed' as const,
        frames: [{ kind: 'text' as const, frameId: `reply-${ordinal}`, role: 'assistant' as const, text: `Reply ${ordinal} ${'y'.repeat(2000)}` }] }] }));
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: turns.slice(-1), olderCursor: '79' }), 1, true));
    client.getAgentTranscript.mockImplementation(async (_session, _agent, options) => {
      const input = options as { beforeItem: string };
      const end = Number(input.beforeItem); const start = Math.max(0, end - 10);
      return { agent_id: 'main', items: turns.slice(start, end), has_more: start > 0, next_cursor: start > 0 ? String(start) : undefined };
    });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => !controller.getState().hasMoreHistory);
      expect(historyTexts(controller)).toHaveLength(80);
      expect(controller.historyPreviewPending('main', 'history-0')).toBe(true);
      const before = controller.residentBytes();
      const releasePreview = controller.retainHistoryPreview('main', 'history-0');
      try {
        await waitFor(() => !controller.historyPreviewPending('main', 'history-0'));
        expect(historyTexts(controller)[0]).toBe(turns[0]!.prompt);
        expect(controller.getState().blocks.find((block) => block.kind === 'assistant' && block.turnId === 'history-0')).toMatchObject({ text: turns[0]!.steps[0]!.frames[0]!.text });
        expect(client.getAgentTranscript.mock.calls.length).toBe(9);
      } finally { releasePreview(); }
      expect(controller.residentBytes()).toBeLessThan(before + 12000);
      expect(controller.historyPreviewPending('main', 'history-0')).toBe(true);
      expect(controller.getState().hasMoreHistory).toBe(false);
    } finally { controller.close(); }
  });

  it('reads 1100 turns only on explicit continuation demand while preserving live newest messages', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    const turns = Array.from({ length: 1100 }, (_, ordinal) => historyTurn(ordinal));
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: turns.slice(-20), olderCursor: '1080' }), 1, true));
    // The old consumer path leaves only the reset window until scrolling requests a page.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(historyTexts(controller)).toEqual(turns.slice(-20).map((turn) => turn.prompt));
    expect(client.getAgentTranscript).not.toHaveBeenCalled();
    client.getAgentTranscript.mockImplementation(async (_session, _agent, options) => {
      const input = options as { beforeItem: string; pageSize: number };
      const end = Number(input.beforeItem);
      const start = Math.max(0, end - input.pageSize);
      if (end === 1080) {
        controller.handleTranscript(opsEvent('main', [{ op: 'turn.upsert', turn: historyTurn(1100) }], 2));
        flushAll();
      }
      return { agent_id: 'main', items: turns.slice(start, end), has_more: start > 0,
        next_cursor: start > 0 ? String(start) : undefined,
        coverage: start > 0 ? { kind: 'tail', hasMoreOlder: true } : { kind: 'full', hasMoreOlder: false } };
    });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => !controller.getState().hasMoreHistory);
      expect(historyTexts(controller)).toEqual([...turns, historyTurn(1100)].map((turn) => turn.prompt));
      expect(controller.getState()).toMatchObject({ historyCoverageKind: 'full', loadingOlder: false, olderError: undefined });
      expect(client.getAgentTranscript).toHaveBeenCalledTimes(54);
      expect(client.getAgentTranscript.mock.calls[0]?.[2]).toMatchObject({ beforeItem: '1080', pageSize: 20 });
    } finally { controller.close(); }
  });

  it('consumes oversized HTTP pages through the real klient decoder and completes ordered history', async () => {
    const { createKlient } = await import('@kiki/klient/http');
    const { controller, client } = await openTranscriptController();
    const turns = Array.from({ length: 240 }, (_, ordinal) => ({ ...historyTurn(ordinal), prompt: `History ${ordinal} ${'界'.repeat(700)}` }));
    const decodedBytes: number[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const input = new URL(String(url));
      const end = Number(input.searchParams.get('before_item'));
      const start = Math.max(0, end - 100);
      const body = JSON.stringify({ code: 0, msg: 'success', request_id: 'history-page', data: {
        session_id: 'session_test', agent_id: 'main', items: turns.slice(start, end), has_more: start > 0,
        next_cursor: start > 0 ? String(start) : undefined, transcript_coverage_version: 2,
        tasks: [], meta: {}, agents: [], pending_interactions: [],
        coverage: start > 0 ? { kind: 'tail', hasMoreOlder: true } : { kind: 'full', hasMoreOlder: false },
      } });
      decodedBytes.push(new TextEncoder().encode(body).byteLength);
      return new Response(body);
    });
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    const view = fakeView(client, {});
    const scoped = new SessionController(client as unknown as KikiClient, { ...view, transcript: klient.session('session_test').view.transcript }, 'session_test');
    await scoped.open();
    scoped.handleTranscript(resetEvent('main', emptySnapshot({ items: turns.slice(-20), olderCursor: '220' }), 1, true));
    await readHistoryToBoundary(scoped);
    try {
      await waitFor(() => !scoped.getState().hasMoreHistory);
      expect(decodedBytes[0]).toBeGreaterThan(96 * 1024);
      expect(historyTexts(scoped)).toEqual(turns.map((turn) => turn.prompt));
      expect(scoped.getState()).toMatchObject({ olderError: undefined, historyCoverageKind: 'full' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { scoped.close(); controller.close(); await klient.close(); }
  });

  it('continues a preparing history page without reporting it as a terminal read failure', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(1)] }), 1, true));
    client.getAgentTranscript.mockRejectedValueOnce(new ApiError({ code: 40923, msg: 'Preparing navigation', data: null }));
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0)], has_more: false, coverage: { kind: 'full', hasMoreOlder: false } });
    const errors: string[] = [];
    const unsubscribe = controller.subscribe(() => { if (controller.getState().olderError !== undefined) errors.push(controller.getState().olderError!); });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => !controller.getState().hasMoreHistory);
      expect(historyTexts(controller)).toEqual(['History 0', 'History 1']);
      expect(errors).toEqual([]);
      expect(client.getAgentTranscript).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); controller.close(); }
  });

  it('keeps a failed page idle until retry demand, then clears its error before continuing', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(2)] }), 1, true));
    client.getAgentTranscript.mockRejectedValueOnce(new Error('temporary network failure'));
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(1)], has_more: true });
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0)], has_more: false,
      coverage: { kind: 'full', hasMoreOlder: false } });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => controller.getState().olderError !== undefined);
      expect(controller.getState().hasMoreHistory).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(client.getAgentTranscript).toHaveBeenCalledTimes(1);
      await readHistoryToBoundary(controller);
      expect(historyTexts(controller)).toEqual(['History 0', 'History 1', 'History 2']);
      expect(controller.getState().olderError).toBeUndefined();
      expect(client.getAgentTranscript).toHaveBeenCalledTimes(3);
      expect(client.getAgentTranscript.mock.calls.map((call) => call[2])).toEqual([
        expect.objectContaining({ beforeTurn: 'history-2' }),
        expect.objectContaining({ beforeTurn: 'history-2' }),
        expect.objectContaining({ beforeTurn: 'history-1' }),
      ]);
    } finally { controller.close(); }
  });

  it('stops repeated cursors as a retryable error without falsely completing history', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(2)], olderCursor: 'cursor-2' }), 1, true));
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(1)], has_more: true, next_cursor: 'cursor-2' });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => controller.getState().olderError !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(controller.getState()).toMatchObject({ hasMoreHistory: true, loadingOlder: false, olderError: 'History page did not advance its cursor' });
      expect(client.getAgentTranscript).toHaveBeenCalledTimes(1);
      client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0), historyTurn(1)], has_more: false });
      await controller.loadOlderMessages();
      expect(historyTexts(controller)).toEqual(['History 0', 'History 1', 'History 2']);
      expect(controller.getState().olderError).toBeUndefined();
    } finally { controller.close(); }
  });

  it('retains read windows on same-epoch tail refresh but fills the gap from the new tail cursor', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(2)], olderCursor: '2' }), 1, true));
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0), historyTurn(1)], has_more: false });
    await controller.loadOlderMessages();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(5)], olderCursor: '5' }), 2, true));
    expect(historyTexts(controller)).toEqual(['History 0', 'History 1', 'History 2', 'History 5']);
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(2), historyTurn(3), historyTurn(4)], has_more: true, next_cursor: '2' });
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0), historyTurn(1)], has_more: false });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => !controller.getState().hasMoreHistory);
      expect(historyTexts(controller)).toEqual(Array.from({ length: 6 }, (_, ordinal) => `History ${ordinal}`));
      expect(client.getAgentTranscript.mock.calls[1]?.[2]).toMatchObject({ beforeItem: '5' });
    } finally { controller.close(); }
  });

  it('keeps a delivered row visible across a bounded same-epoch reset and loads it once from cold tail history', async () => {
    const deliveredPrompt = {
      promptId: 'prompt-111', userMessageId: 'user-111', status: 'completed' as const,
      content: [{ type: 'text' as const, text: 'row 111 full text' }], createdAt: '2026-01-01T00:01:51.000Z',
      finishedAt: '2026-01-01T00:01:52.000Z',
    };
    const deliveredTurn = {
      kind: 'turn' as const, turnId: 'turn-111', ordinal: 111, state: 'completed' as const,
      origin: { kind: 'user' as const, payload: { promptId: deliveredPrompt.promptId, userMessageId: deliveredPrompt.userMessageId } },
      prompt: 'row 111 full text', startedAt: deliveredPrompt.createdAt, endedAt: deliveredPrompt.finishedAt, steps: [],
    };
    const tailTurn = (ordinal: 113 | 114) => ({
      kind: 'turn' as const, turnId: `turn-${ordinal}`, ordinal, state: 'completed' as const,
      origin: { kind: 'other' as const }, prompt: `tail ${ordinal}`, startedAt: `2026-01-01T00:01:${ordinal}.000Z`, steps: [],
    });
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [deliveredTurn], prompts: [deliveredPrompt] }), 1, true));
    expect(historyTexts(controller)).toEqual(['row 111 full text']);
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [tailTurn(113), tailTurn(114)] }), 2, true));
    expect(historyTexts(controller)).toEqual(['row 111 full text']);
    controller.close();
    const cold = await openTranscriptController();
    cold.controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [tailTurn(113), tailTurn(114)] }), 1, true));
    cold.client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [deliveredTurn], has_more: false });
    await expect(cold.controller.loadOlderMessages()).resolves.toBe(true);
    const users = cold.controller.getState().blocks.filter((block): block is UserBlock => block.kind === 'user' && block.userMessageId === deliveredPrompt.userMessageId);
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe('row 111 full text');
    expect(cold.client.getAgentTranscript).toHaveBeenCalledExactlyOnceWith('session_test', 'main', expect.objectContaining({ beforeTurn: 'turn-113' }));
    cold.controller.close();
  });

  it('loads a partial global prompt collection through one entity page without overwriting a live upsert', async () => {
    const prompt = (promptId: string, text: string) => ({
      promptId, userMessageId: `user-${promptId}`, status: 'queued' as const,
      content: [{ type: 'text' as const, text }], createdAt: '2026-01-01T00:00:00.000Z',
    });
    const initial = Array.from({ length: 8 }, (_, index) => prompt(`p-${index}`, `initial ${index}`));
    const stale = prompt('p-0', 'stale page text');
    const page = [stale, ...Array.from({ length: 4 }, (_, index) => prompt(`p-${index + 8}`, `page ${index + 8}`))];
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>();
    const held = deferred<Awaited<ReturnType<NonNullable<SessionViewFacade['transcript']['entities']>>>>();
    entities.mockImplementationOnce(() => held.promise);
    const { controller, deliver, flushAll } = await openEntityController(entities);
    deliver(resetEvent('main', emptySnapshot({
      prompts: initial,
      globalCoverage: {
        version: 1,
        tasks: { returned: 0, total: 0, hasMore: false },
        attachments: { returned: 0, total: 0, hasMore: false },
        prompts: { returned: 8, total: 12, hasMore: true },
      },
    }), 1, true));
    const loading = controller.loadTranscriptEntities('main', 'prompt');
    expect(entities).toHaveBeenCalledExactlyOnceWith({ agentId: 'main', kind: 'prompt', cursor: undefined, limit: 20 }, { signal: expect.any(AbortSignal) });
    deliver(opsEvent('main', [{ op: 'prompt.upsert', prompt: prompt('p-0', 'live full text') }], 2));
    flushAll();
    held.resolve({ session_id: 'session_test', agent_id: 'main', kind: 'prompt', items: page, has_more: false, total: 12 });
    await expect(loading).resolves.toBe(true);
    expect(controller.getState().globalCoverage?.prompts).toEqual({ returned: 12, total: 12, hasMore: false });
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'live full text')).toBe(true);
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'stale page text')).toBe(false);
    controller.close();
  });

  it.each([undefined, '', 'same'] as const)('keeps entity pagination retryable after a network failure and rejects %s cursor progress', async (invalidCursor) => {
    const prompt = (promptId: string) => ({ promptId, status: 'queued' as const, content: [{ type: 'text' as const, text: promptId }], createdAt: '2026-01-01T00:00:00.000Z' });
    const page = (promptId: string, hasMore: boolean, nextCursor?: string) => ({
      session_id: 'session_test', agent_id: 'main', kind: 'prompt' as const, items: [prompt(promptId)], has_more: hasMore, total: 2,
      next_cursor: nextCursor,
    }) as Awaited<ReturnType<NonNullable<SessionViewFacade['transcript']['entities']>>>;
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>()
      .mockRejectedValueOnce(new Error('entity network down'));
    if (invalidCursor === 'same') {
      entities
        .mockResolvedValueOnce(page('p-0', true, 'cursor-1'))
        .mockResolvedValueOnce(page('p-invalid', true, 'cursor-1'))
        .mockResolvedValueOnce(page('p-recovered', false));
    } else {
      entities
        .mockResolvedValueOnce(page('p-invalid', true, invalidCursor === undefined ? undefined : invalidCursor))
        .mockResolvedValueOnce(page('p-recovered', false));
    }
    const { controller, deliver } = await openEntityController(entities);
    deliver(resetEvent('main', emptySnapshot({ prompts: [], globalCoverage: {
      version: 1,
      tasks: { returned: 0, total: 0, hasMore: false },
      attachments: { returned: 0, total: 0, hasMore: false },
      prompts: { returned: 0, total: 2, hasMore: true },
    } }), 1, true));
    await expect(controller.loadTranscriptEntities('main', 'prompt')).resolves.toBe(false);
    expect(controller.getState().detailLoads['entities:prompt']).toEqual({ status: 'error', message: 'entity network down' });
    const firstPage = await controller.loadTranscriptEntities('main', 'prompt');
    let invalidPage = firstPage;
    if (invalidCursor === 'same') {
      expect(firstPage).toBe(true);
      expect(controller.getState().detailLoads['entities:prompt']).toBeUndefined();
      expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'p-0')).toBe(true);
      invalidPage = await controller.loadTranscriptEntities('main', 'prompt');
    }
    expect(invalidPage).toBe(false);
    expect(controller.getState().detailLoads['entities:prompt']).toEqual({ status: 'error', message: 'Transcript entity page did not advance its cursor' });
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'p-invalid')).toBe(false);
    const expectedRetryCursor = invalidCursor === 'same' ? 'cursor-1' : undefined;
    expect(entities.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: expectedRetryCursor });
    await expect(controller.loadTranscriptEntities('main', 'prompt')).resolves.toBe(true);
    expect(controller.getState().detailLoads['entities:prompt']).toBeUndefined();
    expect(entities.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: expectedRetryCursor });
    controller.close();
  });

  it('ignores an old entity page and error after a reset while allowing the new generation to load', async () => {
    const prompt = (promptId: string, text: string) => ({ promptId, status: 'queued' as const, content: [{ type: 'text' as const, text }], createdAt: '2026-01-01T00:00:00.000Z' });
    const oldPage = deferred<Awaited<ReturnType<NonNullable<SessionViewFacade['transcript']['entities']>>>>();
    const freshPage = deferred<Awaited<ReturnType<NonNullable<SessionViewFacade['transcript']['entities']>>>>();
    const entities = vi.fn<NonNullable<SessionViewFacade['transcript']['entities']>>()
      .mockImplementationOnce(() => oldPage.promise)
      .mockImplementationOnce(() => freshPage.promise);
    const { controller, deliver } = await openEntityController(entities);
    deliver(resetEvent('main', emptySnapshot({ prompts: [prompt('old', 'old text')] }), 1, true));
    const oldLoad = controller.loadTranscriptEntities('main', 'prompt');
    deliver(resetEvent('main', emptySnapshot({ prompts: [prompt('new', 'new text')] }), 2, true));
    const freshLoad = controller.loadTranscriptEntities('main', 'prompt');
    expect(entities).toHaveBeenCalledTimes(2);
    freshPage.resolve({ session_id: 'session_test', agent_id: 'main', kind: 'prompt', items: [prompt('fresh', 'fresh text')], has_more: false, total: 2 });
    expect(await freshLoad).toBe(true);
    oldPage.reject(new Error('old entity network down'));
    expect(await oldLoad).toBe(false);
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'new text')).toBe(true);
    expect(controller.getState().detailLoads['entities:prompt']).toBeUndefined();
    controller.close();
  });

  it('keeps unknown coverage partial after requested pagination reaches its source boundary', async () => {
    const { controller, client } = await openTranscriptController();
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(1)] }), 1, true));
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [historyTurn(0)], has_more: false,
      coverage: { kind: 'unknown', hasMoreOlder: true } });
    await readHistoryToBoundary(controller);
    try {
      await waitFor(() => !controller.getState().hasMoreHistory);
      expect(controller.getState().historyCoverageKind).toBe('unknown');
      expect(historyTexts(controller)).toEqual(['History 0', 'History 1']);
    } finally { controller.close(); }
  });

  it.each(['suspend', 'close', 'reset'] as const)('aborts obsolete page HTTP metadata on %s and ignores its late body', async (action) => {
    const { controller, client } = await openTranscriptController();
    const held = deferred<AgentTranscriptResponse>();
    let signal: AbortSignal | undefined;
    const view = fakeView(client, {});
    view.transcript.page = async (_input, options) => { signal = options?.signal; return held.promise as ReturnType<SessionViewFacade['transcript']['page']>; };
    const scoped = new SessionController(client as unknown as KikiClient, view, 'session_test');
    await scoped.open();
    scoped.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(2)] }), 1, true));
    const first = scoped.loadOlderMessages();
    const second = scoped.loadOlderMessages();
    try {
      await waitFor(() => signal !== undefined);
      expect(signal?.aborted).toBe(false);
      if (action === 'suspend') scoped.suspend();
      else if (action === 'close') scoped.close();
      else scoped.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(9)] }), 2));
      expect(signal?.aborted).toBe(true);
      held.resolve({ agent_id: 'main', items: [historyTurn(0)], has_more: false });
      expect(await first).toBe(false);
      expect(await second).toBe(false);
      expect(historyTexts(scoped)).not.toContain('History 0');
      expect(scoped.getState().loadingOlder).toBe(false);
    } finally { scoped.close(); controller.close(); }
  });

  it.each([false, true])('cancels only abandoned older-page consumers and rejects a late abandoned body (last=%s)', async (cancelLast) => {
    const { controller, client } = await openTranscriptController();
    const held = deferred<AgentTranscriptResponse>();
    let wireSignal: AbortSignal | undefined;
    const view = fakeView(client, {});
    view.transcript.page = async (_input, options) => { wireSignal = options?.signal; return held.promise as ReturnType<SessionViewFacade['transcript']['page']>; };
    const scoped = new SessionController(client as unknown as KikiClient, view, 'session_test');
    await scoped.open();
    scoped.handleTranscript(resetEvent('main', emptySnapshot({ items: [historyTurn(2)] }), 1, true));
    const firstDemand = new AbortController();
    const secondDemand = new AbortController();
    const first = scoped.loadOlderMessages('main', firstDemand.signal);
    const second = scoped.loadOlderMessages('main', secondDemand.signal);
    firstDemand.abort();
    expect(await first).toBe(false);
    expect(wireSignal?.aborted).toBe(false);
    if (cancelLast) secondDemand.abort();
    expect(wireSignal?.aborted).toBe(cancelLast);
    held.resolve({ agent_id: 'main', items: [historyTurn(0)], has_more: false });
    expect(await second).toBe(!cancelLast);
    await held.promise;
    expect(historyTexts(scoped).includes('History 0')).toBe(!cancelLast);
    expect(scoped.getState().loadingOlder).toBe(false);
    scoped.close();
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
    expect(await second).toBe(true);
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

  it('keeps REST and WS unknown coverage visible without discarding earlier turns', async () => {
    const { controller, client } = await openTranscriptController();
    const newer = { kind: 'turn' as const, turnId: 't2', ordinal: 2, state: 'completed' as const,
      origin: { kind: 'user' as const }, prompt: 'newer', steps: [] };
    const older = { kind: 'turn' as const, turnId: 't1', ordinal: 1, state: 'completed' as const,
      origin: { kind: 'user' as const }, prompt: 'older', steps: [] };
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [newer] }), 1, true));
    client.getAgentTranscript.mockResolvedValueOnce({
      agent_id: 'main', items: [older], has_more: false,
      coverage: { kind: 'unknown', hasMoreOlder: true },
    });
    await expect(controller.loadOlderMessages()).resolves.toBe(true);
    expect(controller.getState()).toMatchObject({ historyCoverageKind: 'unknown', hasMoreHistory: false });
    await expect(controller.loadOlderMessages()).resolves.toBe(false);
    expect(client.getAgentTranscript).toHaveBeenCalledTimes(1);
    const unknownReset = resetEvent('main', emptySnapshot({ items: [] }), 2, true);
    if (unknownReset.type !== 'transcript.reset') throw new Error('Expected transcript reset');
    const beforeResetVersion = controller.getState().transcriptResetVersion;
    controller.handleTranscript({ ...unknownReset, coverage: { kind: 'unknown', hasMoreOlder: true } });
    expect(controller.getState()).toMatchObject({
      historyCoverageKind: 'unknown', hasMoreHistory: false, transcriptResetVersion: beforeResetVersion,
    });
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'older')).toBe(true);
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [newer] }), 3, true));
    expect(controller.getState().historyCoverageKind).toBe('unknown');
    controller.handleTranscript(resetEvent('main', emptySnapshot({ items: [newer] }), 4));
    expect(controller.getState().historyCoverageKind).toBe('full');
    expect(controller.getState().blocks.some((block) => block.kind === 'user' && block.text === 'older')).toBe(false);
    controller.close();
  });

  it('does not adopt snapshot messages or in-flight text on open', async () => {
    const { controller, client, socket } = await openTranscriptController();
    expect(client.snapshot).toHaveBeenCalledWith('session_test', { transcript: true });
    expect(client.listMessages).not.toHaveBeenCalled();
    expect(socket.subscribe).toHaveBeenCalledWith(
      'session_test',
      { seq: 10, epoch: 'epoch-1' },
      expect.objectContaining({ '*': 'off', main: 'delta' }),
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
    await expect(controller.loadOlderMessages('main')).resolves.toBe(false);
    expect(controller.getState().olderError).toBe('History page did not advance its cursor');
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

  it('clears plan mode, queue, active, and pending state while preserving permission through sparse AgentState updates', async () => {
    const { controller, flushAll } = await openTranscriptController();
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
        meta: { modes: { plan: {} }, agent: { permission: 'yolo' } },
      },
    }));
    expect(controller.getState()).toMatchObject({
      planMode: true,
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
      queuedPromptIds: [],
      activePromptId: undefined,
      pendingInteraction: 'none',
      permissionMode: 'yolo',
    });
    controller.handleTranscript(asTranscriptEvent({
      type: 'transcript.ops', agent_id: 'main', seq: 3,
      ops: [{ op: 'meta.merge', meta: { agent: { permission: 'manual' } } }],
    }));
    flushAll();
    expect(controller.getState().permissionMode).toBe('manual');
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
    const presentation = { spans: [{ start: 0, end: 8, kind: 'selection' as const, quote: 'replaced' }] };
    client.replacePrompt = vi.fn(async () => ({
      prompt_id: 'p-local',
      user_message_id: 'um-local',
      status: 'queued',
      content: [{ type: 'text', text: 'replaced', presentation }],
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
    await controller.replaceQueued('p-local', 'replaced', undefined, presentation);
    expect(client.replacePrompt).toHaveBeenCalledWith('session_test', 'p-local', {
      content: [{ type: 'text', text: 'replaced', presentation }], replace_attachments: undefined,
    });
    expect(controller.getState().blocks.find((block) => block.kind === 'user')).toMatchObject({
      text: 'replaced', presentation,
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

  it('replaces a queued prompt with image-only content without an empty text part or a new identity', async () => {
    const { controller, client } = await openTranscriptController();
    const image = { type: 'image' as const, source: { kind: 'base64' as const, media_type: 'image/png', data: 'cG5n' } };
    client.replacePrompt = vi.fn(async () => ({ prompt_id: 'p-edit', user_message_id: 'um-edit', status: 'queued' as const, content: [image], created_at: '2026-01-01T00:00:00.000Z' }));
    await controller.replaceQueued('p-edit', '', [image]);
    expect(client.replacePrompt).toHaveBeenCalledExactlyOnceWith('session_test', 'p-edit', { content: [image], replace_attachments: true });
    expect(controller.getState().blocks.filter((block) => block.kind === 'user')).toEqual([
      expect.objectContaining({ promptId: 'p-edit', userMessageId: 'um-edit', queuedContent: [image] }),
    ]);
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

  it('holds and releases a queued prompt for editing over the wire', async () => {
    const { controller, client } = await openTranscriptController();
    await expect(controller.holdQueued('p1', true)).resolves.toBe(true);
    await controller.holdQueued('p1', false);
    expect(client.holdPrompt).toHaveBeenNthCalledWith(1, 'session_test', 'p1', { held: true });
    expect(client.holdPrompt).toHaveBeenNthCalledWith(2, 'session_test', 'p1', { held: false });
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
    expect(controller.getState().resyncFailed).toBe(false);
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

  it('reads at most two bounded catchup pages and restores the live gap from their canonical batches', async () => {
    const { controller, client, socket, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    const target = { type: 'frame' as const, turnId: 't1', stepId: 't1.1', frameId: 'f1' };
    client.getTranscriptOps.mockResolvedValueOnce({ session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', through_seq: 2, complete: true, has_more: true, batches: [{ seq: 2, ops: [{ op: 'append', target, offset: 5, text: ' world' }] }] });
    client.getTranscriptOps.mockResolvedValueOnce({ session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', through_seq: 3, complete: true, has_more: false, batches: [{ seq: 3, ops: [{ op: 'append', target, offset: 11, text: '!' }] }] });
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', seq: 3, ops: [{ op: 'append', target, offset: 11, text: '!' }] }));
    flushAll();
    await waitFor(() => { flushAll(); return controller.getState().blocks.some((block) => block.kind === 'assistant' && block.text === 'Hello world!'); });
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(2);
    expect(client.getTranscriptOps).toHaveBeenLastCalledWith('session_test', 'main', { seq: 2, epoch: 'epoch-1' }, 'delta');
    expect(socket.restartGeneration).not.toHaveBeenCalled();
    controller.close();
  });

  it('continues beyond two bounded catchup pages and publishes the recovered newest region', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    const target = { type: 'frame' as const, turnId: 't1', stepId: 't1.1', frameId: 'f1' };
    for (let seq = 2; seq <= 6; seq += 1) client.getTranscriptOps.mockResolvedValueOnce({
      session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', through_seq: seq,
      complete: true, has_more: seq < 6,
      batches: [{ seq, ops: [{ op: 'append', target, offset: seq + 3, text: String(seq) }] }],
    });
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', seq: 6,
      ops: [{ op: 'append', target, offset: 9, text: '6' }] }));
    flushAll();
    await waitFor(() => { flushAll(); return controller.getState().blocks.some((block) => block.kind === 'assistant' && block.text === 'Hello23456'); });
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(5);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('resynchronizes a catchup cursor that stops advancing rather than looping forever', async () => {
    const { controller, client, flushAll } = await openTranscriptController();
    seedTextAgent(controller, 'main', 'f1', 'Hello');
    client.getTranscriptOps.mockResolvedValueOnce({ session_id: 'session_test', agent_id: 'main', epoch: 'epoch-1', through_seq: 1, complete: true, has_more: true, batches: [] });
    controller.handleTranscript(asTranscriptEvent({ type: 'transcript.ops', agent_id: 'main', seq: 9,
      ops: [{ op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 'f1' }, offset: 99, text: 'gap' }] }));
    flushAll();
    await waitFor(() => client.snapshot.mock.calls.length > 1);
    expect(client.getTranscriptOps).toHaveBeenCalledTimes(1);
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


it('keeps selected answers visible immediately after a successful question response', async () => {
  const { controller, client, flushAll } = await openController();
  const resolveQuestion = vi.fn(async () => undefined);
  Object.assign(client, { resolveQuestion });
  const interaction = {
    interactionId: 'q-history', interactionKind: 'question' as const, state: 'pending' as const,
    request: { createdAt: '2026-01-01T00:00:00.000Z', questions: [
      { id: 'q1', question: 'Which checks?', options: [{ id: 'a', label: 'Typecheck' }, { id: 'b', label: 'Visual proof' }] },
    ] },
  };
  try {
    controller.handleTranscript(resetEvent('main', emptySnapshot({ interactions: [interaction] }), 1));
    flushAll();
    await controller.answerQuestion('q-history', { q1: { kind: 'multi_with_other', option_ids: ['a', 'b'], other_text: 'Include mobile.' } });
    expect(resolveQuestion).toHaveBeenCalledOnce();
    expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({
      outcome: { kind: 'answered', answers: { q1: 'Typecheck, Visual proof, Include mobile.' } },
    });
    controller.handleTranscript(opsEvent('main', [{ op: 'interaction.upsert', interaction: {
      ...interaction, state: 'answered', response: { answers: { 'Which checks?': 'Typecheck, Visual proof, Include mobile.' } },
    } }], 2));
    flushAll();
    expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({
      outcome: { kind: 'answered', answers: { q1: 'Typecheck, Visual proof, Include mobile.' } },
    });
  } finally {
    controller.close();
  }
});


describe('question terminal REST reconciliation', () => {
  const pending = {
    interactionId: 'q-reply', interactionKind: 'question' as const, state: 'pending' as const,
    request: { questions: [{ question: 'Pick one', options: [{ label: 'Yes' }, { label: 'No' }] }] },
  };
  const answers = { q_0: { kind: 'single' as const, option_id: 'opt_0_0' } };

  it.each([
    [API_CODES.QUESTION_NOT_FOUND, 'unavailable'],
    [API_CODES.APPROVAL_ALREADY_RESOLVED, 'resolvedElsewhere'],
    [API_CODES.QUESTION_EXPIRED, 'expired'],
  ] as const)('closes a stale card for code %s without claiming delivery', async (code, kind) => {
    const { controller, client, flushAll } = await openController();
    const resolveQuestion = vi.fn(async () => { throw new ApiError({ code, msg: 'Question ended', data: null }); });
    Object.assign(client, { resolveQuestion });
    try {
      controller.handleTranscript(resetEvent('main', emptySnapshot({ interactions: [pending] }), 1));
      flushAll();
      await controller.answerQuestion('q-reply', answers);
      expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({ outcome: { kind } });
      expect(controller.getState().pendingInteraction).toBe('none');
      controller.handleTranscript(opsEvent('main', [{ op: 'meta.merge', meta: { agent: { phase: { kind: 'idle' } } } }], 2));
      flushAll();
      expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({ outcome: { kind } });
      await controller.answerQuestion('q-reply', answers);
      expect(resolveQuestion).toHaveBeenCalledOnce();
    } finally { controller.close(); }
  });

  it.each([
    ['dismissed', null, 'dismissed'],
    ['dismissed', { cancelled: true, reason: 'no_consumer' }, 'cancelled'],
    ['answered', { answers: { 'Pick one': 'No' } }, 'answered'],
  ] as const)('reads the actual %s outcome after a stale answer fails', async (state, response, kind) => {
    const { controller, client, flushAll } = await openController();
    Object.assign(client, { resolveQuestion: vi.fn(async () => { throw new ApiError({ code: API_CODES.QUESTION_NOT_FOUND, msg: 'Not found', data: null }); }) });
    client.getAgentTranscript.mockResolvedValueOnce({ agent_id: 'main', items: [], has_more: false, interactions: [{ ...pending, state, response }] });
    try {
      controller.handleTranscript(resetEvent('main', emptySnapshot({ interactions: [pending] }), 1));
      flushAll();
      await controller.answerQuestion('q-reply', answers);
      const block = controller.getState().blocks.find((entry) => entry.kind === 'question');
      expect(block).toMatchObject({ outcome: { kind } });
      if (kind === 'cancelled') expect(block).toMatchObject({ outcome: { reason: 'no_consumer' } });
      if (kind === 'answered') expect(block).toMatchObject({ outcome: { answers: { q_0: 'No' } } });
    } finally { controller.close(); }
  });

  it('retains a recoverable failure and sends the selected answer on retry to its source session', async () => {
    const { controller, client, flushAll } = await openController();
    const resolveQuestion = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(undefined);
    Object.assign(client, { resolveQuestion });
    try {
      controller.handleTranscript(resetEvent('main', emptySnapshot({ interactions: [pending] }), 1));
      flushAll();
      await expect(controller.answerQuestion('q-reply', answers)).rejects.toThrow('Connection lost');
      expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({ outcome: undefined });
      await controller.answerQuestion('q-reply', answers);
      expect(resolveQuestion).toHaveBeenLastCalledWith('session_test', 'q-reply', { answers, method: 'click' });
      expect(controller.getState().blocks.find((block) => block.kind === 'question')).toMatchObject({ outcome: { kind: 'answered', answers: { q_0: 'Yes' } } });
    } finally { controller.close(); }
  });

  it('settles a question visible only in the focused child view', async () => {
    const { controller, client, flushAll } = await openController();
    Object.assign(client, { resolveQuestion: vi.fn(async () => { throw new ApiError({ code: API_CODES.QUESTION_NOT_FOUND, msg: 'Not found', data: null }); }) });
    try {
      controller.handleTranscript(resetEvent('child', emptySnapshot({ interactions: [{ ...pending, origin: { agentId: 'child' } }] }), 1));
      flushAll();
      await controller.answerQuestion('q-reply', answers);
      expect(controller.getAgentState('child').blocks.find(block => block.kind === 'question')).toMatchObject({ outcome: { kind: 'unavailable' } });
      expect(client.getAgentTranscript).toHaveBeenCalledWith('session_test', 'child', { pageSize: 1 });
    } finally { controller.close(); }
  });

  it('does not submit a question projected from a different source session', async () => {
    const { controller, client, flushAll } = await openController();
    const resolveQuestion = vi.fn();
    Object.assign(client, { resolveQuestion });
    try {
      controller.handleTranscript(resetEvent('main', emptySnapshot({ interactions: [{ ...pending, request: { ...pending.request, session_id: 'session_other' } }] }), 1));
      flushAll();
      await expect(controller.answerQuestion('q-reply', answers)).rejects.toThrow('different session');
      expect(resolveQuestion).not.toHaveBeenCalled();
    } finally { controller.close(); }
  });
});

it('retains the current view and refuses a gap ready cursor while restoring the session baseline', async () => {
  const pending = deferred<SessionSnapshotResponse>();
  const read = vi.fn(async () => snapshot()).mockImplementationOnce(async () => snapshot()).mockImplementationOnce(() => pending.promise);
  const client = { snapshot: read };
  const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
  const controller = new SessionController(client as unknown as KikiClient, fakeView(client, socket), 'session_test');
  try {
    await controller.open();
    const prior = controller.getState();
    controller.handleSignal(sessionViewSignalSchema.parse({ type: 'resyncRequired', reason: 'journal_gap', currentSessionCursor: { seq: 99, epoch: 'epoch-1' }, generation: 1 }));
    expect(controller.getState().resyncing).toBe(true);
    expect(controller.getState().blocks).toEqual(prior.blocks);
    controller.handleSignal({ type: 'ready', generation: 1, currentSessionCursor: { seq: 99, epoch: 'epoch-1' }, reconnected: true });
    expect(controller.getState().cursor.seq).toBe(10);
    pending.resolve(snapshot({ as_of_seq: 99 }));
    await waitFor(() => !controller.getState().resyncing);
    expect(controller.getState().cursor).toEqual({ seq: 99, epoch: 'epoch-1' });
    expect(socket.subscribe).toHaveBeenLastCalledWith('session_test', { seq: 99, epoch: 'epoch-1' }, expect.anything());
  } finally { pending.resolve(snapshot()); controller.close(); }
});
