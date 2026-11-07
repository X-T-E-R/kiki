import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { AssistantDelta } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { PluginManager } from '#/app/plugin/manager';
import { writeInstalled } from '#/app/plugin/store';
import { APIConnectionError, APIProviderRateLimitError, APIStatusError, APIProviderQuotaExhaustedError, ChatProviderError, ambiguousRequestDelivery, markProviderEventError, noteExplicitUpstreamRetryDenial } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { HookDef } from '#/features/externalHooks/internal/types';

import { appService, createTestAgent, externalHookServices, permissionModeServices, type TestAgentContext, type TestAgentOptions } from '../../harness';
import { makeHookRunner, nodeCommand } from './runner-stub';

const pluginRoot = process.env['KIKI_RECOVERY_PLUGIN_ROOT'] ?? fileURLToPath(new URL('../../fixtures/plugins/argon-error-recovery/', import.meta.url));
const alwaysContinue: HookDef = {
  event: 'StopFailure',
  command: nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { recovery: { action: "continue", userMessage: "继续" } } }));'),
  timeout: 5,
};

async function fixture(options: { readonly hooks?: readonly HookDef[]; readonly config?: TestAgentOptions['initialConfig']; readonly create?: unknown } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'failure-recovery-plugin-'));
  await writeInstalled(home, { version: 1, plugins: [{ id: 'argon-error-recovery', root: pluginRoot, source: 'local-path', enabled: true, installedAt: '2026-01-01T00:00:00.000Z' }] });
  const manager = new PluginManager({ kimiHomeDir: home });
  await manager.load();
  expect(manager.get('argon-error-recovery')?.diagnostics).toEqual([]);
  expect(manager.get('argon-error-recovery')?.state).toBe('ok');
  const runner = makeHookRunner([], { pluginHooks: options.hooks ?? manager.enabledHooks() });
  const trigger = vi.spyOn(runner, 'trigger');
  const provider = new AnthropicChatProvider({
    model: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl: 'https://api.example.test',
    clientFactory: () => ({ messages: { create: options.create } }) as unknown as Anthropic,
  });
  class FixtureRegistry extends ProtocolAdapterRegistry {
    override createChatProvider(): ChatProvider { return provider; }
  }
  const local = createTestAgent(
    externalHookServices(runner), permissionModeServices('yolo'),
    options.create === undefined ? [] : appService(IProtocolAdapterRegistry, new FixtureRegistry()),
    { initialConfig: options.config },
  );
  return {
    local, trigger,
    async dispose() {
      await local.dispose();
      await runner.dispose();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function missingTerminal() {
  return markProviderEventError(new ChatProviderError('Upstream closed without a terminal event'), 'antigravity_missing_terminal');
}

function deniedMissingTerminal() {
  return noteExplicitUpstreamRetryDenial(missingTerminal(), {
    error: { type: 'api_error', code: 'antigravity_missing_terminal', retryable: false },
  });
}

function prompt(local: TestAgentContext) {
  return local.get(IAgentPromptService).enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] } });
}

function continuations(local: TestAgentContext) {
  return local.contextData().history.filter((message) => message.origin?.kind === 'system_trigger' && message.origin.name === 'failure_recovery_hook');
}

