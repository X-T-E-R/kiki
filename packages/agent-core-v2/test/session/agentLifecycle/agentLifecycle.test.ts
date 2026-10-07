import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'pathe';
import { Error2, ErrorCodes } from '#/errors';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { IWireService } from '#/wire/wire';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { overrideScopedService, ScopeActivation, type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { IAgentProfileService } from '#/agent/profile/profile';
import { RESEARCH_READONLY_TOOLS } from '#/agent/profile/executionRestriction';
import '#/agent/profile/profileService';
import { ProfileBind } from '#/agent/profile/profileOps';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import '#/agent/permissionMode/permissionModeService';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IPersonaStore } from '#/app/persona/personaStore';
import { IShippedAgentProfileManager } from '#/app/shippedAgentProfiles/shippedAgentProfileManager';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import '#/agent/mcp/mcpService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import '#/wire/wireService';
import '#/state/eventDispatcherService';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { SessionCronServiceImpl } from '#/session/cron/sessionCronServiceImpl';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SECTION } from '#/app/cron/configSection';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { todoKey } from '#/session/todo/todoOps';
import { interactionKey } from '#/session/interaction/interactionOps';
import '#/agent/toolDedupe/toolDedupeService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { TurnStepCompleted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { AgentCollaborationRegistry, IAgentCollaborationRegistry, COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';
import { WIRE_TRANSCRIPT_RECEIPT_KEY, parseWireTranscriptReceipt } from '#/wire/transcriptReceipt';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { _clearAgentToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import '#/agent/toolActivation/toolActivationService';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import '#/agent/media/mediaToolsRegistrar';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { stubFlag } from '../../app/flag/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

const pluginServiceStub = {
  _serviceBrand: undefined,
  onDidReload: () => ({ dispose: () => {} }),
  listPlugins: async () => [],
  installPlugin: async () => ({ id: '' }) as never,
  setPluginEnabled: async () => {},
  setPluginMcpServerEnabled: async () => {},
  removePlugin: async () => {},
  reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
  getPluginInfo: async () => {
    throw new Error('getPluginInfo is not used by these tests');
  },
  listPluginCommands: async () => [],
  checkUpdates: async () => [],
  pluginSkillRoots: async () => [],
  enabledSessionStarts: async () => [],
  enabledMcpServers: async () => ({}),
  enabledHooks: async () => [],
} as unknown as IPluginService;

function recordingAppendLog(initial: readonly WireRecord[] = []): {
  readonly appended: WireRecord[];
  readonly store: IAppendLogStore;
  rewritten?: readonly WireRecord[];
} {
  const records = [...initial];
  const appended: WireRecord[] = [];
  const state: { rewritten?: readonly WireRecord[] } = {};
  const store: IAppendLogStore = {
    _serviceBrand: undefined,
    onDidWrite: Event.None as IAppendLogStore['onDidWrite'],
    append: <R>(_scope: string, _key: string, record: R) => {
      const persisted = record as unknown as WireRecord;
      records.push(persisted);
      appended.push(persisted);
    },
    read: async function* <R>(): AsyncIterable<R> {
      for (const record of records) {
        yield record as R;
      }
    },
    rewrite: <R>(_scope: string, _key: string, next: readonly R[]) => {
      const persisted = next as readonly WireRecord[];
      state.rewritten = persisted;
      records.splice(0, records.length, ...persisted);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    acquire: () => ({ dispose: () => {} }),
    drainRetirements: () => Promise.resolve(),
  };
  return {
    appended,
    get rewritten() {
      return state.rewritten;
    },
    store,
  };
}

function stubBlobPassThrough(ix: TestInstantiationService): void {
  ix.stub(IAgentBlobService, {
    _serviceBrand: undefined,
    offloadParts: async (parts) => parts,
    loadParts: async (parts) => parts,
    isBlobRef: () => false,
  } satisfies IAgentBlobService);
}

describe('AgentLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registerAgent: ReturnType<typeof vi.fn<ISessionMetadata['registerAgent']>>;
  let atomicDocs: Map<string, unknown>;
  let permissionModeSetMode: ReturnType<typeof vi.fn>;
  let stopAllOnExit: ReturnType<typeof vi.fn<IAgentTaskService['stopAllOnExit']>>;
  let loopActiveTurnId: number | undefined;
  let loopPendingTurnIds: number[];
  let loopCancel: ReturnType<typeof vi.fn<IAgentLoopService['cancel']>>;
  let loopSettled: ReturnType<typeof vi.fn<IAgentLoopService['settled']>>;
  let promptDrain: ReturnType<typeof vi.fn<IAgentPromptService['drain']>>;
  let executionCancel: ReturnType<typeof vi.fn<IAgentExecutionService['cancel']>>;
  let executionShutdown: ReturnType<typeof vi.fn<IAgentExecutionService['shutdown']>>;
  let beforeExecuteListeners: number;
  let didExecuteHookIds: string[];

  async function updateAgent(agentId: string, updater: Parameters<ISessionMetadata['updateAgent']>[1]): Promise<void> {
    const current = (await ix.get(ISessionMetadata).read()).agents?.[agentId];
    if (current !== undefined) await registerAgent(agentId, updater(structuredClone(current)));
  }

  function createTestHost(): void {
    _clearAgentToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(IAgentStateService, new AgentStateService());
    ix.get(IAgentStateService).contributeState(permissionModeKey);
    ix.get(IAgentStateService).contributeState(permissionModeConfiguredKey);
    ix.stub(IAppendLogStore, recordingAppendLog().store);
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    stubBlobPassThrough(ix);
    registerAgent = vi.fn<ISessionMetadata['registerAgent']>().mockResolvedValue(undefined);
    atomicDocs = new Map();
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-agentLifecycle-test',
      metaScope: 'test',
      scope: (subKey?: string) =>
        subKey === undefined || subKey === ''
          ? 'sessions/ws_test/sess_test'
          : `sessions/ws_test/sess_test/${subKey}`,
    } as unknown as ISessionContext);
    ix.stub(IRuntimeResolver, {
      _serviceBrand: undefined,
      inspect: (binding) => new FakeRuntime({ ...binding, generation: `${binding.runtimeId}-one` }),
      acquire: (binding) => ({
        runtime: new FakeRuntime({ ...binding, generation: `${binding.runtimeId}-one` }),
        track: (resource) => resource,
        dispose: () => {},
      }),
    });
    ix.stub(IWorkspaceInstanceManager, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      get: () => undefined,
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({ id: 'sess_test', createdAt: 0, updatedAt: 0, archived: false }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent,
      updateAgent,
    });
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/tmp/kimi-agentLifecycle-home',
      cwd: '/tmp/kimi-agentLifecycle-home',
      getEnv: () => undefined,
    } as unknown as IBootstrapService);
    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: '/tmp/kimi-agentLifecycle-work',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext);
    ix.stub(IPluginService, pluginServiceStub);
    ix.stub(IPluginHostService, { _serviceBrand: undefined, list: async () => [] });
    ix.stub(IFlagService, stubFlag(false));
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => undefined) as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);
    const atomicDocsStore: IAtomicDocumentStore = {
      _serviceBrand: undefined,
      get: async <T>(scope: string, key: string): Promise<T | undefined> =>
        atomicDocs.get(`${scope}/${key}`) as T | undefined,
      set: async <T>(scope: string, key: string, value: T): Promise<void> => {
        atomicDocs.set(`${scope}/${key}`, value);
      },
      update: async <T>(
        scope: string,
        key: string,
        updater: (current: T | undefined) => T | undefined,
      ): Promise<T | undefined> => {
        const id = `${scope}/${key}`;
        const current = atomicDocs.get(id) as T | undefined;
        const next = updater(current);
        if (next !== undefined && next !== current) atomicDocs.set(id, next);
        return next ?? current;
      },
      delete: async (scope: string, key: string): Promise<void> => {
        atomicDocs.delete(`${scope}/${key}`);
      },
      list: async (scope: string, prefix = ''): Promise<readonly string[]> =>
        [...atomicDocs.keys()]
          .filter((key) => key.startsWith(`${scope}/${prefix}`))
          .map((key) => key.slice(scope.length + 1)),
      watch: () => Event.None as Event<void>,
      acquire: () => ({ dispose: () => {} }),
    };
    ix.stub(IAtomicDocumentStore, atomicDocsStore);
    ix.stub(ILogService, noopLog);
    ix.stub(IAgentPluginService, {
      _serviceBrand: undefined,
      refreshSessionStart: async () => {},
    });
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      resolve: () => undefined,
      list: () => [],
    } as unknown as IAgentToolRegistryService);
    ix.stub(IAgentMediaToolsRegistrar, {
      _serviceBrand: undefined,
      refresh: () => {},
    } satisfies IAgentMediaToolsRegistrar);
    beforeExecuteListeners = 0;
    didExecuteHookIds = [];
    ix.stub(IAgentToolExecutorService, {
      _serviceBrand: undefined,
      onBeforeExecuteTool: () => {
        beforeExecuteListeners += 1;
        return { dispose: () => {} };
      },
      onWillExecuteTool: () => ({ dispose: () => {} }),
      hooks: {
        onDidExecuteTool: {
          register: (id: string) => {
            didExecuteHookIds.push(id);
            return { dispose: () => {} };
          },
        },
      },
    } as unknown as IAgentToolExecutorService);
    loopActiveTurnId = undefined;
    loopPendingTurnIds = [];
    loopCancel = vi.fn<IAgentLoopService['cancel']>((turnId) => {
      if (turnId === undefined) {
        loopActiveTurnId = undefined;
      } else {
        loopPendingTurnIds = loopPendingTurnIds.filter((id) => id !== turnId);
      }
      return true;
    });
    loopSettled = vi.fn<IAgentLoopService['settled']>(async () => {
      if (loopActiveTurnId !== undefined || loopPendingTurnIds.length > 0) {
        throw new Error('Agent loop did not settle');
      }
    });
    ix.stub(IAgentLoopService, {
      _serviceBrand: undefined,
      hooks: {
        onWillBeginStep: { register: () => ({ dispose: () => {} }) },
        onDidFinishStep: { register: () => ({ dispose: () => {} }) },
      },
      registerLoopErrorHandler: () => ({ dispose: () => {} }),
      status: () => ({
        state: loopActiveTurnId === undefined ? 'idle' : 'running',
        activeTurnId: loopActiveTurnId,
        pendingTurnIds: loopPendingTurnIds,
        hasPendingRequests: loopActiveTurnId !== undefined || loopPendingTurnIds.length > 0,
      }),
      cancel: loopCancel,
      settled: loopSettled,
    } as unknown as IAgentLoopService);
    promptDrain = vi.fn<IAgentPromptService['drain']>(async () => {});
    ix.stub(IAgentPromptService, {
      _serviceBrand: undefined,
      drain: promptDrain,
    });
    class StubPromptService {
      declare readonly _serviceBrand: undefined;
      drain = promptDrain;
    }
    overrideScopedService<Partial<IAgentPromptService>>(
      LifecycleScope.Agent, IAgentPromptService, StubPromptService, ScopeActivation.OnDemand,
    );
    executionCancel = vi.fn<IAgentExecutionService['cancel']>(() => false);
    executionShutdown = vi.fn<IAgentExecutionService['shutdown']>(async () => {});
    ix.stub(IAgentExecutionService, {
      _serviceBrand: undefined,
      run: async () => { throw new Error('unexpected run'); },
      status: () => ({
        state: loopActiveTurnId === undefined && loopPendingTurnIds.length === 0
          ? 'idle'
          : 'running',
        turnId: loopActiveTurnId,
      }),
      cancel: executionCancel,
      settled: loopSettled,
      shutdown: executionShutdown,
      hooks: { onWillRun: { register: () => ({ dispose: () => {} }) } },
    } as unknown as IAgentExecutionService);
    ix.stub(IAgentUsageService, {
      _serviceBrand: undefined,
      onDidRecord: Event.None,
    } as unknown as IAgentUsageService);
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2: () => {},
      withContext: () => ({
        _serviceBrand: undefined,
        track2: () => {},
      }) as unknown as ITelemetryService,
    } as unknown as ITelemetryService);
    ix.stub(IAgentTelemetryContextService, {
      _serviceBrand: undefined,
      get: () => ({ mode: 'agent' }),
      set: () => {},
    });
    ix.stub(IHostEnvironment, { _serviceBrand: undefined } as IHostEnvironment);
    ix.stub(IHostFileSystem, { _serviceBrand: undefined } as IHostFileSystem);
    ix.stub(IHostClock, { _serviceBrand: undefined } as IHostClock);
    ix.stub(IAgentExecutorRegistry, {
      _serviceBrand: undefined,
      get: () => ({ id: 'native', protocol: 'native', args: [], revision: 'native' }),
      resolve: () => ({
        descriptor: { id: 'native', protocol: 'native', args: [], revision: 'native' },
        options: {},
      }),
      resolveExecutable: async () => ({
        descriptor: { id: 'native', protocol: 'native', args: [], revision: 'native' },
        options: {},
      }),
      provider: () => undefined,
    });
    ix.stub(IModelCatalog, { _serviceBrand: undefined } as IModelCatalog);
    ix.stub(IModelService, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeModels: Event.None,
      onDidChangeDefaultModel: Event.None,
      resolveId: (id: string) => id,
      get: () => undefined,
      list: () => ({}),
      getDefaultModel: () => undefined,
    } as unknown as IModelService);
    ix.stub(ISessionInteractionService, {
      _serviceBrand: undefined,
      cancelPendingForTurn: () => {},
      listPending: () => [],
    } as unknown as ISessionInteractionService);
    ix.stub(IProtocolAdapterRegistry, {
      _serviceBrand: undefined,
    } as IProtocolAdapterRegistry);
    ix.stub(IBuiltinAgentProfileLoader, {
      _serviceBrand: undefined,
    } as IBuiltinAgentProfileLoader);
    ix.stub(IPromptFieldRegistry, {
      _serviceBrand: undefined,
      onDidChange: Event.None as IPromptFieldRegistry['onDidChange'],
      list: () => [],
      get: () => undefined,
      validate: () => ({ values: {}, fields: [] }),
      resolve: async () => ({ values: {}, fields: [] }),
    });
    ix.stub(IAgentIdentity, { _serviceBrand: undefined } as IAgentIdentity);
    ix.stub(IPersonaStore, { _serviceBrand: undefined });
    ix.stub(IShippedAgentProfileManager, {
      ready: Promise.resolve(),
      isCleanActivePath: () => false,
    });
    ix.stub(ISessionDeliveryService, {
      onDidChangeEffective: Event.None as ISessionDeliveryService['onDidChangeEffective'],
      effectiveMode: () => 'reply',
    });
    ix.stub(IAgentAgentsMdReminderService, {
      _serviceBrand: undefined,
    } as IAgentAgentsMdReminderService);
    ix.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentContextInjectorService);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => {
        throw new Error('catalog resolution is not expected');
      },
      list: () => [],
      load: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      onDidChange: Event.None,
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: { skills: [] },
      ready: Promise.resolve(),
      onDidChange: Event.None,
      load: () => Promise.resolve(),
      reload: () => Promise.resolve(),
    } as unknown as ISessionSkillCatalog);
    ix.stub(ISessionToolPolicy, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      disabledTools: () => [],
      setDisabledTools: () => Promise.resolve(),
    } as unknown as ISessionToolPolicy);
    ix.stub(ISessionToolPolicyGate, {
      _serviceBrand: undefined,
      disabledTools: [],
      onDidChange: Event.None as Event<void>,
    } satisfies ISessionToolPolicyGate);
    permissionModeSetMode = vi.fn();
    ix.stub(IAgentPermissionModeService, {
      _serviceBrand: undefined,
      mode: 'manual',
      setMode: permissionModeSetMode,
      onDidChangeMode: Event.None,
    } as unknown as IAgentPermissionModeService);
    ix.stub(ISessionInstructionsProvider, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      agentsMd: undefined,
      agentsMdWarning: undefined,
      agentsMdPaths: undefined,
      onDidChange: Event.None as Event<void>,
    } satisfies ISessionInstructionsProvider);
    ix.stub(IAgentAgentsMdReminderService, {
      _serviceBrand: undefined,
      seedInjected: () => {},
    });
    ix.stub(ISessionMcpHandle, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      connectionManager: new McpConnectionManager({
        log: noopLog,
        oauthService: new McpOAuthService({ store: createMcpOAuthStore(atomicDocsStore) }),
      }),
      isBaselineServer: () => true,
    } satisfies ISessionMcpHandle);
    stopAllOnExit = vi.fn(async () => []);
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      stopAllOnExit,
    } as unknown as IAgentTaskService);
    ix.stub(IAgentFullCompactionService, {
      _serviceBrand: undefined,
      compacting: null,
    } as unknown as IAgentFullCompactionService);
    ix.set(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService));
  }

  beforeEach(createTestHost);
  afterEach(async () => {
    await disposables.dispose();
    overrideScopedService(LifecycleScope.Agent, IAgentPromptService, AgentPromptService);
    vi.restoreAllMocks();
  });

  it.each([
    { imageIn: true, expected: true },
    { imageIn: false, expected: false },
  ])('rebuilds the resumed child media tool for its bound model (image_in=$imageIn)', async ({ imageIn, expected }) => {
    const modelAlias = 'provider/child-model';
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (alias: string) => {
        if (alias !== modelAlias) throw new Error(`Unexpected model: ${alias}`);
        return {
          id: modelAlias,
          name: 'Child model',
          aliases: [],
          protocol: 'anthropic',
          headers: {},
          capabilities: { ...UNKNOWN_CAPABILITY, image_in: imageIn, tool_use: true, max_context_tokens: 4096 },
          maxContextSize: 4096,
          alwaysThinking: false,
          providerName: 'provider',
          imagePolicy: { acceptedTypes: new Set(['image/png'] as const), convertUnsupported: 'off' },
          authProvider: { getAuth: async () => undefined },
        } satisfies ReturnType<IModelCatalog['get']>;
      },
      getRequester: () => { throw new Error('No requester needed'); },
    } as unknown as IModelCatalog);
    ix.stub(IRuntimeResolver, {
      _serviceBrand: undefined,
      inspect: (binding) => new FakeRuntime({ ...binding, generation: 'one' }, { capabilities: ['fs'] }),
      acquire: (binding) => ({
        runtime: new FakeRuntime({ ...binding, generation: 'one' }, { capabilities: ['fs'] }),
        track: (resource) => resource,
        dispose: () => {},
      }),
    });
    const tools = new Map<string, Parameters<IAgentToolRegistryService['register']>[0]>();
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      register: (tool: Parameters<IAgentToolRegistryService['register']>[0]) => {
        tools.set(tool.name, tool);
        return { dispose: () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        } };
      },
      resolve: (name: string) => tools.get(name),
      list: () => [],
    } as unknown as IAgentToolRegistryService);
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias,
        profileName: 'frontend',
        thinkingEffort: 'high',
        executorId: 'native',
        executorProtocol: 'native',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    const svc = ix.get(IAgentLifecycleService);
    const first = await svc.create({ agentId: 'child' });
    first.accessor.get(IAgentProfileService).republishStatus();
    await vi.waitFor(() => {
      expect(first.accessor.get(IAgentToolRegistryService).resolve('ReadMediaFile') !== undefined).toBe(expected);
    });
    await svc.remove('child');

    const resumed = await svc.create({ agentId: 'child' });
    expect(resumed.accessor.get(IAgentProfileService).data().modelAlias).toBe(modelAlias);
    expect(resumed.accessor.get(IAgentToolRegistryService).resolve('ReadMediaFile') !== undefined).toBe(expected);
  });

  it('counts and drains tasks across live agents without stopping them or conflating local task ids', async () => {
    const info = { kind: 'agent' as const, taskId: 'local-task', description: 'example', status: 'running' as const, startedAt: 0, endedAt: null };
    let pending = true;
    const suppress = vi.fn(async () => {});
    const wait = vi.fn(async () => {
      if (wait.mock.calls.length === 2) pending = false;
      return { ...info, status: 'completed' as const };
    });
    ix.stub(IAgentTaskService, {
      list: () => pending ? [info] : [],
      suppressTerminalNotification: suppress,
      wait,
      stopAllOnExit,
    });
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'child' });
    expect(svc.countPendingBackgroundTasks()).toBe(2);
    await svc.drainBackgroundTasks(5_000);
    expect(suppress).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith('local-task', expect.any(Number));
    expect(svc.countPendingBackgroundTasks()).toBe(0);
    expect(stopAllOnExit).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid drain deadline %s', async (timeout) => {
    await expect(ix.get(IAgentLifecycleService).drainBackgroundTasks(timeout)).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
  });

  it.each(['completed', 'cancelled', 'failed', 'blocked'] as const)(
    'only cancels pending approvals when their own agent turn ends (%s)', async (reason) => {
      ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
      const interaction = ix.get(ISessionInteractionService);
      const svc = ix.get(IAgentLifecycleService);
      const main = await svc.create({ agentId: 'main' });
      const child = await svc.create({ agentId: 'child' });
      const sibling = await svc.create({ agentId: 'sibling' });
      const pending = interaction.request<unknown, unknown>({ id: 'child-approval', kind: 'approval', payload: {},
        origin: { agentId: 'child', turnId: 0 } });
      const childBus = child.accessor.get(IEventBus);
      childBus.publish(new TurnStepCompleted({ turnId: 0, step: 1, finishReason: 'tool_use' }));
      main.accessor.get(IEventBus).publish(new TurnEnded({ turnId: 0, reason }));
      sibling.accessor.get(IEventBus).publish(new TurnEnded({ turnId: 0, reason }));
      childBus.publish(new TurnEnded({ turnId: 1, reason }));
      expect(interaction.listPending().map((entry) => entry.id)).toEqual(['child-approval']);
      childBus.publish(new TurnEnded({ turnId: 0, reason }));
      await expect(pending).resolves.toEqual({ cancelled: true, reason: 'turn_ended' });
      expect(interaction.listPending()).toEqual([]);
    },
  );

  it('agent removal cancels only that agent pending interactions', async () => {
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    const interaction = ix.get(ISessionInteractionService);
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'child' });
    const pending = interaction.request<unknown, unknown>({ id: 'child-approval', kind: 'approval', payload: {},
      origin: { agentId: 'child', turnId: 0 } });
    interaction.enqueue({ id: 'main-approval', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 0 } });
    await svc.remove('child');
    await expect(pending).resolves.toEqual({ cancelled: true, reason: 'agent_closed' });
    expect(interaction.listPending().map((entry) => entry.id)).toEqual(['main-approval']);
  });

  it('persists birth before publishing a queued child and preserves it across scope restart and fork', async () => {
    ix.stub(ISessionIndexMirror, { record: () => {} });
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    const metadata = ix.get(ISessionMetadata);
    const svc = ix.get(IAgentLifecycleService);
    disposables.add(svc.onWillCreate((handle) => { handle.accessor.get(IAgentProfileService); }));
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const child = await svc.create({ agentId: 'child', deferCreateEvent: true,
      delegator: { kind: 'external', delegationId: 'external-example' } });
    expect((await metadata.read()).agents?.['child']?.createdAt).toBe(10_000);
    expect(atomicDocs.get('test/state.json')).toMatchObject({ agents: { child: { createdAt: 10_000 } } });
    svc.commitCreate(child.id);
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    expect(await svc.create({ agentId: 'child' })).toBe(child);
    await svc.remove('child');
    await svc.create({ agentId: 'child' });
    expect((await metadata.read()).agents?.['child']?.createdAt).toBe(10_000);
    const fork = await svc.fork('child');
    expect((await metadata.read()).agents?.[fork.id]?.createdAt).toBe(20_000);
  });

  it('leaves legacy metadata and orphan restored journals birth unknown but dates copied new identities', async () => {
    const { metadata } = installStoredTerminalChild('completed');
    const svc = ix.get(IAgentLifecycleService);
    disposables.add(svc.onWillCreate((handle) => { handle.accessor.get(IAgentProfileService); }));
    await svc.create({ agentId: 'child' });
    expect((await metadata.read()).agents?.['child']?.createdAt).toBeUndefined();
    const storage = ix.get(IFileSystemStorageService);
    const ctx = ix.get(ISessionContext);
    await storage.write(ctx.scope('agents/orphan'), AGENT_WIRE_RECORD_KEY, new TextEncoder().encode('{}\n'));
    await svc.create({ agentId: 'orphan' });
    expect((await metadata.read()).agents?.['orphan']?.createdAt).toBeUndefined();
    await storage.write(ctx.scope('agents/copied'), AGENT_WIRE_RECORD_KEY, new TextEncoder().encode('{}\n'));
    vi.spyOn(Date, 'now').mockReturnValue(30_000);
    await svc.create({ agentId: 'copied', copiedIdentity: true });
    expect((await metadata.read()).agents?.['copied']?.createdAt).toBe(30_000);
  });

  it('dates a fresh ACP entity and keeps its birth on executor scope restoration', async () => {
    ix.stub(ISessionIndexMirror, { record: () => {} });
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    ix.stub(IAppendLogStore, recordingAppendLog([createWireMetadataRecord(1), {
      type: 'profile.bind', modelAlias: 'external-model', profileName: 'explore', thinkingEffort: 'high',
      executorId: 'example-acp', executorProtocol: 'acp-v1', systemPrompt: '', disallowedTools: [], time: 2,
    }]).store);
    const metadata = ix.get(ISessionMetadata);
    const svc = ix.get(IAgentLifecycleService);
    disposables.add(svc.onWillCreate((handle) => { handle.accessor.get(IAgentProfileService); }));
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const child = await svc.create({ agentId: 'acp-child' });
    expect(child.accessor.get(IAgentProfileService).data().executorProtocol).toBe('acp-v1');
    expect((await metadata.read()).agents?.[child.id]?.createdAt).toBe(10_000);
    await svc.remove(child.id);
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    await svc.create({ agentId: child.id });
    expect((await metadata.read()).agents?.[child.id]?.createdAt).toBe(10_000);
  });

  it('create / getHandle / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    expect(main.id).toBe('main');
    expect(svc.get('main')).toBe(main);
    expect(svc.list()).toEqual([main]);
    await svc.remove('main');
    expect(svc.get('main')).toBeUndefined();
  });

  it('remove stops the agent background tasks before disposal', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    await svc.remove('main');

    expect(stopAllOnExit).toHaveBeenCalledWith('Session closed');
    expect(promptDrain).toHaveBeenCalledOnce();
  });

  it('remove awaits asynchronous scope disposal once before emitting onDidDispose', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const disposalStarted = new Promise<void>((resolve) => { started = resolve; });
    const svc = ix.get(IAgentLifecycleService);
    const handle = await svc.create({ agentId: 'main' });
    const originalDispose = handle.dispose.bind(handle);
    const dispose = vi.spyOn(handle, 'dispose').mockImplementation(async () => {
      started();
      await gate;
      await originalDispose();
    });
    const disposed: string[] = [];
    disposables.add(svc.onDidDispose((agentId) => disposed.push(agentId)));
    const removal = svc.remove('main');
    const duplicate = svc.remove('main');
    await disposalStarted;
    expect(disposed).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([removal, duplicate]);
    expect(disposed).toEqual(['main']);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('remove waits for prompt intake to drain before disposing the agent scope', async () => {
    let releaseDrain!: () => void;
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    promptDrain.mockImplementationOnce(() => {
      markDrainStarted();
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const disposed: string[] = [];
    disposables.add(svc.onDidDispose((agentId) => disposed.push(agentId)));

    const removal = svc.remove('main');
    await drainStarted;
    await Promise.resolve();

    expect(disposed).toEqual([]);

    releaseDrain();
    await removal;
    expect(disposed).toEqual(['main']);
  });

  it('create for an agent whose removal is in flight waits for the old scope to go away', async () => {
    let releaseDrain!: () => void;
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    promptDrain.mockImplementationOnce(() => {
      markDrainStarted();
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    const first = await svc.create({ agentId: 'child' });
    const disposed: string[] = [];
    disposables.add(svc.onDidDispose((agentId) => disposed.push(agentId)));

    const removal = svc.remove('child');
    await drainStarted;
    expect(svc.get('child')).toBeUndefined();

    let recreated: IAgentScopeHandle | undefined;
    const recreate = svc.create({ agentId: 'child' }).then((handle) => {
      recreated = handle;
      return handle;
    });
    await Promise.resolve();
    expect(recreated).toBeUndefined();

    releaseDrain();
    await removal;
    const second = await recreate;
    expect(disposed).toEqual(['child']);
    expect(second).not.toBe(first);
    expect(svc.get('child')).toBe(second);
  });

  it('remove cancels queued turns before waiting for the active turn to settle', async () => {
    loopActiveTurnId = 1;
    loopPendingTurnIds = [2, 3];
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    await svc.remove('main');

    expect(loopCancel.mock.calls.map(([turnId]) => turnId)).toEqual([2, 3, undefined]);
    expect(loopSettled).toHaveBeenCalledOnce();
  });

  it('remove waits for an active full compaction to reject after aborting it', async () => {
    const abortController = new AbortController();
    let rejectCompaction!: (reason: unknown) => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectCompaction = reject;
    });
    const aborted = new Promise<void>((resolve) => {
      abortController.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    ix.stub(IAgentFullCompactionService, {
      _serviceBrand: undefined,
      compacting: {
        abortController,
        promise,
        trigger: 'manual',
        tokenCount: 100,
      },
    } as unknown as IAgentFullCompactionService);
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    let removed = false;
    const removal = svc.remove('main').then(() => {
      removed = true;
    });
    await aborted;
    await Promise.resolve();
    expect(removed).toBe(false);

    rejectCompaction(abortController.signal.reason);
    await removal;
    expect(removed).toBe(true);
  });

  it('ignites the self-wiring toolDedupe plugin so its listeners exist before the first turn', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    expect(beforeExecuteListeners).toBeGreaterThan(0);
    expect(didExecuteHookIds).toContain('toolDedupe');
  });

  it('create skips auto ids that collide with agents persisted by a previous run', async () => {
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () =>
        Promise.resolve({
          id: 'sess_test',
          createdAt: 0,
          updatedAt: 0,
          archived: false,
          agents: {
            'agent-0': { homedir: '/tmp/kimi-agentLifecycle-test/agents/agent-0', type: 'sub' },
            'agent-1': { homedir: '/tmp/kimi-agentLifecycle-test/agents/agent-1', type: 'sub' },
          },
        }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent,
    });
    const svc = ix.get(IAgentLifecycleService);

    const first = await svc.create({});
    expect(first.id).toBe('agent-2');

    const second = await svc.create({});
    expect(second.id).toBe('agent-3');
  });

  it('seeds each agent scope with a telemetry view bound to its own agent id', async () => {
    const records: TelemetryRecord[] = [];
    ix.stub(ITelemetryService, recordingTelemetry(records));
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const sub = await svc.create({});

    main.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: true });
    sub.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: false });

    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: 'main', enabled: true },
    });
    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: sub.id, enabled: false },
    });
  });

  it('create reserves distinct ids before concurrent durable existence checks settle', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const [a, b] = await Promise.all([svc.create({}), svc.create({})]);
    expect(a.id).not.toBe(b.id);
    expect(svc.list()).toHaveLength(2);
  });

  it.each(['', 'not a valid journal'])('skips a previously allocated wire even when its content is %j', async (content) => {
    await ix.get(IFileSystemStorageService).write(
      ix.get(ISessionContext).scope('agents/agent-0'),
      AGENT_WIRE_RECORD_KEY,
      new TextEncoder().encode(content),
    );
    const child = await ix.get(IAgentLifecycleService).create({});
    expect(child.id).toBe('agent-1');
    expect(child.accessor.get(IAgentProfileService).data().routeId).toBeUndefined();
  });

  it('fails closed without creating a scope when durable identity inspection fails', async () => {
    const failure = new Error('storage unavailable');
    vi.spyOn(ix.get(IFileSystemStorageService), 'size').mockRejectedValueOnce(failure);
    const lifecycle = ix.get(IAgentLifecycleService);
    const willCreate = vi.fn();
    disposables.add(lifecycle.onWillCreate(willCreate));
    await expect(lifecycle.create({})).rejects.toBe(failure);
    expect(lifecycle.list()).toEqual([]);
    expect(willCreate).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
  });

  function installStoredTerminalChild(status: 'completed' | 'failed') {
    const prior = {
      type: 'sub' as const,
      parentAgentId: 'main',
      delegator: { kind: 'agent' as const, agentId: 'main' },
      labels: { parentAgentId: 'main', profileName: 'old-profile', workItem: 'example' },
      model: 'provider/old-model',
      thinkingEffort: 'low',
      status,
      completedAt: 1_700_000_000_000,
      resultSummary: 'Previous result',
      error: status === 'failed' ? 'Previous failure' : undefined,
      usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
      contextTokens: 23,
      toolCallCount: 0,
    };
    atomicDocs.set('test/state.json', {
      id: 'sess_test',
      version: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      archived: false,
      agents: { child: prior },
      custom: {},
    });
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias: 'provider/child-model',
        profileName: 'explore',
        thinkingEffort: 'high',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    ix.stub(ISessionIndexMirror, { record: () => {} });
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    return { metadata: ix.get(ISessionMetadata), prior };
  }

  it('preserves persisted terminal metadata while cold-materializing the current binding', async () => {
    const { metadata, prior } = installStoredTerminalChild('completed');
    const update = vi.spyOn(metadata, 'updateAgent');
    const register = vi.spyOn(metadata, 'registerAgent');
    const child = await ix.get(IAgentLifecycleService).create({
      agentId: 'child',
      delegator: prior.delegator,
      labels: prior.labels,
    });

    expect(child.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'explore',
      modelAlias: 'provider/child-model',
      thinkingLevel: 'high',
    });
    const expected = {
      status: prior.status,
      completedAt: prior.completedAt,
      resultSummary: prior.resultSummary,
      usage: prior.usage,
      contextTokens: prior.contextTokens,
      toolCallCount: prior.toolCallCount,
      model: 'provider/child-model',
      thinkingEffort: 'high',
      labels: { parentAgentId: 'main', profileName: 'explore', workItem: 'example' },
    };
    expect(update).toHaveBeenCalledWith('child', expect.any(Function));
    expect(register).not.toHaveBeenCalled();
    expect((await metadata.read()).agents?.['child']).toMatchObject(expected);
    expect(atomicDocs.get('test/state.json')).toMatchObject({ agents: { child: expected } });
  });

  it('preserves a failed run in persisted metadata when cold resume rejects a model change', async () => {
    const { metadata, prior } = installStoredTerminalChild('failed');
    ix.stub(IModelCatalog, {
      get: (id) => ({
        id,
        name: id,
        aliases: [],
        protocol: 'openai',
        headers: {},
        capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
        maxContextSize: 1_000,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'low',
        alwaysThinking: false,
        providerName: 'example',
        imagePolicy: { acceptedTypes: new Set(['image/png']), convertUnsupported: 'off' },
        authProvider: { getAuth: async () => undefined },
      }),
    });
    ix.set(IAgentCollaborationRegistry, new SyncDescriptor(AgentCollaborationRegistry));
    const run = vi.fn();
    const executeSwitch = vi.fn();
    ix.stub(IAgentModelSwitchService, { get: () => undefined, execute: executeSwitch });
    ix.stub(ISessionSubagentService, { run });
    ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    const lifecycle = ix.get(IAgentLifecycleService);
    await lifecycle.create({ agentId: 'main' });
    const dispatch = ix.get(ISessionDispatchService);
    const child = await dispatch.resolveOwnedChild(prior.delegator, 'child');
    expect(child.modelAlias).toBe('provider/child-model');

    await expect(dispatch.runOnExisting(child, 'Continue', {
      requesterAgentId: 'main',
      bindingOverride: { modelAlias: 'provider/other-model' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
      details: { requiredParameter: 'allow_model_change' },
    });
    expect(run).not.toHaveBeenCalled();
    expect(executeSwitch).not.toHaveBeenCalled();
    const expected = {
      status: prior.status,
      completedAt: prior.completedAt,
      resultSummary: prior.resultSummary,
      error: prior.error,
      usage: prior.usage,
      contextTokens: prior.contextTokens,
      toolCallCount: prior.toolCallCount,
      model: 'provider/child-model',
      thinkingEffort: 'high',
      labels: { parentAgentId: 'main', profileName: 'explore', workItem: 'example' },
    };
    expect((await metadata.read()).agents?.['child']).toMatchObject(expected);
    expect(atomicDocs.get('test/state.json')).toMatchObject({ agents: { child: expected } });
  });

  it('persists complete agent metadata when creating a child', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias: 'provider/child-model',
        profileName: 'explore',
        thinkingEffort: 'high',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    const svc = ix.get(IAgentLifecycleService);

    const child = await svc.create({
      agentId: 'child',
      forkedFrom: 'main',
      labels: { workItem: 'work-item-1' },
      userLabel: 'Review usage accounting',
    });

    expect(child.id).toBe('child');
    expect(registerAgent).toHaveBeenCalledWith('child', {
      createdAt: expect.any(Number),
      homedir: '/tmp/kimi-agentLifecycle-home/sessions/ws_test/sess_test/agents/child',
      type: 'sub',
      parentAgentId: 'main',
      delegator: undefined,
      forkedFrom: 'main',
      labels: { workItem: 'work-item-1', profileName: 'explore' },
      displayName: 'explore',
      userLabel: 'Review usage accounting',
      model: 'provider/child-model',
      thinkingEffort: 'high',
      executor: 'native',
      executorProtocol: 'native',
    });
  });

  it('recreates one persisted child with its profile binding', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias: 'provider/child-model',
        profileName: 'explore',
        thinkingEffort: 'high',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    const svc = ix.get(IAgentLifecycleService);

    const first = await svc.create({ agentId: 'child' });
    await svc.remove('child');
    const restored = await svc.create({ agentId: 'child' });

    expect(restored).not.toBe(first);
    expect(restored.id).toBe('child');
    expect(svc.list().map((agent) => agent.id)).toEqual(['child']);
    expect(restored.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'explore',
      modelAlias: 'provider/child-model',
      thinkingLevel: 'high',
    });
    expect(registerAgent).toHaveBeenLastCalledWith(
      'child',
      expect.objectContaining({ labels: { profileName: 'explore' } }),
    );
  });

  it('restores a known disposed agent from its persisted binding snapshot', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias: 'provider/child-model',
        profileName: 'explore',
        thinkingEffort: 'high',
        executorId: 'native',
        executorProtocol: 'native',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: async () => ({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: { child: { type: 'sub', labels: { profileName: 'explore' } } },
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent,
      updateAgent,
    } as unknown as ISessionMetadata);
    const resolveExecutable = vi.fn(async () => ({
      descriptor: { id: 'native', protocol: 'native' as const, args: [], revision: 'native' },
      options: {},
    }));
    ix.stub(IAgentExecutorRegistry, {
      _serviceBrand: undefined,
      resolveExecutable,
    } as unknown as IAgentExecutorRegistry);
    const svc = ix.get(IAgentLifecycleService);

    const restored = await svc.create({
      agentId: 'child',
      restoreBinding: {
        profileName: 'explore',
        modelAlias: 'provider/child-model',
        thinkingEffort: 'high',
        executorId: 'native',
        executorProtocol: 'native',
      },
    });

    expect(restored.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'explore',
      modelAlias: 'provider/child-model',
      thinkingLevel: 'high',
      executorId: 'native',
      executorProtocol: 'native',
    });
    expect(resolveExecutable).toHaveBeenCalledWith('native', undefined);
  });

  it('restores a route-only binding and keeps its route, role, and tools when the model changes', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        routeId: 'route-only',
        modelAlias: 'provider/child-model',
        lockedModelAlias: 'provider/child-model',
        lockedThinkingEffort: 'high',
        thinkingEffort: 'high',
        executionRestriction: 'research-readonly',
        executorId: 'native',
        executorProtocol: 'native',
        systemPrompt: 'route prompt snapshot',
        activeToolNames: ['Read'],
        toolAllowPolicies: [['Read']],
        disallowedTools: ['Write'],
        allowedSubagents: ['explore'],
        subagentLeases: { explore: { name: 'explore', modelAlias: 'provider/child-model' } },
        appliedLease: { name: 'explore', modelAlias: 'provider/child-model' },
        spawnPolicy: { allowedModels: ['provider/child-model'] },
        time: 2,
      },
    ]).store);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: async () => ({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: { child: { type: 'sub', displayName: 'route-only' } },
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent,
      updateAgent,
    } as unknown as ISessionMetadata);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: () => ({ providerName: 'test-provider', capabilities: UNKNOWN_CAPABILITY }),
    } as unknown as IModelCatalog);
    const svc = ix.get(IAgentLifecycleService);

    const restored = await svc.create({
      agentId: 'child',
      restoreBinding: {
        routeId: 'route-only',
        modelAlias: 'provider/child-model',
        thinkingEffort: 'high',
        executorId: 'native',
        executorProtocol: 'native',
      },
    });
    const profile = restored.accessor.get(IAgentProfileService);

    expect(profile.data()).toMatchObject({
      profileName: undefined,
      routeId: 'route-only',
      modelAlias: 'provider/child-model',
    });

    const before = profile.data();
    await profile.setModel('provider/other-model');
    const after = profile.data();
    const serialized = (value: unknown): string => JSON.stringify(value) ?? 'undefined';
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => serialized(before[key as keyof typeof before]) !== serialized(after[key as keyof typeof after]))
      .sort();

    expect(after.modelAlias).toBe('provider/other-model');
    expect(changedKeys).toEqual([
      'bindingAdvisories',
      'effectiveThinkingLevel',
      'modelAlias',
      'routeDetached',
      'thinkingLevel',
    ]);
    expect(after).toMatchObject({
      profileName: undefined,
      routeId: 'route-only',
      routeDetached: true,
      lockedModelAlias: 'provider/child-model',
      lockedThinkingEffort: 'high',
      executionRestriction: 'research-readonly',
      systemPrompt: 'route prompt snapshot',
      activeToolNames: ['Read'],
      disallowedTools: ['Write'],
      allowedSubagents: ['explore'],
      subagentLeases: { explore: { name: 'explore', modelAlias: 'provider/child-model' } },
      appliedLease: { name: 'explore', modelAlias: 'provider/child-model' },
      spawnPolicy: { allowedModels: ['provider/child-model'] },
    });
    expect(after.toolAllowPolicies).toEqual([['Read'], RESEARCH_READONLY_TOOLS]);
  });

  it('rejects restore when persisted binding metadata is incomplete', async () => {
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: async () => ({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: { child: { type: 'sub', labels: { profileName: 'explore' } } },
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent,
      updateAgent,
    } as unknown as ISessionMetadata);
    const svc = ix.get(IAgentLifecycleService);

    await expect(svc.create({
      agentId: 'child',
      restoreBinding: {
        profileName: 'explore',
        modelAlias: 'provider/child-model',
      },
    })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      details: { missingFields: ['thinkingEffort', 'executorId', 'executorProtocol'] },
    });
    expect(svc.get('child')).toBeUndefined();
  });

  it('rejects restore when the persisted executor is unavailable', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        modelAlias: 'external-model',
        profileName: 'explore',
        thinkingEffort: 'high',
        executorId: 'missing-executor',
        executorProtocol: 'acp-v1',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: async () => ({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: { child: { type: 'sub', labels: { profileName: 'explore' } } },
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent,
      updateAgent,
    } as unknown as ISessionMetadata);
    ix.stub(IAgentExecutorRegistry, {
      _serviceBrand: undefined,
      resolveExecutable: async () => {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'No executable source is available');
      },
    } as unknown as IAgentExecutorRegistry);
    const svc = ix.get(IAgentLifecycleService);

    await expect(svc.create({
      agentId: 'child',
      restoreBinding: {
        profileName: 'explore',
        modelAlias: 'external-model',
        thinkingEffort: 'high',
        executorId: 'missing-executor',
        executorProtocol: 'acp-v1',
      },
    })).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
    expect(svc.get('child')).toBeUndefined();
  });

  it('falls back to the default profile when the persisted restore profile is gone from the catalog', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
    ]).store);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: async () => ({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents: { child: { type: 'sub', labels: { profileName: 'deleted-profile' } } },
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent,
      updateAgent,
    } as unknown as ISessionMetadata);
    const defaultProfile = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: 'provider/child-model',
      systemPrompt: () => 'default profile',
    });
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: () => undefined,
      getDefault: () => defaultProfile,
      list: () => [defaultProfile],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, 'unknown profile');
      },
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(IAgentIdentity, {
      _serviceBrand: undefined,
      resolved: async () => ({ displayName: 'Test' }),
    } as unknown as IAgentIdentity);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: () => ({ providerName: 'test-provider', capabilities: { ...UNKNOWN_CAPABILITY, thinking: true }, defaultEffort: 'high' }),
    } as unknown as IModelCatalog);
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-agentLifecycle-test',
      metaScope: 'test',
      cwd: '/tmp/kimi-agentLifecycle-work',
      scope: (subKey?: string) =>
        subKey === undefined || subKey === ''
          ? 'sessions/ws_test/sess_test'
          : `sessions/ws_test/sess_test/${subKey}`,
    } as unknown as ISessionContext);
    ix.stub(IPluginService, {
      ...pluginServiceStub,
      enabledSystemPrompts: async () => [],
      hasLoadedSnapshot: () => false,
    } as unknown as IPluginService);
    ix.stub(IHostClock, {
      _serviceBrand: undefined,
      now: () => new Date('2026-09-26T00:00:00Z'),
      timeZone: () => 'UTC',
    });
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/tmp/kimi-agentLifecycle-home',
      cwd: '/tmp/kimi-agentLifecycle-home',
      getEnv: () => undefined,
      args: {},
    } as unknown as IBootstrapService);
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      listReferences: () => [],
    } as unknown as IAgentToolRegistryService);
    ix.stub(IBuiltinAgentProfileLoader, {
      _serviceBrand: undefined,
      list: () => [],
    } as unknown as IBuiltinAgentProfileLoader);
    const svc = ix.get(IAgentLifecycleService);

    const restored = await svc.create({
      agentId: 'child',
      restoreBinding: {
        profileName: 'deleted-profile',
        modelAlias: 'provider/child-model',
        thinkingEffort: 'high',
        executorId: 'native',
        executorProtocol: 'native',
      },
    });

    expect(restored.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: 'provider/child-model',
      thinkingLevel: 'high',
    });
  });

  it('keeps a persisted display name when restored profile metadata differs', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'profile.bind',
        profileName: 'explore',
        routeId: 'reviewer-route',
        thinkingEffort: 'off',
        systemPrompt: '',
        disallowedTools: [],
        time: 2,
      },
    ]).store);
    const agents: Record<string, import('#/session/sessionMetadata/sessionMetadata').AgentMeta> = {
      child: { type: 'sub', displayName: 'trusted-name' },
    };
    let queue = Promise.resolve();
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({
        id: 'sess_test',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents,
      }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent,
      updateAgent: (agentId: string, updater: Parameters<ISessionMetadata['updateAgent']>[1]) => {
        const work = async () => {
          const current = agents[agentId];
          if (current === undefined) return;
          const next = updater(structuredClone(current));
          await registerAgent(agentId, next);
          agents[agentId] = next;
        };
        const result = queue.then(work, work);
        queue = result.catch(() => {});
        return result;
      },
    });

    await ix.get(IAgentLifecycleService).create({ agentId: 'child' });

    expect(registerAgent).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ displayName: 'trusted-name' }),
    );
  });

  it('seals a fresh wire log with the metadata envelope as the first record', async () => {
    const log = recordingAppendLog();
    ix.stub(IAppendLogStore, log.store);
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'main' });

    expect(log.appended[0]).toMatchObject({
      type: 'metadata',
      protocol_version: createWireMetadataRecord().protocol_version,
    });
  });

  it('opens a durable transcript acceptance epoch before an agent runs and seals after removal', async () => {
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IAppendLogStore, new AppendLogStore(storage));
    const svc = ix.get(IAgentLifecycleService);
    const handle = await svc.create({ agentId: 'child' });
    const scope = ix.get(ISessionContext).scope('agents/child');
    const open = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(open).toMatchObject({ state: 'open', trusted: true });
    handle.accessor.get(IWireService).appendRecord({ type: 'turn.prompt', turnId: 0 });
    await svc.remove('child');
    const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(sealed).toMatchObject({ state: 'sealed', trusted: true, epoch: open?.epoch, wire: { size: expect.any(Number), sha256: expect.any(String) } });
    expect(sealed?.wire?.size).toBeGreaterThan(0);
  });

  it('waits for a direct loop to settle before sealing its accepted transcript', async () => {
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.stub(IAppendLogStore, new AppendLogStore(storage));
    const svc = ix.get(IAgentLifecycleService);
    const handle = await svc.create({ agentId: 'child' });
    const wire = handle.accessor.get(IWireService);
    const scope = ix.get(ISessionContext).scope('agents/child');
    let releaseLoop!: () => void;
    const loopGate = new Promise<void>((resolve) => { releaseLoop = resolve; });
    let enteredLoop!: () => void;
    const loopEntered = new Promise<void>((resolve) => { enteredLoop = resolve; });
    loopSettled.mockImplementationOnce(async () => {
      enteredLoop();
      await loopGate;
    });
    const removal = svc.remove('child');
    await loopEntered;
    const stillOpen = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(stillOpen?.state).toBe('open');
    wire.appendRecord({ type: 'turn.ended', turnId: 0, reason: 'cancelled' });
    releaseLoop();
    await removal;
    const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    const persisted = await storage.read(scope, AGENT_WIRE_RECORD_KEY);
    expect(Buffer.from(persisted!).toString('utf8')).toContain('"type":"turn.ended"');
    expect(sealed).toMatchObject({ state: 'sealed', trusted: true, wire: { size: persisted!.byteLength } });
  });

  it('does not re-seal a wire log that already has records', async () => {
    const existing: WireRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'existing' }],
      origin: { kind: 'user' },
    };
    const log = recordingAppendLog([existing]);
    ix.stub(IAppendLogStore, log.store);
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'main' });

    expect(log.appended.some((record) => record.type === 'metadata')).toBe(false);
  });

  it('leaves permission mode at the default when permissionMode is omitted', async () => {
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'child' });
    expect(permissionModeSetMode).not.toHaveBeenCalled();
  });

  it('applies the configured permission mode when the Agent has no persisted mode', async () => {
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => 'auto') as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);

    const main = await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    expect(main.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('auto');
  });

  it('keeps the restored permission mode instead of overwriting it with the default', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      { type: 'permission.set_mode', mode: 'manual', time: 2 },
    ]).store);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => 'auto') as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);

    await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    expect(permissionModeSetMode).not.toHaveBeenCalled();
  });

  it('restores the runtime binding without persisting a generation', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      { type: 'runtime.set_binding', workspaceId: 'ws_test', runtimeId: 'remote', time: 2 },
    ]).store);

    const agent = await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    expect(agent.accessor.get(IAgentRuntimeBindingService).current).toEqual({
      workspaceId: 'ws_test',
      runtimeId: 'remote',
    });
    expect(agent.accessor.get(IAgentRuntimeService).inspect().identity.generation).toBe('remote-one');
  });

  it('contributes session-domain replayable keys before restore and replays them', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'bridged', status: 'pending' }],
        time: 2,
      },
      { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: 1 }, time: 3 },
    ]).store);
    ix.stub(ICronTaskPersistence, {
      _serviceBrand: undefined,
      get: async () => undefined,
      list: async () => [],
      listWorkspaceIds: async () => [],
      save: async () => {},
      delete: async () => {},
    } as ICronTaskPersistence);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: ((section: unknown) =>
        section === CRON_SECTION ? { disabled: true } : undefined) as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);
    ix.set(ISessionTodoService, new SyncDescriptor(SessionTodoService));
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionCronService, new SyncDescriptor(SessionCronServiceImpl));
    ix.get(ISessionTodoService);
    ix.get(ISessionInteractionService);
    ix.get(ISessionCronService);

    const main = await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    const state = main.accessor.get(IAgentStateService);
    expect(state.replayableKeys().map((key) => key.name)).toEqual(
      expect.arrayContaining(['todo', 'cron', 'interaction']),
    );
    expect(state.get(todoKey)).toEqual({
      items: [{ title: 'bridged', status: 'pending' }],
    });
    expect(state.get(interactionKey).get('i1')).toMatchObject({
      id: 'i1',
      kind: 'question',
      request: { q: 1 },
      resolved: false,
    });
  });

  it('broadcastPermissionMode sets the mode on every live agent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const child = await svc.create({ agentId: 'child' });

    svc.broadcastPermissionMode('yolo');

    expect(main.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('yolo');
    expect(child.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('yolo');
  });

  it('broadcastPermissionMode skips agents that have been removed', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'child' });
    await svc.remove('child');

    svc.broadcastPermissionMode('auto');

    expect(main.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('auto');
  });

  it('wires MCP OAuth credentials through the session atomic document store', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    const mcp = main.accessor.get(IAgentMcpService);
    const oauth = mcp.oauthService;
    if (oauth === undefined) throw new Error('Expected session MCP manager to provide OAuth');
    const provider = oauth.getProvider('linear', 'https://linear.example.com/mcp');
    await provider.ready;

    await provider.saveTokens({
      access_token: 'session-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const tokenEntries = [...atomicDocs.entries()].filter(
      ([key]) => key.startsWith('credentials/mcp/') && key.endsWith('-tokens.json'),
    );
    expect(tokenEntries).toEqual([
      [
        expect.stringMatching(/^credentials\/mcp\/linear-[a-f0-9]{24}-tokens\.json$/),
        {
          access_token: 'session-token',
          token_type: 'Bearer',
          obtained_at: expect.any(Number),
        },
      ],
    ]);
  });

  it('returns an agent without waiting for the MCP handle readiness', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    ix.stub(ISessionMcpHandle, {
      _serviceBrand: undefined,
      ready,
      connectionManager: new McpConnectionManager({ log: noopLog }),
      isBaselineServer: () => true,
    } satisfies ISessionMcpHandle);

    const svc = ix.get(IAgentLifecycleService);
    const handle = await svc.create({ agentId: 'main' });
    expect(handle.id).toBe('main');

    releaseReady();
  });

  it('keeps a restoring agent out of get and list until its bootstrap completes', async () => {
    let releaseRegister!: () => void;
    let registerStarted!: () => void;
    const registerCalled = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    registerAgent.mockImplementationOnce(() => {
      registerStarted();
      return new Promise<void>((resolve) => {
        releaseRegister = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    const sealed: string[] = [];
    disposables.add(svc.onWillCreate((handle) => sealed.push(handle.id)));
    const create = svc.create({ agentId: 'main' });

    await registerCalled;
    expect(sealed).toEqual(['main']);
    expect(svc.get('main')).toBeUndefined();
    expect(svc.list()).toEqual([]);

    const joined = svc.create({ agentId: 'main' });
    releaseRegister();
    const handle = await create;
    expect(await joined).toBe(handle);
    expect(svc.get('main')).toBe(handle);
    expect(svc.list()).toEqual([handle]);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('voids an in-flight create when the identity is removed and never returns the disposed handle', async () => {
    let releaseRegister!: () => void;
    let registerStarted!: () => void;
    const registerCalled = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    registerAgent.mockImplementationOnce(() => {
      registerStarted();
      return new Promise<void>((resolve) => {
        releaseRegister = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    const disposed: string[] = [];
    disposables.add(svc.onDidDispose((agentId) => disposed.push(agentId)));
    const create = svc.create({ agentId: 'child' });
    await registerCalled;

    let removed = false;
    const removal = svc.remove('child').then(() => {
      removed = true;
    });
    const recreated = svc.create({ agentId: 'child' });
    await Promise.resolve();
    expect(removed).toBe(false);
    expect(svc.get('child')).toBeUndefined();

    releaseRegister();
    await expect(create).rejects.toMatchObject({ code: ErrorCodes.AGENT_REMOVED });
    await removal;
    expect(svc.get('child')).toBeUndefined();
    expect(disposed).toEqual(['child']);

    const handle = await recreated;
    expect(handle.id).toBe('child');
    expect(svc.get('child')).toBe(handle);
    expect(registerAgent).toHaveBeenCalledTimes(2);
  });

  it('joins the in-flight create when a listener creates the same id during onWillCreate', async () => {
    const svc = ix.get(IAgentLifecycleService);
    let reentrant: Promise<IAgentScopeHandle> | undefined;
    disposables.add(svc.onWillCreate((handle) => {
      if (reentrant !== undefined) return;
      reentrant = svc.create({ agentId: 'main' });
    }));

    const handle = await svc.create({ agentId: 'main' });

    expect(reentrant).toBeDefined();
    expect(await reentrant).toBe(handle);
    expect(registerAgent).toHaveBeenCalledTimes(1);
    expect(svc.get('main')).toBe(handle);
  });

  it('ensureMainAgent returns one handle when calls start concurrently', async () => {
    const session: ISessionScopeHandle = {
      id: 'sess_test',
      kind: LifecycleScope.Session,
      accessor: ix,
      dispose: () => {},
    };

    const [first, second] = await Promise.all([
      ensureMainAgent(session),
      ensureMainAgent(session),
    ]);

    expect(first).toBe(second);
    expect(registerAgent).toHaveBeenCalledTimes(1);
    expect(ix.get(IAgentLifecycleService).list()).toEqual([first]);
  });

  it('drops the handle when creation bootstrap fails so the next create starts clean', async () => {
    registerAgent.mockRejectedValueOnce(new Error('bootstrap boom'));
    const svc = ix.get(IAgentLifecycleService);

    await expect(svc.create({ agentId: 'main' })).rejects.toThrow('bootstrap boom');
    expect(svc.get('main')).toBeUndefined();

    const main = await svc.create({ agentId: 'main' });
    expect(main.id).toBe('main');
  });

  it('fork throws when the source agent does not exist', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await expect(svc.fork('missing')).rejects.toThrow('Source agent "missing" does not exist');
  });

  it('fork copies the bound profile snapshot without catalog resolution', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    source.accessor.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      allowedSubagents: ['explore'],
    });

    const child = await svc.fork('main', { agentId: 'forked' });

    expect(child.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      allowedSubagents: ['explore'],
    });
  });

  it('fork snapshots the source runtime and remains independent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    const sourceRuntime = source.accessor.get(IAgentRuntimeBindingService);
    sourceRuntime.switch('remote');

    const child = await svc.fork('main', { agentId: 'forked-runtime' });
    const childRuntime = child.accessor.get(IAgentRuntimeBindingService);
    expect(childRuntime.current.runtimeId).toBe('remote');

    sourceRuntime.switch('local');
    expect(childRuntime.current.runtimeId).toBe('remote');
    childRuntime.switch('local');
    expect(sourceRuntime.current.runtimeId).toBe('local');
  });

  it('run throws when the agent does not exist', () => {
    ix.stub(IFlagService, stubFlag(true));
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
    const svc = ix.get(ISessionSubagentService);
    expect(() =>
      svc.run('missing', { kind: 'prompt', prompt: 'hi' }, { signal: new AbortController().signal }),
    ).toThrow('Agent "missing" does not exist');
  });

  it('fires onWillCreate before onDidCreate and onDidDispose on remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const events: string[] = [];
    const disposed: string[] = [];
    let willKeys: string[] = [];
    disposables.add(svc.onWillCreate((h) => {
      events.push(`will:${h.id}`);
      willKeys = h.accessor.get(IAgentStateService).replayableKeys().map((key) => key.name);
    }));
    disposables.add(svc.onDidCreate((h) => events.push(`did:${h.id}`)));
    disposables.add(svc.onDidDispose((id) => disposed.push(id)));

    const a = await svc.create({});
    expect(events).toEqual([`will:${a.id}`, `did:${a.id}`]);
    expect(willKeys).toContain('interaction');

    await svc.remove(a.id);
    expect(disposed).toEqual([a.id]);
  });

  it('fires onWillCreate immediately while deferring onDidCreate until commit', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const events: string[] = [];
    disposables.add(svc.onWillCreate((h) => events.push(`will:${h.id}`)));
    disposables.add(svc.onDidCreate((h) => events.push(`did:${h.id}`)));

    const agent = await svc.create({ agentId: 'deferred', deferCreateEvent: true });
    expect(events).toEqual(['will:deferred']);

    svc.commitCreate?.(agent.id);
    expect(events).toEqual(['will:deferred', 'did:deferred']);
  });

  it('discards staged children from real metadata without announcing creation and permits the same name', async () => {
    ix.stub(ISessionIndexMirror, { record: () => {} });
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    ix.set(IAgentCollaborationRegistry, new SyncDescriptor(AgentCollaborationRegistry));
    const metadata = ix.get(ISessionMetadata);
    const names = ix.get(IAgentCollaborationRegistry);
    const svc = ix.get(IAgentLifecycleService);
    const owner = { kind: 'agent', agentId: 'main' } as const;
    const created: string[] = [];
    const disposed: string[] = [];
    disposables.add(svc.onDidCreate((child) => created.push(child.id)));
    disposables.add(svc.onDidDispose((id) => disposed.push(id)));
    await svc.create({ agentId: 'main' });
    created.length = 0;
    expect(await names.reserve('retry_child', owner)).toBe(true);
    const child = await svc.create({
      deferCreateEvent: true,
      delegator: owner,
      labels: { [COLLABORATION_TASK_NAME_LABEL]: 'retry_child' },
    });
    expect((await metadata.read()).agents?.[child.id]).toBeDefined();
    expect(await names.reserve('retry_child', owner)).toBe(false);
    await svc.discard(child.id);
    names.release('retry_child', owner);
    svc.commitCreate(child.id);
    expect(svc.get(child.id)).toBeUndefined();
    expect(Object.keys((await metadata.read()).agents ?? {})).toEqual(['main']);
    expect(atomicDocs.get('test/state.json')).toMatchObject({ agents: { main: { type: 'main' } } });
    expect(Object.keys((atomicDocs.get('test/state.json') as { agents: object }).agents)).toEqual(['main']);
    expect(disposed).toEqual([child.id]);
    expect(created).toEqual([]);
    expect(await names.reserve('retry_child', owner)).toBe(true);
    const retried = await svc.create({
      deferCreateEvent: true,
      delegator: owner,
      labels: { [COLLABORATION_TASK_NAME_LABEL]: 'retry_child' },
    });
    names.commit('retry_child', owner);
    svc.commitCreate(retried.id);
    expect(created).toEqual([retried.id]);
  });

  it('does not recycle a discarded durable identity after cold allocation while retaining readonly restores', async () => {
    const tempRoot = resolve('.tmp/agent-allocation');
    await mkdir(tempRoot, { recursive: true });
    const home = await mkdtemp(`${tempRoot}/cold-`);
    const installStores = (): void => {
      ix.stub(IFileSystemStorageService, new FileStorageService(home));
      ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
      ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix.stub(ISessionIndexMirror, { record: () => {} });
      ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
      ix.set(IAgentCollaborationRegistry, new SyncDescriptor(AgentCollaborationRegistry));
    };
    const closeHost = async (): Promise<void> => {
      const lifecycle = ix.get(IAgentLifecycleService);
      for (const handle of lifecycle.list()) await lifecycle.remove(handle.id);
      await ix.get(IAppendLogStore).close();
      await ix.get(IFileSystemStorageService).close();
      await disposables.dispose();
    };
    const bindReadonly = async (child: IAgentScopeHandle): Promise<void> => {
      await child.accessor.get(IEventDispatcher).dispatch(new ProfileBind({
        profileName: 'explore',
        routeId: 'research-route',
        executionRestriction: 'research-readonly',
        systemPrompt: 'Research only',
        thinkingEffort: 'off',
        disallowedTools: [],
      }));
      await child.accessor.get(IWireService).flush();
    };
    installStores();
    try {
      const lifecycle = ix.get(IAgentLifecycleService);
      const owner = { kind: 'agent', agentId: 'main' } as const;
      const names = ix.get(IAgentCollaborationRegistry);
      await lifecycle.create({ agentId: 'main' });
      expect(await names.reserve('retry_child', owner)).toBe(true);
      const failed = await lifecycle.create({
        deferCreateEvent: true,
        delegator: owner,
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'retry_child' },
      });
      await bindReadonly(failed);
      const failure = new Error('initial ownership write failed');
      const store = ix.get(IAtomicDocumentStore);
      vi.spyOn(store, 'set').mockRejectedValueOnce(failure);
      await expect(store.set('external-delegation', 'root', { child: failed.id })).rejects.toBe(failure);
      await lifecycle.discard(failed.id);
      names.release('retry_child', owner);
      expect((await ix.get(ISessionMetadata).read()).agents?.[failed.id]).toBeUndefined();
      const failedScope = ix.get(ISessionContext).scope(`agents/${failed.id}`);
      expect(await ix.get(IFileSystemStorageService).size(failedScope, AGENT_WIRE_RECORD_KEY)).toBeGreaterThan(0);
      const retained = await lifecycle.create({ agentId: 'retained', deferCreateEvent: true });
      await bindReadonly(retained);
      await store.set('external-delegation', 'root', { child: retained.id });
      lifecycle.commitCreate(retained.id);
      await closeHost();
      createTestHost();
      installStores();
      const cold = ix.get(IAgentLifecycleService);
      const coldNames = ix.get(IAgentCollaborationRegistry);
      expect(await coldNames.reserve('retry_child', owner)).toBe(true);
      const fresh = await cold.create({
        deferCreateEvent: true,
        delegator: owner,
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'retry_child' },
      });
      expect(fresh.accessor.get(IAgentProfileService).data().executionRestriction).toBeUndefined();
      expect(fresh.accessor.get(IAgentProfileService).data().routeId).toBeUndefined();
      expect(fresh.id).not.toBe(failed.id);
      coldNames.commit('retry_child', owner);
      cold.commitCreate(fresh.id);
      const restored = await cold.create({ agentId: retained.id });
      expect(restored.accessor.get(IAgentProfileService).data()).toMatchObject({
        executionRestriction: 'research-readonly', routeId: 'research-route',
      });
      expect(await ix.get(IAtomicDocumentStore).get('external-delegation', 'root')).toEqual({ child: retained.id });
    } finally {
      await closeHost();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('de-dupes concurrent create calls for the same agent id', async () => {
    let resolveRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    registerAgent.mockReturnValue(registration);
    const svc = ix.get(IAgentLifecycleService);

    const first = svc.create({ agentId: 'main' });
    const second = svc.create({ agentId: 'main' });

    resolveRegistration();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('create returns the existing agent on a sequential duplicate id', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const first = await svc.create({ agentId: 'main' });
    const second = await svc.create({ agentId: 'main' });

    expect(second).toBe(first);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps a cold committed switch unready while metadata is absent and finishes after lifecycle identity restoration', async () => {
    const { getScopedServiceDescriptors, _clearScopedRegistryForTests, registerScopedService } = await import('#/_base/di/scope');
    const scopes = ['app', 'workspace', 'session', 'agent'];
    const lifecycleRegistrations = scopes.flatMap(getScopedServiceDescriptors);
    const { testAgent, sessionService } = await import('../../harness');
    const { IAgentModelSwitchService } = await import('#/agent/modelSwitch/modelSwitch');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');
    const { contextWindowEpochKey } = await import('#/agent/fullCompaction/windowEpoch');
    overrideScopedService(LifecycleScope.Agent, IAgentPromptService, AgentPromptService);
    const harnessRegistrations = scopes.flatMap(getScopedServiceDescriptors);
    const installRegistrations = (entries: typeof lifecycleRegistrations): void => {
      _clearScopedRegistryForTests();
      for (const entry of entries) registerScopedService(entry.scope, entry.id, entry.descriptor.ctor,
        entry.activation, entry.domain, entry.descriptor.staticArguments);
    };
    const withLifecycleRegistrations = async <T>(action: () => Promise<T>): Promise<T> => {
      installRegistrations(lifecycleRegistrations);
      try { return await action(); } finally { installRegistrations(harnessRegistrations); }
    };
    ix.stub(ISessionIndexMirror, { record: () => {} });
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    const metadata = ix.get(ISessionMetadata);
    const lifecycle = ix.get(IAgentLifecycleService);
    const originalIdentity = await withLifecycleRegistrations(() => lifecycle.create({ agentId: 'main' }));
    const original = testAgent(sessionService(ISessionMetadata, metadata));
    let cold: typeof original | undefined;
    try {
      await original.ready;
      original.get(IAgentContextMemoryService).append({ role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Keep the saved task' }], origin: { kind: 'user' } });
      const model = original.get(IAgentProfileService).getModel();
      const input = { operationId: 'lifecycle-cold-switch', model, mode: 'fresh' as const };
      const completed = await original.get(IAgentModelSwitchService).execute(input);
      expect(completed).toMatchObject({ state: 'completed', windowEpoch: 1, summaryGenerated: false });
      const records: WireRecord[] = [];
      for await (const record of original.get(IWireService).readJournal()) records.push(record);
      await lifecycle.remove('main');
      await metadata.unregisterAgent!('main');
      cold = testAgent(sessionService(ISessionMetadata, metadata));
      await cold.ready;
      await cold.restore(records);
      const switcher = cold.get(IAgentModelSwitchService);
      expect(await switcher.execute(input)).toMatchObject({ state: 'preparing', error: { code: 'agent_metadata_missing' } });
      expect((await metadata.read()).agents?.['main']).toBeUndefined();
      expect(switcher.get(input.operationId)?.state).toBe('preparing');
      const restoredIdentity = await withLifecycleRegistrations(() => lifecycle.create({ agentId: 'main' }));
      expect(restoredIdentity).not.toBe(originalIdentity);
      expect(lifecycle.get('main')).toBe(restoredIdentity);
      expect((await metadata.read()).agents?.['main']).toBeDefined();
      expect(await switcher.execute(input)).toEqual(completed);
      expect(cold.get(IAgentStateService).get(contextWindowEpochKey)).toBe(1);
      expect(cold.llmCalls).toHaveLength(0);
      await lifecycle.remove('main');
    } finally {
      await cold?.dispose();
      await original.dispose();
      installRegistrations(harnessRegistrations);
    }
  }, 30_000);
});


