import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { createTestAgent, type TestAgentContext } from '../../harness';

describe('relay-v1 same-turn request prefix', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
  });

  it('keeps the recorded system prompt and tool hashes across a relay window boundary', async () => {
    ctx = createTestAgent({ initialConfig: { worktree: { cleanup: { auto: false } } } });
    ctx.configure({ modelCapabilities: { image_in: false, video_in: false, audio_in: false,
      thinking: false, tool_use: true, max_context_tokens: 128_000 } });
    ctx.context.append(
      { role: 'user', content: [{ type: 'text', text: 'Before the boundary' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'First conclusion' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }], toolCalls: [] },
    );
    const requester = ctx.get(IAgentLLMRequesterService);
    ctx.mockNextResponse({ type: 'text', text: 'before' });
    await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    ctx.context.applyCompaction({ summary: 'Working notes for the next window',
      compactedCount: 2, tokensBefore: 100, strategy: 'relay', shapeVersion: 1 });
    await ctx.get(IAgentProfileService).refreshSystemPrompt();
    ctx.mockNextResponse({ type: 'text', text: 'after' });
    await requester.request({ source: { type: 'turn', turnId: 1, step: 2 } });

    const requests = ctx.allEvents.filter((event) => event.type === '[wire]' && event.event === 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.args).toMatchObject({ kind: 'loop', systemPromptHash: expect.any(String), toolsHash: expect.any(String) });
    expect(requests[1]?.args).toMatchObject({ kind: 'loop', systemPromptHash: expect.any(String), toolsHash: expect.any(String) });
    expect((requests[1]?.args as { systemPromptHash: string }).systemPromptHash)
      .toBe((requests[0]?.args as { systemPromptHash: string }).systemPromptHash);
    expect((requests[1]?.args as { toolsHash: string }).toolsHash)
      .toBe((requests[0]?.args as { toolsHash: string }).toolsHash);
  });
});
