import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { AsyncEmitter, Emitter, Event } from '#/_base/event';
import { IPluginUsageService, type PluginUsageChange } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { AgentPluginService } from '#/agent/plugin/agentPluginService';
import { capabilitySourceMessage } from '#/agent/contextInjector/capabilityDelta';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IPluginService } from '#/app/plugin/plugin';
import type {
  EnabledPluginSessionStart,
  PluginMutationSummary,
  PluginReloadEvent,
} from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { summarizeSkill } from '#/app/skillCatalog/types';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { agentService, appService, createTestAgent, skillServices, type TestAgentContext } from '../../harness';
import { stubPluginService } from '../../app/plugin/stubs';

function pluginSkill(): SkillDefinition {
  return {
    name: 'demo-skill',
    description: 'A plugin skill',
    path: '/plugins/demo/skills/demo-skill/SKILL.md',
    dir: '/plugins/demo/skills/demo-skill',
    content: 'Do the demo thing.',
    metadata: {},
    source: 'extra',
    plugin: { id: 'demo', instructions: 'Always be helpful.' },
  };
}

function findPluginSessionStartEventMessages(ctx: TestAgentContext) {
  return ctx.contextData().history.flatMap((message) => {
    const source = capabilitySourceMessage(message, 'plugin_session_start');
    return source === undefined ? [] : [source];
  });
}

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

async function runInjectionBoundary(ctx: TestAgentContext): Promise<void> {
  await ctx.get(IAgentLoopService).hooks.onWillBeginStep.run({
    turnId: 0,
    step: 1,
    firstStepOfTurn: true,
    signal: new AbortController().signal,
  });
}

describe('AgentPluginService plugin session-start wiring', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
    ctx = undefined;
  });

  it('injects the plugin session-start reminder through the real service registration', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    const injected = findPluginSessionStartEventMessages(ctx).at(-1);
    expect(injected).toBeDefined();
    const text = injected === undefined ? '' : messageText(injected);
    expect(text).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(text).toContain('Do the demo thing.');
    expect(text).toContain('Always be helpful.');
  });

  it('does not re-inject the plugin session-start reminder on later turns while it remains live', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);
    ctx.get(IEventBus).publish(
      new TurnStarted({ turnId: 2, origin: USER_PROMPT_ORIGIN }),
    );
    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);
  });

  it('refreshes the frozen session-start guidance through the explicit service path', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(catalog),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );

    const plugins = ctx.get(IAgentPluginService);
    await runInjectionBoundary(ctx);
    expect(messageText(findPluginSessionStartEventMessages(ctx).at(-1)!)).toContain(
      'Do the demo thing.',
    );

    catalog.register(
      { ...pluginSkill(), content: 'Do the explicitly refreshed demo thing.' },
      { replace: true },
    );
    await plugins.refreshSessionStart();

    const messages = findPluginSessionStartEventMessages(ctx);
    expect(messages).toHaveLength(2);
    expect(messageText(messages.at(-1)!)).toContain(
      'Do the explicitly refreshed demo thing.',
    );
    expect(messageText(messages.at(-1)!)).toContain(
      'supersedes any earlier plugin_session_start reminder',
    );
  });

  it('keeps workspace usage pending until session-start guidance reaches a safe boundary', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const change = new Emitter<PluginUsageChange>();
    let allowed = true;
    const usage: IPluginUsageService = { _serviceBrand: undefined, enabled: () => true,
      read: async (workspaceId) => ({ workspaceId, revision: 0, overrides: {}, applyState: 'applied', errors: [] }),
      allows: async () => allowed, set: async () => { throw new Error('unused'); },
      registerPluginStateReader: () => ({ dispose: () => {} }),
      readSession: async (workspaceId, sessionId) => ({ workspaceId, sessionId, revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      applySession: async (snapshot) => snapshot,
      onDidChange: change.event, onDidApply: Event.None as IPluginUsageService['onDidApply'] };
    const plugins = { ...stubPluginService({ sessionStarts: [] }), enabledSessionStarts: async (workspaceId?: string) => {
      expect(workspaceId).toBe(ctx!.get(ISessionContext).workspaceId);
      return allowed ? [{ pluginId: 'demo', skillName: 'demo-skill' }] : [];
    } };
    ctx = createTestAgent({ autoConfigure: true }, appService(IPluginService, plugins), appService(IPluginUsageService, usage),
      skillServices(catalog), agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)));
    ctx.get(IAgentPluginService);
    await runInjectionBoundary(ctx);
    const before = findPluginSessionStartEventMessages(ctx).length;
    const work: Promise<unknown>[] = [];
    let applied = false;
    allowed = false;
    change.fire({ workspaceId: ctx.get(ISessionContext).workspaceId, pluginId: 'demo', revision: 1, waitUntil: (promise) => work.push(promise) });
    expect(work.length).toBeGreaterThan(0);
    void Promise.all(work).then(() => { applied = true; });
    await Promise.all(work);
    expect(applied).toBe(true);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(before);
    await runInjectionBoundary(ctx);
    expect(messageText(findPluginSessionStartEventMessages(ctx).at(-1)!)).toContain('no active plugin session starts');
    change.dispose();
  });

  it('does not inject when no plugin session starts are enabled', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, stubPluginService({ sessionStarts: [] })),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(0);
  });

  it('re-appends a fresh reminder when the plugin skill source finishes refreshing', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);

    sinkChange.fire('plugin');
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);
    await runInjectionBoundary(ctx);

    const messages = findPluginSessionStartEventMessages(ctx);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const latest = messageText(messages.at(-1)!);
    expect(latest).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(latest).toContain('supersedes any earlier plugin_session_start reminder');
    sinkChange.dispose();
  });

  it('appends only for the plugin source when unrelated and plugin changes arrive together', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);

    sinkChange.fire('user');
    sinkChange.fire('plugin');
    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(2);
    sinkChange.dispose();
  });

  it('reconciles the current plugin guidance after undo removes its latest render', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    catalog.register(
      { ...pluginSkill(), content: 'Do the updated demo thing.' },
      { replace: true },
    );
    sinkChange.fire('plugin');
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentLoopService).settled();
    await ctx.undoHistory(1);
    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third prompt' }] });
    await ctx.untilTurnEnd();

    const latest = findPluginSessionStartEventMessages(ctx).at(-1);
    expect(latest).toBeDefined();
    expect(messageText(latest!)).toContain('Do the updated demo thing.');
    expect(messageText(latest!)).toContain(
      'supersedes any earlier plugin_session_start reminder',
    );
    sinkChange.dispose();
  });
});

