import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  listAvailableSubagentTargets,
  resolveSubagentDispatch,
  resolveSubagentTarget,
} from '#/app/agentProfileCatalog/subagentDispatch';
import {
  parseSpawnConstraints,
  parseSubagentList,
  SubagentLeaseParseError,
} from '#/app/agentProfileCatalog/subagentLease';
import { ErrorCodes, isError2 } from '#/errors';
import type { IModelService } from '#/kosong/model/model';

const PATH = '/tmp/agents/grok-play.md';

describe('parseSubagentList', () => {
  it('treats a comma-separated string as names without leases', () => {
    expect(parseSubagentList('explore, worker-lite', PATH)).toEqual({
      subagents: ['explore', 'worker-lite'],
    });
  });

  it('treats a wildcard as an unrestricted allowlist', () => {
    expect(parseSubagentList(['explore', '*'], PATH)).toEqual({
      subagents: undefined,
    });
  });

  it('stores a * overlay on a named lease as unlimited replacement', () => {
    const parsed = parseSubagentList(
      [{ name: 'worker-lite', subagents: ['*'] }],
      PATH,
    );
    expect(parsed.subagentLeases?.['worker-lite']?.subagents).toBeNull();
  });

  it('stores tools: * as a full-open replacement rather than inherit', () => {
    const parsed = parseSubagentList([{ name: 'worker-lite', tools: ['*'] }], PATH);
    expect(parsed.subagentLeases?.['worker-lite']?.tools).toBeNull();
  });

  it('keeps an empty overlay as a leaf allowlist', () => {
    const parsed = parseSubagentList([{ name: 'worker-lite', subagents: [] }], PATH);
    expect(parsed.subagentLeases?.['worker-lite']?.subagents).toEqual([]);
  });

  it('parses a source lease with its overlay', () => {
    const parsed = parseSubagentList(
      [{ name: 'research-writer', source: './_private/writer.md', model_alias: 'k3-256k' }],
      PATH,
    );
    expect(parsed.subagentLeases?.['research-writer']).toMatchObject({
      name: 'research-writer',
      source: './_private/writer.md',
      modelAlias: 'k3-256k',
    });
  });

  it.each([
    '/tmp/writer.md',
    'C:\\tmp\\writer.md',
    '~/writer.md',
    'https://example.test/writer.md',
    '${HOME}/writer.md',
    '%USERPROFILE%/writer.md',
    './writer.txt',
  ])('rejects unsafe source path %s', (source) => {
    expect(() => parseSubagentList([{ name: 'writer', source }], PATH)).toThrow(
      SubagentLeaseParseError,
    );
  });

  it('rejects duplicate aliases across named and source entries', () => {
    expect(() =>
      parseSubagentList(['writer', { name: 'writer', source: './_private/writer.md' }], PATH),
    ).toThrow(/more than once/);
  });

  it('rejects a mapping without name', () => {
    expect(() => parseSubagentList([{ model_alias: 'grok-4.6' }], PATH)).toThrow(
      SubagentLeaseParseError,
    );
  });
});

describe('parseSpawnConstraints', () => {
  it('parses the closed field set', () => {
    expect(
      parseSpawnConstraints(
        {
          allowed_models: ['grok-4.6'],
          deny_models: ['gpt-5.6-sol'],
          allowed_efforts: ['high'],
          disallowed_tools: ['Bash'],
        },
        PATH,
      ),
    ).toEqual({
      allowedModels: ['grok-4.6'],
      denyModels: ['gpt-5.6-sol'],
      allowedEfforts: ['high'],
      disallowedTools: ['Bash'],
    });
  });

  it('rejects an unknown key', () => {
    expect(() => parseSpawnConstraints({ model_alias: 'grok-4.6' }, PATH)).toThrow(
      /unknown key "model_alias"/,
    );
  });

  it('keeps empty model allowlists as deny-all and wildcards as open', () => {
    expect(parseSpawnConstraints({ allowed_models: [] }, PATH)).toEqual({ allowedModels: [] });
    expect(parseSpawnConstraints({ allowed_models: '*' }, PATH)).toBeUndefined();
    expect(parseSpawnConstraints({ deny_models: [] }, PATH)).toBeUndefined();
  });
});

