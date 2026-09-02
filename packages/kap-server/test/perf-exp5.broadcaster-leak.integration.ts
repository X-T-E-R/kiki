import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { IScopeHandle, Scope, SessionActivityState } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  ISessionActivityView,
  ISessionIndex,
  ISessionInteractionService,
  ISessionManager,
  LifecycleScope,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';

type Disposable = { dispose(): void };
type FakeEvent = { type: string; [key: string]: unknown };

type ReflectedState = {
  readonly tail: unknown[];
  readonly targets: Map<BroadcastTarget, unknown>;
  readonly agentDisposables: Map<string, Disposable>;
  readonly lifecycleDisposables: Disposable[];
  queue: Promise<void>;
};

type L1Row = {
  round: number;
  sessionsSize: number;
  tailEntries: number;
  targetSlots: number;
  uniqueTargets: number;
  agentDisposableSlots: number;
  lifecycleDisposableSlots: number;
  closedBusSubscribers: number;
  heapMiB: number;
  heapDeltaMiB: number;
  heapNonDecreasing: boolean;
};

class ListenerSet<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(event: T): number {
    const snapshot = [...this.listeners];
    for (const listener of snapshot) listener(event);
    return snapshot.length;
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}

class FakeAgentBus {
  private readonly all = new ListenerSet<FakeEvent>();

  subscribe(listener: (event: FakeEvent) => void): Disposable;
  subscribe(type: string, listener: (event: FakeEvent) => void): Disposable;
  subscribe(typeOrListener: string | ((event: FakeEvent) => void), listener?: (event: FakeEvent) => void) {
    if (typeof typeOrListener === 'function') return this.all.subscribe(typeOrListener);
    return { dispose: () => void listener };
  }

  emit(event: FakeEvent): number {
    return this.all.fire(event);
  }

  dispose(): void {
    this.all.clear();
  }

  get subscriberCount(): number {
    return this.all.size;
  }
}

class FakeAgentHandle {
  readonly kind = LifecycleScope.Agent;
  readonly bus = new FakeAgentBus();
  readonly accessor = {
    get: (token: unknown) => (token === IEventBus ? this.bus : undefined),
  };

  constructor(readonly id: string) {}

  dispose(): void {
    this.bus.dispose();
  }
}

class FakeAgentLifecycle {
  private readonly handles = new Map<string, FakeAgentHandle>();
  private readonly created = new ListenerSet<IScopeHandle>();
  private readonly disposed = new ListenerSet<string>();

  list(): readonly FakeAgentHandle[] {
    return [...this.handles.values()];
  }

  get(id: string): FakeAgentHandle | undefined {
    return this.handles.get(id);
  }

  onDidCreate(listener: (handle: IScopeHandle) => void): Disposable {
    return this.created.subscribe(listener);
  }

  onDidDispose(listener: (agentId: string) => void): Disposable {
    return this.disposed.subscribe(listener);
  }

  add(id = MAIN_AGENT_ID): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    this.handles.set(id, handle);
    this.created.fire(handle as unknown as IScopeHandle);
    return handle;
  }

  async remove(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (handle === undefined) return;
    this.handles.delete(id);
    handle.dispose();
    this.disposed.fire(id);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.handles.keys()]) await this.remove(id);
  }

  dispose(): void {
    this.created.clear();
    this.disposed.clear();
  }
}

class FakeWorkView {
  private readonly changed = new ListenerSet<unknown>();

  state(): SessionActivityState {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
    };
  }

  onDidChange(listener: (event: unknown) => void): Disposable {
    return this.changed.subscribe(listener);
  }

  dispose(): void {
    this.changed.clear();
  }
}

class FakeInteractions {
  private readonly pendingChanged = new ListenerSet<unknown>();
  private readonly resolved = new ListenerSet<unknown>();
  readonly acquiredConsumerIds: string[] = [];
  readonly releasedConsumerIds: string[] = [];
  readonly consumerIds = new Set<string>();

  acquireConsumer(id: string): void {
    this.acquiredConsumerIds.push(id);
    this.consumerIds.add(id);
  }

