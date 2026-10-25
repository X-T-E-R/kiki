import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import type { ToolDidExecuteContext, ToolExecutionOutcome } from '#/agent/toolExecutor/toolHooks';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { AgentPluginToolService } from '#/agent/userTool/pluginToolService';
import type { IPluginService } from '#/app/plugin/plugin';
import type { IPluginUsageService, PluginUsageChange } from '#/app/pluginUsage/pluginUsage';
import type { IPluginHostService } from '#/app/plugin/pluginHostService';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { IAgentToolExecutorService, ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import type { ToolCall } from '#/kosong/contract/message';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IAgentProfileService } from '#/agent/profile/profile';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { ExecutableTool, RunnableToolExecution } from '#/tool/toolContract';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function dir() {
  const created = await mkdtemp(path.join(tmpdir(), 'kiki-plugin-path-'));
  directories.push(created);
  return created;
}

function setup(workspace: string, usage?: IPluginUsageService, workspaceId = 'workspace-a', messageExecutor?: IAgentToolExecutorService, suppliedDocuments?: IAtomicTomlDocumentStore) {
  const ix = new TestInstantiationService();
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  const documents = suppliedDocuments ?? ix.get(IAtomicTomlDocumentStore);
  const plugin = { onDidReload: () => ({ dispose() {} }) } as unknown as IPluginService;
  const hosts = { list: vi.fn(async () => [{ pluginId: 'kiki-office', definition: {
    schemaVersion: 1 as const, name: 'office_create', description: 'Create a document',
    accesses: [{ kind: 'file' as const, operation: 'write' as const, path: '$.file' }, { kind: 'all' as const }],
    disclosure: 'deferred' as const,
  } }]), execute: vi.fn(async () => ({ output: 'created' })) } as unknown as IPluginHostService;
  const tools = new Map<string, ExecutableTool>();
  if (messageExecutor !== undefined) tools.set('SendMessage', { name: 'SendMessage', description: 'Send', parameters: { type: 'object' }, resolveExecution: () => ({ approvalRule: 'SendMessage', execute: async () => ({ output: '{}' }) }) });
  const registry = {
    register: (tool: ExecutableTool) => { tools.set(tool.name, tool); return { dispose: () => { tools.delete(tool.name); } }; },
    registerPreparation: () => ({ dispose: () => {} }),
    prepare: async () => {},
    resolve: (name: string) => tools.get(name),
  } as unknown as IAgentToolRegistryService;
  const runtime = new FakeRuntime({ workspaceId: 'w', runtimeId: 'local', generation: '1' },
    { pathClass: process.platform === 'win32' ? 'win32' : 'posix' });
  const fs = new HostFileSystem();
  Object.assign(runtime, { fs });
  const runtimeService = { inspect: () => runtime, acquire: () => ({ runtime, dispose() {} }) } as unknown as IAgentRuntimeService;
  const workspaceCtx = { workDir: workspace, additionalDirs: [] } as unknown as ISessionWorkspaceContext;
  const profile = { getModelCapabilities: () => ({ image_in: true }) } as unknown as IAgentProfileService;
  const service = new AgentPluginToolService(
    plugin,
    hosts,
    registry,
    runtimeService,
    workspaceCtx,
    profile,
    undefined,
    usage,
    { workspaceId, sessionId: 'session-a' } as ISessionContext,
    undefined,
    { agentId: 'main', scope: (key?: string) => `sessions/session-a/agents/main/${key ?? ''}` } as IAgentScopeContext,
    messageExecutor,
    documents,
  );
  return { service, tools, hosts, fs, documents };
}

