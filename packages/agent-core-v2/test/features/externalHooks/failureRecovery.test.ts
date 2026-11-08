import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createControlledPromise } from '@antfu/utils';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { AssistantDelta, TurnStepInterrupted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskNotified, TaskTerminated } from '#/agent/task/taskOps';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { PluginManager } from '#/app/plugin/manager';
import { writeInstalled } from '#/app/plugin/store';
import { APIConnectionError, APIProviderRateLimitError, APIStatusError, APIProviderQuotaExhaustedError, ChatProviderError, ambiguousRequestDelivery, markProviderEventError, noteExplicitUpstreamRetryDenial } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { HookDef } from '#/features/externalHooks/internal/types';
import { ISessionExecutionControl } from '#/session/executionControl/executionControl';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

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

  it('resets the one-continuation streak budget after completed model responses and stops on a consecutive repeat failure', async () => {
    const f = await fixture();
    try {
      let tools = 0;
      f.local.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save work', parameters: { type: 'object' }, resolveExecution: () => ({ approvalRule: 'SaveWork', execute: async () => { tools++; return { output: 'saved' }; } }) });
      f.local.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
      f.local.mockNextResponse({ type: 'function', name: 'SaveWork', id: 'save-call', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'First partial' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'function', name: 'SaveWork', id: 'save-call-2', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Second partial' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'text', text: 'Progress' }, { type: 'function', name: 'SaveWork', id: 'save-call-3', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Third partial' }], error: missingTerminal() });
      const error = missingTerminal();
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Final partial' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(continuations(f.local)).toHaveLength(3);
      expect(tools).toBe(3);
      expect(f.local.llmCalls).toHaveLength(7);
      expect(f.trigger.mock.calls.filter(([event]) => event === 'PostToolUse')).toHaveLength(3);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls).toHaveLength(4);
      expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 0, 0, 1]);
      expect(calls.map(([, args]) => args?.inputData?.['maxRecoveryAttempts'])).toEqual([1, 1, 1, 1]);
      expect(calls.map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true, true, false]);
    } finally { await f.dispose(); }
  });

  it('does not reset the streak budget on thinking-only, truncated, or tool-only step activity', async () => {
    const f = await fixture({ hooks: [alwaysContinue] });
    try {
      let tools = 0;
      f.local.get(IAgentToolRegistryService).register({ name: 'SaveWork', description: 'Save work', parameters: { type: 'object' }, resolveExecution: () => ({ approvalRule: 'SaveWork', execute: async () => { tools++; return { output: 'saved' }; } }) });
      f.local.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
      f.local.mockNextResponse({ type: 'function', name: 'SaveWork', id: 'save-call-1', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'First streak failure' }], error: missingTerminal() });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Truncated continuation' }], finishReason: 'truncated', rawFinishReason: 'max_tokens' });
      const loop = f.local.get(IAgentLoopService);
      loop.hooks.onDidFinishStep.register('enqueue-after-truncated', async (ctx, next) => {
        await next();
        if (ctx.finishReason === 'truncated') loop.enqueue(new ContinuationStepRequest());
      });
      const error = missingTerminal();
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Still in the same streak' }], error });
      expect(await (await prompt(f.local)).completion).toMatchObject({ state: 'failed', result: { error } });
      expect(tools).toBe(1);
      expect(continuations(f.local)).toHaveLength(1);
      const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
      expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
      expect(calls.map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, false]);
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
      expect(calls.map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, false]);
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

  it('resets the streak budget and suppresses task.failed notification when a resumed pendingStep completes before a second recoverable error', async () => {
    const parent = createTestAgent(permissionModeServices('yolo'));
    const f = await fixture();
    try {
      let tools = 0;
      const toolStarted = createControlledPromise<void>();
      const releaseTool = createControlledPromise<void>();
      f.local.get(IAgentToolRegistryService).register({
        name: 'WaitWork',
        description: 'Wait work',
        parameters: { type: 'object' },
        resolveExecution: () => ({
          approvalRule: 'WaitWork',
          execute: async () => {
            tools++;
            if (tools === 1) {
              toolStarted.resolve();
              await releaseTool;
              return { output: '', executionWait: { kind: 'task', taskIds: ['proc-wait-1'], startedAt: Date.now(), timeoutMs: 5_000 } };
            }
            return { output: 'saved after resume' };
          },
        }),
      });
      f.local.get(IAgentProfileService).update({ activeToolNames: ['WaitWork'] });

      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'First partial' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'function', name: 'WaitWork', id: 'wait-call-1', arguments: '{}' });
      f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Second partial after resume' }], error: missingTerminal() });
      f.local.mockNextResponse({ type: 'text', text: 'Final subagent receipt' });

      const parentNotifications: TaskNotified[] = [];
      const parentTerminated: TaskTerminated[] = [];
      const parentBus = parent.get(IEventBus);
      const sub1 = parentBus.subscribe(TaskNotified, (event) => parentNotifications.push(event));
      const sub2 = parentBus.subscribe(TaskTerminated, (event) => parentTerminated.push(event));

      try {
        const queued = await prompt(f.local);
        await toolStarted;
        const control = f.local.get(ISessionExecutionControl);
        await control.pause({ operationId: 'pause-pending-step' });
        releaseTool.resolve();
        await vi.waitFor(async () => expect(await control.read()).toMatchObject({ phase: 'paused' }));
        expect(control.resumePoint('main')?.pendingStep?.step).toBe(2);
        expect(f.local.get(IAgentLoopService).preservePausedForExit?.()).toBe(true);
        await f.local.get(IAgentLoopService).settled();

        const internalLoop = f.local.get(IAgentLoopService) as unknown as {
          parkedForExit: boolean;
          resumeExecution(point?: unknown): Promise<{ id: number; result: Promise<unknown> } | undefined>;
          pumpTurns(): void;
        };
        internalLoop.parkedForExit = false;
        const resumedTurn = await internalLoop.resumeExecution(control.resumePoint('main'));
        expect(resumedTurn).toBeDefined();
        await control.cancelPause({ operationId: 'release-pending-step', pauseOperationId: 'pause-pending-step' });
        internalLoop.pumpTurns();

        const parentTasks = parent.get(IAgentTaskService);
        const taskId = parentTasks.registerTask(new SubagentTask(
          {
            agentId: 'agent-child',
            profileName: 'implementer',
            completion: resumedTurn!.result.then((res) => {
              const r = res as { type: string; error?: unknown };
              if (r.type === 'failed') throw r.error ?? new Error('Subagent failed');
              return { result: 'Final subagent receipt' };
            }),
          },
          'subagent with resumed pendingStep',
          new AbortController(),
        ));

        parent.mockNextResponse({ type: 'text', text: 'Handled child completion.' });
        const taskInfo = await parentTasks.wait(taskId);
        await vi.waitFor(() => expect(parentNotifications).toHaveLength(1));
        await parent.get(IAgentLoopService).settled();
        expect(taskInfo).toMatchObject({ status: 'completed' });
        expect(parentNotifications.map((n) => n.notificationType)).toEqual(['task.completed']);
        expect(parentTerminated.map((t) => t.info.status)).toEqual(['completed']);
        expect(continuations(f.local)).toHaveLength(2);
        const calls = f.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
        expect(calls).toHaveLength(2);
        expect(calls.map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 0]);
        expect(calls.map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true]);
        void queued;
      } finally {
        sub1.dispose();
        sub2.dispose();
      }
    } finally {
      await f.dispose();
      await parent.dispose();
    }
  });

  it('keeps the agent turn active and suppresses premature failure events while an async StopFailure hook is deciding to continue', async () => {
    const f = await fixture();
    try {
      const hookEntered = createControlledPromise<void>();
      const releaseHook = createControlledPromise<void>();
      f.trigger.mockImplementation(async (event) => {
        if (event === 'StopFailure') {
          hookEntered.resolve();
          await releaseHook;
          return [{ action: 'allow', recovery: { action: 'continue', userMessage: '继续' } }];
        }
        return [];
      });

      const parent = createTestAgent(permissionModeServices('yolo'));
      const childController = new AbortController();
      const childErrors: AgentErrorEvent[] = [];
      const childTurnEnded: TurnEnded[] = [];
      const childStepInterrupted: TurnStepInterrupted[] = [];
      const parentNotifications: TaskNotified[] = [];
      const bus = f.local.get(IEventBus);
      const pBus = parent.get(IEventBus);
      const subs = [
        bus.subscribe(AgentErrorEvent, (e) => childErrors.push(e)),
        bus.subscribe(TurnEnded, (e) => childTurnEnded.push(e)),
        bus.subscribe(TurnStepInterrupted, (e) => childStepInterrupted.push(e)),
        pBus.subscribe(TaskNotified, (e) => parentNotifications.push(e)),
      ];

      try {
        f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial before slow hook' }], error: missingTerminal() });
        f.local.mockNextResponse({ type: 'text', text: 'Completed after slow hook' });
        parent.mockNextResponse({ type: 'text', text: 'Handled child completion.' });

        const handle = await runAgentTurn(
          { id: 'agent-child', accessor: { get: (id) => f.local.get(id) } },
          { kind: 'prompt', prompt: 'Run child task' },
          { signal: childController.signal },
        );
        const parentTasks = parent.get(IAgentTaskService);
        const taskId = parentTasks.registerTask(new SubagentTask(
          {
            agentId: 'agent-child',
            profileName: 'implementer',
            completion: handle.completion.then((r) => ({ result: r.summary, usage: r.usage })),
          },
          'slow hook recovery child',
          childController,
        ));

        await hookEntered;
        expect(f.local.get(IAgentLoopService).status().state).toBe('running');
        expect(f.local.get(IAgentActivityView).state().turn).toBeDefined();
        expect(childErrors).toEqual([]);
        expect(childTurnEnded).toEqual([]);
        expect(childStepInterrupted).toEqual([]);
        expect(parentTasks.getTask(taskId)?.status).toBe('running');
        expect(parentNotifications).toEqual([]);

        releaseHook.resolve();
        const finalInfo = await parentTasks.wait(taskId);
        expect(finalInfo).toMatchObject({ status: 'completed' });
        await vi.waitFor(() => expect(parentNotifications.map((n) => n.notificationType)).toEqual(['task.completed']));
        await parent.get(IAgentLoopService).settled();
        expect(childErrors).toEqual([]);
        expect(childStepInterrupted).toEqual([]);
        expect(childTurnEnded).toEqual([expect.objectContaining({ reason: 'completed' })]);
        expect((await f.local.persistedWireRecords()).some((r) => r.type === 'context.append_loop_event' && (r['event'] as { type?: string; finishReason?: string } | undefined)?.type === 'step.end' && (r['event'] as { finishReason?: string } | undefined)?.finishReason === 'error')).toBe(true);
      } finally {
        for (const sub of subs) sub.dispose();
        await parent.dispose();
      }
    } finally { await f.dispose(); }
  });

  it('aborts an in-flight slow StopFailure hook on user cancellation without appending continuation or emitting failure notifications', async () => {
    const f = await fixture();
    try {
      const hookEntered = createControlledPromise<void>();
      f.trigger.mockImplementation(async (event, options) => {
        if (event === 'StopFailure') {
          hookEntered.resolve();
          await new Promise<void>((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options?.signal?.reason ?? new Error('aborted')), { once: true });
          });
        }
        return [];
      });

      const errors: AgentErrorEvent[] = [];
      const ended: TurnEnded[] = [];
      const bus = f.local.get(IEventBus);
      const sub1 = bus.subscribe(AgentErrorEvent, (e) => errors.push(e));
      const sub2 = bus.subscribe(TurnEnded, (e) => ended.push(e));

      try {
        f.local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'Partial before hook cancel' }], error: missingTerminal() });
        const enqueued = await prompt(f.local);
        await hookEntered;
        f.local.get(IAgentLoopService).cancel();
        expect(await enqueued.completion).toMatchObject({ state: 'cancelled' });
        expect(continuations(f.local)).toEqual([]);
        expect(f.local.llmCalls).toHaveLength(1);
        expect(errors).toEqual([]);
        expect(ended).toEqual([expect.objectContaining({ reason: 'cancelled' })]);
      } finally {
        sub1.dispose();
        sub2.dispose();
      }
    } finally { await f.dispose(); }
  });
});
