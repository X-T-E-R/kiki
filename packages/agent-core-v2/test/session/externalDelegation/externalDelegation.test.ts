import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type IWaitUntil } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import type { ErrorCode } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
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
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IModelService } from '#/kosong/model/model';
import type { SessionWillCloseEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';

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
  let runAgentIds: string[];
  let runPrompts: string[];
  let createdWith: unknown[];
  let willClose: Emitter<SessionWillCloseEvent & IWaitUntil>;
  let logCalls: Array<{ msg: string; payload: unknown }>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    documents = new Map();
    handles = new Map();
    completions = [];
    nextRunHandleGate = undefined;
    runSignals = [];
    runAgentIds = [];
    runPrompts = [];
    createdWith = [];
    logCalls = [];

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
    ix.stub(IModelService, { resolveId: (id: string) => id });
    willClose = new Emitter<SessionWillCloseEvent & IWaitUntil>();
    disposables.add(willClose);
    ix.set(ISessionManager, {
      _serviceBrand: undefined,
      onWillCloseSession: willClose.event,
    } as unknown as ISessionManager);
    ix.stub(ILogService, {
      _serviceBrand: undefined,
      level: 'off',
      error: (msg: string, payload: unknown) => { logCalls.push({ msg, payload }); },
      warn: () => {},
      info: () => {},
      debug: () => {},
      setLevel: () => {},
      flush: async () => {},
      child: () => ix.get(ILogService),
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : undefined,
      getDefault: () => profile,
      list: () => [profile],
    });

    const makeHandle = (
      id: string,
      profileName: string,
      modelAlias = 'model',
      thinkingLevel = 'off',
      profileDefinitionId?: string,
    ): IAgentScopeHandle => {
      const agent = new TestInstantiationService();
      disposables.add(agent);
      agent.stub(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => ({ modelAlias, modelCapabilities: UNKNOWN_CAPABILITY, profileName, profileDefinitionId, thinkingLevel, systemPrompt: '', subagents: ['coder'] }),
      });
      agent.stub(IAgentPermissionModeService, { mode: 'auto', setMode: () => {} });
      agent.stub(IAgentUserToolService, { inheritUserTools: () => {} });
      const runtime = new FakeRuntime(
        { workspaceId: 'workspace_test', runtimeId: 'local', generation: 'test' },
        { capabilities: ['process'] },
      );
      agent.set(IAgentRuntimeService, {
        _serviceBrand: undefined,
        onDidChange: () => ({ dispose: () => {} }),
        inspect: () => runtime,
        isAvailable: () => true,
        acquire: () => ({ runtime, dispose: () => {}, track: () => {} }),
      } as unknown as IAgentRuntimeService);
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
        const handle = makeHandle(
          'external-child',
          opts?.binding?.profile ?? 'coder',
          opts?.binding?.model,
          opts?.binding?.thinking,
          opts?.binding?.resolvedProfile?.definitionId,
        );
        handles.set(handle.id, handle);
        return handle;
      },
    });
    ix.stub(ISessionSubagentService, {
      _serviceBrand: undefined,
      run: async (agentId, request, opts) => {
        runAgentIds.push(agentId);
        if (request.kind === 'prompt') runPrompts.push(request.prompt);
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
      runtimeId: 'local',
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

  it('binds an exact model and effort only when creating a named child', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const first = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'exact_binding',
      profileName: 'coder',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
      message: 'inspect',
    });

    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'coder',
        model: 'grok-4.6',
        thinking: 'high',
        strictThinking: true,
      },
      delegator: { kind: 'external' },
    });
    expect(first).toMatchObject({
      target: 'named',
      taskName: 'exact_binding',
      profileName: 'coder',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
    });
    expect(runAgentIds).toEqual(['external-child']);
    expect(runAgentIds).not.toContain('main');

    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: first.dispatchId })).status).toBe('completed');
    });

    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'exact_binding',
        modelAlias: 'other-model',
        message: 'switch',
      }),
    ).rejects.toThrow(/cannot change model_alias/);
    await expect(
      service.dispatch({
        authority,
        target: 'named',
        taskName: 'exact_binding',
        thinkingEffort: 'low',
        message: 'switch',
      }),
    ).rejects.toThrow(/cannot change thinking_effort/);

    const repeated = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'exact_binding',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'high',
      message: 'same binding',
    });
    expect(repeated).toMatchObject({ modelAlias: 'grok-4.6', thinkingEffort: 'high' });
    expect(createdWith).toHaveLength(1);
  });

  it('binds a scoped named child from the main profile snapshot', async () => {
    const publicWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'public-writer',
      description: 'Public writer',
      systemPrompt: () => 'PUBLIC',
      renderSystemPrompt: () => ({ text: 'PUBLIC', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PUBLIC PREFIX',
    };
    const scopedWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'private-writer',
      description: 'Private writer',
      systemPrompt: () => 'PRIVATE',
      renderSystemPrompt: () => ({ text: 'PRIVATE', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PRIVATE PREFIX',
    };
    const snapshot = {
      publicProfiles: new Map([['writer', publicWriter]]),
      defaultProfile: profile,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'writer',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'writer',
                source: './_private/writer.md',
                lease: { name: 'writer', source: './_private/writer.md' },
                status: 'ready' as const,
                sourceDefinitionId: 'private-writer',
                profile: scopedWriter,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map([['private-writer', scopedWriter]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      profileDefinitionId: 'parent-definition',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['writer'],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      getDefault: () => profile,
      list: () => [...snapshot.publicProfiles.values()],
      snapshot: () => snapshot,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);
    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_writer',
      profileName: 'writer',
      message: 'write',
    });

    expect(root.dispatchables).toContainEqual({
      kind: 'named',
      profileName: 'writer',
      description: 'Private writer',
    });
    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'writer',
        resolvedProfile: scopedWriter,
      },
    });
    expect(dispatch.profileName).toBe('writer');
    await vi.waitFor(() => {
      expect(runPrompts).toEqual(['PRIVATE PREFIX\n\nwrite']);
    });
    completions[0]!.resolve({ summary: 'done' });
    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('completed');
    });

    await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_writer',
      message: 'write again',
    });

    await vi.waitFor(() => {
      expect(runPrompts).toEqual([
        'PRIVATE PREFIX\n\nwrite',
        'PRIVATE PREFIX\n\nwrite again',
      ]);
    });
  });

  it('starts a scoped named child without a same-name public profile', async () => {
    const scopedWriter: AgentProfile = {
      name: 'writer',
      definitionId: 'private-only-writer',
      description: 'Private-only writer',
      systemPrompt: () => 'PRIVATE ONLY',
      renderSystemPrompt: () => ({ text: 'PRIVATE ONLY', environment: { cwd: '', date: { disclosed: false } } }),
      promptPrefix: async () => 'PRIVATE ONLY PREFIX',
    };
    const snapshot = {
      publicProfiles: new Map([['coder', profile]]),
      defaultProfile: profile,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'writer',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'writer',
                source: './_private/writer.md',
                lease: { name: 'writer', source: './_private/writer.md' },
                status: 'ready' as const,
                sourceDefinitionId: 'private-only-writer',
                profile: scopedWriter,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map([['private-only-writer', scopedWriter]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      profileDefinitionId: 'parent-definition',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['writer'],
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => snapshot.publicProfiles.get(name),
      getDefault: () => profile,
      list: () => [...snapshot.publicProfiles.values()],
      snapshot: () => snapshot,
    });
    const service = ix.get(ISessionExternalDelegationService);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'private_only_writer',
      profileName: 'writer',
      message: 'write',
    });

    expect(dispatch.status).toBe('queued');
    await vi.waitFor(() => {
      expect(runPrompts).toEqual(['PRIVATE ONLY PREFIX\n\nwrite']);
    });
  });

  it('rejects named-child binding fields for a main dispatch', async () => {
    const service = ix.get(ISessionExternalDelegationService);

    await expect(
      service.dispatch({
        authority,
        target: 'main',
        modelAlias: 'grok-4.6',
        message: 'work',
      }),
    ).rejects.toThrow(/not admitted for target main/);
    expect(runAgentIds).toEqual([]);
  });

  it('uses the same effective target list and lease as in-process delegation', async () => {
    const mainProfile: AgentProfile = {
      name: 'agent',
      main: true,
      description: 'Main profile',
      systemPrompt: () => 'main',
      renderSystemPrompt: () => ({ text: 'main', environment: { cwd: '', date: { disclosed: false } } }),
    };
    vi.spyOn(handles.get('main')!.accessor.get(IAgentProfileService), 'data').mockReturnValue({
      modelAlias: 'model',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: '',
      subagents: ['agent', 'coder'],
      subagentLeases: {
        coder: {
          name: 'coder',
          description: 'Leased code owner',
          modelAlias: 'leased-model',
        },
      },
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) => name === profile.name ? profile : name === mainProfile.name ? mainProfile : undefined,
      getDefault: () => mainProfile,
      list: () => [mainProfile, profile],
    } as unknown as ISessionAgentProfileCatalog);
    const service = ix.get(ISessionExternalDelegationService);

    const root = await service.list(authority);
    expect(root.dispatchables).toEqual([
      { kind: 'main' },
      {
        kind: 'named',
        profileName: 'coder',
        description: 'Leased code owner',
      },
    ]);

    const dispatch = await service.dispatch({
      authority,
      target: 'named',
      taskName: 'leased_coder',
      profileName: 'coder',
      message: 'work',
    });

    expect(dispatch.modelAlias).toBe('leased-model');
    expect(createdWith[0]).toMatchObject({
      binding: {
        profile: 'coder',
        model: 'leased-model',
        lease: {
          name: 'coder',
          description: 'Leased code owner',
          modelAlias: 'leased-model',
        },
      },
    });
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

  it('classifies provider auth failures: category crosses the edge, raw text stays in the log', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });
    const raw = '401 Unauthorized: Bearer sk-live-SEEDED at C:\\Users\\secret-user\\credentials.json';
    completions[0]!.reject(new Error2('provider.auth_error', raw));

    await vi.waitFor(async () => {
      expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
    });
    const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
    const result = await service.result({ authority, dispatchId: dispatch.dispatchId });
    const persisted = JSON.stringify(documents.get('root'));

    expect(status.errorCode).toBe('auth_expired');
    expect(result.text).toBe(
      'External agent authentication expired or was rejected; re-authenticate the provider and retry.',
    );
    expect(persisted).not.toContain('sk-live-SEEDED');
    expect(persisted).not.toContain('secret-user');
    expect(persisted).not.toContain(raw);

    const failure = logCalls.find((entry) => entry.msg === 'External dispatch failed.');
    expect(failure?.payload).toMatchObject({
      dispatchId: dispatch.dispatchId,
      sessionId: 'session_test',
      code: 'provider.auth_error',
      category: 'auth_expired',
      raw,
    });
  });

  it('classifies quota, model, network, and validation failures onto the stable taxonomy', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const cases: Array<{ code: ErrorCode; category: string }> = [
      { code: 'provider.rate_limit', category: 'quota_exceeded' },
      { code: 'model.not_found', category: 'model_not_supported' },
      { code: 'provider.connection_error', category: 'network' },
      { code: 'validation.failed', category: 'invalid_input' },
    ];
    for (const [index, { code, category }] of cases.entries()) {
      const dispatch = await service.dispatch({ authority, target: 'main', message: `work ${index}` });
      completions.at(-1)!.reject(new Error2(code, `raw detail ${code}`));
      await vi.waitFor(async () => {
        expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('failed');
      });
      const status = await service.status({ authority, dispatchId: dispatch.dispatchId });
      expect(status.errorCode, code).toBe(category);
      const persisted = JSON.stringify(documents.get('root'));
      expect(persisted, code).not.toContain(`raw detail ${code}`);
    }
  });

  it('persists interruption before the Session close hook proceeds', async () => {
    const service = ix.get(ISessionExternalDelegationService);
    const dispatch = await service.dispatch({ authority, target: 'main', message: 'work' });

    const waits: Promise<unknown>[] = [];
    willClose.fire({
      sessionId: 'session_test',
      handle: {} as never,
      reason: 'exit',
      signal: new AbortController().signal,
      waitUntil: (promise) => {
        waits.push(Promise.resolve(promise));
      },
    });
    await Promise.all(waits);

    expect((await service.status({ authority, dispatchId: dispatch.dispatchId })).status).toBe('interrupted');
    expect(documents.get('root')).toMatchObject({ lastCloseReason: 'exit' });
  });
});