  releaseConsumer(id: string): void {
    this.releasedConsumerIds.push(id);
    this.consumerIds.delete(id);
  }

  hasConsumer(): boolean {
    return this.consumerIds.size > 0;
  }

  listPending(): never[] {
    return [];
  }

  onDidChangePending(listener: (event: unknown) => void): Disposable {
    return this.pendingChanged.subscribe(listener);
  }

  onDidResolve(listener: (event: unknown) => void): Disposable {
    return this.resolved.subscribe(listener);
  }

  dispose(): void {
    this.pendingChanged.clear();
    this.resolved.clear();
  }
}

class FakeSession {
  readonly kind = LifecycleScope.Session;
  readonly agents = new FakeAgentLifecycle();
  readonly workView = new FakeWorkView();
  readonly interactions = new FakeInteractions();
  readonly accessor = {
    get: (token: unknown) => {
      if (token === IAgentLifecycleService) return this.agents;
      if (token === ISessionActivityView) return this.workView;
      if (token === ISessionInteractionService) return this.interactions;
      return undefined;
    },
  };

  constructor(readonly id: string) {}

  async close(): Promise<void> {
    await this.agents.closeAll();
    this.workView.dispose();
    this.interactions.dispose();
    this.agents.dispose();
  }

  dispose(): void {}
}

class FakeCoreEvents {
  private readonly events = new ListenerSet<{ type: string; payload: unknown }>();

  subscribe(listener: (event: { type: string; payload: unknown }) => void): Disposable {
    return this.events.subscribe(listener);
  }
}

class FakeSessionHost {
  readonly live = new Map<string, FakeSession>();
  private readonly known = new Set<string>();
  private readonly created = new ListenerSet<{
    sessionId: string;
    handle: FakeSession;
    source: 'create';
  }>();
  private readonly closed = new ListenerSet<{ sessionId: string }>();
  private readonly archived = new ListenerSet<{ sessionId: string }>();

  create(sessionId: string): { session: FakeSession; main: FakeAgentHandle } {
    const session = new FakeSession(sessionId);
    const main = session.agents.add();
    this.known.add(sessionId);
    this.live.set(sessionId, session);
    this.created.fire({ sessionId, handle: session, source: 'create' });
    return { session, main };
  }

  get(sessionId: string): FakeSession | undefined {
    return this.live.get(sessionId);
  }

  list(): readonly FakeSession[] {
    return [...this.live.values()];
  }

  has(sessionId: string): boolean {
    return this.known.has(sessionId);
  }

  onDidCreateSession(
    listener: (event: { sessionId: string; handle: FakeSession; source: 'create' }) => void,
  ): Disposable {
    return this.created.subscribe(listener);
  }

  onDidCloseSession(listener: (event: { sessionId: string }) => void): Disposable {
    return this.closed.subscribe(listener);
  }

  onDidArchiveSession(listener: (event: { sessionId: string }) => void): Disposable {
    return this.archived.subscribe(listener);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (session === undefined) return;
    this.live.delete(sessionId);
    await session.close();
    this.closed.fire({ sessionId });
  }
}

class CountingTarget implements BroadcastTarget {
  sends = 0;

  send(): void {
    this.sends += 1;
  }

  reset(): void {
    this.sends = 0;
  }
}

function makeCore(host: FakeSessionHost): Scope {
  const coreEvents = new FakeCoreEvents();
  const sessionManager = {
    _serviceBrand: undefined,
    get: (sessionId: string) => host.get(sessionId),
    list: () => host.list(),
    onDidCreateSession: (
      listener: (event: { sessionId: string; handle: FakeSession; source: 'create' }) => void,
    ) => host.onDidCreateSession(listener),
    onDidCloseSession: (listener: (event: { sessionId: string }) => void) =>
      host.onDidCloseSession(listener),
    onDidArchiveSession: (listener: (event: { sessionId: string }) => void) =>
      host.onDidArchiveSession(listener),
  } as unknown as ISessionManager;
  const sessionIndex = {
    _serviceBrand: undefined,
    get: async (sessionId: string) =>
      host.has(sessionId)
        ? {
            id: sessionId,
            workspaceId: 'perf-workspace',
            cwd: '/perf-workspace',
            createdAt: 1,
            updatedAt: 1,
            archived: false,
          }
        : undefined,
  } as unknown as ISessionIndex;
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === IEventService) return coreEvents;
        if (token === ISessionManager) return sessionManager;
        if (token === ISessionIndex) return sessionIndex;
        return undefined;
      },
    },
  } as unknown as Scope;
}

