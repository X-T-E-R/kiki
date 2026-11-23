import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISubagentTool } from '#/agent/tools/agent/agent';
import { AGENT_RUN_ADVERTISED_MODELS_LIMIT_ENV } from '#/agent/tools/agent/subagentDescription';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IModelService } from '#/kosong/model/model';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { configServices, createTestAgent, sessionService, type TestAgentContext } from '../harness';

describe('AgentRun dispatch recommendations', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await ctx?.dispose();
  });

  function agentRun(allowedSubagents?: readonly string[]) {
    const preferred = normalizeAgentProfile({
      name: 'explore', description: 'Preferred explorer', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const other = normalizeAgentProfile({
      name: 'worker', description: 'Other worker', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const parent = normalizeAgentProfile({
      name: 'agent', description: 'Main agent profile', main: true, systemPrompt: () => '',
    });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [parent, preferred, other].find((profile) => profile.name === name),
      getDefault: () => parent,
      list: () => [parent, preferred, other],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      configServices(() => ({ providers: {} })),
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'agent', thinkingLevel: 'off', systemPrompt: 'parent',
      preferredSubagents: ['explore'], allowedSubagents,
    });
    return ctx.get(ISubagentTool);
  }

  function description(allowedSubagents?: readonly string[]): string {
    return agentRun(allowedSubagents).description;
  }

  it('promotes preferred profiles without hiding nonpreferred permitted targets', () => {
    const text = description();
    expect(text).toContain('Available profiles (pass via profile; preferred first):');
    expect(text).toContain('- explore: Preferred explorer');
    expect(text).toContain('- worker: Other worker');
    expect(text.indexOf('- explore:')).toBeLessThan(text.indexOf('- worker:'));
  });

  it('never lists a preset outside a hard allowed set', () => {
    const text = description(['explore']);
    expect(text).toContain('Available profiles (pass via profile; preferred first):');
    expect(text).toContain('- explore: Preferred explorer');
    expect(text).not.toContain('- worker: Other worker');
  });

  it('keeps a catalog main profile out of the description and capability projection', () => {
    const tool = agentRun();
    expect(tool.description).toContain('- explore: Preferred explorer');
    expect(tool.description).not.toContain('- agent: Main agent profile');
    expect(tool.description).not.toContain('Main agent profile');
    expect([...tool.visibleProfileDescriptions().keys()]).toEqual(['explore', 'worker']);
  });

  it('keeps AgentRun description under 8 KiB with 10,000 configured models while prioritizing profile and default aliases', async () => {
    const models: Record<string, { provider: string; model: string; maxContextSize: number }> = {};
    for (let i = 0; i < 10_000; i += 1) {
      models[`gw/model-${String(i).padStart(5, '0')}`] = {
        provider: 'gw',
        model: `remote-${i}`,
        maxContextSize: 128_000,
      };
    }
    const preferred = normalizeAgentProfile({
      name: 'explore',
      description: 'Preferred explorer',
      modelAlias: 'gw/model-09999',
      modelProfiles: [{ alias: 'gw/model-09998', when: 'fast pass' }],
      systemPrompt: () => '',
    });
    const other = normalizeAgentProfile({
      name: 'worker',
      description: 'Other worker',
      modelAlias: 'gw/model-09997',
      systemPrompt: () => '',
    });
    const parent = normalizeAgentProfile({
      name: 'agent',
      description: 'Main agent profile',
      main: true,
      systemPrompt: () => '',
    });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [parent, preferred, other].find((profile) => profile.name === name),
      getDefault: () => parent,
      list: () => [parent, preferred, other],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;

    ctx = createTestAgent(
      {
        initialConfig: {
          providers: { gw: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://gw.example.test/v1' } },
          models,
          defaultModel: 'gw/model-08888',
        },
      },
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    await ctx.get(IModelService).setDefaultModel('gw/model-08888');
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: 'parent',
      preferredSubagents: ['explore'],
    });

    const started = performance.now();
    const desc = ctx.get(ISubagentTool).description;
    const elapsedMs = performance.now() - started;
    const bytes = Buffer.byteLength(desc, 'utf8');
    process.stdout.write(
      `${JSON.stringify({ stage: 'scale-10k-agent-run-description', bytes, elapsedMs })}\n`,
    );

    expect(bytes).toBeLessThan(8 * 1024);
    expect(desc).toContain('Model aliases available across the targets above:');
    expect(desc).toContain('gw/model-08888');
    expect(desc).toContain('gw/model-09999');
    expect(desc).toContain('gw/model-09998');
    expect(desc).toContain('gw/model-09997');
    expect(desc).toMatch(/\.\.\. and \d+ more configured models/);

    vi.stubEnv(AGENT_RUN_ADVERTISED_MODELS_LIMIT_ENV, '6');
    const compactCtx = createTestAgent(
      {
        initialConfig: {
          providers: { gw: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://gw.example.test/v1' } },
          models,
        },
      },
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    try {
      await compactCtx.get(IModelService).setDefaultModel('gw/model-08888');
      compactCtx.get(IAgentProfileService).applyBindingSnapshot({
        profileName: 'agent',
        thinkingLevel: 'off',
        systemPrompt: 'parent',
        preferredSubagents: ['explore'],
      });
      const compactDesc = compactCtx.get(ISubagentTool).description;
      const aliasLine = compactDesc.split('\n').find((line) => line.startsWith('Model aliases available across the targets above:'))!;
      expect(aliasLine).toContain('gw/model-08888');
      expect(aliasLine).toContain('gw/model-09999');
      expect(aliasLine).toContain('... and 9995 more configured models');
    } finally {
      await compactCtx.dispose();
    }
  });

  it('does not freeze AgentRun description while unbound and refreshes when bound profile switches to scoped private subagents', async () => {
    const explore = normalizeAgentProfile({
      name: 'explore', description: 'Built-in explorer', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const agent = normalizeAgentProfile({
      name: 'agent', description: 'Main agent profile', main: true, definitionId: 'def:agent', systemPrompt: () => '',
    });
    const ctfWorker = normalizeAgentProfile({
      name: 'ctf-worker', description: 'Private CTF execution seat', private: true, definitionId: 'def:ctf-worker', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const ctf = normalizeAgentProfile({
      name: 'ctf', description: 'CTF orchestrator', main: true, definitionId: 'def:ctf',
      allowedSubagents: ['ctf-worker'], preferredSubagents: ['ctf-worker'], systemPrompt: () => '',
    });
    const snapshot = {
      publicProfiles: new Map([[agent.name, agent], [ctf.name, ctf], [explore.name, explore]]),
      defaultProfile: agent,
      routes: new Map(),
      scopedBindings: new Map([
        ['def:ctf', new Map([
          ['ctf-worker', {
            alias: 'ctf-worker',
            parentDefinitionId: 'def:ctf',
            source: '_private/ctf-worker.md',
            status: 'ready' as const,
            sourceDefinitionId: 'def:ctf-worker',
            profile: ctfWorker,
          }],
        ])],
      ]),
      sourceDefinitions: new Map([['def:ctf-worker', ctfWorker]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [agent, ctf, explore].find((profile) => profile.name === name),
      getDefault: () => agent,
      list: () => [agent, ctf, explore],
      snapshot: () => snapshot,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;

    ctx = createTestAgent(
      configServices(() => ({ providers: {} })),
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    await Promise.resolve();

    const tool = ctx.get(ISubagentTool);
    const unboundDescription = tool.description;
    expect(unboundDescription).toContain('- explore: Built-in explorer');
    expect(unboundDescription).not.toContain('ctf-worker');

    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'agent',
      profileDefinitionId: 'def:agent',
      thinkingLevel: 'off',
      systemPrompt: 'agent',
    });
    const agentDescription = tool.description;
    expect(agentDescription).toContain('- explore: Built-in explorer');
    expect(agentDescription).not.toContain('ctf-worker');

    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'ctf',
      thinkingLevel: 'off',
      systemPrompt: 'ctf',
      allowedSubagents: ['ctf-worker'],
      preferredSubagents: ['ctf-worker'],
    });
    const ctfDescription = tool.description;
    expect(ctfDescription).toContain('- ctf-worker: Private CTF execution seat');
    expect(ctfDescription).not.toContain('- explore: Built-in explorer');
  });
});
