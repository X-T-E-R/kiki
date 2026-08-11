import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event, Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { createHooks } from '#/hooks';
import { IAgentContextMemoryService, type IAgentContextMemoryService as AgentContextMemory } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type IAgentLoopService as AgentLoop } from '#/agent/loop/loop';
import { IAgentLifecycleService, type IAgentLifecycleService as AgentLifecycle } from '#/session/agentLifecycle/agentLifecycle';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  type IAgentCollaborationMessageStore,
} from '#/session/agentCollaboration/messageMailbox';
import { MiniDbAgentCollaborationMessageBackend } from '#/session/agentCollaboration/miniDbMessageStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService, type IWireService as Wire } from '#/wire/wire';

const signal = new AbortController().signal;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MiniDb agent collaboration message store', () => {
  it('keeps FIFO, idempotency, payload conflicts, and consumption across reopen', async () => {
    const dir = tempDir();
    const first = new MiniDbAgentCollaborationMessageBackend(dir);
    const one = await first.accept(messageInput('one', 'idem-one'));
    const two = await first.accept(messageInput('two', 'idem-two'));

    expect([one.message.targetSeq, two.message.targetSeq]).toEqual([1, 2]);
    expect(await first.accept(messageInput('one', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      delivery: 'queued',
      payloadConflict: false,
    });
    expect(await first.accept(messageInput('changed', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      payloadConflict: true,
    });
    expect((await first.nextQueued('session-1', 'agent-target'))?.messageId).toBe(one.message.messageId);
    expect(await first.markDelivered(one.message.messageId)).toBe(true);

    const reopened = new MiniDbAgentCollaborationMessageBackend(dir);
    expect((await reopened.nextQueued('session-1', 'agent-target'))?.messageId).toBe(two.message.messageId);
    expect(await reopened.markDelivered(two.message.messageId)).toBe(true);
    expect(await reopened.nextQueued('session-1', 'agent-target')).toBeUndefined();
    expect(await reopened.accept(messageInput('one', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      delivery: 'delivered',
    });
  });

  it('rejects acceptance beyond the per-target queued backlog limit', async () => {
    const store = new MiniDbAgentCollaborationMessageBackend(tempDir());
    for (let index = 0; index < AGENT_MESSAGE_BACKLOG_LIMIT; index++) {
      await store.accept(messageInput(`message-${index}`, `idem-${index}`));
    }
    await expect(store.accept(messageInput('overflow', 'overflow'))).rejects.toThrow(
      `backlog is full (${AGENT_MESSAGE_BACKLOG_LIMIT} queued messages)`,
    );
  }, 15_000);
});

describe('agent collaboration safe-boundary delivery', () => {
  it('does not wake an idle target and delivers FIFO only at its next step boundary', async () => {
    const store = new MiniDbAgentCollaborationMessageBackend(tempDir());
    const lifecycle = lifecycleHarness([]);
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext());
    const target = agentHandle('agent-target');

    await service.send(sendInput('first', 'call-1'));
    await service.send(sendInput('second', 'call-2'));
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    expect(target.messages).toEqual([]);

    lifecycle.add(target.handle);
    expect(target.messages).toEqual([]);
    await target.loop.hooks.onWillBeginStep.run({ turnId: 7, step: 1, signal });

    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from named agent "root" (main):\n\nfirst' },
      { type: 'text', text: 'Message from named agent "root" (main):\n\nsecond' },
    ]);
    expect(target.messages.map((message) => message.origin)).toEqual([
      expect.objectContaining({ kind: 'agent_message', senderAgentId: 'main', senderTaskName: 'root' }),
      expect.objectContaining({ kind: 'agent_message', senderAgentId: 'main', senderTaskName: 'root' }),
    ]);
    expect(target.operations).toEqual(['append', 'flush', 'append', 'flush']);
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it('replays an unacknowledged durable receipt without double-applying its origin', async () => {
    const backend = new MiniDbAgentCollaborationMessageBackend(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    let failAcknowledgement = true;
    const faultedStore: IAgentCollaborationMessageStore = {
      _serviceBrand: undefined,
      accept: (input) => backend.accept(input),
      nextQueued: (sessionId, agentId) => backend.nextQueued(sessionId, agentId),
      markDelivered: async (messageId) => {
        if (failAcknowledgement) {
          failAcknowledgement = false;
          throw new Error('simulated crash after wire flush');
        }
        return backend.markDelivered(messageId);
      },
    };
    const first = new AgentCollaborationMessagingService(faultedStore, lifecycle.service, sessionContext());
    const accepted = await first.send(sendInput('once', 'call-once'));
    await expect(target.loop.hooks.onWillBeginStep.run({ turnId: 1, step: 2, signal })).rejects.toThrow(
      'simulated crash after wire flush',
    );
    expect(target.messages).toHaveLength(1);
    first.dispose();

    const reopened = new AgentCollaborationMessagingService(backend, lifecycle.service, sessionContext());
    await target.loop.hooks.onWillBeginStep.run({ turnId: 2, step: 1, signal });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['append', 'flush', 'flush']);
    expect(await backend.accept(messageInput('once', 'call-once'))).toMatchObject({
      message: { messageId: accepted.message.messageId },
      deduplicated: true,
      delivery: 'delivered',
    });
    reopened.dispose();
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-message-mailbox-'));
  tempDirs.push(dir);
  return dir;
}

function messageInput(content: string, idempotencyKey: string) {
  return {
    sessionId: 'session-1',
    sourceAgentId: 'main',
    sourceTaskName: 'root',
    targetAgentId: 'agent-target',
    targetTaskName: 'target',
    content,
    idempotencyKey,
  };
}

function sendInput(content: string, idempotencyKey: string) {
  return {
    sourceAgentId: 'main',
    sourceTaskName: 'root',
    targetAgentId: 'agent-target',
    targetTaskName: 'target',
    content,
    idempotencyKey,
  };
}

function sessionContext(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: 'session-dir',
    metaScope: 'session/scope',
    cwd: 'cwd',
    scope: (subKey) => subKey === undefined ? 'session/scope' : `session/scope/${subKey}`,
  };
}

function lifecycleHarness(initial: readonly IAgentScopeHandle[]) {
  const handles = new Map(initial.map((handle) => [handle.id, handle]));
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const service: AgentLifecycle & { create: ReturnType<typeof vi.fn> } = {
    _serviceBrand: undefined,
    onDidCreate: onDidCreate.event,
    onDidDispose: Event.None as AgentLifecycle['onDidDispose'],
    create: vi.fn(async () => { throw new Error('unexpected wake'); }),
    fork: vi.fn(async () => { throw new Error('unexpected fork'); }),
    get: (agentId) => handles.get(agentId),
    list: () => [...handles.values()],
    broadcastPermissionMode: () => {},
    remove: async () => {},
  };
  return {
    service,
    add(target: IAgentScopeHandle) {
      handles.set(target.id, target);
      onDidCreate.fire(target);
    },
  };
}

function agentHandle(agentId: string) {
  const messages: ContextMessage[] = [];
  const operations: string[] = [];
  const memory: AgentContextMemory = {
    _serviceBrand: undefined,
    get: () => messages,
    append: (...added) => { operations.push('append'); messages.push(...added); },
    appendLoopEvent: () => {},
    clear: () => {},
    undo: () => { throw new Error('unexpected undo'); },
    applyCompaction: () => { throw new Error('unexpected compaction'); },
  };
  const loop = {
    _serviceBrand: undefined,
    hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
  } as unknown as AgentLoop;
  const wire = {
    _serviceBrand: undefined,
    flush: async () => { operations.push('flush'); },
  } as unknown as Wire;
  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get<T>(id: unknown): T {
        if (id === IAgentContextMemoryService) return memory as T;
        if (id === IAgentLoopService) return loop as T;
        if (id === IWireService) return wire as T;
        if (id === IAgentLifecycleService) return undefined as T;
        throw new Error('unexpected agent service');
      },
    },
    dispose: () => {},
  };
  return { handle, loop, messages, operations };
}
