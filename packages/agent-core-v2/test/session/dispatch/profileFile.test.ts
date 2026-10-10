import { describe, expect, it, vi } from 'vitest';
import { loadDispatchProfileFile, inheritProfileFileSources } from '#/session/dispatch/profileFile';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { createTestAgent } from '../../harness';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';

it.each([{ tools: undefined }, { tools: ['manage_task'] }, { tools: ['*'] }])('freezes source declarations separately from native catalogs ($tools)', async ({ tools }) => {
  const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => 'original' });
  const catalog = { get: () => original, getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
  const files = new Map([
    ['/workspace/team.md', '---\nname: coder\ndescription: Team\nmodel_alias: model-a\nallowed_subagents:\n  - name: research\n    source: ./_private/research.md\n---\nROOT SOURCE'],
    ['/workspace/_private/research.md', '---\nname: research\ndescription: Research\nprivate: true\nmodel_alias: model-a\ntools: [Read]\n---\nFROZEN RESEARCH SOURCE'],
  ]);
  const readText = vi.fn(async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error('missing fixture');
    return text;
  });
  const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
  Object.defineProperty(fake, 'fs', { value: {
    realpath: async (path: string) => path, readText,
  } as unknown as IHostFileSystem });
  const runtime: Runtime = fake;
  const caller: ProfileData = { thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY, allowedSubagents: ['coder', 'research'], activeToolNames: ['Read'], toolOverride: tools === undefined ? undefined : { tools } };
  const loaded = await loadDispatchProfileFile('team.md', runtime, { workDir: '/workspace' }, catalog, caller);
  const bound = JSON.parse(JSON.stringify(freezeBoundProfile(loaded.snapshot.publicProfiles.get('coder')!)));
  expect(Object.keys(bound.fileSources.sourceDefinitions)).toHaveLength(1);
  expect(bound.fileSources.callerCeiling).toMatchObject({ activeToolNames: ['Read'], externalToolAllowPolicies: tools === undefined ? [] : [tools] });
  expect(bound.sourcePath).toBe('/workspace/team.md');
  expect(catalog.get('coder')).toBe(original);
  expect(readText).toHaveBeenCalledTimes(2);
  files.clear();
  readText.mockClear();
  const restored = inheritProfileFileSources({ ...caller, profileDefinitionId: bound.definitionId, boundProfile: bound }, catalog)!;
  const child = restored.scopedBindings.get(bound.definitionId)?.get('research');
  expect(child?.status).toBe('ready');
  expect(child?.profile?.systemPrompt({})).toContain('FROZEN RESEARCH SOURCE');
  expect(readText).not.toHaveBeenCalled();
  expect(restored.publicProfiles.get('coder')).toBe(original);
});

describe('profile file runtime isolation', () => {
  it('retains tool ceilings without promoting explicit advisory recommendations to a hard ceiling', async () => {
    const ctx = createTestAgent();
    try {
      await ctx.get(ISessionMetadata).registerAgent('main', { type: 'main' });
      const catalog = ctx.get(ISessionAgentProfileCatalog);
      const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
      Object.defineProperty(fake, 'fs', { value: {
        realpath: async (path: string) => path,
        readText: async () => '---\nname: coder\ndescription: File role\npreferred_models: [preferred-model]\ntools: [Read, Write]\nallowed_subagents: [coder, explore]\n---\nFile role',
      } as unknown as IHostFileSystem });
      const loaded = await loadDispatchProfileFile('role.md', fake, { workDir: '/workspace' }, catalog, {
        thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
        activeToolNames: ['Read'], disallowedTools: ['Bash'],
        preferredSubagents: ['explore'],
      });
      const svc = ctx.get(IAgentProfileService);
      await svc.bind({
        resolvedProfile: loaded.snapshot.publicProfiles.get('coder')!, model: 'mock-model',
        delegationPosition: 'sub',
        lease: { name: 'coder', tools: ['Read', 'Write'], disallowedTools: [], allowedSubagents: ['coder', 'explore'] },
      });
      const policy = ctx.get(IAgentToolPolicyService);
      expect(policy.isToolActive('Read')).toBe(true);
      expect(policy.isToolActive('Write')).toBe(false);
      expect(svc.data().disallowedTools).toContain('Bash');
      expect(svc.data().allowedSubagents).toEqual(['coder', 'explore']);
      expect(svc.data().bindingAdvisories).toEqual([
        expect.objectContaining({
          code: 'model_not_preferred',
          ruleSource: 'profile-file:/workspace/role.md.preferred_models',
          effectiveValue: 'mock-model',
        }),
      ]);
      const binding = await svc.prepareResumeBinding({});
      expect(await ctx.get(IAgentModelSwitchService).execute({ operationId: 'profile-file-resume', model: binding.model, thinking: binding.thinking, mode: 'direct' }, { binding })).toMatchObject({ state: 'completed' });
      expect(policy.isToolActive('Write')).toBe(false);
      expect(JSON.stringify(svc.data().boundProfile)).toContain('/workspace/role.md');
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });
  it('keeps a file definition’s own preset permissions without copying its caller’s selection list', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: reviewer\ndescription: File role\nallowed_subagents: [researcher, explore]\npreferred_subagents: [researcher]\n---\nFile role',
    } as unknown as IHostFileSystem });
    const loaded = await loadDispatchProfileFile('role.md', fake, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
      allowedSubagents: [], preferredSubagents: ['explore'], denySubagents: ['reviewer'],
    });
    const profile = loaded.snapshot.publicProfiles.get('reviewer')!;
    expect(profile).toMatchObject({ allowedSubagents: ['researcher', 'explore'], preferredSubagents: ['researcher'] });
    expect(profile.denySubagents).toBeUndefined();
    expect(JSON.parse(JSON.stringify(freezeBoundProfile(profile))).fileSources.callerCeiling).not.toHaveProperty('allowedSubagents');
  });

  it('loads a main profile file as a role for explicit dispatch', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: solo\ndescription: Main role\nmain: true\nmodel_alias: model-a\n---\nMAIN ROLE',
    } as unknown as IHostFileSystem });
    const loaded = await loadDispatchProfileFile('main.md', fake, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
      activeToolNames: ['Read'],
    });
    expect(loaded.profileName).toBe('solo');
    expect(loaded.snapshot.publicProfiles.get('solo')).toMatchObject({ main: true, modelAlias: 'model-a' });
    expect(loaded.snapshot.publicProfiles.get('solo')?.systemPrompt({})).toContain('MAIN ROLE');
    expect(loaded.snapshot.publicProfiles.get('solo')?.toolAllowPolicies).toContainEqual(['Read']);
  });

  it('preserves an explicitly dispatched main profile file with its external executor', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: solo\ndescription: Main role\nmain: true\nexecutor: codex-app-server\n---\nMAIN ROLE',
    } as unknown as IHostFileSystem });
    const loaded = await loadDispatchProfileFile('main.md', fake, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
    });
    expect(loaded.profileName).toBe('solo');
    expect(loaded.snapshot.publicProfiles.get('solo')).toMatchObject({ main: true, executor: 'codex-app-server' });
  });

  it('rejects a canonical root that escapes the isolated workspace before reading content', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const readText = vi.fn();
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'isolated', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async () => '/outside/private.md', readText,
    } as unknown as IHostFileSystem });
    const runtime: Runtime = fake;
    await expect(loadDispatchProfileFile('linked.md', runtime, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
    })).rejects.toMatchObject({ code: 'fs.path_escapes' });
    expect(readText).not.toHaveBeenCalled();
  });
});
