import { describe, expect, it, vi } from 'vitest';

import { applyContextCompactionRecord } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { resolveAutoCompact } from '#/agent/fullCompaction/autoCompact';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  IAgentFullCompactionService,
  ISessionTodoService,
} from '#/index';
import type { TestAgentContext } from '../../harness';
import { testAgent } from '../../harness';

const PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;

const CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const SIGNATURE = 'c2lnbmVkLWV4Y2hhbmdl';

function agent(): TestAgentContext {
  const ctx = testAgent();
  ctx.configure({ provider: PROVIDER, modelCapabilities: CAPABILITIES });
  return ctx;
}

function wireCounts(ctx: TestAgentContext, types: readonly string[]): Record<string, number> {
  const counts = Object.fromEntries(types.map((type) => [type, 0]));
  for (const event of ctx.newEvents()) {
    if (typeof event !== 'object' || event === null) continue;
    const candidate = event as { type?: unknown; event?: unknown };
    if (candidate.type !== '[wire]' || typeof candidate.event !== 'string') continue;
    const current = counts[candidate.event];
    if (current !== undefined) counts[candidate.event] = current + 1;
  }
  return counts;
}

function partCount(messages: readonly ContextMessage[], part: ContentPart): number {
  return messages.reduce((count, message) => count + message.content.filter((candidate) => candidate === part).length, 0);
}

function urlCount(messages: readonly ContextMessage[], url: string): number {
  return messages.reduce((count, message) => count + message.content.filter((part) => {
    if (part.type === 'image_url') return part.imageUrl.url === url;
    if (part.type === 'audio_url') return part.audioUrl.url === url;
    if (part.type === 'video_url') return part.videoUrl.url === url;
    return false;
  }).length, 0);
}

function compactionShape(messages: readonly ContextMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    origin: message.origin?.kind,
    content: message.content,
  }));
}

function takeCompactionApply(ctx: TestAgentContext): Record<string, unknown> {
  const apply = ctx.newEvents().find((event) => {
    if (typeof event !== 'object' || event === null) return false;
    const candidate = event as { type?: unknown; event?: unknown };
    return candidate.type === '[wire]' && candidate.event === 'context.apply_compaction';
  }) as { args: Record<string, unknown> } | undefined;
  expect(apply).toBeDefined();
  return apply!.args;
}

function appendDroppedToolMedia(ctx: TestAgentContext, media: readonly ContentPart[]): void {
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  ctx.context.append({
    role: 'assistant',
    content: [{ type: 'text', text: 'I will look it up.' }],
    toolCalls: [{ type: 'function', id: 'call_media', name: 'Lookup', arguments: '{}' }],
  });
  ctx.context.append({
    role: 'tool',
    content: [{ type: 'text', text: 'tool image body' }, ...media],
    toolCalls: [],
    toolCallId: 'call_media',
  });
  ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
}

async function holdFailedFlush() {
  const ctx = agent();
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
  const service = ctx.get(IAgentFullCompactionService);
  const dispatcher = (service as unknown as { dispatcher: { flush: () => Promise<void> } }).dispatcher;
  vi.spyOn(dispatcher, 'flush').mockImplementation(async () => {
    throw new Error('disk full');
  });
  expect(service.begin({ source: 'manual' })).toBe(true);
  await expect(service.compacting!.promise).rejects.toMatchObject({ name: 'CompactionPersistError' });
  return { ctx, service };
}

