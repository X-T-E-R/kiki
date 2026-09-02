import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import {
  interactionKey,
  InteractionRequestEvent,
  InteractionResolvedEvent,
} from '#/session/interaction/interactionOps';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

interface RecordedEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly dispatched: RecordedEvent[];
}

function makeFakeAgent(agentId: string): FakeAgent {
  const dispatched: RecordedEvent[] = [];
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: (event: RecordedEvent) => {
      dispatched.push(event);
      return Promise.resolve();
    },
  } as unknown as IEventDispatcher;
  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IEventDispatcher) return dispatcher as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };
  return {
    handle: { id: agentId, kind: LifecycleScope.Agent, accessor, dispose: () => {} },
    dispatched,
  };
}

function payloadOf(event: RecordedEvent): Record<string, unknown> {
  const { type: _type, time: _time, ...payload } = event;
  return payload;
}

describe('SessionInteractionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Map<string, FakeAgent>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = new Map();
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: Event.None,
      onDidDispose: Event.None,
      list: () => [],
      get: (id: string) => agents.get(id)?.handle,
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  });
  afterEach(() => disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('rejects a duplicate pending id without replacing the original request', async () => {
    const svc = ix.get(ISessionInteractionService);
    const original = svc.request<unknown, string>({
      id: 'tool-1',
      kind: 'approval',
      payload: { request: 'original' },
    });
    const duplicate = svc.request({
      id: 'tool-1',
      kind: 'approval',
      payload: { request: 'duplicate' },
    });

    await expect(duplicate).rejects.toThrow('Interaction "tool-1" is already pending');
    expect(svc.listPending()).toHaveLength(1);
    expect(svc.listPending()[0]?.payload).toEqual({ request: 'original' });

    svc.respond('tool-1', 'approved');
    await expect(original).resolves.toBe('approved');
  });

  it('throws when enqueue reuses a pending id', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'tool-1', kind: 'approval', payload: {} });

    expect(() => svc.enqueue({ id: 'tool-1', kind: 'question', payload: {} })).toThrow(
      'Interaction "tool-1" is already pending',
    );
    expect(svc.listPending()).toHaveLength(1);
  });

  it('generates an id that does not collide with an explicit pending id', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'interaction-0', kind: 'approval', payload: {} });

    const generated = svc.enqueue({ kind: 'question', payload: {} });

    expect(generated.id).toBe('interaction-1');
    expect(svc.listPending().map((interaction) => interaction.id)).toEqual([
      'interaction-0',
      'interaction-1',
    ]);
  });

  it('listPending filters by kind', () => {
    const svc = ix.get(ISessionInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('listPending filters by origin fields', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'child-a', turnId: 1 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'child-a', turnId: 2 } });
    svc.enqueue({ id: 'b1', kind: 'approval', payload: {}, origin: { agentId: 'child-b', turnId: 1 } });
    svc.enqueue({ id: 'q1', kind: 'question', payload: {}, origin: { agentId: 'child-a', turnId: 1 } });

    expect(svc.listPending(undefined, { agentId: 'child-a' }).map((entry) => entry.id)).toEqual([
      'a1',
      'a2',
      'q1',
    ]);
    expect(svc.listPending('approval', { turnId: 1 }).map((entry) => entry.id)).toEqual([
      'a1',
      'b1',
    ]);
    expect(svc.listPending('approval', { agentId: 'child-a', turnId: 2 }).map((entry) => entry.id)).toEqual([
      'a2',
    ]);
  });

  it('defaults consumer coverage to the whole session', async () => {
    const svc = ix.get(ISessionInteractionService);
    expect(svc.hasConsumer()).toBe(false);
    svc.acquireConsumer('gui');
    expect(svc.hasConsumer()).toBe(true);
    expect(svc.hasConsumer({})).toBe(true);
    expect(svc.hasConsumer({ agentId: 'child-a' })).toBe(true);

    const main = svc.request<unknown, { decision: string }>({ id: 'main', kind: 'approval', payload: {} });
    const child = svc.request<unknown, { decision: string }>({
      id: 'child',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'child-a' },
    });
    svc.releaseConsumer('gui');

    await expect(main).resolves.toEqual({ decision: 'cancelled' });
    await expect(child).resolves.toEqual({ decision: 'cancelled' });
    expect(svc.hasConsumer()).toBe(false);
  });

  it('scoped consumer coverage follows live agent subtrees', () => {
    const svc = ix.get(ISessionInteractionService);
    const roots = new Set(['child-a']);
    const parents = new Map([['grandchild-a', 'child-a']]);
    svc.acquireConsumer('external-root', {
      kind: 'agent_subtrees',
      roots: () => roots,
      parent: (agentId) => parents.get(agentId),
    });

    expect(svc.hasConsumer()).toBe(true);
    expect(svc.hasConsumer({ agentId: 'child-a' })).toBe(true);
    expect(svc.hasConsumer({ agentId: 'grandchild-a' })).toBe(true);
    expect(svc.hasConsumer({ agentId: 'child-b' })).toBe(false);
    expect(svc.hasConsumer({})).toBe(false);
    roots.add('child-b');
    expect(svc.hasConsumer({ agentId: 'child-b' })).toBe(true);
  });

  it('releasing scoped consumers cancels only approvals without remaining coverage', async () => {
    const svc = ix.get(ISessionInteractionService);
    const wideRoots = new Set(['child-a', 'child-b']);
    const childB = new Set(['child-b']);
    svc.acquireConsumer('wide', {
      kind: 'agent_subtrees',
      roots: () => wideRoots,
      parent: () => undefined,
    });
    svc.acquireConsumer('child-b', {
      kind: 'agent_subtrees',
      roots: () => childB,
      parent: () => undefined,
    });
    const pendingA = svc.request<unknown, { decision: string }>({
      id: 'a',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'child-a' },
    });
    const pendingB = svc.request<unknown, { decision: string }>({
      id: 'b',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'child-b' },
    });
    const pendingMain = svc.request<unknown, { decision: string }>({
      id: 'main',
      kind: 'approval',
      payload: {},
    });

    svc.releaseConsumer('wide');

    await expect(pendingA).resolves.toEqual({ decision: 'cancelled' });
    await expect(pendingMain).resolves.toEqual({ decision: 'cancelled' });
    expect(svc.listPending('approval').map((entry) => entry.id)).toEqual(['b']);

    svc.releaseConsumer('child-b');
    await expect(pendingB).resolves.toEqual({ decision: 'cancelled' });
    expect(svc.listPending()).toEqual([]);
  });

  it('whole-session coverage prevents scoped release from cancelling pending approvals', async () => {
    const svc = ix.get(ISessionInteractionService);
    const roots = new Set(['child-a']);
    svc.acquireConsumer('gui');
    svc.acquireConsumer('external-root', {
      kind: 'agent_subtrees',
      roots: () => roots,
      parent: () => undefined,
    });
    const child = svc.request<unknown, { decision: string }>({
      id: 'child',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'child-a' },
    });
    const main = svc.request<unknown, { decision: string }>({ id: 'main', kind: 'approval', payload: {} });

    svc.releaseConsumer('external-root');
    expect(svc.listPending('approval').map((entry) => entry.id)).toEqual(['child', 'main']);

    svc.releaseConsumer('gui');
    await expect(child).resolves.toEqual({ decision: 'cancelled' });
    await expect(main).resolves.toEqual({ decision: 'cancelled' });
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidChangePending(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = ix.get(ISessionInteractionService);
    const snapshots: (readonly string[])[] = [];
    disposables.add(svc.onDidChangePending((e) => snapshots.push(e.pending)));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ix.get(ISessionInteractionService);
    expect(() => svc.respond('nope', 'x')).not.toThrow();
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidResolve(() => count++));
    svc.respond('nope', 'x');
    expect(count).toBe(0);
  });

  it('cancelPendingForTurn clears pending interactions whose turn has ended (矛盾 c)', () => {
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('cancelPendingForTurn resolves cancelled interactions through onDidResolve', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('cancelPendingForTurn is a no-op when no interaction matches', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 1 } });
    expect(() => svc.cancelPendingForTurn(99)).not.toThrow();
    expect(svc.listPending()).toHaveLength(1);
  });

  it('request journals an interaction.request op to the origin agent wire', () => {
    const sub = makeFakeAgent('agent-1');
    agents.set('agent-1', sub);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
      origin: { agentId: 'agent-1', turnId: 2 },
    });

    expect(sub.dispatched.map((event) => ({ type: event.type, payload: payloadOf(event) }))).toEqual([
      {
        type: 'interaction.request',
        payload: {
          id: 'i1',
          kind: 'approval',
          toolCallId: 'call-1',
          agentId: 'agent-1',
          origin: { agentId: 'agent-1', turnId: 2 },
          request: { toolCallId: 'call-1', toolName: 'Bash' },
        },
      },
    ]);
  });

  it('journals to the main agent wire when the origin has no agentId', () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'i1', kind: 'question', payload: { question: '?' } });

    expect(main.dispatched.map((event) => ({ type: event.type, payload: payloadOf(event) }))).toEqual([
      {
        type: 'interaction.request',
        payload: {
          id: 'i1',
          kind: 'question',
          toolCallId: undefined,
          agentId: undefined,
          origin: {},
          request: { question: '?' },
        },
      },
    ]);
  });

  it('respond journals an interaction.resolved op to the same wire', async () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    const pending = svc.request({ id: 'i1', kind: 'approval', payload: {} });
    svc.respond('i1', { decision: 'approved' });
    await pending;

    expect(main.dispatched.map((event) => event.type)).toEqual([
      'interaction.request',
      'interaction.resolved',
    ]);
    expect(payloadOf(main.dispatched[1]!)).toEqual({
      id: 'i1',
      response: { decision: 'approved' },
    });
  });

  it('cancelPendingForTurn journals the cancellation as interaction.resolved', () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'i1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    const last = main.dispatched.at(-1);
    expect(last?.type).toBe('interaction.resolved');
    expect(last === undefined ? undefined : payloadOf(last)).toEqual({ id: 'i1', response: { cancelled: true, reason: 'turn_ended' } });
  });

  it('kernel semantics are unchanged when the origin agent is absent', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request<unknown, string>({ kind: 'question', payload: {} });
    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });
});

