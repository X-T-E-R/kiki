import {
  type Event2,
  type IAgentScopeHandle,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskStopHookContext,
  type RunAgentOptions,
  type ProfileData,
  IAgentContextInjectorService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentStateService,
  IAgentToolPolicyService,
  IAgentToolRegistryService,
  IAgentUserToolService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  ISessionCronService,
  ISessionSubagentService,
  IWireService,
  LifecycleScope,
} from '@kiki/agent-core-v2';
import { Event } from '../../../agent-core-v2/src/_base/event';
import type { TokenUsage } from '../../../agent-core-v2/src/kosong/contract/usage';
import {
  createTestAgent,
  sessionService,
  type TestAgentContext,
} from '../../../agent-core-v2/test/harness';

export interface AgentLifecycleStubOptions {
  readonly createAgentIds?: readonly string[];
  readonly runCompletion?: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
  readonly createError?: Error;
}

export interface AgentLifecycleStub
  extends IAgentLifecycleService,
    ISessionSubagentService {
  readonly create: (input?: Record<string, unknown>) => Promise<IAgentScopeHandle>;
  readonly run: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<AgentRunHandle>;
  readonly get: (agentId: string) => IAgentScopeHandle | undefined;
  readonly publishedEvents: Event2[];
  addHandle(agentId: string, profileName: string): void;
}

