import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE, MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { TaskNotificationStepRequest } from '#/agent/task/taskService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISendMessageTool, isOggOpusAudio, runManagedFfmpeg } from '#/agent/tools/message/sendMessageTool';
import { IBotService } from '#/app/bot/bot';
import { IConfigService } from '#/app/config/config';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { PluginMediaService } from '#/app/pluginMedia/pluginMediaService';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { SEND_MESSAGE_SECTION } from '#/agent/tools/message/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IRoomMessageRouter, IUserMessageRouter, internalMessageChannel, routeUserMessage, type MessageChannelBinding, type SendMessageReceipt, type UserMessageChannel } from '#/app/bot/messageRouting';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { FakeImAdapter, fakeAdapterFactory, ImSessionBridge, type ImSessionPorts } from '@nb-corp/im-bridge-core';
import type { MediaGenerateInput, MediaJob } from '@kiki/protocol';
import { ChatProviderError, markProviderEventError } from '#/kosong/contract/errors';
import type { HookDef } from '#/features/externalHooks/internal/types';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { appServices, createTestAgent, externalHookServices, homeDirServices, permissionModeServices, type TestAgentContext, type TestAgentServiceOverride } from '../../../harness';
import { makeHookRunner, nodeCommand } from '../../../features/externalHooks/runner-stub';