function usageState(): {
  readonly usage: IPluginUsageService;
  readonly fire: (workspaceId: string) => Promise<void>;
} {
  const changed = new Emitter<PluginUsageChange>();
  return {
    usage: {
      enabled: () => true,
      allows: async () => true,
      onDidChange: changed.event,
    } as unknown as IPluginUsageService,
    fire: async (workspaceId) => {
      const waits: Promise<unknown>[] = [];
      changed.fire({
        workspaceId,
        pluginId: 'kiki-office',
        revision: 1,
        waitUntil: (promise) => waits.push(promise),
      });
      await Promise.all(waits);
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function executorFor(result: ToolExecutionResult['result'], calls: ToolCall[]): IAgentToolExecutorService {
  return executorForResults([result], calls);
}

function executorForResults(results: readonly ToolExecutionResult['result'][], calls: ToolCall[], after?: (index: number) => void, errorOutcome: ToolExecutionOutcome = 'preflight-rejected'): IAgentToolExecutorService {
  let index = 0;
  const hooks = { onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>() };
  return {
    hooks,
    execute: async function* (toolCalls: ToolCall[]): AsyncGenerator<ToolExecutionResult> {
      const call = toolCalls[0]!;
      calls.push(call);
      after?.(index);
      const result = results[Math.min(index++, results.length - 1)]!;
      await hooks.onDidExecuteTool.run({ turnId: 1, signal: new AbortController().signal, toolCall: call, toolCalls, args: JSON.parse(call.arguments!), result, outcome: result.isError === true ? errorOutcome : 'executed' });
      yield { toolCallId: call.id, toolName: 'SendMessage', result };
    },
  } as unknown as IAgentToolExecutorService;
}

const context = { turnId: 1, toolCallId: 'one', signal: new AbortController().signal };

describe('plugin file target admission', () => {
  it('resolves $.file into a real target and only passes the approved outside target to its own host', async () => {
    const workspace = await dir();
    const outside = await dir();
    const { service, tools, hosts } = setup(workspace);
    try {
      await service.ready();
      const tool = tools.get('plugin__kiki_office__office_create')!;
      const local = await tool.resolveExecution({ file: 'draft.docx' }) as RunnableToolExecution;
      expect(local.accesses?.[0]).toMatchObject({ kind: 'file', path: path.join(workspace, 'draft.docx').replaceAll('\\', '/') });
      expect(local.approvalRule).toContain('draft.docx');
      await local.execute(context);
      expect(vi.mocked(hosts.execute).mock.lastCall?.[5]).toMatchObject({ workspaceRoot: workspace, approvedPaths: [], imageIn: true });
      const external = path.join(outside, 'draft.docx');
      const execution = await tool.resolveExecution({ file: external }) as RunnableToolExecution;
      expect(execution.accesses?.[0]).toMatchObject({ path: external.replaceAll('\\', '/') });
      await execution.execute(context);
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5];
      expect(scope?.approvedPaths).toEqual([outside.replaceAll('\\', '/')]);
      expect(vi.mocked(hosts.execute).mock.lastCall?.[2]).toEqual({ file: external.replaceAll('\\', '/') });
    } finally { await service.dispose(); }
  });

  it('rejects target replacement between approval and execution', async () => {
    const workspace = await dir();
    const { service, tools, hosts, fs } = setup(workspace);
    try {
      await service.ready();
      const target = path.join(workspace, 'document.docx');
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: target }) as RunnableToolExecution;
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, 'realpath').mockImplementation((candidate) =>
        candidate.replaceAll('\\', '/') === target.replaceAll('\\', '/')
          ? Promise.resolve(path.join(workspace, 'replaced.docx').replaceAll('\\', '/')) : realpath(candidate));
      await expect(execution.execute(context)).resolves.toMatchObject({ isError: true, output: expect.stringContaining('changed') });
      expect(hosts.execute).not.toHaveBeenCalled();
    } finally { await service.dispose(); }
  });

  it('keeps workspace usage admission isolated and lets started calls complete after an off', async () => {
    const workspace = await dir();
    const state = usageState();
    let workspaceAAllowed = true;
    const sharedUsage = {
      ...state.usage,
      allows: async (workspaceId: string | undefined) => workspaceId !== 'workspace-a' || workspaceAAllowed,
    } as unknown as IPluginUsageService;
    const a = setup(workspace, sharedUsage, 'workspace-a');
    const b = setup(workspace, sharedUsage, 'workspace-b');
    try {
      await Promise.all([a.service.ready(), b.service.ready()]);
      const toolA = a.tools.get('plugin__kiki_office__office_create')!;
      const toolB = b.tools.get('plugin__kiki_office__office_create')!;
      const prepared = await toolA.resolveExecution({ file: path.join(workspace, 'late.docx') });
      if (prepared.isError === true) throw new Error('expected runnable workspace-A tool');

      workspaceAAllowed = false;
      await expect(prepared.execute(context)).resolves.toMatchObject({
        isError: true,
        output: expect.stringContaining('disabled in this session'),
      });
      expect(a.hosts.execute).not.toHaveBeenCalled();
      await state.fire('workspace-a');
      expect(a.tools.has('plugin__kiki_office__office_create')).toBe(false);
      expect(b.tools.has('plugin__kiki_office__office_create')).toBe(true);

      const bExecution = await toolB.resolveExecution({ file: path.join(workspace, 'b.docx') });
      if (bExecution.isError === true) throw new Error('expected runnable workspace-B tool');
      await expect(bExecution.execute(context)).resolves.toMatchObject({ output: 'created' });
      expect(b.hosts.execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(b.hosts.execute).mock.calls[0]?.[6]).toMatchObject({ name: 'office_create' });

      workspaceAAllowed = true;
      const started = deferred<void>();
      const released = deferred<{ readonly output: string }>();
      vi.mocked(a.hosts.execute).mockImplementation(async () => {
        started.resolve();
        return released.promise;
      });
      const active = await toolA.resolveExecution({ file: path.join(workspace, 'active.docx') });
      if (active.isError === true) throw new Error('expected active runnable workspace-A tool');
      const result = active.execute(context);
      await started.promise;
      workspaceAAllowed = false;
      released.resolve({ output: 'completed after off' });
      await expect(result).resolves.toEqual({ output: 'completed after off' });
      expect(a.hosts.execute).toHaveBeenCalledTimes(1);
    } finally {
      await a.service.dispose();
      await b.service.dispose();
    }
  });
});