async function createHarness(maxBufferSize = 1000) {
  const dir = await mkdtemp(join(tmpdir(), 'kiki-exp5-broadcaster-'));
  const host = new FakeSessionHost();
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: dir,
    core: makeCore(host),
    maxBufferSize,
  });
  return {
    dir,
    host,
    broadcaster,
    async close() {
      await broadcaster.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function statesOf(broadcaster: SessionEventBroadcaster): Map<string, ReflectedState> {
  return (broadcaster as unknown as { sessions: Map<string, ReflectedState> }).sessions;
}

function allTargetSlots(broadcaster: SessionEventBroadcaster): BroadcastTarget[] {
  const reflected = broadcaster as unknown as { allTargets(): Iterable<BroadcastTarget> };
  return [...reflected.allTargets()];
}

function event(type: string, fields: Record<string, unknown> = {}): FakeEvent {
  return { type, ...fields };
}

async function forceGcAndReadHeap(): Promise<number> {
  const gc = globalThis.gc;
  if (gc !== undefined) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
  }
  return process.memoryUsage().heapUsed;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function benchmarkAgentPath(
  broadcaster: SessionEventBroadcaster,
  main: FakeAgentHandle,
  repeats: number,
  samples: number,
): Promise<{ medianMs: number; callbackCount: number }> {
  for (let i = 0; i < 200; i++) main.bus.emit(event('assistant.delta', { delta: 'x' }));
  await broadcaster.getCursor('active');

  const durations: number[] = [];
  let callbackCount = 0;
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < repeats; i++) {
      callbackCount += main.bus.emit(event('assistant.delta', { delta: 'x' }));
    }
    await broadcaster.getCursor('active');
    durations.push(performance.now() - start);
  }
  return { medianMs: median(durations), callbackCount };
}

function benchmarkGlobalDispatch(
  broadcaster: SessionEventBroadcaster,
  target: CountingTarget,
  repeats: number,
  samples: number,
): { medianMs: number; sendsPerEvent: number; scannedTargetSlots: number } {
  const state = statesOf(broadcaster).get('active');
  if (state === undefined) throw new Error('active state was not created');
  const dispatch = (
    broadcaster as unknown as {
      dispatch(state: ReflectedState, event: FakeEvent, volatile: boolean): Promise<void>;
    }
  ).dispatch.bind(broadcaster);
  const globalEvent = {
    type: 'event.session.work_changed',
    busy: false,
    agentId: MAIN_AGENT_ID,
    sessionId: 'active',
  };

  for (let i = 0; i < 200; i++) void dispatch(state, globalEvent, true);
  const durations: number[] = [];
  let sendsPerEvent = 0;
  for (let sample = 0; sample < samples; sample++) {
    target.reset();
    const start = performance.now();
    for (let i = 0; i < repeats; i++) void dispatch(state, globalEvent, true);
    durations.push(performance.now() - start);
    sendsPerEvent = target.sends / repeats;
  }
  return {
    medianMs: median(durations),
    sendsPerEvent,
    scannedTargetSlots: allTargetSlots(broadcaster).length,
  };
}

function benchmarkAllTargetsScan(
  broadcaster: SessionEventBroadcaster,
  repeats: number,
  samples: number,
): number {
  const reflected = broadcaster as unknown as { allTargets(): Iterable<BroadcastTarget> };
  const durations: number[] = [];
  let recipientCount = 0;
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < repeats; i++) {
      const recipients = new Set<BroadcastTarget>();
      for (const target of reflected.allTargets()) recipients.add(target);
      recipientCount += recipients.size;
    }
    durations.push(performance.now() - start);
  }
  if (recipientCount === 0) throw new Error('allTargets scan produced no recipients');
  return median(durations);
}

