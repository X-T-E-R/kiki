import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE, MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { TaskNotificationStepRequest } from '#/agent/task/taskService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISendMessageTool } from '#/agent/tools/message/sendMessageTool';
import { IBotService } from '#/app/bot/bot';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IRoomMessageRouter, IUserMessageRouter, type SendMessageReceipt } from '#/app/bot/messageRouting';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { appServices, createTestAgent, type TestAgentContext, type TestAgentServiceOverride } from '../../../harness';

let ctx: TestAgentContext;
const dirs: string[] = [];
afterEach(async () => {
  await ctx?.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
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

  it.each(['partial', 'failed', 'unknown'] as const)('continues after a final send with %s channel delivery', async (status) => {
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
      await approval.dispose();
    }
  });

  it('sends a media-only message with an explicit kind through the in-app channel', async () => {
    await mediaAgent(['clip.mp4']);
    const result = await execute({ attachments: [{ path: 'clip.mp4', kind: 'video', mime_type: 'video/mp4' }] });
    const wire = JSON.parse(result.output as string);
    expect(wire.delivered_to).toEqual(['user']);
    expect(wire.channels).toEqual([{ channel_id: 'internal', status: 'delivered' }]);
    expect(wire.attachments).toEqual([expect.objectContaining({ kind: 'video', mime_type: 'video/mp4' })]);
    expect(result.note).toContain(MESSAGE_DELIVERY_SENT_GUIDANCE);
  });

  it('sends a generated session media artifact by file_id without widening path roots', async () => {
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
