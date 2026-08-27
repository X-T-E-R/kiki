import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
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

  it('prepends the TASK prefix to coder when bound as a subagent', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({
      profile: 'coder',
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

  it('rejects a sub bind whose model is outside the child allowed_models', async () => {
    const custom = normalizeAgentProfile({
      name: 'locked-child',
      allowedModels: ['grok-4.6'],
      systemPrompt: () => 'LOCKED',
    });
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalogWith(custom)),
    );
    await expect(
      ctx.get(IAgentProfileService).bind({
        profile: 'locked-child',
        model: MOCK_MODEL,
        delegationPosition: 'sub',
      }),
    ).rejects.toSatisfy((error) => isError2(error) && error.code === ErrorCodes.CONFIG_INVALID);
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
