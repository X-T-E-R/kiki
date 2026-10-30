import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionDeliveryService,
  resolveCreateDeliveryMode,
} from '#/session/delivery/delivery';
import { SessionDeliveryService } from '#/session/delivery/deliveryService';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';

import { stubLog } from '../../_base/log/stubs';
import { stubSessionIndexMirror } from '../../app/sessionIndex/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

function makeContext(): ISessionContext {
  return makeSessionContext({
    sessionId: 's1',
    workspaceId: 'wd_test',
    sessionDir: '/tmp/sessions/wd_test/s1',
    sessionScope: 'sessions/wd_test/s1',
    metaScope: META_SCOPE,
    cwd: '/tmp/sessions/wd_test/s1',
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('resolveCreateDeliveryMode', () => {
  it('uses message only when a persona omitted delivery', () => {
    expect(resolveCreateDeliveryMode({ hasPersona: true })).toBe('message');
    expect(resolveCreateDeliveryMode({ hasPersona: false })).toBe('reply');
    expect(resolveCreateDeliveryMode({ hasPersona: true, personaDelivery: 'reply' })).toBe('reply');
    expect(resolveCreateDeliveryMode({ hasPersona: true, personaDelivery: 'message' })).toBe('message');
    expect(resolveCreateDeliveryMode({ hasPersona: true, personaDelivery: 'message', requested: 'reply' })).toBe('reply');
    expect(resolveCreateDeliveryMode({ hasPersona: false, requested: 'message' })).toBe('message');
  });
});

describe('SessionDeliveryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionContext, makeContext());
    ix.stub(ISessionIndexMirror, stubSessionIndexMirror());
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(IFileSystemStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    ix.set(ISessionDeliveryService, new SyncDescriptor(SessionDeliveryService));
  });

  afterEach(async () => {
    await disposables.dispose();
    vi.restoreAllMocks();
  });

  it('keeps a stored reply ahead of metadata and does not infer a persona on load', async () => {
    const metadata = ix.get(ISessionMetadata);
    await metadata.ready;
    await metadata.update({ delivery: 'message' }, { touchUpdatedAt: false });
    await ix.get(IAtomicDocumentStore).set(META_SCOPE, 'delivery.json', { mode: 'reply' });
    const delivery = ix.get(ISessionDeliveryService);
    await delivery.ready;
    expect(delivery.mode()).toBe('reply');
    expect(delivery.effectiveMode()).toBe('reply');
  });

  it('reopens the persisted mode and freezes an in-flight turn', async () => {
    const first = ix.get(ISessionDeliveryService);
    await first.ready;
    expect(first.mode()).toBe('reply');
    await first.set('message');
    expect(await ix.get(IAtomicDocumentStore).get(META_SCOPE, 'delivery.json')).toEqual({ mode: 'message' });
    expect((await ix.get(ISessionMetadata).read()).delivery).toBe('message');
    const reopened = ix.createInstance(SessionDeliveryService);
    await reopened.ready;
    expect(reopened.mode()).toBe('message');
    reopened.beginTurn();
    await reopened.set('reply');
    expect(reopened.mode()).toBe('reply');
    expect(reopened.effectiveMode()).toBe('message');
    reopened.endTurn();
    expect(reopened.effectiveMode()).toBe('reply');
    await reopened.dispose();
  });

  it('serializes reverse mode changes and keeps the turn snapshot stable', async () => {
    const delivery = ix.get(ISessionDeliveryService);
    await delivery.ready;
    const documents = ix.get(IAtomicDocumentStore);
    const originalSet = documents.set.bind(documents);
    const entered = deferred();
    const gate = deferred();
    let blockFirstMessage = true;
    vi.spyOn(documents, 'set').mockImplementation(async (...args) => {
      const value = args[2] as { readonly mode?: unknown };
      if (blockFirstMessage && args[1] === 'delivery.json' && value.mode === 'message') {
        blockFirstMessage = false;
        entered.resolve();
        await gate.promise;
      }
      return originalSet(...args);
    });
    const changes: Array<'reply' | 'message'> = [];
    delivery.onDidChange((mode) => changes.push(mode));
    delivery.beginTurn();
    const first = delivery.set('message');
    await entered.promise;
    const second = delivery.set('reply');
    let secondDone = false;
    void second.then(() => { secondDone = true; });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    expect(delivery.mode()).toBe('reply');
    expect(delivery.effectiveMode()).toBe('reply');
    gate.resolve();
    await Promise.all([first, second]);
    expect(changes).toEqual(['message', 'reply']);
    expect(delivery.mode()).toBe('reply');
    expect(delivery.effectiveMode()).toBe('reply');
    expect(await documents.get(META_SCOPE, 'delivery.json')).toEqual({ mode: 'reply' });
    expect((await ix.get(ISessionMetadata).read()).delivery).toBe('reply');
    delivery.endTurn();
  });

  it('rolls back metadata after a failed second document write and can retry', async () => {
    const delivery = ix.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    const documents = ix.get(IAtomicDocumentStore);
    const metadata = ix.get(ISessionMetadata);
    const originalSet = documents.set.bind(documents);
    let failMetadataWrite = true;
    vi.spyOn(documents, 'set').mockImplementation(async (...args) => {
      if (failMetadataWrite && args[1] === 'state.json') {
        failMetadataWrite = false;
        throw new Error('metadata unavailable');
      }
      return originalSet(...args);
    });
    await expect(delivery.set('reply')).rejects.toThrow('metadata unavailable');
    expect(delivery.mode()).toBe('message');
    expect(await documents.get(META_SCOPE, 'delivery.json')).toEqual({ mode: 'message' });
    expect((await metadata.read()).delivery).toBe('message');
    await delivery.set('reply');
    expect(delivery.mode()).toBe('reply');
    expect(await documents.get(META_SCOPE, 'delivery.json')).toEqual({ mode: 'reply' });
    expect((await metadata.read()).delivery).toBe('reply');
  });

  it('uses custom delivery only when metadata has no delivery field', async () => {
    await ix.get(IAtomicDocumentStore).set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      agents: {},
      custom: { delivery: 'message' },
    });
    const delivery = ix.get(ISessionDeliveryService);
    await delivery.ready;
    expect((await ix.get(ISessionMetadata).read()).delivery).toBeUndefined();
    expect(delivery.mode()).toBe('message');
  });
});