describe('resolveSubagentDispatch', () => {
  const publicProfile = normalizeAgentProfile({
    name: 'writer',
    definitionId: 'public-writer',
    systemPrompt: () => 'PUBLIC',
  });
  const scopedProfile = normalizeAgentProfile({
    name: 'writer',
    definitionId: 'private-writer',
    systemPrompt: () => 'PRIVATE',
  });
  const unavailableProfile = normalizeAgentProfile({
    name: 'broken',
    definitionId: 'public-broken',
    systemPrompt: () => 'PUBLIC BROKEN',
  });
  const snapshot = {
    publicProfiles: new Map([
      ['writer', publicProfile],
      ['broken', unavailableProfile],
    ]),
    defaultProfile: publicProfile,
    routes: new Map(),
    scopedBindings: new Map([
      [
        'parent-definition',
        new Map([
          [
            'writer',
            {
              parentDefinitionId: 'parent-definition',
              alias: 'writer',
              source: './_private/writer.md',
              lease: { name: 'writer', source: './_private/writer.md' },
              status: 'ready' as const,
              sourceDefinitionId: 'private-writer',
              profile: scopedProfile,
            },
          ],
          [
            'broken',
            {
              parentDefinitionId: 'parent-definition',
              alias: 'broken',
              source: './_private/broken.md',
              lease: { name: 'broken', source: './_private/broken.md' },
              status: 'unavailable' as const,
              diagnostic: {
                code: 'agent_profile_source.unavailable',
                severity: 'error' as const,
                message: 'missing',
              },
            },
          ],
        ]),
      ],
    ]),
    sourceDefinitions: new Map([['private-writer', scopedProfile]]),
    dependencyIndex: new Map(),
    diagnostics: [],
  };
  const catalog = {
    get: (name: string) => snapshot.publicProfiles.get(name),
    getDefault: () => publicProfile,
    list: () => [...snapshot.publicProfiles.values()],
    snapshot: () => snapshot,
    resolveSelection: () => ({ profile: publicProfile, baseProfile: publicProfile }),
  };

  it('applies the caller allowlist after scoped alias resolution', () => {
    for (const subagents of [[], ['other']]) {
      expect(() =>
        resolveSubagentDispatch(
          catalog,
          { profileName: 'parent', profileDefinitionId: 'parent-definition', subagents },
          { profileName: 'writer', snapshot },
        ),
      ).toThrowError(
        expect.objectContaining({ code: ErrorCodes.AGENT_TYPE_NOT_ALLOWED }),
      );
    }
    const resolved = resolveSubagentDispatch(
      catalog,
      {
        profileName: 'parent',
        profileDefinitionId: 'parent-definition',
        subagents: ['writer'],
      },
      { profileName: 'writer', snapshot },
    );
    expect(resolved.scoped).toBe(true);
    expect(resolved.selection.profile.definitionId).toBe('private-writer');
  });

  it('does not fall back to a same-name public profile when scoped is unavailable', () => {
    expect(() =>
      resolveSubagentDispatch(
        catalog,
        {
          profileName: 'parent',
          profileDefinitionId: 'parent-definition',
          subagents: ['broken'],
        },
        { profileName: 'broken', snapshot },
      ),
    ).toThrowError(
      expect.objectContaining({ code: ErrorCodes.SCOPED_PROFILE_UNAVAILABLE }),
    );
  });

  it('returns a structured allowlist error', () => {
    try {
      resolveSubagentDispatch(
        catalog,
        {
          profileName: 'parent',
          profileDefinitionId: 'parent-definition',
          subagents: [],
        },
        { profileName: 'writer', snapshot },
      );
      throw new Error('expected dispatch rejection');
    } catch (error) {
      expect(isError2(error)).toBe(true);
      if (!isError2(error)) return;
      expect(error.code).toBe(ErrorCodes.AGENT_TYPE_NOT_ALLOWED);
      expect(error.details).toEqual({ profileName: 'writer', allowlist: [] });
    }
  });
});

