import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IReadMessageHistoryTool, ReadMessageHistoryInputSchema, ReadMessageHistoryTool } from '#/agent/tools/message/readMessageHistoryTool';
import { IImMessageHistoryReader, type IImMessageHistoryReader as ImMessageHistoryReader, type ImHistoryQuery, type ImLocalHistoryPage } from '#/app/bot/imMessageHistory';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolContext, ExecutableToolResult } from '#/tool/toolContract';

import { appServices, createTestAgent, type TestAgentContext } from '../../../harness';

let ctx: TestAgentContext | undefined;
afterEach(async () => {
  await ctx?.dispose();
  ctx = undefined;
});

function localPage(): ImLocalHistoryPage {
  return {
    status: 'ok',
    source: 'local',
    messages: [],
    nextCursor: 'opaque-next',
    coverage: 'received_only',
    end: 'more',
  };
}

function reader(read: ImMessageHistoryReader['read']): ImMessageHistoryReader {
  return { _serviceBrand: undefined, read };
}

async function messageHistoryAgent(history?: ImMessageHistoryReader): Promise<IReadMessageHistoryTool> {
  ctx = createTestAgent(history === undefined ? [] : appServices((reg) => {
    reg.defineInstance(IImMessageHistoryReader, history);
  }));
  await ctx.ready;
  return ctx.get(IReadMessageHistoryTool);
}

function executionContext(signal = new AbortController().signal): ExecutableToolContext {
  return { turnId: 1, toolCallId: 'read-history-1', signal };
}

type ReadHistoryInput = Parameters<IReadMessageHistoryTool['resolveExecution']>[0];

async function execute(tool: IReadMessageHistoryTool, input: Partial<ReadHistoryInput>, context = executionContext()): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(input as ReadHistoryInput);
  return 'execute' in execution ? execution.execute(context) : execution;
}

