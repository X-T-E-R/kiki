import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCollaborationRegistry } from '#/session/agentCollaboration/registry';
import {
  type ExternalAuthority,
  ISessionExternalDelegationService,
} from '#/session/externalDelegation/externalDelegation';
import { SessionExternalDelegationService } from '#/session/externalDelegation/externalDelegationService';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import type { Hooks } from '#/hooks';
import { createHooks } from '#/hooks';

const authority: ExternalAuthority = {
  principalFingerprint: 'a'.repeat(64),
  authorityFingerprint: 'b'.repeat(64),
  configFingerprint: 'c'.repeat(64),
};

const profile: AgentProfile = {
  name: 'coder',
  description: 'Code owner',
  systemPrompt: () => 'coder',
  renderSystemPrompt: () => ({ text: 'coder', environment: { cwd: '', date: { disclosed: false } } }),
};

describe('SessionExternalDelegationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let documents: Map<string, unknown>;
  let handles: Map<string, IAgentScopeHandle>;
  let completions: Array<{ resolve(value: { summary: string }): void; reject(error: unknown): void }>;
  let nextRunHandleGate: Promise<void> | undefined;
  let runSignals: AbortSignal[];
  let createdWith: unknown[];
  let lifecycleHooks: Hooks<SessionLifecycleHookSlots>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    documents = new Map();
    handles = new Map();
    completions = [];
    nextRunHandleGate = undefined;
    runSignals = [];
    createdWith = [];

    ix.stub(IFlagService, { enabled: () => true });
    ix.stub(IAtomicDocumentStore, {
      _serviceBrand: undefined,
      get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
      set: async (_scope, key, value) => { documents.set(key, structuredClone(value)); },
      delete: async () => {},
      list: async () => [],
      watch: () => () => ({ dispose: () => {} }),
      acquire: () => ({ dispose: () => {} }),
    });
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'session_test',
      workspaceId: 'workspace_test',
      sessionDir: '',
      metaScope: '',
      cwd: '/workspace',
      scope: (key?: string) => `session/${key ?? ''}`,
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: async () => ({ id: 'session_test', createdAt: 0, updatedAt: 0, archived: false, agents: {} }),
    });
    ix.stub(ISessionWorkspaceContext, { _serviceBrand: undefined, workDir: '/workspace', additionalDirs: [] });
    ix.stub(ISessionProcessRunner, {});
    ix.stub(ILogService, { level: 'off', child: () => ix.get(ILogService) });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : undefined,
      getDefault: () => profile,
      list: () => [profile],
    });

    const makeHandle = (id: string, profileName: string): IAgentScopeHandle => {
      const agent = new TestInstantiationService();
      disposables.add(agent);
      agent.stub(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => ({ modelAlias: 'model', modelCapabilities: UNKNOWN_CAPABILITY, profileName, thinkingLevel: 'off', systemPrompt: '', subagents: ['coder'] }),
      });
      agent.stub(IAgentPermissionModeService, { mode: 'auto', setMode: () => {} });
      agent.stub(IAgentUserToolService, { inheritUserTools: () => {} });
      agent.stub(IAgentContextMemoryService, { get: () => [] });
      agent.stub(IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) });
      return { id, accessor: agent } as unknown as IAgentScopeHandle;
    };
    handles.set('main', makeHandle('main', 'agent'));
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      get: (id) => handles.get(id),
      create: async (opts) => {
        createdWith.push(opts);
        const handle = makeHandle('external-child', opts?.binding?.profile ?? 'coder');
        handles.set(handle.id, handle);
        return handle;
      },
    });
    ix.stub(ISessionSubagentService, {
      _serviceBrand: undefined,
      run: async (agentId, _request, opts) => {
        runSignals.push(opts.signal);
        const gate = nextRunHandleGate;
        nextRunHandleGate = undefined;
        if (gate !== undefined) await gate;
        let resolve!: (value: { summary: string }) => void;
        let reject!: (error: unknown) => void;
        const completion = new Promise<{ summary: string }>((res, rej) => { resolve = res; reject = rej; });
        completions.push({ resolve, reject });
        return { agentId, turn: {} as never, completion };
      },
    });
    ix.stub(IAgentCollaborationRegistry, {
      _serviceBrand: undefined,
      reserve: async () => true,
      commit: () => {},
      release: () => {},
    });
    lifecycleHooks = createHooks<SessionLifecycleHookSlots, keyof SessionLifecycleHookSlots>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]);
    ix.set(ISessionLifecycleHooks, lifecycleHooks);
    ix.set(ISessionExternalDelegationService, new SyncDescriptor(SessionExternalDelegationService));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('owns named work under an external root and enforces one active dispatch', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const first = await service.dispatch({ authority, target: 'named', taskName: 'reviewer', profileName: 'coder', message: 'review' });
    expect(first.status).toBe('queued');
    expect(createdWith[0]).toMatchObject({
      delegator: { kind: 'external', delegationId: expect.stringMatching(/^delegation_/) },
      labels: { externalDelegationTaskName: 'reviewer' },
    });
    await expect(service.dispatch({ authority, target: 'named', taskName: 'reviewer', message: 'again' })).rejects.toThrow(/active dispatch/);

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: first.dispatchId })).status).toBe(
        'completed',
      );
    });
    const continued = await service.continue({ authority, dispatchId: first.dispatchId, message: 'continue' });
    expect(continued.continuationOf).toBe(first.dispatchId);
    expect(createdWith).toHaveLength(1);
  });

  it('keeps the external contract profile-only instead of advertising an unselectable route', async () => {
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : undefined,
      getDefault: () => profile,
      list: () => [profile],
      listRoutes: () => [{
        id: 'coder.review',
        profile: 'coder',
        description: 'Review route',
        overriddenFields: ['tools'],
      }],
    } as unknown as ISessionAgentProfileCatalog);
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);

    expect(root.dispatchables).toEqual([
      { kind: 'main' },
      { kind: 'named', profileName: 'coder', description: 'Code owner' },
    ]);
    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'routed',
        profileName: 'coder.review',
        message: 'review',
      }),
    ).rejects.toThrow('Unknown named-agent profile');
    expect(createdWith).toEqual([]);
  });

  it('rejects another principal and unknown dispatch handles', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    await service.list(authority);
    await expect(service.list({ ...authority, principalFingerprint: 'd'.repeat(64) })).rejects.toThrow(/does not own/);
    await expect(service.status({ authority, dispatchId: 'dispatch_unknown' })).rejects.toThrow(/Unknown external dispatch/);
  });

  it('marks a persisted nonterminal dispatch interrupted instead of claiming it resumed', async () => {
    documents.set('root', {
      version: 1,
      delegationId: 'delegation_cold',
      principalFingerprint: authority.principalFingerprint,
      authorityFingerprint: authority.authorityFingerprint,
      configFingerprint: authority.configFingerprint,
      lifecycle: 'active',
      createdAt: 1,
      children: {},
      dispatches: {
        dispatch_cold: {
          dispatchId: 'dispatch_cold',
          target: 'main',
          agentId: 'main',
          status: 'running',
          createdAt: 1,
          startedAt: 2,
          transcriptStart: 0,
        },
      },
      events: [],
      nextEventSeq: 1,
    });

    const service = ix.get(ISessionExternalDelegationService);
    expect((await service.status({ authority, dispatchId: 'dispatch_cold' })).status).toBe('interrupted');
  });

  it('cancels idempotently without cancelling sibling work', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
  });

  it('does not publish started after cancellation wins a deferred run-handle race', async () => {
    let releaseRunHandle!: () => void;
    nextRunHandleGate = new Promise<void>((resolve) => { releaseRunHandle = resolve; });
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    expect(dispatch.status).toBe('queued');

    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect((await service.cancel({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    expect(runSignals[0]?.aborted).toBe(true);
    releaseRunHandle();
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('cancelled');
    });
    const eventTypes = (await service.events({ authority, dispatchId: dispatch.dispatchId })).items.map((event) => event.type);
    expect(eventTypes).toEqual(['queued', 'cancelled']);

    const later = await service.dispatch({ authority, target: 'main', message: 'later work' });
    expect(later.status).toBe('queued');
    expect(later.dispatchId).not.toBe(dispatch.dispatchId);
  });

  it('persists only typed, redacted, byte-bounded external failures', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const secret = 'SEEDED_SECRET_TOKEN';
    const path = 'C:\\Users\\secret-user\\credentials.json';
    const url = 'https://provider.invalid/private?api_key=SEEDED_API_KEY';
    completions[0]!.reject(new Error(`${'failure '.repeat(300)} Bearer ${secret} at ${path} via ${url}`));

    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
    });
    const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
    const result = await service.result({ authority, dispatchId: dispatch.dispatchId });
    const events = await service.events({ authority, dispatchId: dispatch.dispatchId });
    const persisted = JSON.stringify(documents.get('root'));

    expect(status.errorCode).toBe('internal');
    expect(result.text).toBe('External agent run failed.');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(512);
    expect(events.items.at(-1)).toMatchObject({ type: 'failed', message: result.text });
    for (const projection of [persisted, JSON.stringify(result), JSON.stringify(events)]) {
      expect(projection).not.toContain(secret);
      expect(projection).not.toContain('SEEDED_API_KEY');
      expect(projection).not.toContain(path);
      expect(projection).not.toContain(url);
    }
  });

  it('persists interruption before the Session close hook proceeds', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });

    await lifecycleHooks.onWillCloseSession.run({ reason: 'exit' });

    expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('interrupted');
    expect(documents.get('root')).toMatchObject({ lastCloseReason: 'exit' });
  });
});
