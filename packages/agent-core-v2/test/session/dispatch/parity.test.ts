import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentLoopService, type AgentLoopStatus } from '#/agent/loop/loop';
import {
  constrainPermissionMode,
  IAgentPermissionModeService,
} from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask, AgentTaskInfoBase } from '#/agent/task/types';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  ISubagentTool,
  SubagentToolInputSchema,
  type SubagentToolInput,
} from '#/agent/tools/agent/agent';
import { SubagentTool } from '#/agent/tools/agent/agentTool';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  normalizeAgentProfile,
  type AgentProfile,
  type ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type {
  SpawnConstraints,
  SubagentLease,
} from '#/app/agentProfileCatalog/subagentLease';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import {
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
  IAgentCollaborationRegistry,
} from '#/session/agentCollaboration/registry';
import { ISessionApprovalService } from '#/session/approval/approval';
import { SessionApprovalService } from '#/session/approval/approvalService';
import {
  type CreateAgentOptions,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { evaluateDispatchAdmission, tightenDispatchLaunchPolicy } from '#/session/dispatch/launchPolicy';
import {
  type DispatchUsageView,
  type ExternalAuthority,
  type ExternalDispatchRequest,
  type ExternalDispatchView,
  ISessionExternalDelegationProvisionStore,
  ISessionExternalDelegationService,
} from '#/session/externalDelegation/externalDelegation';
import { SessionExternalDelegationService } from '#/session/externalDelegation/externalDelegationService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  type AgentMeta,
  type DelegatorRef,
  ISessionMetadata,
} from '#/session/sessionMetadata/sessionMetadata';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import { ISessionQuestionService } from '#/session/question/question';
import { SessionQuestionService } from '#/session/question/questionService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IWireService } from '#/wire/wire';

import { executeTool } from '../../tools/fixtures/execute-tool';

const authority: ExternalAuthority = {
  principalFingerprint: 'a'.repeat(64),
  authorityFingerprint: 'b'.repeat(64),
  configFingerprint: 'c'.repeat(64),
};

const usage: TokenUsage = {
  inputOther: 11,
  output: 7,
  inputCacheRead: 5,
  inputCacheCreation: 3,
};

const parityLease: SubagentLease = {
  name: 'coder',
  description: 'Leased parity coder',
  modelAlias: 'parity-model',
  thinkingEffort: 'high',
  allowedModels: ['parity-model'],
  allowedEfforts: ['high'],
  tools: ['Read', 'Write'],
  disallowedTools: ['Bash'],
};

const paritySpawnPolicy: SpawnConstraints = {
  allowedModels: ['parity-model'],
  allowedEfforts: ['high'],
  disallowedTools: ['Bash'],
};

const parityProfile = normalizeAgentProfile({
  name: 'coder',
  definitionId: 'profile-coder',
  description: 'Parity coder',
  whenToUse: 'Use for parity checks',
  tools: ['Read', 'Write'],
  toolAllowPolicies: [['Read'], ['Write']],
  disallowedTools: ['Bash'],
  subagents: [],
  executor: 'native',
  modelAlias: 'parity-model',
  thinkingEffort: 'high',
  allowedModels: ['parity-model'],
  allowedEfforts: ['high'],
  delegationNotice: 'off',
  systemPrompt: () => 'coder',
});

const PROBE_DIFFERENCE_WHITELIST = {
  workIdField: ['task_id', 'dispatch_id'],
  delegatorKind: ['agent', 'external'],
  labelFields: {
    internalOnly: [
      'parentAgentId',
      'requestIdentityParentTurn',
      'requestIdentityRootAgent',
      'requestIdentityRootTurn',
    ],
    externalOnly: [],
  },
  acceptedStatus: ['running', 'queued'],
  continuationField: ['resume_hint', 'continue_hint'],
} as const;

type ProbeTuple = readonly unknown[];

type WireUsage = {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
};

interface M1DispatchView extends ExternalDispatchView {
  readonly agentId?: string;
  readonly actualProfile?: string;
  readonly nextStep?: string;
  readonly continueHint?: string;
}

interface M1ExternalService {
  dispatch(request: ExternalDispatchRequest): Promise<M1DispatchView>;
  continue(request: {
    readonly authority: ExternalAuthority;
    readonly dispatchId: string;
    readonly message: string;
    readonly dispatchKey?: string;
  }): Promise<M1DispatchView>;
  wait(request: {
    readonly authority: ExternalAuthority;
    readonly dispatchId?: string;
    readonly timeoutMs: number;
  }): Promise<{
    readonly waitStatus: 'completed' | 'timed_out' | 'no_items';
    readonly waitedMs: number;
    readonly dispatch?: M1DispatchView;
    readonly completedDuringWait: readonly M1DispatchView[];
  }>;
  send(request: {
    readonly authority: ExternalAuthority;
    readonly taskName: string;
    readonly message: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance>;
  status(request: {
    readonly authority: ExternalAuthority;
    readonly dispatchId: string;
  }): Promise<M1DispatchView>;
  result(request: {
    readonly authority: ExternalAuthority;
    readonly dispatchId: string;
  }): Promise<{ readonly dispatch: M1DispatchView; readonly text: string }>;
  list(authority: ExternalAuthority): Promise<{
    readonly delegationId: string;
    readonly children: readonly {
      readonly taskName: string;
      readonly latestDispatchId?: string;
      readonly status?: string;
      readonly usage?: DispatchUsageView;
    }[];
  }>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wireUsage(value: TokenUsage): WireUsage {
  return {
    input: value.inputOther + value.inputCacheRead + value.inputCacheCreation,
    output: value.output,
    cache_read: value.inputCacheRead,
    cache_write: value.inputCacheCreation,
  };
}

function externalWireUsage(value: DispatchUsageView | undefined): WireUsage | undefined {
  return value === undefined
    ? undefined
    : {
        input: value.input,
        output: value.output,
        cache_read: value.cacheRead,
        cache_write: value.cacheWrite,
      };
}

function outputText(output: ExecutableToolResult['output']): string {
  if (typeof output !== 'string') throw new Error('Expected text tool output');
  return output;
}

function fieldMap(text: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    text
      .split('\n')
      .flatMap((line) => {
        const index = line.indexOf(': ');
        return index < 0 ? [] : [[line.slice(0, index), line.slice(index + 2)]];
      }),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)] as const);
}

function profileSnapshot(profile: AgentProfile | undefined): ProbeTuple | undefined {
  if (profile === undefined) return undefined;
  const {
    systemPrompt,
    renderSystemPrompt,
    promptPrefix: _promptPrefix,
    ...durable
  } = profile;
  return [
    'resolved-profile',
    stableValue(durable),
    systemPrompt({}),
    stableValue(renderSystemPrompt({})),
  ];
}

function routeSnapshot(route: ResolvedAgentProfileRoute | undefined): ProbeTuple | undefined {
  if (route === undefined) return undefined;
  const { effectiveProfile, ...durable } = route;
  return ['resolved-route', stableValue(durable), profileSnapshot(effectiveProfile)];
}

function executorSnapshot(profile: AgentProfile | undefined): ProbeTuple {
  const executorId = profile?.executor ?? 'native';
  return [
    'executor',
    executorId,
    executorId === 'native' ? 'native' : undefined,
    executorId === 'native' ? undefined : stableValue(profile?.executorOptions),
    executorId === 'native' ? 'native' : undefined,
  ];
}