export function createAgentLifecycleStub(
  options: AgentLifecycleStubOptions = {},
): AgentLifecycleStub {
  let lifecycle: AgentLifecycleStub;
  let created = 0;
  const stateByAgentId = new Map<string, IAgentStateService>();
  const profileByAgentId = new Map<
    string,
    {
      readonly profileName: string;
      readonly modelAlias?: string;
      readonly thinkingLevel: string;
      readonly allowParentNotify?: boolean;
    }
  >();
  const handles = new Map<string, IAgentScopeHandle>();
  const publishedEvents: Event2[] = [];
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (serviceId) => {
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentContextInjectorService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentContextMemoryService) {
          return {
            _serviceBrand: undefined,
            get: () => [],
          } as never;
        }
        if (serviceId === IAgentProfileService) {
          return {
            _serviceBrand: undefined,
            data: () => profileByAgentId.get(agentId) as unknown as ProfileData,
            update: () => {},
            republishStatus: () => {},
            publishBindingAdvisories: () => {},
            getEffectiveThinkingLevel: () =>
              profileByAgentId.get(agentId)?.thinkingLevel ?? 'off',
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentToolPolicyService) {
          return {
            _serviceBrand: undefined,
            isToolActive: () =>
              profileByAgentId.get(agentId)?.allowParentNotify !== false,
          } as never;
        }
        if (serviceId === IAgentExecutionService) {
          return {
            _serviceBrand: undefined,
            run: lifecycle.run,
            status: () => ({ state: 'idle' }),
            cancel: () => false,
            settled: () => Promise.resolve(),
            shutdown: () => Promise.resolve(),
            hooks: { onWillRun: { register: () => ({ dispose: () => {} }) } },
          } as never;
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
            hooks: {
              onWillBeginStep: { register: () => ({ dispose: () => {} }) },
              onDidFinishStep: { register: () => ({ dispose: () => {} }) },
            },
          } as never;
        }
        if (serviceId === IAgentPermissionModeService) {
          return {
            _serviceBrand: undefined,
            mode: 'manual',
            setMode: () => {},
            onDidChangeMode: Event.None,
          } as never;
        }
        if (serviceId === IAgentToolRegistryService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentUserToolService) {
          return {
            _serviceBrand: undefined,
            list: () => [],
            inheritUserTools: () => {},
            register: () => {},
            unregister: () => {},
          } as never;
        }
        if (serviceId === IEventBus) {
          return {
            _serviceBrand: undefined,
            publish: (event: Event2) => {
              publishedEvents.push(event);
            },
            subscribe: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IWireService) {
          return {
            _serviceBrand: undefined,
            hooks: { onDidRestore: { register: () => ({ dispose: () => {} }) } },
            dispatch: () => {},
            replay: async () => {},
            flush: async () => {},
            getModel: () => [],
            subscribe: () => ({ dispose: () => {} }),
            onEmission: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IEventDispatcher) {
          return {
            _serviceBrand: undefined,
            hooks: { onDidRestore: { register: () => ({ dispose: () => {} }) } },
            dispatch: (event: Event2) => {
              publishedEvents.push(event);
              return Promise.resolve();
            },
            history: () => [],
            checkpointDepth: () => 0,
            undo: () => {},
            restore: () => Promise.resolve(),
            flush: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IAgentStateService) {
          return stateByAgentId.get(agentId) as never;
        }
        return undefined as never;
      },
    },
    dispose: () => {},
  });
  lifecycle = {
    _serviceBrand: undefined,
    hooks: {
      onWillStartAgentTask: {
        run: async () => {},
        register: () => ({ dispose: () => {} }),
        delete: () => false,
      },
    },
    onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
    onWillCreate: Event.None as Event<IAgentScopeHandle>,
    onDidCreate: Event.None as Event<IAgentScopeHandle>,
    onDidDispose: Event.None as Event<string>,
    create: (async (input: Record<string, unknown> = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        (input['agentId'] as string | undefined) ??
        options.createAgentIds?.[created] ??
        `agent-child-${String(created + 1)}`;
      created += 1;
      const binding = input['binding'] as
        | { profile?: string; model?: string; thinking?: string; allowParentNotify?: boolean }
        | undefined;
      const profileName = binding?.profile ?? 'coder';
      profileByAgentId.set(agentId, {
        profileName,
        modelAlias: binding?.model,
        thinkingLevel: binding?.thinking ?? 'off',
        allowParentNotify: binding?.allowParentNotify,
      });
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return createdHandle;
    }) as never,
    commitCreate: () => {},
    discard: async (agentId: string) => {
      handles.get(agentId)?.dispose();
      handles.delete(agentId);
      stateByAgentId.delete(agentId);
      profileByAgentId.delete(agentId);
    },
    notifyAgentTaskStopped: () => {},
    trackPromptRun: (_agentId: string, _completion: Promise<unknown>, signal: AbortSignal) => signal,
    fork: (async () => {
      throw new Error('unexpected fork');
    }) as never,
    run: (async (
      agentId: string,
      request: AgentRunRequest,
      runOptions: RunAgentOptions,
    ): Promise<AgentRunHandle> => {
      const completion =
        options.runCompletion?.(agentId, request, runOptions) ??
        Promise.resolve({ summary: 'child result' });
      return {
        agentId,
        turn: {} as AgentRunHandle['turn'],
        completion,
      };
    }) as never,
    get: ((agentId: string) => handles.get(agentId)) as never,
    list: () => [...handles.values()],
    broadcastPermissionMode: () => {},
    countPendingBackgroundTasks: () => 0,
    drainBackgroundTasks: (async (): Promise<void> => {
      return undefined;
    }) as never,
    remove: (async (agentId: string): Promise<void> => {
      handles.delete(agentId);
    }) as never,
    addHandle: (agentId: string, profileName: string) => {
      profileByAgentId.set(agentId, { profileName, thinkingLevel: 'off' });
      handles.set(agentId, handle(agentId));
    },
    publishedEvents,
  };
  return lifecycle;
}

const cronStub = {
  _serviceBrand: undefined,
  list: () => [],
} as unknown as ISessionCronService;

export function createAgentToolContext(lifecycle: AgentLifecycleStub): TestAgentContext {
  const ctx = createTestAgent(
    sessionService(IAgentLifecycleService, lifecycle),
    sessionService(ISessionSubagentService, lifecycle),
    sessionService(ISessionCronService, cronStub),
  );
  const config = ctx.get(IConfigService);
  const subagentSection = (config.get<{ defaultProfile?: string }>('subagent') ?? {}) as {
    defaultProfile?: string;
  };
  void config.set('subagent', {
    ...subagentSection,
    defaultProfile: subagentSection.defaultProfile ?? 'general',
  });
  lifecycle.addHandle('main', 'agent');
  return ctx;
}
