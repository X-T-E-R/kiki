import '#/agent/pluginState/pluginStateAssembly';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ContextAppendMessage, ContextClear, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { contextMemoryKey, contextRevisionKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPluginStateService, IPluginStateRegistryService } from '#/agent/pluginState/pluginState';
import type { PluginStateJsonObject, PluginStateJsonValue, PluginStateReducerSpec } from '#/agent/pluginState/pluginState';
import { MAX_PLUGIN_STATE_BYTES, pluginConversationStateKey, pluginWorldStateKey } from '#/agent/pluginState/pluginStateKeys';
import { AgentPluginStateService, PluginStateRegistryService } from '#/agent/pluginState/pluginStateService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { decodeReplayCheckpointGraph, encodeReplayCheckpointGraph, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { IWireService, type WireJournalReadOptions } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { WireService } from '#/wire/wireService';

const PLUGIN_ID = 'test-plugin';
const SCOPE = 'sessions/test-session/agents/main';
const CHECKPOINT_SCOPE = `${SCOPE}/replay-checkpoints`;
const CHECKPOINT_KEY = 'engine-v1';
const PLUGIN_STATE_NAMES = new Set([pluginConversationStateKey.name, pluginWorldStateKey.name]);

interface Harness {
  readonly storage: InMemoryStorageService;
  readonly docs: IAtomicDocumentStore;
  readonly wire: IWireService;
  readonly dispatcher: IEventDispatcher;
  readonly state: IAgentStateService;
  readonly pluginState: IAgentPluginStateService;
  readonly registry: IPluginStateRegistryService;
}

interface CheckpointEnvelope {
  stateNames: string[];
  pluginInterpretation?: readonly unknown[];
  graph: ReplayCheckpointGraph;
}

const noopLogger: ILogService = {
  _serviceBrand: undefined,
  level: 'off',
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
  setLevel: () => {},
  flush: async () => {},
};

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(async () => {
  await disposables.dispose();
});

function harness(storage = new InMemoryStorageService()): Harness {
  const ix = disposables.add(new TestInstantiationService());
  ix.set(IFileSystemStorageService, storage);
  ix.set(ILogService, noopLogger);
  ix.set(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId: 'main',
    scope: (subKey?: string) => subKey === undefined || subKey === '' ? SCOPE : `${SCOPE}/${subKey}`,
  });
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IWireService, new SyncDescriptor(WireService));
  ix.set(IPluginStateRegistryService, new SyncDescriptor(PluginStateRegistryService));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  ix.set(IAgentPluginStateService, new SyncDescriptor(AgentPluginStateService));
  const state = ix.get(IAgentStateService);
  state.contributeState(contextMemoryKey);
  state.contributeState(contextRevisionKey);
  const pluginState = ix.get(IAgentPluginStateService);
  return {
    storage,
    docs: ix.get(IAtomicDocumentStore),
    wire: ix.get(IWireService),
    dispatcher: ix.get(IEventDispatcher),
    state,
    pluginState,
    registry: ix.get(IPluginStateRegistryService),
  };
}

function reducerSpec(
  clock: 'conversation' | 'world',
  reducerVersion = 1,
  multiplier = 1,
  requiredForModel = false,
): PluginStateReducerSpec<{ total: number }> {
  return {
    pluginId: PLUGIN_ID,
    clock,
    schemaVersion: 1,
    reducerVersion,
    requiredForModel,
    initial: () => ({ total: 0 }),
    reduce: (state, _factType, payload) => ({ total: state.total + numberValue(payload) * multiplier }),
  };
}

function isPluginJsonObject(value: PluginStateJsonValue): value is PluginStateJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(payload: PluginStateJsonValue): number {
  if (!isPluginJsonObject(payload) || typeof payload['value'] !== 'number') {
    throw new Error('Expected a numeric plugin fact value.');
  }
  return payload['value'];
}