function labelEntries(labels: Readonly<Record<string, string>> | undefined): ProbeTuple {
  return Object.entries(labels ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
}

function normalizedLabels(
  lane: 'internal' | 'external',
  labels: Readonly<Record<string, string>> | undefined,
  parentAgentId = 'main',
): ProbeTuple {
  const values = { ...labels };
  if (lane === 'internal') {
    expect(values['parentAgentId']).toBe(parentAgentId);
    expect(values['requestIdentityParentTurn']).toBe('1');
    expect(values['requestIdentityRootAgent']).toBe('main');
    expect(values['requestIdentityRootTurn']).toBe('1');
    for (const key of PROBE_DIFFERENCE_WHITELIST.labelFields.internalOnly) delete values[key];
  }
  return ['labels', ...labelEntries(values)];
}

function labelDifferenceKeys(internal: ProbeTuple, external: ProbeTuple): {
  readonly internalOnly: readonly string[];
  readonly externalOnly: readonly string[];
} {
  const internalKeys = new Set(internal.map((entry) => (entry as readonly [string, string])[0]));
  const externalKeys = new Set(external.map((entry) => (entry as readonly [string, string])[0]));
  return {
    internalOnly: [...internalKeys].filter((key) => !externalKeys.has(key)).toSorted(),
    externalOnly: [...externalKeys].filter((key) => !internalKeys.has(key)).toSorted(),
  };
}

class ParityProbe {
  readonly profileBinds: ProbeTuple[] = [];
  readonly permissions: ProbeTuple[] = [];
  readonly names: ProbeTuple[] = [];
  readonly labels: ProbeTuple[] = [];
  readonly rawLabels: ProbeTuple[] = [];
  readonly userToolInheritance: ProbeTuple[] = [];
  readonly runs: ProbeTuple[] = [];
  readonly lifecycle: ProbeTuple[] = [];
  readonly engineUsage: WireUsage[] = [];
  readonly mailbox: ProbeTuple[] = [];
  readonly terminals: ProbeTuple[] = [];
  readonly agentIds: string[] = [];

  recordCreate(lane: 'internal' | 'external', agentId: string, options: CreateAgentOptions): void {
    const binding = options.binding;
    const profile = binding?.resolvedProfile;
    this.agentIds.push(agentId);
    this.profileBinds.push([
      'profile-bind',
      ['profile', binding?.profile],
      profileSnapshot(profile),
      ['route', binding?.route],
      routeSnapshot(binding?.resolvedRoute),
      ['model', binding?.model],
      ['thinking', binding?.thinking],
      ['lease', stableValue(binding?.lease)],
      ['spawn-policy', stableValue(binding?.spawnPolicy)],
      executorSnapshot(profile),
      ['inherited-user-tools', stableValue(binding?.inheritedUserToolNames)],
    ]);
    const expectedDelegator =
      lane === 'internal'
        ? PROBE_DIFFERENCE_WHITELIST.delegatorKind[0]
        : PROBE_DIFFERENCE_WHITELIST.delegatorKind[1];
    if (options.delegator?.kind !== expectedDelegator) {
      throw new Error(`Unexpected ${lane} delegator kind`);
    }
    this.rawLabels.push(labelEntries(options.labels));
    this.labels.push(normalizedLabels(lane, options.labels, options.delegator?.kind === 'agent' ? options.delegator.agentId : 'main'));
  }

  recordName(action: 'reserve' | 'commit' | 'release', taskName: string, owner: DelegatorRef): void {
    const expected = owner.kind === 'agent'
      ? PROBE_DIFFERENCE_WHITELIST.delegatorKind[0]
      : PROBE_DIFFERENCE_WHITELIST.delegatorKind[1];
    if (owner.kind !== expected) throw new Error('Unexpected reservation owner');
    this.names.push([action, taskName, 'owner']);
  }

  internalReceipt(text: string): ProbeTuple {
    const fields = fieldMap(text);
    if (fields['status'] !== PROBE_DIFFERENCE_WHITELIST.acceptedStatus[0]) {
      throw new Error('Unexpected internal receipt status');
    }
    return [
      'receipt',
      fields[PROBE_DIFFERENCE_WHITELIST.workIdField[0]] !== undefined,
      fields['agent_id'] !== undefined,
      fields['actual_profile'],
      'accepted',
      fields['next_step'] !== undefined,
      fields[PROBE_DIFFERENCE_WHITELIST.continuationField[0]] !== undefined,
    ];
  }

  externalReceipt(view: M1DispatchView): ProbeTuple {
    if (view.status !== PROBE_DIFFERENCE_WHITELIST.acceptedStatus[1]) {
      throw new Error('Unexpected external receipt status');
    }
    return [
      'receipt',
      view.dispatchId.length > 0,
      view.agentId !== undefined,
      view.actualProfile ?? view.profileName,
      'accepted',
      view.nextStep !== undefined,
      view.continueHint !== undefined,
    ];
  }
}

interface TaskRecord {
  readonly task: AgentTask;
  readonly controller: AbortController;
  readonly terminal: Deferred<void>;
  output: string;
  status: AgentTaskInfoBase['status'];
  startedAt: number;
  endedAt: number | null;
  stopReason?: string;
}

interface LaneOptions {
  readonly capacity?: { readonly maxDirectChildren: number; readonly maxTotalSubagents: number };
  readonly defaultProfile?: string;
  readonly profile?: AgentProfile;
  readonly mainModel?: string;
  readonly resolveModelAlias?: (id: string) => string | undefined;
  readonly modelCatalogGet?: (id: string) => Model;
  readonly validateBinding?: (binding: ExecutorBinding) => ExecutorValidationResult;
  readonly externalPermissionCeiling?: PermissionMode;
  readonly notifyParent?: boolean;
}

interface ParityLane {
  readonly probe: ParityProbe;
  readonly ix: TestInstantiationService;
  readonly lifecycleCreate: ReturnType<typeof vi.fn>;
  readonly subagentRun: ReturnType<typeof vi.fn>;
  readonly completions: Deferred<{ summary: string; usage?: TokenUsage }>[];
  readonly metadataAgents: Record<string, AgentMeta>;
  readonly handles: Map<string, IAgentScopeHandle>;
  readonly taskRecords: Map<string, TaskRecord>;
  readonly external: ISessionExternalDelegationService;
  readonly externalM1: M1ExternalService;
  readonly profile: AgentProfile;
  taskRelease?: 'detached' | 'timeout_detached' | 'terminal';
  runInternal(args: SubagentToolInput): Promise<ExecutableToolResult>;
  context(agentId: string): readonly string[];
  permissionMode(agentId: string): PermissionMode;
  setPermissionMode(agentId: string, mode: PermissionMode): void;
  setExecutionRunning(agentId: string, running: boolean): void;
  setLoopStatus(agentId: string, status: AgentLoopStatus): void;
  dropHandle(agentId: string): void;
}

function createLane(
  disposables: DisposableStore,
  lane: 'internal' | 'external',
  options: LaneOptions = {},
): ParityLane {
  const profile = options.profile ?? parityProfile;
  const probe = new ParityProbe();
  const ix = disposables.add(new TestInstantiationService());
  const documents = new Map<string, unknown>();
  const handles = new Map<string, IAgentScopeHandle>();
  const metadataAgents: Record<string, AgentMeta> = {};
  const completions: Deferred<{ summary: string; usage?: TokenUsage }>[] = [];
  const taskRecords = new Map<string, TaskRecord>();
  const stateByAgent = new Map<string, AgentStateService>();
  const profileByAgent = new Map<string, ProfileData>();
  const contextByAgent = new Map<string, string[]>();
  const permissionModeByAgent = new Map<string, PermissionMode>();
  const permissionCeilingByAgent = new Map<string, PermissionMode>();
  const executionRunning = new Set<string>();
  const loopStatusByAgent = new Map<string, AgentLoopStatus>();
  const mailboxQueue: Array<{
    readonly messageId: string;
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }> = [];
  const mailboxByKey = new Map<string, typeof mailboxQueue[number]>();
  let created = 0;
  let taskCounter = 0;
  let laneRef!: ParityLane;

  const runtime = new FakeRuntime(
    { workspaceId: 'workspace_test', runtimeId: 'local', generation: 'test' },
    { capabilities: ['process'] },
  );

  const runtimeService = {
    _serviceBrand: undefined,
    onDidChange: Event.None,
    inspect: () => runtime,
    isAvailable: () => true,
    acquire: () => ({ runtime, dispose: () => {}, track: () => {} }),
  } as unknown as IAgentRuntimeService;

  const userTools = [{ name: 'SharedTool', description: 'Shared tool', parameters: {} }];

  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IAgentActivityView) {
          return { _serviceBrand: undefined, state: () => ({ lifecycle: 'ready', background: [] }) } satisfies IAgentActivityView;
        }
        if (serviceId === IAgentLifecycleService) return lifecycle;
        if (serviceId === ISessionSubagentService) return subagents;
        if (serviceId === IAgentProfileService) {
          const data = profileByAgent.get(agentId)!;
          return {
            _serviceBrand: undefined,
            data: () => data,
            getEffectiveThinkingLevel: () => data.thinkingLevel,
            validateBinding: (binding: ExecutorBinding) => {
              const complete = {
                modelAlias: binding.modelAlias ?? data.modelAlias,
                thinkingEffort: binding.thinkingEffort ?? data.thinkingLevel,
              };
              if (data.executorId !== undefined && data.executorId !== 'native') {
                return options.validateBinding?.(complete) ?? { ok: true, binding: complete };
              }
              return {
                ok: true,
                binding: {
                  modelAlias:
                    complete.modelAlias === undefined
                      ? undefined
                      : options.resolveModelAlias?.(complete.modelAlias) ?? complete.modelAlias,
                  thinkingEffort: complete.thinkingEffort,
                },
              };
            },
            prepareResumeBinding: async (input: Parameters<IAgentProfileService['prepareResumeBinding']>[0]) => () => {
              if (input.allowParentNotify !== undefined) {
                (data as { allowParentNotify?: boolean }).allowParentNotify = input.allowParentNotify;
              }
            },
            republishStatus: () => {},
          };
        }
        if (serviceId === IAgentToolPolicyService) {
          const data = profileByAgent.get(agentId)!;
          return {
            _serviceBrand: undefined,
            isToolActive: (name: string) =>
              name !== 'AgentNotify' ||
              data.executionRestriction !== 'research-readonly' &&
              data.allowParentNotify !== false &&
              !(data.disallowedTools ?? []).includes('AgentNotify'),
          };
        }
        if (serviceId === IAgentPermissionModeService) {
          permissionModeByAgent.set(
            agentId,
            permissionModeByAgent.get(agentId) ?? (agentId === 'main' ? 'manual' : 'auto'),
          );
          return {
            _serviceBrand: undefined,
            get mode() {
              return permissionModeByAgent.get(agentId)!;
            },
            setMode: (mode: PermissionMode) => {
              const ceiling = permissionCeilingByAgent.get(agentId);
              const effective = ceiling === undefined ? mode : constrainPermissionMode(mode, ceiling);
              permissionModeByAgent.set(agentId, effective);
              probe.permissions.push(['permission', effective]);
            },
            setModeCeiling: (mode: PermissionMode) => {
              permissionCeilingByAgent.set(agentId, mode);
              permissionModeByAgent.set(
                agentId,
                constrainPermissionMode(permissionModeByAgent.get(agentId)!, mode),
              );
            },
          };
        }
        if (serviceId === IAgentUserToolService) {
          return {
            _serviceBrand: undefined,
            list: () => agentId === 'main' ? userTools : [],
            inheritUserTools: (source: IAgentUserToolService) => {
              if (agentId !== 'main') {
                probe.userToolInheritance.push([
                  'inherited-user-tools',
                  source.list().map((tool) => tool.name),
                ]);
              }
            },
          };
        }
        if (serviceId === IAgentRuntimeService) return runtimeService;
        if (serviceId === IAgentExecutionService) {
          return {
            _serviceBrand: undefined,
            status: () => executionRunning.has(agentId)
              ? { state: 'running', turnId: 1 }
              : { state: 'idle' },
            hooks: { onWillRun: { register: () => ({ dispose: () => {} }) } },
          };
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => loopStatusByAgent.get(agentId) ?? {
              state: 'idle',
              pendingTurnIds: [],
              hasPendingRequests: false,
            },
          };
        }
        if (serviceId === IAgentContextMemoryService) {
          return {
            _serviceBrand: undefined,
            get: () => [],
          };
        }
        if (serviceId === IAgentContextInjectorService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          };
        }
        if (serviceId === IAgentToolRegistryService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          };
        }
        if (serviceId === IEventBus) {
          return {
            _serviceBrand: undefined,
            publish: () => {},
            subscribe: () => ({ dispose: () => {} }),
          };
        }
        if (serviceId === IWireService) {
          return {
            _serviceBrand: undefined,
            readJournal: async function* () {},
            flush: async () => {},
          };
        }
        if (serviceId === IEventDispatcher) {
          return {
            _serviceBrand: undefined,
            dispatch: async (_event: Event2) => {},
          };
        }
        if (serviceId === IAgentStateService) {
          let state = stateByAgent.get(agentId);
          if (state === undefined) {
            state = new AgentStateService();
            stateByAgent.set(agentId, state);
          }
          return state;
        }
        if (serviceId === IAgentTokenCountingService) {
          return {
            _serviceBrand: undefined,
            statusSize: () => 0,
          };
        }
        if (serviceId === ITelemetryService) return noopTelemetryService;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  } as IAgentScopeHandle);

  profileByAgent.set('main', {
    modelAlias: options.mainModel ?? 'main-model',
    modelCapabilities: UNKNOWN_CAPABILITY,
    profileName: 'agent',
    thinkingLevel: 'off',
    systemPrompt: '',
    subagents: [profile.name],
    subagentLeases: profile === parityProfile ? { [profile.name]: parityLease } : undefined,
    spawnPolicy: profile === parityProfile ? paritySpawnPolicy : undefined,
  });
  metadataAgents['main'] = { type: 'main', labels: {} };
  contextByAgent.set('main', []);
  permissionModeByAgent.set('main', 'manual');
  handles.set('main', handle('main'));

  const lifecycleCreate = vi.fn(async (createOptions: CreateAgentOptions = {}) => {
    const agentId = createOptions.agentId ?? `agent_child_${String(++created)}`;
    const binding = createOptions.binding;
    const prior = profileByAgent.get(agentId);
    if (binding === undefined && prior !== undefined) {
      const restoredHandle = handle(agentId);
      handles.set(agentId, restoredHandle);
      return restoredHandle;
    }
    const resolved = binding?.resolvedProfile ?? profile;
    const requestedBinding = {
      modelAlias: binding?.model ?? resolved.modelAlias,
      thinkingEffort: binding?.thinking ?? resolved.thinkingEffort ?? 'off',
    };
    const validated =
      resolved.executor !== undefined && resolved.executor !== 'native'
        ? options.validateBinding?.(requestedBinding) ?? { ok: true as const, binding: requestedBinding }
        : { ok: true as const, binding: requestedBinding };
    if (!validated.ok) throw new Error(validated.diagnostic);
    profileByAgent.set(agentId, {
      modelAlias: validated.binding.modelAlias,
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: binding?.profile ?? resolved.name,
      profileDefinitionId: resolved.definitionId,
      thinkingLevel: validated.binding.thinkingEffort ?? 'off',
      effectiveThinkingLevel: validated.binding.thinkingEffort ?? 'off',
      routeDetached: binding?.resolvedRoute !== undefined && (
        binding.resolvedRoute.lockedModelAlias !== undefined &&
        binding.resolvedRoute.lockedModelAlias !== validated.binding.modelAlias ||
        binding.resolvedRoute.lockedThinkingEffort !== undefined &&
        binding.resolvedRoute.lockedThinkingEffort !== validated.binding.thinkingEffort
      ),
      profileSource: 'fileSources' in resolved ? 'profile-file' : 'registered',
      systemPrompt: '',
      executionRestriction: binding?.executionRestriction ?? prior?.executionRestriction,
      allowParentNotify: binding?.allowParentNotify ?? prior?.allowParentNotify ?? resolved.allowParentNotify,
      activeToolNames: resolved.tools,
      disallowedTools: resolved.disallowedTools,
      executorId: resolved.executor,
      subagentPolicy: resolved.subagentPolicy,
      subagentDeclaration: resolved.subagentDeclaration,
      subagents: resolved.subagents,
      dispatchDecision: binding?.dispatchDecision,
      spawnPolicy: binding?.spawnPolicy,
      appliedLease: binding?.lease,
    });
    metadataAgents[agentId] = {
      type: 'sub',
      parentAgentId: createOptions.delegator?.kind === 'agent'
        ? createOptions.delegator.agentId
        : undefined,
      delegator: createOptions.delegator,
      labels: {
        ...createOptions.labels,
        profileName: binding?.profile ?? resolved.name,
      },
      displayName: binding?.profile,
      model: validated.binding.modelAlias,
      thinkingEffort: validated.binding.thinkingEffort,
      executor: resolved.executor,
    };
    contextByAgent.set(agentId, []);
    permissionModeByAgent.set(agentId, permissionModeByAgent.get(agentId) ?? 'auto');
    const createdHandle = handle(agentId);
    handles.set(agentId, createdHandle);
    probe.recordCreate(lane, agentId, createOptions);
    return createdHandle;
  });

  const lifecycle = {
    _serviceBrand: undefined,
    onWillCreate: Event.None,
    onDidCreate: Event.None,
    onDidDispose: Event.None,
    create: lifecycleCreate,
    commitCreate: vi.fn(),
    discard: vi.fn(async (agentId: string) => {
      handles.get(agentId)?.dispose();
      handles.delete(agentId);
      delete metadataAgents[agentId];
    }),
    get: (agentId: string) => handles.get(agentId),
    list: () => [...handles.values()],
    broadcastPermissionMode: () => {},
    remove: async (agentId: string) => {
      handles.delete(agentId);
    },
    fork: async () => {
      throw new Error('Unexpected fork');
    },
  } as unknown as IAgentLifecycleService;

  const subagentRun = vi.fn(
    async (
      agentId: string,
      request: AgentRunRequest,
      _runOptions: RunAgentOptions,
    ): Promise<AgentRunHandle> => {
      for (const message of mailboxQueue.splice(0)) {
        if (message.targetAgentId !== agentId) {
          mailboxQueue.push(message);
          continue;
        }
        probe.mailbox.push([
          'inject',
          'before-next-run',
          message.sourceAgentId,
          message.sourceTaskName,
          message.targetTaskName,
          message.content,
        ]);
      }
      probe.lifecycle.push(['running']);
      probe.runs.push([
        'run',
        agentId,
        request.kind,
        request.kind === 'prompt' ? request.prompt : undefined,
      ]);
      if (request.kind === 'prompt') {
        const context = contextByAgent.get(agentId) ?? [];
        context.push(request.prompt);
        contextByAgent.set(agentId, context);
      }
      const completion = deferred<{ summary: string; usage?: TokenUsage }>();
      completions.push(completion);
      void completion.promise.then((result) => {
        probe.terminals.push(['completed', result.summary]);
        if (result.usage !== undefined) probe.engineUsage.push(wireUsage(result.usage));
        probe.lifecycle.push(['completed']);
      });
      return {
        agentId,
        turn: {} as AgentRunHandle['turn'],
        completion: completion.promise,
      };
    },
  );

  const subagents = {
    _serviceBrand: undefined,
    hooks: {
      onWillStartAgentTask: {
        run: async () => {},
        register: () => ({ dispose: () => {} }),
        delete: () => false,
      },
    },
    onDidStopAgentTask: Event.None,
    run: subagentRun,
    notifyAgentTaskStopped: () => {},
  } as unknown as ISessionSubagentService;

  const taskService = {
    _serviceBrand: undefined,
    registerTask: (task: AgentTask) => {
      const taskId = `task_${String(++taskCounter)}`;
      const controller = new AbortController();
      const terminal = deferred<void>();
      const record: TaskRecord = {
        task,
        controller,
        terminal,
        output: '',
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
      };
      taskRecords.set(taskId, record);
      void task.start({
        signal: controller.signal,
        appendOutput: (chunk) => {
          record.output += chunk;
        },
        settle: async (settlement) => {
          record.status = settlement.status;
          record.stopReason = settlement.stopReason;
          record.endedAt = Date.now();
          terminal.resolve();
          return true;
        },
      });
      return taskId;
    },
    waitForForegroundRelease: async (taskId: string) => {
      if (laneRef.taskRelease !== undefined) return laneRef.taskRelease;
      await taskRecords.get(taskId)!.terminal.promise;
      return 'terminal' as const;
    },
    getTask: (taskId: string) => {
      const record = taskRecords.get(taskId);
      if (record === undefined) return undefined;
      return record.task.toInfo({
        taskId,
        description: record.task.description,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        stopReason: record.stopReason,
      });
    },
    readOutput: async (taskId: string) => taskRecords.get(taskId)?.output ?? '',
  };

  const catalog = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None,
    get: (name: string) => name === profile.name ? profile : undefined,
    getDefault: () => profile,
    list: () => [profile],
    listRoutes: () => [],
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  } as unknown as ISessionAgentProfileCatalog;

  const metadata = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None,
    read: async () => ({
      id: 'session_test',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: metadataAgents,
    }),
    usage: () => undefined,
    recordUsage: () => {},
    update: async () => {},
    setTitle: async () => {},
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async (agentId: string, meta: AgentMeta) => {
      metadataAgents[agentId] = meta;
    },
  } as ISessionMetadata;

  const names = new Set<string>();
  const registry = {
    _serviceBrand: undefined,
    reserve: async (taskName: string, owner: DelegatorRef) => {
      probe.recordName('reserve', taskName, owner);
      if (names.has(taskName)) return false;
      names.add(taskName);
      return true;
    },
    commit: (taskName: string, owner: DelegatorRef) => {
      probe.recordName('commit', taskName, owner);
    },
    release: (taskName: string, owner: DelegatorRef) => {
      probe.recordName('release', taskName, owner);
      names.delete(taskName);
    },
  };

  ix.stub(IFlagService, { enabled: () => true });
  ix.stub(IAtomicDocumentStore, {
    _serviceBrand: undefined,
    get: async <T>(_scope: string, key: string) => documents.get(key) as T | undefined,
    set: async (_scope, key, value) => {
      documents.set(key, structuredClone(value));
    },
    delete: async () => {},
    list: async () => [],
    watch: () => () => ({ dispose: () => {} }),
    acquire: () => ({ dispose: () => {} }),
  });
  ix.stub(ISessionExternalDelegationProvisionStore, {
    read: async () => undefined,
    write: async () => {},
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
  ix.stub(ISessionWorkspaceContext, {
    _serviceBrand: undefined,
    workDir: '/workspace',
    additionalDirs: [],
  });
  ix.stub(ISessionManager, { onWillCloseSession: undefined });
  ix.stub(ILogService, {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ix.get(ILogService),
  });
  ix.stub(IBootstrapService, {
    getEnv: () => options.externalPermissionCeiling ?? 'yolo',
  });
  const subagentConfig = { ...options.capacity, defaultProfile: options.defaultProfile };
  ix.stub(IConfigService, {
    get: <T>(section: string) => (
      section === 'subagent'
        ? subagentConfig
        : section === 'agents'
          ? { notify_parent: options.notifyParent ?? true }
          : undefined
    ) as T,
    inspect: <T>(section: string) => ({
      value: section === 'subagent' ? subagentConfig as T : undefined,
      defaultValue: undefined,
      userValue: section === 'subagent' ? subagentConfig as T : undefined,
      memoryValue: undefined,
    }),
  });
  ix.stub(IModelService, { resolveId: options.resolveModelAlias ?? ((id: string) => id) });
  ix.stub(IModelCatalog, {
    get: options.modelCatalogGet ?? ((id: string) => ({ id }) as Model),
    getRequester: (id: string) => ({
      model: { id } as Model,
      request: async function* () {},
    }),
  });
  ix.stub(ISessionAgentProfileCatalog, catalog);
  ix.stub(ISessionMetadata, metadata);
  ix.stub(IAgentLifecycleService, lifecycle);
  ix.stub(ISessionSubagentService, subagents);
  ix.stub(IAgentCollaborationRegistry, registry);
  ix.stub(IAgentCollaborationMessagingService, {
    send: async (input) => {
      const prior = mailboxByKey.get(input.idempotencyKey);
      const message = prior ?? {
        messageId: `message_${String(mailboxByKey.size + 1)}`,
        ...input,
      };
      if (prior === undefined) {
        mailboxByKey.set(input.idempotencyKey, message);
        mailboxQueue.push(message);
      }
      return {
        message: {
          messageId: message.messageId,
          sessionId: 'session_test',
          sourceAgentId: message.sourceAgentId,
          sourceTaskName: message.sourceTaskName,
          targetAgentId: message.targetAgentId,
          targetTaskName: message.targetTaskName,
          content: message.content,
          acceptedAt: 1,
          targetSeq: 1,
        },
        deduplicated: prior !== undefined,
        delivery: 'queued',
        payloadConflict: false,
      };
    },
  });
  ix.stub(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId: 'main',
    scope: (key?: string) => `agent/main/${key ?? ''}`,
  });
  ix.stub(IAgentTaskService, taskService);
  ix.stub(IAgentProfileService, handles.get('main')!.accessor.get(IAgentProfileService));
  ix.stub(IAgentPermissionModeService, handles.get('main')!.accessor.get(IAgentPermissionModeService));
  ix.stub(IAgentRuntimeService, runtimeService);
  ix.stub(IAgentToolPolicyService, {
    isToolActive: () => true,
    isToolActiveForDisclosure: () => true,
    isToolActiveForProfile: () => true,
    setSessionDisabledTools: async () => {},
  });
  ix.stub(IAgentToolRegistryService, {
    register: () => ({ dispose: () => {} }),
    list: () => [],
    listReferences: () => [],
    resolve: () => undefined,
  });
  ix.stub(
    AgentToolContribution as unknown as ServiceIdentifier<CollectionView<AgentToolContribution>>,
    { items: [] },
  );
  ix.set(ISessionStateService, new SessionStateService());
  ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  ix.set(ISessionApprovalService, new SyncDescriptor(SessionApprovalService));
  ix.set(ISessionQuestionService, new SyncDescriptor(SessionQuestionService));
  ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
  ix.set(ISubagentTool, new SyncDescriptor(SubagentTool));
  ix.set(
    ISessionExternalDelegationService,
    new SyncDescriptor(SessionExternalDelegationService),
  );

  const external = ix.get(ISessionExternalDelegationService);
  laneRef = {
    probe,
    ix,
    lifecycleCreate,
    subagentRun,
    completions,
    metadataAgents,
    handles,
    taskRecords,
    external,
    externalM1: external as unknown as M1ExternalService,
    profile,
    runInternal: async (args) => {
      const parsed = SubagentToolInputSchema.parse(args);
      return executeTool(ix.get(ISubagentTool), {
        turnId: 1,
        toolCallId: `call_${String(taskCounter + 1)}`,
        args: parsed,
        signal: new AbortController().signal,
      });
    },
    context: (agentId) => contextByAgent.get(agentId) ?? [],
    permissionMode: (agentId) => permissionModeByAgent.get(agentId)!,
    setPermissionMode: (agentId, mode) => {
      permissionModeByAgent.set(agentId, mode);
    },
    setExecutionRunning: (agentId, running) => {
      if (running) executionRunning.add(agentId);
      else executionRunning.delete(agentId);
    },
    setLoopStatus: (agentId, status) => {
      loopStatusByAgent.set(agentId, status);
    },
    dropHandle: (agentId) => {
      handles.delete(agentId);
      permissionCeilingByAgent.delete(agentId);
    },
  };
  return laneRef;
}

