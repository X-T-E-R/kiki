import { afterEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISubagentTool } from '#/agent/tools/agent/agent';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { configServices, createTestAgent, sessionService, type TestAgentContext } from '../harness';

describe('AgentRun dispatch recommendations', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => { await ctx?.dispose(); });

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
});
