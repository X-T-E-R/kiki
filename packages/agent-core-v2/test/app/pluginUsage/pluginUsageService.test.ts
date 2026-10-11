import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ErrorCodes } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { TestInstantiationService } from '#/_base/di/testInstantiationService';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionPluginUsageService, SessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';

type StoredValue = { readonly revision: number; readonly overrides: Record<string, boolean> };

class MemoryDocuments {
  readonly values = new Map<string, StoredValue>();
  reads = 0;

  async get<T>(_scope: string, key: string): Promise<T | undefined> {
    this.reads++;
    return this.values.get(key) as T | undefined;
  }

  async set<T>(_scope: string, key: string, value: T): Promise<void> {
    this.values.set(key, value as StoredValue);
  }
}

function flag(enabled: boolean): IFlagService {
  return { enabled: () => enabled } as unknown as IFlagService;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('PluginUsageService', () => {
  const containers: TestInstantiationService[] = [];

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.dispose();
  });

  function create(documents = new MemoryDocuments(), enabled = true) {
    const container = new TestInstantiationService();
    container.set(IAtomicDocumentStore, documents as unknown as IAtomicDocumentStore);
    container.set(IFlagService, flag(enabled));
    container.set(IPluginUsageService, new SyncDescriptor(PluginUsageService));
    containers.push(container);
    return { service: container.get(IPluginUsageService), documents };
  }

  function sessionUsage(service: IPluginUsageService, documents: MemoryDocuments, sessionId: string) {
    const container = new TestInstantiationService();
    container.set(IAtomicDocumentStore, documents as unknown as IAtomicDocumentStore);
    container.set(IPluginUsageService, service);
    container.set(ISessionContext, { workspaceId: 'workspace-b', sessionId } as ISessionContext);
    container.set(IPluginService, { getPluginInfo: async ({ id }: { id: string }) => ({ id, enabled: id !== 'denied', state: 'ok' }) } as unknown as IPluginService);
    container.set(ISessionPluginUsageService, new SyncDescriptor(SessionPluginUsageService));
    containers.push(container);
    return container.get(ISessionPluginUsageService);
  }

  it('isolates workspace overrides so turning A off leaves B unchanged', async () => {
    const { service } = create();

    const a = await service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' });

    expect(a).toMatchObject({
      workspaceId: 'workspace-a',
      revision: 1,
      overrides: { demo: false },
      applyState: 'applied',
    });
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(false);
    await expect(service.allows('workspace-b', 'demo')).resolves.toBe(true);
  });

  it('persists an off override across service recreation and deletes it on inherit', async () => {
    const documents = new MemoryDocuments();
    const first = create(documents).service;

    await first.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' });
    const restored = create(documents).service;
    await expect(restored.allows('workspace-a', 'demo')).resolves.toBe(false);

    const inherited = await restored.set({
      workspaceId: 'workspace-a',
      pluginId: 'demo',
      override: 'inherit',
    });
    expect(inherited).toMatchObject({ revision: 2, overrides: {}, applyState: 'applied' });

    const reloaded = create(documents).service;
    await expect(reloaded.read('workspace-a')).resolves.toMatchObject({
      revision: 2,
      overrides: {},
      applyState: 'applied',
    });
    await expect(reloaded.allows('workspace-a', 'demo')).resolves.toBe(true);
  });

  it('keeps installation defaults, workspace choices, and explicit session choices independent across cold reads', async () => {
    const { service, documents } = create();
    service.registerPluginStateReader(id => ({ allowed: id !== 'denied', globalEnabled: false }));
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(false);
    await service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'on' });
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(true);
    await expect(service.allows('workspace-b', 'demo')).resolves.toBe(false);
    await documents.set('session-plugin-usage', 'session-b', { revision: 1, overrides: { demo: true, denied: true } });
    await expect(service.allows('workspace-b', 'demo', 'session-b')).resolves.toBe(true);
    await expect(service.allows('workspace-b', 'demo', 'session-other')).resolves.toBe(false);
    await expect(service.allows('workspace-b', 'denied', 'session-b')).resolves.toBe(false);
    const cold = create(documents).service;
    cold.registerPluginStateReader(id => ({ allowed: id !== 'denied', globalEnabled: false }));
    await expect(cold.allows('workspace-b', 'demo', 'session-b')).resolves.toBe(true);
    await expect(cold.read('workspace-b')).resolves.toMatchObject({ overrides: {} });
    await expect(cold.read('workspace-a')).resolves.toMatchObject({ overrides: { demo: true } });
  });

  it('persists explicit session activation, hot off and restore independently, and recovers a failed apply', async () => {
    const { service, documents } = create();
    service.registerPluginStateReader(id => ({ allowed: id !== 'denied', globalEnabled: false }));
    const session = sessionUsage(service, documents, 'session-b');
    const activation = deferred<void>();
    const activationListener = service.onDidChange(event => { if (event.sessionId === 'session-b') event.waitUntil(activation.promise); });
    const activating = session.set('demo', 'on');
    await vi.waitFor(async () => {
      expect(await service.readSession('workspace-b', 'session-b')).toMatchObject({ overrides: { demo: true }, applyState: 'pending' });
    });
    activation.resolve();
    await expect(activating).resolves.toMatchObject({ overrides: { demo: true }, applyState: 'applied' });
    activationListener.dispose();
    await expect(service.allows('workspace-b', 'demo', 'session-b')).resolves.toBe(true);
    await expect(service.allows('workspace-b', 'demo')).resolves.toBe(false);
    await expect(sessionUsage(service, documents, 'session-b').read()).resolves.toMatchObject({ overrides: { demo: true } });
    await expect(session.set('denied', 'on')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    let fail = true;
    const listener = service.onDidChange(event => {
      if (event.sessionId === 'session-b' && fail) { fail = false; event.waitUntil(Promise.reject(new Error('host activation failed'))); }
    });
    await expect(session.set('demo', 'off')).resolves.toMatchObject({ overrides: { demo: true }, applyState: 'failed', errors: ['Error: host activation failed'] });
    await expect(service.readSession('workspace-b', 'session-b')).resolves.toMatchObject({ overrides: { demo: true }, applyState: 'failed', errors: ['Error: host activation failed'] });
    listener.dispose();
    await expect(session.set('demo', 'off')).resolves.toMatchObject({ overrides: { demo: false }, applyState: 'applied' });
    await expect(service.allows('workspace-b', 'demo', 'session-b')).resolves.toBe(false);
    await expect(session.set('demo', 'inherit')).resolves.toMatchObject({ overrides: {} });
    await expect(service.read('workspace-b')).resolves.toMatchObject({ revision: 0, overrides: {} });
  });

  it('fails closed for writes and allows inherited usage when the flag is off', async () => {
    const { service, documents } = create(new MemoryDocuments(), false);

    await expect(service.read('workspace-a')).resolves.toMatchObject({
      revision: 0,
      overrides: {},
      applyState: 'applied',
    });
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(true);
    await expect(
      service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' }),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_IMPLEMENTED });
    expect(documents.reads).toBe(0);
  });

  it('does not let an older failed apply overwrite a newer revision', async () => {
    const { service } = create();
    const oldApply = deferred<void>();
    const newApply = deferred<void>();
    const appliedRevisions: number[] = [];
    let changeCount = 0;
    service.onDidChange((event) => {
      event.waitUntil(changeCount++ === 0 ? oldApply.promise : newApply.promise);
    });
    service.onDidApply((snapshot) => appliedRevisions.push(snapshot.revision));

    await expect(
      service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' }),
    ).resolves.toMatchObject({ revision: 1, applyState: 'pending' });
    await expect(
      service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'on' }),
    ).resolves.toMatchObject({ revision: 2, applyState: 'pending' });

    oldApply.reject(new Error('old apply failed'));
    await vi.waitFor(async () => {
      expect((await service.read('workspace-a')).applyState).toBe('pending');
    });

    newApply.resolve();
    await vi.waitFor(async () => {
      expect((await service.read('workspace-a')).applyState).toBe('applied');
    });
    expect((await service.read('workspace-a')).revision).toBe(2);
    expect(appliedRevisions).toEqual([2]);
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(true);
  });

  it('restores the last workspace selection after an apply failure', async () => {
    const { service } = create();
    const failedApply = deferred<void>();
    service.onDidChange((event) => {
      event.waitUntil(failedApply.promise);
    });

    await expect(
      service.set({ workspaceId: 'workspace-a', pluginId: 'demo', override: 'off' }),
    ).resolves.toMatchObject({ revision: 1, applyState: 'pending' });
    failedApply.reject(new Error('apply failed'));

    await vi.waitFor(async () => {
      expect((await service.read('workspace-a')).revision).toBe(2);
    });
    await expect(service.read('workspace-a')).resolves.toMatchObject({
      revision: 2,
      overrides: {},
      applyState: 'failed',
      errors: ['Error: apply failed'],
    });
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(true);
  });
});