describe('AgentPluginService plugin-change reminder', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
    ctx = undefined;
  });

  function findPluginChangeMessages(context: TestAgentContext) {
    return context.contextData().history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'plugin_change',
    );
  }

  it('keeps plugin mutations on the usage-managed refresh path when usage is enabled', async () => {
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, stubPluginService({ sessionStarts: [], mutateEmitter })),
      skillServices(new InMemorySkillCatalog()),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    mutateEmitter.fire({
      added: [],
      removed: [],
      errors: [],
      mutation: { kind: 'enable', id: 'demo' },
    });

    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    mutateEmitter.dispose();
  });

  it('leaves tool mutations to dynamic announcements when disclosure is enabled', async () => {
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, stubPluginService({ sessionStarts: [], mutateEmitter })),
      skillServices(new InMemorySkillCatalog()),
      agentService(IAgentToolSelectService, { enabled: () => true } as unknown as IAgentToolSelectService),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);
    mutateEmitter.fire({ added: ['demo'], removed: [], errors: [], mutation: { kind: 'install', id: 'demo' } });
    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    mutateEmitter.dispose();
  });

  it('does not append the plugin_change reminder on an explicit reload', async () => {
    const reloadEmitter = new AsyncEmitter<PluginReloadEvent>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, stubPluginService({ sessionStarts: [], reloadEmitter })),
      skillServices(new InMemorySkillCatalog()),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    await reloadEmitter.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    reloadEmitter.dispose();
  });

  function skillCatalogWithChange(catalog: InMemorySkillCatalog, change: Emitter<string>) {
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: change.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };
    return skillCatalog;
  }

  function fireMutation(mutateEmitter: Emitter<PluginMutationSummary>, id: string): void {
    mutateEmitter.fire({
      added: [],
      removed: [],
      errors: [],
      mutation: { kind: 'install', id },
    });
  }

  it('suppresses the session-start refresh for mutation-driven catalog changes', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    let sessionStarts: readonly EnabledPluginSessionStart[] = [
      { pluginId: 'demo', skillName: 'demo-skill' },
    ];
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        {
          ...stubPluginService({ sessionStarts, mutateEmitter }),
          enabledSessionStarts: async () => sessionStarts,
        },
      ),
      skillServices(skillCatalogWithChange(catalog, sinkChange)),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);
    await runInjectionBoundary(ctx);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);

    fireMutation(mutateEmitter, 'demo');
    sessionStarts = [];
    sinkChange.fire('plugin');
    await runInjectionBoundary(ctx);

    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(2);

    sinkChange.fire('plugin');
    await runInjectionBoundary(ctx);
    expect(findPluginSessionStartEventMessages(ctx).length).toBeGreaterThanOrEqual(2);

    sinkChange.dispose();
    mutateEmitter.dispose();
  });

  it('suppresses one session-start refresh per mutation when mutations arrive back to back', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
          mutateEmitter,
        }),
      ),
      skillServices(skillCatalogWithChange(catalog, sinkChange)),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);
    await runInjectionBoundary(ctx);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(1);

    fireMutation(mutateEmitter, 'demo');
    fireMutation(mutateEmitter, 'demo');
    sinkChange.fire('plugin');
    sinkChange.fire('plugin');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    expect(findPluginSessionStartEventMessages(ctx)).toHaveLength(2);

    sinkChange.dispose();
    mutateEmitter.dispose();
  });
});
