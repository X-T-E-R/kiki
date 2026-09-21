import { Event } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop/loop';
import { LifecycleScope } from '#/app/scopes';
import { createHooks } from '#/hooks';
import type { ThreadDeliveryClaim } from '#/app/threadCommunication/threadMailboxStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AcceptedAgentMessage,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

export interface ExternalMailboxHarness {
  readonly messaging: IAgentCollaborationMessagingService;
  delivered(): boolean;
  dispose(): void;
}

export function attachExternalMailboxHarness(
  executorServices: TestInstantiationService,
  agentId: string,
): ExternalMailboxHarness {
  let message: AcceptedAgentMessage | undefined;
  let delivered = false;
  const claim = {} as ThreadDeliveryClaim;
  const store: IAgentCollaborationMessageStore = {
    _serviceBrand: undefined,
    accept: async (input): Promise<AgentMessageAcceptance> => {
      message ??= {
        messageId: 'external-mailbox-message',
        sessionId: input.sessionId,
        sourceAgentId: input.sourceAgentId,
        sourceTaskName: input.sourceTaskName,
        targetAgentId: input.targetAgentId,
        targetTaskName: input.targetTaskName,
        content: input.content,
        acceptedAt: 1,
        targetSeq: 1,
      };
      return {
        message,
        deduplicated: message.content !== input.content,
        delivery: delivered ? 'delivered' : 'queued',
        payloadConflict: message.content !== input.content,
      };
    },
    nextQueued: async () => delivered || message === undefined ? undefined : { message, claim },
    markDelivered: async () => {
      delivered = true;
      return true;
    },
    listPendingAgents: async () => delivered || message === undefined ? [] : [agentId],
    discardPending: async () => ({ discarded: 0 }),
  };
  const loop = {
    _serviceBrand: undefined,
    status: () => ({
      state: 'idle' as const,
      pendingTurnIds: [],
      hasPendingRequests: false,
    }),
    hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
  } as unknown as IAgentLoopService;
  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get<T>(id: ServiceIdentifier<T>): T {
        if (id === IAgentLoopService) return loop as T;
        return executorServices.get(id);
      },
    },
    dispose: () => {},
  };
  const lifecycle = {
    _serviceBrand: undefined,
    onWillCreate: Event.None,
    onDidCreate: Event.None,
    onDidDispose: Event.None,
    get: (targetId: string) => targetId === agentId ? handle : undefined,
    list: () => [handle],
  } as unknown as IAgentLifecycleService;
  const collaboration = new TestInstantiationService();
  collaboration.set(IAgentCollaborationMessageStore, store);
  collaboration.set(IAgentLifecycleService, lifecycle);
  collaboration.set(ISessionContext, {
    _serviceBrand: undefined,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: 'session-dir',
    metaScope: 'session/scope',
    cwd: 'cwd',
    scope: (subKey?: string) => subKey === undefined ? 'session/scope' : `session/scope/${subKey}`,
  });
  collaboration.set(ISessionMetadata, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    read: async () => ({
      id: 'session-1',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: { [agentId]: {} },
    }),
    createdByLoad: () => true,
  } as unknown as ISessionMetadata);
  collaboration.stub(ISessionDispatchService, {});
  collaboration.set(
    IAgentCollaborationMessagingService,
    new SyncDescriptor(AgentCollaborationMessagingService),
  );
  return {
    messaging: collaboration.get(IAgentCollaborationMessagingService),
    delivered: () => delivered,
    dispose: () => {
      collaboration.dispose();
    },
  };
}
