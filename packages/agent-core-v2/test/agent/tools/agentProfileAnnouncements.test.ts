import { afterEach, describe, expect, it } from 'vitest';
import { Event } from '#/_base/event';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentContextInjectorService, type ContextInjectionProvider, type ContextInjectionResult } from '#/agent/contextInjector/contextInjector';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISubagentTool } from '#/agent/tools/agent/agent';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import { AgentProfileAnnouncementsService, IAgentProfileAnnouncementsService, describeProfileDelta, type ProfileDirectoryDisclosure } from '#/agent/tools/agent/agentProfileAnnouncementsService';
import { registerLogServices } from '../../_base/log/stubs';

function visible(...entries: readonly (readonly [string, string, string])[]) {
  return new Map(entries.map(([name, line, signature]) => [name, { line, signature }]));
}
const resources = new DisposableStore();
afterEach(() => resources.clear());
function harness(ready = Promise.resolve()) {
  let profiles = visible(['general', '- general: General work.', 'v1']);
  let active = true;
  let provider: ContextInjectionProvider<ProfileDirectoryDisclosure> | undefined;
  const states = new AgentStateService();
  states.contributeState(llmRequestTraceKey);
  const ix = createServices(resources, { base: [registerLogServices], additionalServices: (reg) => {
    reg.defineInstance(IAgentStateService, states);
    reg.definePartialInstance(ISessionAgentProfileCatalog, { ready, onDidChange: Event.None as Event<string> });
    reg.definePartialInstance(ISubagentTool, { visibleProfileDescriptions: () => profiles });
    reg.definePartialInstance(IAgentToolPolicyService, { isToolActive: () => active });
    reg.definePartialInstance(IAgentContextInjectorService, { register: (_name, callback) => {
      provider = callback as unknown as ContextInjectionProvider<ProfileDirectoryDisclosure>; return { dispose() {} };
    } });
    reg.define(IAgentProfileAnnouncementsService, AgentProfileAnnouncementsService);
  } });
  ix.get(IAgentProfileAnnouncementsService);
  return { states, set: (value: typeof profiles) => { profiles = value; }, active: (value: boolean) => { active = value; },
    schema: () => states.set(llmRequestTraceKey, { seenToolsHashes: [], advertisedProfiles: [...profiles].map(([name, entry]) => ({ name, ...entry })) }),
    evaluate: (lastDisclosure?: ProfileDirectoryDisclosure) => provider!({ isNewTurn: false, injectedPositions: [], lastInjectedAt: null, lastDisclosure }) };
}

describe('AgentRun profile change reminders', () => {
  it('describes unavailability as caller policy, not file deletion', () => {
    const text = describeProfileDelta(visible(['old', '- old: Old work.', 'v1']), visible(['new', '- new: New work.', 'v1']));
    expect(text).toContain('Available now:\n- new: New work.');
    expect(text).toContain('Now unavailable to this caller:\nold');
    expect(text).not.toContain('agent_profiles_removed');
  });
  it('ignores unchanged effective dispatchable views', () => {
    const same = visible(['general', '- general: General work.', 'v1']);
    expect(describeProfileDelta(same, new Map(same))).toBeUndefined();
  });
  it('waits for the first bound schema instead of baselining catalog ready', async () => {
    const h = harness();
    await Promise.resolve();
    h.set(visible(['explore', '- explore: Research.', 'v1']));
    expect(await h.evaluate()).toBeUndefined();
    h.schema();
    expect(await h.evaluate()).toBeUndefined();
    h.set(visible(['explore', '- explore: Research.', 'v2']));
    const result = await h.evaluate() as ContextInjectionResult<ProfileDirectoryDisclosure>;
    expect(result.content).toContain('Updated:\n- explore: Research.');
    expect(result.content).not.toContain('general');
  });
  it('only advances when a change is committed into context', async () => {
    const h = harness(); h.schema();
    h.set(visible(['new', '- new: New work.', 'v1']));
    const first = await h.evaluate() as ContextInjectionResult<ProfileDirectoryDisclosure>;
    expect(await h.evaluate()).toEqual(first);
    expect(await h.evaluate(first.disclosure)).toBeUndefined();
    h.active(false);
    expect(await h.evaluate()).toBeUndefined();
    h.active(true);
    h.schema();
    expect(await h.evaluate()).toBeUndefined();
  });
  it('handles catalog readiness failure at the safe boundary', async () => {
    const h = harness(Promise.reject(new Error('Catalog unavailable')));
    expect(await h.evaluate()).toBeUndefined();
  });
});