async function addClosedSessions(
  harness: Awaited<ReturnType<typeof createHarness>>,
  count: number,
  target: CountingTarget,
  durableEventsPerSession: number,
  firstIndex = 1,
): Promise<FakeAgentBus[]> {
  const closedBuses: FakeAgentBus[] = [];
  for (let offset = 0; offset < count; offset++) {
    const sessionId = `closed-${String(firstIndex + offset)}`;
    const { session, main } = harness.host.create(sessionId);
    closedBuses.push(main.bus);
    expect(await harness.broadcaster.subscribe(sessionId, target)).toBe(true);
    expect(session.interactions.acquiredConsumerIds).toHaveLength(1);
    expect(session.interactions.consumerIds).toEqual(
      new Set(session.interactions.acquiredConsumerIds),
    );
    for (let n = 0; n < durableEventsPerSession; n++) {
      main.bus.emit(event('turn.started', { turnId: n }));
    }
    await harness.broadcaster.getCursor(sessionId);
    await harness.host.close(sessionId);
    await harness.broadcaster.getCursor(sessionId);
    expect(session.interactions.releasedConsumerIds).toEqual(
      session.interactions.acquiredConsumerIds,
    );
    expect(session.interactions.consumerIds).toEqual(new Set());
  }
  return closedBuses;
}