function registerReducers(
  target: Harness,
  options: { readonly conversationRequired?: boolean; readonly worldRequired?: boolean } = {},
): IDisposable[] {
  return [
    disposables.add(target.registry.registerReducer(reducerSpec('conversation', 1, 1, options.conversationRequired))),
    disposables.add(target.registry.registerReducer(reducerSpec('world', 1, 1, options.worldRequired))),
  ];
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

async function appendUserAnchors(target: Harness, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await target.dispatcher.dispatch(new ContextAppendMessage({ message: userMessage(`anchor-${index}`) }));
  }
}

async function initialize(target: Harness, seal = false): Promise<void> {
  if (seal) await target.wire.seal();
  await target.dispatcher.restore();
}

function watchReads(wire: IWireService): { readonly full: () => number; readonly tails: () => readonly number[] } {
  let full = 0;
  const tails: number[] = [];
  const original = wire.readJournal.bind(wire);
  wire.readJournal = (options?: WireJournalReadOptions) => {
    if (options?.startByte !== undefined && options.startByte > 0) tails.push(options.startByte);
    else full += 1;
    return original(options);
  };
  return { full: () => full, tails: () => tails };
}

async function readJournal(wire: IWireService): Promise<WireRecord[]> {
  const records: WireRecord[] = [];
  for await (const record of wire.readJournal()) records.push(record);
  return records;
}

function snapshot(target: Harness) {
  return {
    conversation: target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'conversation'),
    world: target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'world'),
    context: target.state.get(contextMemoryKey).map((message) => message.content.map((part) => part.type === 'text' ? part.text : '').join('')),
  };
}

async function recordConversationAndWorldFacts(target: Harness): Promise<void> {
  for (const round of [
    { factType: 'round-18', conversation: 2, world: 11 },
    { factType: 'round-19', conversation: 3, world: 17 },
    { factType: 'round-20', conversation: 5, world: 23 },
  ]) {
    await target.pluginState.recordFact({
      pluginId: PLUGIN_ID,
      clock: 'conversation',
      factType: round.factType,
      payload: { value: round.conversation },
    });
    await target.pluginState.recordFact({
      pluginId: PLUGIN_ID,
      clock: 'world',
      factType: round.factType,
      payload: { value: round.world },
    });
  }
}

