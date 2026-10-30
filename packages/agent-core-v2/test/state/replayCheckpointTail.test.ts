import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ContextAppendMessage, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { z } from 'zod';
import { TurnPrompt } from '#/agent/loop/turnOps';
import { agentMessageMaterializationsKey } from '#/session/agentCollaboration/messageReceiptState';
import { defineState, type ReplayableStateKey } from '#/state/state';
import { contextMemoryKey, contextRevisionKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { promptAdmissionKey } from '#/agent/prompt/promptOps';
import { PromptEnqueued, PromptLaunchCommitted, promptQueueKey } from '#/agent/prompt/promptService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { usageKey } from '#/agent/usage/usageOps';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import type { StorageReadRange } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService, REPLAY_CHECKPOINT_GROWTH_BYTES } from '#/state/eventDispatcherService';
import { IWireService, type WireJournalReadOptions } from '#/wire/wire';
import { WireService } from '#/wire/wireService';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { WIRE_TRANSCRIPT_RECEIPT_KEY } from '#/wire/transcriptReceipt';

const SCOPE = 'sessions/s/agents/main';
const CHECKPOINT_SCOPE = `${SCOPE}/replay-checkpoints`;
const CHECKPOINT_KEY = 'engine-v1';

class CountingStorage extends InMemoryStorageService {
  streamBytes = 0;

  override async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    for await (const chunk of super.readStream(scope, key, range)) {
      this.streamBytes += chunk.byteLength;
      yield chunk;
    }
  }
}

let disposables = new DisposableStore();
beforeEach(() => {
  disposables = new DisposableStore();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await disposables.dispose();
});

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

interface Harness {
  readonly storage: InMemoryStorageService;
  readonly docs: IAtomicDocumentStore;
  readonly wire: IWireService;
  readonly dispatcher: IEventDispatcher;
  readonly state: IAgentStateService;
}

function message(role: 'user' | 'assistant', text: string): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: role === 'user' ? { kind: 'user' } : { kind: 'assistant' },
  } as ContextMessage;
}

function prompt(text: string, queueIndex: number) {
  return new PromptEnqueued({
    schemaVersion: 1,
    promptId: 'prompt-1',
    userMessageId: 'prompt-1',
    createdAt: '2026-10-12T00:00:00.000Z',
    message: message('user', text),
    alreadyMaterialized: false,
    appendTiming: 'agent_idle',
    revision: queueIndex,
    queueIndex,
  }).serialize();
}

function harness<T = Record<string, true>>(storage = new InMemoryStorageService(), extraKey?: ReplayableStateKey<T>): Harness {
  const root = disposables.add(new TestInstantiationService());
  root.stub(IFileSystemStorageService, storage);
  root.stub(ILogService, noopLogger);
  root.stub(ITelemetryService, noopTelemetryService);
  root.stub(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId: 'main',
    scope: (subKey?: string) => (subKey === undefined || subKey === '' ? SCOPE : `${SCOPE}/${subKey}`),
  });
  root.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  root.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  root.set(IAgentBlobService, noopBlob);
  root.set(IEventBus, new SyncDescriptor(EventBusService));
  root.set(IWireService, new SyncDescriptor(WireService));
  root.set(IAgentStateService, new AgentStateService());
  root.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const state = root.get(IAgentStateService);
  state.contributeState(contextMemoryKey);
  state.contributeState(contextRevisionKey);
  state.contributeState(usageKey);
  state.contributeState(promptQueueKey);
  state.contributeState(promptAdmissionKey);
  if (extraKey !== undefined) state.contributeState(extraKey);
  return {
    storage,
    docs: root.get(IAtomicDocumentStore),
    wire: root.get(IWireService),
    dispatcher: root.get(IEventDispatcher),
    state,
  };
}

function watchReads(wire: IWireService): { full: number; tails: number[] } {
  const seen = { full: 0, tails: [] as number[] };
  const original = wire.readJournal.bind(wire);
  wire.readJournal = (options?: WireJournalReadOptions) => {
    if (options?.startByte !== undefined && options.startByte > 0) seen.tails.push(options.startByte);
    else seen.full += 1;
    return original(options);
  };
  return seen;
}

