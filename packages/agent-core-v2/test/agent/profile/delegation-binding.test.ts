import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { renderPromptTemplateResult, renderSystemPromptResult } from '@kiki/agent-profiles/profileShared';
import { DEFAULT_INDEPENDENT_DELEGATION_NOTICE } from '#/agent/profile/delegationContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';
import { ErrorCodes, isError2 } from '#/errors';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import {
  createTestAgent,
  homeDirServices,
  sessionService,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';

function catalogWith(
  profile: ReturnType<typeof normalizeAgentProfile>,
): ISessionAgentProfileCatalog {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name) => (name === profile.name ? profile : undefined),
    getDefault: () => profile,
    list: () => [profile],
    listRoutes: () => [],
    routeDiagnostics: () => [],
    resolveSelection: () => ({ profile, baseProfile: profile, route: undefined }),
    inspect: () => undefined,
    load: async () => {},
    reload: async () => {},
  };
}

describe('delegation context at bind', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-delegation-bind-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
  });

  it.each(['sub', 'independent', 'off'] as const)('MP-03 preserves %s notice and shared once in outbound bind, model-resume and anchor replacements', async (position) => {
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/replace.md'), 'REPLACEMENT BODY');
    await writeFile(join(homeDir, 'cognition/anchor.md'), 'ANCHOR BODY');
    const custom = normalizeAgentProfile({ name: 'replacement-role', delegationNotice: position === 'off' ? 'off' : undefined, systemPrompt: () => 'ORIGINAL BODY' });
    ctx = createTestAgent(homeDirServices(homeDir), sessionService(ISessionAgentProfileCatalog, catalogWith(custom)), { initialConfig: { prompt: { overrides: { fields: { 'system.shared': 'SHARED_FINAL', 'system.language': '# Language\n\nSHADOWED' } } } } });
    const model = ctx.kimiConfig.models![MOCK_MODEL]!;
    ctx.kimiConfig = { ...ctx.kimiConfig, models: {
      ...ctx.kimiConfig.models,
      [MOCK_MODEL]: { ...model, cognition: { overlay: 'cognition/replace.md', overlayMode: 'replace' } },
      'replacement-model': { ...model, model: 'replacement-model', cognition: { overlay: 'cognition/replace.md', overlayMode: 'replace', anchor: 'cognition/anchor.md', anchorScope: 'turn' } },
    } };
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: custom.name, model: MOCK_MODEL, delegationPosition: position === 'off' ? 'sub' : position });
    expect(profile.getPromptFieldSnapshot().fields.find((field) => field.id === 'system.language')?.status).toBe('shadowed');
    const notice = position === 'sub' ? TASK_AGENT_ROLE_PREFIX : position === 'independent' ? DEFAULT_INDEPENDENT_DELEGATION_NOTICE : undefined;
    const requester = ctx.get(IAgentLLMRequesterService);
    const assertOutbound = (body: string) => {
      const system = ctx!.llmCalls.at(-1)!.systemPrompt;
      expect(system).toContain(body);
      expect(system).not.toContain('ORIGINAL BODY');
      expect(system.split('SHARED_FINAL')).toHaveLength(2);
      if (notice !== undefined) expect(system.split(notice)).toHaveLength(2);
      else {
        expect(system).not.toContain(TASK_AGENT_ROLE_PREFIX);
        expect(system).not.toContain(DEFAULT_INDEPENDENT_DELEGATION_NOTICE);
      }
    };
    const assertAnchored = () => {
      expect(ctx!.llmCalls.at(-1)!.systemPrompt).toBe('ANCHOR BODY');
    };
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await requester.request({});
    assertOutbound('REPLACEMENT BODY');
    (await profile.prepareResumeBinding({ modelAlias: 'replacement-model', allowModelChange: true }))();
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await requester.request({});
    assertOutbound('REPLACEMENT BODY');
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await requester.request({ source: { type: 'turn', turnId: 0, step: 1 } });
    assertAnchored();
    const snapshot = JSON.parse(JSON.stringify(profile.data())) as ReturnType<typeof profile.data>;
    const config = ctx.kimiConfig;
    await ctx.dispose();
    ctx = createTestAgent(homeDirServices(homeDir), sessionService(ISessionAgentProfileCatalog, catalogWith(custom)));
    ctx.kimiConfig = config;
    ctx.get(IAgentProfileService).applyBindingSnapshot(snapshot);
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.get(IAgentLLMRequesterService).request({ source: { type: 'turn', turnId: 1, step: 1 } });
    assertAnchored();
  });

  it.each(['sub', 'independent', 'off'] as const)('preserves the saved %s notice across a cold variable refresh', async (position) => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      delegationNotice: position === 'off' ? 'off' : undefined,
      renderSystemPrompt: (context) => renderPromptTemplateResult('Role ${guidance}', context, { skillActive: false }),
    });
    ctx = createTestAgent(homeDirServices(homeDir), sessionService(ISessionAgentProfileCatalog, catalogWith(custom)), {
      initialConfig: { prompt: { variables: { guidance: 'OLD' }, overrides: { fields: { 'system.shared': 'SHARED_OLD' } } } },
    });
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: custom.name, model: MOCK_MODEL, delegationPosition: position === 'off' ? 'sub' : position });
    const before = JSON.parse(JSON.stringify(profile.data())) as ReturnType<typeof profile.data>;
    const snippet = before.boundProfile?.promptBase?.delegationSnippet;
    if (position !== 'off') expect(snippet).toBeTruthy();
    await ctx.dispose();
    ctx = createTestAgent(homeDirServices(homeDir), sessionService(ISessionAgentProfileCatalog, catalogWith(custom)), {
      initialConfig: { prompt: { variables: { guidance: 'NEW' }, overrides: { fields: { 'system.shared': 'SHARED_NEW' } } } },
    });
    const restored = ctx.get(IAgentProfileService);
    restored.applyBindingSnapshot(before);
    await restored.preparePromptConfiguration();
    expect(restored.getSystemPrompt()).toContain('Role NEW');
    expect(restored.getSystemPrompt().split('SHARED_NEW')).toHaveLength(2);
    expect(restored.data().boundProfile?.promptBase?.delegationSnippet).toBe(snippet);
    if (snippet !== undefined) expect(restored.getSystemPrompt().split(snippet)).toHaveLength(2);
    else {
      expect(restored.getSystemPrompt()).not.toContain(TASK_AGENT_ROLE_PREFIX);
      expect(restored.getSystemPrompt()).not.toContain(DEFAULT_INDEPENDENT_DELEGATION_NOTICE);
    }
    expect(restored.data().appliedLease).toEqual(before.appliedLease);
    expect(restored.data().activeToolNames).toEqual(before.activeToolNames);
  });

  it('does not inject a prefix when the main agent binds explore', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: 'explore', model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain('codebase exploration specialist');
    expect(prompt).not.toContain(TASK_AGENT_ROLE_PREFIX);
    expect(prompt).not.toContain('${delegation_context}');
  });

  it('fills explore overlay with the TASK prefix when bound as a subagent', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'explore',
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain(TASK_AGENT_ROLE_PREFIX);
    expect(prompt).toContain('codebase exploration specialist');
    expect(prompt).not.toContain('${delegation_context}');
  });

  it('prepends the TASK prefix to general when bound as a subagent', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'general',
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain(TASK_AGENT_ROLE_PREFIX);
    expect(prompt).toContain('Your final message is the entire handoff');
    expect(prompt.split('Your final message is the entire handoff').length).toBe(2);
  });

  it('prepends the TASK prefix to a custom file profile bound as a subagent', async () => {
    const custom = normalizeAgentProfile({
      name: 'custom-reviewer',
      systemPrompt: () => 'CUSTOM BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'custom-reviewer',
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    expect(profile.getSystemPrompt()).toContain(TASK_AGENT_ROLE_PREFIX);
    expect(profile.getSystemPrompt()).toContain('CUSTOM BODY');
    expect(profile.getSystemPrompt().indexOf(TASK_AGENT_ROLE_PREFIX)).toBeLessThan(
      profile.getSystemPrompt().indexOf('CUSTOM BODY'),
    );
  });

  it('uses the independent notice and honors delegation_notice off', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      systemPrompt: () => 'CUSTOM BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      delegationPosition: 'independent',
    });
    expect(profile.getSystemPrompt()).toContain(DEFAULT_INDEPENDENT_DELEGATION_NOTICE);
    expect(profile.getSystemPrompt()).toContain('CUSTOM BODY');
    expect(profile.getSystemPrompt()).not.toContain(TASK_AGENT_ROLE_PREFIX);

    const quiet = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      delegationNotice: 'off',
      systemPrompt: () => 'CUSTOM BODY',
    });
    await ctx.dispose();
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(quiet)),
    );
    const quietProfile = ctx.get(IAgentProfileService);
    await quietProfile.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    expect(quietProfile.getSystemPrompt()).toContain('CUSTOM BODY');
    expect(quietProfile.getSystemPrompt()).not.toContain(TASK_AGENT_ROLE_PREFIX);
  });

  it('consumes the four prompt override scopes in priority order', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      promptOverrides: { fields: { 'system.language': '# Language\n\nPROFILE' } },
      modelProfiles: [{
        alias: MOCK_MODEL,
        promptOverrides: { fields: { 'system.language': '# Language\n\nPROFILE_MODEL' } },
      }],
      renderSystemPrompt: (context) => renderSystemPromptResult('', context, { skillActive: false }),
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
      { initialConfig: { prompt: { overrides: { fields: { 'system.language': '# Language\n\nGLOBAL' } } } } },
    );
    const model = ctx.kimiConfig.models![MOCK_MODEL]!;
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]: {
          ...model,
          promptOverrides: { fields: { 'system.language': '# Language\n\nMODEL' } },
        },
      },
    };
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain('PROFILE_MODEL');
    expect(profile.getSystemPrompt()).not.toContain('\n\nPROFILE\n');
    expect(profile.getSystemPrompt()).not.toContain('\n\nMODEL\n');
    expect(profile.getSystemPrompt()).not.toContain('\n\nGLOBAL\n');
  });

  it('marks reply style shadowed when an intent override removes its slot', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      promptOverrides: { fields: {
        'system.intent_tool_use': '# Intent, Continuity, and Tool Use\n\nCUSTOM INTENT',
        'system.reply_style': 'CUSTOM STYLE ${reply_style_guide}',
      } },
      renderSystemPrompt: (context) => renderSystemPromptResult('', context, { skillActive: false }),
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const fields = new Map(profile.getPromptFieldSnapshot().fields.map((field) => [field.id, field.status]));
    expect(fields.get('system.intent_tool_use')).toBe('effective');
    expect(fields.get('system.reply_style')).toBe('shadowed');
    expect(profile.getSystemPrompt()).toContain('CUSTOM INTENT');
    expect(profile.getSystemPrompt()).not.toContain('CUSTOM STYLE');
  });

  it('uses delegation notice fields while keeping the boolean gate authoritative', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      systemPrompt: () => 'CUSTOM BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
      { initialConfig: { prompt: { overrides: { fields: { 'delegation.sub.notice': 'CUSTOM NOTICE' } } } } },
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    expect(profile.getSystemPrompt()).toContain('CUSTOM NOTICE');
    expect(profile.getSystemPrompt()).not.toContain(TASK_AGENT_ROLE_PREFIX);
  });

  it('marks whole-prompt and anchor shadowing in the internal field snapshot', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      sourcePath: '/home/example/SYSTEM.md',
      systemPromptMode: 'replace',
      promptOverrides: { fields: {
        'system.language': '# Language\n\nCUSTOM',
        'system.shared': 'SHARED',
        'delegation.sub.notice': 'NOTICE',
      } },
      systemPrompt: () => 'CUSTOM BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    const ordinary = new Map(profile.getPromptFieldSnapshot().fields.map((field) => [field.id, field.status]));
    expect(ordinary.get('system.language')).toBe('shadowed');
    expect(ordinary.get('system.shared')).toBe('effective');
    expect(ordinary.get('delegation.sub.notice')).toBe('effective');
    const anchored = new Map(profile.getPromptFieldSnapshot({ anchor: true }).fields.map((field) => [field.id, field.status]));
    expect(anchored.get('system.language')).toBe('inactive');
    expect(anchored.get('system.shared')).toBe('inactive');
    expect(anchored.get('delegation.sub.notice')).toBe('inactive');
  });

  it('does not inject when agents.delegation.sub is false', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      systemPrompt: () => 'CUSTOM BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
      { initialConfig: { agents: { delegation: { sub: false } } } },
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    });
    expect(profile.getSystemPrompt()).toContain('CUSTOM BODY');
    expect(profile.getSystemPrompt()).not.toContain(TASK_AGENT_ROLE_PREFIX);
  });

  it('binds a sub model outside allowed_models and records an advisory', async () => {
    const custom = normalizeAgentProfile({
      name: 'locked-child',
      allowedModels: ['grok-4.6'],
      systemPrompt: () => 'LOCKED',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await expect(profile.bind({
      profile: 'locked-child',
      model: MOCK_MODEL,
      delegationPosition: 'sub',
    })).resolves.toBeUndefined();
    expect(profile.data().bindingAdvisories).toEqual([
      expect.objectContaining({ code: 'model_not_allowed', effectiveValue: MOCK_MODEL }),
    ]);
  });

  it('rejects a sub bind denied by [subagent].deny_models even without a lease', async () => {
    const custom = normalizeAgentProfile({
      name: 'open-child',
      systemPrompt: () => 'OPEN',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
      { initialConfig: { subagent: { denyModels: [MOCK_MODEL] } } },
    );
    await expect(
      ctx.get(IAgentProfileService).bind({
        profile: 'open-child',
        model: MOCK_MODEL,
        delegationPosition: 'sub',
      }),
    ).rejects.toSatisfy((error) => isError2(error) && error.code === ErrorCodes.CONFIG_INVALID);
  });

  it('does not bind [subagent].deny_models against the main agent', async () => {
    const custom = normalizeAgentProfile({
      name: 'open-child',
      systemPrompt: () => 'OPEN',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
      { initialConfig: { subagent: { denyModels: [MOCK_MODEL] } } },
    );
    await ctx.get(IAgentProfileService).bind({
      profile: 'open-child',
      model: MOCK_MODEL,
    });
    expect(ctx.get(IAgentProfileService).getSystemPrompt()).toContain('OPEN');
  });

  it('reapplies slot 4 after a snapshot replay refreshes the system prompt', async () => {
    const custom = normalizeAgentProfile({
      name: 'leased-child',
      systemPrompt: () => 'CHILD BODY',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'leased-child',
      model: MOCK_MODEL,
      delegationPosition: 'sub',
      lease: {
        name: 'leased-child',
        promptMode: 'prepend',
        prompt: 'LEASE PREPEND',
      },
    });
    expect(profile.getSystemPrompt()).toContain('LEASE PREPEND');
    expect(profile.getSystemPrompt()).toContain('CHILD BODY');
    expect(profile.data().appliedLease).toEqual({
      name: 'leased-child',
      promptMode: 'prepend',
      prompt: 'LEASE PREPEND',
    });
    profile.applyBindingSnapshot(profile.data());
    await profile.refreshSystemPrompt();
    expect(profile.getSystemPrompt()).toContain('LEASE PREPEND');
    expect(profile.getSystemPrompt()).toContain('CHILD BODY');
  });

  it('restores a scoped definition exactly with its lease and spawn policy', async () => {
    const publicProfile = normalizeAgentProfile({
      name: 'secret',
      definitionId: 'public-secret',
      systemPrompt: () => 'PUBLIC BODY',
    });
    const scopedProfile = normalizeAgentProfile({
      name: 'secret',
      definitionId: 'private-secret',
      systemPrompt: () => 'PRIVATE BODY',
    });
    const catalog: ISessionAgentProfileCatalog = {
      ...catalogWith(publicProfile),
      snapshot: () => ({
        publicProfiles: new Map([['secret', publicProfile]]),
        defaultProfile: publicProfile,
        routes: new Map(),
        scopedBindings: new Map([
          [
            'parent-definition',
            new Map([
              [
                'secret',
                {
                  parentDefinitionId: 'parent-definition',
                  alias: 'secret',
                  source: './_private/secret.md',
                  lease: { name: 'secret', source: './_private/secret.md' },
                  status: 'ready',
                  sourceDefinitionId: 'private-secret',
                  profile: scopedProfile,
                },
              ],
            ]),
          ],
        ]),
        sourceDefinitions: new Map([['private-secret', scopedProfile]]),
        dependencyIndex: new Map(),
        diagnostics: [],
      }),
    };
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'secret',
      resolvedProfile: scopedProfile,
      model: MOCK_MODEL,
      delegationPosition: 'sub',
      lease: {
        name: 'secret',
        promptMode: 'prepend',
        prompt: 'LEASE PREPEND',
      },
      spawnPolicy: { disallowedTools: ['Bash'] },
    });
    const snapshot = profile.data();
    profile.applyBindingSnapshot(snapshot);

    await profile.refreshSystemPrompt();

    expect(profile.getSystemPrompt()).toContain('LEASE PREPEND');
    expect(profile.getSystemPrompt()).toContain('PRIVATE BODY');
    expect(profile.getSystemPrompt()).not.toContain('PUBLIC BODY');
    expect(
      (profile as unknown as { activeProfile?: { disallowedTools?: readonly string[] } })
        .activeProfile?.disallowedTools,
    ).toContain('Bash');
  });
});
