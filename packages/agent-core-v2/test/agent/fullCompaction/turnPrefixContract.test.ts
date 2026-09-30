import { afterEach, describe, expect, it, vi } from 'vitest';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TodoListReminderTracker } from '#/session/todo/todoListReminder';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import type { Protocol } from '#/kosong/protocol/protocol';
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { createTestAgent, type TestAgentContext } from '../../harness';

describe('relay-v1 same-turn request prefix', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await ctx?.dispose();
  });

  it.each([
    { modelName: 'deepseek-chat', protocol: 'openai' as Protocol },
    { modelName: 'k3', protocol: 'anthropic' as Protocol, providerType: 'kimi' },
    { modelName: 'gpt-5', protocol: 'openai_responses' as Protocol },
  ])('appends one reminder without changing the serialized $modelName prefix ($protocol)', async (binding) => {
    ctx = createTestAgent({ initialConfig: { worktree: { cleanup: { auto: false } } } });
    ctx.configure({ modelCapabilities: { image_in: false, video_in: false, audio_in: false,
      thinking: false, tool_use: true, max_context_tokens: 128_000 }, tools: ['TodoList', 'AgentRun'] });
    const tracker = new TodoListReminderTracker();
    ctx.get(IAgentContextInjectorService).register('todo_list_reminder', () => tracker.evaluate({ active: true,
      history: ctx!.get(IAgentContextMemoryService).get(), todos: [], epoch: 0 }));
    ctx.context.append(
      { role: 'user', content: [{ type: 'text', text: 'Begin the task' }], toolCalls: [], origin: { kind: 'user' }, source: { turnId: 1 } },
      { role: 'assistant', content: [{ type: 'text', text: 'Working' }], toolCalls: [] },
    );
    const requester = ctx.get(IAgentLLMRequesterService);
    ctx.mockNextResponse({ type: 'text', text: 'before' });
    await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    const provider = new ProtocolAdapterRegistry().createChatProvider({ ...binding, apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(JSON.parse(await request.text()));
      return new Response(JSON.stringify({ error: { message: 'capture only' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }));
    const capture = async () => {
      const tools = ctx!.get(IAgentToolRegistryService).list().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? {} }));
      const system = ctx!.get(IAgentProfileService).getSystemPrompt();
      expect(system).not.toBe('');
      expect(tools.length).toBeGreaterThan(0);
      await expect(provider.generate(system, tools,
        [...ctx!.get(IAgentContextMemoryService).get()])).rejects.toThrow();
    };
    await capture();
    const before = [...ctx.get(IAgentContextMemoryService).get()];
    ctx.context.append({ role: 'user', content: [{ type: 'text', text: 'Always keep the selected model' }], toolCalls: [], origin: { kind: 'user' }, source: { turnId: 1 } });
    await ctx.get(IAgentContextInjectorService).reconcileAtSafeBoundary('todo_list_reminder');
    await ctx.get(IAgentContextInjectorService).reconcileAtSafeBoundary('todo_list_reminder');
    const history = ctx.get(IAgentContextMemoryService).get();
    expect(history.slice(0, before.length)).toEqual(before);
    const reminders = history.filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'todo_list_reminder');
    expect(reminders).toHaveLength(1);
    expect(history.at(-1)).toBe(reminders[0]);
    expect(reminders[0]?.origin).toMatchObject({ disclosure: { kind: 'directive', triggers: ['E1'] } });
    await capture();
    expect(bodies).toHaveLength(2);
    const [first, second] = bodies;
    expect(JSON.stringify(second?.['tools'])).toBe(JSON.stringify(first?.['tools']));
    const field = binding.protocol === 'openai_responses' ? 'input' : 'messages';
    const original = first?.[field] as unknown[];
    const appended = second?.[field] as unknown[];
    if (binding.protocol === 'anthropic') {
      const withoutBreakpoint = (value: unknown) => JSON.stringify(value, (key, item: unknown) => key === 'cache_control' ? undefined : item);
      expect(withoutBreakpoint(appended.slice(0, original.length))).toBe(withoutBreakpoint(original));
      expect(JSON.stringify(original.at(-1))).toContain('cache_control');
      expect(JSON.stringify(appended.slice(0, original.length))).not.toContain('cache_control');
      expect(JSON.stringify(appended.at(-1))).toContain('cache_control');
      expect(JSON.stringify(second?.['system'])).toBe(JSON.stringify(first?.['system']));
    } else {
      expect(JSON.stringify(appended.slice(0, original.length))).toBe(JSON.stringify(original));
    }
    expect(appended.length).toBeGreaterThan(original.length);
    if (binding.protocol === 'openai_responses') expect(second?.['instructions']).toBe(first?.['instructions']);
    expect(JSON.stringify(second)).toContain('standing instruction');
    ctx.mockNextResponse({ type: 'text', text: 'after' });
    await requester.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    const requests = ctx.allEvents.filter((event) => event.type === '[wire]' && event.event === 'llm.request');
    const previous = requests[0]?.args as { systemPromptHash: string; toolsHash: string };
    const next = requests[1]?.args as { systemPromptHash: string; toolsHash: string };
    expect(next.systemPromptHash).toBe(previous.systemPromptHash);
    expect(next.toolsHash).toBe(previous.toolsHash);
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
