import { describe, expect, it } from 'vitest';
import { Emitter, Event } from '#/_base/event';
import type { IAgentContextInjectorService, ContextInjectionProvider } from '#/agent/contextInjector/contextInjector';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISubagentTool } from '#/agent/tools/agent/agent';
import { AgentProfileAnnouncementsService, describeProfileDelta } from '#/agent/tools/agent/agentProfileAnnouncementsService';

import { stubLog } from '../../_base/log/stubs';

function visible(...entries: readonly (readonly [string, string, string])[]) {
  return new Map(entries.map(([name, line, signature]) => [name, { line, signature }]));
}

describe('AgentRun profile change reminders', () => {
  it('sends only the effective added, updated and removed profiles', () => {
    expect(describeProfileDelta(
      visible(['general', '- general: General work.', 'v1'], ['hidden', '- hidden: Not visible.', 'same'], ['old', '- old: Old work.', 'v1']),
      visible(['general', '- general: General work.', 'v2'], ['hidden', '- hidden: Not visible.', 'same'], ['new', '- new: New work.', 'v1']),
    )).toBe('<agent_profiles_added>\n- new: New work.\n</agent_profiles_added>\n<agent_profiles_updated>\n- general: General work.\n</agent_profiles_updated>\n<agent_profiles_removed>\nold\n</agent_profiles_removed>');
  });

  it('ignores profile reloads whose effective dispatchable view is unchanged', () => {
    const same = visible(['general', '- general: General work.', 'v1']);
    expect(describeProfileDelta(same, new Map(same))).toBeUndefined();
  });

  it('coalesces catalog events into one reminder on the next user turn', async () => {
    const change = new Emitter<string>();
    let profiles = visible(['general', '- general: General work.', 'v1']);
    let provider: ContextInjectionProvider | undefined;
    const injector = {
      register: (_name: string, callback: ContextInjectionProvider) => {
        provider = callback;
        return { dispose() {} };
      },
    } as IAgentContextInjectorService;
    const service = new AgentProfileAnnouncementsService(
      { ready: Promise.resolve(), onDidChange: change.event } as ISessionAgentProfileCatalog,
      { visibleProfileDescriptions: () => profiles } as unknown as ISubagentTool,
      { isToolActive: () => true } as unknown as IAgentToolPolicyService,
      injector,
      stubLog(),
    );
    await Promise.resolve();
    const context = (isNewTurn: boolean) => ({ isNewTurn, injectedPositions: [], lastInjectedAt: null });
    profiles = visible(['general', '- general: General work.', 'v1'], ['temporary', '- temporary: Temporary.', 'v1']);
    change.fire('temporary');
    profiles = visible(['general', '- general: General work.', 'v1'], ['new', '- new: New work.', 'v1']);
    change.fire('new');
    expect(await provider?.(context(false))).toBeUndefined();
    expect(await provider?.(context(true))).toBe('<agent_profiles_added>\n- new: New work.\n</agent_profiles_added>');
    expect(await provider?.(context(true))).toBeUndefined();
    change.fire('hidden');
    expect(await provider?.(context(true))).toBeUndefined();
    service.dispose();
    change.dispose();
  });

  it('records a baseline failure instead of leaking an unhandled rejection', async () => {
    const warnings: string[] = [];
    const log = { ...stubLog(), warn: (message: string) => { warnings.push(message); } };
    const build = (ready: Promise<void>, visibleProfileDescriptions: () => unknown) =>
      new AgentProfileAnnouncementsService(
        { ready, onDidChange: Event.None } as unknown as ISessionAgentProfileCatalog,
        { visibleProfileDescriptions } as unknown as ISubagentTool,
        { isToolActive: () => true } as unknown as IAgentToolPolicyService,
        { register: () => ({ dispose() {} }) } as unknown as IAgentContextInjectorService,
        log,
      );

    const snapshotReadFailed = build(Promise.resolve(), () => {
      throw new Error('Default agent profile is unavailable');
    });
    const catalogUnavailable = build(
      Promise.reject(new Error('Default agent profile is unavailable')),
      () => visible(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings).toEqual([
      'failed to baseline the visible agent profiles for change announcements',
      'failed to baseline the visible agent profiles for change announcements',
    ]);
    snapshotReadFailed.dispose();
    catalogUnavailable.dispose();
  });
});
