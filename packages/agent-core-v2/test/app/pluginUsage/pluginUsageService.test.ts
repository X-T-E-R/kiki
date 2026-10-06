import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ErrorCodes } from '#/errors';
import type { IFlagService } from '#/app/flag/flag';
import { PluginUsageService } from '#/app/pluginUsage/pluginUsageService';

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
  const services: PluginUsageService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.dispose();
  });

  function create(documents = new MemoryDocuments(), enabled = true): {
    readonly service: PluginUsageService;
    readonly documents: MemoryDocuments;
  } {
    const service = new PluginUsageService(
      documents as unknown as IAtomicDocumentStore,
      flag(enabled),
    );
    services.push(service);
    return { service, documents };
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

  it('reports a latest apply failure without changing the persisted revision', async () => {
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
      expect((await service.read('workspace-a')).applyState).toBe('failed');
    });
    await expect(service.read('workspace-a')).resolves.toMatchObject({
      revision: 1,
      overrides: { demo: false },
      applyState: 'failed',
      errors: ['Error: apply failed'],
    });
    await expect(service.allows('workspace-a', 'demo')).resolves.toBe(false);
  });
});
