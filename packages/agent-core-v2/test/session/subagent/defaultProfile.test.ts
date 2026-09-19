import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { IConfigService } from '#/app/config/config';
import { SubagentTool } from '#/agent/tools/agent/agentTool';
import { SubagentToolInputSchema } from '#/agent/tools/agent/agent';
import {
  DEFAULT_SUBAGENT_PROFILE,
  SUBAGENT_SECTION,
  resolveDefaultSubagentProfileName,
  type SubagentConfig,
} from '#/session/subagent/configSection';
import { discoverAgentFiles } from '@kiki/agent-profiles/agentFileDiscovery';
import { profilesFromDiscovery } from '@kiki/agent-profiles/agentProfileFromFile';
import { projectAgentProfileCatalog } from '@kiki/agent-profiles/profileCatalog';
import { renderSystemPromptResult } from '#/app/agentProfileCatalog/profile-shared';
import { ShippedAgentProfileManagerService } from '#/app/shippedAgentProfiles/shippedAgentProfileManagerService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { agentProfilesHostFs } from '#/workspace/workspaceAgentProfileLoader/internal/hostFs';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function configWithSubagent(section?: Partial<SubagentConfig>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
    get: (domain: string) => (domain === SUBAGENT_SECTION ? section : undefined),
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
  } as unknown as IConfigService;
}

function toolWithConfig(config: IConfigService): SubagentTool {
  const tool = Object.create(SubagentTool.prototype) as SubagentTool;
  Object.defineProperty(tool, 'config', { value: config });
  return tool;
}

describe('resolveDefaultSubagentProfileName', () => {
  it('defaults to the shipped general profile', () => {
    const config = configWithSubagent({ defaultProfile: DEFAULT_SUBAGENT_PROFILE });
    expect(resolveDefaultSubagentProfileName(config)).toBe('general');
  });

  it('respects a configured custom profile name', () => {
    const config = configWithSubagent({ defaultProfile: ' my-worker ' });
    expect(resolveDefaultSubagentProfileName(config)).toBe('my-worker');
  });

  it('treats an empty value as strict (require explicit target)', () => {
    expect(resolveDefaultSubagentProfileName(configWithSubagent({ defaultProfile: '' }))).toBeUndefined();
    expect(resolveDefaultSubagentProfileName(configWithSubagent({ defaultProfile: '   ' }))).toBeUndefined();
  });

  it('inherits general when the section or only defaultProfile is missing', () => {
    expect(resolveDefaultSubagentProfileName(configWithSubagent(undefined))).toBe('general');
    expect(resolveDefaultSubagentProfileName(configWithSubagent({ timeoutMs: 1000 }))).toBe('general');
  });
});

describe('SubagentToolInputSchema', () => {
  it('leaves an omitted profile omitted instead of injecting a default', () => {
    const parsed = SubagentToolInputSchema.parse({ prompt: 'do it', description: 'a task' });
    expect(parsed.profile).toBeUndefined();
  });

  it('keeps an explicit profile and drops blank ones', () => {
    const parsed = SubagentToolInputSchema.parse({ prompt: 'do it', description: 'a task', profile: 'explore' });
    expect(parsed.profile).toBe('explore');
    const blank = SubagentToolInputSchema.parse({ prompt: 'do it', description: 'a task', profile: '' });
    expect(blank.profile).toBeUndefined();
  });
});

describe('SubagentTool default-target resolution', () => {
  it('resolves omitted-target dispatch to the configured default profile', () => {
    const tool = toolWithConfig(configWithSubagent({ defaultProfile: DEFAULT_SUBAGENT_PROFILE }));
    const resolve = (tool as unknown as { requireDefaultProfileName(): string }).requireDefaultProfileName.bind(tool);
    expect(resolve()).toBe('general');
  });

  it('rejects omitted-target dispatch with a recovery hint when no default is configured', () => {
    const tool = toolWithConfig(configWithSubagent({ defaultProfile: '' }));
    const resolve = (tool as unknown as { requireDefaultProfileName(): string }).requireDefaultProfileName.bind(tool);
    try {
      resolve();
      expect.unreachable('requireDefaultProfileName should throw');
    } catch (error) {
      expect(isError2(error)).toBe(true);
      const error2 = error as Error2;
      expect(error2.code).toBe(ErrorCodes.PROFILE_UNKNOWN);
      expect(error2.message).toContain('[subagent].default_profile');
      expect(error2.message).toContain('profile');
    }
  });
});

describe('materialized default target resolves through the file catalog', () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'default-profile-')));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('loads agent/explore/general from the materialized builtin directory with expected semantics', async () => {
    const log = { _serviceBrand: undefined, warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, setLevel: () => {} } as never;
    const manager = new ShippedAgentProfileManagerService(stubBootstrap(home), new HostFileSystem(), log, configWithSubagent(undefined));
    await manager.ready;

    const fs = new HostFileSystem();
    const roots = [{ path: join(home, 'agents'), source: 'user' as const }];
    const base = (context: Parameters<typeof renderSystemPromptResult>[1]) =>
      renderSystemPromptResult('', context, { skillActive: true });
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(agentProfilesHostFs(fs), roots, () => {}, { includeRoutes: false }),
      base,
      base,
    );
    const projection = projectAgentProfileCatalog({
      entries: [{ sourceId: 'user', priority: 10, contribution }],
      disabledNamedProfiles: new Set(),
      routeBaseMissingCode: 'agent_profile_route.base_missing',
      warn: () => {},
    });

    const agent = projection.resolvableProfiles.get('agent');
    expect(agent?.main).toBe(true);
    expect(agent?.subagentPolicy).toBe('advisory');
    expect(agent?.subagents).toBeUndefined();
    expect(agent?.tools).toContain('AgentRun');

    const general = projection.resolvableProfiles.get('general');
    expect(general).toBeDefined();
    expect(general?.subagentPolicy).toBe('strict');
    expect(general?.subagents).toEqual([]);
    expect(general?.tools).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'Skill']),
    );
    expect(general?.tools).not.toContain('AgentRun');

    expect(projection.resolvableProfiles.get('explore')?.subagentPolicy).toBe('advisory');
    expect(projection.resolvableProfiles.has('coder')).toBe(false);
    expect(projection.resolvableProfiles.has('plan')).toBe(false);
    expect(projection.snapshot.defaultProfile?.name).toBe('agent');
  });
});