let ctx: TestAgentContext;
const dirs: string[] = [];
afterEach(async () => {
  await ctx?.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function messageAgent(...overrides: TestAgentServiceOverride[]): Promise<TestAgentContext> {
  ctx = createTestAgent(...overrides);
  const delivery = ctx.get(ISessionDeliveryService);
  await delivery.ready;
  await delivery.set('message');
  return ctx;
}

async function mediaAgent(files: readonly string[], ...overrides: TestAgentServiceOverride[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'send-message-media-'));
  dirs.push(cwd);
  for (const name of files) await writeFile(join(cwd, name), new Uint8Array([1, 2, 3, 4]));
  ctx = createTestAgent({ cwd }, ...overrides);
  const delivery = ctx.get(ISessionDeliveryService);
  await delivery.ready;
  await delivery.set('message');
  return cwd;
}

async function execute(input: Parameters<ISendMessageTool['resolveExecution']>[0], context = { turnId: 0, toolCallId: 'send-1', signal: new AbortController().signal }): Promise<ExecutableToolResult> {
  const execution = await ctx.get(ISendMessageTool).resolveExecution(input);
  return 'execute' in execution ? execution.execute(context) : execution;
}

function historyText(index: number): string {
  return ctx.llmCalls[index]!.history.flatMap((message) => message.content)
    .map((part) => part.type === 'text' ? part.text : '').join('\n');
}

function sendCalls(): string[] {
  return ctx.get(IAgentContextMemoryService).get().flatMap((message) => message.toolCalls ?? [])
    .filter((call) => call.name === 'SendMessage').map((call) => call.id);
}

describe('SendMessage completion guidance', () => {
  it('requests completion only for fully delivered final message batches', async () => {
    await messageAgent();
    expect((await execute({ messages: [{ text: 'First' }, { text: 'Last' }], end_turn: true })).stopTurn).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect((await execute({ messages: [{ text: 'Unsent' }], end_turn: true }, { turnId: 0, toolCallId: 'cancelled-batch', signal: controller.signal })).stopTurn).toBeUndefined();
  });

  it.each(['partial', 'failed', 'unknown'] as const)('continues after an explicit-channel final send with %s channel delivery', async (status) => {
    const send = vi.fn(async (): Promise<SendMessageReceipt> => ({
      messageId: 'send:final', deliveredTo: ['user'], delivery: 'delivered',
      channels: [{ channelId: 'notify:fixture', status }],
    }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    expect((await execute({ channel: 'notify:fixture', messages: [{ text: 'First' }, { text: 'Last' }], end_turn: true })).stopTurn).toBeUndefined();
    ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"Final answer","channel":"notify:fixture","end_turn":true}' });
    ctx.mockNextResponse({ type: 'text', text: 'Delivery requires attention.' });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it.each(['failed', 'unknown'] as const)('continues after an implicit fan-out final send when the only channel is %s', async (status) => {
    const send = vi.fn(async (): Promise<SendMessageReceipt> => ({
      messageId: 'send:final', deliveredTo: ['user'], delivery: 'delivered',
      channels: [{ channelId: 'notify:fixture', status }],
    }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    expect((await execute({ messages: [{ text: 'First' }, { text: 'Last' }], end_turn: true })).stopTurn).toBeUndefined();
    ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"Final answer","end_turn":true}' });
    ctx.mockNextResponse({ type: 'text', text: 'Delivery requires attention.' });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('continues when approval rejects a final SendMessage before delivery', async () => {
    const send = vi.fn(async (): Promise<SendMessageReceipt> => ({ messageId: 'unexpected', deliveredTo: ['user'] }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    const approval = ctx.get(IAgentToolExecutorService).onBeforeExecuteTool((event) => {
      if (event.toolCall.name === 'SendMessage') event.veto({ output: 'Message approval rejected.', isError: true });
    });
    try {
      ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"Final answer","end_turn":true}' });
      ctx.mockNextResponse({ type: 'text', text: 'Approval requires attention.' });
      expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] })).state).toBe('completed');
      expect(ctx.llmCalls).toHaveLength(2);
      expect(send).not.toHaveBeenCalled();
      expect(historyText(1)).toContain('Message approval rejected.');
    } finally {
      approval.dispose();
    }
  });

  it('sends a media-only message with an explicit kind through the in-app channel', async () => {
    const cwd = await mediaAgent(['clip.mp4']);
    const result = await execute({ attachments: [{ path: 'clip.mp4', kind: 'video', mime_type: 'video/mp4' }] });
    const wire = JSON.parse(result.output as string);
    expect(wire.delivered_to).toEqual(['user']);
    expect(wire.channels).toEqual([{ channel_id: 'internal', status: 'delivered' }]);
    expect(wire.attachments).toEqual([expect.objectContaining({ kind: 'video', mime_type: 'video/mp4', source_id: expect.stringMatching(/^[a-f0-9]{64}$/u) })]);
    const blobId = String(wire.attachments[0]?.blob_id ?? '');
    const sourceId = String(wire.attachments[0]?.source_id ?? '');
    const sourceDoc = await ctx.get(IAtomicDocumentStore).get<{
      version: number;
      sourceId: string;
      sessionId: string;
      agentId: string;
      blobId: string;
      path: string;
    }>(
      ctx.get(IAgentScopeContext).scope('blobs'),
      `sources/${sourceId}.json`,
    );
    expect(sourceDoc).toMatchObject({
      version: 1,
      sourceId,
      sessionId: ctx.get(ISessionContext).sessionId,
      agentId: 'main',
      blobId,
      path: expect.stringContaining(cwd),
    });
    expect(result.note).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
  });

  it('sends a generated session media artifact by file_id and rejects missing or truncated file_id', async () => {
    await messageAgent();
    const data = Buffer.from('generated-media');
    await ctx.get(ISessionMediaStore).materialize({
      fileId: 'f_media_fixture',
      name: 'cover.png',
      mimeType: 'image/png',
      size: data.length,
      stream: () => Readable.from([data]),
    });
    const result = await execute({ attachments: [{ file_id: 'f_media_fixture' }] });
    const wire = JSON.parse(result.output as string);
    expect(wire.delivered_to).toEqual(['user']);
    expect(wire.attachments).toEqual([expect.objectContaining({ kind: 'image', mime_type: 'image/png', size: data.length })]);

    const missingExecution = await ctx.get(ISendMessageTool).resolveExecution({ attachments: [{ file_id: 'f_missing_session_media' }] });
    if (!('execute' in missingExecution)) throw new Error('Expected an executable tool.');
    await expect(missingExecution.execute({ turnId: 0, toolCallId: 'missing-fid', signal: new AbortController().signal }))
      .rejects.toThrow('Attachment file_id is not available in this session: f_missing_session_media');
  });

  it('copies readable attachments from workspace-relative paths, outside-workspace absolute paths, symlink targets outside workspace, and Chinese/space paths into blobs for single and batch sends while rejecting missing or directory paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'send-message-cwd-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'send-message-outside-'));
    dirs.push(cwd, outsideDir);

    const relDir = join(cwd, '子目录 附件');
    await mkdir(relDir, { recursive: true });
    const relBytes = Buffer.from('relative-attachment-bytes-中文');
    const relSubPath = join('子目录 附件', '说明 文档.txt');
    await writeFile(join(cwd, relSubPath), relBytes);

    const outsideSubDir = join(outsideDir, '外部 导出');
    await mkdir(outsideSubDir, { recursive: true });
    const outsideBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
    const outsideFilePath = join(outsideSubDir, '测试 图片 01.png');
    await writeFile(outsideFilePath, outsideBytes);

    const linkedDirPath = join(cwd, 'linked-outside-dir');
    await symlink(outsideSubDir, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedFileInWorkspace = join(linkedDirPath, '测试 图片 01.png');

    const batchOutsideFilePath = join(outsideDir, 'batch-report.md');
    const batchOutsideBytes = Buffer.from('# External Batch Report\nLine 2');
    await writeFile(batchOutsideFilePath, batchOutsideBytes);

    const sentInputs: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];
    ctx = createTestAgent(
      { cwd },
      appServices((reg) => reg.definePartialInstance(IUserMessageRouter, {
        listChannels: async () => [internalMessageChannel()],
        sendMessage: async (input) => {
          sentInputs.push(input);
          return routeUserMessage(input, [internalMessageChannel()]);
        },
      })),
    );
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');

    const sessionMediaBytes = Buffer.from('session-media-artifact-bytes');
    await ctx.get(ISessionMediaStore).materialize({
      fileId: 'f_session_item',
      name: 'artifact.json',
      mimeType: 'application/json',
      size: sessionMediaBytes.length,
      stream: () => Readable.from([sessionMediaBytes]),
    });

    const singleRes = await execute({
      text: 'Single send with external, relative, symlinked, and file_id attachments',
      attachments: [
        { path: outsideFilePath, kind: 'image', title: '外部图片.png' },
        { path: relSubPath, title: '相对说明.txt' },
        { path: linkedFileInWorkspace, kind: 'image' },
        { file_id: 'f_session_item', title: '会话产物.json' },
      ],
    }, { turnId: 0, toolCallId: 'single-attach', signal: new AbortController().signal });

    const singleWire = JSON.parse(singleRes.output as string) as {
      delivered_to: string[];
      attachments: Array<{ blob_id: string; path: string; title?: string; mime_type?: string; size?: number; kind?: string }>;
    };
    const realOutsideFile = await realpath(outsideFilePath);
    const realRelFile = await realpath(join(cwd, relSubPath));
    expect(singleWire.delivered_to).toEqual(['user']);
    expect(singleWire.attachments).toHaveLength(4);
    expect(singleWire.attachments[0]).toMatchObject({
      path: realOutsideFile,
      title: '外部图片.png',
      mime_type: 'image/png',
      size: outsideBytes.length,
      kind: 'image',
    });
    expect(singleWire.attachments[1]).toMatchObject({
      path: realRelFile,
      title: '相对说明.txt',
      mime_type: 'text/plain',
      size: relBytes.length,
      kind: 'file',
    });
    expect(singleWire.attachments[2]).toMatchObject({
      path: realOutsideFile,
      mime_type: 'image/png',
      size: outsideBytes.length,
      kind: 'image',
    });
    expect(singleWire.attachments[2]?.blob_id).toBe(singleWire.attachments[0]?.blob_id);
    expect(singleWire.attachments[3]).toMatchObject({
      title: '会话产物.json',
      mime_type: 'application/json',
      size: sessionMediaBytes.length,
      kind: 'file',
    });

    const blobs = ctx.get(IBlobStore);
    const blobScope = ctx.get(IAgentScopeContext).scope('blobs');
    const readBlob = async (blobId: string): Promise<Uint8Array | undefined> => {
      const hash = blobId.split(':').at(-1)!;
      return blobs.get(blobScope, hash);
    };
    expect(Buffer.from((await readBlob(singleWire.attachments[0]!.blob_id))!)).toEqual(outsideBytes);
    expect(Buffer.from((await readBlob(singleWire.attachments[1]!.blob_id))!)).toEqual(relBytes);
    expect(Buffer.from((await readBlob(singleWire.attachments[3]!.blob_id))!)).toEqual(sessionMediaBytes);
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]?.attachments).toHaveLength(4);

    const batchRes = await execute({
      messages: [
        { text: 'Batch item 0', attachments: [{ path: batchOutsideFilePath, title: '报告.md' }] },
        { text: 'Batch item 1', attachments: [{ path: '子目录 附件/说明 文档.txt' }, { file_id: 'f_session_item' }] },
      ],
      end_turn: true,
    }, { turnId: 0, toolCallId: 'batch-attach', signal: new AbortController().signal });
    const batchWire = JSON.parse(batchRes.output as string) as {
      messages: Array<{ index: number; delivery: string; attachments: Array<{ blob_id: string; path: string; size: number; mime_type: string }> }>;
    };
    expect(batchWire.messages).toHaveLength(2);
    expect(batchWire.messages[0]?.attachments[0]).toMatchObject({
      path: await realpath(batchOutsideFilePath),
      mime_type: 'text/markdown',
      size: batchOutsideBytes.length,
    });
    expect(Buffer.from((await readBlob(batchWire.messages[0]!.attachments[0]!.blob_id))!)).toEqual(batchOutsideBytes);
    expect(batchWire.messages[1]?.attachments).toHaveLength(2);
    expect(Buffer.from((await readBlob(batchWire.messages[1]!.attachments[0]!.blob_id))!)).toEqual(relBytes);
    expect(Buffer.from((await readBlob(batchWire.messages[1]!.attachments[1]!.blob_id))!)).toEqual(sessionMediaBytes);
    expect(batchRes.stopTurn).toBe(true);

    const missingPathExec = await ctx.get(ISendMessageTool).resolveExecution({
      attachments: [{ path: join(outsideDir, 'does-not-exist.png') }],
    });
    if (!('execute' in missingPathExec)) throw new Error('Expected an executable tool.');
    await expect(missingPathExec.execute({ turnId: 0, toolCallId: 'missing-path', signal: new AbortController().signal }))
      .rejects.toThrow('Attachment path does not exist:');

    const dirPathExec = await ctx.get(ISendMessageTool).resolveExecution({
      attachments: [{ path: outsideSubDir }],
    });
    if (!('execute' in dirPathExec)) throw new Error('Expected an executable tool.');
    await expect(dirPathExec.execute({ turnId: 0, toolCallId: 'dir-path', signal: new AbortController().signal }))
      .rejects.toThrow('Attachment is not a file:');
  });

  it('declares every path attachment as a file read so manual mode asks for secrets and links while yolo sends any path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'send-message-admit-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'send-message-admit-outside-'));
    dirs.push(cwd, outsideDir);
    await writeFile(join(cwd, 'notes.txt'), 'notes');
    await writeFile(join(cwd, '.env'), 'TOKEN=example');
    await writeFile(join(outsideDir, 'report.txt'), 'report');
    await mkdir(join(cwd, '.git'));
    await writeFile(join(cwd, '.git', 'config'), '[core]\n');
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(outsideDir, join(cwd, 'linked'), directoryLink);
    await symlink(join(cwd, '.git'), join(cwd, 'repo-info'), directoryLink);
    const realCwd = await realpath(cwd);
    const realOutside = await realpath(outsideDir);
    ctx = createTestAgent({ cwd }, permissionModeServices('manual'));
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    await ctx.get(ISessionMediaStore).materialize({
      fileId: 'f_admit', name: 'a.txt', mimeType: 'text/plain', size: 1, stream: () => Readable.from([Buffer.from('a')]),
    });
    const decide = async (input: Parameters<ISendMessageTool['resolveExecution']>[0]) => {
      const execution = await ctx.get(ISendMessageTool).resolveExecution(input);
      if (!('execute' in execution)) throw new Error('Expected an executable tool.');
      const toolCall = { type: 'function' as const, id: 'admit', name: 'SendMessage', arguments: JSON.stringify(input) };
      const evaluation = await ctx.get(IAgentPermissionPolicyService).evaluate({
        turnId: 0, signal: new AbortController().signal, toolCall, toolCalls: [toolCall], args: input, execution,
      });
      return { execution, policy: evaluation?.policyName, kind: evaluation?.result.kind };
    };

    const plain = await decide({ text: 'no attachment', attachments: [{ file_id: 'f_admit' }] });
    expect(plain.execution.accesses).toBeUndefined();
    expect(plain.policy).toBe('fallback-ask');

    const workspaceFile = await decide({ attachments: [{ path: 'notes.txt' }] });
    expect(workspaceFile.execution.accesses).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', operation: 'read', path: join(realCwd, 'notes.txt').replaceAll('\\', '/') })]));
    expect(workspaceFile.execution.description).toContain(join(realCwd, 'notes.txt').replaceAll('\\', '/'));
    expect(workspaceFile).toMatchObject({ policy: 'fallback-ask', kind: 'ask' });

    expect(await decide({ attachments: [{ path: join(outsideDir, 'report.txt') }] })).toMatchObject({ policy: 'fallback-ask', kind: 'ask' });
    expect(await decide({ attachments: [{ path: '.env' }] })).toMatchObject({ policy: 'sensitive-file-access-ask', kind: 'ask' });
    expect(await decide({ attachments: [{ path: 'linked/report.txt' }] })).toMatchObject({ policy: 'external-link-access-ask', kind: 'ask' });

    const batch = await decide({ messages: [{ text: 'first', attachments: [{ path: 'notes.txt' }] }, { text: 'second', attachments: [{ file_id: 'f_admit' }, { path: '.env' }] }] });
    expect(batch.execution.accesses?.filter((access) => access.kind === 'file').map((access) => access.kind === 'file' ? access.path : '')).toEqual(['notes.txt', '.env'].map((name) => join(realCwd, name).replaceAll('\\', '/')));
    expect(batch).toMatchObject({ policy: 'sensitive-file-access-ask', kind: 'ask' });

    ctx.get(IAgentPermissionRulesService).recordApprovalResult({
      turnId: 0, toolCallId: 'ordinary-send', toolName: 'SendMessage', action: 'Sending a message',
      sessionApprovalRule: 'SendMessage', result: { decision: 'approved', scope: 'session' },
    });
    const repositoryFile = await decide({ attachments: [{ path: 'notes.txt' }, { path: 'repo-info/config' }] });
    expect(repositoryFile.execution.accesses).toContainEqual(expect.objectContaining({
      kind: 'file', operation: 'read', path: join(realCwd, '.git', 'config').replaceAll('\\', '/'), implicitExternal: false,
    }));
    expect(repositoryFile).toMatchObject({ policy: 'git-control-path-access-ask', kind: 'ask' });

    ctx.get(IAgentPermissionModeService).setMode('yolo');
    expect(await decide({ attachments: [{ path: '.env' }, { path: 'linked/report.txt' }, { path: join(realOutside, 'report.txt') }] })).toMatchObject({ policy: 'yolo-mode-approve', kind: 'approve' });
  });

  it('sends an ordered batch through one SendMessage execution and preserves media channel facts', async () => {
    const send = vi.fn(async (input: Parameters<IUserMessageRouter['sendMessage']>[0]): Promise<SendMessageReceipt> => ({
      messageId: `send:${input.toolCallId}`,
      deliveredTo: input.toolCallId.endsWith(':item:1') ? ['user'] : [],
      delivery: input.toolCallId.endsWith(':item:1') ? 'delivered' : 'pending',
      attachments: input.attachments,
      channels: [{ channelId: input.channels?.[0] ?? 'internal', status: input.toolCallId.endsWith(':item:1') ? 'partial' : 'unknown' }],
    }));
    await mediaAgent(['clip.mp4'], appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    const result = await execute({
      to: 'user', channels: ['notify:fixture'],
      messages: [{ text: 'first', attachments: [{ path: 'clip.mp4', kind: 'audio', mime_type: 'audio/mpeg' }] }, { text: 'second', reply_to: 'message-1' }],
    });
    const wire = JSON.parse(result.output as string);
    expect(wire.messages).toHaveLength(2);
    expect(wire.messages[0]).toMatchObject({ index: 0, message_id: 'send:send-1:item:0', delivery: 'pending', channels: [{ status: 'unknown' }], attachments: [{ kind: 'audio' }] });
    expect(wire.messages[1]).toMatchObject({ index: 1, message_id: 'send:send-1:item:1', delivery: 'delivered', channels: [{ status: 'partial' }] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([input]) => input.toolCallId)).toEqual(['send-1:item:0', 'send-1:item:1']);
    expect(send.mock.calls[0]?.[0].attachments).toEqual([expect.objectContaining({ kind: 'audio', mimeType: 'audio/mpeg' })]);
    expect(send.mock.calls[1]?.[0].replyTo).toBe('message-1');
    expect(result.note).toContain('Do not resend automatically');
    expect(result.note).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
  });

  it('stops unlaunched batch items on cancellation without resending the delivered first item', async () => {
    const controller = new AbortController();
    const send = vi.fn(async (input: Parameters<IUserMessageRouter['sendMessage']>[0]): Promise<SendMessageReceipt> => {
      controller.abort();
      return { messageId: `send:${input.toolCallId}`, deliveredTo: ['user'], delivery: 'delivered' };
    });
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    const result = await execute({ messages: [{ text: 'first' }, { text: 'second' }, { text: 'third' }] }, { turnId: 0, toolCallId: 'batch-1', signal: controller.signal });
    const wire = JSON.parse(result.output as string);
    expect(wire.messages).toHaveLength(3);
    expect(wire.messages[0]).toMatchObject({ index: 0, message_id: 'send:batch-1:item:0', delivery: 'delivered' });
    expect(wire.messages.slice(1)).toEqual([
      expect.objectContaining({ index: 1, message_id: 'send:batch-1:item:1', delivery: 'cancelled' }),
      expect.objectContaining({ index: 2, message_id: 'send:batch-1:item:2', delivery: 'cancelled' }),
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a blank message that carries neither text nor attachments', async () => {
    await messageAgent();
    const execution = await ctx.get(ISendMessageTool).resolveExecution({ text: '   ' });
    if (!('execute' in execution)) throw new Error('Expected an executable tool.');
    await expect(execution.execute({ turnId: 0, toolCallId: 'blank', signal: new AbortController().signal }))
      .rejects.toThrow('A message cannot be blank.');
  });

  it('refuses to treat an opaque media kind as a plain file', async () => {
    await mediaAgent(['clip.mp4']);
    const execution = await ctx.get(ISendMessageTool).resolveExecution({ attachments: [{ path: 'clip.mp4', kind: 'hologram' }] });
    if (!('execute' in execution)) throw new Error('Expected an executable tool.');
    await expect(execution.execute({ turnId: 0, toolCallId: 'hologram', signal: new AbortController().signal }))
      .rejects.toThrow('media_unsupported');
  });

  it('keeps the full ordinary fallback and conditional completion contract in the real tool description', async () => {
    await messageAgent();
    const tool = ctx.get(ISendMessageTool);
    expect(tool.description).not.toContain('Ordinary assistant text is not delivered');
    expect(tool.description).toContain('A final ordinary reply is delivered in full as a fallback');
    expect(tool.description).toContain('if the request is complete and no work remains');
    expect(tool.description).toContain('Do not split one message into sentences');
    expect(tool.description).toContain('set end_turn=true');
    expect(tool.parameters).toMatchObject({ properties: { end_turn: { type: 'boolean' } } });
    const result = await execute({ text: 'The complete answer.' });
    expect(JSON.parse(result.output as string)).toMatchObject({ delivered_to: ['user'] });
    expect(result.note).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
    expect(result.stopTurn).toBeUndefined();
  });

  it('lets a fake provider end without a closing message after receiving the successful delivery guidance', async () => {
    await messageAgent();
    ctx.mockNextResponse({ type: 'function', id: 'send-1', name: 'SendMessage', arguments: '{"text":"The complete answer."}' });
    ctx.mockNextResponse();
    const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] });
    expect(result.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(historyText(1)).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
    expect(sendCalls()).toEqual(['send-1']);
    expect(ctx.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
    expect(historyText(1)).not.toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
    await ctx.expectResumeMatches();
  });

  it('ends after one delivered final SendMessage without an empty model continuation', async () => {
    await messageAgent();
    ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"The complete answer.","end_turn":true}' });
    ctx.mockNextResponse({ type: 'text', text: 'Unexpected continuation' });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
    expect(sendCalls()).toEqual(['send-final']);
    expect(ctx.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
    await ctx.expectResumeMatches();
  });

  it('ends a final SendMessage batch under implicit bound-output fan-out when each item reaches at least one channel without triggering StopFailure', async () => {
    const stopFailureHook: HookDef = {
      event: 'StopFailure',
      command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { recovery: { action: "continue", userMessage: "继续" } } }));'),
      timeout: 5,
    };
    const runner = makeHookRunner([stopFailureHook]);
    const trigger = vi.spyOn(runner, 'trigger');
    const channels: UserMessageChannel[] = [
      internalMessageChannel(),
      {
        id: 'im:tg-1',
        kind: 'im',
        bound: true,
        enabled: true,
        capabilities: [{ kind: 'file' }, { kind: 'voice', mimeTypes: ['audio/ogg'] }],
        send: async () => ({ status: 'delivered', messageIds: ['tg-m1'] }),
      },
      {
        id: 'im:wx-1',
        kind: 'im',
        bound: true,
        enabled: true,
        capabilities: [{ kind: 'file' }],
        send: async () => ({ status: 'delivered', messageIds: ['wx-m1'] }),
      },
      {
        id: 'im:fs-offline',
        kind: 'im',
        bound: true,
        enabled: true,
        capabilities: [{ kind: 'file' }],
        send: async () => ({ status: 'failed', detail: 'offline_peer' }),
      },
      {
        id: 'im:legacy-voice',
        kind: 'im',
        bound: true,
        enabled: true,
        capabilities: [{ kind: 'file' }],
        send: async () => ({ status: 'failed', unsupported: ['voice'], detail: 'unsupported_voice' }),
      },
    ];
    try {
      await messageAgent(
        externalHookServices(runner),
        appServices((reg) => reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => channels,
          sendMessage: async (input) => routeUserMessage(input, channels),
        })),
      );
      ctx.mockNextResponse({
        type: 'function',
        id: 'send-fanout-batch',
        name: 'SendMessage',
        arguments: JSON.stringify({
          end_turn: true,
          messages: [
            { text: 'First final batch item.' },
            { text: 'Second final batch item.' },
          ],
        }),
      });
      ctx.mockNextProviderResponse({
        parts: [],
        error: markProviderEventError(new ChatProviderError('Upstream closed without a terminal event'), 'antigravity_missing_terminal'),
      });
      const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Send the final batch.' }] });
      expect(result.state).toBe('completed');
      expect(ctx.llmCalls).toHaveLength(1);
      expect(trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(0);
      expect(ctx.contextData().history.filter((msg) => msg.origin?.kind === 'system_trigger')).toEqual([]);
      const toolResultMsg = ctx.contextData().history.find((msg) => msg.role === 'tool' && msg.toolCallId === 'send-fanout-batch');
      const wire = JSON.parse(
        toolResultMsg!.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      ) as { messages: Array<{ delivered_to: string[]; channels: Array<{ channel_id: string; status: string; unsupported?: string[] }> }> };
      expect(wire.messages).toHaveLength(2);
      for (const item of wire.messages) {
        expect(item.delivered_to).toContain('user');
        expect(item.channels.filter((ch) => ch.status === 'delivered')).toHaveLength(3);
        expect(item.channels).toEqual(expect.arrayContaining([
          expect.objectContaining({ channel_id: 'internal', status: 'delivered' }),
          expect.objectContaining({ channel_id: 'im:tg-1', status: 'delivered' }),
          expect.objectContaining({ channel_id: 'im:wx-1', status: 'delivered' }),
          expect.objectContaining({ channel_id: 'im:fs-offline', status: 'failed', detail: 'offline_peer' }),
          expect.objectContaining({ channel_id: 'im:legacy-voice', status: 'failed', unsupported: ['voice'] }),
        ]));
      }
      await ctx.expectResumeMatches();
    } finally {
      await runner.dispose();
    }
  });

  it('ends after multiple same-step SendMessage calls when all are confirmed delivered and at least one sets end_turn=true without triggering StopFailure', async () => {
    const stopFailureHook: HookDef = {
      event: 'StopFailure',
      command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { recovery: { action: "continue", userMessage: "继续" } } }));'),
      timeout: 5,
    };
    const runner = makeHookRunner([stopFailureHook]);
    const trigger = vi.spyOn(runner, 'trigger');
    try {
      await messageAgent(externalHookServices(runner));
      ctx.mockNextResponse(
        { type: 'function', id: 'send-part-1', name: 'SendMessage', arguments: '{"text":"First delivered message."}' },
        { type: 'function', id: 'send-part-2', name: 'SendMessage', arguments: '{"text":"Second delivered message.","end_turn":true}' },
      );
      ctx.mockNextProviderResponse({
        parts: [],
        error: markProviderEventError(new ChatProviderError('Upstream closed without a terminal event'), 'antigravity_missing_terminal'),
      });
      const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Send two messages.' }] });
      expect(result.state).toBe('completed');
      expect(ctx.llmCalls).toHaveLength(1);
      expect(sendCalls()).toEqual(['send-part-1', 'send-part-2']);
      expect(trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(0);
      expect(ctx.contextData().history.filter((msg) => msg.origin?.kind === 'system_trigger')).toEqual([]);
      await ctx.expectResumeMatches();
    } finally {
      await runner.dispose();
    }
  });

  it('ends when a 32-item SendMessage batch receipt is spilled and truncated alongside a sibling end_turn=true SendMessage without triggering StopFailure', async () => {
    const stopFailureHook: HookDef = {
      event: 'StopFailure',
      command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { recovery: { action: "continue", userMessage: "继续" } } }));'),
      timeout: 5,
    };
    const runner = makeHookRunner([stopFailureHook]);
    const trigger = vi.spyOn(runner, 'trigger');
    const channels: UserMessageChannel[] = [
      internalMessageChannel(),
      ...Array.from({ length: 12 }, (_, idx): UserMessageChannel => ({
        id: `im:bound-channel-${idx}`,
        kind: 'im',
        bound: true,
        enabled: true,
        capabilities: [{ kind: 'file' }],
        send: async ({ toolCallId }) => ({
          status: idx < 10 ? 'delivered' : 'failed',
          messageIds: idx < 10 ? [`msg-${toolCallId}-ch-${idx}-${'x'.repeat(80)}`] : undefined,
          detail: idx < 10 ? `delivered-receipt-${'d'.repeat(80)}` : `offline-peer-${'f'.repeat(80)}`,
        }),
      })),
    ];
    try {
      await messageAgent(
        externalHookServices(runner),
        appServices((reg) => reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => channels,
          sendMessage: async (input) => routeUserMessage(input, channels),
        })),
      );
      const batchItems = Array.from({ length: 32 }, (_, idx) => ({
        text: `Batch item ${idx + 1}`,
      }));
      ctx.mockNextResponse(
        {
          type: 'function',
          id: 'send-large-batch',
          name: 'SendMessage',
          arguments: JSON.stringify({ messages: batchItems }),
        },
        {
          type: 'function',
          id: 'send-final-sibling',
          name: 'SendMessage',
          arguments: JSON.stringify({ text: 'All 32 items and closing note sent.', end_turn: true }),
        },
      );
      ctx.mockNextProviderResponse({
        parts: [],
        error: markProviderEventError(new ChatProviderError('Upstream closed without a terminal event'), 'antigravity_missing_terminal'),
      });
      const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Send 32 items and final note.' }] });
      expect(result.state).toBe('completed');
      expect(ctx.llmCalls).toHaveLength(1);
      expect(sendCalls()).toEqual(['send-large-batch', 'send-final-sibling']);
      expect(trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(0);
      expect(ctx.contextData().history.filter((msg) => msg.origin?.kind === 'system_trigger')).toEqual([]);
      const largeBatchToolMsg = ctx.contextData().history.find((msg) => msg.role === 'tool' && msg.toolCallId === 'send-large-batch');
      const largeBatchText = largeBatchToolMsg!.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      expect(largeBatchText).toContain('output_path:');
      expect(() => JSON.parse(largeBatchText)).toThrow();
      await ctx.expectResumeMatches();
    } finally {
      await runner.dispose();
    }
  });

  it('continues when a same-step sibling SendMessage is not confirmed even if another SendMessage sets end_turn=true', async () => {
    const send = vi.fn(async (input: Parameters<IUserMessageRouter['sendMessage']>[0]): Promise<SendMessageReceipt> => ({
      messageId: `send:${input.toolCallId}`,
      deliveredTo: ['user'],
      delivery: 'delivered',
      channels: [{
        channelId: 'im:primary',
        status: input.toolCallId === 'send-ok' ? 'delivered' : 'unknown',
      }],
    }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
    ctx.mockNextResponse(
      { type: 'function', id: 'send-ok', name: 'SendMessage', arguments: '{"text":"Confirmed part.","end_turn":true}' },
      { type: 'function', id: 'send-unconfirmed', name: 'SendMessage', arguments: '{"text":"Uncertain part."}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Inspecting uncertain sibling delivery.' });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Send both parts.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(historyText(1)).toContain('Do not resend automatically');
  });

  it('completes end_turn under implicit fan-out when at least one channel is delivered despite a secondary unknown channel, while keeping continuation when no channel delivered or explicit targets are not all delivered', async () => {
    let mode: 'implicit-delivered-and-unknown' | 'implicit-only-unknown' | 'explicit-partial' | 'explicit-unknown' = 'implicit-delivered-and-unknown';
    const send = vi.fn(async (input: Parameters<IUserMessageRouter['sendMessage']>[0]): Promise<SendMessageReceipt> => ({
      messageId: `send:${input.toolCallId}`,
      deliveredTo: ['user'],
      delivery: 'delivered',
      channels: mode === 'implicit-delivered-and-unknown'
        ? [
            { channelId: 'internal', status: 'delivered' },
            { channelId: 'im:feishu', status: 'delivered', messageIds: ['fs-1'] },
            { channelId: 'im:timeout', status: 'unknown', detail: 'transport_timeout' },
          ]
        : mode === 'implicit-only-unknown'
          ? [
              { channelId: 'im:timeout', status: 'unknown', detail: 'transport_timeout' },
            ]
          : mode === 'explicit-partial'
            ? [
                { channelId: 'internal', status: 'delivered' },
                { channelId: 'im:wx', status: 'partial', unsupported: ['voice'] },
              ]
            : [
                { channelId: 'internal', status: 'delivered' },
                { channelId: 'im:timeout', status: 'unknown', detail: 'transport_timeout' },
              ],
    }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));

    expect((await execute({ text: 'Implicit fan-out with secondary unknown.', end_turn: true })).stopTurn).toBe(true);
    ctx.mockNextResponse({ type: 'function', id: 'send-implicit-delivered-unknown', name: 'SendMessage', arguments: '{"text":"Implicit fan-out with secondary unknown.","end_turn":true}' });
    ctx.mockNextProviderResponse({
      parts: [],
      error: markProviderEventError(new ChatProviderError('Upstream completed without a usable answer.'), 'antigravity_empty_response'),
    });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Reply.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);

    mode = 'implicit-only-unknown';
    expect((await execute({ text: 'Uncertain implicit fan-out.', end_turn: true })).stopTurn).toBeUndefined();

    mode = 'explicit-partial';
    expect((await execute({ text: 'Explicit channels.', channels: ['internal', 'im:wx'], end_turn: true })).stopTurn).toBeUndefined();

    mode = 'explicit-unknown';
    expect((await execute({ text: 'Explicit channels with unknown.', channels: ['internal', 'im:timeout'], end_turn: true })).stopTurn).toBeUndefined();
  });

  it('skips tool continuation when SendMessage(end_turn=true) is paired with a successful TodoList update, but continues if TodoList errors', async () => {
    await messageAgent();
    ctx.mockNextResponse(
      { type: 'function', id: 'todo-1', name: 'TodoList', arguments: JSON.stringify({ todos: [{ title: 'Ship SendMessage fix', status: 'done' }] }) },
      { type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"All wrapped up.","end_turn":true}' },
    );
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Finish and reply.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);

    ctx.mockNextResponse(
      { type: 'function', id: 'todo-bad', name: 'TodoList', arguments: JSON.stringify({ notes: { next: 'x'.repeat(2000) } }) },
      { type: 'function', id: 'send-after-bad-todo', name: 'SendMessage', arguments: '{"text":"Attempted wrap up.","end_turn":true}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Handled TodoList validation error.' });
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Try invalid note.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('converges an antigravity_empty_response post-delivery continuation to completed when SendMessage omitted end_turn', async () => {
    await messageAgent();
    ctx.mockNextResponse({ type: 'function', id: 'send-without-flag', name: 'SendMessage', arguments: '{"text":"Delivered without end_turn."}' });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: '', encrypted: 'sig-empty-post-delivery' }],
      error: markProviderEventError(new ChatProviderError('Upstream completed without a usable answer.'), 'antigravity_empty_response'),
    });
    const outcome = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Say hello.' }] });
    expect(outcome.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    await ctx.expectResumeMatches();
  });

  it('still fails antigravity_empty_response when no SendMessage user delivery was confirmed in the turn', async () => {
    await messageAgent();
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: '', encrypted: 'sig-empty-no-delivery' }],
      error: markProviderEventError(new ChatProviderError('Upstream completed without a usable answer.'), 'antigravity_empty_response'),
    });
    const outcome = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Say hello.' }] });
    expect(outcome.state).toBe('failed');
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('keeps sibling tool results available to the model even when SendMessage requests completion', async () => {
    await messageAgent();
    const registration = ctx.get(IAgentToolRegistryService).register({
      name: 'RequiredWork', description: 'Finish required work.', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'RequiredWork', execute: async () => ({ output: 'Inspect this result.' }) }),
    });
    try {
      ctx.mockNextResponse(
        { type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"The current answer.","end_turn":true}' },
        { type: 'function', id: 'work-1', name: 'RequiredWork', arguments: '{}' },
      );
      ctx.mockNextResponse({ type: 'text', text: 'Result inspected.' });
      expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Check the work.' }] })).state).toBe('completed');
      expect(ctx.llmCalls).toHaveLength(2);
      expect(historyText(1)).toContain('Inspect this result.');
    } finally {
      await registration.dispose();
    }
  });

  it('continues same-step and later tool work after a progress message', async () => {
    await messageAgent();
    const work = vi.fn(async () => ({ output: 'Work finished.' }));
    const registration = ctx.get(IAgentToolRegistryService).register({
      name: 'RequiredWork', description: 'Finish required work.', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'RequiredWork', execute: work }),
    });
    try {
      ctx.mockNextResponse(
        { type: 'function', id: 'send-progress', name: 'SendMessage', arguments: '{"text":"I am checking the result."}' },
        { type: 'function', id: 'work-1', name: 'RequiredWork', arguments: '{}' },
      );
      ctx.mockNextResponse({ type: 'function', id: 'work-2', name: 'RequiredWork', arguments: '{}' });
      ctx.mockNextResponse();
      expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Check and finish the work.' }] })).state).toBe('completed');
      expect(work).toHaveBeenCalledTimes(2);
      expect(ctx.llmCalls).toHaveLength(3);
      expect(historyText(1)).toContain('If this was a progress update and work remains, continue');
      expect(sendCalls()).toEqual(['send-progress']);
    } finally {
      await registration.dispose();
    }
  });

  it.each(['queue', 'steer'] as const)('preserves %s input after final delivery', async (kind) => {
    await messageAgent();
    const loop = ctx.get(IAgentLoopService);
    const prompts = ctx.get(IAgentPromptService);
    let pendingCompletion: Promise<unknown> | undefined;
    const pending = loop.hooks.onDidAppendToolResult.register('pending-user-input', async (event, next) => {
      await next();
      if (event.toolCallId !== 'send-final') return;
      const handle = await prompts.enqueue({
        message: { role: 'user', content: [{ type: 'text', text: 'Inspect the new input.' }], toolCalls: [], origin: { kind: 'user' } },
        waitForLaunch: false,
      });
      pendingCompletion = kind === 'steer'
        ? Promise.all([handle.completion, prompts.steer([handle.id])])
        : handle.completion;
    });
    try {
      ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"Current answer delivered.","end_turn":true}' });
      ctx.mockNextResponse({ type: 'text', text: 'New input inspected.' });
      expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Give the current answer.' }] })).state).toBe('completed');
      await pendingCompletion;
      await loop.settled();
      expect(ctx.llmCalls).toHaveLength(2);
      expect(historyText(1)).toContain('Inspect the new input.');
      expect(prompts.list().pending).toEqual([]);
    } finally {
      await pending.dispose();
    }
  });

  it('preserves active goal follow-up after final delivery', async () => {
    await messageAgent();
    const loop = ctx.get(IAgentLoopService);
    const goals = ctx.get(IAgentGoalService);
    let afterSteps = 0;
    const createGoal = loop.hooks.onDidAppendToolResult.register('start-goal-on-delivery', async (event, next) => {
      await next();
      if (event.toolCallId === 'send-final') await goals.createGoal({ objective: 'Inspect remaining goal work' });
    });
    const afterStep = loop.hooks.onDidFinishStep.register('observe-final-delivery-goal', async (_event, next) => {
      afterSteps += 1;
      await next();
    });
    const followup = loop.hooks.onWillBeginStep.register('finish-goal-followup', async (event, next) => {
      if (event.turnId !== 0) {
        expect(goals.getGoal().goal?.status).toBe('active');
        await goals.markComplete();
      }
      await next();
    });
    try {
      ctx.mockNextResponse({ type: 'function', id: 'send-final', name: 'SendMessage', arguments: '{"text":"Current answer delivered.","end_turn":true}' });
      ctx.mockNextResponse({ type: 'text', text: 'Remaining goal work inspected.' });
      expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Give the current answer.' }] })).state).toBe('completed');
      await loop.settled();
      expect(ctx.llmCalls).toHaveLength(2);
      expect(afterSteps).toBe(2);
      expect(goals.getGoal().goal).toBeNull();
    } finally {
      await followup.dispose();
      await afterStep.dispose();
      await createGoal.dispose();
    }
  });

  it('preserves a pending background notification after successful delivery', async () => {
    await messageAgent();
    const loop = ctx.get(IAgentLoopService);
    const pending = loop.hooks.onDidAppendToolResult.register('pending-task-notification', async (event, next) => {
      await next();
      if (event.toolCallId !== 'send-1') return;
      loop.enqueue(new TaskNotificationStepRequest({
        role: 'user', content: [{ type: 'text', text: 'Background work finished; inspect the result.' }], toolCalls: [],
        origin: { kind: 'task', taskId: 'task-1', status: 'completed', notificationId: 'notification-1' },
      }));
    });
    try {
      ctx.mockNextResponse({ type: 'function', id: 'send-1', name: 'SendMessage', arguments: '{"text":"Current answer delivered.","end_turn":true}' });
      ctx.mockNextResponse({ type: 'text', text: 'Background result inspected.' });
      const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Give the current answer.' }] });
      expect(result).toMatchObject({ state: 'completed' });
      expect(ctx.llmCalls).toHaveLength(2);
      expect(historyText(1)).toContain('Background work finished; inspect the result.');
      expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
    } finally {
      await pending.dispose();
    }
  });

  it('leaves a failed send recoverable instead of treating it as completion', async () => {
    await messageAgent();
    ctx.mockNextResponse({ type: 'function', id: 'failed-send', name: 'SendMessage', arguments: '{"text":" ","to":"user","end_turn":true}' });
    ctx.mockNextResponse({ type: 'function', id: 'retry-send', name: 'SendMessage', arguments: '{"text":"The complete answer."}' });
    ctx.mockNextResponse();
    expect((await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Answer the question.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(3);
    expect(historyText(1)).toContain('A message cannot be blank.');
    expect(historyText(1)).not.toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
    expect(historyText(2)).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
    expect(sendCalls()).toEqual(['failed-send', 'retry-send']);
  });

  it.each([
    { deliveredTo: ['room'], delivery: 'delivered' as const },
    { deliveredTo: [], delivery: 'undeliverable' as const },
    { deliveredTo: ['user'], delivery: 'pending' as const },
  ])('does not claim user completion for room receipt %j', async (receipt) => {
    const post = vi.fn(async (): Promise<SendMessageReceipt> => ({ messageId: 'room-message-1', ...receipt }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IRoomMessageRouter, { postBotMessage: post })));
    await ctx.get(ISessionMetadata).update({ custom: { room_member_of: 'room-1' } });
    const result = await execute({ text: 'Room update.', to: '@helper' });
    expect(post).toHaveBeenCalledOnce();
    expect(JSON.parse(result.output as string)).toMatchObject({ delivered_to: receipt.deliveredTo, delivery: receipt.delivery });
    expect(result.note).toBeUndefined();
    expect(result.stopTurn).toBeUndefined();
  });

  it('preserves directed Bot handoff and its pending receipt without user-completion guidance', async () => {
    const handoff = vi.fn(async (): Promise<SendMessageReceipt> => ({ messageId: 'handoff-1', deliveredTo: ['@helper'], delivery: 'pending' }));
    await messageAgent(appServices((reg) => reg.definePartialInstance(IBotService, { sendHandoff: handoff })));
    const result = await execute({ text: 'Please inspect the result.', to: '@helper', reply_to: 'message-1' });
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ target: '@helper', replyTo: 'message-1', idempotencyKey: 'send-1' }));
    expect(JSON.parse(result.output as string)).toMatchObject({ delivered_to: ['@helper'], delivery: 'pending' });
    expect(result.note).toBeUndefined();
    expect(result.stopTurn).toBeUndefined();
  });
});

