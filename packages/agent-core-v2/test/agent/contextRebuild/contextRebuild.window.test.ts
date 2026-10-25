import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextRebuildService } from '#/agent/contextRebuild/contextRebuild';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { AgentModelSwitchService } from '#/agent/modelSwitch/modelSwitchService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { agentServices, sessionServices, testAgent, type TestAgentContext } from '../../harness';

const OLD = 'example/old-model';
const NEW = 'example/new-model';
const hosts: TestAgentContext[] = [];

async function open(reload: () => Promise<{ instructionsChanged: boolean; pluginsChanged: boolean }>): Promise<TestAgentContext> {
  const ctx = testAgent({ autoConfigure: false, initialConfig: {
    providers: { example: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
    models: {
      [OLD]: { provider: 'example', model: 'old-model', maxContextSize: 200_000 },
      [NEW]: { provider: 'example', model: 'new-model', maxContextSize: 100_000 },
    },
  } }, sessionServices((reg) => {
    reg.defineInstance(ISessionContextSourceReloader, { _serviceBrand: undefined, reload });
  }), agentServices((reg) => {
    reg.define(IAgentModelSwitchService, AgentModelSwitchService);
  }));
  hosts.push(ctx);
  await ctx.ready;
  ctx.get(IAgentProfileService).update({ modelAlias: OLD, thinkingLevel: 'off', systemPrompt: 'Test system prompt.' });
  await ctx.get(ISessionMetadata).registerAgent('main', { type: 'main', model: OLD, thinkingEffort: 'off' });
  ctx.get(IAgentContextMemoryService).append({
    role: 'user', content: [{ type: 'text', text: 'Keep this task.' }], toolCalls: [],
    id: 'human-input', origin: { kind: 'user' }, source: { turnId: 2, step: 0 },
  });
  return ctx;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((ctx) => ctx.dispose()));
});

describe('context rebuild at a completed context window', () => {
  it('re-reads once after a fresh window while the switch lease is held and keeps the chosen model', async () => {
    const held: boolean[] = [];
    let ctx!: TestAgentContext;
    const reload = vi.fn(async () => {
      const lease = ctx.get(IAgentLoopService).tryAcquireQuiescence();
      held.push(lease === undefined);
      await lease?.dispose();
      return { instructionsChanged: false, pluginsChanged: false };
    });
    ctx = await open(reload);
    const profile = ctx.get(IAgentProfileService);
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'fresh-window', model: NEW, mode: 'fresh' });
    expect(result).toMatchObject({ state: 'completed', mode: 'fresh', toModel: NEW });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(held).toEqual([true]);
    expect(profile.getModel()).toBe(NEW);
    expect(profile.data().thinkingLevel).toBe('off');
    expect(ctx.get(IAgentContextRebuildService).control()).toMatchObject({ trigger: 'model_switch_fresh', outcome: 'applied' });
    expect(ctx.llmCalls).toHaveLength(0);
  }, 30_000);

  it('re-reads once after a compacted window and keeps the model that switch selected', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = await open(reload);
    await ctx.get(IAgentContextRebuildService).setEnabled(true);
    ctx.mockNextResponse({ type: 'text', text: 'A portable visible summary.' });
    const result = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'compact-window', model: NEW, mode: 'compact' });
    expect(result).toMatchObject({ state: 'completed', mode: 'compact', toModel: NEW });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ctx.get(IAgentProfileService).getModel()).toBe(NEW);
    expect(ctx.get(IAgentProfileService).data().thinkingLevel).toBe('off');
    expect(ctx.get(IAgentContextRebuildService).control().trigger).toBe('model_switch_compact');
  }, 30_000);

  it('does not re-read for a direct switch, a cancelled switch, or a fresh switch while the rebuild switch is off', async () => {
    const reload = vi.fn(async () => ({ instructionsChanged: false, pluginsChanged: false }));
    const ctx = await open(reload);
    const direct = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'direct-window', model: NEW, mode: 'direct' });
    expect(direct).toMatchObject({ state: 'completed', mode: 'direct', toModel: NEW });
    const signal = AbortSignal.abort();
    const cancelled = await ctx.get(IAgentModelSwitchService).execute({ operationId: 'cancelled-window', model: OLD, mode: 'fresh' }, { signal });
    expect(cancelled.state).toBe('cancelled');
    expect(reload).not.toHaveBeenCalled();
    const off = await open(reload);
    const fresh = await off.get(IAgentModelSwitchService).execute({ operationId: 'fresh-off', model: NEW, mode: 'fresh' });
    expect(fresh.state).toBe('completed');
    expect(reload).not.toHaveBeenCalled();
  }, 30_000);
});