async function waitForCompletionSlot(lane: ParityLane, index: number): Promise<void> {
  await vi.waitFor(() => {
    expect(lane.completions.length).toBeGreaterThan(index);
  });
}

async function complete(
  lane: ParityLane,
  index: number,
  summary = 'done',
  tokenUsage: TokenUsage | undefined = usage,
): Promise<void> {
  await waitForCompletionSlot(lane, index);
  lane.completions[index]!.resolve({ summary, usage: tokenUsage });
  await Promise.resolve();
}

async function completeExternal(
  lane: ParityLane,
  dispatchId: string,
  index: number,
  summary = 'done',
  tokenUsage: TokenUsage | undefined = usage,
): Promise<void> {
  await complete(lane, index, summary, tokenUsage);
  await vi.waitFor(async () => {
    expect((await lane.external.status({ authority, dispatchId })).status).toBe('completed');
  });
}

async function spawnPair(internal: ParityLane, external: ParityLane) {
  const internalResult = await internal.runInternal({
    prompt: 'inspect parity',
    description: 'Inspect parity',
    profile: 'coder',
    name: 'parity_child',
    background: true,
    model_alias: 'parity-model',
    effort: 'high',
  });
  const externalView = await external.external.dispatch({
    authority,
    target: 'named',
    taskName: 'parity_child',
    profileName: 'coder',
    modelAlias: 'parity-model',
    thinkingEffort: 'high',
    message: 'inspect parity',
  });
  await vi.waitFor(() => {
    expect(external.subagentRun).toHaveBeenCalledTimes(1);
  });
  return { internalResult, externalView };
}

