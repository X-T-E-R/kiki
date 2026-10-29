import Anthropic, { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
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
const CONTINUE = 'Continue.';

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
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
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

  it.each(['thrown', 'yielded'] as const)('does not continue a signed think followed by an unclassified api_error (%s)', async (delivery) => {
    const create = scriptedCreate([
      delivery === 'thrown' ? signedThinkThenThrow('api_error', 'upstream reset') : signedThinkThenYieldError('api_error', 'upstream reset'),
      textStream('should not run'),
    ]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: THINKING, encrypted: SIGNATURE });
      expect(local.contextData().history.some((message) =>
        message.role === 'user' && message.content.some((part) => part.type === 'text' && part.text === CONTINUE))).toBe(false);
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
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
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

  it('stops a repeated unsigned think loop after the single continuation', async () => {
    const create = scriptedCreate([unsignedThinkStream(), unsignedThinkStream(), textStream('too late')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: {
          code: 'loop.empty_completion',
          details: { thinking_only: 'continuation_exhausted' },
        } },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([]);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
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
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
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

  it.each([413, 429, 502] as const)('never retries a failed second call through projection, infinite retry, or step retry (%s)', async (status) => {
    vi.stubEnv('KIKI_INFINITE_RETRY', 'true');
    const create = vi.fn(async (..._args: unknown[]) => {
      if (create.mock.calls.length === 1) return signedThinkStream('end_turn')();
      throw AnthropicAPIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'synthetic second request failure' } }, 'Failure', new Headers());
    });
    const local = anthropicAgent(create);
    try {
      const handle = await local.get(IAgentPromptService).enqueue({
        message: { role: 'user', content: [{ type: 'text', text: PROMPT }], toolCalls: [] },
        signal: AbortSignal.timeout(2_000),
      });
      const terminal = await handle.completion;
      expect(terminal).toMatchObject({ state: 'failed', result: { type: 'failed', error: { statusCode: status } } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(signaturesOf(create.mock.calls[1]?.[0])).toEqual([SIGNATURE]);
      expect((await local.persistedWireRecords()).filter((record) => record.type === 'usage.record')).toHaveLength(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
      vi.unstubAllEnvs();
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

  it('keeps the explicit off choice and the stored signed thinking', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), textStream('should not run')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { thinkingOnlyContinuation: false } } });
    try {
      await (await prompt(local)).completion;
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['none', 'max_tokens', 'refusal', 'missing_stop'] as const)('does not continue thinking without a normal authoritative terminal (%s)', async (kind) => {
    const stream = kind === 'none' ? signedThinkStream('none') : async function* () {
      yield* thinkPrefix();
      if (kind !== 'missing_stop') yield { type: 'message_delta', delta: { stop_reason: kind }, usage: { output_tokens: THINK_OUTPUT } };
      if (kind === 'max_tokens' || kind === 'refusal') yield { type: 'message_stop' };
    };
    const create = scriptedCreate([stream, textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: THINKING, encrypted: SIGNATURE });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['antigravity_empty_response', 'antigravity_missing_terminal', 'antigravity_max_tokens', 'antigravity_safety', 'antigravity_malformed_function_call', 'antigravity_malformed_response', 'antigravity_upstream_terminal_error', 'antigravity_stream_read_error'])('does not continue the ineligible gateway code %s', async (code) => {
    const create = scriptedCreate([gatewayNoUsableAnswerStream(code), textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: 'plan', encrypted: 'sig-plan' });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['normal', 'classified'] as const)('does not obtain a third call after a second %s thinking-only response', async (second) => {
    const create = scriptedCreate([signedThinkStream('end_turn'), second === 'normal' ? signedThinkStream('end_turn') : gatewayNoUsableAnswerStream(), textStream('too late')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(create).toHaveBeenCalledTimes(2);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      expect(storedThinking(local)).toHaveLength(2);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('renews the one-continuation budget only in a new turn and keeps one usage fact per model call', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), textStream('first result'), signedThinkStream('end_turn'), textStream('second result')]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      await (await prompt(local, 'Another task.')).completion;
      expect(create).toHaveBeenCalledTimes(4);
      const facts = (await local.persistedWireRecords()).filter((record) => record.type === 'usage.record');
      expect(facts).toHaveLength(4);
      expect(local.get(IAgentUsageService).status().total?.output).toBe((THINK_OUTPUT + 8) * 2);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['normal', 'classified'] as const)('runs the real Messages SDK and requester path for %s thinking-only output', async (kind) => {
    const bodies: unknown[] = [];
    const streams = [kind === 'normal' ? signedThinkStream('end_turn') : gatewayNoUsableAnswerStream(), textStream('SDK result')];
    const sdkFetch: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected the SDK JSON request body');
      bodies.push(JSON.parse(init.body));
      const stream = streams[bodies.length - 1];
      if (stream === undefined) throw new Error('unexpected SDK HTTP attempt');
      const events: string[] = [];
      for await (const event of stream()) events.push(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
      return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const local = anthropicAgent(undefined, { sdkFetch });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(bodies).toHaveLength(2);
      expect(tailRole(bodies[1])).toBe('user');
      expect(promptCount(bodies[1], CONTINUE)).toBe(1);
      expect(thinkingOf(bodies[1])).toEqual([kind === 'normal'
        ? { thinking: THINKING, signature: SIGNATURE }
        : { thinking: 'plan', signature: 'sig-plan' }]);
      const history = local.contextData().history;
      const continuation = history.findIndex((message) => message.role === 'user' &&
        message.content.some((part) => part.type === 'text' && part.text === CONTINUE));
      expect(history[continuation - 1]?.role).toBe('assistant');
      expect(history[continuation + 1]?.content).toContainEqual({ type: 'text', text: 'SDK result' });
      const facts = (await local.persistedWireRecords()).filter((record) => record.type === 'usage.record');
      expect(facts).toHaveLength(2);
      expect(local.get(IAgentUsageService).status().total?.output).toBe((kind === 'normal' ? THINK_OUTPUT : 5) + 8);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['no_thought', 'refusal'] as const)('requires real SDK generate facts, not merely the classified code (%s)', async (kind) => {
    const stream = async function* () {
      if (kind === 'refusal') {
        yield* thinkPrefix();
        yield { type: 'content_block_start', index: 1, content_block: { type: 'refusal', refusal: 'Declined' } };
        yield { type: 'content_block_stop', index: 1 };
      }
      yield { type: 'error', error: { type: 'api_error', code: 'antigravity_thinking_only', message: NO_USABLE_ANSWER } };
    };
    const sdkFetch = vi.fn<typeof fetch>(async () => {
      const events: string[] = [];
      for await (const event of stream()) events.push(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
      return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const local = anthropicAgent(undefined, { sdkFetch });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(sdkFetch).toHaveBeenCalledTimes(1);
      expect(local.contextData().history.some((message) => message.role === 'user' &&
        message.content.some((part) => part.type === 'text' && part.text === CONTINUE))).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('echoes one trailing empty thinking signature on the next provider request', async () => {
    const stream = async function* () {
      yield { type: 'message_start', message: { id: 'answer-signed', usage: { input_tokens: 4, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Answer' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: SIGNATURE } };
      yield { type: 'content_block_stop', index: 1 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    };
    const create = scriptedCreate([stream, textStream('Next answer')]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      expect(storedThinking(local)).toEqual([{ type: 'think', think: '', encrypted: SIGNATURE }]);
      expect(local.allEvents.filter((event) => event.event === 'thinking.delta')).toEqual([]);
      await (await prompt(local, 'Next request')).completion;
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([{ thinking: '', signature: SIGNATURE }]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not treat a signature without real thinking as a continuation candidate', async () => {
    const stream = async function* () {
      yield { type: 'message_start', message: { id: 'signature-only', usage: { input_tokens: 4, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    };
    const create = scriptedCreate([stream, textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      await (await prompt(local)).completion;
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: '', encrypted: SIGNATURE });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not enqueue Continue when the initial thinking request is cancelled', async () => {
    const controller = new AbortController();
    const stream = async function* () {
      yield* thinkPrefix();
      controller.abort();
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: THINK_OUTPUT } };
      yield { type: 'message_stop' };
    };
    const create = scriptedCreate([stream, textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      const handle = await local.get(IAgentPromptService).enqueue({
        message: { role: 'user', content: [{ type: 'text', text: PROMPT }], toolCalls: [] },
        signal: controller.signal,
      });
      expect(await handle.completion).toMatchObject({ state: 'cancelled' });
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: THINKING, encrypted: SIGNATURE });
      expect(local.contextData().history.some((message) => message.role === 'user' &&
        message.content.some((part) => part.type === 'text' && part.text === CONTINUE))).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

describe('zero-output continuation', () => {
  it.each([undefined, false] as const)('does not continue an empty end_turn when the switch is %s', async (zeroOutputContinuation) => {
    const create = scriptedCreate([emptyStream(), textStream('should not run')]);
    const local = anthropicAgent(create, zeroOutputContinuation === undefined
      ? {}
      : { initialConfig: { loopControl: { zeroOutputContinuation } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(continued(local)).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('sends one Continue after an empty end_turn when the switch is on', async () => {
    const create = scriptedCreate([emptyStream(), textStream('Visible answer')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
      expect(promptCount(create.mock.calls[1]?.[0], PROMPT)).toBe(1);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      expect(blockTypeCount(create.mock.calls[1]?.[0], 'tool_use')).toBe(0);
      expect((await local.persistedWireRecords()).some((record) => record.type === 'turn.step.retrying')).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not send a second Continue when the follow-up is also empty', async () => {
    const create = scriptedCreate([emptyStream(), emptyStream(), textStream('too late')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { code: 'loop.empty_completion', name: 'ThinkingOnlyContinuationError' } },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not use the switch for signed thinking when thinking-only continuation is off', async () => {
    const create = scriptedCreate([signedThinkStream('end_turn'), textStream('should not run')]);
    const local = anthropicAgent(create, {
      initialConfig: { loopControl: { zeroOutputContinuation: true, thinkingOnlyContinuation: false } },
    });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(storedThinking(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect(continued(local)).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues an empty thinking container as zero output when the switch is on', async () => {
    const create = scriptedCreate([emptyThinkContainerStream(), textStream('Visible answer')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      expect(thinkingOf(create.mock.calls[1]?.[0])).toEqual([]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not use thinking-only continuation for an empty thinking container', async () => {
    const create = scriptedCreate([emptyThinkContainerStream(), textStream('should not run')]);
    const local = anthropicAgent(create);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(continued(local)).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not continue non-empty redacted thinking when the switch is on', async () => {
    const create = scriptedCreate([redactedThinkStream(), textStream('should not run')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(continued(local)).toBe(false);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: '', redacted: 'redacted-example' });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues a signature-only empty think as zero output when the switch is on', async () => {
    const create = scriptedCreate([signatureOnlyStream(), textStream('Visible answer')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(tailRole(create.mock.calls[1]?.[0])).toBe('user');
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      expect(storedThinking(local)).toContainEqual({ type: 'think', think: '', encrypted: SIGNATURE });
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not continue a signature-only stream that never reaches a normal stop', async () => {
    const stream = async function* () {
      yield { type: 'message_start', message: { id: 'signature-eof', usage: { input_tokens: 4, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } };
      yield { type: 'content_block_stop', index: 0 };
    };
    const create = scriptedCreate([stream, textStream('should not run')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(create).toHaveBeenCalledTimes(1);
      expect(continued(local)).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not use the switch for visible text', async () => {
    const create = scriptedCreate([textStream('Visible answer'), textStream('should not run')]);
    const local = anthropicAgent(create, { initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(continued(local)).toBe(false);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not use the switch for a tool call', async () => {
    let toolRuns = 0;
    const create = scriptedCreate([toolStream(), textStream('Work saved.')]);
    const local = anthropicAgent(create, { permission: 'yolo', initialConfig: { loopControl: { zeroOutputContinuation: true } } });
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
      expect(create).toHaveBeenCalledTimes(2);
      expect(promptCount(create.mock.calls[0]?.[0], CONTINUE)).toBe(0);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(0);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues one empty child completion when the switch is on', async () => {
    const create = scriptedCreate([emptyStream(), textStream('Child receipt')]);
    const local = anthropicAgent(create, { parent: true, initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('fails a second empty child completion after the one continuation', async () => {
    const create = scriptedCreate([emptyStream(), emptyStream(), textStream('too late')]);
    const local = anthropicAgent(create, { parent: true, initialConfig: { loopControl: { zeroOutputContinuation: true } } });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { code: 'loop.empty_completion' } },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(promptCount(create.mock.calls[1]?.[0], CONTINUE)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

function continued(local: TestAgentContext): boolean {
  return local.contextData().history.some((message) => message.role === 'user' &&
    message.content.some((part) => part.type === 'text' && part.text === CONTINUE));
}

function anthropicAgent(
  create: unknown,
  options: {
    readonly parent?: boolean;
    readonly permission?: 'manual' | 'yolo';
    readonly model?: string;
    readonly sdkFetch?: typeof fetch;
    readonly initialConfig?: { readonly loopControl?: { readonly maxStepsPerTurn?: number; readonly thinkingOnlyContinuation?: boolean; readonly zeroOutputContinuation?: boolean } };
  } = {},
): TestAgentContext {
  const provider = new AnthropicChatProvider({
    model: options.model ?? 'example-model',
    apiKey: 'YOUR_API_KEY',
    baseUrl: 'https://api.example.test',
    clientFactory: () => options.sdkFetch === undefined
      ? ({ messages: { create } }) as unknown as Anthropic
      : new Anthropic({ apiKey: 'YOUR_API_KEY', baseURL: 'https://api.example.test', fetch: options.sdkFetch, maxRetries: 0 }),
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

function storedThinking(local: TestAgentContext) {
  return local.contextData().history.flatMap((message) =>
    message.role === 'assistant' ? message.content.filter((part) => part.type === 'think') : []);
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

function gatewayNoUsableAnswerStream(code = 'antigravity_thinking_only'): () => AsyncGenerator<Record<string, unknown>> {
  return async function* noUsableAnswer() {
    yield { type: 'message_start', message: { id: 'plan-1', usage: { input_tokens: 11, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-plan' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 5 } };
    yield { type: 'error', error: { type: 'api_error', code, message: NO_USABLE_ANSWER } };
  };
}

function redactedThinkStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* redactedThink() {
    yield { type: 'message_start', message: { id: 'redacted-1', usage: { input_tokens: 4, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'redacted-example' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } };
    yield { type: 'message_stop' };
  };
}

function signatureOnlyStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* signatureOnly() {
    yield { type: 'message_start', message: { id: 'signature-only', usage: { input_tokens: 4, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } };
    yield { type: 'message_stop' };
  };
}

function emptyThinkContainerStream(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* emptyThinkContainer() {
    yield { type: 'message_start', message: { id: 'empty-think', usage: { input_tokens: 4, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } };
    yield { type: 'message_stop' };
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