describe('relay gate fixtures', () => {
  it('relays a recoverable tool error and does not search by tool name', async () => {
    const ctx = agent();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will look it up.' }],
      toolCalls: [{ type: 'function', id: 'call_lookup', name: 'spill_debug', arguments: '{"query":"moon"}' }],
      source: { ref: 'h1_lookup_call', turnId: 3, step: 1 },
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup failed: exit code 1; distinctive body alpha-recoverable' }],
      toolCalls: [],
      toolCallId: 'call_lookup',
      isError: true,
      source: { ref: 'h1_lookup_result', turnId: 3, step: 1, toolCallId: 'call_lookup' },
    });
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual' })).toBe(true);
    const result = await service.compacting!.promise;
    const summary = ctx.context.get().find((message) => message.origin?.kind === 'compaction_summary');
    const text = summary?.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') ?? '';
    expect(result).toMatchObject({ strategy: 'relay' });
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['tool_error', 'requested:auto', 'strategy_source:default']));
    expect(result.reasonCodes).not.toEqual(expect.arrayContaining(['non_replayable_result', 'debug_chain', 'multiple_sources']));
    expect(ctx.llmCalls).toHaveLength(0);
    expect(text).toContain('HistoryRead {ref:"h1_lookup_result"}');
    expect(text).toContain('distinctive body alpha-recoverable');
    expect(text).not.toContain('query:"spill_debug"');
    expect(text).not.toContain("query:'spill_debug'");
  });

  it('keeps a 601-character user input verbatim and still marks a 120k input elided', async () => {
    const short = `SHORTREQ ${'y'.repeat(592)}`;
    expect(short).toHaveLength(601);
    const shortCtx = agent();
    shortCtx.appendExchange(1, short, 'old assistant one', 20);
    shortCtx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const shortService = shortCtx.get(IAgentFullCompactionService);
    expect(shortService.begin({ source: 'manual' })).toBe(true);
    const shortResult = await shortService.compacting!.promise;
    expect(shortResult).toMatchObject({ strategy: 'relay' });
    expect(shortResult.reasonCodes).not.toContain('user_input_elided');
    expect(shortCtx.llmCalls).toHaveLength(0);
    expect(shortCtx.compactHistory().some((message) => message.text === short)).toBe(true);

    const longText = `LONGREQ ${'x'.repeat(120_000)}`;
    const longCtx = agent();
    longCtx.appendExchange(1, longText, 'old assistant one', 20);
    longCtx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    longCtx.mockNextResponse({ type: 'text', text: 'Fallback summary for the oversized input.' });
    const longService = longCtx.get(IAgentFullCompactionService);
    expect(longService.begin({ source: 'manual' })).toBe(true);
    const longResult = await longService.compacting!.promise;
    expect(longResult).toMatchObject({ strategy: 'summarize', fallbackFrom: 'relay' });
    expect(longResult.reasonCodes).toContain('user_input_elided');
    expect(longCtx.llmCalls.length).toBeGreaterThan(0);
    expect(longCtx.compactHistory().some((message) => message.text === longText)).toBe(false);
  });

  it('keeps one user image, carries dropped tool media through a second relay, and keeps a shared URL', async () => {
    const sharedUrl = 'data:image/png;base64,shared';
    const userImage: ContentPart = { type: 'image_url', imageUrl: { url: sharedUrl, id: 'user-diagram' } };
    const toolImage: ContentPart = { type: 'image_url', imageUrl: { url: sharedUrl, id: 'tool-diagram' } };
    const audio: ContentPart = {
      type: 'audio_url',
      audioUrl: {
        url: 'kimi-file://file-audio-1',
        id: 'audio-1',
        attachment: { fileId: 'file-audio-1', mimeType: 'audio/wav', size: 128 },
      },
    };
    const ctx = agent();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.context.append({
      role: 'user',
      origin: { kind: 'user' },
      content: [{ type: 'text', text: 'keep this diagram' }, userImage, audio],
      toolCalls: [],
    });
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will look it up.' }],
      toolCalls: [{ type: 'function', id: 'call_media', name: 'Lookup', arguments: '{}' }],
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: 'tool image body' }, toolImage],
      toolCalls: [],
      toolCallId: 'call_media',
    });
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const before = ctx.context.get().slice();
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual' })).toBe(true);
    const first = await service.compacting!.promise;
    expect(first).toMatchObject({ strategy: 'relay' });
    expect(first.reasonCodes).not.toContain('non_text_result');
    expect(ctx.llmCalls).toHaveLength(0);
    const live = ctx.context.get();
    const summary = live.find((message) => message.origin?.kind === 'compaction_summary');
    expect(live.some((message) => message.role === 'tool')).toBe(false);
    expect(summary?.content.includes(userImage)).toBe(false);
    expect(summary?.content.includes(audio)).toBe(false);
    expect(summary?.content.includes(toolImage)).toBe(true);
    expect(partCount(live, userImage)).toBe(1);
    expect(partCount(live, audio)).toBe(1);
    expect(partCount(live, toolImage)).toBe(1);
    expect(urlCount(live, sharedUrl)).toBe(2);
    const replayed = applyContextCompactionRecord(before, takeCompactionApply(ctx));
    expect(compactionShape(replayed)).toEqual(compactionShape(live));
    expect(partCount(replayed, userImage)).toBe(1);
    expect(partCount(replayed, toolImage)).toBe(1);

    ctx.appendExchange(3, 'later user three', 'later assistant three', 90);
    const beforeSecond = ctx.context.get().slice();
    expect(service.begin({ source: 'manual' })).toBe(true);
    const second = await service.compacting!.promise;
    expect(second).toMatchObject({ strategy: 'relay' });
    expect(second.reasonCodes).not.toContain('non_text_result');
    expect(ctx.llmCalls).toHaveLength(0);
    const again = ctx.context.get();
    const nextSummary = again.find((message) => message.origin?.kind === 'compaction_summary');
    expect(again.filter((message) => message.origin?.kind === 'compaction_summary')).toHaveLength(1);
    expect(nextSummary?.content.includes(toolImage)).toBe(true);
    expect(nextSummary?.content.includes(userImage)).toBe(false);
    expect(partCount(again, userImage)).toBe(1);
    expect(partCount(again, audio)).toBe(1);
    expect(partCount(again, toolImage)).toBe(1);
    expect(urlCount(again, sharedUrl)).toBe(2);
    const replayedSecond = applyContextCompactionRecord(beforeSecond, takeCompactionApply(ctx));
    expect(compactionShape(replayedSecond)).toEqual(compactionShape(again));
    await ctx.expectResumeMatches();
  });

  it('falls back when carried media tokens exceed the reserved window and relays the same text without them', async () => {
    const wide = testAgent({
      initialConfig: { providers: {}, loopControl: { reservedContextSize: 0 } },
    });
    wide.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPABILITIES, max_context_tokens: 2_000_000 },
    });
    appendDroppedToolMedia(wide, []);
    const wideService = wide.get(IAgentFullCompactionService);
    expect(wideService.begin({ source: 'manual' })).toBe(true);
    const measured = await wideService.compacting!.promise;
    expect(measured).toMatchObject({ strategy: 'relay' });
    const windowTokens = measured.tokensAfter + 2_000;

    const control = testAgent({
      initialConfig: { providers: {}, loopControl: { reservedContextSize: 0 } },
    });
    control.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPABILITIES, max_context_tokens: windowTokens },
    });
    appendDroppedToolMedia(control, []);
    const controlService = control.get(IAgentFullCompactionService);
    expect(controlService.getAutoCompact()).toMatchObject({
      effectiveMaxContextTokens: windowTokens,
      reservedContextTokens: 0,
    });
    expect(controlService.begin({ source: 'manual' })).toBe(true);
    const controlResult = await controlService.compacting!.promise;
    expect(controlResult).toMatchObject({ strategy: 'relay' });
    expect(controlResult.fallbackFrom).toBeUndefined();
    expect(controlResult.tokensAfter).toBeLessThanOrEqual(windowTokens);
    expect(control.llmCalls).toHaveLength(0);

    const images: ContentPart[] = Array.from({ length: 3 }, (_, index) => ({
      type: 'image_url',
      imageUrl: { url: `https://media.example/dropped-${String(index)}`, id: `dropped-${String(index)}` },
    }));
    const crowded = testAgent({
      initialConfig: { providers: {}, loopControl: { reservedContextSize: 0 } },
    });
    crowded.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPABILITIES, max_context_tokens: windowTokens },
    });
    crowded.mockNextResponse({ type: 'text', text: 'Media budget fallback summary.' });
    appendDroppedToolMedia(crowded, images);
    const crowdedService = crowded.get(IAgentFullCompactionService);
    expect(crowdedService.begin({ source: 'manual' })).toBe(true);
    const crowdedResult = await crowdedService.compacting!.promise;
    expect(crowdedResult).toMatchObject({ strategy: 'summarize', fallbackFrom: 'relay' });
    expect(crowdedResult.reasonCodes).toContain('projected_too_large');
    expect(crowdedResult.reasonCodes).not.toContain('non_text_result');
    expect(crowded.llmCalls.length).toBeGreaterThan(0);
  });

  it('carries an unreviewed handoff and a new user requirement without forging review', async () => {
    const ctx = agent();
    ctx.context.append({
      role: 'user',
      origin: { kind: 'compaction_summary' },
      content: [{ type: 'text', text: 'Earlier handoff without review.' }],
      toolCalls: [],
      source: { ref: 'handoff-prev' },
    });
    ctx.appendExchange(1, 'Ship the blue cover, not the red one.', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'manual' })).toBe(true);
    const result = await service.compacting!.promise;
    const text = ctx.context.get().flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
    expect(result).toMatchObject({ strategy: 'relay' });
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['notes_missing', 'handoff_unreviewed']));
    expect(ctx.llmCalls).toHaveLength(0);
    expect(ctx.compactHistory().some((message) => message.text === 'Ship the blue cover, not the red one.')).toBe(true);
    expect(text).toContain('HistoryRead {ref:"handoff-prev"}');
    expect(text).toContain('reviewed not confirmed');
    expect(ctx.get(ISessionTodoService).getNotes('main').meta?.reviewedMessageId).toBeUndefined();
  });

  it('keeps an explicit summarize request on the model and an explicit relay instruction in the handoff', async () => {
    const summarized = agent();
    summarized.appendExchange(1, 'old user one', 'old assistant one', 20);
    summarized.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    summarized.mockNextResponse({ type: 'text', text: 'Explicit model summary.' });
    const summarize = summarized.get(IAgentFullCompactionService);
    expect(summarize.begin({ source: 'manual', strategy: 'summarize' })).toBe(true);
    const summarizedResult = await summarize.compacting!.promise;
    expect(summarizedResult).toMatchObject({ strategy: 'summarize' });
    expect(summarizedResult.reasonCodes).toEqual(expect.arrayContaining(['requested:summarize', 'strategy_source:request']));
    expect(summarized.llmCalls).toHaveLength(1);

    const relayed = agent();
    relayed.appendExchange(1, 'old user one', 'old assistant one', 20);
    relayed.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    relayed.mockNextResponse({ type: 'text', text: 'This model call must not happen.' });
    const relay = relayed.get(IAgentFullCompactionService);
    expect(relay.begin({ source: 'manual', strategy: 'relay', instruction: 'Keep the deployment window.' })).toBe(true);
    const relayResult = await relay.compacting!.promise;
    const relayText = relayed.context.get().find((message) => message.origin?.kind === 'compaction_summary')?.content
      .flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') ?? '';
    expect(relayResult).toMatchObject({ strategy: 'relay' });
    expect(relayResult.reasonCodes).toEqual(expect.arrayContaining(['requested:relay', 'strategy_source:request']));
    expect(relayed.llmCalls).toHaveLength(0);
    expect(relayText).toContain('## Compaction instruction\nKeep the deployment window.');

    const instructed = agent();
    instructed.appendExchange(1, 'old user one', 'old assistant one', 20);
    instructed.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    instructed.mockNextResponse({ type: 'text', text: 'Instruction stayed with the summarizer.' });
    const auto = instructed.get(IAgentFullCompactionService);
    expect(auto.begin({ source: 'manual', instruction: 'Summarize the deployment window.' })).toBe(true);
    const autoResult = await auto.compacting!.promise;
    expect(autoResult).toMatchObject({ strategy: 'summarize', fallbackFrom: 'relay' });
    expect(autoResult.reasonCodes).toContain('manual_instruction');
    expect(instructed.llmCalls).toHaveLength(1);
    expect(instructed.llmCalls[0]?.history.some((message) => message.content.some((part) => part.type === 'text' && part.text.includes('Summarize the deployment window.')))).toBe(true);
  });

  it('keeps a signed tool exchange through relay, restore, and the next request', async () => {
    const ctx = agent();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'old user three', 'old assistant three', 60);
    ctx.context.append({
      role: 'user',
      origin: { kind: 'user' },
      content: [{ type: 'text', text: 'sign the last exchange' }],
      toolCalls: [],
    });
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'calling lookup' }],
      toolCalls: [{
        type: 'function',
        id: 'call_signed',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
        extras: { thought_signature_b64: SIGNATURE },
      }],
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup result body alpha-signed' }],
      toolCalls: [],
      toolCallId: 'call_signed',
    });
    const service = ctx.get(IAgentFullCompactionService);
    expect(service.begin({ source: 'auto' })).toBe(true);
    const result = await service.compacting!.promise;
    expect(result).toMatchObject({ strategy: 'relay' });
    expect(ctx.llmCalls).toHaveLength(0);
    const signed = (): ContextMessage | undefined => ctx.context.get().find((message) => message.toolCalls.some((call) => call.id === 'call_signed'));
    expect(signed()?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: SIGNATURE });
    await ctx.expectResumeMatches();
    expect(signed()?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: SIGNATURE });
    ctx.mockNextResponse({ type: 'text', text: 'Continued after the signed exchange.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue with the signed exchange' }] });
    await ctx.untilTurnEnd();
    const next = ctx.llmCalls.at(-1);
    const carried = next?.history.find((message) => message.toolCalls.some((call) => call.id === 'call_signed'));
    expect(carried?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: SIGNATURE });
  });

  it('retries the same relay result after flush fails and does not announce success early', async () => {
    const ctx = agent();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const service = ctx.get(IAgentFullCompactionService);
    const dispatcher = (service as unknown as { dispatcher: { flush: () => Promise<void> } }).dispatcher;
    const original = dispatcher.flush.bind(dispatcher);
    let blocked = true;
    const flush = vi.spyOn(dispatcher, 'flush').mockImplementation(async () => {
      if (blocked) throw new Error('disk full');
      return original();
    });
    expect(service.begin({ source: 'manual' })).toBe(true);
    const active = service.compacting!;
    const first = active.promise;
    await expect(first).rejects.toMatchObject({ name: 'CompactionPersistError' });
    blocked = false;
    expect(service.isCompacting()).toBe(true);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel'])).toEqual({
      'context.apply_compaction': 1,
      'full_compaction.complete': 0,
      'full_compaction.cancel': 0,
    });
    expect(service.begin({ source: 'manual', strategy: 'summarize' })).toBe(true);
    expect(service.compacting).toBe(active);
    expect(active.promise).not.toBe(first);
    const result = await active.promise;
    flush.mockRestore();
    expect(result).toMatchObject({ strategy: 'relay' });
    expect(result.fallbackFrom).toBeUndefined();
    expect(ctx.llmCalls).toHaveLength(0);
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel'])).toEqual({
      'context.apply_compaction': 0,
      'full_compaction.complete': 1,
      'full_compaction.cancel': 0,
    });
    await ctx.expectResumeMatches();
  });

  it('releases the quiescence lease on cancel after a failed flush without applying again', async () => {
    const { ctx, service } = await holdFailedFlush();
    const summary = ctx.context.get().find((message) => message.origin?.kind === 'compaction_summary');
    const length = ctx.context.get().length;
    expect(summary).toBeDefined();
    expect(service.isCompacting()).toBe(true);
    expect(ctx.get(IAgentLoopService).tryAcquireQuiescence()).toBeUndefined();
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel', 'compaction.cancelled'])).toEqual({
      'context.apply_compaction': 1,
      'full_compaction.complete': 0,
      'full_compaction.cancel': 0,
      'compaction.cancelled': 0,
    });
    service.cancel();
    const lease = ctx.get(IAgentLoopService).tryAcquireQuiescence();
    expect(lease).toBeDefined();
    await lease?.dispose();
    expect(service.isCompacting()).toBe(false);
    expect(ctx.context.get()).toHaveLength(length);
    expect(ctx.context.get().find((message) => message.origin?.kind === 'compaction_summary')).toBe(summary);
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel', 'compaction.cancelled'])).toEqual({
      'context.apply_compaction': 0,
      'full_compaction.complete': 0,
      'full_compaction.cancel': 0,
      'compaction.cancelled': 0,
    });
  });

  it('releases the quiescence lease on dispose after a failed flush without applying again', async () => {
    const { ctx, service } = await holdFailedFlush();
    const summary = ctx.context.get().find((message) => message.origin?.kind === 'compaction_summary');
    const length = ctx.context.get().length;
    expect(summary).toBeDefined();
    expect(ctx.get(IAgentLoopService).tryAcquireQuiescence()).toBeUndefined();
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel', 'compaction.cancelled'])).toEqual({
      'context.apply_compaction': 1,
      'full_compaction.complete': 0,
      'full_compaction.cancel': 0,
      'compaction.cancelled': 0,
    });
    await (service as unknown as { dispose(): void | Promise<void> }).dispose();
    const lease = ctx.get(IAgentLoopService).tryAcquireQuiescence();
    expect(lease).toBeDefined();
    await lease?.dispose();
    expect(service.isCompacting()).toBe(false);
    expect(ctx.context.get()).toHaveLength(length);
    expect(ctx.context.get().find((message) => message.origin?.kind === 'compaction_summary')).toBe(summary);
    expect(wireCounts(ctx, ['context.apply_compaction', 'full_compaction.complete', 'full_compaction.cancel', 'compaction.cancelled'])).toEqual({
      'context.apply_compaction': 0,
      'full_compaction.complete': 0,
      'full_compaction.cancel': 0,
      'compaction.cancelled': 0,
    });
  });

  it('keeps an explicit threshold positive inside a 32k window with a 50k reserve', () => {
    const resolved = resolveAutoCompact({
      modelAlias: 'test',
      modelCapabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: 32_000 },
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel: 'off',
      reservedContextSize: 50_000,
      compactionTriggerRatio: undefined,
      compactionMaxAttempts: undefined,
      compactionSoftContextSize: undefined,
      profileAutoCompact: 20_000,
    });
    expect(resolved.tokens).toBe(32_000);
    expect(resolved.tokens).toBeGreaterThan(0);
    expect(resolved.tokens).toBeLessThanOrEqual(32_000);

    const ctx = testAgent({
      initialConfig: { providers: {}, loopControl: { autoCompact: '60%', reservedContextSize: 50_000 } },
    });
    ctx.configure({
      provider: PROVIDER,
      modelCapabilities: { ...CAPABILITIES, max_context_tokens: 32_000 },
    });
    const live = ctx.get(IAgentFullCompactionService).getAutoCompact();
    expect(live.source).not.toBe('legacy');
    expect(live.tokens).toBeGreaterThan(0);
    expect(live.tokens).toBeLessThanOrEqual(32_000);
  });
});