async function seed(wire: IWireService): Promise<void> {
  await wire.seal();
  wire.appendRecord({ type: 'context.append_message', message: message('user', 'prefix-user'), time: 1 });
  wire.appendRecord({ type: 'context.append_message', message: message('assistant', 'prefix-assistant'), time: 2 });
  wire.appendRecord({
    type: 'usage.record',
    time: 3,
    model: 'stub',
    usage: { inputOther: 1, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
  });
  wire.appendRecord(prompt('queued-first', 0));
  await wire.flush();
}

function texts(state: IAgentStateService): string[] {
  return state.get(contextMemoryKey).map((entry) => {
    const part = entry.content[0];
    return part !== undefined && 'text' in part ? String(part.text) : '';
  });
}

function queueText(state: IAgentStateService): string | undefined {
  const queue = state.get(promptQueueKey);
  const entry = queue.entries.get('prompt-1') as { message?: ContextMessage } | undefined;
  const part = entry?.message?.content[0];
  return part !== undefined && 'text' in part ? String(part.text) : undefined;
}

async function checkpointed(): Promise<Harness> {
  const first = harness();
  await seed(first.wire);
  await first.dispatcher.restore();
  await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
  return first;
}

async function bytesOf(storage: InMemoryStorageService): Promise<Uint8Array> {
  const bytes = await storage.read(SCOPE, AGENT_WIRE_RECORD_KEY);
  if (bytes === undefined) throw new Error('journal missing');
  return bytes;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function ticks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('replay checkpoint tail', () => {
  it('saves and reopens sixty-three MiB of state without a long uninterrupted encoding slice', async () => {
    const text = 'x'.repeat(32_256);
    const key = defineState('checkpoint.large', () => Array.from({ length: 2048 }, () => text))
      .replayable({ schema: z.array(z.string()) });
    const first = harness(undefined, key);
    await first.wire.seal();
    let running = true;
    let beats = 0;
    let previous = performance.now();
    let maxStallMs = 0;
    const heartbeat = (): void => {
      const now = performance.now();
      maxStallMs = Math.max(maxStallMs, now - previous);
      previous = now;
      beats += 1;
      if (running) setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    try {
      await first.dispatcher.restore();
      await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    } finally {
      running = false;
    }
    expect(beats).toBeGreaterThan(1);
    expect(maxStallMs).toBeLessThan(100);
    process.stdout.write(`checkpoint63MiB maxStallMs=${maxStallMs.toFixed(2)} yields=${beats}\n`);
    const reopened = harness(first.storage, key);
    await reopened.dispatcher.restore();
    expect(reopened.state.get(key)).toEqual(first.state.get(key));
  });

  it('does not read state or write a checkpoint again for an unchanged agent', async () => {
    const first = await checkpointed();
    const reads = vi.spyOn(first.state, 'get');
    const writes = vi.spyOn(first.docs, 'set');
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    await first.dispatcher.dispatch(new ContextAppendMessage({ message: message('user', 'changed') }));
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockClear();
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([false, true])('rebuilds mailbox evidence from a legacy checkpoint without losing pending input, consumed=%s', async (consumed) => {
    const legacyKey = defineState('agentCollaboration.materializedMessages', (): Record<string, true> => ({}))
      .replayable({ schema: z.record(z.string(), z.literal(true)) })
      .on(ContextAppendMessage, (state, event) => {
        if (event.message.origin?.kind === 'agent_message') state[event.message.origin.messageId] = true;
      });
    const first = harness(undefined, legacyKey);
    await first.wire.seal();
    const mailboxMessage: ContextMessage = { ...message('user', 'saved mailbox body'), id: 'mailbox-message',
      origin: { kind: 'agent_message', messageId: 'mailbox-message', senderAgentId: 'sender', senderTaskName: 'worker' } };
    await first.dispatcher.dispatch(new PromptEnqueued({ schemaVersion: 1, promptId: 'mailbox-message', userMessageId: 'mailbox-message',
      createdAt: new Date(0).toISOString(), message: mailboxMessage, alreadyMaterialized: true,
      appendTiming: 'agent_idle', revision: 0, queueIndex: 0 }));
    if (consumed) {
      await first.dispatcher.dispatch(new PromptLaunchCommitted({ launchId: 'launch', promptId: 'mailbox-message', revision: 0, committedAt: new Date(0).toISOString() }));
      await first.dispatcher.dispatch(new TurnPrompt({ turnId: 1, promptId: 'mailbox-message',
        input: mailboxMessage.content, origin: mailboxMessage.origin! }));
    }
    await first.wire.flush();
    expect(first.state.get(legacyKey)).toEqual({});
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);

    const upgraded = harness(first.storage, agentMessageMaterializationsKey);
    const upgradedReads = watchReads(upgraded.wire);
    await upgraded.dispatcher.restore();
    expect(upgradedReads.full).toBe(1);
    expect(upgraded.state.get(agentMessageMaterializationsKey)).toEqual(consumed ? { 'mailbox-message': true } : {});
    expect(upgraded.state.get(promptQueueKey).entries.has('mailbox-message')).toBe(!consumed);
    await expect(upgraded.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);

    const current = harness(first.storage, agentMessageMaterializationsKey);
    const currentReads = watchReads(current.wire);
    await current.dispatcher.restore();
    expect(currentReads.full).toBe(0);
    expect(current.state.get(agentMessageMaterializationsKey)).toEqual(consumed ? { 'mailbox-message': true } : {});
    expect(current.state.get(promptQueueKey).entries.has('mailbox-message')).toBe(!consumed);
  });

  it('keeps an exact current checkpoint and an old headless envelope on the canonical paths', async () => {
    const first = await checkpointed();
    const saved = await first.docs.get<{ wire: { prefixSha256?: string; headHash?: string } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    expect(saved?.wire.prefixSha256).toMatch(/^[a-f0-9]{64}$/);

    const exact = harness(first.storage);
    const exactReads = watchReads(exact.wire);
    await exact.dispatcher.restore();
    expect(exactReads.full).toBe(0);
    expect(exactReads.tails).toEqual([]);
    expect(texts(exact.state)).toEqual(['prefix-user', 'prefix-assistant']);
    expect(exact.state.get(usageKey).byModel['stub']?.output).toBe(3);
    expect(queueText(exact.state)).toBe('queued-first');
    expect(exact.state.get(promptAdmissionKey).get('prompt-1')).toBe(true);

    const legacy = structuredClone(saved);
    delete legacy?.wire.headHash;
    delete legacy?.wire.prefixSha256;
    await first.docs.set(CHECKPOINT_SCOPE, CHECKPOINT_KEY, legacy);
    const old = harness(first.storage);
    const oldReads = watchReads(old.wire);
    await old.dispatcher.restore();
    expect(oldReads.full).toBe(1);
    expect(texts(old.state)).toEqual(['prefix-user', 'prefix-assistant']);
    expect(queueText(old.state)).toBe('queued-first');
  });

  it('replays only the verified tail for an append, including duplicate prompts, usage, and undo', async () => {
    const first = await checkpointed();
    const size = (await bytesOf(first.storage)).byteLength;
    first.wire.appendRecord({ type: 'context.append_message', message: message('user', 'tail-user'), time: 4 });
    first.wire.appendRecord({
      type: 'usage.record',
      time: 5,
      model: 'stub',
      usage: { inputOther: 1, output: 4, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    first.wire.appendRecord(prompt('queued-tail', 0));
    await first.wire.flush();

    const tailed = harness(first.storage);
    const reads = watchReads(tailed.wire);
    await tailed.dispatcher.restore();
    expect(reads.full).toBe(0);
    expect(reads.tails).toEqual([size]);
    expect(texts(tailed.state)).toEqual(['prefix-user', 'prefix-assistant', 'tail-user']);
    expect(tailed.state.get(usageKey).byModel['stub']?.output).toBe(7);
    expect(queueText(tailed.state)).toBe('queued-tail');
    expect([...tailed.state.get(promptQueueKey).order]).toEqual(['prompt-1']);
    expect(tailed.state.get(contextRevisionKey)).toBe(3);

    await first.docs.delete(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const replayed = harness(first.storage);
    await replayed.dispatcher.restore();
    expect(texts(replayed.state)).toEqual(texts(tailed.state));
    expect(replayed.state.get(usageKey)).toEqual(tailed.state.get(usageKey));
    expect(queueText(replayed.state)).toBe(queueText(tailed.state));
    expect(replayed.state.get(contextRevisionKey)).toBe(tailed.state.get(contextRevisionKey));

    await tailed.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    await replayed.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    expect(texts(tailed.state)).toEqual(['prefix-user', 'prefix-assistant']);
    expect(texts(replayed.state)).toEqual(texts(tailed.state));
  });

  it('accepts an unchanged journal whose mtime moved when the prefix digest matches', async () => {
    const first = await checkpointed();
    const before = await first.storage.mtime(SCOPE, AGENT_WIRE_RECORD_KEY);
    while (Date.now() === before) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await first.storage.write(SCOPE, AGENT_WIRE_RECORD_KEY, await bytesOf(first.storage));
    expect(await first.storage.mtime(SCOPE, AGENT_WIRE_RECORD_KEY)).not.toBe(before);

    const restored = harness(first.storage);
    const reads = watchReads(restored.wire);
    await restored.dispatcher.restore();
    expect(reads.full).toBe(0);
    expect(reads.tails).toEqual([]);
    expect(texts(restored.state)).toEqual(['prefix-user', 'prefix-assistant']);
  });

  it('uses a legacy full-journal sealed digest when an older checkpoint has no prefix hash', async () => {
    const first = await checkpointed();
    const sealedBytes = Buffer.from(await bytesOf(first.storage));
    await first.storage.write(SCOPE, WIRE_TRANSCRIPT_RECEIPT_KEY, Buffer.from(JSON.stringify({
      format: 1, epoch: 'legacy', state: 'sealed', trusted: true,
      wire: { size: sealedBytes.byteLength, sha256: createHash('sha256').update(sealedBytes).digest('hex') },
    })));
    const saved = await first.docs.get<{ wire: { prefixSha256?: string } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    delete saved?.wire.prefixSha256;
    await first.docs.set(CHECKPOINT_SCOPE, CHECKPOINT_KEY, saved);
    const before = await first.storage.mtime(SCOPE, AGENT_WIRE_RECORD_KEY);
    while (Date.now() === before) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const original = await bytesOf(first.storage);
    await first.storage.write(SCOPE, AGENT_WIRE_RECORD_KEY, original);
    const extra = Buffer.from(`${JSON.stringify({ type: 'context.append_message', message: message('user', 'sealed-tail'), time: 9 })}\n`);
    await first.storage.append(SCOPE, AGENT_WIRE_RECORD_KEY, extra);

    const restored = harness(first.storage);
    await restored.wire.beginTranscriptEpoch!();
    const reads = watchReads(restored.wire);
    await restored.dispatcher.restore();
    expect(reads.full).toBe(0);
    expect(reads.tails).toEqual([original.byteLength]);
    expect(texts(restored.state)).toEqual(['prefix-user', 'prefix-assistant', 'sealed-tail']);
    expect(queueText(restored.state)).toBe('queued-first');
  });

  it('falls back to a full replay after a same-size rewrite, a truncate, or a corrupt tail', async () => {
    const rewritten = await checkpointed();
    const original = Buffer.from(await bytesOf(rewritten.storage));
    const token = Buffer.from('prefix-user');
    const at = original.indexOf(token);
    expect(at).toBeGreaterThan(0);
    original.set(Buffer.from('rewritten!!'), at);
    await rewritten.storage.write(SCOPE, AGENT_WIRE_RECORD_KEY, original);
    const rewriteHost = harness(rewritten.storage);
    const rewriteWatch = watchReads(rewriteHost.wire);
    await rewriteHost.dispatcher.restore();
    expect(rewriteWatch.full).toBe(1);
    expect(texts(rewriteHost.state)).toEqual(['rewritten!!', 'prefix-assistant']);

    const truncated = await checkpointed();
    const whole = Buffer.from(await bytesOf(truncated.storage));
    const cut = whole.subarray(0, whole.indexOf(Buffer.from('prefix-assistant')) - 1);
    const newline = cut.lastIndexOf(0x0a);
    await truncated.storage.write(SCOPE, AGENT_WIRE_RECORD_KEY, cut.subarray(0, newline + 1));
    const truncateHost = harness(truncated.storage);
    const truncateWatch = watchReads(truncateHost.wire);
    await truncateHost.dispatcher.restore();
    expect(truncateWatch.full).toBe(1);
    expect(texts(truncateHost.state)).toEqual(['prefix-user']);

    const corrupt = await checkpointed();
    await corrupt.storage.append(SCOPE, AGENT_WIRE_RECORD_KEY, Buffer.from('{not-json}\n'));
    const corruptHost = harness(corrupt.storage);
    const corruptWatch = watchReads(corruptHost.wire);
    await corruptHost.dispatcher.restore();
    expect(corruptWatch.tails.length).toBe(1);
    expect(corruptWatch.full).toBe(1);
    expect(texts(corruptHost.state)).toEqual(['prefix-user', 'prefix-assistant']);
    const repaired = Buffer.from(await bytesOf(corrupt.storage)).toString('utf8');
    expect(repaired).not.toContain('not-json');
  });

  it('hashes only the bytes appended since the previous prefix digest', async () => {
    const storage = new CountingStorage();
    const first = harness(storage);
    await seed(first.wire);
    const size = (await bytesOf(storage)).byteLength;
    storage.streamBytes = 0;
    await expect(first.wire.journalSha256?.(size)).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(storage.streamBytes).toBe(size);

    first.wire.appendRecord({ type: 'context.append_message', message: message('user', 'delta'), time: 9 });
    await first.wire.flush();
    const grown = (await bytesOf(storage)).byteLength;
    storage.streamBytes = 0;
    const digest = await first.wire.journalSha256?.(grown);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.streamBytes).toBe(grown - size);
  });

  it('does not commit a streamed digest after the read fails', async () => {
    const storage = new CountingStorage();
    const first = harness(storage);
    await seed(first.wire);
    const bytes = await bytesOf(storage);
    const correct = createHash('sha256').update(bytes).digest('hex');
    const originalRead = storage.readStream.bind(storage);
    let fail = true;
    storage.readStream = async function* (scope, key, range) {
      if (fail && key === AGENT_WIRE_RECORD_KEY) {
        fail = false;
        yield bytes.subarray(0, 4);
        throw new Error('injected stream failure');
      }
      yield* originalRead(scope, key, range);
    };

    await expect(first.wire.journalSha256!(bytes.byteLength)).rejects.toThrow('injected stream failure');
    await expect(first.wire.journalSha256!(bytes.byteLength)).resolves.toBe(correct);
  });

  it('serializes concurrent prefix digest requests without sharing a mutable hash', async () => {
    const storage = new CountingStorage();
    const first = harness(storage);
    await seed(first.wire);
    const bytes = await bytesOf(storage);
    const correct = createHash('sha256').update(bytes).digest('hex');
    const entered = deferred();
    const release = deferred();
    const originalRead = storage.readStream.bind(storage);
    let firstRead = true;
    storage.readStream = async function* (scope, key, range) {
      if (firstRead && key === AGENT_WIRE_RECORD_KEY) {
        firstRead = false;
        yield bytes.subarray(0, 4);
        entered.resolve();
        await release.promise;
        yield bytes.subarray(4);
        return;
      }
      yield* originalRead(scope, key, range);
    };

    const a = first.wire.journalSha256!(bytes.byteLength);
    await entered.promise;
    const b = first.wire.journalSha256!(bytes.byteLength);
    release.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual([correct, correct]);
  });

  it('keeps growth pending when a later append lands during checkpoint I/O', async () => {
    const first = await checkpointed();
    await first.dispatcher.dispatch(new ContextAppendMessage({ message: message('user', 'before save') }));
    vi.useFakeTimers();
    const originalSet = first.docs.set.bind(first.docs);
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    first.docs.set = async (scope, key, value) => {
      if (key === CHECKPOINT_KEY) {
        writes += 1;
        entered.resolve();
        if (writes === 1) await release.promise;
      }
      return originalSet(scope, key, value);
    };

    const saving = first.dispatcher.saveReplayCheckpoint!();
    await entered.promise;
    await first.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'prompt-during-save',
      userMessageId: 'prompt-during-save',
      createdAt: '2026-10-22T00:00:00.000Z',
      message: message('user', 'x'.repeat(REPLAY_CHECKPOINT_GROWTH_BYTES + 1)),
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 2,
      queueIndex: 2,
    }));
    await first.wire.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    release.resolve();
    await expect(saving).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    const checkpoint = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const size = (await bytesOf(first.storage)).byteLength;
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(checkpoint?.wire.size).toBe(size);
  });

  it('schedules one successor when a revision-cancelled save saw a new append', async () => {
    const first = await checkpointed();
    vi.useFakeTimers();
    const previous = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const originalHash = first.wire.journalSha256!.bind(first.wire);
    const entered = deferred();
    const release = deferred();
    let hashes = 0;
    first.wire.journalSha256 = async (byteLength: number) => {
      hashes += 1;
      if (hashes === 1) {
        entered.resolve();
        await release.promise;
      }
      return originalHash(byteLength);
    };

    await first.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'prompt-cancelled',
      userMessageId: 'prompt-cancelled',
      createdAt: '2026-10-22T00:00:00.000Z',
      message: message('user', 'x'.repeat(REPLAY_CHECKPOINT_GROWTH_BYTES + 1)),
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 4,
      queueIndex: 4,
    }));
    await first.wire.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await entered.promise;
    await first.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'prompt-after-cancel',
      userMessageId: 'prompt-after-cancel',
      createdAt: '2026-10-22T00:00:00.000Z',
      message: message('user', 'tail'),
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 5,
      queueIndex: 5,
    }));
    await first.wire.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    release.resolve();
    await ticks();
    await vi.advanceTimersByTimeAsync(10_000);

    const checkpoint = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const size = (await bytesOf(first.storage)).byteLength;
    expect(previous?.wire.size).toBeLessThan(size);
    expect(checkpoint?.wire.size).toBe(size);
    expect(hashes).toBeGreaterThanOrEqual(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rearm a failed growth save after dispatcher disposal', async () => {
    const first = await checkpointed();
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    first.docs.set = async (_scope, key) => {
      if (key === CHECKPOINT_KEY) {
        writes += 1;
        entered.resolve();
        await release.promise;
        throw new Error('persistent checkpoint failure');
      }
    };

    await first.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'prompt-failure',
      userMessageId: 'prompt-failure',
      createdAt: '2026-10-22T00:00:00.000Z',
      message: message('user', 'x'.repeat(REPLAY_CHECKPOINT_GROWTH_BYTES + 1)),
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 3,
      queueIndex: 3,
    }));
    await first.wire.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await entered.promise;
    await (first.dispatcher as unknown as { dispose(): void | Promise<void> }).dispose();
    expect(vi.getTimerCount()).toBe(0);
    release.resolve();
    await ticks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs restore hooks without waiting for the optional checkpoint write', async () => {
    const first = harness();
    await first.wire.seal();
    const entered = deferred();
    const release = deferred();
    const originalSet = first.docs.set.bind(first.docs);
    first.docs.set = async (scope, key, value) => {
      if (key === CHECKPOINT_KEY) {
        entered.resolve();
        await release.promise;
      }
      return originalSet(scope, key, value);
    };
    let restoredHook = false;
    let settled = false;
    first.dispatcher.hooks.onDidRestore.register('test', async (_context, next) => {
      restoredHook = true;
      await next();
    });

    const restoring = first.dispatcher.restore().then(() => { settled = true; });
    await entered.promise;
    await ticks();
    expect(first.state.get(promptQueueKey).order).toEqual([]);
    expect(settled).toBe(true);
    expect(restoredHook).toBe(true);
    release.resolve();
    await restoring;
  });

  it('checkpoints a long run once the journal grows, then reopens on that snapshot', async () => {
    const first = await checkpointed();
    const bulky = 'x'.repeat(REPLAY_CHECKPOINT_GROWTH_BYTES);
    await first.dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'prompt-growth',
      userMessageId: 'prompt-growth',
      createdAt: '2026-10-22T00:00:00.000Z',
      message: message('user', bulky),
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 1,
      queueIndex: 1,
    }));
    await first.wire.flush();
    const started = Date.now();
    let saved = false;
    while (Date.now() - started < 5_000) {
      const envelope = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
      const size = (await bytesOf(first.storage)).byteLength;
      if (envelope?.wire.size === size) {
        saved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(saved).toBe(true);

    const reopened = harness(first.storage);
    const reads = watchReads(reopened.wire);
    await reopened.dispatcher.restore();
    expect(reads.full).toBe(0);
    expect(reads.tails).toEqual([]);
    expect(queueText(reopened.state)).toBe('queued-first');
    const grown = reopened.state.get(promptQueueKey).entries.get('prompt-growth') as { message?: ContextMessage } | undefined;
    const part = grown?.message?.content[0];
    expect(part !== undefined && 'text' in part ? String(part.text).length : 0).toBe(REPLAY_CHECKPOINT_GROWTH_BYTES);
  }, 20_000);

  it('keeps the previous checkpoint when a turn event arrives during the save', async () => {
    const first = await checkpointed();
    await first.dispatcher.dispatch(new ContextAppendMessage({ message: message('user', 'before save') }));
    const before = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    const original = first.wire.journalSha256?.bind(first.wire);
    let nested = false;
    first.wire.journalSha256 = async (byteLength: number) => {
      if (!nested) {
        nested = true;
        await first.dispatcher.dispatch(new PromptEnqueued({
          schemaVersion: 1,
          promptId: 'prompt-1',
          userMessageId: 'prompt-1',
          createdAt: '2026-10-12T00:00:00.000Z',
          message: message('user', 'during-save'),
          alreadyMaterialized: false,
          appendTiming: 'agent_idle',
          revision: 1,
          queueIndex: 1,
        }));
      }
      return original?.(byteLength);
    };
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(false);
    const during = await first.docs.get<{ wire: { size: number } }>(CHECKPOINT_SCOPE, CHECKPOINT_KEY);
    expect(during?.wire.size).toBe(before?.wire.size);
    first.wire.journalSha256 = original;
    await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
    const reopened = harness(first.storage);
    await reopened.dispatcher.restore();
    expect(queueText(reopened.state)).toBe('during-save');
  });

  it('restores a batch of independent journals from exact checkpoints', async () => {
    const batch = 8;
    const storages: CountingStorage[] = [];
    for (let index = 0; index < batch; index += 1) {
      const storage = new CountingStorage();
      const first = harness(storage);
      await seed(first.wire);
      await first.dispatcher.restore();
      await expect(first.dispatcher.saveReplayCheckpoint?.()).resolves.toBe(true);
      storages.push(storage);
    }
    let streamBytes = 0;
    const started = Date.now();
    for (const storage of storages) {
      storage.streamBytes = 0;
      const reopened = harness(storage);
      const reads = watchReads(reopened.wire);
      await reopened.dispatcher.restore();
      expect(reads.full).toBe(0);
      expect(reads.tails).toEqual([]);
      expect(texts(reopened.state)).toEqual(['prefix-user', 'prefix-assistant']);
      streamBytes += storage.streamBytes;
    }
    expect(streamBytes).toBeLessThan(batch * 1024 * 1024);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
