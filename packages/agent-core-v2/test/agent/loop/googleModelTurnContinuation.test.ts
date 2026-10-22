import { describe, expect, it, vi } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { WarningIssued } from '#/agent/profile/profileOps';
import type { ChatProvider } from '#/kosong/contract/provider';
import { GoogleGenAIChatProvider } from '#/kosong/provider/bases/google-genai/google-genai';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';

import { appService, createTestAgent, permissionModeServices, type TestAgentContext } from '../../harness';

const THINKING = 'deliberate signed thought';
const SIGNATURE = 'sig-fixture';
const PROMPT = 'Complete the task and report the result.';

describe('google model-turn continuation', () => {
  it('keeps a gemini-4 think-only result and does not enqueue another model turn', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), textChunk('should not run')]);
    const local = googleAgent('gemini-4-argon', generateContentStream);
    const warnings: WarningIssued[] = [];
    local.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 1 } });
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      expect(warnings.map((warning) => warning.code)).toContain('google-model-turn-prefill');
      expect(storedThink(local)).toEqual([{ type: 'think', think: THINKING, encrypted: SIGNATURE }]);
      expect(promptCount(local, PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });

  it('still continues a gemini-2.5 think-only result and echoes the signature', async () => {
    const generateContentStream = scriptedStream([thinkChunk(), textChunk('Visible answer')]);
    const local = googleAgent('gemini-2.5-flash', generateContentStream);
    const warnings: WarningIssued[] = [];
    local.get(IEventBus).subscribe(WarningIssued, (event) => warnings.push(event));
    try {
      const terminal = await (await prompt(local)).completion;
      expect(terminal).toMatchObject({ state: 'completed', result: { type: 'completed', steps: 2 } });
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(warnings.some((warning) => warning.code === 'google-model-turn-prefill')).toBe(false);
      const second = generateContentStream.mock.calls[1]?.[0];
      expect(contentsOf(second).at(-1)?.['role']).toBe('model');
      expect(signaturesOf(second)).toEqual([SIGNATURE]);
      expect(promptCount(local, PROMPT)).toBe(1);
      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

function googleAgent(model: string, generateContentStream: ReturnType<typeof vi.fn>): TestAgentContext {
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
    permissionModeServices('manual'),
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
  return local.contextData().history.flatMap((message) => message.role === 'assistant' ? message.content : []);
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
