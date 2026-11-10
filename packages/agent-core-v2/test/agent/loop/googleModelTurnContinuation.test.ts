import { createServer, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { IAgentProfileService } from '#/index';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { WarningIssued } from '#/agent/profile/profileOps';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { ChatProvider } from '#/kosong/contract/provider';
import { GoogleGenAIChatProvider } from '#/kosong/provider/bases/google-genai/google-genai';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import { appService, createTestAgent, permissionModeServices, type TestAgentContext } from '../../harness';

const THINKING = 'deliberate signed thought';
const SIGNATURE = 'sig-fixture';
const PROMPT = 'Complete the task and report the result.';

describe('google model-turn continuation', () => {
  it.each([true, false])('keeps the gemini-4 original-snapshot retry when explicit continuation is %s', async (thinkingOnlyContinuation) => {
    const generateContentStream = scriptedStream([thinkChunk(), textChunk('Visible answer')]);
    const local = googleAgent('gemini-4-argon', generateContentStream, 'manual', thinkingOnlyContinuation);
    const warnings: WarningIssued[] = [];
    const retries: TurnStepRetrying[] = [];
    local.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    local.get(IEventBus).subscribe(TurnStepRetrying, (event) => retries.push(event));
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(warnings.some((warning) => warning.code === 'google-model-turn-prefill')).toBe(false);
      expect(contentsOf(generateContentStream.mock.calls[1]?.[0])).toEqual(
        contentsOf(generateContentStream.mock.calls[0]?.[0]),
      );
      expect(contentsOf(generateContentStream.mock.calls[1]?.[0]).at(-1)?.['role']).toBe('user');
      expect(signaturesOf(generateContentStream.mock.calls[1]?.[0])).toEqual([]);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 0,
        errorName: 'GeminiThinkOnlyStop',
      });
      expect(retries[0]?.errorMessage.toLowerCase().includes('prefill')).toBe(false);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect(local.get(IAgentUsageService).status().currentTurn).toMatchObject({
        inputOther: 10,
        output: 5,
      });
      expect(promptCount(local, PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('continues a gemini-4 think into a tool call and keeps the stored signature', async () => {
    let toolRuns = 0;
    const generateContentStream = scriptedStream([
      thinkChunk(),
      toolChunk(),
      textChunk('Work saved.'),
    ]);
    const local = googleAgent('gemini-4-argon', generateContentStream, 'yolo');
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
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(toolRuns).toBe(1);
      expect(generateContentStream).toHaveBeenCalledTimes(3);
      expect(contentsOf(generateContentStream.mock.calls[1]?.[0])).toEqual(
        contentsOf(generateContentStream.mock.calls[0]?.[0]),
      );
      expect(contentsOf(generateContentStream.mock.calls[1]?.[0]).at(-1)?.['role']).toBe('user');
      expect(signaturesOf(generateContentStream.mock.calls[1]?.[0])).toEqual([]);
      expect(signaturesOf(generateContentStream.mock.calls[2]?.[0])).toContain(SIGNATURE);
      expect(contentsOf(generateContentStream.mock.calls[2]?.[0]).at(-1)?.['role']).toBe('user');
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
    } finally {
      await local.dispose();
    }
  });

  it('cancels the gemini-4 continuation instead of completing the turn', async () => {
    const generateContentStream = vi.fn(async () => {
      if (generateContentStream.mock.calls.length === 1) return thinkChunk()();
      return new Promise<AsyncGenerator<Record<string, unknown>>>(() => {});
    });
    const local = googleAgent('gemini-4-argon', generateContentStream);
    try {
      const handle = await prompt(local);
      await vi.waitFor(() => expect(generateContentStream).toHaveBeenCalledTimes(2));
      expect(local.get(IAgentLoopService).cancel()).toBe(true);
      const terminal = await handle.completion;
      expect(terminal).toMatchObject({ state: 'cancelled' });
      expect(generateContentStream).toHaveBeenCalledTimes(2);
    } finally {
      await local.dispose();
    }
  });

  it('stops a gemini-4 turn when the second response is still only thinking', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), thinkChunk(), textChunk('too late')]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: {
          code: 'provider.api_error',
          details: { google_stop: 'think_snapshot_exhausted', google_think_snapshot_retries: 1 },
        } },
      });
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(storedThink(local)).toEqual([
        { type: 'think', think: THINKING, encrypted: SIGNATURE },
        { type: 'think', think: THINKING, encrypted: SIGNATURE },
      ]);
    } finally {
      await local.dispose();
    }
  });

  it('fails an empty second snapshot response without a third request', async () => {
    const empty = async function* () {
      yield {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0 },
        responseId: 'resp-empty',
      };
    };
    const generateContentStream = scriptedStream([thinkChunk(), empty, textChunk('too late')]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(promptCount(local, 'Continue.')).toBe(0);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('stops a gemini-4 CONTINUATION instead of completing the turn', async () => {
    const generateContentStream = scriptedStream([continuationChunk(), textChunk('should not send')]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    const retries: TurnStepRetrying[] = [];
    local.get(IEventBus).subscribe(TurnStepRetrying, (event) => retries.push(event));
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: {
          code: 'provider.api_error',
          details: { google_stop: 'continuation_unsupported', raw_finish_reason: 'CONTINUATION' },
        } },
      });
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(retries).toEqual([]);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect(promptCount(local, PROMPT)).toBe(1);
    } finally {
      await local.dispose();
    }
  });

  it('still continues a gemini-2.5 think-only result and echoes the signature', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), textChunk('Visible answer')]);
    const local = googleAgent('gemini-2.5-flash', generateContentStream);
    const warnings: WarningIssued[] = [];
    const retries: TurnStepRetrying[] = [];
    local.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    local.get(IEventBus).subscribe(TurnStepRetrying, (event) => retries.push(event));
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(warnings.some((warning) => warning.code === 'google-model-turn-prefill')).toBe(false);
      const second = generateContentStream.mock.calls[1]?.[0];
      expect(contentsOf(second).at(-1)?.['role']).toBe('user');
      expect(promptCount(local, 'Continue.')).toBe(1);
      expect(signaturesOf(second)).toEqual([SIGNATURE]);
      expect(retries).toEqual([]);
      expect(promptCount(local, PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it.each(['gemini-2.5-flash', 'gemini-4-argon'])('fails grounded thinking without an answer instead of silently completing (%s)', async (model) => {
    const generateContentStream = scriptedStream([thinkChunk(true), textChunk('should not run')]);
    const local = googleAgent(model, generateContentStream);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({
        state: 'failed',
        result: { type: 'failed', error: { message: expect.stringMatching(/\S/) } },
      });
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(promptCount(local, 'Continue.')).toBe(0);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect((await local.persistedWireRecords()).filter((record) => record.type === 'usage.record')).toHaveLength(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('does not renew the snapshot budget after a tool step', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), toolChunk(), thinkChunk(), textChunk('too late')]);
    const local = googleAgent('gemini-4-argon', generateContentStream, 'yolo');
    let toolRuns = 0;
    local.get(IAgentToolRegistryService).register({
      name: 'FinishWork', description: 'Complete work.', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'FinishWork', execute: async () => { toolRuns += 1; return { output: 'saved' }; } }),
    });
    local.get(IAgentProfileService).update({ activeToolNames: ['FinishWork'] });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal.state).toBe('failed');
      expect(generateContentStream).toHaveBeenCalledTimes(3);
      expect(toolRuns).toBe(1);
      expect(promptCount(local, 'Continue.')).toBe(0);
      expect((await local.persistedWireRecords()).filter((record) => record.type === 'usage.record')).toHaveLength(3);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('stops after a failed snapshot retry even with infinite retry enabled', async () => {
    vi.stubEnv('KIKI_INFINITE_RETRY', 'true');
    const generateContentStream = vi.fn(async () => {
      if (generateContentStream.mock.calls.length === 1) return thinkChunk()();
      throw new Error('synthetic second request failure');
    });
    const local = googleAgent('gemini-4-argon', generateContentStream);
    try {
      const handle = await local.get(IAgentPromptService).enqueue({
        message: { role: 'user', content: [{ type: 'text', text: PROMPT }], toolCalls: [] },
        signal: AbortSignal.timeout(2_000),
      });
      const terminal = await handle.completion;
      expect(terminal.state).toBe('failed');
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(promptCount(local, 'Continue.')).toBe(0);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('retains visible text and unsigned thought through overlapping EOF retries', async () => {
    const generateContentStream = scriptedStream([
      googlePartsChunk([{ thought: true, text: THINKING }, { text: 'Visible an' }]),
      googlePartsChunk([{ thought: true, text: THINKING }, { text: 'Visible an' }]),
      async function* () {
        yield googleResponse([{ thought: true, text: THINKING }, { text: 'Visible an' }]);
        yield googleResponse([{ text: 'swer.' }], 'STOP');
      },
      textChunk('too late'),
    ]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(generateContentStream).toHaveBeenCalledTimes(3);
      expect(storedContent(local)).toEqual([
        { type: 'think', think: THINKING },
        { type: 'text', text: 'Visible answer.' },
      ]);
      expect(deltaValues(local, 'thinking.delta')).toEqual([THINKING]);
      expect(deltaValues(local, 'assistant.delta')).toEqual(['Visible an', 'swer.']);
      expect(discardEvents(local)).toEqual([]);
      expect(contentsOf(generateContentStream.mock.calls[1]?.[0])).toEqual(
        contentsOf(generateContentStream.mock.calls[0]?.[0]),
      );
      expect(contentsOf(generateContentStream.mock.calls[2]?.[0])).toEqual(
        contentsOf(generateContentStream.mock.calls[0]?.[0]),
      );
      for (const call of generateContentStream.mock.calls) expect(continuationConfigOf(call[0])).toBeUndefined();
      expect(signaturesOf(generateContentStream.mock.calls[1]?.[0])).toEqual([]);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('retracts only the interrupted tool delta and executes the final complete call once', async () => {
    let toolRuns = 0;
    const generateContentStream = scriptedStream([
      googlePartsChunk([
        { thought: true, text: THINKING, thoughtSignature: SIGNATURE },
        { text: 'Before tool' },
        { functionCall: { name: 'FinishWork', args: {} }, thoughtSignature: 'sig-call' },
      ]),
      googlePartsChunk([
        { thought: true, text: THINKING, thoughtSignature: SIGNATURE },
        { text: 'Before tool' },
        { functionCall: { name: 'FinishWork', args: {} }, thoughtSignature: 'sig-call' },
      ], 'STOP'),
      textChunk('Work saved.'),
    ]);
    const local = googleAgent('gemini-4-argon', generateContentStream, 'yolo');
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
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed' } });
      expect(generateContentStream).toHaveBeenCalledTimes(3);
      expect(toolRuns).toBe(1);
      expect(deltaValues(local, 'thinking.delta')).toEqual([THINKING]);
      expect(deltaValues(local, 'assistant.delta')).toEqual(['Before tool', 'Work saved.']);
      expect(discardEvents(local)).toEqual([expect.objectContaining({ partIds: [], toolCallIds: [expect.any(String)] })]);
      expect(wireLoopEvents(local, 'tool.call')).toHaveLength(1);
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect(storedTextParts(local)).toEqual(['Before tool', 'Work saved.']);
      expect(signaturesOf(generateContentStream.mock.calls[2]?.[0])).toEqual([SIGNATURE, 'sig-call']);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('keeps interrupted output and stops the continuation when the user cancels retry backoff', async () => {
    const generateContentStream = scriptedStream([
      googlePartsChunk([{ thought: true, text: THINKING, thoughtSignature: SIGNATURE }, { text: 'Keep this' }]),
      textChunk('must not send'),
    ]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    const subscription = local.get(IEventBus).subscribe(TurnStepRetrying, () => {
      local.get(IAgentLoopService).cancel();
    });
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'cancelled' });
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(storedContent(local)).toEqual([
        { type: 'think', think: THINKING, encrypted: SIGNATURE },
        { type: 'text', text: 'Keep this' },
      ]);
      expect(discardEvents(local)).toEqual([]);
      await local.expectResumeMatches();
    } finally {
      subscription.dispose();
      await local.dispose();
    }
  });

  it('carries a complete continuation token through an outer SDK retry without replaying visible output', async () => {
    const fixture = await googleHttpAgent('gemini-4-argon', (attempt, _body, response) => {
      if (attempt === 1) {
        writeGoogleSse(response, [{
          candidates: [{
            content: { role: 'model', parts: [
              { thought: true, text: THINKING, thoughtSignature: SIGNATURE },
              { text: 'Before' },
            ] },
            finishReason: 'CONTINUATION',
            continuationToken: 'token-resume',
          }],
        }]);
      } else if (attempt === 2) {
        response.socket?.destroy();
      } else {
        writeGoogleSse(response, [{
          candidates: [{ content: { role: 'model', parts: [{ text: ' after' }] }, finishReason: 'STOP' }],
        }]);
      }
    });
    try {
      const terminal = await (await prompt(fixture.local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(fixture.bodies).toHaveLength(3);
      const bodies = fixture.bodies.map(body => JSON.parse(body) as Record<string, unknown>);
      expect(bodies[0]?.['continuationToken']).toBeUndefined();
      expect(bodies[1]?.['continuationToken']).toBe('token-resume');
      expect(bodies[2]?.['continuationToken']).toBe('token-resume');
      expect(bodies[2]?.['contents']).toEqual(bodies[0]?.['contents']);
      expect(bodies[2]?.['systemInstruction']).toEqual(bodies[0]?.['systemInstruction']);
      expect(bodies[2]?.['generationConfig']).toEqual(bodies[0]?.['generationConfig']);
      expect(storedContent(fixture.local)).toEqual([
        { type: 'think', think: THINKING, encrypted: SIGNATURE },
        { type: 'text', text: 'Before after' },
      ]);
      expect(deltaValues(fixture.local, 'thinking.delta')).toEqual([THINKING]);
      expect(deltaValues(fixture.local, 'assistant.delta')).toEqual(['Before', ' after']);
      expect(discardEvents(fixture.local)).toEqual([]);
      await fixture.local.expectResumeMatches();
    } finally {
      await fixture.local.dispose();
      await fixture.close();
    }
  });

  it('falls back to a deduplicated snapshot after output advances beyond the latest token', async () => {
    const fixture = await googleHttpAgent('gemini-4-argon', (attempt, _body, response) => {
      if (attempt === 1) {
        writeGoogleSse(response, [{
          candidates: [{
            content: { role: 'model', parts: [
              { thought: true, text: THINKING, thoughtSignature: SIGNATURE },
              { text: 'Before' },
            ] },
            finishReason: 'CONTINUATION',
            continuationToken: 'token-resume',
          }],
        }]);
      } else if (attempt === 2) {
        writeGoogleSse(response, [googleResponse([{ text: ' after' }])]);
      } else {
        writeGoogleSse(response, [
          googleResponse([{ thought: true, text: THINKING, thoughtSignature: SIGNATURE }, { text: 'Before' }]),
          googleResponse([{ text: ' after' }]),
          googleResponse([{ text: '.' }], 'STOP'),
        ]);
      }
    });
    try {
      const terminal = await (await prompt(fixture.local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(fixture.bodies).toHaveLength(3);
      const bodies = fixture.bodies.map(body => JSON.parse(body) as Record<string, unknown>);
      expect(bodies[0]?.['continuationToken']).toBeUndefined();
      expect(bodies[1]?.['continuationToken']).toBe('token-resume');
      expect(bodies[2]?.['continuationToken']).toBeUndefined();
      expect(bodies[2]?.['contents']).toEqual(bodies[0]?.['contents']);
      expect(storedContent(fixture.local)).toEqual([
        { type: 'think', think: THINKING, encrypted: SIGNATURE },
        { type: 'text', text: 'Before after.' },
      ]);
      expect(deltaValues(fixture.local, 'thinking.delta')).toEqual([THINKING]);
      expect(deltaValues(fixture.local, 'assistant.delta')).toEqual(['Before', ' after', '.']);
      expect(discardEvents(fixture.local)).toEqual([]);
      await fixture.local.expectResumeMatches();
    } finally {
      await fixture.local.dispose();
      await fixture.close();
    }
  });

  it.each(['thoughtSignature', 'continuationToken', 'functionCall'] as const)('does not recover or execute a truncated %s', async field => {
    const toolRuns = vi.fn(async () => ({ output: 'must not run' }));
    const fixture = await googleHttpAgent('gemini-4-argon', (attempt, _body, response) => {
      if (attempt === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`${googleSseEvent(googleResponse([{ thought: true, text: THINKING }, { text: 'Before' }]))}${truncatedGoogleSse(field)}`);
      } else {
        writeGoogleSse(response, [googleResponse([{ text: 'BeforeRecovered' }], 'STOP')]);
      }
    }, 'yolo');
    fixture.local.get(IAgentToolRegistryService).register({
      name: 'FinishWork',
      description: 'Complete work.',
      parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'FinishWork', execute: toolRuns }),
    });
    fixture.local.get(IAgentProfileService).update({ activeToolNames: ['FinishWork'] });
    try {
      const terminal = await (await prompt(fixture.local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(fixture.bodies).toHaveLength(2);
      const bodies = fixture.bodies.map(body => JSON.parse(body) as Record<string, unknown>);
      expect(bodies[1]?.['continuationToken']).toBeUndefined();
      expect(bodies[1]?.['contents']).toEqual(bodies[0]?.['contents']);
      expect(JSON.stringify(bodies[1])).not.toContain('sig-truncated');
      expect(JSON.stringify(bodies[1])).not.toContain('token-truncated');
      expect(storedContent(fixture.local)).toEqual([
        { type: 'think', think: THINKING },
        { type: 'text', text: 'BeforeRecovered' },
      ]);
      expect(toolRuns).not.toHaveBeenCalled();
      expect(wireLoopEvents(fixture.local, 'tool.call')).toHaveLength(0);
      expect(discardEvents(fixture.local)).toEqual([]);
      await fixture.local.expectResumeMatches();
    } finally {
      await fixture.local.dispose();
      await fixture.close();
    }
  });
});

function googleAgent(
  model: string,
  generateContentStream: ReturnType<typeof vi.fn>,
  permission: 'manual' | 'yolo' = 'manual',
  thinkingOnlyContinuation?: boolean,
): TestAgentContext {
  const provider = new GoogleGenAIChatProvider({
    model,
    apiKey: 'gk-local-fixture',
    stream: true,
    clientFactory: () => ({ models: { generateContentStream } }) as never,
  });
  class FixtureRegistry extends ProtocolAdapterRegistry {
    override createChatProvider(): ChatProvider {
      return provider;
    }
  }
  const local = createTestAgent(
    permissionModeServices(permission),
    appService(IProtocolAdapterRegistry, new FixtureRegistry()),
    { initialConfig: {
      loopControl: { thinkingOnlyContinuation },
      retry: { policies: [{ match: 'APIConnectionError', backoff: 1 }] },
    } },
  );
  local.configureRuntimeModel({ type: 'google-genai', model, apiKey: 'gk-local-fixture' });
  return local;
}

function scriptedStream(chunks: Array<() => AsyncGenerator<Record<string, unknown>>>): ReturnType<typeof vi.fn> {
  const generateContentStream = vi.fn(async () => {
    const next = chunks[generateContentStream.mock.calls.length - 1];
    if (next === undefined) throw new Error('unexpected google call');
    return next();
  });
  return generateContentStream;
}

async function prompt(local: TestAgentContext, text = PROMPT) {
  return local.get(IAgentPromptService).enqueue({
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
  });
}

function storedThink(local: TestAgentContext): unknown[] {
  return local.contextData().history.flatMap((message) =>
    message.role === 'assistant' ? message.content.filter((part) => part.type === 'think') : []);
}

function promptCount(local: TestAgentContext, text: string): number {
  let count = 0;
  for (const message of local.contextData().history) {
    for (const part of message.content) {
      if (part.type === 'text' && part.text === text) count += 1;
    }
  }
  return count;
}

function contentsOf(params: unknown): Array<Record<string, unknown>> {
  const contents = (params as { contents?: unknown } | undefined)?.contents;
  if (!Array.isArray(contents)) return [];
  return contents.filter((content): content is Record<string, unknown> => typeof content === 'object' && content !== null);
}

function signaturesOf(params: unknown): string[] {
  const signatures: string[] = [];
  for (const content of contentsOf(params)) {
    const parts = content['parts'];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue;
      const signature = (part as { thoughtSignature?: unknown }).thoughtSignature;
      if (typeof signature === 'string') signatures.push(signature);
    }
  }
  return signatures;
}

function continuationChunk(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* continuation() {
    yield {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ thought: true, text: THINKING, thoughtSignature: SIGNATURE }],
        },
        finishReason: 'CONTINUATION',
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      responseId: 'resp-continuation',
    };
  };
}

function thinkChunk(grounded = false): () => AsyncGenerator<Record<string, unknown>> {
  return async function* think() {
    yield {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ thought: true, text: THINKING, thoughtSignature: SIGNATURE }],
        },
        finishReason: 'STOP',
        groundingMetadata: grounded ? { webSearchQueries: ['example query'] } : undefined,
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      responseId: 'resp-think',
    };
  };
}

