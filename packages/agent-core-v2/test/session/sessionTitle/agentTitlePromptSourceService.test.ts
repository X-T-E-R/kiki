import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';
import { AgentTitlePromptSourceService } from '#/session/sessionTitle/agentTitlePromptSourceService';

const USER_ORIGIN: ContextMessage['origin'] = { kind: 'user' };

function userMessage(id: string, text: string, origin: ContextMessage['origin'] = USER_ORIGIN): ContextMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin };
}

function assistantMessage(id: string, parts: ContentPart[]): ContextMessage {
  return { id, role: 'assistant', content: parts, toolCalls: [] };
}

function queued(id: string, text: string): ReturnType<IAgentPromptService['list']>['pending'][number] {
  return { id, userMessageId: id, createdAt: '2026-01-01T00:00:00.000Z', state: 'pending', message: userMessage(id, text) };
}

describe('AgentTitlePromptSource', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let liveMessages: readonly ContextMessage[];
  let queue: ReturnType<IAgentPromptService['list']>;

  beforeEach(() => {
    liveMessages = [];
    queue = { active: undefined, pending: [] };
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: reg => {
        reg.definePartialInstance(IAgentContextMemoryService, { get: () => liveMessages });
        reg.definePartialInstance(IAgentPromptService, { list: () => queue });
        reg.define(IAgentTitlePromptSource, AgentTitlePromptSourceService);
      },
    });
  });

  afterEach(async () => { await disposables.dispose(); });

  it('returns the first three prompts from the live context and queue in order', async () => {
    liveMessages = [userMessage('one', '第一条')];
    queue = { active: undefined, pending: [queued('two', '第二条'), queued('three', '第三条')] };
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['第一条', '第二条', '第三条']);
  });

  it.each([false, true])('includes launching before later pending prompts without duplicates; appended=%s', async appended => {
    const launching = queued('two', '第二条');
    liveMessages = [userMessage('one', '第一条'), ...(appended ? [launching.message] : [])];
    queue = { active: undefined, launching, pending: [queued('three', '第三条')] };
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['第一条', '第二条', '第三条']);
  });

  it('keeps the head user and summary as separate sources from a compacted window', async () => {
    liveMessages = [
      userMessage('head', '开场提问'),
      userMessage('elision', '... omitted ...', { kind: 'injection', variant: 'compaction_elision' }),
      userMessage('tail', '最近的追问'),
      userMessage('summary', ' compaction summary ', { kind: 'compaction_summary' }),
    ];
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['开场提问', '最近的追问']);
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '开场提问', recentUsers: ['最近的追问'], summary: 'compaction summary', assistant: undefined,
    });
  });

  it('returns no title prompts for slash activations or injected context', async () => {
    liveMessages = [
      userMessage('skill', 'expanded skill instructions', { kind: 'skill_activation', activationId: 'skill-1', skillName: 'compact', trigger: 'user-slash' }),
      userMessage('plugin', 'expanded plugin instructions', { kind: 'plugin_command', activationId: 'plugin-1', pluginId: 'example-plugin', commandName: 'run', trigger: 'user-slash' }),
      userMessage('injection', 'internal reminder', { kind: 'injection', variant: 'system' }),
    ];
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([]);
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toMatchObject({ recentUsers: [] });
  });

  it('deduplicates history, active, launching and pending user messages in their original order', async () => {
    const one = queued('one', '同一条');
    liveMessages = [one.message, one.message, assistantMessage('reply', [{ type: 'text', text: '最终回答' }])];
    queue = { active: { ...one, state: 'running' }, launching: one, pending: [one, queued('two', '未回答的问题')] };
    const source = ix.get(IAgentTitlePromptSource);
    await expect(source.firstUserPrompts(5)).resolves.toEqual(['同一条', '未回答的问题']);
    await expect(source.firstTurnExcerpt()).resolves.toEqual({ user: '同一条', assistant: '最终回答' });
    await expect(source.digestExcerpt()).resolves.toEqual({ firstUser: '同一条', recentUsers: ['未回答的问题'], summary: undefined, assistant: undefined });
  });

  it('keeps distinct provider messages that reuse a user id', async () => {
    liveMessages = [
      { ...userMessage('reused', '第一轮'), providerMessageId: 'provider-one' },
      { ...userMessage('reused', '第二轮'), providerMessageId: 'provider-two' },
    ];
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['第一轮', '第二轮']);
  });

  it('keeps a materialized launching prompt at its committed history position', async () => {
    const message = userMessage('one', '最初的问题');
    liveMessages = [message, assistantMessage('reply', [{ type: 'text', text: '最终回答' }])];
    queue = { active: undefined, launching: { ...queued('one', '最初的问题'), message }, pending: [] };
    const source = ix.get(IAgentTitlePromptSource);
    await expect(source.firstTurnExcerpt()).resolves.toEqual({ user: '最初的问题', assistant: '最终回答' });
    await expect(source.digestExcerpt()).resolves.toEqual({ firstUser: '最初的问题', recentUsers: [], summary: undefined, assistant: '最终回答' });
  });

  it('pairs the opening prompt with that turn’s final assistant text, excluding tool and thinking', async () => {
    liveMessages = [
      userMessage('u1', '帮我写一个快排'),
      assistantMessage('thinking', [{ type: 'think', think: '让我想想' }]),
      assistantMessage('a1', [{ type: 'text', text: '好的，先写一版' }]),
      { id: 'tool', role: 'tool', content: [{ type: 'text', text: 'tool output' }], toolCalls: [] },
      assistantMessage('a2', [{ type: 'text', text: '这是最终版实现' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }]),
      userMessage('u2', '再加个单测'),
      assistantMessage('a3', [{ type: 'text', text: '第二轮的回复' }]),
    ];
    await expect(ix.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({ user: '帮我写一个快排', assistant: '这是最终版实现' });
  });

  it('reports a missing first reply instead of crossing the compaction boundary', async () => {
    liveMessages = [
      userMessage('u1', '刚发的问题'),
      userMessage('summary', '历史摘要', { kind: 'compaction_summary' }),
      assistantMessage('a1', [{ type: 'text', text: '摘要之后的回答' }]),
    ];
    await expect(ix.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({ user: '刚发的问题', assistant: undefined });
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toMatchObject({ summary: '历史摘要', assistant: undefined });
    liveMessages = [userMessage('u1', '刚发的问题')];
    await expect(ix.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({ user: '刚发的问题', assistant: undefined });
  });

  it('anchors the first prompt and retains the latest four user requirements in order', async () => {
    liveMessages = [
      userMessage('u1', '最初的目标'),
      userMessage('u2', '旧要求'),
      userMessage('u3', '切换到新目标'),
      userMessage('u4', '中途追问'),
      userMessage('u5', '继续'),
      userMessage('u6', '最近的要求'),
      assistantMessage('a1', [{ type: 'think', think: '思考中' }]),
      assistantMessage('a2', [{ type: 'text', text: '最新正文' }]),
    ];
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '最初的目标', recentUsers: ['切换到新目标', '中途追问', '继续', '最近的要求'], summary: undefined, assistant: '最新正文',
    });
  });

  it('does not attach an earlier assistant answer to a new unanswered question', async () => {
    liveMessages = [userMessage('u1', '唯一的问题'), assistantMessage('a1', [{ type: 'text', text: '唯一的回答' }]), userMessage('u2', '还没得到回复的新问题')];
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '唯一的问题', recentUsers: ['还没得到回复的新问题'], summary: undefined, assistant: undefined,
    });
    liveMessages = [userMessage('u1', '唯一的问题')];
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({ firstUser: '唯一的问题', recentUsers: [], summary: undefined, assistant: undefined });
  });

  it('reads only the latest live summary even without a remaining user', async () => {
    liveMessages = [
      userMessage('s1', '旧摘要', { kind: 'compaction_summary' }),
      userMessage('s2', '最新摘要 password=sample-secret', { kind: 'compaction_summary' }),
    ];
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({ firstUser: undefined, recentUsers: [], summary: '最新摘要 password=[redacted]', assistant: undefined });
  });

  it('preserves the existing 4k metadata cap for each source', async () => {
    liveMessages = [userMessage('u1', '问'.repeat(5000)), assistantMessage('a1', [{ type: 'text', text: '答'.repeat(5000) }]), userMessage('s1', '摘'.repeat(5000), { kind: 'compaction_summary' })];
    const source = ix.get(IAgentTitlePromptSource);
    expect((await source.firstUserPrompts(1))[0]).toHaveLength(4000);
    const turn = await source.firstTurnExcerpt();
    expect(turn.user).toHaveLength(4000);
    expect(turn.assistant).toHaveLength(4000);
    expect((await source.digestExcerpt()).summary).toHaveLength(4000);
  });

  it.each([0, -1, NaN, 1.5])('ignores invalid initial prompt limits (%s)', async limit => {
    liveMessages = [userMessage('u1', '一个问题')];
    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(limit)).resolves.toEqual([]);
  });
});
