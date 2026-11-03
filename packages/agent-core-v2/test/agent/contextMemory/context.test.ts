import type OpenAI from 'openai';
import { Jimp } from 'jimp';
import type { Message } from '#/kosong/contract/message';
import { OpenAIResponsesChatProvider } from '#/kosong/provider/bases/openai/openai-responses';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokens, estimateTokensForMessage, estimateTokensForMessages, MEDIA_TOKEN_ESTIMATE } from '#/kosong/contract/tokens';
import { IEventBus } from '#/app/event/eventBus';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { buildImageCompressionCaption } from '#/agent/media/image-compress';
import {
  buildContextCompactionShape,
  COMPACT_CARRIED_MEDIA_MAX_TOKENS,
  COMPACT_USER_MESSAGE_HEAD_TOKENS,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  createCompactionSummaryMessage,
  selectCompactionUserMessages,
  type TokenEstimate,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { applyContextCompactionRecord, computeUndoCut } from '#/agent/contextMemory/contextOps';
import { IWireService } from '#/wire/wire';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  IAgentContextMemoryService,
  IAgentTokenCountingService,
  IAgentProfileService,
} from '#/index';

import { createTestAgent, permissionModeServices, type TestAgentContext } from '../../harness';

describe('Agent context', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tokenCounting: IAgentTokenCountingService;
  let profile: IAgentProfileService;
  let wire: IWireService;

  beforeEach(() => {
    ctx = createTestAgent(permissionModeServices('manual'));
    context = ctx.get(IAgentContextMemoryService);
    tokenCounting = ctx.get(IAgentTokenCountingService);
    profile = ctx.get(IAgentProfileService);
    wire = ctx.get(IWireService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('stores prompt origins without leaking them to LLM projection', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.appendSystemReminder('Remember this.', { kind: 'injection', variant: 'host' });
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_origin', name: 'Run', arguments: '{}' }],
      },
    );
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCalls: [],
        toolCallId: 'call_origin',
      },
    );

    expect(context.get().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
      { role: 'assistant', origin: undefined },
      { role: 'tool', origin: undefined },
    ]);
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('publishes the delivery-carrying append event for user-visible appends', async () => {
    const events: unknown[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => events.push(event));
    const appendEvents = () => events.filter((event) =>
      typeof event === 'object' && event !== null && 'type' in event && event.type === 'context.append_message'
    );
    context.append({
      id: 'ordinary-message',
      role: 'user',
      content: [{ type: 'text', text: 'ordinary' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    expect(appendEvents()).toEqual([]);

    context.appendObservable({
      id: 'mailbox-message',
      role: 'user',
      content: [{ type: 'text', text: 'mailbox' }],
      toolCalls: [],
      origin: {
        kind: 'agent_message',
        messageId: 'mailbox-message',
        senderAgentId: 'main',
        senderTaskName: 'root',
      },
    });

    expect(ContextAppendMessage.durable).toBe(true);
    const observedAll = appendEvents();
    const [observed] = observedAll.slice(-1);
    expect(observed).toEqual(expect.objectContaining({
      type: 'context.append_message',
      message: expect.objectContaining({ id: 'mailbox-message' }),
    }));
    expect((observed as { delivery?: { origin: string; messageId: string; deliveryId: string } }).delivery).toEqual(
      expect.objectContaining({ origin: 'mailbox', messageId: 'mailbox-message' }),
    );

    context.appendManaged(
      {
        id: 'prompt-message',
        role: 'user',
        content: [{ type: 'text', text: 'prompt' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        deliveryId: 'dlv_prompt',
        messageId: 'prompt-message',
        turnId: 3,
        stepId: 'step-uuid',
        step: 2,
        deliveredAt: new Date().toISOString(),
        origin: 'user',
      },
    );
    const [promptObserved] = appendEvents().slice(-1);
    expect(promptObserved).toEqual(expect.objectContaining({
      type: 'context.append_message',
      delivery: expect.objectContaining({
        deliveryId: 'dlv_prompt',
        messageId: 'prompt-message',
        turnId: 3,
        stepId: 'step-uuid',
        step: 2,
        origin: 'user',
      }),
    }));
    await subscription.dispose();
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_error', name: 'Run', arguments: '{}' },
          { type: 'function', id: 'call_empty', name: 'Run', arguments: '{}' },
        ],
      },
    );
    context.append(
      {
        role: 'tool',
        content: [
          {
            type: 'text',
            text: '<system>ERROR: Tool execution failed.</system>\npermission denied',
          },
        ],
        toolCalls: [],
        toolCallId: 'call_error',
      },
    );
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    );

    expect(ctx.project()).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call_error' }, { id: 'call_empty' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'text',
            text: '<system>ERROR: Tool execution failed.</system>\npermission denied',
          },
        ],
        toolCallId: 'call_error',
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCallId: 'call_empty',
      },
    ]);
  });

  it('drops empty text parts only in LLM projection', () => {
    const history: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Run the tool' },
        ],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'enc_empty_thinking' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '   ' }],
        toolCalls: [],
      },
    ];

    expect(ctx.project(history)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Run the tool' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'enc_empty_thinking' }],
        toolCalls: [],
      },
    ]);
    expect(history[0]?.content).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Run the tool' },
    ]);
    expect(history[1]?.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('renders tool result messages left empty by LLM projection cleanup as empty output', () => {
    const history: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '' }],
        toolCallId: 'call_empty',
        toolCalls: [],
      },
    ];

    expect(ctx.project(history)).toEqual([
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    ]);
  });

  it('projects hook result messages into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hooked input' }]);
    context.append(
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
    );
    context.append(
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    );
    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue from stop hook' }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'Stop' },
      },
    );

    expect(context.get()).toHaveLength(4);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue from stop hook' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects blocked UserPromptSubmit prompts into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'blocked prompt' }]);
    context.append(
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    );
    ctx.appendUserMessage([{ type: 'text', text: 'safe followup' }]);

    expect(context.get()).toHaveLength(3);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'blocked prompt' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'safe followup' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects user, assistant, tool call, and tool result records into LLM history', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendAssistantText(1, 'earlier assistant');
    ctx.appendToolExchange();

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "user before step 1"
        assistant: text "earlier assistant"
        user: text "lookup something"
        assistant: text "I will call Lookup."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "lookup result"
        user: text "continue"
    `);
  });

  it('keeps system reminders separate from real user prompts', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendSystemReminder('Remember the host note.', {
      kind: 'injection',
      variant: 'host',
    });

    ctx.mockNextResponse({ type: 'text', text: 'noted' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Real user prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "<system-reminder>\\nRemember the host note.\\n</system-reminder>"
        user: text "Real user prompt"
    `);
  });

  it('defers system reminders until pending tool results are recorded and resumed', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'load a skill' }]);
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_write', name: 'Write', arguments: '{}' },
          { type: 'function', id: 'call_skill', name: 'Skill', arguments: '{}' },
        ],
      },
    );
    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act_skill',
          skillName: 'demo',
          trigger: 'model-tool',
        },
      },
    );

    expect(context.get().map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'wrote file' }],
        toolCalls: [],
        toolCallId: 'call_write',
      },
    );
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'skill loaded' }],
        toolCalls: [],
        toolCallId: 'call_skill',
      },
    );

    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.project()[4]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' },
    ]);
  });

  it('clears context before the next LLM request', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendUserMessage([{ type: 'text', text: 'stale user message' }]);
    await ctx.rpc.clearContext({});

    ctx.mockNextResponse({ type: 'text', text: 'fresh' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'fresh prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "fresh prompt"
    `);
  });

  it('includes new user messages as pending until the next usage update', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next user prompt'.repeat(20) }]);

    const pendingMessages = context.get().slice(-1);
    expect(tokenCounting.get().size).toBe(
      tokenCounting.get().measured + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps tool results pending when step usage covers only through the assistant message', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'lookup pending tokens' }]);
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_pending_tokens', name: 'Lookup', arguments: '{}' },
        ],
      },
    );
    tokenCounting.measured(context.get(), [], {
      inputCacheRead: 0,
      inputCacheCreation: 0,
      inputOther: 1_280,
      output: 0,
    });
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'large tool result '.repeat(50) }],
        toolCalls: [],
        toolCallId: 'call_pending_tokens',
      },
    );

    const pendingMessages = context.get().slice(-1);
    expect(tokenCounting.get().measured).toBe(1_280);
    expect(tokenCounting.get().size).toBe(
      1_280 + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps zero-usage steps pending instead of zeroing tokenCount', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next prompt' }]);

    expect(tokenCounting.get().measured).toBe(1_000);
    expect(tokenCounting.get().size).toBeGreaterThanOrEqual(
      tokenCounting.get().measured,
    );
  });

  it('get(start, end) returns the size of a context-message range', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });

    ctx.appendUserMessage([{ type: 'text', text: 'pending one'.repeat(20) }]);
    ctx.appendUserMessage([{ type: 'text', text: 'pending two'.repeat(20) }]);

    const messages = context.get();
    const tailEstimate = estimateTokensForMessages(messages.slice(2));

    expect(tokenCounting.get()).toEqual({
      size: 1_000 + tailEstimate,
      measured: 1_000,
      estimated: tailEstimate,
    });

    const firstPending = estimateTokensForMessages(messages.slice(2, 3));
    expect(tokenCounting.get(2, 3)).toEqual({
      size: firstPending,
      measured: 0,
      estimated: firstPending,
    });

    expect(tokenCounting.get(0, 2)).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });

    const prefixHead = estimateTokensForMessages(messages.slice(0, 1));
    expect(tokenCounting.get(0, 1)).toEqual({
      size: prefixHead,
      measured: prefixHead,
      estimated: 0,
    });

    const assistant = estimateTokensForMessages(messages.slice(1, 2));
    expect(tokenCounting.get(1, 3)).toEqual({
      size: assistant + firstPending,
      measured: assistant,
      estimated: firstPending,
    });

    expect(tokenCounting.get(-2)).toEqual({
      size: tailEstimate,
      measured: 0,
      estimated: tailEstimate,
    });
    expect(tokenCounting.get(0, -2)).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
    expect(tokenCounting.get(-3, -1)).toEqual({
      size: assistant + firstPending,
      measured: assistant,
      estimated: firstPending,
    });

    expect(tokenCounting.get(-1, -3)).toEqual({ size: 0, measured: 0, estimated: 0 });
  });

  it('resets the measured context size when the context is cleared', async () => {
    ctx.appendAssistantTextWithUsage(1, 'answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    await context.clear();

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
  });

  it('restores the real measured anchor when undo truncates the ledger', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2', 2_000);
    expect(tokenCounting.get().measured).toBe(2_000);

    await ctx.undoHistory(1);

    const surviving = context.get();
    expect(surviving.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('keeps the measured prefix when undo removes only the unmeasured tail', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2');
    expect(tokenCounting.get().measured).toBe(1_000);

    await ctx.undoHistory(1);

    expect(context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('undo only counts real user prompts, skipping task notifications', async () => {
    ctx.appendTurnExchange('u1', 'first response');
    ctx.appendTurnExchange('u2', 'second response');

    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'background task completed' }],
        toolCalls: [],
        origin: {
          kind: 'task',
          taskId: 'bash-001',
          status: 'completed',
          notificationId: 'task:bash-001:completed',
        },
      },
    );

    expect(context.get().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    await ctx.undoHistory(1);

    expect(context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('undo removes the thread-created task and its response rather than the preceding user exchange', async () => {
    ctx.appendTurnExchange('earlier question', 'earlier answer');
    const earlier = context.get();
    context.append(userMessage('Complete the new thread task.', { kind: 'system_trigger', name: 'thread_create' }));
    context.append({ role: 'assistant', content: [{ type: 'text', text: 'task answer' }], toolCalls: [] });
    context.append(userMessage('Continue automatically.', { kind: 'system_trigger', name: 'goal_continuation' }));
    await ctx.undoHistory(1);
    expect(context.get()).toEqual(earlier);
  });

  it('removes injection messages inside the undone turn', async () => {
    ctx.appendUserTurn('earlier question');
    ctx.appendUserTurn('do the work');
    context.append(
      userMessage('Plan mode is active', {
        kind: 'injection',
        variant: 'plan_mode',
      }),
    );
    context.append(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'work done' }],
        toolCalls: [],
        origin: undefined,
      },
    );

    await ctx.undoHistory(1);

    expect(context.get()).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'earlier question' }],
        origin: { kind: 'user' },
      }),
    ]);
  });

  it('removes the prompt-owned image compression reminder when undoing its prompt', async () => {
    profile.update({ activeToolNames: [] });
    const caption = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });
    const prefix = 'inspect this image ';
    const text = `${prefix}${caption}`;
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({
      input: [{ type: 'text', text, presentation: {
        spans: [{ start: prefix.length, end: text.length, kind: 'image_compression' }],
      } }],
    });
    await ctx.untilTurnEnd();

    expect(context.get()).toMatchObject([
      {
        origin: {
          kind: 'injection',
          variant: 'image_compression',
          ownerPromptId: expect.any(String),
        },
      },
      { origin: { kind: 'user' }, id: expect.any(String) },
      { role: 'assistant' },
    ]);

    await ctx.get(IAgentLoopService).settled();
    await ctx.undoHistory(1);

    expect(context.get()).toEqual([]);
  });

  describe('notification projection', () => {
    it('does not merge a cron-fire envelope into an adjacent user message', () => {
      const cronEnvelope =
        '<cron-fire jobId="deadbeef" cron="*/5 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>';
      const messages = ctx.project([
        userMessage(cronEnvelope, {
          kind: 'cron_job',
          jobId: 'deadbeef',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        }),
        userMessage('Actual follow-up from the user', { kind: 'user' }),
      ]);
      expect(messages).toHaveLength(2);
      expect(textOf(messages[0]!)).toBe(cronEnvelope);
      expect(textOf(messages[1]!)).toBe('Actual follow-up from the user');
    });

    it('uses message origin to keep non-user-origin messages separate', () => {
      const messages = ctx.project([
        userMessage('Host reminder without an XML prefix', {
          kind: 'injection',
          variant: 'host',
        }),
        userMessage('Actual follow-up from the user', { kind: 'user' }),
      ]);

      expect(messages).toHaveLength(2);
      expect(textOf(messages[0]!)).toBe('Host reminder without an XML prefix');
      expect(textOf(messages[1]!)).toBe('Actual follow-up from the user');
    });

    it('merges consecutive user-role messages at one safe boundary without crossing an unanchored message', () => {
      const source = { turnId: 1, stepId: 'same-step' };
      const messages = ctx.project([
        { ...userMessage('First real prompt', { kind: 'user' }), source },
        { ...userMessage('Second real prompt', { kind: 'user' }), source },
        userMessage('No origin prompt'),
        { ...userMessage('Third real prompt', { kind: 'user' }), source },
      ]);

      expect(messages).toHaveLength(3);
      expect(textOf(messages[0]!)).toBe('First real prompt\n\nSecond real prompt');
      expect(textOf(messages[1]!)).toBe('No origin prompt');
      expect(textOf(messages[2]!)).toBe('Third real prompt');
    });
  });

  describe('compaction handoff under a zero estimator', () => {
    it('retains a thread-created task as original input without retaining other system triggers', () => {
      const origin: ContextMessage['origin'] = { kind: 'system_trigger', name: 'thread_create' };
      const prompt = userMessage('Complete the new thread task.', origin);
      const mixed = userMessage('A mixed thread task.', { kind: 'merged', origins: [origin, { kind: 'system_trigger', name: 'future_trigger' }] });
      const internal = ['goal_continuation', 'subagent', 'future_trigger'].map((name) => userMessage(`Internal ${name}`, { kind: 'system_trigger', name }));
      const history = [prompt, mixed, ...internal];
      const shape = buildContextCompactionShape(history, { summary: 'carried context', compactedCount: history.length, tokensBefore: 100 });
      expect(shape.messages.map(textOf)).toEqual(['Complete the new thread task.', 'A mixed thread task.', 'carried context']);
      expect(shape.messages[0]).toEqual(prompt);
      expect(shape.messages[0]?.origin).toEqual(origin);
      expect(shape.messages[1]).toEqual(mixed);
      expect(shape.keptUserMessageCount).toBe(2);
    });

    it('marks omitted message locations without token counts or a guarantee that the summary covers them', () => {
      const messages = Array.from({ length: 300 }, (_, i) => userMessage(`user ${i} ${'x'.repeat(400)}`));
      const shape = buildContextCompactionShape(messages, { summary: 'carried context', compactedCount: messages.length, tokensBefore: 100000 });
      const elision = shape.messages.find((message) => message.origin?.kind === 'injection' && message.origin.variant === 'compaction_elision');
      expect(elision).toBeDefined();
      const text = textOf(elision!);
      expect(text).toContain('oldest retained input');
      expect(text).toContain('most recent');
      expect(text).toContain('available history tools');
      expect(text).toContain('not a substitute');
      expect(text).not.toMatch(/roughly|\\d+ tokens|omitted content is covered/);
    });
    const zero: TokenEstimate = { text: () => 0, message: () => 0, messages: () => 0 };

    it('keeps every user message without elision', () => {
      const messages = Array.from({ length: 300 }, (_, i) =>
        userMessage(`user ${i} ${'x'.repeat(400)}`),
      );

      const zeroed = selectCompactionUserMessages(
        messages,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        COMPACT_USER_MESSAGE_HEAD_TOKENS,
        zero.message,
      );
      expect(zeroed.elided).toBe(false);
      expect(zeroed.head).toHaveLength(0);
      expect(zeroed.tail).toHaveLength(messages.length);

      expect(selectCompactionUserMessages(messages).elided).toBe(true);
    });

    it('falls back to a zero tokensAfter', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const shape = buildContextCompactionShape(
        history,
        { summary: 'summary', compactedCount: 2, tokensBefore: 0 },
        zero,
      );

      expect(shape.tokensAfter).toBe(0);
      expect(shape.messages.map((m) => m.role)).toEqual(['user', 'user']);
      expect(shape.messages[1]?.origin?.kind).toBe('compaction_summary');
    });

    it('splices the summary before the uncompacted recent tail', () => {
      const history = [
        userMessage('old user'),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'old assistant' }],
          toolCalls: [],
        } as ContextMessage,
        userMessage('recent user'),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'recent assistant' }],
          toolCalls: [],
        } as ContextMessage,
        userMessage('stale reminder', { kind: 'injection', variant: 'test' }),
      ];

      const shape = buildContextCompactionShape(
        history,
        { summary: 'summary', compactedCount: 2, tokensBefore: 0 },
        zero,
      );

      expect(shape.messages.map(textOf)).toEqual([
        'old user',
        'summary',
        'recent user',
        'recent assistant',
      ]);
      expect(shape.messages[1]?.origin?.kind).toBe('compaction_summary');
    });

    it('prefers the measured summary output tokens over the text estimate', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const withMeasured = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
      });
      const withEstimate = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
      });

      expect(withMeasured.tokensAfter).toBeGreaterThan(500);
      expect(withMeasured.tokensAfter - 500).toBe(
        withEstimate.tokensAfter - estimateTokens('summary'),
      );
      expect(withMeasured.messages).toEqual(withEstimate.messages);
    });

    it('counts the request overhead into tokensAfter on the full-request basis', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const withOverhead = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
        requestOverheadTokens: 3_000,
      });
      const withoutOverhead = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
      });

      expect(withOverhead.tokensAfter).toBe(withoutOverhead.tokensAfter + 3_000);
      expect(withOverhead.messages).toEqual(withoutOverhead.messages);
    });

    it('keeps both selected ends of one oversized original input in order', () => {
      const original = userMessage('BEGIN' + 'x'.repeat(200) + 'END', { kind: 'user' });
      const shape = buildContextCompactionShape([original], { summary: 'summary', compactedCount: 1, tokensBefore: 100, userBudget: { max: 20, head: 5 } });
      expect(shape.messages.map(textOf)).toEqual([
        'BEGIN' + 'x'.repeat(15), expect.stringContaining('Some earlier user messages'), 'x'.repeat(57) + 'END', 'summary',
      ]);
    });

    it('preserves all pending user images on their own input even beyond the historical limit', () => {
      const pending = { ...userMessage('Inspect these current images.', { kind: 'user' }), content: [
        { type: 'text' as const, text: 'Inspect these current images.' },
        ...Array.from({ length: 12 }, (_, index) => ({ type: 'image_url' as const, imageUrl: { url: `https://example.test/current-${index}.png` } })),
      ] };
      const history = [userMessage('Earlier task'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Finished.' }], toolCalls: [] }, pending];
      const shape = buildContextCompactionShape(history, { summary: 'summary', compactedCount: history.length, tokensBefore: 100 });
      expect(shape.messages.find(message => message.content.some(part => part.type === 'image_url'))).toEqual(pending);
      expect(shape.messages.find(message => message.origin?.kind === 'compaction_summary')?.content).toHaveLength(1);
      const second = buildContextCompactionShape(shape.messages, { summary: 'second', compactedCount: shape.messages.length, tokensBefore: shape.tokensAfter });
      expect(second.messages.find(message => message.content.some(part => part.type === 'image_url'))).toEqual(pending);
    });

    it('keeps completed user media historical before a second compaction with no new final response', () => {
      const images = Array.from({ length: 12 }, (_, index) => ({ type: 'image_url' as const, imageUrl: { url: `https://example.test/historical-${index}.png` } }));
      const history = [
        { ...userMessage('Original reference images', { kind: 'user' }), content: [{ type: 'text' as const, text: 'Original reference images' }, ...images] },
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Finished the original task.' }], toolCalls: [] },
        userMessage('Current text-only task', { kind: 'user' }),
      ];
      const first = buildContextCompactionShape(history, { summary: 'first', compactedCount: history.length, tokensBefore: 100 });
      const secondHistory = [...first.messages, ...mediaExchange('new-tool')];
      const second = buildContextCompactionShape(secondHistory, { summary: 'second', compactedCount: secondHistory.length, tokensBefore: first.tokensAfter });
      const carried = second.messages.flatMap(message => message.content.filter(part => part.type === 'image_url'));
      expect(carried).toHaveLength(COMPACT_CARRIED_MEDIA_MAX_TOKENS / MEDIA_TOKEN_ESTIMATE);
      expect(carried).not.toContainEqual(images[0]);
      expect(second.messages.some(message => message.toolCallId === 'call_new-tool')).toBe(false);
    });

    it('retains the original call when a carried tool image is across the compaction boundary', () => {
      const exchange = mediaExchange('boundary');
      const history = [userMessage('Inspect the evidence.'), ...exchange];
      const shape = buildContextCompactionShape(history, { summary: 'summary', compactedCount: 2, tokensBefore: 100 });
      expect(ctx.project(shape.messages).find(message => message.role === 'tool' && message.toolCallId === 'call_boundary')?.content).toEqual(exchange[1]?.content);
      expect(shape.messages.find(message => message.role === 'assistant')?.toolCalls).toEqual(exchange[0]?.toolCalls);
    });

    it('does not reattach unattributed images from an old handoff, injection, or orphan tool result', () => {
      const image = { type: 'image_url' as const, imageUrl: { url: 'https://example.test/unattributed.png' } };
      const latest = userMessage('The current task is text-only.', { kind: 'user' });
      const history = [
        { ...createCompactionSummaryMessage('Old handoff'), content: [{ type: 'text' as const, text: 'Old handoff' }, image] },
        { ...userMessage('Old injection', { kind: 'injection', variant: 'runtime_snapshot' }), content: [image] },
        { role: 'tool' as const, toolCallId: 'missing', toolCalls: [], content: [image] }, latest,
      ];
      const shape = buildContextCompactionShape(history, { summary: 'New handoff', compactedCount: history.length, tokensBefore: 100 });
      expect(shape.messages.some(message => message.content.includes(image))).toBe(false);
      expect(shape.messages).toContainEqual(latest);
      expect(shape.messages.find(message => message.origin?.kind === 'compaction_summary')?.content).toEqual([{ type: 'text', text: 'New handoff' }]);
    });

    it('keeps historical tool images with their original exchange before the latest text-only request', async () => {
      const oldImage = { type: 'image_url' as const, imageUrl: { url: await new Jimp({ width: 1, height: 1, color: 0xff0000ff }).getBase64('image/png') } };
      const currentImage = { type: 'image_url' as const, imageUrl: { url: await new Jimp({ width: 1, height: 1, color: 0x0000ffff }).getBase64('image/png') } };
      const originalCall = { type: 'function' as const, id: 'read-old', name: 'ReadMediaFile', arguments: '{"path":"old-mock.png"}' };
      const oldResult: ContextMessage = {
        role: 'tool', toolCallId: originalCall.id, toolCalls: [],
        content: [{ type: 'text', text: 'Historical screenshot: old-mock.png' }, oldImage],
        source: { turnId: 1, step: 1, toolCallId: originalCall.id },
      };
      const latest = {
        ...userMessage('Implement account authorization and retain account IDs.'.padEnd(714, '.')),
        id: 'latest',
        origin: { kind: 'peer_thread' as const, source: { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-session' }, messageId: 'latest', acceptedAt: 1 },
      };
      for (const message of [
        userMessage('Inspect the old mock.'),
        { role: 'assistant' as const, content: [], toolCalls: [originalCall] },
        oldResult,
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Old inspection completed.' }], toolCalls: [] },
        latest,
      ]) context.append(message);
      context.applyCompaction({ summary: 'Paused product work; latest request concerns accounts.', compactedCount: context.get().length, tokensBefore: 100 });
      const first = context.get();
      expect(first.find(message => message.origin?.kind === 'compaction_summary')?.content).toHaveLength(1);
      expect(first.find(message => message.content.includes(oldImage))).toEqual(oldResult);
      expect(first.indexOf(first.find(message => message.content.includes(oldImage))!)).toBeLessThan(first.indexOf(latest));
      expect(ctx.project().find(message => message.content.includes(oldImage))).toMatchObject({ role: 'tool', toolCallId: originalCall.id });
      expect(ctx.project().find(message => message.toolCalls.some(call => call.id === originalCall.id))?.toolCalls).toEqual([originalCall]);
      const pending = { ...userMessage('Now inspect this current screenshot.'), content: [{ type: 'text' as const, text: 'Now inspect this current screenshot.' }, currentImage] };
      context.append(pending);
      context.applyCompaction({ summary: 'Latest request is the current screenshot.', compactedCount: context.get().length, tokensBefore: 100 });
      expect(context.get().find(message => message.content.includes(currentImage))).toEqual(pending);
      expect(context.get()).toContainEqual(latest);
      expect(textOf(latest)).toHaveLength(714);
      expect(ctx.project().find(message => message.content.includes(oldImage))).toMatchObject({ role: 'tool', toolCallId: originalCall.id });
      expect(ctx.project().filter(message => message.role === 'user').some(message => message.content.includes(oldImage))).toBe(false);
      let payload: { input: { type: string; role?: string; call_id?: string; output?: unknown; content?: unknown }[] } = { input: [] };
      const provider = new OpenAIResponsesChatProvider({
        model: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl: 'https://example.test/v1',
        clientFactory: () => ({ responses: { create: async (params: typeof payload) => {
          payload = params;
          return { async *[Symbol.asyncIterator]() {
            yield { type: 'response.completed', response: { id: 'example-response', status: 'completed', output: [] } };
          } };
        } } }) as unknown as OpenAI,
      });
      const response = await provider.generate('', [], [...ctx.project()]);
      for await (const part of response) void part;
      const oldOutput = payload.input.findIndex(item => item.type === 'function_call_output' && item.call_id === originalCall.id);
      const latestInput = payload.input.findIndex(item => item.role === 'user' && JSON.stringify(item.content).includes('Implement account authorization'));
      expect(oldOutput).toBeGreaterThan(0);
      expect(oldOutput).toBeLessThan(latestInput);
      expect(payload.input[oldOutput - 1]).toMatchObject({ type: 'function_call', call_id: originalCall.id, name: originalCall.name, arguments: originalCall.arguments });
      expect(payload.input[latestInput]).toMatchObject({ content: [{ type: 'input_text', text: textOf(latest) }] });
      expect(payload.input[oldOutput]).toMatchObject({ output: [
        { type: 'input_text', text: 'Historical screenshot: old-mock.png' },
        { type: 'input_image', image_url: oldImage.imageUrl.url },
      ] });
      expect(payload.input.filter(item => item.role === 'user').some(item => JSON.stringify(item).includes(oldImage.imageUrl.url))).toBe(false);
      expect(payload.input.filter(item => item.role === 'user').some(item => JSON.stringify(item).includes(currentImage.imageUrl.url))).toBe(true);
    });

    it('retains the newest historical media exchanges within the shared source-and-media budget', () => {
      const removed = Array.from({ length: 12 }, (_, index) => mediaExchange(`shot-${index}`)).flat();
      const keptShot = { type: 'image_url' as const, imageUrl: { url: 'kimi-file://kept', id: 'kept' } };
      const kept = { ...userMessage('keep this shot'), content: [{ type: 'text' as const, text: 'keep this shot' }, keptShot] };
      const history = [userMessage('Inspect the earlier screenshots.'), ...removed, kept];
      const shape = buildContextCompactionShape(history, { summary: 'notes', compactedCount: history.length, tokensBefore: 100 });
      const summary = shape.messages.find(message => message.origin?.kind === 'compaction_summary');
      const exchanges = shape.messages.filter(message => message.role === 'assistant' || message.role === 'tool');
      const carried = exchanges.flatMap(message => message.content.flatMap(part => part.type === 'image_url' ? [part.imageUrl.id] : []));
      const keptCount = COMPACT_CARRIED_MEDIA_MAX_TOKENS / MEDIA_TOKEN_ESTIMATE - 1;
      expect(carried).toEqual(Array.from({ length: keptCount }, (_, index) => `shot-${12 - keptCount + index}`));
      expect(estimateTokensForMessages(exchanges)).toBeLessThanOrEqual(COMPACT_CARRIED_MEDIA_MAX_TOKENS);
      expect(estimateTokensForMessages([...mediaExchange('shot-2'), ...exchanges])).toBeGreaterThan(COMPACT_CARRIED_MEDIA_MAX_TOKENS);
      expect(shape.messages.find(message => message.content.includes(keptShot))).toEqual(kept);
      expect(summary?.content).toEqual([{ type: 'text', text: 'notes' }]);
      const elision = shape.messages.find(message => message.origin?.kind === 'injection' && message.origin.variant === 'compaction_elision');
      expect(textOf(elision!)).toContain('not reattached');
      expect(textOf(elision!)).toContain('files themselves are unchanged');
      expect(textOf(elision!)).not.toContain('Some earlier user messages were omitted');
    });

    it('does not accumulate removed media, injections, or user text across a second compaction or cold replay', () => {
      const removed = Array.from({ length: 12 }, (_, index) => mediaExchange(`shot-${index}`)).flat();
      const keptShot = { type: 'image_url' as const, imageUrl: { url: 'kimi-file://kept', id: 'kept' } };
      const kept = {
        role: 'user' as const,
        origin: { kind: 'user' as const },
        content: [{ type: 'text' as const, text: 'keep this shot and this wording' }, keptShot],
        toolCalls: [],
      } satisfies ContextMessage;
      const injected = {
        role: 'user' as const,
        origin: { kind: 'injection' as const, variant: 'runtime_snapshot' },
        content: [{ type: 'text' as const, text: 'runtime snapshot that must not be copied forward' }],
        toolCalls: [],
      } satisfies ContextMessage;
      const history = [...removed, injected, kept];
      const first = buildContextCompactionShape(history, {
        summary: 'handoff one',
        compactedCount: history.length,
        tokensBefore: 100,
      });
      const newer = Array.from({ length: 3 }, (_, index) => mediaExchange(`new-${index}`)).flat();
      const secondHistory = [...first.messages, ...newer];
      const second = buildContextCompactionShape(secondHistory, {
        summary: 'handoff two',
        compactedCount: secondHistory.length,
        tokensBefore: first.tokensAfter,
      });
      const carriedIds = (shape: ReturnType<typeof buildContextCompactionShape>) => shape.messages
        .filter(message => message.role === 'tool')
        .flatMap(message => message.content.flatMap(part => part.type === 'image_url' ? [part.imageUrl.id] : []));
      const keptCount = COMPACT_CARRIED_MEDIA_MAX_TOKENS / MEDIA_TOKEN_ESTIMATE - 1;
      expect(carriedIds(first)).toHaveLength(keptCount);
      expect(carriedIds(second)).toHaveLength(keptCount);
      expect(carriedIds(second).slice(-3)).toEqual(['new-0', 'new-1', 'new-2']);
      expect(carriedIds(second)).not.toContain('shot-2');
      expect(second.messages.filter((message) => message.origin?.kind === 'compaction_summary')).toHaveLength(1);
      expect(textOf(second.messages.find((message) => message.origin?.kind === 'compaction_summary')!)).toBe('handoff two');
      expect(second.messages.filter((message) => message.origin?.kind === 'injection')).toHaveLength(1);
      expect(second.messages.some((message) => message.content.some((part) => part.type === 'text' && part.text.includes('runtime snapshot')))).toBe(false);
      expect(second.messages.filter((message) => message.content.includes(keptShot))).toHaveLength(1);
      expect(second.messages.find((message) => message.content.includes(keptShot))?.origin?.kind).toBe('user');
      const exchanges = second.messages.filter(message => message.role === 'assistant' || message.role === 'tool');
      expect(estimateTokensForMessages(exchanges)).toBeLessThanOrEqual(COMPACT_CARRIED_MEDIA_MAX_TOKENS);
      expect(second.messages.find(message => message.origin?.kind === 'compaction_summary')?.content).toHaveLength(1);
      expect(second.tokensAfter).toBeLessThan(first.tokensAfter + 3 * MEDIA_TOKEN_ESTIMATE);

      const replayed = applyContextCompactionRecord(history, {
        summary: 'handoff one',
        contextSummary: 'handoff one',
        compactedCount: history.length,
        tokensBefore: 100,
        tokensAfter: 444334,
        shapeVersion: 1,
        keptUserMessageCount: 1,
      });
      expect(carriedIds({ ...first, messages: replayed })).toEqual(carriedIds(first));
      expect(replayed.find(message => message.origin?.kind === 'compaction_summary')?.content).toHaveLength(1);
      expect(replayed.filter((message) => message.content.includes(keptShot))).toHaveLength(1);

      const later = {
        role: 'user' as const,
        origin: { kind: 'user' as const },
        content: [{ type: 'text' as const, text: 'after the handoff' }],
        toolCalls: [],
      } satisfies ContextMessage;
      const undo = computeUndoCut([...second.messages, later], 2);
      expect(undo.stoppedAtCompaction).toBe(true);
      expect(undo.removedCount).toBe(1);
    });
  });

  it('shares the historical media budget across kept user input, prior handoffs, injections and the uncompacted tail', () => {
    const image = (id: string) => ({ type: 'image_url' as const, imageUrl: { url: `https://example.test/${id}.png`, id } });
    const media = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => image(`${prefix}-${index}`));
    const history: ContextMessage[] = [
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this instruction' }, ...media('user', 4)], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Completed comparison' }], toolCalls: [] },
      { ...createCompactionSummaryMessage('Previous handoff'), content: [{ type: 'text', text: 'Previous handoff' }, ...media('previous', 12)] },
      { role: 'tool', content: media('old-tool', 12), toolCalls: [], toolCallId: 'old' },
      { role: 'user', origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: media('injection', 12), toolCalls: [] },
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'recent', name: 'ReadMediaFile', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'Recent evidence' }, ...media('tail', 12)], toolCalls: [], toolCallId: 'recent' },
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Compare these new images' }, ...media('pending', 2)], toolCalls: [] },
    ];
    const ids = (messages: readonly ContextMessage[]) => messages.flatMap(message => message.content.flatMap(part => part.type === 'image_url' ? [part.imageUrl.id] : [])).sort();
    const before = ids(history);
    const shape = buildContextCompactionShape(history, { summary: 'New handoff', compactedCount: 5, tokensBefore: 100_000 });
    const expected = [...media('user', 4), ...media('tail', 12).slice(7), ...media('pending', 2)].map(part => part.imageUrl.id).sort();
    expect(ids(shape.messages)).toEqual(expected);
    expect(shape.messages.find(message => message.toolCallId === 'recent')?.content).toHaveLength(6);
    expect(shape.messages.map(textOf).join('\n')).toContain('Keep this instruction');
    expect(ids(history)).toEqual(before);
    const restored = applyContextCompactionRecord(history, { ...shape, shapeVersion: 1 });
    expect(ids(restored)).toEqual(expected);
    const secondHistory = [...restored, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Finished' }], toolCalls: [] }];
    const second = buildContextCompactionShape(secondHistory, { summary: 'Second handoff', compactedCount: secondHistory.length, tokensBefore: shape.tokensAfter });
    expect(ids(second.messages)).toHaveLength(9);
    expect(ids(second.messages)).toContain('pending-1');
    expect(ids(second.messages).some(id => id?.startsWith('previous') || id?.startsWith('injection'))).toBe(false);
    expect(ids(applyContextCompactionRecord(secondHistory, { ...second, shapeVersion: 1 }))).toEqual(ids(second.messages));
  });

  describe('legacy compaction layout', () => {
    it('does not project unattributed media already present in a saved context snapshot', () => {
      context.append(userMessage('Latest text-only request', { kind: 'user' }));
      context.append({ ...createCompactionSummaryMessage('Saved handoff'), content: [
        { type: 'text', text: 'Saved handoff' },
        { type: 'image_url', imageUrl: { url: 'https://example.test/old-unattributed.png' } },
      ] });
      expect(ctx.project().map(message => message.content)).toEqual([
        [{ type: 'text', text: 'Latest text-only request' }], [{ type: 'text', text: 'Saved handoff' }],
      ]);
    });

    it('does not revive unowned summary media when replaying a legacy record', () => {
      const summary = { ...createCompactionSummaryMessage('Legacy handoff'), content: [
        { type: 'text' as const, text: 'Legacy handoff' },
        { type: 'image_url' as const, imageUrl: { url: 'https://example.test/old-unowned.png' } },
      ] };
      const latest = userMessage('Current text-only task', { kind: 'user' });
      const restored = applyContextCompactionRecord([userMessage('old'), latest], { summary, count: 1 });
      expect(restored).toEqual([{ ...summary, content: [{ type: 'text', text: 'Legacy handoff' }] }, latest]);
    });

    it('keeps the verbatim summary followed by the uncompacted tail', () => {
      const history = [userMessage('old'), userMessage('tail')];
      const legacySummary: ContextMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'legacy summary' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      };
      const input = {
        summary: 'legacy summary',
        legacySummaryMessage: legacySummary,
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        legacyTail: true,
      };

      const shape = buildContextCompactionShape(history, input);

      expect(shape.messages[0]).toBe(legacySummary);
      expect(shape.messages[1]).toBe(history[1]);
      expect(shape.messages.map(textOf)).toEqual(['legacy summary', 'tail']);
    });
  });
});

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function mediaExchange(id: string): ContextMessage[] {
  const toolCallId = `call_${id}`;
  return [
    { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: toolCallId, name: 'ReadMediaFile', arguments: JSON.stringify({ path: `${id}.png` }) }] },
    { role: 'tool', content: [{ type: 'text', text: `Historical image ${id}` }, { type: 'image_url', imageUrl: { url: `kimi-file://${id}`, id } }], toolCalls: [], toolCallId },
  ];
}

function textOf(message: Message): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