it('uses the host router through its live DI binding and preserves uncertain wire receipts', async () => {
  const send = vi.fn(async (): Promise<SendMessageReceipt> => ({
    messageId: 'send:send-1', deliveredTo: [], delivery: 'pending',
    channels: [{ channelId: 'im:binding', status: 'unknown', detail: 'transport_timeout' }],
  }));
  await messageAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
  const result = await execute({ text: 'Host routed text.' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Host routed text.', toolCallId: 'send-1' }));
  expect(JSON.parse(result.output as string)).toMatchObject({ delivered_to: [], delivery: 'pending', channels: [{ channel_id: 'im:binding', status: 'unknown' }] });
  expect(result.note).toContain('Do not resend automatically');
  expect(result.note).not.toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
  expect(result.stopTurn).toBeUndefined();
});


it('hot-enables a plain reply thread, executes named outputs, and withdraws the tool without changing reply mode', async () => {
  const send = vi.fn(async (): Promise<SendMessageReceipt> => ({
    messageId: 'send:send-1', deliveredTo: ['user'], delivery: 'delivered',
    channels: [{ channelId: 'notify:updates', status: 'partial', borrowed: true, unsupported: ['voice'] }],
  }));
  ctx = createTestAgent(appServices((reg) => reg.definePartialInstance(IUserMessageRouter, { sendMessage: send })));
  const delivery = ctx.get(ISessionDeliveryService);
  await delivery.ready;
  expect(delivery.effectiveMode()).toBe('reply');
  const capability = ctx.get(IOptionalCapabilityPolicy);
  const session = ctx.get(ISessionContext);
  await capability.load(session.sessionId);
  const registry = ctx.get(IAgentToolRegistryService);
  await registry.prepare();
  expect(registry.resolve('SendMessage')).toBeUndefined();
  expect(await execute({ text: 'blocked' })).toMatchObject({ isError: true });
  await capability.setChoice(session.sessionId, 'send_message', 'on');
  await registry.prepare();
  expect(registry.resolve('SendMessage')).toBeDefined();
  const result = await execute({ text: 'Thread update', to: 'user', channels: ['notify:updates'] });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ channels: ['notify:updates'], text: 'Thread update' }));
  expect(JSON.parse(result.output as string).channels).toEqual([{ channel_id: 'notify:updates', status: 'partial', borrowed: true, unsupported: ['voice'] }]);
  await capability.setChoice(session.sessionId, 'send_message', 'off');
  await registry.prepare();
  expect(registry.resolve('SendMessage')).toBeUndefined();
  expect(await execute({ text: 'blocked again' })).toMatchObject({ isError: true });
  expect(delivery.effectiveMode()).toBe('reply');
  expect(send).toHaveBeenCalledOnce();
});

