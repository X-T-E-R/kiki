import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { IAgentProfileService } from '#/index';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { ChatProvider } from '#/kosong/contract/provider';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import { appService, createTestAgent, permissionModeServices, type TestAgentContext } from '../../harness';

const THINKING = 'deliberate signed thought';
const SIGNATURE = 'sig-example';
const THINK_OUTPUT = 1765;
const PROMPT = 'Complete the task and report the result.';

const NO_USABLE_ANSWER = 'Upstream completed without a usable answer. Please retry the request.';

describe('thinking-only continuation', () => {
  it('continues a signed think end_turn in the same turn until visible text', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), textStream('Visible answer')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([SIGNATURE]);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('assistant');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(local.get(IAgentUsageService).status().currentTurn).toMatchObject({
        inputOther: 30189 + 4,
        output: THINK_OUTPUT + 8,
        inputCacheRead: 20677,
        inputCacheCreation: 0,
      });
      expect((await local.persistedWireRecords()).some((record) => record.type === 'turn.step.retrying')).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues a subagent signed think without loop.empty_completion', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), textStream('Child result')]);
    const local = anthropicAgent(create, { parent: true });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([SIGNATURE]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['thrown', 'yielded'] as const)('retries a signed think followed by Messages api_error inside the same turn (%s)', async (delivery) => {
    const create = scriptedCreate([
      delivery === 'thrown' ? signedThinkThenThrow('api_error', 'upstream reset') : signedThinkThenYieldError('api_error', 'upstream reset'),
      textStream('Recovered answer'),
    ]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([SIGNATURE]);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('assistant');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(local.get(IAgentUsageService).status().currentTurn).toMatchObject({
        output: THINK_OUTPUT + 8,
        inputOther: 30189 + 4,
        inputCacheRead: 20677,
      });
      expect((await local.persistedWireRecords()).some((record) => record.type === 'turn.step.retrying')).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues an unsigned thinking-only end_turn to visible text without inventing a signature', async () => {
    const create = scriptedCreate([unsignedThinkStream(), textStream('Visible answer')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([{ thinking: 'silent completion', signature: undefined }]);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('assistant');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect((await local.persistedWireRecords()).some((record) => record.type === 'turn.step.retrying')).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues an unsigned thinking-only end_turn into one tool call', async () => {
    let toolRuns = 0;
    const create = scriptedCreate([unsignedThinkStream(), toolStream(), textStream('Work saved.')]);
    const local = anthropicAgent(create, { permission: 'yolo' });
    local.get(IAgentToolRegistryService).register({
      name: 'FinishWork',
      description: 'Complete work.',
      parameters: { type: 'object' },
      resolveExecution: () => ({
        approvalRule: 'FinishWork',
        execute: async () => {
          toolRuns += 1;
          return { output: 'work saved' };
        },
      }),
    });
    local.get(IAgentProfileService).update({ activeToolNames: ['FinishWork'] });
    try {
      const terminal = await (await prompt(local, 'Complete work.')).completion;
      expect(terminal).toMatchObject({ state: 'completed' });
      expect(toolRuns).toBe(1);
      expect(create).toHaveBeenCalledTimes(3);
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([{ thinking: 'silent completion', signature: undefined }]);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(promptCount(create.mock.calls[2]?.[0], 'Complete work.')).toBe(1);
      expect(blockTypeCount(create.mock.calls[2]?.[0], 'tool_use')).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('drops unsigned thinking on a known Anthropic model and still continues without a fabricated signature', async () => {
    const create = scriptedCreate([unsignedThinkStream(), textStream('Visible answer')]);
    const local = anthropicAgent(create, { model: 'claude-sonnet-4-5' });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('stops a repeated unsigned think loop at the step budget', async () => {
    const create = scriptedCreate([unsignedThinkStream(), unsignedThinkStream(), textStream('too late')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { maxStepsPerTurn: 2 } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { code: 'loop.max_steps_exceeded' } },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not continue whitespace-only thinking', async () => {
    const create = scriptedCreate([unsignedThinkStream('   '), textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues the gateway no-usable-answer event after a signed plan in the same turn', async () => {
    const create = scriptedCreate([gatewayNoUsableAnswerStream(), textStream('Recovered answer')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual(['sig-plan']);
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([{ thinking: 'plan', signature: 'sig-plan' }]);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('assistant');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(local.get(IAgentUsageService).status().currentTurn).toMatchObject({
        output: 5 + 8,
        inputOther: 11 + 4,
      });
      expect((await local.persistedWireRecords()).some((record) => record.type === 'turn.step.retrying')).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not retry a truly empty end_turn', async () => {
    const create = scriptedCreate([emptyStream(), textStream('should not run')]);
    const local = anthropicAgent(create, { parent: true });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { code: 'loop.empty_completion' } },
      });
      expect(create).toHaveBeenCalledTimes(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('fails a signed think followed by invalid_request without another model call', async () => {
    const create = scriptedCreate([signedThinkThenYieldError('invalid_request_error', 'Invalid signature in thinking block')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(create).toHaveBeenCalledTimes(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not spin when the continuation request rejects the signature', async () => {
    const create = vi.fn(async (..._args: unknown[]) => {
      if (create.mock.calls.length === 1) return signedThinkStream('end_turn')();
      throw AnthropicAPIError.generate(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' },
      }, 'Bad Request', new Headers());
    });
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([SIGNATURE]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('stops on the step budget instead of continuing signed thinks forever', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), signedThinkStream('end_turn'), textStream('too late')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { maxStepsPerTurn: 1 } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { code: 'loop.max_steps_exceeded' } },
      });
      expect(create).toHaveBeenCalledTimes(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('cancels the continuation request instead of completing the turn', async () => {
    const create = vi.fn(async (...args: unknown[]) => {
      const options = args[1] as { signal?: AbortSignal } | undefined;
      if (create.mock.calls.length === 1) return signedThinkStream('end_turn')();
      const signal = options?.signal;
      if (signal === undefined) throw new Error('continuation request has no abort signal');
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      });
    });
    const local = anthropicAgent(create);
    try {
      const handle = await prompt(local);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(local.get(IAgentLoopService).cancel()).toBe(true);
      const terminal = await handle.completion;
      expect(terminal).toMatchObject({ state: 'cancelled' });
      expect(create).toHaveBeenCalledTimes(2);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not execute an earlier tool again while continuing a later signed think', async () => {
    let toolRuns = 0;
    const create = scriptedCreate([toolStream(), signedThinkStream('end_turn'), textStream('Work saved.')]);
    const local = anthropicAgent(create, { permission: 'yolo' });
    local.get(IAgentToolRegistryService).register({
      name: 'FinishWork',
      description: 'Complete work.',
      parameters: { type: 'object' },
      resolveExecution: () => ({
        approvalRule: 'FinishWork',
        execute: async () => {
          toolRuns += 1;
          return { output: 'work saved' };
        },
      }),
    });
    local.get(IAgentProfileService).update({ activeToolNames: ['FinishWork'] });
    try {
      const terminal = await (await prompt(local, 'Complete work.')).completion;
      expect(terminal).toMatchObject({ state: 'completed' });
      expect(toolRuns).toBe(1);
      expect(create).toHaveBeenCalledTimes(3);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(signaturesOf(create.mock.calls[2]?.[0])).toEqual([SIGNATURE]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

function anthropicAgent(
  create: unknown,
  options: {
    readonly parent?: boolean;
    readonly permission?: 'manual' | 'yolo';
    readonly model?: string;
    readonly initialConfig?: { readonly loopControl?: { readonly maxStepsPerTurn: number } };
  } = {},
): TestAgentContext {
  const provider = new AnthropicChatProvider({
    model: options.model ?? 'example-model',
    apiKey: 'YOUR_API_KEY',
    baseUrl: 'https://api.example.test',
    clientFactory: () => ({ messages: { create } }) as unknown as import('@anthropic-ai/sdk').default,
  });
  class FixtureRegistry extends ProtocolAdapterRegistry {
    override createChatProvider(): ChatProvider {
      return provider;
    }
  }
  const local = createTestAgent(
    permissionModeServices(options.permission ?? 'manual'),
    appService(IProtocolAdapterRegistry, new FixtureRegistry()),
    { initialConfig: options.initialConfig },
  );
  if (options.parent === true) Reflect.set(local.get(IAgentScopeContext), 'parentAgentId', 'example-parent');
  return local;
}

function scriptedCreate(streams: Array<() => AsyncIterable<unknown>>): ReturnType<typeof vi.fn> {
  const create = vi.fn(async () => {
    const index = create.mock.calls.length - 1;
    const next = streams[index];
    if (next === undefined) {
      throw AnthropicAPIError.generate(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'unexpected model call' },
      }, 'Bad Request', new Headers());
    }
    return next();
  });
  return create;
}

async function prompt(local: TestAgentContext, text = PROMPT) {
  return local.get(IAgentPromptService).enqueue({
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
  });
}

function signaturesOf(body: unknown): string[] {
  return thinkingOf(body).flatMap((block) => block.signature === undefined ? [] : [block.signature]);
}

function thinkingOf(body: unknown): Array<{ thinking: string; signature: string | undefined }> {
  const blocks: Array<{ thinking: string; signature: string | undefined }> = [];
  for (const message of messagesOf(body)) {
    for (const block of blocksOf(message)) {
      if (block['type'] !== 'thinking' || typeof block['thinking'] !== 'string') continue;
      blocks.push({
        thinking: block['thinking'],
        signature: typeof block['signature'] === 'string' ? block['signature'] : undefined,
      });
    }
  }
  return blocks;
}

function blockTypeCount(body: unknown, type: string): number {
  let count = 0;
  for (const message of messagesOf(body)) {
    for (const block of blocksOf(message)) {
      if (block['type'] === type) count += 1;
    }
  }
  return count;
}

function tailRole(body: unknown): string | undefined {
  return messagesOf(body).at(-1)?.['role'] as string | undefined;
}

function promptCount(body: unknown, text: string): number {
  let count = 0;
  for (const message of messagesOf(body)) {
    for (const block of blocksOf(message)) {
      if (block['type'] === 'text' && block['text'] === text) count += 1;
    }
  }
  return count;
}

function messagesOf(body: unknown): Array<Record<string, unknown>> {
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? messages.filter((message): message is Record<string, unknown> => typeof message === 'object' && message !== null) : [];
}

function blocksOf(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message['content'])
    ? message['content'].filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
    : [];
}

function signedThinkStream(stop: 'end_turn' | 'none'): () => AsyncGenerator<Record<string, unknown>> {
  return async function* signedThink() {
    yield* thinkPrefix();
    yield {
      type: 'message_delta',
      delta: stop === 'end_turn' ? { stop_reason: 'end_turn' } : {},
      usage: { output_tokens: THINK_OUTPUT },
    };
    if (stop === 'end_turn') yield { type: 'message_stop' };
  };
}

function signedThinkThenThrow(type: string, message: string): () => AsyncGenerator<Record<string, unknown>> {
  return async function* signedThinkError() {
    yield* thinkPrefix();
    yield { type: 'message_delta', delta: {}, usage: { output_tokens: THINK_OUTPUT } };
    throw new AnthropicAPIError(undefined, {
      type: 'error',
      error: { type, message },
    }, undefined, new Headers(), type as 'api_error');
  };
}

function signedThinkThenYieldError(type: string, message: string): () => AsyncGenerator<Record<string, unknown>> {
  return async function* signedThinkError() {
    yield* thinkPrefix();
    yield { type: 'message_delta', delta: {}, usage: { output_tokens: THINK_OUTPUT } };
    yield { type: 'error', error: { type, message } };
  };
}

async function* thinkPrefix(): AsyncGenerator<Record<string, unknown>> {
  yield { type: 'message_start', message: { id: 'think-1', usage: { input_tokens: 30189, output_tokens: 0, cache_read_input_tokens: 20677 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } };
  yield { type: 'content_block_stop', index: 0 };
}

function unsignedThinkStream(think = 'silent completion'): () => AsyncGenerator<Record<string, unknown>> {
  return async function* unsigned() {
    yield { type: 'message_start', message: { id: 'unsigned-1', usage: { input_tokens: 10, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: think } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } };
    yield { type: 'message_stop' };
  };
}

function gatewayNoUsableAnswerStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* noUsableAnswer() {
    yield { type: 'message_start', message: { id: 'plan-1', usage: { input_tokens: 11, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-plan' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 5 } };
    yield { type: 'error', error: { type: 'api_error', message: NO_USABLE_ANSWER } };
  };
}

function emptyStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* empty() {
    yield { type: 'message_start', message: { id: 'empty-1', usage: { input_tokens: 20, output_tokens: 0 } } };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } };
    yield { type: 'message_stop' };
  };
}

function textStream(text: string): () => AsyncGenerator<Record<string, unknown>> {
  return async function* visibleText() {
    yield { type: 'message_start', message: { id: 'text-1', usage: { input_tokens: 4, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } };
    yield { type: 'message_stop' };
  };
}

function toolStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* tool() {
    yield { type: 'message_start', message: { id: 'tool-1', usage: { input_tokens: 6, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-work', name: 'FinishWork' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } };
    yield { type: 'message_stop' };
  };
}
