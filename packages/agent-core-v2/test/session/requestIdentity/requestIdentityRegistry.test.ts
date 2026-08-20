import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IRequestIdentityInstallation,
  RequestIdentityRegistry,
} from '#/session/requestIdentity/requestIdentityRegistry';

interface RegistryStore {
  value?: unknown;
}

function createRegistry(store: RegistryStore = {}): RequestIdentityRegistry {
  const ix = new TestInstantiationService();
  ix.stub(ISessionContext, {
    sessionId: 'session-internal-key',
    scope: (key?: string) => `sessions/session-internal-key/${key ?? ''}`,
  });
  ix.stub(ISessionMetadata, {
    read: async () => ({
      id: 'session-internal-key',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      archived: false,
    }),
  });
  ix.stub(IRequestIdentityInstallation, {
    get: async () => '00000000-0000-4000-8000-000000000001',
  });
  ix.stub(IAtomicDocumentStore, {
    get: async <T>() => structuredClone(store.value) as T | undefined,
    set: async (_scope, _key, value) => {
      store.value = structuredClone(value);
    },
  });
  return ix.createInstance(RequestIdentityRegistry);
}

describe('request identity registry', () => {
  it('keeps session, turn, index, lineage, and retry lifetimes distinct', async () => {
    const registry = createRegistry();
    const root = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv7',
    });
    const retry = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv7',
    });
    const next = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:2',
      compactionWindow: 1,
      logicalIdKind: 'uuidv7',
    });
    const child = await registry.snapshot({
      agentId: 'child',
      parentAgentId: 'main',
      parentTurnKey: 'turn:0',
      rootAgentId: 'main',
      rootTurnKey: 'turn:0',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv7',
    });

    expect(root.sharedSessionId).toBe(root.threadId);
    expect(retry.logicalId).toBe(root.logicalId);
    root.setTurnState('sticky-state');
    const continued = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv7',
    });
    expect(continued.turnState).toBe('sticky-state');
    expect(next.logicalId).not.toBe(root.logicalId);
    expect(next.turnIndex).toBe(2);
    expect(next.windowId).toBe(`${root.threadId}:2`);
    expect(child.sharedSessionId).toBe(root.sharedSessionId);
    expect(child.threadId).not.toBe(root.threadId);
    expect(child.parentThreadId).toBe(root.threadId);
    expect(child.parentTurnId).toBe(root.logicalId);
    expect(child.rootTurnId).toBe(root.logicalId);
  });

  it('reconstructs stable session and accepted-turn IDs after resume', async () => {
    const store: RegistryStore = {};
    const first = await createRegistry(store).snapshot({
      agentId: 'main',
      turnKey: 'turn:4',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const resumedRegistry = createRegistry(store);
    const resumed = await resumedRegistry.snapshot({
      agentId: 'main',
      turnKey: 'turn:4',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    expect(resumed.sharedSessionId).toBe(first.sharedSessionId);
    expect(resumed.agentSessionId).toBe(first.agentSessionId);
    expect(resumed.logicalId).toBe(first.logicalId);
    const next = await resumedRegistry.snapshot({
      agentId: 'main',
      turnKey: 'turn:9',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    expect(resumed.turnIndex).toBe(1);
    expect(next.turnIndex).toBe(2);
  });
});