function toolChunk(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* toolStream() {
    yield {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'FinishWork', args: {} }, thoughtSignature: 'sig-call' }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
      responseId: 'resp-tool',
    };
  };
}

function textChunk(text: string): () => AsyncGenerator<Record<string, unknown>> {
  return async function* textStream() {
    yield {
      candidates: [{
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
      responseId: 'resp-text',
    };
  };
}

function googlePartsChunk(parts: Array<Record<string, unknown>>, finishReason?: string): () => AsyncGenerator<Record<string, unknown>> {
  return async function* () {
    yield googleResponse(parts, finishReason);
  };
}

function googleResponse(parts: Array<Record<string, unknown>>, finishReason?: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
  };
}

function continuationConfigOf(params: unknown): unknown {
  return (params as { config?: Record<string, unknown> } | undefined)?.config?.['continuationToken'];
}

function storedContent(local: TestAgentContext): unknown[] {
  return local.contextData().history.flatMap(message => message.role === 'assistant' ? message.content : []);
}

function storedTextParts(local: TestAgentContext): string[] {
  return local.contextData().history.flatMap(message => message.role === 'assistant'
    ? message.content.flatMap(part => part.type === 'text' ? [part.text] : [])
    : []);
}

function deltaValues(local: TestAgentContext, name: string): string[] {
  return local.allEvents
    .filter(entry => entry.type === '[rpc]' && entry.event === name)
    .map(entry => (entry.args as { delta: string }).delta);
}

function discardEvents(local: TestAgentContext): Array<Record<string, unknown>> {
  return local.allEvents
    .filter(entry => entry.type === '[rpc]' && entry.event === 'response.attempt.discarded')
    .map(entry => entry.args as Record<string, unknown>);
}

function wireLoopEvents(local: TestAgentContext, eventType: string): Array<Record<string, unknown>> {
  return local.allEvents
    .filter(entry => entry.type === '[wire]' && entry.event === 'context.append_loop_event' &&
      (entry.args as { event?: { type?: string } }).event?.type === eventType)
    .map(entry => (entry.args as { event: Record<string, unknown> }).event);
}

async function googleHttpAgent(
  model: string,
  respond: (attempt: number, body: Record<string, unknown>, response: ServerResponse) => void,
  permission: 'manual' | 'yolo' = 'manual',
) {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      bodies.push(body);
      respond(bodies.length, JSON.parse(body) as Record<string, unknown>, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const provider = new GoogleGenAIChatProvider({ model, apiKey: 'gk-local-fixture', baseUrl, stream: true });
  class FixtureRegistry extends ProtocolAdapterRegistry {
    override createChatProvider(): ChatProvider {
      return provider;
    }
  }
  const local = createTestAgent(
    permissionModeServices(permission),
    appService(IProtocolAdapterRegistry, new FixtureRegistry()),
    { initialConfig: { retry: { policies: [{ match: 'APIConnectionError', backoff: 1 }] } } },
  );
  local.configureRuntimeModel({ type: 'google-genai', model, apiKey: 'gk-local-fixture', baseUrl });
  return {
    local,
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function writeGoogleSse(response: ServerResponse, payloads: Array<Record<string, unknown>>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(payloads.map(googleSseEvent).join(''));
}

function googleSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function truncatedGoogleSse(field: 'thoughtSignature' | 'continuationToken' | 'functionCall'): string {
  if (field === 'thoughtSignature') {
    return 'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"truncated thought","thoughtSignature":"sig-truncated';
  }
  if (field === 'continuationToken') {
    return 'data: {"candidates":[{"content":{"role":"model","parts":[]},"continuationToken":"token-truncated';
  }
  return 'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"FinishWork","args":{"value":1}';
}
