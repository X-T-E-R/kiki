import { afterEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { IAgentProfileService } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { configServices, createTestAgent, sessionService, type TestAgentContext } from '../harness';

describe('AgentRun dispatch recommendations', () => {
  let ctx: TestAgentContext | undefined;
  afterEach(async () => { await ctx?.dispose(); });

  function description(mainDispatchPolicy: 'advisory' | 'strict'): string {
    const preferred = normalizeAgentProfile({
      name: 'explore', description: 'Preferred explorer', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const other = normalizeAgentProfile({
      name: 'worker', description: 'Other worker', modelAlias: 'mock-model', systemPrompt: () => '',
    });
    const parent = normalizeAgentProfile({ name: 'agent', main: true, systemPrompt: () => '' });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name: string) => [parent, preferred, other].find((profile) => profile.name === name),
      getDefault: () => parent,
      list: () => [preferred, other],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      configServices(() => ({ providers: {}, subagent: { mainDispatchPolicy } })),
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'agent', thinkingLevel: 'off', systemPrompt: 'parent', subagents: ['explore'],
    });
    return ctx.toolsData().find((tool) => tool.name === 'AgentRun')!.description;
  }

  it('promotes preferred profiles while advisory callers still see nonpreferred targets', () => {
    const text = description('advisory');
    expect(text).toContain('Preferred agent profiles: explore.');
    expect(text).toContain('- explore: Preferred explorer');
    expect(text).toContain('- worker: Other worker');
    expect(text.indexOf('- explore:')).toBeLessThan(text.indexOf('- worker:'));
  });

  it('never lists a blocked target to a strict caller', () => {
    const text = description('strict');
    expect(text).toContain('Preferred agent profiles: explore.');
    expect(text).toContain('- explore: Preferred explorer');
    expect(text).not.toContain('- worker: Other worker');
  });
});
