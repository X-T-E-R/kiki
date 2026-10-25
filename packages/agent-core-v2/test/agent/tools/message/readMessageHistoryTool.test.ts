import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IReadMessageHistoryTool, ReadMessageHistoryTool } from '#/agent/tools/message/readMessageHistoryTool';
import { IImMessageHistoryReader, type ImHistoryQuery, type ImLocalHistoryPage } from '#/app/bot/imMessageHistory';
import type { IImMessageHistoryReader as ImMessageHistoryReader } from '#/app/bot/imMessageHistory';
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
  ctx = createTestAgent(history === undefined ? [] : appServices((reg) => reg.defineInstance(IImMessageHistoryReader, history)));
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
    expect(validate({ unexpected: true })).toBe(false);
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
