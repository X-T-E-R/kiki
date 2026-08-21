import { describe, expect, it } from 'vitest';

import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveSubagentDispatch } from '#/app/agentProfileCatalog/subagentDispatch';
import {
  parseSpawnConstraints,
  parseSubagentList,
  SubagentLeaseParseError,
} from '#/app/agentProfileCatalog/subagentLease';
import { ErrorCodes, isError2 } from '#/errors';

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

  it('coerces empty lists to omitted fields', () => {
    expect(parseSpawnConstraints({ allowed_models: [] }, PATH)).toBeUndefined();
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
