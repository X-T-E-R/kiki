import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IThreadCreateTool, ThreadCreateTool, ThreadCreateToolInputSchema } from '#/agent/tools/thread-communication/threadCreateTool';
import {
  ListThreadsToolInputSchema,
  ReadThreadToolInputSchema,
  SendMessageToThreadToolInputSchema,
  SendMessageToThreadTool,
  WaitThreadsToolInputSchema,
} from '#/agent/tools/thread-communication/threadCommunicationTools';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import {
  SEND_PEER_THREAD_MESSAGE,
  type IThreadPeerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { createTestAgent } from '../../harness/agent';

describe('thread communication tools', () => {
  it('registers exactly five main-only tools', () => {
    const records = getAgentToolContributions().filter(
      (record) => record.options.domain === 'threadCommunication',
    );
    expect(records.map((record) => record.options.name).toSorted()).toEqual([
      'ThreadCreate',
      'ThreadList',
      'ThreadRead',
      'ThreadSend',
      'ThreadWait',
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

  it('creates a top-level session in an existing directory outside the current workspace', async () => {
    const external = await mkdtemp(join(tmpdir(), 'thread-create-external-'));
    try {
      const { tool, create, metadata } = createThreadFixture();
      const result = await executeThreadCreate(tool, { title: 'Separate topic', cwd: external });
      expect(create).toHaveBeenCalledExactlyOnceWith({ workDir: external, mainAgentBinding: undefined });
      expect(metadata.setTitle).toHaveBeenCalledExactlyOnceWith('Separate topic');
      expect(JSON.parse(result.output as string)).toMatchObject({
        id: 'session-new', title: 'Separate topic', cwd: external, profile: 'agent', prompt_started: false,
        message: expect.stringContaining('ThreadSend and ThreadWait'),
      });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('uses the ambient workspace and leaves the thread empty without a prompt', async () => {
    const { tool, create, metadata, prompt, lifecycle } = createThreadFixture();
    const result = await executeThreadCreate(tool, {});
    expect(create).toHaveBeenCalledExactlyOnceWith({ workDir: '/ambient/workspace', mainAgentBinding: undefined });
    expect(metadata.setTitle).not.toHaveBeenCalled();
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(prompt.enqueue).not.toHaveBeenCalled();
    expect(JSON.parse(result.output as string)).toMatchObject({
      id: 'session-new', title: 'Untitled session', cwd: '/ambient/workspace', profile: 'agent', prompt_started: false,
    });
  });

  it('binds an enabled main profile to the new session without other agent_config fields', async () => {
    const { tool, create, lifecycle } = createThreadFixture();
    const result = await executeThreadCreate(tool, { profile: 'main-alt' });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      workDir: '/ambient/workspace', mainAgentBinding: { profile: 'main-alt' },
    });
    expect(lifecycle.create).toHaveBeenCalledExactlyOnceWith({
      agentId: 'main', binding: { profile: 'main-alt' },
    });
    expect(JSON.parse(result.output as string)).toMatchObject({ profile: 'main-alt', prompt_started: false });
  });

  it.each([
    { profile: 'missing', reason: 'unavailable or disabled' },
    { profile: 'disabled', reason: 'unavailable or disabled' },
    { profile: 'worker', reason: 'not a main-agent profile' },
  ])('rejects an invalid main profile and removes the new empty session: %o', async ({ profile, reason }) => {
    const { tool, remove, prompt } = createThreadFixture();
    await expect(executeThreadCreate(tool, { profile, prompt: 'Start work' })).rejects.toThrow(reason);
    expect(remove).toHaveBeenCalledExactlyOnceWith('session-new');
    expect(prompt.enqueue).not.toHaveBeenCalled();
  });

  it('submits the first prompt as a user message and waits for its turn to launch', async () => {
    let launch!: (value: { id: number }) => void;
    const launched = new Promise<{ id: number }>((resolve) => { launch = resolve; });
    const { tool, prompt, lifecycle, metadata } = createThreadFixture({ launched });
    const firstLine = 'A'.repeat(90);
    const content = `${firstLine}\nAdditional instructions`;
    const pending = executeThreadCreate(tool, { prompt: content });
    await vi.waitFor(() => expect(prompt.enqueue).toHaveBeenCalledOnce());
    expect(prompt.enqueue).toHaveBeenCalledExactlyOnceWith({
      message: {
        role: 'user', content: [{ type: 'text', text: content }], toolCalls: [], origin: { kind: 'user' },
      },
    });
    expect(metadata.setTitle).toHaveBeenCalledExactlyOnceWith('A'.repeat(80));
    expect(lifecycle.create).toHaveBeenCalledExactlyOnceWith({ agentId: 'main' });
    let returned = false;
    void pending.then(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);
    launch({ id: 1 });
    const result = await pending;
    expect(JSON.parse(result.output as string)).toMatchObject({
      title: 'A'.repeat(80), profile: 'agent', prompt_started: true,
    });
  });

  it('delivers a new thread prompt to a real agent loop and starts its turn', async () => {
    const target = createTestAgent();
    try {
      target.mockNextResponse({ type: 'text', text: 'new thread answered' });
      const agent: IAgentScopeHandle = {
        id: 'main', kind: 'agent', accessor: { get: (id) => target.get(id) }, dispose() {},
      };
      const session: ISessionScopeHandle = {
        id: 'session-new', kind: 'session', dispose() {},
        accessor: {
          get(id) {
            if (id === IAgentLifecycleService) return { create: async () => agent } as never;
            if (id === ISessionContext) return { cwd: '/target/workspace' } as never;
            return target.get(id);
          },
        },
      };
      const ix = disposables.add(new TestInstantiationService());
      ix.stub(ISessionContext, { cwd: '/ambient/workspace' });
      ix.stub(ISessionManager, { create: async () => session, delete: async () => {} });
      ix.set(IThreadCreateTool, new SyncDescriptor(ThreadCreateTool));

      const result = await executeThreadCreate(ix.get(IThreadCreateTool), { prompt: 'Work in the new thread' });
      expect(JSON.parse(result.output as string)).toMatchObject({ prompt_started: true, cwd: '/target/workspace' });
      await target.get(IAgentLoopService).settled();
      expect(target.llmCalls).toHaveLength(1);
      expect(target.contextData().history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'user', origin: { kind: 'user' },
          content: [{ type: 'text', text: 'Work in the new thread' }],
        }),
      ]));
    } finally {
      await target.dispose();
    }
  });

  it('prefers an explicit title when launching a prompt', async () => {
    const { tool, metadata } = createThreadFixture();
    await executeThreadCreate(tool, { title: 'Chosen', prompt: 'First line\nNext line' });
    expect(metadata.setTitle).toHaveBeenCalledExactlyOnceWith('Chosen');
  });

  it('rejects relative cwd before creating a session and surfaces missing-directory errors', async () => {
    const { tool, create } = createThreadFixture();
    expect(await executeThreadCreate(tool, { cwd: 'relative/path' })).toMatchObject({
      isError: true, output: expect.stringContaining('absolute path'),
    });
    expect(create).not.toHaveBeenCalled();
    const missing = join(tmpdir(), 'missing-thread-create-workspace');
    create.mockRejectedValueOnce(new Error(`workspace root ${missing} does not exist`));
    await expect(executeThreadCreate(tool, { cwd: missing })).rejects.toThrow('does not exist');
    expect(create).toHaveBeenCalledExactlyOnceWith({ workDir: missing, mainAgentBinding: undefined });
  });

  it('accepts only the four optional ThreadCreate inputs and discourages unsolicited creation', () => {
    const { tool } = createThreadFixture();
    expect(ThreadCreateToolInputSchema.safeParse({}).success).toBe(true);
    expect(ThreadCreateToolInputSchema.safeParse({ title: '', cwd: '/example' }).success).toBe(false);
    expect(ThreadCreateToolInputSchema.safeParse({ prompt: '', agent_config: {} }).success).toBe(false);
    expect(ThreadCreateToolInputSchema.safeParse({ profile: 'agent', prompt: 'Start' }).success).toBe(true);
    expect(tool.description).toContain('Do not use this tool unless the user explicitly asks');
  });
});

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createThreadFixture(options: { launched?: Promise<{ id: number }> } = {}) {
  const ix = disposables.add(new TestInstantiationService());
  let title: string | undefined;
  const metadata = {
    setTitle: vi.fn(async (value: string) => { title = value; }),
    read: vi.fn(async () => ({ title })),
  };
  const prompt = {
    enqueue: vi.fn(async () => ({
      launched: options.launched ?? Promise.resolve({ id: 1 }),
      completion: Promise.resolve({ state: 'completed' }),
    })),
  };
  const agent = { id: 'main', accessor: { get: () => prompt } } as unknown as IAgentScopeHandle;
  const lifecycle = { create: vi.fn<IAgentLifecycleService['create']>(async () => agent) };
  const catalog = {
    ready: Promise.resolve(),
    getDefault: () => ({ name: 'agent', main: true }),
    get: (name: string) => ({
      agent: { name: 'agent', main: true },
      'main-alt': { name: 'main-alt', main: true },
      worker: { name: 'worker', main: false },
    })[name as 'agent' | 'main-alt' | 'worker'],
  };
  const create = vi.fn<ISessionManager['create']>(async (options) => {
    if (options.mainAgentBinding !== undefined) {
      await lifecycle.create({ agentId: 'main', binding: options.mainAgentBinding });
    }
    return {
      id: 'session-new',
      kind: 'session' as const,
      dispose() {},
      accessor: {
        get(id) {
          if (id === ISessionMetadata) return metadata as never;
          if (id === ISessionContext) return { cwd: options.workDir } as never;
          if (id === ISessionAgentProfileCatalog) return catalog as never;
          if (id === IAgentLifecycleService) return lifecycle as never;
          throw new Error(`Unexpected service: ${String(id)}`);
        },
      },
    } as ISessionScopeHandle;
  });
  const remove = vi.fn<ISessionManager['delete']>(async () => {});
  ix.stub(ISessionManager, { create, delete: remove });
  ix.stub(ISessionContext, { cwd: '/ambient/workspace' });
  ix.set(IThreadCreateTool, new SyncDescriptor(ThreadCreateTool));
  return { tool: ix.get(IThreadCreateTool), create, remove, metadata, lifecycle, prompt };
}

async function executeThreadCreate(tool: IThreadCreateTool, input: Parameters<IThreadCreateTool['resolveExecution']>[0]) {
  const execution = await tool.resolveExecution(input);
  return 'execute' in execution ? execution.execute({} as never) : execution;
}

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