describe('resolved subagent targets', () => {
  const models = {
    resolveId: (id: string) => id,
  } as unknown as IModelService;
  const main = normalizeAgentProfile({
    name: 'agent',
    main: true,
    systemPrompt: () => 'MAIN',
  });
  const worker = normalizeAgentProfile({
    name: 'worker',
    tools: ['Read', 'Write'],
    modelAlias: 'base-model',
    allowedModels: ['base-model', 'leased-model'],
    systemPrompt: () => 'WORKER',
  });
  const reviewer = normalizeAgentProfile({
    name: 'reviewer',
    systemPrompt: () => 'REVIEWER',
  });
  const catalog = {
    get: (name: string) => [main, worker, reviewer].find((profile) => profile.name === name),
    getDefault: () => main,
    list: () => [main, worker, reviewer],
    resolveSelection: ({ profile }: { readonly profile?: string }) => {
      const selected = [main, worker, reviewer].find((candidate) => candidate.name === profile);
      if (selected === undefined) throw new Error('unknown test profile');
      return { profile: selected, baseProfile: selected };
    },
  };

  it('returns the effective profile after caller lease and spawn constraints', () => {
    const lease = {
      name: 'worker',
      tools: ['Read'],
      modelAlias: 'leased-model',
    } as const;
    const spawnPolicy = {
      allowedModels: ['leased-model'],
      disallowedTools: ['Bash'],
    } as const;
    const target = resolveSubagentTarget(
      catalog,
      {
        profileName: 'parent',
        subagents: ['worker'],
        subagentLeases: { worker: lease },
        spawnPolicy,
      },
      { profileName: 'worker' },
      models,
    );

    expect(target.selection.profile).toBe(worker);
    expect(target.effectiveProfile).toMatchObject({
      name: 'worker',
      tools: ['Read'],
      modelAlias: 'leased-model',
      allowedModels: ['leased-model'],
      disallowedTools: ['Bash'],
    });
    expect(target.lease).toBe(lease);
    expect(target.spawnPolicy).toBe(spawnPolicy);
  });

  it('uses the same effective target rules when describing available profiles and routes', () => {
    const lease = { name: 'worker', tools: ['Read'] } as const;
    const caller = {
      profileName: 'parent',
      subagents: ['worker'],
      subagentLeases: { worker: lease },
      spawnPolicy: { denyModels: ['route-model'] },
    } as const;
    const available = listAvailableSubagentTargets(
      catalog,
      caller,
      {
        profiles: catalog.list(),
        routes: [
          {
            id: 'worker.route',
            profile: 'worker',
            description: 'Pinned route',
            modelAlias: 'route-model',
            overriddenFields: ['model_alias'],
          },
        ],
      },
      models,
    );

    expect(available.profiles).toHaveLength(1);
    expect(available.profiles[0]).toMatchObject({ name: 'worker', tools: ['Read'] });
    expect(available.routes).toEqual([]);
  });

  it('does not fall back to a public profile when a scoped alias is unavailable', () => {
    const snapshot = {
      publicProfiles: new Map([['worker', worker]]),
      defaultProfile: main,
      routes: new Map(),
      scopedBindings: new Map([
        [
          'parent-definition',
          new Map([
            [
              'worker',
              {
                parentDefinitionId: 'parent-definition',
                alias: 'worker',
                source: './_private/worker.md',
                lease: { name: 'worker', source: './_private/worker.md' },
                status: 'unavailable' as const,
              },
            ],
          ]),
        ],
      ]),
      sourceDefinitions: new Map(),
      dependencyIndex: new Map(),
      diagnostics: [],
    };
    const caller = {
      profileName: 'parent',
      profileDefinitionId: 'parent-definition',
      subagents: ['worker'],
    } as const;

    const available = listAvailableSubagentTargets(
      catalog,
      caller,
      { profiles: [worker], routes: [], snapshot },
      models,
    );
    expect(available.profiles).toEqual([]);

    try {
      resolveSubagentTarget(catalog, caller, { profileName: 'worker', snapshot }, models);
      throw new Error('expected scoped profile resolution to fail');
    } catch (error) {
      expect(isError2(error)).toBe(true);
      if (isError2(error)) expect(error.code).toBe(ErrorCodes.SCOPED_PROFILE_UNAVAILABLE);
    }
  });
});
