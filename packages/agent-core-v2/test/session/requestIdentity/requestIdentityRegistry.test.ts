import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IRequestIdentityInstallation,
  RequestIdentityInstallation,
  RequestIdentityRegistry,
} from '#/session/requestIdentity/requestIdentityRegistry';

interface RegistryStore {
  value?: unknown;
  reads?: number;
  writes?: number;
  installationGets?: number;
}

function createInstallation(store: RegistryStore): RequestIdentityInstallation {
  const ix = new TestInstantiationService();
  ix.stub(IBootstrapService, { scope: (name: string) => `bootstrap/${name}` });
  ix.stub(IAtomicDocumentStore, {
    get: async <T>() => {
      store.reads = (store.reads ?? 0) + 1;
      return structuredClone(store.value) as T | undefined;
    },
    set: async (_scope, _key, value) => {
      store.writes = (store.writes ?? 0) + 1;
      store.value = structuredClone(value);
    },
  });
  return ix.createInstance(RequestIdentityInstallation);
}

function createRegistry(
  store: RegistryStore = {},
  options: { sessionId?: string; installationId?: string } = {},
): RequestIdentityRegistry {
  const sessionId = options.sessionId ?? 'session-internal-key';
  const ix = new TestInstantiationService();
  ix.stub(ISessionContext, {
    sessionId,
    scope: (key?: string) => `sessions/${sessionId}/${key ?? ''}`,
  });
  ix.stub(ISessionMetadata, {
    read: async () => ({
      id: sessionId,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      archived: false,
    }),
  });
  ix.stub(IRequestIdentityInstallation, {
    get: async () => {
      store.installationGets = (store.installationGets ?? 0) + 1;
      return options.installationId ?? '00000000-0000-4000-8000-000000000001';
    },
  });
  ix.stub(IAtomicDocumentStore, {
    get: async <T>() => {
      store.reads = (store.reads ?? 0) + 1;
      return structuredClone(store.value) as T | undefined;
    },
    set: async (_scope, _key, value) => {
      store.writes = (store.writes ?? 0) + 1;
      store.value = structuredClone(value);
    },
  });
  return ix.createInstance(RequestIdentityRegistry);
}

describe('request identity registry', () => {
  it('performs no identity or document allocation when every dimension is disabled', async () => {
    const store: RegistryStore = {};
    const snapshot = await createRegistry(store).snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
      dimensions: {
        installationIdentity: false,
        sharedSessionIdentity: false,
        agentSessionIdentity: false,
        threadIdentity: false,
        logicalRequestIdentity: false,
        turnIndex: false,
        turnState: false,
      },
    });

    expect(snapshot).toEqual({
      installationId: undefined,
      sharedSessionId: undefined,
      threadId: undefined,
      agentSessionId: undefined,
      logicalId: undefined,
      turnIndex: undefined,
      parentTurnId: undefined,
      rootTurnId: undefined,
      parentThreadId: undefined,
      windowId: undefined,
      turnState: undefined,
      setTurnState: expect.any(Function),
    });
    expect(store).toEqual({});
  });

  it('derives logical IDs without persisting an unused accepted-turn ordinal', async () => {
    const store: RegistryStore = {};
    const registry = createRegistry(store);
    const dimensions = {
      installationIdentity: false,
      sharedSessionIdentity: false,
      agentSessionIdentity: false,
      threadIdentity: false,
      logicalRequestIdentity: true,
      turnIndex: false,
      turnState: false,
    } as const;
    const first = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
      dimensions,
    });
    const retry = await registry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
      dimensions,
    });

    expect(retry.logicalId).toBe(first.logicalId);
    expect(first.turnIndex).toBeUndefined();
    expect(store.installationGets).toBeUndefined();
    expect(store.reads).toBeUndefined();
    expect(store.writes).toBeUndefined();
  });

  it('persists one installation identity across app/process reconstruction', async () => {
    const store: RegistryStore = {};
    const first = await createInstallation(store).get();
    const reconstructed = await createInstallation(store).get();

    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(reconstructed).toBe(first);
  });

  it('keeps Grok installation, agent-session, logical-request, and accepted-turn scopes distinct', async () => {
    const installationId = '00000000-0000-4000-8000-000000000001';
    const firstSessionStore: RegistryStore = {};
    const firstRegistry = createRegistry(firstSessionStore, {
      sessionId: 'session-a',
      installationId,
    });
    const first = await firstRegistry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const retry = await firstRegistry.snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const next = await firstRegistry.snapshot({
      agentId: 'main',
      turnKey: 'turn:9',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const child = await firstRegistry.snapshot({
      agentId: 'child',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const reloaded = await createRegistry(firstSessionStore, {
      sessionId: 'session-a',
      installationId,
    }).snapshot({
      agentId: 'main',
      turnKey: 'turn:9',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });
    const otherSession = await createRegistry({}, {
      sessionId: 'session-b',
      installationId,
    }).snapshot({
      agentId: 'main',
      turnKey: 'turn:0',
      compactionWindow: 0,
      logicalIdKind: 'uuidv4',
    });

    expect(first.installationId).toBe(installationId);
    expect(otherSession.installationId).toBe(installationId);
    expect(retry.agentSessionId).toBe(first.agentSessionId);
    expect(child.agentSessionId).not.toBe(first.agentSessionId);
    expect(otherSession.agentSessionId).not.toBe(first.agentSessionId);
    expect(retry.logicalId).toBe(first.logicalId);
    expect(next.logicalId).not.toBe(first.logicalId);
    expect(retry.turnIndex).toBe(1);
    expect(next.turnIndex).toBe(2);
    expect(reloaded.logicalId).toBe(next.logicalId);
    expect(reloaded.turnIndex).toBe(2);
  });

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