describe('perf experiment 5: SessionEventBroadcaster close eviction', () => {
  it(
    'L1 verifies closed states, tails, target slots, and listeners are evicted',
    async () => {
      const harness = await createHarness(1000);
      const target = new CountingTarget();
      const rows: L1Row[] = [];
      try {
        const baselineHeap = await forceGcAndReadHeap();
        let previousHeap = baselineHeap;
        for (let i = 1; i <= 20; i++) {
          const [closedBus] = await addClosedSessions(harness, 1, target, 1000, i);
          const states = [...statesOf(harness.broadcaster).values()];
          const heap = await forceGcAndReadHeap();
          rows.push({
            round: i,
            sessionsSize: states.length,
            tailEntries: states.reduce((total, state) => total + state.tail.length, 0),
            targetSlots: states.reduce((total, state) => total + state.targets.size, 0),
            uniqueTargets: new Set(states.flatMap((state) => [...state.targets.keys()])).size,
            agentDisposableSlots: states.reduce(
              (total, state) => total + state.agentDisposables.size,
              0,
            ),
            lifecycleDisposableSlots: states.reduce(
              (total, state) => total + state.lifecycleDisposables.length,
              0,
            ),
            closedBusSubscribers: closedBus?.subscriberCount ?? -1,
            heapMiB: Number((heap / 1024 / 1024).toFixed(3)),
            heapDeltaMiB: Number(((heap - baselineHeap) / 1024 / 1024).toFixed(3)),
            heapNonDecreasing: heap >= previousHeap,
          });
          previousHeap = heap;
        }

        const heapNonDecreasingSteps = rows.filter((row) => row.heapNonDecreasing).length;
        const summary = {
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          gcExposed: globalThis.gc !== undefined,
          baselineHeapMiB: Number((baselineHeap / 1024 / 1024).toFixed(3)),
          finalHeapDeltaMiB: rows.at(-1)?.heapDeltaMiB,
          heapNonDecreasingSteps,
          rows,
        };
        console.table(rows);
        console.log(`EXP5_L1 ${JSON.stringify(summary)}`);

        expect(statesOf(harness.broadcaster).size).toBe(0);
        expect(rows.every((row) => row.sessionsSize === 0)).toBe(true);
        expect(rows.every((row) => row.tailEntries === 0)).toBe(true);
        expect(rows.every((row) => row.targetSlots === 0)).toBe(true);
        expect(rows.every((row) => row.uniqueTargets === 0)).toBe(true);
        expect(rows.every((row) => row.agentDisposableSlots === 0)).toBe(true);
        expect(rows.every((row) => row.lifecycleDisposableSlots === 0)).toBe(true);
        expect(rows.every((row) => row.closedBusSubscribers === 0)).toBe(true);
      } finally {
        await harness.close();
      }
    },
    120_000,
  );

  it(
    'L2 keeps local dispatch and global target scanning flat after 20 closes',
    async () => {
      const baseline = await createHarness();
      const retained = await createHarness();
      try {
        const baselineTarget = new CountingTarget();
        const retainedTarget = new CountingTarget();
        const baselineActive = baseline.host.create('active').main;
        const retainedActive = retained.host.create('active').main;
        expect(await baseline.broadcaster.subscribe('active', baselineTarget)).toBe(true);
        expect(await retained.broadcaster.subscribe('active', retainedTarget)).toBe(true);
        const closedBuses = await addClosedSessions(retained, 20, retainedTarget, 1);

        const baselineAgent = await benchmarkAgentPath(
          baseline.broadcaster,
          baselineActive,
          3000,
          7,
        );
        const retainedAgent = await benchmarkAgentPath(
          retained.broadcaster,
          retainedActive,
          3000,
          7,
        );
        const baselineGlobal = benchmarkGlobalDispatch(
          baseline.broadcaster,
          baselineTarget,
          10_000,
          7,
        );
        const retainedGlobal = benchmarkGlobalDispatch(
          retained.broadcaster,
          retainedTarget,
          10_000,
          7,
        );
        const baselineAllTargetsScanMs = benchmarkAllTargetsScan(
          baseline.broadcaster,
          100_000,
          7,
        );
        const retainedAllTargetsScanMs = benchmarkAllTargetsScan(
          retained.broadcaster,
          100_000,
          7,
        );
        const deadAgentSubscribers = closedBuses.reduce(
          (total, bus) => total + bus.subscriberCount,
          0,
        );
        const deadAgentCallbacks = closedBuses.reduce(
          (total, bus) => total + bus.emit(event('assistant.delta', { delta: 'probe' })),
          0,
        );

        const results = {
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          baseline: {
            broadcasterStates: statesOf(baseline.broadcaster).size,
            agentMedianMs: Number(baselineAgent.medianMs.toFixed(3)),
            agentCallbacks: baselineAgent.callbackCount,
            globalMedianMs: Number(baselineGlobal.medianMs.toFixed(3)),
            allTargetsScanMedianMs: Number(baselineAllTargetsScanMs.toFixed(3)),
            globalScannedTargetSlots: baselineGlobal.scannedTargetSlots,
            globalSendsPerEvent: baselineGlobal.sendsPerEvent,
          },
          after20Closed: {
            broadcasterStates: statesOf(retained.broadcaster).size,
            agentMedianMs: Number(retainedAgent.medianMs.toFixed(3)),
            agentCallbacks: retainedAgent.callbackCount,
            deadAgentSubscribers,
            deadAgentCallbacks,
            globalMedianMs: Number(retainedGlobal.medianMs.toFixed(3)),
            allTargetsScanMedianMs: Number(retainedAllTargetsScanMs.toFixed(3)),
            globalScannedTargetSlots: retainedGlobal.scannedTargetSlots,
            globalSendsPerEvent: retainedGlobal.sendsPerEvent,
          },
        };
        console.log(`EXP5_L2 ${JSON.stringify(results)}`);

        expect(statesOf(retained.broadcaster).size).toBe(1);
        expect(deadAgentSubscribers).toBe(0);
        expect(deadAgentCallbacks).toBe(0);
        expect(baselineAgent.callbackCount).toBe(3000 * 7);
        expect(retainedAgent.callbackCount).toBe(3000 * 7);
        expect(baselineGlobal.scannedTargetSlots).toBe(1);
        expect(retainedGlobal.scannedTargetSlots).toBe(1);
        expect(baselineGlobal.sendsPerEvent).toBe(1);
        expect(retainedGlobal.sendsPerEvent).toBe(1);
      } finally {
        await baseline.close();
        await retained.close();
      }
    },
    120_000,
  );
});