describe('interaction ops (wire-backed)', () => {
  const SCOPE = 'wire';
  const KEY = 'interaction-test';

  let disposables: DisposableStore;
  let dispatcher: IEventDispatcher;
  let agentState: IAgentStateService;
  let log: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
    dispatcher = registerTestEventDispatcher(ix);
    agentState = ix.get(IAgentStateService);
    agentState.contributeState(interactionKey);
  });
  afterEach(() => disposables.dispose());

  async function readRecords(key = KEY): Promise<WireRecord[]> {
    await dispatcher.flush();
    const out: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
      out.push(record);
    }
    return out;
  }

  it('request/resolved persist to the journal and fold into the model by id', async () => {
    await dispatcher.dispatch(
      new InteractionRequestEvent({
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'main',
        request: { toolCallId: 'call-1' },
      }),
    );
    await dispatcher.dispatch(new InteractionResolvedEvent({ id: 'i1', response: { decision: 'approved' } }));

    const entry = agentState.get(interactionKey).get('i1');
    expect(entry).toMatchObject({
      id: 'i1',
      kind: 'approval',
      toolCallId: 'call-1',
      agentId: 'main',
      resolved: true,
      response: { decision: 'approved' },
    });

    expect(await readRecords()).toEqual([
      {
        type: 'interaction.request',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'main',
        request: { toolCallId: 'call-1' },
        time: expect.any(Number),
      },
      {
        type: 'interaction.resolved',
        id: 'i1',
        response: { decision: 'approved' },
        time: expect.any(Number),
      },
    ]);
  });

  it('resolved without a known request leaves the model unchanged', async () => {
    const before = agentState.get(interactionKey);
    await dispatcher.dispatch(new InteractionResolvedEvent({ id: 'ghost', response: {} }));
    expect(agentState.get(interactionKey)).toBe(before);
  });

  it('replay rebuilds the interaction map from persisted records', async () => {
    const records: WireRecord[] = [
      { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: '?' } },
      { type: 'interaction.resolved', id: 'i1', response: { answer: 'a' } },
      { type: 'interaction.request', id: 'i2', kind: 'approval', toolCallId: 'call-2', request: {} },
    ] as unknown as WireRecord[];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    registerTestAgentWire(ix2, testWireScope(SCOPE, 'interaction-replay'), {
      log: log2,
    });
    const dispatcher2 = registerTestEventDispatcher(ix2);
    const agentState2 = ix2.get(IAgentStateService);
    agentState2.contributeState(interactionKey);
    await restoreTestEventDispatcher(dispatcher2, log2, testWireScope(SCOPE, 'interaction-replay'), records);

    const model = agentState2.get(interactionKey);
    expect(model.size).toBe(2);
    expect(model.get('i1')).toMatchObject({ resolved: true, response: { answer: 'a' } });
    expect(model.get('i2')).toMatchObject({ resolved: false, toolCallId: 'call-2' });
  });
});
