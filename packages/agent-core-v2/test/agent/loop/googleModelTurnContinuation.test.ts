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
  it('retries a gemini-4 think-only STOP from the original snapshot', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), textChunk('Visible answer')]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
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
      expect(contentsOf(second).at(-1)?.['role']).toBe('model');
      expect(signaturesOf(second)).toEqual([SIGNATURE]);
      expect(retries).toEqual([]);
      expect(promptCount(local, PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

function googleAgent(
  model: string,
  generateContentStream: ReturnType<typeof vi.fn>,
  permission: 'manual' | 'yolo' = 'manual',
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

function thinkChunk(): () => AsyncGenerator<Record<string, unknown>> {
  return async function* think() {
    yield {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ thought: true, text: THINKING, thoughtSignature: SIGNATURE }],
        },
        finishReason: 'STOP',
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