describe('AgentPluginStateService', () => {
  it('undoes the last three anchored rounds after late plugin registration while preserving world facts and replay state', async () => {
    const storage = new InMemoryStorageService();
    const live = harness(storage);
    await initialize(live, true);
    await appendUserAnchors(live, 20);
    expect(live.state.get(contextMemoryKey)).toHaveLength(20);
    expect(live.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(20);

    const registrations = registerReducers(live, { conversationRequired: true });
    expect(live.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(20);
    await recordConversationAndWorldFacts(live);
    expect(live.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(20);
    expect(live.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'conversation')).toEqual({ total: 10 });
    expect(live.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'world')).toEqual({ total: 51 });
    const roundFacts = (await readJournal(live.wire)).filter((record) => record.type === 'plugin.fact_recorded');
    expect(roundFacts.map((record) => [record['clock'], record['factType']])).toEqual([
      ['conversation', 'round-18'],
      ['world', 'round-18'],
      ['conversation', 'round-19'],
      ['world', 'round-19'],
      ['conversation', 'round-20'],
      ['world', 'round-20'],
    ]);

    await live.dispatcher.dispatchDurably(new ContextUndo({ count: 3 }));

    expect(live.state.get(contextMemoryKey)).toHaveLength(17);
    expect(live.state.get(contextMemoryKey).at(-1)).toEqual(userMessage('anchor-16'));
    expect(live.pluginState.readSlice(PLUGIN_ID, 'conversation')).toBeUndefined();
    expect(live.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'world')).toEqual({ total: 51 });
    expect(live.pluginState.unresolvedRequiredPlugins()).toEqual([]);

    await expect(live.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    const expected = snapshot(live);
    const checkpoint = await live.docs.get<CheckpointEnvelope>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    expect(checkpoint?.stateNames).toEqual(expect.arrayContaining([...PLUGIN_STATE_NAMES]));

    const restored = harness(storage);
    registerReducers(restored, { conversationRequired: true });
    const restoredReads = watchReads(restored.wire);
    await restored.dispatcher.restore();
    expect(restoredReads.full()).toBe(0);
    expect(restoredReads.tails()).toEqual([]);
    expect(snapshot(restored)).toEqual(expected);

    await live.docs.delete(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const replayed = harness(storage);
    registerReducers(replayed, { conversationRequired: true });
    const replayReads = watchReads(replayed.wire);
    await replayed.dispatcher.restore();
    expect(replayReads.full()).toBe(1);
    expect(snapshot(replayed)).toEqual(expected);

    const unloaded = harness(storage);
    const unloadedReads = watchReads(unloaded.wire);
    await expect(unloaded.dispatcher.restore()).resolves.toBeUndefined();
    expect(unloadedReads.full()).toBe(1);
    expect(unloaded.pluginState.unresolvedRequiredPlugins()).toEqual([]);
    expect(unloaded.state.get(contextMemoryKey)).toHaveLength(17);

    for (const registration of registrations) await registration.dispose();
  });

  it('accepts exactly 64 KiB of plugin JSON state and rejects a larger slice', async () => {
    const target = harness();
    await initialize(target, true);
    const emptyState = { text: '' };
    const stateOverhead = Buffer.byteLength(JSON.stringify(emptyState), 'utf8');
    const exactState = { text: 'x'.repeat(MAX_PLUGIN_STATE_BYTES - stateOverhead) };
    const oversizedState = { text: 'x'.repeat(MAX_PLUGIN_STATE_BYTES - stateOverhead + 1) };
    expect(Buffer.byteLength(JSON.stringify(exactState), 'utf8')).toBe(MAX_PLUGIN_STATE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversizedState), 'utf8')).toBe(MAX_PLUGIN_STATE_BYTES + 1);

    disposables.add(target.registry.registerReducer({
      pluginId: 'exact-limit-plugin',
      clock: 'conversation',
      schemaVersion: 1,
      reducerVersion: 1,
      maxBytes: MAX_PLUGIN_STATE_BYTES,
      initial: () => exactState,
      reduce: (state) => state,
    }));
    disposables.add(target.registry.registerReducer({
      pluginId: 'oversized-plugin',
      clock: 'conversation',
      schemaVersion: 1,
      reducerVersion: 1,
      initial: () => oversizedState,
      reduce: (state) => state,
    }));

    await expect(target.pluginState.recordFact({
      pluginId: 'exact-limit-plugin',
      clock: 'conversation',
      factType: 'retain',
      payload: { value: 1 },
    })).resolves.toBeUndefined();
    await expect(target.pluginState.recordFact({
      pluginId: 'oversized-plugin',
      clock: 'conversation',
      factType: 'retain',
      payload: { value: 1 },
    })).rejects.toMatchObject({ code: 'plugin_state.invalid_fact' });

    expect(target.pluginState.readSlice<{ text: string }>('exact-limit-plugin', 'conversation')).toEqual(exactState);
    expect(target.pluginState.readSlice('oversized-plugin', 'conversation')).toBeUndefined();
  });

  it('snapshots facts as prototype-free JSON before the caller mutates the payload', async () => {
    const target = harness();
    await initialize(target, true);
    disposables.add(target.registry.registerReducer<{ total: number; inheritedVisible: boolean; plainPrototype: boolean }>({
      pluginId: PLUGIN_ID,
      clock: 'conversation',
      schemaVersion: 1,
      reducerVersion: 1,
      initial: () => ({ total: 0, inheritedVisible: false, plainPrototype: true }),
      reduce: (_state, _factType, factPayload) => {
        if (!isPluginJsonObject(factPayload)) throw new Error('Expected a JSON object fact.');
        return {
          total: numberValue(factPayload),
          inheritedVisible: 'inherited' in factPayload,
          plainPrototype: Object.getPrototypeOf(factPayload) === Object.prototype,
        };
      },
    }));
    const payload = Object.assign(Object.create({ inherited: 'discarded' }), {
      value: 4,
      nested: { label: 'before' },
    });

    const recording = target.pluginState.recordFact({
      pluginId: PLUGIN_ID,
      clock: 'conversation',
      factType: 'snapshot',
      payload,
    });
    payload.value = 99;
    payload.nested.label = 'after';
    payload.late = 'discarded';
    await recording;

    expect(target.pluginState.readSlice<{ total: number; inheritedVisible: boolean; plainPrototype: boolean }>(PLUGIN_ID, 'conversation')).toEqual({
      total: 4,
      inheritedVisible: false,
      plainPrototype: true,
    });
    const fact = (await readJournal(target.wire)).find((record) => record.type === 'plugin.fact_recorded');
    expect(fact).toMatchObject({
      pluginId: PLUGIN_ID,
      factType: 'snapshot',
      payload: { value: 4, nested: { label: 'before' } },
    });
    expect(fact).not.toHaveProperty('payload.inherited');
    expect(fact).not.toHaveProperty('payload.late');
  });

  it('falls back to canonical replay when an older checkpoint lacks plugin state keys', async () => {
    const storage = new InMemoryStorageService();
    const first = harness(storage);
    await initialize(first, true);
    await appendUserAnchors(first, 2);
    registerReducers(first);
    await recordConversationAndWorldFacts(first);
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);

    const saved = await first.docs.get<CheckpointEnvelope>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    expect(saved).toBeDefined();
    expect(saved?.stateNames).toEqual(expect.arrayContaining([...PLUGIN_STATE_NAMES]));
    const payload = decodeReplayCheckpointGraph(saved!.graph) as { states: { name: string }[] };
    const older = {
      ...saved!,
      stateNames: saved!.stateNames.filter((name) => !PLUGIN_STATE_NAMES.has(name)),
      graph: encodeReplayCheckpointGraph({
        ...payload,
        states: payload.states.filter((state) => !PLUGIN_STATE_NAMES.has(state.name)),
      }),
    };
    await first.docs.set(CHECKPOINT_SCOPE, CHECKPOINT_KEY, older);

    const recovered = harness(storage);
    registerReducers(recovered);
    const reads = watchReads(recovered.wire);
    await recovered.dispatcher.restore();

    expect(reads.full()).toBe(1);
    expect(snapshot(recovered)).toEqual(snapshot(first));
    expect(recovered.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(2);
    await recovered.dispatcher.dispatchDurably(new ContextUndo({ count: 1 }));
    expect(snapshot(recovered)).toEqual({ context: ['anchor-0'], conversation: undefined, world: { total: 51 } });
  });

  it('treats an external provider message revision as one undo anchor in live state and replay', async () => {
    const live = harness();
    await initialize(live, true);
    registerReducers(live);
    const append = async (text: string) => live.dispatcher.dispatchDurably(new ContextAppendMessage({
      message: { ...userMessage(text), id: 'external-user', providerMessageId: 'provider-user' },
    }));
    await append('first segment');
    await live.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 1 } });
    await append('revised segment');
    await live.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 2 } });
    expect(snapshot(live)).toEqual({ context: ['first segmentrevised segment'], conversation: { total: 3 }, world: undefined });
    expect(live.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(1);

    const replayed = harness(live.storage);
    registerReducers(replayed);
    await replayed.dispatcher.restore();
    expect(replayed.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(1);
    await replayed.dispatcher.dispatchDurably(new ContextUndo({ count: 1 }));
    expect(snapshot(replayed)).toEqual({ context: [], conversation: undefined, world: undefined });
    expect(replayed.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(0);
  });

  it('binds a checkpoint and its undo history to the reducer that folded the facts', async () => {
    const storage = new InMemoryStorageService();
    const first = harness(storage);
    await initialize(first, true);
    disposables.add(first.registry.registerReducer(reducerSpec('conversation', 1, 1)));
    await appendUserAnchors(first, 1);
    await first.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 5 } });
    expect(first.pluginState.readSlice(PLUGIN_ID, 'conversation')).toEqual({ total: 5 });
    expect(() => first.registry.registerReducer(reducerSpec('conversation', 1, 10))).toThrow('must change');

    const newSpec: PluginStateReducerSpec<{ amount: number }> = {
      pluginId: PLUGIN_ID, clock: 'conversation', schemaVersion: 2, reducerVersion: 2,
      initial: () => ({ amount: 0 }),
      reduce: (state, factType, payload) => ({ amount: state.amount + (factType === 'add' ? numberValue(payload) * 10 : Number(payload)) }),
    };
    disposables.add(first.registry.registerReducer(newSpec));
    await expect(first.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add-v2', payload: 7 }))
      .rejects.toMatchObject({ code: 'plugin_state.replay_required' });
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    const saved = await first.docs.get<CheckpointEnvelope>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    expect(saved?.pluginInterpretation).toEqual([{ pluginId: PLUGIN_ID, clock: 'conversation', schemaVersion: 1, reducerVersion: 1 }]);

    const upgraded = harness(storage);
    disposables.add(upgraded.registry.registerReducer(newSpec));
    const reads = watchReads(upgraded.wire);
    await upgraded.dispatcher.restore();

    expect(reads.full()).toBe(1);
    expect(upgraded.pluginState.readSlice(PLUGIN_ID, 'conversation')).toEqual({ amount: 50 });
    expect(upgraded.pluginState.unresolvedRequiredPlugins()).toEqual([]);
    await upgraded.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add-v2', payload: 7 });
    expect(upgraded.pluginState.readSlice(PLUGIN_ID, 'conversation')).toEqual({ amount: 57 });
    await upgraded.dispatcher.dispatchDurably(new ContextUndo({ count: 1 }));
    expect(upgraded.pluginState.readSlice(PLUGIN_ID, 'conversation')).toBeUndefined();
  });

  it('rejects recovery when an unloaded reducer owns required plugin facts', async () => {
    const storage = new InMemoryStorageService();
    const first = harness(storage);
    await initialize(first, true);
    const registration = disposables.add(first.registry.registerReducer(reducerSpec('conversation', 1, 1, true)));
    await first.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 3 } });
    await registration.dispose();

    const recovering = harness(storage);
    const reads = watchReads(recovering.wire);
    let restoreHookRan = false;
    recovering.dispatcher.hooks.onDidRestore.register('test', async (_context, next) => {
      restoreHookRan = true;
      await next();
    });

    await expect(recovering.dispatcher.restore()).rejects.toMatchObject({ code: 'plugin_state.required_unresolved' });
    expect(reads.full()).toBe(1);
    expect(restoreHookRan).toBe(false);
  });

  it('clears conversation undo markers at a context clear boundary', async () => {
    const target = harness();
    await initialize(target, true);
    const registrations = registerReducers(target);
    await appendUserAnchors(target, 1);
    await target.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 2 } });
    await target.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'world', factType: 'add', payload: { value: 9 } });
    expect(target.dispatcher.checkpointDepth(pluginConversationStateKey)).toBeGreaterThan(0);

    await target.dispatcher.dispatchDurably(new ContextClear({}));

    expect(target.dispatcher.checkpointDepth(pluginConversationStateKey)).toBe(0);
    expect(target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'conversation')).toEqual({ total: 2 });
    expect(target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'world')).toEqual({ total: 9 });

    await appendUserAnchors(target, 1);
    await target.pluginState.recordFact({ pluginId: PLUGIN_ID, clock: 'conversation', factType: 'add', payload: { value: 4 } });
    await target.dispatcher.dispatchDurably(new ContextUndo({ count: 1 }));

    expect(target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'conversation')).toEqual({ total: 2 });
    expect(target.pluginState.readSlice<{ total: number }>(PLUGIN_ID, 'world')).toEqual({ total: 9 });
    for (const registration of registrations) await registration.dispose();
  });
});