function textStream(text: string, fail = false) {
  return async function* () {
    yield { type: 'message_start', message: { id: 'fixture-response', usage: { input_tokens: 4, output_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text } };
    yield { type: 'content_block_stop', index: 0 };
    if (fail) {
      yield { type: 'error', error: { type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream closed without a terminal event' } };
      return;
    }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } };
    yield { type: 'message_stop' };
  };
}

describe('StopFailure continuation recovery', () => {
  it('loads the independent plugin and continues a real Messages failure with its partial assistant output', async () => {
    const streams = [textStream('Partial assistant answer.', true), textStream('Completed answer.')];
    const create = vi.fn(async (_params: unknown) => streams[create.mock.calls.length - 1]!());
    const f = await fixture({ create });
    try {
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(create).toHaveBeenCalledTimes(2);
      const history = f.local.contextData().history;
      const continued = history.indexOf(continuations(f.local)[0]!);
      expect(history[continued - 1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Partial assistant answer.' }] });
      expect(history[continued]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '继续' }] });
      expect(history[continued + 1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Completed answer.' }] });
      const request = create.mock.calls[1]?.[0] as { messages: unknown[] } | undefined;
      expect(JSON.stringify(request?.messages)).toContain('Partial assistant answer.');
      expect(JSON.stringify(request?.messages).split('继续')).toHaveLength(2);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(1);
      expect((await f.local.persistedWireRecords()).filter((record) => record.type === 'turn.ended')).toHaveLength(1);
      await f.local.expectResumeMatches();
    } finally { await f.dispose(); }
  });

  it('leaves an unconfigured failure unchanged', async () => {
    const f = await fixture({ hooks: [] });
    try {
      const error = missingTerminal();
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(continuations(f.local)).toEqual([]);
      expect(f.local.llmCalls).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it('lets the plugin recover only once and observes the final error only once', async () => {
    const f = await fixture();
    try {
      const finalError = missingTerminal();
      for (const error of [missingTerminal(), finalError]) f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error: finalError } });
      expect(continuations(f.local)).toHaveLength(1);
      expect(f.local.llmCalls).toHaveLength(2);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls).toHaveLength(2);
      expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Next turn partial' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'text', text: 'Next turn completed' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(continuations(f.local)).toHaveLength(2);
    } finally { await f.dispose(); }
  });

  it('enforces the host two-continuation budget even across a successful tool step', async () => {
    const f = await fixture({ hooks: [alwaysContinue] });
    try {
      let tools = 0;
      f.local.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save work', parameters: { type: 'object' }, resolveExecution: () => ({ approvalRule: 'SaveWork', execute: async () => { tools++; return { output: 'saved' }; } }) });
      f.local.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
      f.local.mockNextResponse({ type: 'function', name: 'SaveWork', id: 'save-call', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'First partial' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'text', text: 'Progress' }, { type: 'function', name: 'SaveWork', id: 'save-call-2', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Second partial' }], error: missingTerminal() });
      const error = missingTerminal();
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Final partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(continuations(f.local)).toHaveLength(2);
      expect(tools).toBe(2);
      expect(f.local.llmCalls).toHaveLength(5);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'PostToolUse')).toHaveLength(2);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls).toHaveLength(3);
      expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1, 2]);
      expect(calls.at(-1)?.[1]?.inputData?.['recoverable']).toBe(false);
    } finally { await f.dispose(); }
  });

  it('leaves native step retry ahead of plugin recovery', async () => {
    const f = await fixture({ config: { retry: { policies: [{ match: 'APIConnectionError', backoff: 0 }] } } });
    try {
      f.local.mockNextProviderResponse({ error: new APIConnectionError('Connection failed before output') });
      f.local.mockNextResponse({ type: 'text', text: 'Native retry completed' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(continuations(f.local)).toEqual([]);
      expect(f.local.llmCalls).toHaveLength(2);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('keeps a new user message available after the native retry budget without another same-request retry', async () => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { maxAttempts: 2, policies: [{ match: 'APIConnectionError', backoff: 0 }] } } });
    try {
      f.local.mockNextProviderResponse({ error: new APIConnectionError('First failure') });
      f.local.mockNextProviderResponse({ error: new APIConnectionError('Budget exhausted') });
      f.local.mockNextResponse({ type: 'text', text: 'Continued after the retry budget' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(f.local.llmCalls).toHaveLength(3);
      expect(continuations(f.local)).toHaveLength(1);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]?.inputData?.['recoverable']).toBe(true);
      expect(calls[0]?.[1]?.inputData?.['recoveryAttempts']).toBe(0);
      const details = (calls[0]?.[1]?.inputData?.['error'] as { details?: Record<string, unknown> } | undefined)?.details;
      expect(details).toMatchObject({ retry: false, retry_exhausted: true, retry_attempts: 2, retry_max_attempts: 2 });
      expect(details).not.toHaveProperty('upstream_retryable');
      expect(JSON.stringify(f.local.llmCalls[2])).toContain('继续');
    } finally { await f.dispose(); }
  });

  it('continues one explicit same-request denial and sends no third request when the new message fails', async () => {
    const f = await fixture();
    try {
      f.local.mockNextProviderResponse({ error: deniedMissingTerminal() });
      f.local.mockNextProviderResponse({ error: deniedMissingTerminal() });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed' });
      expect(f.local.llmCalls).toHaveLength(2);
      expect(continuations(f.local)).toHaveLength(1);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
      expect(calls.map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true]);
      expect(calls.map(([, args]) => (args?.inputData?.['error'] as { details?: { upstream_retryable?: unknown } }).details?.upstream_retryable)).toEqual([false, false]);
    } finally { await f.dispose(); }
  });

  it('does not replay a completed tool after an explicit same-request denial', async () => {
    const f = await fixture();
    try {
      let tools = 0;
      f.local.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save work', parameters: { type: 'object' }, resolveExecution: () => ({ approvalRule: 'SaveWork', execute: async () => { tools++; return { output: 'saved' }; } }) });
      f.local.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
      f.local.mockNextResponse({ type: 'function', name: 'SaveWork', id: 'save-call', arguments: '{}' });
      f.local.mockNextProviderResponse({ error: deniedMissingTerminal() });
      f.local.mockNextResponse({ type: 'text', text: 'Continued without replaying the tool' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(tools).toBe(1);
      expect(continuations(f.local)).toHaveLength(1);
      expect(f.local.llmCalls).toHaveLength(3);
    } finally { await f.dispose(); }
  });

  it.each([true, false, undefined])('permits a new message but no same-request retry for a gateway event with upstream retryable=%s', async (retryable) => {
    const f = await fixture({ hooks: [alwaysContinue] });
    try {
      const error = noteExplicitUpstreamRetryDenial(
        markProviderEventError(new ChatProviderError('terminal'), 'gateway_stream_terminal_error'),
        { error: { retryable, code: 'gateway_stream_terminal_error' } },
      );
      f.local.mockNextProviderResponse({ error });
      f.local.mockNextResponse({ type: 'text', text: 'Continued on the new message' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(f.local.llmCalls).toHaveLength(2);
      expect(continuations(f.local)).toHaveLength(1);
      expect(JSON.stringify(f.local.llmCalls[1])).toContain('继续');
      const input = f.trigger.mock.calls.find(([event]) => event === 'StopFailure')?.[1]?.inputData;
      expect(input).toMatchObject({ recoverable: true, errorDetails: { retry: false } });
    } finally { await f.dispose(); }
  });

  it.each(['unknown', 'not_executed'] as const)('keeps a new user message available after native retries for execution=%s', async (execution) => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { maxAttempts: 2, policies: [{ match: '.+', backoff: 0 }] } } });
    try {
      const error = () => markProviderEventError(new ChatProviderError('Upstream failure', undefined, { details: { execution } }), 'antigravity_missing_terminal');
      f.local.mockNextProviderResponse({ error: error() });
      f.local.mockNextProviderResponse({ error: error() });
      f.local.mockNextResponse({ type: 'text', text: 'Continued on the new message' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(f.local.llmCalls).toHaveLength(3);
      expect(continuations(f.local)).toHaveLength(1);
      expect(f.trigger.mock.calls.find(([event]) => event === 'StopFailure')?.[1]?.inputData?.['recoverable']).toBe(true);
    } finally { await f.dispose(); }
  });

  it('continues an exhausted ambiguous native model request with a new user message', async () => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { maxAttempts: 2, policies: [{ match: '.+', backoff: 0 }] } } });
    try {
      f.local.mockNextProviderResponse({ error: ambiguousRequestDelivery(new APIConnectionError('read dropped')) });
      f.local.mockNextProviderResponse({ error: ambiguousRequestDelivery(new APIConnectionError('read dropped again')) });
      f.local.mockNextResponse({ type: 'text', text: 'Continued on the new message' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(f.local.llmCalls).toHaveLength(3);
      expect(continuations(f.local)).toHaveLength(1);
      expect(f.trigger.mock.calls.find(([event]) => event === 'StopFailure')?.[1]?.inputData?.['recoverable']).toBe(true);
    } finally { await f.dispose(); }
  });

  it('retries an ordinary 429 and does not continue it', async () => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { maxAttempts: 2, policies: [{ match: '.+', backoff: 0 }] } } });
    try {
      f.local.mockNextProviderResponse({ error: new APIProviderRateLimitError('slow down') });
      f.local.mockNextResponse({ type: 'text', text: 'After the rate limit' });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'completed' });
      expect(f.local.llmCalls).toHaveLength(2);
      expect(continuations(f.local)).toEqual([]);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('does not retry or continue an HTTP 429 explicitly marked non-retryable', async () => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { policies: [{ match: '.+', backoff: 0 }] } } });
    try {
      const error = noteExplicitUpstreamRetryDenial(new APIProviderRateLimitError('slow down'), { error: { retryable: false } });
      f.local.mockNextProviderResponse({ error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(f.local.llmCalls).toHaveLength(1);
      expect(continuations(f.local)).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('does not let upstream retryable true recover an authentication failure', async () => {
    const f = await fixture({ hooks: [alwaysContinue] });
    try {
      const error = noteExplicitUpstreamRetryDenial(new APIStatusError(401, 'Sign in again'), { error: { retryable: true } });
      f.local.mockNextProviderResponse({ error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(f.local.llmCalls).toHaveLength(1);
      expect(continuations(f.local)).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('does not mistake a step-setup error for a failed model request', async () => {
    const f = await fixture({ hooks: [alwaysContinue], config: { retry: { policies: [{ match: 'ChatProviderError', retry: false }] } } });
    try {
      const error = missingTerminal();
      const loop = f.local.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.register('fixture-failure', async () => { throw error; });
      loop.enqueue(new ContinuationStepRequest());
      expect(await loop.run({ turnId: 0 })).toMatchObject({ type: 'failed', error });
      expect(f.local.llmCalls).toHaveLength(0);
      expect(continuations(f.local)).toEqual([]);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it('observes a later native-protected error even when the next step fails before it starts', async () => {
    const f = await fixture();
    try {
      const error = markProviderEventError(new ChatProviderError('Native continuation cannot proceed'), 'antigravity_thinking_only');
      f.local.get(IAgentLoopService).hooks.onWillBeginStep.register('fixture-second-failure', async (ctx, next) => {
        if (ctx.step === 2) throw error;
        await next();
      });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error: missingTerminal() });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(continuations(f.local)).toHaveLength(1);
      expect(f.local.llmCalls).toHaveLength(1);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]?.inputData?.['upstreamErrorCode']).toBe('antigravity_thinking_only');
      expect(calls[1]?.[1]?.inputData?.['recoverable']).toBe(false);
    } finally { await f.dispose(); }
  });

  it.each([
    new APIStatusError(401, 'Sign in again'),
    new APIStatusError(402, 'Payment required'),
    new APIProviderQuotaExhaustedError('Quota exhausted'),
    markProviderEventError(new ChatProviderError('Safety refusal'), 'antigravity_safety'),
  ])('rejects unconditional recovery for $name ($message)', async (error) => {
    const f = await fixture({ hooks: [alwaysContinue] });
    try {
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(continuations(f.local)).toEqual([]);
      expect(f.local.llmCalls).toHaveLength(1);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it('does not recover a nonmatching error code or a lookalike message', async () => {
    const f = await fixture();
    try {
      const error = markProviderEventError(new ChatProviderError('antigravity_missing_terminal'), 'antigravity_stream_read_error');
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed' });
      expect(continuations(f.local)).toEqual([]);
      expect(f.local.llmCalls).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it.each(['crash', 'invalid', 'throw'] as const)('preserves the original provider failure when the recovery hook fails (%s)', async (mode) => {
    const f = await fixture({ hooks: [{ event: 'StopFailure', command: mode === 'invalid' ? nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: { recovery: { action: "retry" } } }));') : nodeCommand('process.exit(1);'), timeout: 5 }] });
    try {
      if (mode === 'throw') {
        f.trigger.mockImplementation(async (event) => {
          if (event === 'StopFailure') throw new Error('Hook infrastructure failed');
          return [];
        });
      }
      const error = missingTerminal();
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial' }], error });
      const result = await (await prompt(f.local)).completion;
      expect(result).toMatchObject({ state: 'failed', result: { error } });
      if (result.result?.type === 'failed') expect(result.result.error).toBe(error);
      expect(continuations(f.local)).toEqual([]);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it('does not recover a cancelled model step or add a failure notification', async () => {
    const f = await fixture();
    try {
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial before cancellation' }], error: missingTerminal() });
      const subscription = f.local.get(IEventBus).subscribe(AssistantDelta, () => f.local.get(IAgentLoopService).cancel());
      try {
        expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'cancelled' });
      } finally { await subscription.dispose(); }
      expect(continuations(f.local)).toEqual([]);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'StopFailure')).toEqual([]);
    } finally { await f.dispose(); }
  });
});
