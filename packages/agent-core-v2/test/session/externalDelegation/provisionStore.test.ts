import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

import {
  ISessionExternalDelegationProvisionStore,
} from '#/session/externalDelegation/externalDelegation';
import { SessionExternalDelegationProvisionStore } from '#/session/externalDelegation/externalDelegationProvisionStore';

describe('SessionExternalDelegationProvisionStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;
  let store: ISessionExternalDelegationProvisionStore;
  let documents: IAtomicDocumentStore;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'delegation-provision-store-'));
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'session_ext_1',
          workspaceId: 'ws-1',
          sessionDir: join(homeDir, 'sessions', 'session_ext_1'),
          sessionScope: join('sessions', 'session_ext_1'),
          cwd: '/tmp',
        }));
        reg.defineInstance(IFileSystemStorageService, new FileStorageService(homeDir));
        reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
        reg.define(ISessionExternalDelegationProvisionStore, SessionExternalDelegationProvisionStore);
      },
    });
    store = ix.get(ISessionExternalDelegationProvisionStore);
    documents = ix.get(IAtomicDocumentStore);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('round-trips a dedicated provision', async () => {
    await store.write({ version: 1, ownership: 'dedicated' });
    await expect(store.read()).resolves.toEqual({ version: 1, ownership: 'dedicated' });
  });

  it('round-trips an attached provision', async () => {
    await store.write({ version: 1, ownership: 'attached' });
    await expect(store.read()).resolves.toEqual({ version: 1, ownership: 'attached' });
  });

  it('round-trips a seat provision', async () => {
    await store.write({
      version: 2,
      ownership: 'dedicated',
      principalId: 'cursor',
      delegationToken: 'secret',
    });
    await expect(store.read()).resolves.toEqual({
      version: 2,
      ownership: 'dedicated',
      principalId: 'cursor',
      delegationToken: 'secret',
    });
  });

  it('returns undefined when nothing was written', async () => {
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed on an unknown version', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', {
      version: 3,
      ownership: 'dedicated',
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed when the version is missing', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', {
      ownership: 'dedicated',
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed on an invalid ownership value', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', {
      version: 1,
      ownership: 'owner',
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed on invalid seat ownership', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', {
      version: 2,
      ownership: 'attached',
      principalId: 'cursor',
      delegationToken: 'secret',
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed when seat credentials are missing', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', {
      version: 2,
      ownership: 'dedicated',
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('revokes a provision', async () => {
    await store.write({
      version: 2,
      ownership: 'dedicated',
      principalId: 'cursor',
      delegationToken: 'secret',
    });
    await store.revoke();
    await expect(store.read()).resolves.toBeUndefined();
  });

  it('fails closed on a non-object document', async () => {
    await documents.set('external-delegation-provisions/ws-1', 'session_ext_1', 'dedicated');
    await expect(store.read()).resolves.toBeUndefined();
  });
});
