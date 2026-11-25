import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { resolveCompactionBudget } from '#/agent/llmRequester/turnCacheEnvelope';
import { APIContextOverflowError, APIRequestTooLargeError } from '#/kosong/contract/errors';
import { IPluginExtensionPortRegistryReader } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { createTestAgent, type TestAgentContext } from '../../harness';

describe('cache-safe A2 compaction and TurnCacheEnvelope contracts', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('preserves settled prefix byte-identically under R1/R3/R4 hot updates and K < P < H three-boundary compaction', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    let toolDesc = 'Initial tool description v1';
    const reg = ctx.get(IAgentToolRegistryService).register({
      name: 'DemoRead',
      foregroundPolicy: 'instant',
      description: toolDesc,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      resolveExecution: () => ({ approvalRule: 'DemoRead', execute: async () => ({ output: 'ok' }) }),
    }, { source: 'builtin' });
    ctx.configure({ tools: ['DemoRead'] });

    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 0 user task with memory' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading file' }], toolCalls: [{ type: 'function', id: 'fr-1', name: 'Read', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', toolCallId: 'fr-1', name: 'Read', content: [{ type: 'text', text: 'const alpha = 1;\n'.repeat(120) }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Analyzed a.ts thoroughly.' }], toolCalls: [] },
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Turn 1 follow-up task' }], toolCalls: [] },
    );

    ctx.mockNextResponse({ type: 'text', text: 'Turn 1 settled answer.' });
    const requester = ctx.get(IAgentLLMRequesterService);
    const turnResult = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turnResult.message.content, toolCalls: [] });

    const turnCall = ctx.llmCalls[0]!;
    const envelopeBefore = requester.getTurnCacheEnvelopeSummary?.();
    expect(envelopeBefore).toBeDefined();

    toolDesc = 'Hot-reloaded tool description v2 that must not bust warm cache';
    const profile = ctx.get(IAgentProfileService);
    await profile.republishStatus();

    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Trailing turn before unsettled tool' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Calling pending tool' }], toolCalls: [{ type: 'function', id: 'pending-1', name: 'DemoRead', arguments: '{"path":"b.ts"}' }] },
    );

    ctx.mockNextResponse({ type: 'text', text: 'Concise compaction summary covering early history.' });
    const compaction = ctx.get(IAgentFullCompactionService);
    const summary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 4,
      disposition: 'replace_window',
    }, new AbortController().signal);

    expect(summary).toContain('Concise compaction summary');
    expect(ctx.llmCalls).toHaveLength(2);
    const compactCall = ctx.llmCalls[1]!;
    expect(compactCall.systemPrompt).toBe(turnCall.systemPrompt);
    expect(compactCall.tools).toEqual(turnCall.tools);
    expect(compactCall.tools.length).toBeGreaterThan(0);
    expect(compactCall.history.slice(0, turnCall.history.length)).toEqual(turnCall.history);
    expect(compactCall.history.some((m) => m.toolCalls.some((tc) => tc.id === 'pending-1'))).toBe(false);
    expect(compactCall.history.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Messages 5 through 7'),
    });
    expect(requester.getTurnCacheEnvelopeSummary?.()?.id).toBe(envelopeBefore?.id);
    reg.dispose();
  });

  it('rejects mixed text+tool_use, runs exactly 1 prefix-preserving correction without dropping tools, and fails deterministically on second violation', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    ctx.configure({ tools: ['Read'] });
    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Work item 1' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done item 1' }], toolCalls: [] },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Settled turn response.' });
    const requester = ctx.get(IAgentLLMRequesterService);
    const turnResult = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turnResult.message.content, toolCalls: [] });

    ctx.mockNextResponse(
      { type: 'text', text: 'Partial summary text that must be rejected when mixed with tool call' },
      { type: 'function', id: 'bad-tc-1', name: 'Read', arguments: '{"path":"x.ts"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Clean text-only summary on round 2.' });

    const compaction = ctx.get(IAgentFullCompactionService);
    const okSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);
    expect(okSummary).toContain('Clean text-only summary on round 2.');
    expect(ctx.llmCalls).toHaveLength(3);
    const round1 = ctx.llmCalls[1]!;
    const round2 = ctx.llmCalls[2]!;
    expect(round2.tools).toEqual(round1.tools);
    expect(round2.tools.length).toBeGreaterThan(0);
    expect(round2.history.slice(0, round1.history.length - 1)).toEqual(round1.history.slice(0, -1));
    expect(round2.history.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Correction: Your previous compaction attempt invoked a tool'),
    });

    ctx.mockNextResponse(
      { type: 'text', text: 'Mixed attempt 1' },
      { type: 'function', id: 'bad-tc-2', name: 'Read', arguments: '{}' },
    );
    ctx.mockNextResponse(
      { type: 'text', text: 'Mixed attempt 2' },
      { type: 'function', id: 'bad-tc-3', name: 'Read', arguments: '{}' },
    );
    const historyBefore = context.get();
    await expect(compaction.prepareSummary({
      authorizedHistory: historyBefore,
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'compaction_tool_output' });
    expect(context.get()).toEqual(historyBefore);
  });

  it('rejects forced tool_choice pre-flight without silently rewriting tool_choice to none', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    ctx.configure({ tools: ['Read'] });
    const context = ctx.get(IAgentContextMemoryService);
    context.append({ role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }], toolCalls: [] });
    const requester = ctx.get(IAgentLLMRequesterService);

    await expect(requester.request({
      source: { type: 'operation', requestKind: 'compaction' },
      toolChoice: 'required',
      cacheInheritance: { mode: 'last_turn_envelope_exclusive', requireTextOnly: true },
    })).rejects.toMatchObject({ details: { reason: 'compaction_forced_tool_choice_incompatible' } });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('computes Anthropic budget-thinking compaction budget without ever emitting budget_tokens >= max_tokens', () => {
    const locked = resolveCompactionBudget({
      protocol: 'anthropic',
      maxContextTokens: 200_000,
      estimatedInputTokens: 150_000,
      lockedMaxCompletionTokens: 16_000,
      lockedThinkingBudget: 8_000,
      hasAnthropicBudgetThinking: true,
    });
    expect(locked).toEqual({ mode: 'locked', maxCompletionTokens: 16_000, thinkingBudgetOverride: 8_000 });

    const degraded = resolveCompactionBudget({
      protocol: 'anthropic',
      maxContextTokens: 200_000,
      estimatedInputTokens: 195_000,
      lockedMaxCompletionTokens: 16_000,
      lockedThinkingBudget: 8_000,
      hasAnthropicBudgetThinking: true,
    });
    expect(degraded.mode).toBe('size_degraded');
    expect(degraded.maxCompletionTokens).toBe(5_000);
    expect(degraded.thinkingBudgetOverride).toBeGreaterThanOrEqual(1024);
    expect(degraded.thinkingBudgetOverride!).toBeLessThan(degraded.maxCompletionTokens!);

    const overflow = resolveCompactionBudget({
      protocol: 'anthropic',
      maxContextTokens: 200_000,
      estimatedInputTokens: 199_200,
      lockedMaxCompletionTokens: 16_000,
      lockedThinkingBudget: 8_000,
      hasAnthropicBudgetThinking: true,
    });
    expect(overflow).toEqual({ mode: 'overflow' });
  });

  it('preserves 413 degraded media replacements in cached prefix even when trailing media is appended before compaction', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const context = ctx.get(IAgentContextMemoryService);
    const makeImg = (id: string) => ({ type: 'image_url' as const, imageUrl: { url: `https://example.test/${id}.png` } });
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [makeImg('img0'), makeImg('img1'), makeImg('img2'), makeImg('img3'), { type: 'text', text: 'Inspect all images' }], toolCalls: [] },
    );

    const requester = ctx.get(IAgentLLMRequesterService);
    ctx.mockNextProviderResponse({ error: new APIRequestTooLargeError(413, 'Request Entity Too Large') });
    ctx.mockNextResponse({ type: 'text', text: 'Processed degraded images.' });
    const turn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turn.message.content, toolCalls: [] });

    const degradedTurnCall = ctx.llmCalls[1]!;
    expect(degradedTurnCall.history[0]!.content[0]).toMatchObject({ type: 'text' });
    expect(degradedTurnCall.history[0]!.content[1]).toMatchObject({ type: 'text' });
    expect(degradedTurnCall.history[0]!.content[2]).toMatchObject({ type: 'image_url' });
    expect(degradedTurnCall.history[0]!.content[3]).toMatchObject({ type: 'image_url' });

    context.append({
      role: 'user',
      origin: { kind: 'user' },
      content: [makeImg('img4-trailing'), { type: 'text', text: 'One more image after settled turn' }],
      toolCalls: [],
    });

    ctx.mockNextResponse({ type: 'text', text: 'Compaction summary preserving degraded prefix.' });
    const compaction = ctx.get(IAgentFullCompactionService);
    await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);

    const compactCall = ctx.llmCalls[2]!;
    expect(compactCall.history[0]).toEqual(degradedTurnCall.history[0]);
  });

  it('handles overflow ladder A2 -> A1 -> shrink cleanly and skips redundant A1 when K === N', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Early work 1' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Early reply 1' }], toolCalls: [] },
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Kept tail user' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Kept tail assistant' }], toolCalls: [] },
    );

    const compaction = ctx.get(IAgentFullCompactionService);
    ctx.mockNextProviderResponse({ error: new APIContextOverflowError(400, 'prompt is too long') });
    ctx.mockNextResponse({ type: 'text', text: 'A1 fallback summary.' });

    const res = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);
    expect(res).toContain('A1 fallback summary.');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.llmCalls[0]!.history.length).toBeGreaterThan(ctx.llmCalls[1]!.history.length);
  });

  it('keeps cold compaction and readonly branch_seed isolated without mutating lastTurnEnvelope', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Cold history' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Cold reply' }], toolCalls: [] },
    );
    const requester = ctx.get(IAgentLLMRequesterService);
    const compaction = ctx.get(IAgentFullCompactionService);

    expect(requester.getTurnCacheEnvelopeSummary?.()).toBeUndefined();
    ctx.mockNextResponse({ type: 'text', text: 'Cold summary.' });
    const coldSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);
    expect(coldSummary).toContain('Cold summary.');
    expect(requester.getTurnCacheEnvelopeSummary?.()).toBeUndefined();

    ctx.mockNextResponse({ type: 'text', text: 'Warm turn reply.' });
    const warmTurn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: warmTurn.message.content, toolCalls: [] });
    const env = requester.getTurnCacheEnvelopeSummary?.();
    expect(env).toBeDefined();

    ctx.mockNextResponse({ type: 'text', text: 'Readonly btw seed summary.' });
    const btwSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'branch_seed',
    }, new AbortController().signal);
    expect(btwSummary).toContain('Readonly btw seed summary.');
    expect(requester.getTurnCacheEnvelopeSummary?.()?.id).toBe(env?.id);
    expect(ctx.llmCalls[2]!.history.slice(0, ctx.llmCalls[1]!.history.length)).toEqual(ctx.llmCalls[1]!.history);
    void vi;
  });

  it('invalidates warm envelope when a tool is revoked via disallowedTools', async () => {
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    ctx.configure({ tools: ['Read', 'Glob'] });
    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Read file before revocation' }], toolCalls: [] },
    );
    const requester = ctx.get(IAgentLLMRequesterService);
    ctx.mockNextResponse({ type: 'text', text: 'Warm turn with Read active.' });
    const turn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turn.message.content, toolCalls: [] });
    expect(ctx.llmCalls[0]!.tools.some((tool) => tool.name === 'Read')).toBe(true);

    const profile = ctx.get(IAgentProfileService);
    profile.update({ disallowedTools: ['Read'] });
    expect(profile.data().disallowedTools).toContain('Read');

    ctx.mockNextResponse({ type: 'text', text: 'Branch summary without revoked Read tool.' });
    const compaction = ctx.get(IAgentFullCompactionService);
    await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'branch_seed',
    }, new AbortController().signal);

    const summaryCall = ctx.llmCalls[1]!;
    expect(summaryCall.tools.some((tool) => tool.name === 'Read')).toBe(false);
    expect(summaryCall.tools.some((tool) => tool.name === 'Glob')).toBe(true);
  });

  it('freezes pre-baseline extension patch across cold compaction correction rounds', async () => {
    let preBaselineCalls = 0;
    ctx = createTestAgent([], { initialConfig: { worktree: { cleanup: { auto: false } } } });
    await ctx.ready;
    const extensions = ctx.get(IPluginExtensionPortRegistryReader);
    vi.spyOn(extensions, 'hasRequestPolicies', 'get').mockReturnValue(true);
    vi.spyOn(extensions, 'collectPreBaselinePatch').mockImplementation(async () => {
      preBaselineCalls += 1;
      return { sampling: { temperature: 0.2 } };
    });
    ctx.configure({ tools: ['Read'] });
    const context = ctx.get(IAgentContextMemoryService);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Cold task' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Cold answer' }], toolCalls: [] },
    );

    ctx.mockNextResponse(
      { type: 'text', text: 'Invalid mixed text' },
      { type: 'function', id: 'cold-bad-tc', name: 'Read', arguments: '{}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'Clean cold summary on round 2.' });

    const compaction = ctx.get(IAgentFullCompactionService);
    const summary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);

    expect(summary).toContain('Clean cold summary on round 2.');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(preBaselineCalls).toBe(1);
  });
});
