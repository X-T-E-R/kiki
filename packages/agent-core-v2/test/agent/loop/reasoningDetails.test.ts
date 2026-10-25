import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { reduceContextTranscript } from '#/agent/contextMemory/contextTranscript';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { generate } from '#/kosong/contract/generate';
import { isVacuousContentPart, mergeInPlace, type ContentPart, type Message } from '#/kosong/contract/message';
import type { ChatProvider } from '#/kosong/contract/provider';
import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import { appService, createTestAgent } from '../../harness';

const summary = { type: 'reasoning.summary', index: 0, id: 'summary-1', summary: 'A summary', format: 'example-v1', extra: { preserved: [1, null, true] } };
const encrypted = { type: 'reasoning.encrypted', index: 1, id: 'encrypted-1', data: 'opaque-ciphertext', format: 'example-v1', extra: { nonce: 'nonce-1' } };

function fixture(stream: boolean, responses: Array<Record<string, unknown>[]>) {
  let request = 0;
  const create = vi.fn<(body: unknown) => { withResponse(): Promise<{ data: unknown; response: Response }> }>(() => {
    const deltas = responses[request++] ?? [{ content: 'done' }];
    const data = stream ? (async function* () {
      for (const delta of deltas) yield {
        id: 'example-response', object: 'chat.completion.chunk', model: 'example-model', created: 0,
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      yield { id: 'example-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
    })() : {
      id: 'example-response', object: 'chat.completion', model: 'example-model', created: 0,
      choices: [{ index: 0, message: { role: 'assistant', ...deltas[0] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    };
    return { withResponse: async () => ({ data, response: new Response() }) };
  });
  const provider = new OpenAILegacyChatProvider({
    model: 'example-model', apiKey: 'YOUR_API_KEY', stream,
    clientFactory: () => ({ chat: { completions: { create } } }) as unknown as OpenAI,
  });
  return { create, provider };
}

function sentMessage(create: ReturnType<typeof vi.fn>, call: number) {
  const body = create.mock.calls[call]?.[0] as { messages?: Array<Record<string, unknown>> } | undefined;
  return body?.messages?.find((message) => message['role'] === 'assistant');
}

describe('reasoning details roundtrip', () => {
  it.each([true, false])('preserves opaque details through live context, persisted restore and a fresh provider request (stream=%s)', async (stream) => {
    const first = fixture(stream, [[{ reasoning_content: 'Primary thinking', reasoning_details: [summary, encrypted], content: 'answer' }]]);
    class FixtureRegistry extends ProtocolAdapterRegistry {
      override createChatProvider(): ChatProvider { return first.provider; }
    }
    const local = createTestAgent(appService(IProtocolAdapterRegistry, new FixtureRegistry()));
    try {
      const terminal = await (await local.get(IAgentPromptService).enqueue({
        message: { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      })).completion;
      expect(terminal.state).toBe('completed');
      expect(first.create).toHaveBeenCalledTimes(1);
      const history = local.contextData().history;
      const liveDetails = history.flatMap((message) => message.content.flatMap((part) => part.type === 'think' ? part.reasoningDetails ?? [] : []));
      expect(liveDetails).toEqual([summary, encrypted]);
      const visible = local.allEvents.filter((event) => event.event === 'thinking.delta').map((event) => (event.args as { delta?: string }).delta).join('');
      expect(visible).toBe('Primary thinking');
      const records = JSON.parse(JSON.stringify(await local.persistedWireRecords()));
      const cold = reduceContextTranscript(records).logicalEntries;
      expect(cold.flatMap((message) => message.content.flatMap((part) => part.type === 'think' ? part.reasoningDetails ?? [] : []))).toEqual([summary, encrypted]);
      const fresh = fixture(false, [[{ content: 'next answer' }]]);
      await generate(fresh.provider, '', [], cold.map((message) => ({ ...message, content: [...message.content], toolCalls: [...message.toolCalls] })));
      expect(sentMessage(fresh.create, 0)).toMatchObject({ reasoning_content: 'Primary thinking', reasoning_details: [summary, encrypted], content: 'answer' });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('keeps indexed summaries and encrypted fragments distinct and never duplicates a late primary dialect', async () => {
    const { provider, create } = fixture(true, [[
      { reasoning_details: [{ ...summary, summary: 'A ' }, { ...encrypted, data: 'opaque-' }] },
      { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: 'summary' }, { type: 'reasoning.encrypted', index: 1, data: 'ciphertext' }] },
      { reasoning: 'Primary thinking', content: 'answer' },
    ], [{ content: 'done' }]]);
    const parts: ContentPart[] = [];
    const result = await generate(provider, '', [], [], { onMessagePart: (part) => { if (part.type === 'think') parts.push(part); } });
    expect(parts.filter((part) => part.type === 'think' && part.hidden !== true).map((part) => part.type === 'think' ? part.think : '').join('')).toBe('Primary thinking');
    const cold = JSON.parse(JSON.stringify(result.message)) as Message;
    await generate(provider, '', [], [cold]);
    expect(sentMessage(create, 1)).toMatchObject({ reasoning: 'Primary thinking', reasoning_details: [summary, encrypted] });
    expect(sentMessage(create, 1)).not.toHaveProperty('reasoning_content');
  });

  it.each([true, false])('shows a details-only summary once and returns unknown objects without normalization (stream=%s)', async (stream) => {
    const unknown = { type: 'reasoning.future', index: 8, payload: { a: ['opaque', { b: 2 }] } };
    const { provider, create } = fixture(stream, [[{ reasoning_details: [summary, encrypted, unknown], content: 'answer' }], [{ content: 'done' }]]);
    const result = await generate(provider, '', [], []);
    expect(result.message.content.filter((part) => part.type === 'think' && part.hidden !== true).map((part) => part.type === 'think' ? part.think : '').join('')).toBe('A summary');
    await generate(provider, '', [], [JSON.parse(JSON.stringify(result.message))]);
    expect(sentMessage(create, 1)?.['reasoning_details']).toEqual([summary, encrypted, unknown]);
    expect(sentMessage(create, 1)).not.toHaveProperty('reasoning_content');
  });

  it('keeps one visible string dialect across chunks and echoes both original fields', async () => {
    const { provider, create } = fixture(true, [[
      { reasoning_content: 'Primary ' }, { reasoning: 'Secondary ' },
      { reasoning_content: 'thinking', reasoning: 'thinking', content: 'answer' },
    ], [{ content: 'done' }]]);
    const result = await generate(provider, '', [], []);
    expect(result.message.content.filter((part) => part.type === 'think' && part.hidden !== true).map((part) => part.type === 'think' ? part.think : '').join('')).toBe('Primary thinking');
    await generate(provider, '', [], [JSON.parse(JSON.stringify(result.message))]);
    expect(sentMessage(create, 1)).toMatchObject({ reasoning_content: 'Primary thinking', reasoning: 'Secondary thinking' });
  });

  it.each([true, false])('retains encrypted-only details without exposing ciphertext (stream=%s)', async (stream) => {
    const { provider, create } = fixture(stream, [[{ reasoning_details: [encrypted], content: 'answer' }], [{ content: 'done' }]]);
    const result = await generate(provider, '', [], []);
    expect(result.message.content.filter((part) => part.type === 'think' && part.hidden !== true)).toEqual([]);
    await generate(provider, '', [], [JSON.parse(JSON.stringify(result.message))]);
    expect(sentMessage(create, 1)?.['reasoning_details']).toEqual([encrypted]);
  });

  it('never merges different dialects, hidden summaries, or raw detail indexes and retains opaque-only content', () => {
    const target = { type: 'think' as const, think: 'a', reasoningKey: 'reasoning_content' };
    expect(mergeInPlace(target, { type: 'think', think: 'b', reasoningKey: 'reasoning' })).toBe(false);
    expect(mergeInPlace(target, { type: 'think', think: 'b', reasoningKey: 'reasoning_content', hidden: true })).toBe(false);
    expect(mergeInPlace(target, { type: 'think', think: 'b', reasoningDetails: [summary] })).toBe(false);
    expect(isVacuousContentPart({ type: 'think', think: '', hidden: true, reasoningDetails: [encrypted] })).toBe(false);
  });
});