describe('AgentRun and dispatch parity golden', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('MP-01 uses route effort by default and permits an explicit detached override', async () => {
    const profile = normalizeAgentProfile({ ...parityProfile, allowedEfforts: ['low', 'high'], modelProfiles: [{ alias: 'parity-model', thinkingEffort: 'low' }] });
    const lane = createLane(disposables, 'internal', { profile });
    const route: ResolvedAgentProfileRoute = { id: 'coder.locked', profile: 'coder', description: '', modelAlias: 'parity-model', thinkingEffort: 'high', lockedModelAlias: 'parity-model', lockedThinkingEffort: 'high', overriddenFields: ['model_alias', 'thinking_effort'], effectiveProfile: profile };
    Object.assign(lane.ix.get(ISessionAgentProfileCatalog), { resolveSelection: () => ({ profile, baseProfile: profile, route }), listRoutes: () => [route] });
    const result = await lane.runInternal({ route: route.id, prompt: 'work', description: 'MP01 route default', background: true });
    expect(result.isError).not.toBe(true);
    expect(lane.lifecycleCreate.mock.calls[0]?.[0]?.binding?.thinking).toBe('high');
    const detached = await lane.runInternal({ route: route.id, effort: 'low', prompt: 'work', description: 'MP01 route override', background: true });
    expect(detached.output).toContain('route_status: detached');
    expect(lane.lifecycleCreate.mock.calls[1]?.[0]?.binding?.thinking).toBe('low');
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(2);
  });

  it('resolves parent notification from the default, profile setting, and dispatch override', async () => {
    const defaultLane = createLane(disposables, 'internal');
    const defaultResult = await defaultLane.runInternal({
      profile: 'coder', prompt: 'work', description: 'Default notify', background: true,
    });
    expect(defaultLane.lifecycleCreate.mock.calls[0]?.[0]?.binding?.allowParentNotify).toBeUndefined();
    expect(outputText(defaultResult.output)).toContain('parent_notify: enabled');
    await complete(defaultLane, 0);

    const disabledLane = createLane(disposables, 'internal');
    const disabledResult = await disabledLane.runInternal({
      profile: 'coder', prompt: 'work', description: 'Disable notify', background: true,
      allow_parent_notify: false,
    });
    expect(disabledLane.lifecycleCreate.mock.calls[0]?.[0]?.binding?.allowParentNotify).toBe(false);
    expect(outputText(disabledResult.output)).toContain('parent_notify: disabled');
    await complete(disabledLane, 0);

    const quietProfile = normalizeAgentProfile({ ...parityProfile, allowParentNotify: false });
    const quietLane = createLane(disposables, 'internal', { profile: quietProfile });
    const quietResult = await quietLane.runInternal({
      profile: 'coder', prompt: 'work', description: 'Quiet notify', background: true,
    });
    expect(quietLane.lifecycleCreate.mock.calls[0]?.[0]?.binding?.allowParentNotify).toBe(false);
    expect(outputText(quietResult.output)).toContain('parent_notify: disabled');
    await complete(quietLane, 0);

    const overrideLane = createLane(disposables, 'internal', { profile: quietProfile });
    const overrideResult = await overrideLane.runInternal({
      profile: 'coder', prompt: 'work', description: 'Override notify', background: true,
      allow_parent_notify: true,
    });
    expect(overrideLane.lifecycleCreate.mock.calls[0]?.[0]?.binding?.allowParentNotify).toBe(true);
    expect(outputText(overrideResult.output)).toContain('parent_notify: enabled');
    await complete(overrideLane, 0);

    const globallyDisabledLane = createLane(disposables, 'internal', { notifyParent: false });
    const globallyDisabledResult = await globallyDisabledLane.runInternal({
      profile: 'coder', prompt: 'work', description: 'Global notify veto', background: true,
      allow_parent_notify: true,
    });
    expect(outputText(globallyDisabledResult.output)).toContain('parent_notify: disabled');
    await complete(globallyDisabledLane, 0);
  });

  it('persists parent notification across resume omission and applies explicit resume overrides', async () => {
    const lane = createLane(disposables, 'internal');
    const spawned = await lane.runInternal({
      profile: 'coder', name: 'notify_child', prompt: 'work', description: 'Spawn notify', background: true,
    });
    expect(outputText(spawned.output)).toContain('parent_notify: enabled');
    await complete(lane, 0);

    const disabled = await lane.runInternal({
      resume: 'notify_child', prompt: 'continue', description: 'Disable notify', background: true,
      allow_parent_notify: false,
    });
    expect(outputText(disabled.output)).toContain('parent_notify: disabled');
    await complete(lane, 1);

    const preserved = await lane.runInternal({
      resume: 'notify_child', prompt: 'continue', description: 'Preserve notify', background: true,
    });
    expect(outputText(preserved.output)).toContain('parent_notify: disabled');
    await complete(lane, 2);

    const enabled = await lane.runInternal({
      resume: 'notify_child', prompt: 'continue', description: 'Enable notify', background: true,
      allow_parent_notify: true,
    });
    expect(outputText(enabled.output)).toContain('parent_notify: enabled');
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(1);
    await complete(lane, 3);
  });

  it('shares the tree limit across main, child and grandchild dispatch and retains cancelled descendants until settlement', async () => {
    const lane = createLane(disposables, 'internal', { capacity: { maxDirectChildren: 16, maxTotalSubagents: 2 } });
    const dispatch = lane.ix.get(ISessionDispatchService);
    const controller = new AbortController();
    const input = (caller: string) => ({
      requesterAgentId: caller, delegator: { kind: 'agent', agentId: caller } as const,
      profileName: 'coder', message: 'work', parentTurnId: 1, workDir: '/workspace',
      runtime: lane.ix.get(IAgentRuntimeService).inspect(), signal: controller.signal,
    });
    const parent = await dispatch.launch(input('main'));
    Object.assign(parent.child.agent.accessor.get(IAgentProfileService).data(), { subagents: ['coder'] });
    const grandchild = await dispatch.launch(input(parent.child.agentId));
    Object.assign(grandchild.child.agent.accessor.get(IAgentProfileService).data(), { subagents: ['coder'] });
    await expect(dispatch.launch(input(grandchild.child.agentId))).rejects.toMatchObject({
      code: 'dispatch.limit_exceeded', details: { layer: 'tree', current: 2, limit: 2 },
    });
    const parentStarted = await parent.started;
    lane.completions[0]!.resolve({ summary: 'parent done' });
    await parentStarted.completion;
    const deepest = await dispatch.launch(input(grandchild.child.agentId));
    await deepest.started;
    controller.abort(new Error('cancel requested'));
    await expect(dispatch.launch({ ...input('main'), signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'dispatch.limit_exceeded', details: { layer: 'tree', current: 2, limit: 2 },
    });
    lane.completions[1]!.resolve({ summary: 'cancelled execution settled' });
    await (await grandchild.started).completion;
    await dispatch.launch({ ...input('main'), signal: new AbortController().signal });
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(4);
  });

  it('loads profile_file through AgentRun without registering its name or hardening unmarked recommendations', async () => {
    const lane = createLane(disposables, 'internal');
    const runtime = lane.ix.get(IAgentRuntimeService).inspect();
    const readText = vi.fn(async () => '---\nname: coder\ndescription: File role\nmodel_alias: parity-model\nthinking_effort: high\ntools: [Read, Write, Bash]\nsubagents: [coder, outside]\n---\nFILE INSTRUCTIONS');
    Object.defineProperty(runtime, 'fs', { value: { realpath: async (path: string) => path, readText } });
    Object.assign(lane.handles.get('main')!.accessor.get(IAgentProfileService).data(), { activeToolNames: ['Read'], disallowedTools: ['Bash'] });
    const original = lane.ix.get(ISessionAgentProfileCatalog).get('coder');
    const result = await lane.runInternal({ profile_file: 'custom.md', prompt: 'use file role', description: 'File role', background: true });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('profile_source: profile_file');
    expect(readText).toHaveBeenCalledWith('/workspace/custom.md');
    expect(lane.ix.get(ISessionAgentProfileCatalog).get('coder')).toBe(original);
    const bound = lane.lifecycleCreate.mock.calls[0]![0]!.binding!.resolvedProfile!;
    expect(bound.sourcePath).toBe('/workspace/custom.md');
    expect(bound.toolAllowPolicies).toContainEqual(['Read']);
    expect(bound.disallowedTools).toContain('Bash');
    expect(bound.subagents).toEqual(['coder', 'outside']);
    expect(bound.systemPrompt({})).toContain('FILE INSTRUCTIONS');
    await complete(lane, 0);
    const denied = await lane.runInternal({ profile_file: 'custom.md', model_alias: 'outside-model', prompt: 'fail', description: 'Reject escape', background: true });
    expect(denied.isError).toBe(true);
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(1);
    await expect(lane.ix.get(ISubagentTool).resolveExecution({ profile_file: '/outside/custom.md', prompt: 'fail', description: 'Outside path' })).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });

  it('allows advisory profile_file deviations, records them, and keeps strict profile_file admission', async () => {
    const lane = createLane(disposables, 'internal');
    const runtime = lane.ix.get(IAgentRuntimeService).inspect();
    Object.defineProperty(runtime, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: reviewer\ndescription: File reviewer\nmodel_alias: parity-model\nsubagent_policy: strict\nsubagents: []\n---\nREVIEW',
    } });
    const caller = lane.handles.get('main')!.accessor.get(IAgentProfileService).data();
    Object.assign(caller, {
      subagentPolicy: 'advisory',
      subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });
    const allowed = await lane.runInternal({
      profile_file: 'reviewer.md', prompt: 'review', description: 'Review', background: true,
    });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.output).toContain('dispatch_policy: advisory');
    expect(allowed.output).toContain('recommendation_status: allowed_nonpreferred');
    expect(allowed.output).toContain('recommendation_deviation: true');
    expect(allowed.output).toContain('selection_kind: profile_file');

    Object.assign(caller, {
      subagentPolicy: 'strict',
      subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });
    const blocked = await lane.runInternal({
      profile_file: 'reviewer.md', prompt: 'review', description: 'Review', background: true,
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('strict subagent policy');
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(1);
  });

  it('uses the internal generic profile for omitted targets without an explicit default', async () => {
    const lane = createLane(disposables, 'internal');
    const caller = lane.handles.get('main')!.accessor.get(IAgentProfileService).data();
    Object.assign(caller, {
      subagentPolicy: undefined,
      subagentDeclaration: { kind: 'set', names: ['coder'] },
      subagents: ['coder'],
    });
    const result = await lane.runInternal({
      prompt: 'work', description: 'Generic default', background: true,
      model_alias: 'parity-model', effort: 'high',
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('actual_profile: general');
    expect(result.output).toContain('selection_origin: configured-fallback');
    expect(result.output).toContain('recommendation_status: allowed_nonpreferred');
    const resolved = lane.lifecycleCreate.mock.calls[0]![0]!.binding!.resolvedProfile!;
    expect(resolved).not.toBe(parityProfile);
    expect(resolved.systemPrompt({ productName: 'Kiki' })).toContain('You are a general-purpose subagent.');
  });

  it('uses an explicitly configured default profile for omitted targets', async () => {
    const lane = createLane(disposables, 'internal', { defaultProfile: 'coder' });
    const result = await lane.runInternal({
      prompt: 'work', description: 'Configured default', background: true,
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('actual_profile: coder');
    expect(lane.lifecycleCreate.mock.calls[0]![0]!.binding!.resolvedProfile).toBe(parityProfile);
  });

  it('blocks concurrent creation before side effects, and releases only when execution settles', async () => {
    const lane = createLane(disposables, 'internal', { capacity: { maxDirectChildren: 1, maxTotalSubagents: 0 } });
    const dispatch = lane.ix.get(ISessionDispatchService);
    const input = {
      requesterAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' } as const,
      profileName: 'coder', message: 'work', parentTurnId: 1, workDir: '/workspace',
      runtime: lane.ix.get(IAgentRuntimeService).inspect(), signal: new AbortController().signal,
    };
    await expect(dispatch.launch({ ...input, signal: AbortSignal.abort(new Error('cancelled before launch')) })).rejects.toThrow('cancelled before launch');
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    const first = dispatch.launch(input);
    await expect(dispatch.launch(input)).rejects.toMatchObject({
      code: 'dispatch.limit_exceeded', details: { layer: 'direct', current: 1, limit: 1 },
    });
    const run = await first;
    await run.started;
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(1);
    await expect(dispatch.launch(input)).rejects.toMatchObject({ code: 'dispatch.limit_exceeded' });
    lane.completions[0]!.resolve({ summary: 'done' });
    await (await run.started).completion;
    await dispatch.launch(input);
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(2);
  });

  it('releases a failed launch reservation and prevents concurrent resume during preparation', async () => {
    const lane = createLane(disposables, 'internal', { capacity: { maxDirectChildren: 1, maxTotalSubagents: 1 } });
    const dispatch = lane.ix.get(ISessionDispatchService);
    const input = {
      requesterAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' } as const,
      profileName: 'coder', message: 'work', parentTurnId: 1, workDir: '/workspace',
      runtime: lane.ix.get(IAgentRuntimeService).inspect(), signal: new AbortController().signal,
    };
    lane.lifecycleCreate.mockRejectedValueOnce(new Error('create failed'));
    await expect(dispatch.launch(input)).rejects.toThrow('create failed');
    const run = await dispatch.launch(input);
    const started = await run.started;
    lane.completions[0]!.resolve({ summary: 'done' });
    await started.completion;
    const gate = deferred<void>();
    const resumed = dispatch.runOnExisting(run.child, 'continue', {
      signal: input.signal, requesterAgentId: 'main', onBeforeRun: () => gate.promise,
    });
    await expect(dispatch.runOnExisting(run.child, 'duplicate', {
      signal: input.signal, requesterAgentId: 'main',
    })).rejects.toMatchObject({ code: 'agent.already_running' });
    gate.resolve();
    await resumed;
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(2);
  });

  it.each(['before-ownership', 'durable', 'run'] as const)('rolls back only unowned creation failures at %s', async (boundary) => {
    const lane = createLane(disposables, 'internal');
    const dispatch = lane.ix.get(ISessionDispatchService);
    const lifecycle = lane.ix.get(IAgentLifecycleService);
    const failure = new Error('injected launch failure');
    const input = {
      requesterAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' } as const,
      profileName: 'coder',
      name: 'retry_child',
      message: 'work',
      parentTurnId: 1,
      workDir: '/workspace',
      runtime: lane.ix.get(IAgentRuntimeService).inspect(),
      signal: new AbortController().signal,
      onCreated: async (_child: unknown, retain: () => void) => {
        if (boundary === 'durable') retain();
        if (boundary !== 'run') throw failure;
      },
    };
    if (boundary === 'run') lane.subagentRun.mockRejectedValueOnce(failure);
    if (boundary === 'run') {
      const run = await dispatch.launch(input);
      await expect(run.started).rejects.toBe(failure);
    } else {
      await expect(dispatch.launch(input)).rejects.toBe(failure);
    }
    expect(lane.lifecycleCreate.mock.calls[0]![0]).toMatchObject({ deferCreateEvent: true });
    if (boundary === 'before-ownership') {
      expect(lifecycle.discard).toHaveBeenCalledWith('agent_child_1');
      expect(lifecycle.commitCreate).not.toHaveBeenCalled();
      expect([...lane.handles.keys()]).toEqual(['main']);
      expect(Object.keys(lane.metadataAgents)).toEqual(['main']);
      expect(lane.subagentRun).not.toHaveBeenCalled();
      const retried = await dispatch.launch({ ...input, onCreated: undefined });
      await retried.started;
      expect(retried.child.agentId).toBe('agent_child_2');
      expect(lifecycle.commitCreate).toHaveBeenCalledWith('agent_child_2');
    } else {
      expect(lifecycle.discard).not.toHaveBeenCalled();
      expect(lifecycle.commitCreate).toHaveBeenCalledWith('agent_child_1');
      expect(lane.handles.has('agent_child_1')).toBe(true);
      expect(lane.metadataAgents['agent_child_1']).toBeDefined();
    }
  });

  it('reports the original launch failure and discard failure while releasing the name reservation', async () => {
    const lane = createLane(disposables, 'internal');
    const failure = new Error('initial write failed');
    const cleanupFailure = new Error('discard failed');
    vi.mocked(lane.ix.get(IAgentLifecycleService).discard).mockRejectedValueOnce(cleanupFailure);
    const rejected = lane.ix.get(ISessionDispatchService).launch({
      requesterAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' },
      profileName: 'coder',
      name: 'failed_child',
      message: 'work',
      parentTurnId: 1,
      workDir: '/workspace',
      runtime: lane.ix.get(IAgentRuntimeService).inspect(),
      signal: new AbortController().signal,
      onCreated: async () => { throw failure; },
    });
    await expect(rejected).rejects.toMatchObject({ cause: failure, errors: [failure, cleanupFailure] });
    expect(lane.probe.names).toContainEqual(expect.arrayContaining(['release']));
  });

  it.each(['manual', 'auto', 'yolo'] as const)('birth-binds research before the first run in %s without prefix or inherited tools', async (mode) => {
    const prefix = vi.fn(async () => 'must not execute');
    const lane = createLane(disposables, 'internal', { profile: { ...parityProfile, promptPrefix: prefix } });
    lane.setPermissionMode('main', mode);
    Object.assign(lane.handles.get('main')!.accessor.get(IAgentProfileService).data(), {
      subagentLeases: { coder: parityLease }, spawnPolicy: paritySpawnPolicy,
    });
    const dispatch = lane.ix.get(ISessionDispatchService);
    disposables.add(dispatch.registerPlanStateReader('main', () => true));
    const result = await lane.runInternal({
      profile: 'coder', prompt: 'research only', description: 'Research code', background: true,
      allow_parent_notify: true,
    });
    expect(result.isError).not.toBe(true);
    expect(outputText(result.output)).toContain('parent_notify: disabled');
    expect(lane.lifecycleCreate).toHaveBeenCalledTimes(1);
    const birth = lane.lifecycleCreate.mock.calls[0]![0]!;
    expect(birth.binding?.executionRestriction).toBe('research-readonly');
    expect(birth.binding?.inheritedUserToolNames).toBeUndefined();
    expect(birth.binding?.lease).toEqual(parityLease);
    expect(birth.binding?.spawnPolicy).toEqual(paritySpawnPolicy);
    expect(prefix).not.toHaveBeenCalled();
    expect(lane.probe.userToolInheritance).toEqual([]);
    expect(lane.permissionMode('agent_child_1')).toBe(mode);
    expect(lane.handles.get('agent_child_1')!.accessor.get(IAgentProfileService).data().executionRestriction).toBe('research-readonly');
    await complete(lane, 0);
  });

  it('retains an issued research ceiling while catalog readiness is pending and plan exits', async () => {
    const lane = createLane(disposables, 'internal');
    const dispatch = lane.ix.get(ISessionDispatchService);
    let active = true;
    disposables.add(dispatch.registerPlanStateReader('main', () => active));
    let ready!: () => void;
    Object.defineProperty(lane.ix.get(ISessionAgentProfileCatalog), 'ready', {
      value: new Promise<void>((resolve) => { ready = resolve; }), configurable: true,
    });
    const launch = dispatch.launch({
      delegator: { kind: 'agent', agentId: 'main' }, requesterAgentId: 'main',
      profileName: 'coder', message: 'research only', parentTurnId: 1,
      runtime: new FakeRuntime({ workspaceId: 'workspace_test', runtimeId: 'local', generation: 'test' }),
      workDir: '/work', signal: new AbortController().signal,
    });
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    active = false;
    ready();
    const run = await launch;
    expect(lane.lifecycleCreate.mock.calls[0]![0]!.binding?.executionRestriction).toBe('research-readonly');
    expect(run.child.agent.accessor.get(IAgentProfileService).data().executionRestriction).toBe('research-readonly');
    await complete(lane, 0);
  });

  it('rejects a research dispatch to an external executor before child creation or running', async () => {
    const lane = createLane(disposables, 'internal', {
      profile: { ...parityProfile, executor: 'external' },
    });
    disposables.add(lane.ix.get(ISessionDispatchService).registerPlanStateReader('main', () => true));
    const result = await lane.runInternal({ profile: 'coder', prompt: 'research', description: 'Inspect code', background: true });
    expect(result.isError).toBe(true);
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    expect(lane.subagentRun).not.toHaveBeenCalled();
  });

  it.each(['native', 'external'] as const)('captures the real AgentRun request before catalog await for %s', async (executor) => {
    const prefix = vi.fn(async () => 'unsafe prefix');
    const lane = createLane(disposables, 'internal', { profile: { ...parityProfile, executor, promptPrefix: prefix } });
    const dispatch = lane.ix.get(ISessionDispatchService);
    let active = true;
    disposables.add(dispatch.registerPlanStateReader('main', () => active));
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => { ready = resolve; });
    const reachedCatalog = vi.fn(() => pending);
    Object.defineProperty(lane.ix.get(ISessionAgentProfileCatalog), 'ready', { get: reachedCatalog, configurable: true });
    const resultPromise = lane.runInternal({ profile: 'coder', prompt: 'research', description: 'Read source', background: true });
    expect(reachedCatalog).toHaveBeenCalled();
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    active = false;
    ready();
    const result = await resultPromise;
    expect(prefix).not.toHaveBeenCalled();
    expect(lane.probe.userToolInheritance).toEqual([]);
    if (executor === 'external') {
      expect(result.isError).toBe(true);
      expect(lane.lifecycleCreate).not.toHaveBeenCalled();
      expect(lane.subagentRun).not.toHaveBeenCalled();
    } else {
      expect(result.isError).not.toBe(true);
      expect(lane.lifecycleCreate.mock.calls[0]![0]!.binding?.executionRestriction).toBe('research-readonly');
      await complete(lane, 0);
    }
  });

  it.each(['active', 'idle', 'released', 'cold'] as const)('rejects real AgentRun resume of an old %s writable child without resolving or running it', async (state) => {
    const lane = createLane(disposables, 'internal');
    await lane.runInternal({ profile: 'coder', prompt: 'old work', description: 'Old work', background: true, name: 'old_child' });
    if (state !== 'active') await complete(lane, 0);
    if (state === 'released' || state === 'cold') lane.dropHandle('agent_child_1');
    const dispatch = lane.ix.get(ISessionDispatchService);
    disposables.add(dispatch.registerPlanStateReader('main', () => true));
    const resolve = vi.spyOn(dispatch, 'resolveOwnedChild');
    lane.lifecycleCreate.mockClear();
    lane.subagentRun.mockClear();
    const result = await lane.runInternal({ resume: ' old_child ', prompt: 'continue writing', description: 'Resume work', background: true });
    expect(result.isError).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    expect(lane.subagentRun).not.toHaveBeenCalled();
    if (state === 'active') await complete(lane, 0);
  });

  it('projects launch eligibility without dispatch effects and shares the exact runtime predicate', () => {
    const lane = createLane(disposables, 'internal');
    const dispatch = lane.ix.get(ISessionDispatchService);
    let active = true;
    disposables.add(dispatch.registerPlanStateReader('main', () => active));
    const captured = dispatch.readLaunchPolicy('main');
    expect(Object.isFrozen(captured)).toBe(true);
    expect(evaluateDispatchAdmission(captured, 'spawn', 'native')).toEqual({
      allowed: true, executionRestriction: 'research-readonly', reason: undefined, reasonCode: undefined,
    });
    expect(evaluateDispatchAdmission(captured, 'spawn', 'external')).toMatchObject({
      allowed: false, reasonCode: 'native_executor_required',
    });
    expect(evaluateDispatchAdmission(captured, 'resume')).toMatchObject({
      allowed: false, reasonCode: 'plan_resume_forbidden',
    });
    expect(evaluateDispatchAdmission({ planActive: false, callerRestriction: 'research-readonly' }, 'spawn')).toMatchObject({
      allowed: false, reasonCode: 'research_readonly_dispatch_forbidden',
    });
    expect(lane.lifecycleCreate).not.toHaveBeenCalled();
    expect(lane.subagentRun).not.toHaveBeenCalled();
    active = false;
    expect(evaluateDispatchAdmission(dispatch.readLaunchPolicy('main'), 'spawn', 'external').allowed).toBe(true);
    expect(evaluateDispatchAdmission(tightenDispatchLaunchPolicy(dispatch.readLaunchPolicy('main'), captured), 'spawn', 'external').allowed).toBe(false);
  });

  it('keeps every probe normalization difference explicit', () => {
    expect(PROBE_DIFFERENCE_WHITELIST).toEqual({
      workIdField: ['task_id', 'dispatch_id'],
      delegatorKind: ['agent', 'external'],
      labelFields: {
        internalOnly: [
          'parentAgentId',
          'requestIdentityParentTurn',
          'requestIdentityRootAgent',
          'requestIdentityRootTurn',
        ],
        externalOnly: [],
      },
      acceptedStatus: ['running', 'queued'],
      continuationField: ['resume_hint', 'continue_hint'],
    });
  });

  it('P1 launches the same native profile binding, permission mode, name, labels, and run', async () => {
    const internal = createLane(disposables, 'internal');
    const external = createLane(disposables, 'external');

    await spawnPair(internal, external);

    expect(internal.probe.profileBinds).toEqual([[
      'profile-bind',
      ['profile', 'coder'],
      profileSnapshot(parityProfile),
      ['route', undefined],
      undefined,
      ['model', 'parity-model'],
      ['thinking', 'high'],
      ['lease', stableValue(parityLease)],
      ['spawn-policy', stableValue(paritySpawnPolicy)],
      ['executor', 'native', 'native', undefined, 'native'],
      ['inherited-user-tools', ['SharedTool']],
    ]]);
    expect(external.probe.profileBinds).toEqual(internal.probe.profileBinds);
    expect(external.probe.permissions).toEqual(internal.probe.permissions);
    expect(external.probe.names).toEqual(internal.probe.names);
    expect(external.probe.labels).toEqual(internal.probe.labels);
    expect(labelDifferenceKeys(
      internal.probe.rawLabels[0]!,
      external.probe.rawLabels[0]!,
    )).toEqual(PROBE_DIFFERENCE_WHITELIST.labelFields);
    expect(external.probe.userToolInheritance).toEqual(internal.probe.userToolInheritance);
    expect(internal.probe.userToolInheritance).toEqual([
      ['inherited-user-tools', ['SharedTool']],
    ]);
    expect(external.probe.runs).toEqual(internal.probe.runs);
    expect(external.probe.lifecycle).toEqual(internal.probe.lifecycle);
    expect(external.probe.agentIds).toEqual(internal.probe.agentIds);
  });

  it('P2 preserves receipt identity parity while AgentRun omits repeated tutorials', async () => {
    const internal = createLane(disposables, 'internal');
    const external = createLane(disposables, 'external');

    const { internalResult, externalView } = await spawnPair(internal, external);
    const internalReceipt = internal.probe.internalReceipt(outputText(internalResult.output));
    const externalReceipt = external.probe.externalReceipt(externalView);
    expect(externalReceipt.slice(0, 5)).toEqual(internalReceipt.slice(0, 5));
    expect(internalReceipt.slice(5)).toEqual([false, false]);
    expect(externalReceipt.slice(5)).toEqual([true, true]);
    expect(fieldMap(outputText(internalResult.output))['automatic_notification']).toBe('true');
  });

  it('P3 replays a dispatch key without starting a second run', async () => {
    const external = createLane(disposables, 'external');
    const request = {
      authority,
      target: 'named' as const,
      taskName: 'idempotent_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      thinkingEffort: 'high',
      message: 'inspect parity',
      dispatchKey: 'dispatch-key-1',
    };

    const first = await external.externalM1.dispatch(request);
    await completeExternal(external, first.dispatchId, 0);
    const replay = await external.externalM1.dispatch(request);

    expect(replay).toMatchObject({ dispatchId: first.dispatchId, status: 'completed' });
    expect(external.subagentRun).toHaveBeenCalledTimes(1);
    expect((await external.external.list(authority)).continuations).toHaveLength(1);
  });

  it('P4 mirrors timeout, terminal, and wait-any TaskWait semantics', async () => {
    const external = createLane(disposables, 'external');
    const first = await external.externalM1.dispatch({
      authority,
      target: 'named',
      taskName: 'wait_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'wait',
    });

    const timedOut = await external.externalM1.wait({
      authority,
      dispatchId: first.dispatchId,
      timeoutMs: 0,
    });
    expect(timedOut).toMatchObject({
      waitStatus: 'timed_out',
      dispatch: { dispatchId: first.dispatchId, status: expect.stringMatching(/queued|running/) },
    });

    await completeExternal(external, first.dispatchId, 0);
    const terminal = await external.externalM1.wait({
      authority,
      dispatchId: first.dispatchId,
      timeoutMs: 60_000,
    });
    expect(terminal).toMatchObject({
      waitStatus: 'completed',
      dispatch: { dispatchId: first.dispatchId, status: 'completed' },
    });

    const second = await external.externalM1.dispatch({
      authority,
      target: 'named',
      taskName: 'wait_any_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'wait any',
    });
    const waitAny = external.externalM1.wait({ authority, timeoutMs: 60_000 });
    await completeExternal(external, second.dispatchId, 1);
    await expect(waitAny).resolves.toMatchObject({
      waitStatus: 'completed',
      dispatch: { dispatchId: second.dispatchId },
      completedDuringWait: expect.any(Array),
    });
  });

  it('P5 reuses one child and preserves its profile binding across all continuation forms', async () => {
    const internal = createLane(disposables, 'internal');
    const external = createLane(disposables, 'external');
    const first = await spawnPair(internal, external);
    await complete(internal, 0);
    await completeExternal(external, first.externalView.dispatchId, 0);

    const resumedInternal = await internal.runInternal({
      prompt: 'continue parity',
      description: 'Continue parity',
      resume: 'parity_child',
      background: true,
    });
    const resumedExternal = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'parity_child',
      message: 'continue parity',
    });
    const continuedExternal = external.external.continue({
      authority,
      dispatchId: first.externalView.dispatchId,
      message: 'continue by dispatch',
    });

    expect(resumedInternal.isError).not.toBe(true);
    expect(resumedExternal.taskName).toBe('parity_child');
    expect(internal.lifecycleCreate).toHaveBeenCalledTimes(1);
    expect(external.lifecycleCreate).toHaveBeenCalledTimes(1);
    expect(internal.subagentRun).toHaveBeenCalledTimes(2);
    expect(external.subagentRun).toHaveBeenCalledTimes(2);
    expect(internal.probe.profileBinds).toEqual(external.probe.profileBinds);
    await expect(continuedExternal).rejects.toThrow(/active dispatch/);

    await expect(internal.runInternal({
      prompt: 'switch profile',
      description: 'Switch profile',
      resume: 'parity_child',
      profile: 'coder',
      background: true,
    })).rejects.toThrow('Cannot set profile, profile_file, or route');
    await expect(external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'parity_child',
      profileName: 'other',
      message: 'switch profile',
    })).rejects.toThrow(/cannot change profile/);
  });

  it('rebuilds a cold named child with its context and the caller current mode', async () => {
    const internal = createLane(disposables, 'internal', { capacity: { maxDirectChildren: 1, maxTotalSubagents: 1 } });
    const first = await internal.runInternal({
      prompt: 'remember restart context',
      description: 'Persist child',
      profile: 'coder',
      name: 'restart_child',
      model_alias: 'parity-model',
      background: true,
    });
    await complete(internal, 0);
    internal.setPermissionMode('main', 'yolo');
    internal.dropHandle('agent_child_1');

    const resumed = await internal.runInternal({
      prompt: 'continue after restart',
      description: 'Resume child',
      resume: 'restart_child',
      background: true,
    });

    expect(first.isError).not.toBe(true);
    expect(resumed.isError).not.toBe(true);
    expect(fieldMap(outputText(resumed.output))).toMatchObject({
      agent_id: 'agent_child_1',
      actual_profile: 'coder',
    });
    expect(internal.permissionMode('agent_child_1')).toBe('yolo');
    expect(internal.context('agent_child_1')).toEqual([
      'remember restart context',
      'continue after restart',
    ]);
    expect(internal.lifecycleCreate).toHaveBeenCalledTimes(2);
    expect(internal.lifecycleCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'agent_child_1' }),
    );
    expect(internal.probe.agentIds).toEqual(['agent_child_1']);
    expect([...internal.handles.keys()].toSorted()).toEqual(['agent_child_1', 'main']);
    expect(internal.metadataAgents['agent_child_1']?.labels).toMatchObject({
      collaborationTaskName: 'restart_child',
      profileName: 'coder',
    });
    const denied = await internal.runInternal({ profile: 'coder', prompt: 'over limit', description: 'No spare slot', background: true });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(outputText(denied.output))).toMatchObject({ code: 'dispatch.limit_exceeded', details: { layer: 'direct', current: 1, limit: 1 } });
    expect(internal.lifecycleCreate).toHaveBeenCalledTimes(2);
    await complete(internal, 1);
    const next = await internal.runInternal({ resume: 'restart_child', prompt: 'next run', description: 'Reuse slot', background: true });
    expect(next.isError).not.toBe(true);
    expect(internal.lifecycleCreate).toHaveBeenCalledTimes(2);
    await complete(internal, 2);
  });

  it('reapplies the external seat ceiling when a named child is rebuilt cold', async () => {
    const externalProfile = normalizeAgentProfile({
      ...parityProfile,
      executor: 'grok-acp',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
      allowedModels: ['grok-4.6'],
      allowedEfforts: ['xhigh'],
    });
    const external = createLane(disposables, 'external', {
      profile: externalProfile,
      externalPermissionCeiling: 'auto',
    });
    external.setPermissionMode('main', 'yolo');
    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'bounded_external',
      profileName: 'coder',
      message: 'first external run',
    });
    await completeExternal(external, first.dispatchId, 0);
    external.setPermissionMode('agent_child_1', 'yolo');
    external.dropHandle('agent_child_1');

    const resumed = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'bounded_external',
      message: 'resume external run',
    });

    expect(resumed).toMatchObject({
      agentId: 'agent_child_1',
      profileName: 'coder',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
    });
    expect(external.permissionMode('agent_child_1')).toBe('auto');
    expect(external.lifecycleCreate).toHaveBeenCalledTimes(2);
    expect(external.probe.agentIds).toEqual(['agent_child_1']);
    await completeExternal(external, resumed.dispatchId, 1);
  });

  it('keeps transcript and events readable while a named dispatch is running', async () => {
    const external = createLane(disposables, 'external');
    const view = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'running_reader',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'keep running',
    });
    external.setExecutionRunning('agent_child_1', true);
    await vi.waitFor(async () => {
      expect((await external.external.status({ authority, dispatchId: view.dispatchId })).status)
        .toBe('running');
    });

    await expect(external.external.transcript({
      authority,
      dispatchId: view.dispatchId,
    })).resolves.toEqual({ items: [], nextCursor: undefined });
    await expect(external.external.events({
      authority,
      dispatchId: view.dispatchId,
    })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ dispatchId: view.dispatchId, type: 'queued' }),
      ]),
    });
    expect((await external.external.status({ authority, dispatchId: view.dispatchId })).status)
      .toBe('running');
  });

  it('rejects an external named dispatch while a queued KAP prompt occupies the child', async () => {
    const external = createLane(disposables, 'external');
    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'queued_prompt_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'create child',
    });
    await completeExternal(external, first.dispatchId, 0);
    external.setLoopStatus('agent_child_1', {
      state: 'idle',
      pendingTurnIds: [2],
      hasPendingRequests: true,
    });

    await expect(external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'queued_prompt_child',
      message: 'must reject',
    })).rejects.toThrow(/already running/);
    expect(external.subagentRun).toHaveBeenCalledTimes(1);
  });

  it('P6 injects one idempotent external message at the next run boundary', async () => {
    const external = createLane(disposables, 'external');
    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'mailbox_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'create',
    });
    await completeExternal(external, first.dispatchId, 0);

    const accepted = await external.external.send({
      authority,
      taskName: 'mailbox_child',
      message: 'review the update',
      idempotencyKey: 'message-key-1',
    });
    const replay = await external.external.send({
      authority,
      taskName: 'mailbox_child',
      message: 'review the update',
      idempotencyKey: 'message-key-1',
    });
    await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'mailbox_child',
      message: 'continue',
    });

    expect(replay.message.messageId).toBe(accepted.message.messageId);
    expect(replay.deduplicated).toBe(true);
    expect(external.probe.mailbox).toEqual([
      [
        'inject',
        'before-next-run',
        expect.stringMatching(/^external:/),
        'external',
        'mailbox_child',
        'review the update',
      ],
    ]);
  });

  it('P7 exposes completion usage on terminal status and result views', async () => {
    const internal = createLane(disposables, 'internal');
    const external = createLane(disposables, 'external');
    const pair = await spawnPair(internal, external);
    await complete(internal, 0);
    await completeExternal(external, pair.externalView.dispatchId, 0);

    const status = await external.externalM1.status({
      authority,
      dispatchId: pair.externalView.dispatchId,
    });
    const result = await external.externalM1.result({
      authority,
      dispatchId: pair.externalView.dispatchId,
    });

    expect(external.probe.lifecycle).toEqual(internal.probe.lifecycle);
    expect(external.probe.terminals).toEqual(internal.probe.terminals);
    expect(externalWireUsage(status.usage)).toEqual(internal.probe.engineUsage[0]);
    expect(externalWireUsage(result.dispatch.usage)).toEqual(internal.probe.engineUsage[0]);
    expect(result.text).toBe(internal.probe.terminals[0]?.[1]);
  });

  it('C-2 converts a foreground timeout detach into the background receipt path', async () => {
    const internal = createLane(disposables, 'internal');
    internal.taskRelease = 'timeout_detached';

    const result = await internal.runInternal({
      prompt: 'inspect detach',
      description: 'Inspect detach',
      profile: 'coder',
      name: 'detach_child',
      model_alias: 'parity-model',
    });

    expect(result.isError).not.toBe(true);
    expect(fieldMap(outputText(result.output))).toMatchObject({
      status: 'running',
      agent_id: 'agent_child_1',
      actual_profile: 'coder',
    });
  });

  it('C-3 preserves the foreground AgentRun text receipt contract', async () => {
    const internal = createLane(disposables, 'internal');
    const pending = internal.runInternal({
      prompt: 'inspect receipt',
      description: 'Inspect receipt',
      profile: 'coder',
      name: 'receipt_child',
      model_alias: 'parity-model',
    });
    await complete(internal, 0, 'text result');
    const result = await pending;

    expect(outputText(result.output)).toBe([
      'agent_id: agent_child_1',
      'actual_profile: coder',
      'dispatch_policy: advisory',
      'selection_kind: profile',
      'selection_origin: explicit',
      'recommendation_status: preferred',
      'parent_notify: enabled',
      'status: completed',
      '',
      '[summary]',
      'text result',
    ].join('\n'));
  });

  it('P10 writes collaborationLatestTaskId for AgentRun', async () => {
    const internal = createLane(disposables, 'internal');

    await internal.runInternal({
      prompt: 'inspect status',
      description: 'Inspect status',
      profile: 'coder',
      name: 'status_child',
      background: true,
      model_alias: 'parity-model',
    });

    expect(
      internal.metadataAgents['agent_child_1']?.labels?.[COLLABORATION_LATEST_TASK_LABEL],
    ).toBe('task_1');
  });

  it('P10 projects external child status, latest dispatch, and usage from the ledger', async () => {
    const external = createLane(disposables, 'external');
    const view = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'status_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'inspect status',
    });
    await completeExternal(external, view.dispatchId, 0);
    const externalList = await external.external.list(authority);
    const externalChild = externalList.children.find((child) => child.taskName === 'status_child');

    expect(externalChild).toMatchObject({
      latestDispatchId: view.dispatchId,
      status: 'completed',
      usage: {
        input: 19,
        output: 7,
        cacheRead: 5,
        cacheWrite: 3,
      },
    });
    expect(
      external.metadataAgents['agent_child_1']?.labels?.[COLLABORATION_LATEST_TASK_LABEL],
    ).toBe(view.dispatchId);
  });

  it('P11 allows non-native executors while keeping unbound models fail-closed', async () => {
    const nonNative = createLane(disposables, 'external', {
      profile: normalizeAgentProfile({
        ...parityProfile,
        executor: 'fake-executor',
      }),
    });
    const view = await nonNative.external.dispatch({
      authority,
      target: 'named',
      taskName: 'non_native',
      profileName: 'coder',
      message: 'dispatch',
    });
    expect(view.status).toBe('queued');
    expect(nonNative.metadataAgents['agent_child_1']?.executor).toBe('fake-executor');
    await completeExternal(nonNative, view.dispatchId, 0);

    const unbound = createLane(disposables, 'external', {
      profile: normalizeAgentProfile({
        ...parityProfile,
        modelAlias: undefined,
      }),
      mainModel: 'main-model',
    });
    await expect(unbound.external.dispatch({
      authority,
      target: 'named',
      taskName: 'unbound',
      profileName: 'coder',
      message: 'reject',
    })).rejects.toThrow(/No model is bound/);
  });

  it('preserves external bindings across AgentRun, delegation dispatch, and named reuse', async () => {
    const externalProfile = normalizeAgentProfile({
      ...parityProfile,
      executor: 'grok-acp',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
      allowedModels: ['grok-4.6'],
      allowedEfforts: ['xhigh'],
    });
    const options: LaneOptions = {
      profile: externalProfile,
      resolveModelAlias: (id) => id === 'grok-4.6' ? 'axon-message/grok-4.6' : id,
      modelCatalogGet: (id) => {
        throw new Error(`native model catalog must not resolve ${id}`);
      },
    };
    const internal = createLane(disposables, 'internal', options);
    const external = createLane(disposables, 'external', options);

    const internalResult = await internal.runInternal({
      prompt: 'agent run',
      description: 'External AgentRun',
      profile: 'coder',
      name: 'external_agent_run',
      background: true,
    });
    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'external_named',
      profileName: 'coder',
      message: 'delegation run',
    });
    await completeExternal(external, first.dispatchId, 0);
    const resumed = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'external_named',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
      message: 'reuse',
    });

    expect(internalResult.isError).not.toBe(true);
    expect(internal.metadataAgents['agent_child_1']).toMatchObject({
      model: 'grok-4.6',
      thinkingEffort: 'xhigh',
      executor: 'grok-acp',
    });
    expect(external.metadataAgents['agent_child_1']).toMatchObject({
      model: 'grok-4.6',
      thinkingEffort: 'xhigh',
      executor: 'grok-acp',
    });
    expect(resumed).toMatchObject({
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
    });
    expect(external.lifecycleCreate).toHaveBeenCalledTimes(1);
    expect(external.subagentRun).toHaveBeenCalledTimes(2);
  });

  it('normalizes named binding comparisons across warm and cold reuse', async () => {
    const externalProfile = normalizeAgentProfile({
      ...parityProfile,
      executor: 'grok-acp',
      modelAlias: 'vendor-short',
      thinkingEffort: 'xhigh',
      allowedModels: ['vendor-short', 'vendor/model'],
      allowedEfforts: ['xhigh'],
    });
    const external = createLane(disposables, 'external', {
      profile: externalProfile,
      validateBinding: (binding) => ({
        ok: true,
        binding: {
          modelAlias:
            binding.modelAlias === 'vendor-short' ? 'vendor/model' : binding.modelAlias,
          thinkingEffort: binding.thinkingEffort,
        },
      }),
    });

    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'normalized_named',
      profileName: 'coder',
      message: 'first',
    });
    await completeExternal(external, first.dispatchId, 0);
    const warm = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'normalized_named',
      modelAlias: 'vendor-short',
      thinkingEffort: 'xhigh',
      message: 'warm',
    });
    await completeExternal(external, warm.dispatchId, 1);
    external.dropHandle('agent_child_1');
    const cold = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'normalized_named',
      modelAlias: 'vendor-short',
      thinkingEffort: 'xhigh',
      message: 'cold',
    });

    expect(external.metadataAgents['agent_child_1']).toMatchObject({
      model: 'vendor/model',
      thinkingEffort: 'xhigh',
    });
    expect(warm).toMatchObject({ modelAlias: 'vendor/model', thinkingEffort: 'xhigh' });
    expect(cold).toMatchObject({ modelAlias: 'vendor/model', thinkingEffort: 'xhigh' });
    expect(external.lifecycleCreate).toHaveBeenCalledTimes(2);
    expect(external.subagentRun).toHaveBeenCalledTimes(3);
  });

  it('P11 reports the available profile catalog when a profile is unknown', async () => {
    const external = createLane(disposables, 'external');

    await expect(external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'unknown_profile',
      profileName: 'missing',
      message: 'reject',
    })).rejects.toThrow(/Available agent profiles: coder/);
  });

  it('P12 rejects non-owned internal resume targets and foreign root authority', async () => {
    const internal = createLane(disposables, 'internal');
    internal.metadataAgents['foreign_child'] = {
      type: 'sub',
      parentAgentId: 'other_parent',
      delegator: { kind: 'agent', agentId: 'other_parent' },
      labels: {
        parentAgentId: 'other_parent',
        [COLLABORATION_TASK_NAME_LABEL]: 'foreign_child',
        [COLLABORATION_AGENT_TYPE_LABEL]: 'coder',
      },
    };
    internal.handles.set('foreign_child', internal.handles.get('main')!);

    const result = await internal.runInternal({
      prompt: 'continue',
      description: 'Continue foreign',
      resume: 'foreign_child',
      background: true,
    });
    expect(result.isError).toBe(true);
    expect(outputText(result.output)).toContain('does not belong to this delegator');

    const external = createLane(disposables, 'external');
    await external.external.list(authority);
    await expect(external.external.list({
      ...authority,
      principalFingerprint: 'd'.repeat(64),
    })).rejects.toThrow(/does not own this session root/);
  });

  it('P12 rejects a persisted child owned by another external root', async () => {
    const external = createLane(disposables, 'external');
    const first = await external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'owned_child',
      profileName: 'coder',
      modelAlias: 'parity-model',
      message: 'create',
    });
    await completeExternal(external, first.dispatchId, 0);
    external.dropHandle('agent_child_1');
    external.metadataAgents['agent_child_1'] = {
      ...external.metadataAgents['agent_child_1'],
      delegator: { kind: 'external', delegationId: 'delegation_foreign' },
    };

    await expect(external.external.dispatch({
      authority,
      target: 'named',
      taskName: 'owned_child',
      message: 'continue',
    })).rejects.toThrow();
  });
});