describe('SendMessage native TTS synthesis and voice routing', () => {
  const validOggBytes = new Uint8Array([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
    0x01, 0x13,
    0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
    0x01, 0x01, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const oggVorbisBytes = new Uint8Array([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd,
    0x01, 0x1e,
    0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x80, 0xbb, 0x00, 0x00,
  ]);
  const rawMp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);

  function createValidSineWavBytes(sampleRate = 16_000, durationMs = 200): Uint8Array {
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const dataBytes = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000);
      buffer.writeInt16LE(sample, 44 + i * 2);
    }
    return new Uint8Array(buffer);
  }

  function mockTtsMediaService(options: {
    readonly bytes?: Uint8Array;
    readonly mime?: string;
    readonly name?: string;
    readonly providerId?: string;
    readonly voices?: readonly { id: string; name: string }[];
    readonly onStart?: (raw: MediaGenerateInput) => void;
  } = {}) {
    const bytes = options.bytes ?? validOggBytes;
    const mime = options.mime ?? 'audio/ogg';
    const name = options.name ?? 'speech.ogg';
    const providerId = options.providerId ?? 'kiki-media/minimax-speech';
    let jobSeq = 0;

    const start = vi.fn(async (raw: MediaGenerateInput): Promise<MediaJob> => {
      options.onStart?.(raw);
      const id = `media-${String(++jobSeq).padStart(32, '0')}`;
      const fileId = `f_${id}_audio`;
      await ctx.get(ISessionMediaStore).materialize({
        fileId,
        name,
        mimeType: mime,
        size: bytes.byteLength,
        stream: () => Readable.from([bytes]),
      });
      return {
        schemaVersion: 1,
        job_id: id,
        request_id: raw.request_id ?? `req-${id}`,
        owner_session_id: ctx.get(ISessionContext).sessionId,
        owner_agent_id: 'main',
        provider: raw.provider ?? providerId,
        model: raw.model ?? 'speech-2.8-hd',
        state: 'succeeded',
        phase: 'download',
        can_resume: false,
        artifacts: [
          {
            id: 'art_1',
            kind: 'audio',
            role: 'original',
            name,
            mime,
            file_id: fileId,
            bytes: bytes.byteLength,
            complete: true,
          },
        ],
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    });

    const run = vi.fn(async (id: string): Promise<MediaJob> => {
      throw new Error(`Unexpected run for already succeeded job ${id}`);
    });

    const stopLocal = vi.fn(async (id: string): Promise<MediaJob> => ({
      schemaVersion: 1,
      job_id: id,
      request_id: `req-${id}`,
      owner_session_id: 's',
      owner_agent_id: 'main',
      provider: providerId,
      state: 'stopped',
      phase: 'submit',
      can_resume: false,
      artifacts: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }));

    const providers = vi.fn(async () => [
      {
        provider: 'kiki-media/minimax-speech',
        definition: { schemaVersion: 1 as const, id: 'minimax-speech', label: 'MiniMax Speech', kinds: ['tts' as const], resumeVersion: 1 },
      },
      {
        provider: 'kiki-media/openai-speech',
        definition: { schemaVersion: 1 as const, id: 'openai-speech', label: 'OpenAI Speech', kinds: ['tts' as const], resumeVersion: 1 },
      },
      {
        provider: 'kiki-media/script-bailian-tts',
        definition: { schemaVersion: 1 as const, id: 'script-bailian-tts', label: 'Bailian TTS', kinds: ['tts' as const], resumeVersion: 1 },
      },
    ]);

    const voices = vi.fn(async (query: { provider: string }) => ({
      voices: [...(options.voices ?? (
        query.provider.includes('script-bailian-tts')
          ? [{ id: 'Chelsie', label: 'Chelsie' }, { id: 'Ethan', label: 'Ethan' }]
          : []
      ))],
    }));

    return { start, run, stopLocal, providers, voices };
  }

  it('defaults to voice_mode=none and does not call TTS unless enabled by settings or tool arguments', async () => {
    const mediaMock = mockTtsMediaService();
    await messageAgent(appServices((reg) => reg.definePartialInstance(IPluginMediaService, mediaMock)));
    const result = await execute({ text: 'Plain text message.' });
    const wire = JSON.parse(result.output as string);
    expect(mediaMock.start).not.toHaveBeenCalled();
    expect(wire.delivered_to).toEqual(['user']);
    expect(wire.attachments).toBeUndefined();
    expect(wire.voice_only).toBeUndefined();
  });

  it('honors settings default voiceMode and TTS parameters, allows per-call overrides and separate tts.text, and lets explicit none override settings', async () => {
    const startedRequests: MediaGenerateInput[] = [];
    const mediaMock = mockTtsMediaService({ onStart: (raw) => startedRequests.push(raw) });
    const sentInputs: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];
    const userRouter: IUserMessageRouter = {
      _serviceBrand: undefined,
      listChannels: async () => [internalMessageChannel()],
      sendMessage: async (input) => {
        sentInputs.push(input);
        return routeUserMessage(input, [internalMessageChannel()]);
      },
    };
    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IUserMessageRouter, userRouter);
      }),
    );

    const config = ctx.get(IConfigService);
    await config.set(SEND_MESSAGE_SECTION, {
      voiceMode: 'append',
      ttsProvider: 'minimax-speech',
      ttsVoice: 'female-shaonv',
      ttsModel: 'speech-2.8-hd',
      ttsLanguage: 'zh',
    });

    const appendRes = await execute({
      text: 'Visible summary: 42%',
      tts: { text: 'Spoken narration: forty-two percent.', voice: 'male-qn-qingse' },
      end_turn: true,
    }, { turnId: 0, toolCallId: 'tts-append-1', signal: new AbortController().signal });
    const appendWire = JSON.parse(appendRes.output as string);
    expect(startedRequests).toHaveLength(1);
    expect(startedRequests[0]).toMatchObject({
      request_id: 'send-tts:tts-append-1',
      provider: 'kiki-media/minimax-speech',
      model: 'speech-2.8-hd',
      request: {
        kind: 'tts',
        text: 'Spoken narration: forty-two percent.',
        voice: 'male-qn-qingse',
        language: 'zh',
      },
    });
    expect(startedRequests[0]?.request.kind === 'tts' ? startedRequests[0].request.format : undefined).toBeUndefined();
    expect(sentInputs[0]?.text).toBe('Visible summary: 42%');
    expect(sentInputs[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'voice', mimeType: 'audio/ogg', size: validOggBytes.byteLength }),
    ]);
    expect(appendWire.voice_only).toBeUndefined();
    expect(appendRes.stopTurn).toBe(true);

    const onlyRes = await execute({
      text: 'This text is spoken only and not sent as text.',
      voice_mode: 'only',
      tts: { provider: 'openai-speech', model: 'gpt-4o-mini-tts', voice: 'nova' },
    }, { turnId: 0, toolCallId: 'tts-only-1', signal: new AbortController().signal });
    const onlyWire = JSON.parse(onlyRes.output as string);
    expect(startedRequests).toHaveLength(2);
    expect(startedRequests[1]).toMatchObject({
      request_id: 'send-tts:tts-only-1',
      provider: 'kiki-media/openai-speech',
      model: 'gpt-4o-mini-tts',
      request: {
        kind: 'tts',
        text: 'This text is spoken only and not sent as text.',
        voice: 'nova',
      },
    });
    expect(sentInputs[1]?.text).toBe('');
    expect(sentInputs[1]?.attachments).toEqual([
      expect.objectContaining({ kind: 'voice', mimeType: 'audio/ogg' }),
    ]);
    expect(onlyWire.voice_only).toBe(true);

    await execute({
      text: 'Explicitly no voice for this message.',
      voice_mode: 'none',
    }, { turnId: 0, toolCallId: 'tts-none-1', signal: new AbortController().signal });
    expect(startedRequests).toHaveLength(2);
    expect(sentInputs[2]?.text).toBe('Explicitly no voice for this message.');
    expect(sentInputs[2]?.attachments).toEqual([]);
  });

  it('resolves unoverridden voice from provider voices() catalog without forcing format=opus onto custom script providers', async () => {
    const startedRequests: MediaGenerateInput[] = [];
    const mediaMock = mockTtsMediaService({
      providerId: 'kiki-media/script-bailian-tts',
      onStart: (raw) => startedRequests.push(raw),
    });
    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
      }),
    );

    await execute({
      text: 'Bailian voice test',
      voice_mode: 'only',
      tts: { provider: 'script-bailian-tts', model: 'qwen3-tts-flash' },
    });

    expect(mediaMock.voices).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'kiki-media/script-bailian-tts', model: 'qwen3-tts-flash' }),
      expect.any(Object),
    );
    expect(startedRequests).toHaveLength(1);
    expect(startedRequests[0]?.request).toMatchObject({
      kind: 'tts',
      text: 'Bailian voice test',
      voice: 'Chelsie',
    });
    expect(startedRequests[0]?.request.kind === 'tts' ? startedRequests[0].request.format : undefined).toBeUndefined();
  });

  it('supports per-item voice modes in messages[] batches (none, append, only)', async () => {
    const mediaMock = mockTtsMediaService();
    const sentInputs: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];
    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [internalMessageChannel()],
          sendMessage: async (input) => {
            sentInputs.push(input);
            return routeUserMessage(input, [internalMessageChannel()]);
          },
        });
      }),
    );

    const result = await execute({
      messages: [
        { text: 'First plain', voice_mode: 'none' },
        { text: 'Second append', voice_mode: 'append' },
        { tts: { mode: 'only', text: 'Third voice only from tts.text' } },
      ],
      end_turn: true,
    }, { turnId: 0, toolCallId: 'batch-tts', signal: new AbortController().signal });

    const wire = JSON.parse(result.output as string);
    expect(wire.messages).toHaveLength(3);
    expect(mediaMock.start).toHaveBeenCalledTimes(2);
    expect(sentInputs[0]).toMatchObject({ text: 'First plain', attachments: [] });
    expect(sentInputs[1]).toMatchObject({ text: 'Second append', attachments: [expect.objectContaining({ kind: 'voice' })] });
    expect(sentInputs[2]).toMatchObject({ text: '', attachments: [expect.objectContaining({ kind: 'voice' })] });
    expect(wire.messages[2]?.voice_only).toBe(true);
    expect(result.stopTurn).toBe(true);
  });

  it('distinguishes Ogg Opus from Ogg Vorbis and auto-transcodes non-Opus audio via managed IHostProcessService without leaking pre-transcode .mp3/.wav paths', async () => {
    expect(isOggOpusAudio(validOggBytes)).toBe(true);
    expect(isOggOpusAudio(oggVorbisBytes)).toBe(false);
    expect(isOggOpusAudio(rawMp3Bytes)).toBe(false);

    const mediaMock = mockTtsMediaService({
      bytes: oggVorbisBytes,
      mime: 'audio/ogg',
      name: 'speech.wav',
    });
    const feishuChannel: UserMessageChannel = {
      id: 'im:feishu-1',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [{ kind: 'voice', mimeTypes: ['audio/ogg', 'audio/opus'], rendering: 'native_voice' }],
      send: async () => ({ status: 'delivered', messageIds: ['om_feishu_1'] }),
    };
    const spawnCalls: { command: string; args: string[] }[] = [];
    const mockHostProcess: Pick<IHostProcessService, 'spawn'> = {
      spawn: vi.fn(async (command: string, args: string[]): Promise<IHostProcess> => {
        spawnCalls.push({ command, args });
        const outPath = args.at(-1)!;
        await writeFile(outPath, validOggBytes);
        const emitter = { on: () => emitter, off: () => emitter };
        return {
          _serviceBrand: undefined,
          pid: 12345,
          exitCode: 0,
          stdin: { write: () => true, end: () => ({} as IHostProcess['stdin']) } as unknown as IHostProcess['stdin'],
          stdout: emitter as unknown as IHostProcess['stdout'],
          stderr: emitter as unknown as IHostProcess['stderr'],
          wait: async () => 0,
          kill: async () => {},
          dispose: () => {},
        };
      }),
    };
    const sentInputs: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];
    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IHostProcessService, mockHostProcess);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [feishuChannel],
          sendMessage: async (input) => {
            sentInputs.push(input);
            return routeUserMessage(input, [feishuChannel]);
          },
        });
      }),
    );

    const result = await execute({
      text: 'Hello Feishu',
      voice_mode: 'only',
      channel: 'im:feishu-1',
    });
    const wire = JSON.parse(result.output as string);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe('ffmpeg');
    expect(spawnCalls[0]?.args).toContain('libopus');
    expect(sentInputs[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: 'voice',
        mimeType: 'audio/ogg',
        title: 'speech.ogg',
        path: 'speech.ogg',
        size: validOggBytes.byteLength,
      }),
    ]);
    expect(sentInputs[0]?.attachments?.[0]?.path).not.toMatch(/\.(wav|mp3)$/i);
    expect(wire.delivered_to).toEqual(['user']);
    expect(wire.channels).toEqual([{ channel_id: 'im:feishu-1', status: 'delivered', message_ids: ['om_feishu_1'] }]);
  });

  it('preserves real audio/ogg MIME when non-Opus Ogg transcode fails on a non-Opus-mandatory channel, and throws when channel requires Opus', async () => {
    const mediaMock = mockTtsMediaService({
      bytes: oggVorbisBytes,
      mime: 'audio/ogg',
      name: 'vorbis.ogg',
    });
    const failingHostProcess: Pick<IHostProcessService, 'spawn'> = {
      spawn: vi.fn(async (): Promise<IHostProcess> => {
        const err = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    };
    const internalSent: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];
    const feishuChannel: UserMessageChannel = {
      id: 'im:feishu-strict',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [{ kind: 'voice', mimeTypes: ['audio/ogg', 'audio/opus'], rendering: 'native_voice' }],
      send: async () => ({ status: 'delivered', messageIds: ['om_feishu_strict'] }),
    };

    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IHostProcessService, failingHostProcess);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [internalMessageChannel(), feishuChannel],
          sendMessage: async (input) => {
            internalSent.push(input);
            return routeUserMessage(input, [internalMessageChannel(), feishuChannel]);
          },
        });
      }),
    );

    const internalRes = await execute({
      text: 'Internal player accepts Ogg Vorbis as audio/ogg',
      voice_mode: 'only',
      channel: 'internal',
    });
    const internalWire = JSON.parse(internalRes.output as string);
    expect(internalWire.delivery).toBe('delivered');
    expect(internalSent[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: 'voice',
        mimeType: 'audio/ogg',
        title: 'vorbis.ogg',
      }),
    ]);
    expect(internalSent[0]?.attachments?.[0]?.mimeType).not.toBe('audio/mpeg');

    await expect(
      execute({
        text: 'Feishu requires Ogg Opus and must reject untranscoded Ogg Vorbis',
        voice_mode: 'only',
        channel: 'im:feishu-strict',
      }),
    ).rejects.toThrow(/requires Ogg\/Opus audio/);
  });

  it('executes real PluginMediaService.start/run with offline WAV audio and transcodes via real ffmpeg into valid Ogg/Opus when ffmpeg is available', async (testCtx) => {
    const candidateBins = [
      process.env['KIKI_TEST_FFMPEG_PATH'],
      'ffmpeg',
    ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const realProcessService = new HostProcessService();
    let availableFfmpeg: string | undefined;
    for (const candidate of candidateBins) {
      if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue;
      const probe = await runManagedFfmpeg(candidate, ['-version'], new AbortController().signal, 5_000, realProcessService).catch(() => undefined);
      if (probe !== undefined && probe.code === 0) {
        availableFfmpeg = candidate;
        break;
      }
    }
    if (availableFfmpeg === undefined) {
      testCtx.skip('Real ffmpeg binary not found on PATH or KIKI_TEST_FFMPEG_PATH; skipping real ffmpeg transcode integration check.');
      return;
    }

    const homeDir = await mkdtemp(join(tmpdir(), 'send-message-real-tts-'));
    dirs.push(homeDir);
    const wavBytes = createValidSineWavBytes(16_000, 150);
    const providerDescriptor = {
      pluginId: 'kiki-media',
      provider: 'kiki-media/script-bailian-tts',
      source: 'local',
      configuration: 'cfg-1',
      definition: {
        schemaVersion: 1 as const,
        id: 'script-bailian-tts',
        label: 'Bailian TTS',
        kinds: ['tts' as const],
        resumeVersion: 1,
      },
    };
    const hostStub: Partial<IPluginHostService> = {
      attachQuotaCache: () => {},
      attachOutboundIm: () => {},
      attachImAdapters: async () => {},
      listMediaProviders: vi.fn(async () => [providerDescriptor]),
      requestMediaProvider: vi.fn(async (_provider, action, _input, _signal, callCtx) => {
        if (action === 'voices') {
          return {
            schemaVersion: 1,
            provider: 'kiki-media/script-bailian-tts',
            voices: [{ id: 'Chelsie', name: 'Chelsie' }],
          };
        }
        expect(action).toBe('submit');
        const wavPath = join(callCtx.stagingDir, 'synthesized.wav');
        await writeFile(wavPath, wavBytes);
        return {
          state: 'complete',
          artifacts: [
            {
              kind: 'audio',
              role: 'original',
              name: 'synthesized.wav',
              mime: 'audio/wav',
              path: wavPath,
              complete: true,
            },
          ],
        };
      }),
    };

    const feishuChannel: UserMessageChannel = {
      id: 'im:feishu-real',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [{ kind: 'voice', mimeTypes: ['audio/ogg', 'audio/opus'], rendering: 'native_voice' }],
      send: async () => ({ status: 'delivered', messageIds: ['om_feishu_real_1'] }),
    };
    const sentInputs: Parameters<IUserMessageRouter['sendMessage']>[0][] = [];

    await messageAgent(
      homeDirServices(homeDir),
      appServices((reg) => {
        reg.definePartialInstance(IPluginUsageService, {
          enabled: () => false,
          allows: async () => true,
          registerPluginStateReader: () => ({ dispose: () => undefined }),
          onDidChange: Event.None as IPluginUsageService['onDidChange'],
          onDidApply: Event.None as IPluginUsageService['onDidApply'],
        });
        reg.definePartialInstance(IPluginService, {
          listPlugins: async () => [],
          mcpServerEntries: async () => [],
          pluginSkillRoots: async () => [],
          hasLoadedSnapshot: () => false,
          onDidReload: Event.None as IPluginService['onDidReload'],
        });
        reg.definePartialInstance(IPluginSettingsService, {
          forExecution: async () => ({}),
        });
        reg.definePartialInstance(IPluginHostService, hostStub);
        reg.define(IPluginMediaService, PluginMediaService);
        reg.defineInstance(IHostProcessService, realProcessService);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [feishuChannel],
          sendMessage: async (input) => {
            sentInputs.push(input);
            return routeUserMessage(input, [feishuChannel]);
          },
        });
      }),
    );

    await ctx.get(IConfigService).set(SEND_MESSAGE_SECTION, {
      ffmpegPath: availableFfmpeg,
    });

    const result = await execute({
      text: 'Offline WAV to real Ogg/Opus transcode verification.',
      voice_mode: 'only',
      channel: 'im:feishu-real',
    }, { turnId: 0, toolCallId: 'real-pipeline-1', signal: new AbortController().signal });

    const wire = JSON.parse(result.output as string);
    expect(wire).toMatchObject({
      delivered_to: ['user'],
      delivery: 'delivered',
      voice_only: true,
      channels: [{ channel_id: 'im:feishu-real', status: 'delivered', message_ids: ['om_feishu_real_1'] }],
      attachments: [
        expect.objectContaining({
          kind: 'voice',
          mime_type: 'audio/ogg',
          title: 'synthesized.ogg',
          path: 'synthesized.ogg',
        }),
      ],
    });
    const attachment = sentInputs[0]!.attachments![0]!;
    expect(attachment.path).toBe('synthesized.ogg');
    const blobHash = attachment.blobId.split(':').at(-1)!;
    const storedBytes = await ctx.get(IBlobStore).get(ctx.get(IAgentScopeContext).scope('blobs'), blobHash);
    expect(storedBytes).toBeDefined();
    expect(isOggOpusAudio(storedBytes!)).toBe(true);
  });

  it('drains ffmpeg stdout/stderr, handles abort/timeout, and preserves scratch files when process cleanup is unconfirmed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'send-message-unconfirmed-cleanup-'));
    dirs.push(homeDir);
    const mediaMock = mockTtsMediaService({
      bytes: rawMp3Bytes,
      mime: 'audio/mpeg',
      name: 'speech.mp3',
    });
    const feishuChannel: UserMessageChannel = {
      id: 'im:feishu-1',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [{ kind: 'voice', mimeTypes: ['audio/ogg', 'audio/opus'], rendering: 'native_voice' }],
      send: async () => ({ status: 'delivered', messageIds: ['om_feishu_1'] }),
    };

    let capturedInPath: string | undefined;
    const controller = new AbortController();
    const unconfirmedHostProcess: Pick<IHostProcessService, 'spawn'> = {
      spawn: vi.fn(async (_command: string, args: string[]): Promise<IHostProcess> => {
        const iIdx = args.indexOf('-i');
        capturedInPath = iIdx >= 0 ? args[iIdx + 1] : undefined;
        const stdoutListeners = new Set<(chunk: Uint8Array | string) => void>();
        const stderrListeners = new Set<(chunk: Uint8Array | string) => void>();
        const stdoutEmitter = {
          on: (_ev: string, fn: (chunk: Uint8Array | string) => void) => { stdoutListeners.add(fn); return stdoutEmitter; },
          off: (_ev: string, fn: (chunk: Uint8Array | string) => void) => { stdoutListeners.delete(fn); return stdoutEmitter; },
        };
        const stderrEmitter = {
          on: (_ev: string, fn: (chunk: Uint8Array | string) => void) => { stderrListeners.add(fn); return stderrEmitter; },
          off: (_ev: string, fn: (chunk: Uint8Array | string) => void) => { stderrListeners.delete(fn); return stderrEmitter; },
        };
        setTimeout(() => {
          for (const fn of stdoutListeners) fn('ffmpeg stdout chunk');
          for (const fn of stderrListeners) fn('ffmpeg stderr chunk');
          controller.abort();
        }, 10);
        return {
          _serviceBrand: undefined,
          pid: 99999,
          exitCode: null,
          stdin: { write: () => true, end: () => ({} as IHostProcess['stdin']) } as unknown as IHostProcess['stdin'],
          stdout: stdoutEmitter as unknown as IHostProcess['stdout'],
          stderr: stderrEmitter as unknown as IHostProcess['stderr'],
          wait: () => new Promise<number>(() => {}),
          kill: async () => {
            throw new Error('kill tree unconfirmed');
          },
          dispose: () => {},
        };
      }),
    };

    await messageAgent(
      homeDirServices(homeDir),
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IHostProcessService, unconfirmedHostProcess);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [feishuChannel],
          sendMessage: async (input) => routeUserMessage(input, [feishuChannel]),
        });
      }),
    );

    await expect(
      execute(
        { text: 'Should preserve scratch on unconfirmed kill', voice_mode: 'only', channel: 'im:feishu-1' },
        { turnId: 0, toolCallId: 'unconfirmed-kill', signal: controller.signal },
      ),
    ).rejects.toThrow(/cleanup was not confirmed/);
    expect(capturedInPath).toBeDefined();
    expect(existsSync(capturedInPath!)).toBe(true);
  });

  it('preserves Room and @Bot messages when global TTS defaults are enabled, and reports partial/unsupported when voice is explicitly requested on Room or @Bot', async () => {
    const mediaMock = mockTtsMediaService();
    const postBotMessage = vi.fn(async (): Promise<SendMessageReceipt> => ({
      messageId: 'room-msg-1',
      deliveredTo: ['@all'],
      delivery: 'delivered',
    }));
    const sendHandoff = vi.fn(async (): Promise<SendMessageReceipt> => ({
      messageId: 'handoff-1',
      deliveredTo: ['@helper'],
      delivery: 'pending',
    }));

    const cwd = await mediaAgent(
      ['report.pdf'],
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IRoomMessageRouter, { postBotMessage });
        reg.definePartialInstance(IBotService, { sendHandoff });
      }),
    );

    await ctx.get(IConfigService).set(SEND_MESSAGE_SECTION, {
      voiceMode: 'only',
    });

    const botDefaultRes = await execute({ text: 'Normal handoff under global voiceMode=only', to: '@helper' });
    const botDefaultWire = JSON.parse(botDefaultRes.output as string);
    expect(sendHandoff).toHaveBeenCalledWith(expect.objectContaining({
      target: '@helper',
      content: 'Normal handoff under global voiceMode=only',
    }));
    expect(botDefaultWire).toMatchObject({
      delivered_to: ['@helper'],
      delivery: 'pending',
    });
    expect(botDefaultWire.channels).toBeUndefined();

    const botExplicitAppendRes = await execute({
      text: 'Handoff with explicit append voice',
      to: '@helper',
      voice_mode: 'append',
    });
    const botExplicitAppendWire = JSON.parse(botExplicitAppendRes.output as string);
    expect(botExplicitAppendWire).toMatchObject({
      delivered_to: ['@helper'],
      channels: [{ channel_id: '@helper', status: 'partial', unsupported: ['voice'] }],
    });

    const botExplicitOnlyNoAttachmentsRes = await execute({
      text: 'Handoff with explicit voice only',
      to: '@helper',
      voice_mode: 'only',
    });
    const botExplicitOnlyNoAttachmentsWire = JSON.parse(botExplicitOnlyNoAttachmentsRes.output as string);
    expect(botExplicitOnlyNoAttachmentsWire).toMatchObject({
      delivered_to: [],
      delivery: 'undeliverable',
      voice_only: true,
      channels: [{ channel_id: '@helper', status: 'unsupported', unsupported: ['voice'] }],
    });

    const botExplicitOnlyWithAttachmentRes = await execute({
      text: 'Spoken note for attachment',
      to: '@helper',
      voice_mode: 'only',
      attachments: [{ path: join(cwd, 'report.pdf') }],
    });
    const botExplicitOnlyWithAttachmentWire = JSON.parse(botExplicitOnlyWithAttachmentRes.output as string);
    expect(botExplicitOnlyWithAttachmentWire).toMatchObject({
      delivered_to: ['@helper'],
      voice_only: true,
      channels: [{ channel_id: '@helper', status: 'partial', unsupported: ['voice'] }],
    });

    await ctx.get(ISessionMetadata).update({ custom: { room_member_of: 'room-42' } });
    const roomDefaultRes = await execute({ text: 'Room broadcast under global voiceMode=only' });
    const roomDefaultWire = JSON.parse(roomDefaultRes.output as string);
    expect(postBotMessage).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-42',
      text: 'Room broadcast under global voiceMode=only',
    }));
    expect(roomDefaultWire).toMatchObject({
      delivered_to: ['@all'],
      delivery: 'delivered',
    });
    expect(roomDefaultWire.channels).toBeUndefined();

    const roomExplicitAppendRes = await execute({
      text: 'Room broadcast with explicit append voice',
      voice_mode: 'append',
      end_turn: true,
    });
    const roomExplicitAppendWire = JSON.parse(roomExplicitAppendRes.output as string);
    expect(roomExplicitAppendWire).toMatchObject({
      delivered_to: ['@all'],
      channels: [{ channel_id: 'room:room-42', status: 'partial', unsupported: ['voice'] }],
    });
    expect(roomExplicitAppendRes.stopTurn).toBeUndefined();
  });

  it('reflects unsupported voice channels accurately: only mode never sends text or file, append mode delivers text with partial/unsupported receipt', async () => {
    const mediaMock = mockTtsMediaService();
    const discordSent: { input: Parameters<UserMessageChannel['send']>[0]; skipped: readonly string[] }[] = [];
    const discordChannel: UserMessageChannel = {
      id: 'im:discord-1',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [
        { kind: 'image', mimeTypes: ['image/*'] },
        { kind: 'file' },
        { kind: 'audio', mimeTypes: ['audio/*'], rendering: 'attachment' },
      ],
      send: async (input, skipped) => {
        discordSent.push({ input, skipped });
        return { status: 'delivered', messageIds: ['discord_msg_1'] };
      },
    };

    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => [discordChannel],
          sendMessage: async (input) => routeUserMessage(input, [discordChannel]),
        });
      }),
    );

    const onlyResult = await execute({
      text: 'Secret voice only',
      voice_mode: 'only',
      channel: 'im:discord-1',
      end_turn: true,
    }, { turnId: 0, toolCallId: 'discord-only', signal: new AbortController().signal });
    const onlyWire = JSON.parse(onlyResult.output as string);
    expect(discordSent).toHaveLength(0);
    expect(mediaMock.start).not.toHaveBeenCalled();
    expect(onlyWire).toMatchObject({
      delivered_to: [],
      delivery: 'undeliverable',
      voice_only: true,
      channels: [{ channel_id: 'im:discord-1', status: 'unsupported', unsupported: ['voice'] }],
    });
    expect(onlyResult.stopTurn).toBeUndefined();

    const appendResult = await execute({
      text: 'Deliverable text body',
      voice_mode: 'append',
      channel: 'im:discord-1',
      end_turn: true,
    }, { turnId: 0, toolCallId: 'discord-append', signal: new AbortController().signal });
    const appendWire = JSON.parse(appendResult.output as string);
    expect(mediaMock.start).toHaveBeenCalledOnce();
    expect(discordSent).toHaveLength(1);
    expect(discordSent[0]?.input.text).toBe('Deliverable text body');
    expect(discordSent[0]?.input.attachments).toEqual([]);
    expect(appendWire).toMatchObject({
      delivered_to: ['user'],
      delivery: 'delivered',
      channels: [
        {
          channel_id: 'im:discord-1',
          status: 'partial',
          message_ids: ['discord_msg_1'],
          unsupported: ['voice'],
        },
      ],
      attachments: [expect.objectContaining({ kind: 'voice', mime_type: 'audio/ogg' })],
    });
    expect(appendResult.stopTurn).toBeUndefined();
  });

  it('fans out voice_mode=only to supported channels without sending fallback text to unsupported channels', async () => {
    const mediaMock = mockTtsMediaService();
    const internalCh = internalMessageChannel();
    const discordSend = vi.fn(async () => ({ status: 'delivered' as const, messageIds: ['unexpected'] }));
    const discordChannel: UserMessageChannel = {
      id: 'im:discord-1',
      kind: 'im',
      bound: true,
      enabled: true,
      capabilities: [{ kind: 'file' }, { kind: 'audio', mimeTypes: ['audio/*'] }],
      send: discordSend,
    };
    const channels = [internalCh, discordChannel];

    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async () => channels,
          sendMessage: async (input) => routeUserMessage(input, channels),
        });
      }),
    );

    const result = await execute({
      text: 'Fanout voice only',
      voice_mode: 'only',
      end_turn: true,
    });
    const wire = JSON.parse(result.output as string);
    expect(discordSend).not.toHaveBeenCalled();
    expect(wire).toMatchObject({
      delivered_to: ['user'],
      delivery: 'delivered',
      voice_only: true,
      channels: [
        { channel_id: 'internal', status: 'delivered' },
        { channel_id: 'im:discord-1', status: 'unsupported', unsupported: ['voice'] },
      ],
    });
    expect(result.stopTurn).toBe(true);
  });

  it('fans out SendMessage through ImSessionBridge without appending or sending unsupported-media notices on WeChat or runtime-refused channels', async () => {
    const mediaMock = mockTtsMediaService();
    const wechatAdapter = new FakeImAdapter('wechat_bridge', 'wx-account');
    wechatAdapter.voice = false;
    const telegramAdapter = new FakeImAdapter('telegram', 'tg-account');
    const feishuAdapter = new FakeImAdapter('feishu_app', 'fs-account');
    feishuAdapter.sendMedia = async ({ kind }) => ({ status: 'unsupported', unsupported: [kind], detail: 'voice_rejected' });

    const secrets = new Map<string, { providerId: string; credential: string }>([
      ['inst-wx', { providerId: 'wechat_bridge', credential: 'wx-token\nwx-account' }],
      ['inst-tg', { providerId: 'telegram', credential: '123456:abcdefghijklmnopqrstuvwxyz' }],
      ['inst-fs', { providerId: 'feishu_app', credential: 'cli_a\nsec_b' }],
    ]);
    let storedState = '';
    let bridge!: ImSessionBridge;

    await messageAgent(
      appServices((reg) => {
        reg.definePartialInstance(IPluginMediaService, mediaMock);
        reg.definePartialInstance(IUserMessageRouter, {
          listChannels: async (sessionId) => bridge.channelViews(sessionId),
          sendMessage: async (input) => bridge.sendUserMessage(input),
        });
      }),
    );

    const sessionId = ctx.get(ISessionContext).sessionId;
    const ports: ImSessionPorts = {
      credentials: {
        list: () => [...secrets.entries()].map(([id, item]) => ({ id, providerId: item.providerId, configured: true })),
        read: (id) => secrets.get(id)?.credential,
        write: async (id, value) => {
          const prev = secrets.get(id);
          secrets.set(id, { providerId: prev?.providerId ?? 'telegram', credential: value });
        },
        check: async (id) => ({ ok: true, accountId: secrets.get(id)?.providerId ?? 'account' }),
      },
      sessions: {
        listPersonas: async () => [],
        listSessions: async () => [{ id: sessionId, title: 'Session' }],
        owns: async (id) => id === sessionId,
        ensureHome: async () => ({ homeSessionId: sessionId }),
        activity: async () => ({ busy: false, pending: 'none', queueLength: 0 }),
        submit: async ({ promptId }) => ({ duplicate: false, promptId, turnId: 1, deliveryState: 'pending' }),
        steer: async () => 'steered',
        abort: async () => false,
        saveMedia: async () => [],
        readAttachment: async ({ blobId }) => {
          const hash = blobId.split(':').at(-1) ?? '';
          const bytes = await ctx.get(IBlobStore).get(ctx.get(IAgentScopeContext).scope('blobs'), hash);
          return bytes === undefined ? undefined : { bytes, name: 'voice.ogg', mediaType: 'audio/ogg' };
        },
        readVisible: async () => ({ text: '', done: true, media: [] }),
        listInteractions: async () => ({ approvals: [], questions: [] }),
        decideApproval: async () => 'decided',
        decideHostKey: async () => 'decided',
        answerQuestion: async () => 'answered',
      },
      logger: { info: () => undefined },
      load: async () => storedState === '' ? undefined : storedState,
      save: async (value) => { storedState = value; },
    };

    bridge = new ImSessionBridge({
      ports,
      factories: [
        fakeAdapterFactory(wechatAdapter),
        fakeAdapterFactory(telegramAdapter),
        fakeAdapterFactory(feishuAdapter),
      ],
      editIntervalMs: 0,
      now: () => 1_700_000_000_000,
      wait: async () => undefined,
    });

    try {
      for (const id of ['inst-wx', 'inst-tg', 'inst-fs']) {
        await bridge.setListening(id, true);
      }
      await wechatAdapter.emit({ eventId: 'wx-d', identity: { chatId: 'wx-c', senderId: 'u', topicId: '0', chatKind: 'private' }, kind: 'text', text: 'hi' });
      await telegramAdapter.emit({ eventId: 'tg-d', identity: { chatId: 'tg-c', senderId: 'u', topicId: '0', chatKind: 'private' }, kind: 'text', text: 'hi' });
      await feishuAdapter.emit({ eventId: 'fs-d', identity: { chatId: 'fs-c', senderId: 'u', topicId: '0', chatKind: 'private' }, kind: 'text', text: 'hi' });
      for (const d of (await bridge.snapshot()).discoveries) {
        await bridge.confirm(d.id, { target: { kind: 'session', session_id: sessionId } });
      }
      const bindings = (await bridge.snapshot()).bindings;
      const wxChannelId = `im:${bindings.find((b) => b.provider_kind === 'wechat_bridge')!.id}`;
      const tgChannelId = `im:${bindings.find((b) => b.provider_kind === 'telegram')!.id}`;
      const fsChannelId = `im:${bindings.find((b) => b.provider_kind === 'feishu_app')!.id}`;

      const exactBody = 'Here is the exact reply body without any unsupported tail.';
      const res = await execute({
        text: exactBody,
        voice_mode: 'append',
        end_turn: true,
      }, { turnId: 0, toolCallId: 'bridge-fanout-append', signal: new AbortController().signal });
      const wire = JSON.parse(res.output as string);

      expect(wechatAdapter.sent).toEqual([
        expect.objectContaining({ code: 'send_message', text: exactBody, messageId: 'm1' }),
      ]);
      expect(wechatAdapter.files).toHaveLength(0);

      expect(feishuAdapter.sent).toEqual([
        expect.objectContaining({ code: 'send_message', text: exactBody, messageId: 'm1' }),
      ]);
      expect(feishuAdapter.files).toHaveLength(0);

      expect(telegramAdapter.sent).toEqual([
        expect.objectContaining({ code: 'send_message', text: exactBody, messageId: 'm1' }),
      ]);
      expect(telegramAdapter.files).toEqual([
        expect.objectContaining({ deliveredAs: 'voice', mediaType: 'audio/ogg' }),
      ]);

      expect(wire).toMatchObject({
        delivered_to: ['user'],
        delivery: 'delivered',
        channels: [
          { channel_id: 'internal', status: 'delivered' },
          { channel_id: wxChannelId, status: 'partial', message_ids: ['m1'], unsupported: ['voice'] },
          { channel_id: tgChannelId, status: 'delivered', message_ids: ['m1', 'f2'] },
          { channel_id: fsChannelId, status: 'partial', message_ids: ['m1'], unsupported: ['voice'], detail: 'voice_rejected' },
        ],
      });
      expect(res.stopTurn).toBe(true);
    } finally {
      await bridge.close();
    }
  });
});
