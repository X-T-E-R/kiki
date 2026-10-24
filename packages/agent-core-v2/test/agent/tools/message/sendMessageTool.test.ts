import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE, MESSAGE_DELIVERY_SENT_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TaskNotificationStepRequest } from '#/agent/task/taskService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISendMessageTool } from '#/agent/tools/message/sendMessageTool';
import { IBotService } from '#/app/bot/bot';
import { IRoomMessageRouter, type SendMessageReceipt } from '#/app/bot/messageRouting';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { appServices, createTestAgent, type TestAgentContext, type TestAgentServiceOverride } from '../../../harness';

let ctx: TestAgentContext;
afterEach(async () => { await ctx?.dispose(); });

async function messageAgent(...overrides: TestAgentServiceOverride[]): Promise<TestAgentContext> {
  ctx = createTestAgent(...overrides);
  const delivery = ctx.get(ISessionDeliveryService);
  await delivery.ready;
  await delivery.set('message');
  return ctx;
}

async function execute(input: Parameters<ISendMessageTool['resolveExecution']>[0]): Promise<ExecutableToolResult> {
  const execution = await ctx.get(ISendMessageTool).resolveExecution(input);
  return 'execute' in execution
    ? execution.execute({ turnId: 0, toolCallId: 'send-1', signal: new AbortController().signal })
    : execution;
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
  it('keeps the full ordinary fallback and conditional completion contract in the real tool description', async () => {
    await messageAgent();
    const tool = ctx.get(ISendMessageTool);
    expect(tool.description).not.toContain('Ordinary assistant text is not delivered');
    expect(tool.description).toContain('A final ordinary reply is delivered in full as a fallback');
    expect(tool.description).toContain('if the request is complete and no work remains');
    expect(tool.description).toContain('Do not split one message into sentences');
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
      registration.dispose();
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
      ctx.mockNextResponse({ type: 'function', id: 'send-1', name: 'SendMessage', arguments: '{"text":"Current answer delivered."}' });
      ctx.mockNextResponse({ type: 'text', text: 'Background result inspected.' });
      const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Give the current answer.' }] });
      expect(result).toMatchObject({ state: 'completed' });
      expect(ctx.llmCalls).toHaveLength(2);
      expect(historyText(1)).toContain('Background work finished; inspect the result.');
      expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: false });
    } finally {
      pending.dispose();
    }
  });

  it('leaves a failed send recoverable instead of treating it as completion', async () => {
    await messageAgent();
    ctx.mockNextResponse({ type: 'function', id: 'failed-send', name: 'SendMessage', arguments: '{"text":" ","to":"user"}' });
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
