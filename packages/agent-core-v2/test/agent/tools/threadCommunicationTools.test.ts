/**
 * Peer-thread tool schema and activation scenarios.
 */

import { describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import {
  ListThreadsToolInputSchema,
  ReadThreadToolInputSchema,
  SendMessageToThreadToolInputSchema,
  SendMessageToThreadTool,
  WaitThreadsToolInputSchema,
} from '#/agent/tools/thread-communication/threadCommunicationTools';
import type { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import {
  SEND_PEER_THREAD_MESSAGE,
  type IThreadPeerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

describe('thread communication tools', () => {
  it('registers exactly four main-only tools', () => {
    const records = getAgentToolContributions().filter(
      (record) => record.options.domain === 'threadCommunication',
    );
    expect(records.map((record) => record.options.name).toSorted()).toEqual([
      'list_threads',
      'read_thread',
      'send_message_to_thread',
      'wait_threads',
    ]);
    const main = accessorFor('main');
    const subagent = accessorFor('worker-1');
    expect(records.every((record) => record.options.when?.(main) === true)).toBe(true);
    expect(records.every((record) => record.options.when?.(subagent) === false)).toBe(true);
  });

  it('enforces strict bounded input schemas', () => {
    const ref = { host_id: 'host', workspace_id: 'workspace', session_id: 'session' };
    expect(ListThreadsToolInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ReadThreadToolInputSchema.safeParse({ thread: ref, extra: true }).success).toBe(false);
    expect(
      SendMessageToThreadToolInputSchema.safeParse({
        thread: ref,
        content: 'hello',
        idempotency_key: 'key',
      }).success,
    ).toBe(true);
    expect(
      SendMessageToThreadToolInputSchema.safeParse({
        thread: ref,
        content: 'hello',
        idempotency_key: 'key',
        source: ref,
      }).success,
    ).toBe(false);
    expect(
      WaitThreadsToolInputSchema.safeParse({
        threads: Array.from({ length: 9 }, () => ({ thread: ref })),
      }).success,
    ).toBe(false);
  });

  it('derives peer provenance from the ambient session', async () => {
    const sent: unknown[] = [];
    const service = {
      _serviceBrand: undefined,
      hostId: 'local-host',
      isWorkspaceEnabled: async () => true,
      [SEND_PEER_THREAD_MESSAGE]: async (input: unknown) => {
        sent.push(input);
        return {
          messageId: 'message-1',
          targetSeq: 1,
          acceptedAt: 1,
          deduplicated: false,
          delivery: 'pending' as const,
        };
      },
    } as unknown as IThreadCommunicationService & IThreadPeerSendCapability;
    const session = {
      _serviceBrand: undefined,
      sessionId: 'ambient-a',
      workspaceId: 'workspace-a',
    } as ISessionContext;
    const tool = new SendMessageToThreadTool(service, session);
    const execution = tool.resolveExecution({
      thread: {
        host_id: 'local-host',
        workspace_id: 'workspace-b',
        session_id: 'target-b',
      },
      content: 'from ambient',
      idempotency_key: 'ambient-key',
    });

    expect('execute' in execution).toBe(true);
    if (!('execute' in execution)) throw new Error('Expected executable send tool resolution.');
    await execution.execute({} as never);
    expect(sent).toEqual([{
      source: {
        hostId: 'local-host',
        workspaceId: 'workspace-a',
        sessionId: 'ambient-a',
      },
      target: {
        hostId: 'local-host',
        workspaceId: 'workspace-b',
        sessionId: 'target-b',
      },
      content: 'from ambient',
      idempotencyKey: 'ambient-key',
    }]);
  });
});

function accessorFor(agentId: string): ServicesAccessor {
  return {
    get(id) {
      if (id === IAgentScopeContext) {
        return { _serviceBrand: undefined, agentId, scope: () => '' } as never;
      }
      throw new Error(`Unexpected service: ${String(id)}`);
    },
  };
}