describe('plugin messages.send', () => {
  it('reuses concurrent explicit IDs across tool calls and service restoration, including uncertain executor failures', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const release = deferred<void>();
    const executor = { hooks: { onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>() }, execute: async function* (tools: ToolCall[]): AsyncGenerator<ToolExecutionResult> {
      calls.push(tools[0]!);
      await release.promise;
      throw new Error('transport ended after submission');
    } } as unknown as IAgentToolExecutorService;
    const first = setup(workspace, undefined, 'workspace-a', executor);
    const api = async (harness: ReturnType<typeof setup>, id: string) => {
      await harness.service.ready();
      const execution = await harness.tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute({ ...context, toolCallId: id });
      return (vi.mocked(harness.hosts.execute).mock.lastCall?.[5] as { messages: { send(input: unknown): Promise<any> } }).messages;
    };
    const a = await api(first, 'tool-a');
    const b = await api(first, 'tool-b');
    const input = { text: 'send once', request_id: 'stable-request' };
    const sending = a.send(input);
    const repeated = b.send(input);
    release.resolve();
    const receipt = await sending;
    expect(await repeated).toEqual(receipt);
    expect(receipt).toMatchObject({ delivery: 'pending', detail: expect.stringContaining('Do not resend') });
    expect(calls).toHaveLength(1);
    await first.service.dispose();
    const restored = setup(workspace, undefined, 'workspace-a', executor, first.documents);
    try {
      const restoredApi = await api(restored, 'restored-tool-call');
      expect(await restoredApi.send(input)).toEqual(receipt);
      expect(calls).toHaveLength(1);
      await expect(restoredApi.send({ ...input, text: 'different' })).rejects.toThrow('different payload');
    } finally { await restored.service.dispose(); }
  });
  it('restores completed batch items and reserves uncertain remaining items without sending them again', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const enteredSecond = deferred<void>();
    const release = deferred<void>();
    const executor = { hooks: { onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>() }, execute: async function* (tools: ToolCall[]): AsyncGenerator<ToolExecutionResult> {
      calls.push(tools[0]!);
      if (calls.length === 1) {
        yield { toolCallId: tools[0]!.id, toolName: 'SendMessage', result: { output: JSON.stringify({ message_id: `send:${tools[0]!.id}`, delivered_to: ['user'], delivery: 'delivered', channels: [{ channel_id: 'notify:fixture', status: 'partial' }] }) } };
        return;
      }
      enteredSecond.resolve();
      await release.promise;
      throw new Error('transport ended after submission');
    } } as unknown as IAgentToolExecutorService;
    const first = setup(workspace, undefined, 'workspace-a', executor);
    const restored = setup(workspace, undefined, 'workspace-a', executor, first.documents);
    const api = async (harness: ReturnType<typeof setup>, toolCallId: string) => {
      await harness.service.ready();
      const execution = await harness.tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute({ ...context, toolCallId });
      return (vi.mocked(harness.hosts.execute).mock.lastCall?.[5] as { messages: { send(input: unknown): Promise<any> } }).messages;
    };
    try {
      const input = { messages: [{ text: 'accepted' }, { text: 'uncertain' }, { text: 'unlaunched' }], request_id: 'restored-batch' };
      const sending = (await api(first, 'original')).send(input);
      await enteredSecond.promise;
      const snapshot = await (await api(restored, 'restored')).send(input);
      expect(snapshot.messages).toEqual([
        expect.objectContaining({ index: 0, delivery: 'delivered', channels: [{ channel_id: 'notify:fixture', status: 'partial' }] }),
        expect.objectContaining({ index: 1, delivery: 'pending', detail: expect.stringContaining('Do not resend') }),
        expect.objectContaining({ index: 2, delivery: 'pending', detail: expect.stringContaining('Do not resend') }),
      ]);
      expect(calls).toHaveLength(2);
      release.resolve();
      const result = await sending;
      expect(result.messages[1]).toMatchObject({ index: 1, delivery: 'pending' });
      expect(result.messages[2]).toMatchObject({ index: 2, delivery: 'not_sent' });
      expect(result.messages.map((item: { message_id: string }) => item.message_id)).toEqual(snapshot.messages.map((item: { message_id: string }) => item.message_id));
      expect(calls).toHaveLength(2);
    } finally {
      release.resolve();
      await first.service.dispose();
      await restored.service.dispose();
    }
  });

  it('injects the SendMessage capability and reuses explicit unknown receipts without resending', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const receipt = {
      output: JSON.stringify({
        message_id: 'send:plugin-message',
        delivered_to: [],
        delivery: 'pending',
        channels: [{ channel_id: 'notify:fixture', status: 'unknown', detail: 'transport_timeout' }],
      }),
    };
    const executor = executorFor(receipt, calls);
    const { service, tools, hosts } = setup(workspace, undefined, 'workspace-a', executor);
    try {
      await service.ready();
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute(context);
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5] as { readonly messages?: { send(input: unknown): Promise<any> } };
      expect(scope.messages).toBeDefined();
      const first = await scope.messages!.send({ text: 'same', request_id: 'request-1' });
      const second = await scope.messages!.send({ text: 'same', request_id: 'request-1' });
      expect(second).toEqual(first);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.arguments!)).toEqual({ text: 'same' });
      await expect(scope.messages!.send({ text: 'changed', request_id: 'request-1' })).rejects.toThrow('different payload');
      const third = await scope.messages!.send({ text: 'next' });
      const fourth = await scope.messages!.send({ text: 'another' });
      expect(third).toEqual(first);
      expect(fourth).toEqual(third);
      expect(calls).toHaveLength(3);
      expect(calls[1]!.id).not.toBe(calls[2]!.id);
    } finally { await service.dispose(); }
  });

  it('sends ordered batch items with stable child ids and preserves per-item unknown or partial receipts', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const executor = executorForResults([
      { output: JSON.stringify({ message_id: 'send:first', delivered_to: [], delivery: 'pending', channels: [{ channel_id: 'notify:fixture', status: 'unknown' }] }) },
      { output: JSON.stringify({ message_id: 'send:second', delivered_to: ['user'], delivery: 'delivered', channels: [{ channel_id: 'notify:fixture', status: 'partial' }] }) },
    ], calls);
    const { service, tools, hosts } = setup(workspace, undefined, 'workspace-a', executor);
    try {
      await service.ready();
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute(context);
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5] as { readonly messages?: { send(input: unknown): Promise<any> } };
      const input = { messages: [{ text: 'first' }, { text: 'second', reply_to: 'message-1' }], to: 'user', channels: ['notify:fixture'], request_id: 'batch-1' };
      const first = await scope.messages!.send(input);
      expect(first.messages).toHaveLength(2);
      expect(first.messages[0]).toMatchObject({ index: 0, message_id: 'send:first', delivery: 'pending' });
      expect(first.messages[1]).toMatchObject({ index: 1, message_id: 'send:second', delivery: 'delivered' });
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0]!.arguments!)).toEqual({ text: 'first', to: 'user', channels: ['notify:fixture'] });
      expect(JSON.parse(calls[1]!.arguments!)).toEqual({ text: 'second', reply_to: 'message-1', to: 'user', channels: ['notify:fixture'] });
      expect(calls[0]!.id).not.toBe(calls[1]!.id);
      const repeated = await scope.messages!.send(input);
      expect(repeated).toEqual(first);
      expect(calls).toHaveLength(2);
      await expect(scope.messages!.send({ ...input, messages: [{ text: 'changed' }, { text: 'second', reply_to: 'message-1' }] })).rejects.toThrow('different payload');
    } finally { await service.dispose(); }
  });

  it('stops an ordered batch on cancellation and marks only unlaunched items cancelled', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const controller = new AbortController();
    const executor = executorForResults([
      { output: JSON.stringify({ message_id: 'send:first', delivered_to: ['user'], delivery: 'delivered' }) },
    ], calls, (index) => { if (index === 0) controller.abort(); });
    const { service, tools, hosts } = setup(workspace, undefined, 'workspace-a', executor);
    try {
      await service.ready();
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute({ ...context, signal: controller.signal });
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5] as { readonly messages?: { send(input: unknown): Promise<any> } };
      const receipt = await scope.messages!.send({ messages: [{ text: 'first' }, { text: 'second' }, { text: 'third' }], request_id: 'batch-cancel' });
      expect(receipt.messages).toHaveLength(3);
      expect(receipt.messages[0]).toMatchObject({ index: 0, delivery: 'delivered' });
      expect(receipt.messages.slice(1)).toEqual([
        expect.objectContaining({ index: 1, delivery: 'cancelled' }),
        expect.objectContaining({ index: 2, delivery: 'cancelled' }),
      ]);
      expect(calls).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it('distinguishes pre-execution denial from an error after SendMessage execution began', async () => {
    const workspace = await dir();
    const deniedCalls: ToolCall[] = [];
    const uncertainCalls: ToolCall[] = [];
    const denied = setup(workspace, undefined, 'workspace-a', executorFor({ output: 'permission denied', isError: true }, deniedCalls));
    const uncertain = setup(workspace, undefined, 'workspace-a', executorForResults([{ output: 'receipt persistence failed', isError: true }], uncertainCalls, undefined, 'executed'));
    const api = async (harness: ReturnType<typeof setup>) => {
      await harness.service.ready();
      const execution = await harness.tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute(context);
      return (vi.mocked(harness.hosts.execute).mock.lastCall?.[5] as { messages: { send(input: unknown): Promise<any> } }).messages;
    };
    try {
      const deniedApi = await api(denied);
      const receipt = await deniedApi.send({ text: 'denied', request_id: 'denied' });
      expect(receipt).toMatchObject({ delivery: 'undeliverable', detail: 'permission denied' });
      expect(await deniedApi.send({ text: 'denied', request_id: 'denied' })).toEqual(receipt);
      const uncertainApi = await api(uncertain);
      const batch = { messages: [{ text: 'may have sent' }, { text: 'unlaunched' }], request_id: 'uncertain-execution' };
      const uncertainReceipt = await uncertainApi.send(batch);
      expect(uncertainReceipt.messages).toEqual([
        expect.objectContaining({ index: 0, delivery: 'pending', detail: expect.stringContaining('Do not resend') }),
        expect.objectContaining({ index: 1, delivery: 'not_sent' }),
      ]);
      expect(await uncertainApi.send(batch)).toEqual(uncertainReceipt);
      expect(deniedCalls).toHaveLength(1);
      expect(uncertainCalls).toHaveLength(1);
    } finally { await denied.service.dispose(); await uncertain.service.dispose(); }
  });

  it('stops a batch after a denied item and marks later items not_sent without retrying', async () => {
    const workspace = await dir();
    const calls: ToolCall[] = [];
    const executor = executorFor({ output: 'permission denied', isError: true }, calls);
    const { service, tools, hosts } = setup(workspace, undefined, 'workspace-a', executor);
    try {
      await service.ready();
      const execution = await tools.get('plugin__kiki_office__office_create')!.resolveExecution({ file: path.join(workspace, 'draft.docx') }) as RunnableToolExecution;
      await execution.execute(context);
      const scope = vi.mocked(hosts.execute).mock.lastCall?.[5] as { readonly messages?: { send(input: unknown): Promise<any> } };
      const receipt = await scope.messages!.send({ messages: [{ text: 'denied' }, { text: 'not sent' }] });
      expect(receipt.messages).toEqual([
        expect.objectContaining({ index: 0, delivery: 'not_sent', detail: 'permission denied' }),
        expect.objectContaining({ index: 1, delivery: 'not_sent' }),
      ]);
      expect(calls).toHaveLength(1);
    } finally { await service.dispose(); }
  });
});
