import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { IAgentCollaborationMessagingService, IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import type { AgentMessageAcceptance, QueuedAgentMessage } from '#/session/agentCollaboration/messageMailbox';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWireService } from '#/wire/wire';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { appService, createTestAgent, sessionService } from '../../harness';

const signal = new AbortController().signal;

describe('mailbox receipt recovery with real lifecycle', () => {
  it.each(['normal', 'ack-failure', 'compaction', 'cold-compaction'] as const)('restores a completed released sender and allows the receiver next step after %s', async (mode) => {
    const host = createTestAgent(
      appService(IRuntimeResolver, {
        _serviceBrand: undefined,
        inspect: (binding) => new FakeRuntime({ ...binding, generation: 'test' }),
        acquire: (binding) => ({ runtime: new FakeRuntime({ ...binding, generation: 'test' }), track: (resource) => resource, dispose: () => {} }),
      }),
      sessionService(ISessionStateService, new SyncDescriptor(SessionStateService)),
      sessionService(ISessionMetadata, new SyncDescriptor(SessionMetadata)),
      sessionService(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService)),
      sessionService(IAgentCollaborationMessageStore, singleMessageStore()),
      sessionService(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService)),
    );
    try {
      await host.ready;
      const lifecycle = host.get(IAgentLifecycleService);
      const messaging = host.get(IAgentCollaborationMessagingService);
      const binding = host.get(IAgentProfileService).data();
      const sender = await lifecycle.create({ agentId: 'sender', binding: { profile: 'explore', model: binding.modelAlias }, delegator: { kind: 'agent', agentId: 'main' } });
      host.mockNextResponse({ type: 'text', text: 'Sender finished' });
      const senderRun = await sender.accessor.get(IAgentPromptService).enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'Finish work' }], toolCalls: [], origin: { kind: 'user' } } });
      await expect(senderRun.completion).resolves.toMatchObject({ state: 'completed', result: { type: 'completed' } });
      await sender.accessor.get(IWireService).flush();
      await host.get(ISessionMetadata).updateAgent('sender', (meta) => ({ ...meta, status: 'completed', resultSummary: 'Finished work', completedAt: 1 }));
      await lifecycle.remove('sender');
      expect(lifecycle.get('sender')).toBeUndefined();
      let receiver = await lifecycle.create({ agentId: 'receiver', binding: { profile: 'explore', model: binding.modelAlias }, delegator: { kind: 'agent', agentId: 'main' } });
      const compacting = mode === 'compaction' || mode === 'cold-compaction';
      if (compacting) vi.spyOn(lifecycle, 'create').mockRejectedValueOnce(new Error('sender restore failed')).mockRejectedValueOnce(new Error('sender restore failed'));
      const accepted = await messaging.send({ sourceAgentId: 'sender', sourceTaskName: 'source', targetAgentId: 'receiver', targetTaskName: 'target', content: 'Result ready', idempotencyKey: 'cold-receipt', waitForRunningDelivery: true });
      const next = vi.fn(async () => {});
      if (mode === 'ack-failure') {
        vi.spyOn(host.get(IAgentCollaborationMessageStore), 'markDelivered').mockRejectedValueOnce(new Error('ack failed'));
        await expect(receiver.accessor.get(IAgentExecutionService).hooks.onWillRun.run({ signal }, next)).rejects.toThrow('ack failed');
        expect(next).not.toHaveBeenCalled();
        await lifecycle.remove('sender');
      } else {
        await receiver.accessor.get(IAgentExecutionService).hooks.onWillRun.run({ signal }, next);
        expect(next).toHaveBeenCalledOnce();
      }
      if (!compacting) {
        await receiver.accessor.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: false, signal }, next);
        expect(next).toHaveBeenCalledTimes(mode === 'ack-failure' ? 1 : 2);
      }
      host.mockNextResponse({ type: 'text', text: 'Receiver continued' });
      const receiverRun = await receiver.accessor.get(IAgentPromptService).enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'Continue normally' }], toolCalls: [], origin: { kind: 'user' } } });
      await expect(receiverRun.completion).resolves.toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(host.llmCalls).toHaveLength(2);
      if (compacting) {
        expect(lifecycle.get('sender')).toBeUndefined();
        await receiver.accessor.get(IEventDispatcher).dispatch(new ContextApplyCompaction({ summary: 'Conversation summarized', compactedCount: receiver.accessor.get(IAgentContextMemoryService).get().length }));
        await receiver.accessor.get(IWireService).flush();
        expect(receiver.accessor.get(IAgentContextMemoryService).get().some((message) => message.id === accepted.message.messageId)).toBe(false);
        if (mode === 'cold-compaction') {
          await lifecycle.remove('receiver');
          receiver = await lifecycle.create({ agentId: 'receiver', delegator: { kind: 'agent', agentId: 'main' } });
        }
        await receiver.accessor.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 2, step: 1, firstStepOfTurn: false, signal }, next);
      }
      const recipientRecords = [];
      for await (const record of receiver.accessor.get(IWireService).readJournal()) recipientRecords.push(record);
      expect(recipientRecords.filter((record) => record.type === 'context.append_message' && (record['message'] as { id?: string }).id === accepted.message.messageId)).toHaveLength(1);
      const restored = lifecycle.get('sender')!;
      expect(restored.accessor.get(IAgentExecutionService).status().state).toBe('idle');
      expect(restored.accessor.get(IAgentProfileService).data().modelAlias).toBe(binding.modelAlias);
      const records = [];
      for await (const record of restored.accessor.get(IWireService).readJournal()) records.push(record);
      expect(records.filter((record) => record.type === 'agent_message.delivered')).toEqual([expect.objectContaining({ messageId: accepted.message.messageId })]);
      expect((await host.get(ISessionMetadata).read()).agents?.['sender']).toMatchObject({ status: 'completed', resultSummary: 'Finished work', completedAt: 1 });
    } finally {
      await host.dispose();
    }
  });
});

function singleMessageStore(): IAgentCollaborationMessageStore {
  let acceptance: AgentMessageAcceptance | undefined;
  let queued: QueuedAgentMessage | undefined;
  return {
    _serviceBrand: undefined,
    accept: async (input) => {
      if (acceptance !== undefined) return { ...acceptance, deduplicated: true };
      const message = { ...input, messageId: 'message-1', acceptedAt: 1, targetSeq: 1 };
      acceptance = { message, deduplicated: false, delivery: 'queued', payloadConflict: false };
      const target = { hostId: 'test', workspaceId: input.sessionId, sessionId: input.targetAgentId };
      queued = { message, claim: { message: { messageId: message.messageId, producer: { kind: 'peer_thread', source: { ...target, sessionId: input.sourceAgentId } }, target, content: input.content, idempotencyKey: input.idempotencyKey, acceptedAt: 1, targetSeq: 1 }, consumerId: 'test', fence: 1, leaseUntil: Number.MAX_SAFE_INTEGER, hostEpoch: 1 } };
      return acceptance;
    },
    nextQueued: async () => queued,
    markDelivered: async () => {
      if (queued === undefined) return false;
      queued = undefined;
      acceptance = { ...acceptance!, delivery: 'delivered' };
      return true;
    },
    listPendingAgents: async () => [],
    discardPending: async () => ({ discarded: 0 }),
  };
}