describe('ReadMessageHistoryTool', () => {
  it('publishes local defaults, bounds, opaque cursor length, and rejects unknown fields', async () => {
    const tool = await messageHistoryAgent(reader(async () => localPage()));
    const validate = new Ajv({ strict: false, useDefaults: true }).compile(tool.parameters);
    const defaults: Record<string, unknown> = {};
    expect(validate(defaults)).toBe(true);
    expect(defaults).toMatchObject({ source: 'local', limit: 20 });
    expect(validate({ limit: 1, cursor: 'x' })).toBe(true);
    expect(validate({ limit: 50, cursor: 'x'.repeat(8192) })).toBe(true);
    expect(validate({ limit: 0 })).toBe(false);
    expect(validate({ limit: 51 })).toBe(false);
    expect(validate({ cursor: '' })).toBe(false);
    expect(validate({ cursor: 'x'.repeat(8193) })).toBe(false);
    expect(validate({ message_id: 'source-7', text_offset: 0, text_limit: 16_384 })).toBe(true);
    expect(validate({ source: 'platform', message_id: 'source-7', text_offset: 4, text_limit: 1 })).toBe(true);
    expect(validate({ message_id: 'source-7', sender_id: 'sender-7' })).toBe(true);
    expect(validate({ text_offset: 0 })).toBe(false);
    expect(validate({ text_limit: 1 })).toBe(false);
    expect(validate({ message_id: 'source-7', cursor: 'opaque' })).toBe(false);
    expect(validate({ message_id: 'source-7', keyword: 'needle' })).toBe(false);
    expect(validate({ message_id: 'source-7', before: 1_700_000_000_000 })).toBe(false);
    expect(validate({ unexpected: true })).toBe(false);
    expect(ReadMessageHistoryInputSchema.safeParse({ message_id: 'source-7', text_offset: 0, text_limit: 16_384 }).success).toBe(true);
    expect(ReadMessageHistoryInputSchema.safeParse({ text_offset: 0 }).success).toBe(false);
  });

  it('allows only the main agent and keeps the reader absent from child execution', async () => {
    const read = vi.fn<ImMessageHistoryReader['read']>(async () => localPage());
    const tool = await messageHistoryAgent(reader(read));
    const disposables = new DisposableStore();
    try {
      const services = createServices(disposables, { additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, ctx!.get(ISessionContext));
        reg.defineInstance(IAgentScopeContext, { _serviceBrand: undefined, agentId: 'child', scope: () => 'test-session/agents/child' });
        reg.defineInstance(IImMessageHistoryReader, reader(read));
        reg.define(IReadMessageHistoryTool, ReadMessageHistoryTool);
      } });
      const result = await services.get(IReadMessageHistoryTool).resolveExecution({ source: 'local', limit: 20 });
      expect(result).toMatchObject({ isError: true, output: 'IM history is available only to the main agent of the bound conversation.' });
      expect(read).not.toHaveBeenCalled();
      expect(tool.name).toBe('ReadMessageHistory');
    } finally { await disposables.dispose(); }
  });

  it('passes only the current session, explicit filters, opaque cursor, and signal to the local reader', async () => {
    const read = vi.fn<ImMessageHistoryReader['read']>(async () => localPage());
    const tool = await messageHistoryAgent(reader(read));
    const signal = new AbortController().signal;
    const result = await execute(tool, {
      channel: 'notify:fixture',
      topic_id: 'topic-2',
      source: 'local',
      cursor: 'opaque/query-cursor',
      keyword: 'needle',
      sender_id: 'sender-7',
      before: 1_700_000_000_000,
      limit: 7,
    }, executionContext(signal));
    expect(read).toHaveBeenCalledExactlyOnceWith('test-session', {
      channel: 'notify:fixture',
      topicId: 'topic-2',
      source: 'local',
      cursor: 'opaque/query-cursor',
      keyword: 'needle',
      senderId: 'sender-7',
      before: 1_700_000_000_000,
      limit: 7,
      signal,
    });
    expect(JSON.parse(result.output as string)).toEqual({ untrusted: true, ...localPage() });
  });

  it('forwards exact text selectors in camelCase while retaining sender constraints and external output', async () => {
    const read = vi.fn<ImMessageHistoryReader['read']>(async () => ({
      status: 'ok',
      source: 'local',
      messages: [{
        sequence: 7,
        eventId: 'event-7',
        receivedAt: 1_700_000_000_000,
        metadata: {
          provider_kind: 'telegram',
          provider_instance_id: 'instance-1',
          account_id: 'account-1',
          identity: { chat_id: 'chat-1', sender_id: 'sender-7', topic_id: 'topic-1' },
        },
        operation: 'create',
        sessionId: 'test-session',
        timestamp: 1_700_000_000_001,
        text: 'original slice',
        original: { message_id: 'source-7', text_length: 42 },
        text_range: { offset: 5, length: 14, total: 42, next_offset: 19 },
      }],
      coverage: 'received_only',
      end: 'reached',
    }));
    const tool = await messageHistoryAgent(reader(read));
    const signal = new AbortController().signal;
    const result = await execute(tool, {
      source: 'local',
      message_id: 'source-7',
      text_offset: 5,
      text_limit: 14,
      sender_id: 'sender-7',
      limit: 20,
    }, executionContext(signal));
    expect(read).toHaveBeenCalledExactlyOnceWith('test-session', {
      source: 'local',
      messageId: 'source-7',
      textOffset: 5,
      textLimit: 14,
      senderId: 'sender-7',
      limit: 20,
      signal,
    });
    expect(JSON.parse(result.output as string)).toMatchObject({
      untrusted: true,
      messages: [{ original: { message_id: 'source-7', text_length: 42 }, text_range: { next_offset: 19 } }],
    });
  });

  it('marks local JSON as untrusted and preserves a typed platform unsupported page without exhaustion', async () => {
    const read = vi.fn<ImMessageHistoryReader['read']>(async (_sessionId: string, query: ImHistoryQuery) => {
      if (query.source === 'platform') return { status: 'unsupported', detail: 'platform backfill is unavailable' };
      return localPage();
    });
    const tool = await messageHistoryAgent(reader(read));
    const local = await execute(tool, { source: 'local' });
    expect(JSON.parse(local.output as string)).toMatchObject({ untrusted: true, status: 'ok', source: 'local' });
    const platform = await execute(tool, { source: 'platform' });
    const data = JSON.parse(platform.output as string) as Record<string, unknown>;
    expect(data).toEqual({ untrusted: true, status: 'unsupported', detail: 'platform backfill is unavailable' });
    expect(data).not.toHaveProperty('end');
    expect(data).not.toHaveProperty('exhausted');
  });

  it('returns explicit unsupported when no history reader is available', async () => {
    const tool = await messageHistoryAgent();
    const result = await execute(tool, {});
    expect(JSON.parse(result.output as string)).toEqual({ status: 'unsupported', detail: 'This host has no IM history reader.' });
  });

  it('propagates a scope permission failure without falling back or retrying another group', async () => {
    const read = vi.fn<ImMessageHistoryReader['read']>(async () => { throw new Error('scope_permission_denied'); });
    const tool = await messageHistoryAgent(reader(read));
    await expect(execute(tool, { channel: 'group-a', topic_id: 'topic-a', source: 'local' })).rejects.toThrow('scope_permission_denied');
    expect(read).toHaveBeenCalledExactlyOnceWith('test-session', expect.objectContaining({ channel: 'group-a', topicId: 'topic-a' }));
    expect(read).toHaveBeenCalledTimes(1);
  });
});
