import { describe, expect, it, vi } from 'vitest';
import { loadDispatchProfileFile, inheritProfileFileSources } from '#/session/dispatch/profileFile';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { createTestAgent } from '../../harness';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';

it('freezes a scoped profile source graph through JSON and resolves it without rereading files or polluting names', async () => {
  const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => 'original' });
  const catalog = { get: () => original, getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
  const files = new Map([
    ['/workspace/team.md', '---\nname: coder\ndescription: Team\nmodel_alias: model-a\nsubagents:\n  - name: research\n    source: ./_private/research.md\n---\nROOT SOURCE'],
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
  const caller: ProfileData = { thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY, subagents: ['coder', 'research'], activeToolNames: ['Read'] };
  const loaded = await loadDispatchProfileFile('team.md', runtime, { workDir: '/workspace' }, catalog, caller);
  const bound = JSON.parse(JSON.stringify(freezeBoundProfile(loaded.snapshot.publicProfiles.get('coder')!)));
  expect(Object.keys(bound.fileSources.sourceDefinitions)).toHaveLength(1);
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
      const catalog = ctx.get(ISessionAgentProfileCatalog);
      const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
      Object.defineProperty(fake, 'fs', { value: {
        realpath: async (path: string) => path,
        readText: async () => '---\nname: coder\ndescription: File role\nallowed_models: [preferred-model]\ntools: [Read, Write]\nsubagents: [coder, explore]\n---\nFile role',
      } as unknown as IHostFileSystem });
      const loaded = await loadDispatchProfileFile('role.md', fake, { workDir: '/workspace' }, catalog, {
        thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
        activeToolNames: ['Read'], disallowedTools: ['Bash'],
        subagentPolicy: 'advisory', subagents: ['explore'],
      });
      const svc = ctx.get(IAgentProfileService);
      await svc.bind({
        resolvedProfile: loaded.snapshot.publicProfiles.get('coder')!, model: 'mock-model',
        delegationPosition: 'sub',
        lease: { name: 'coder', tools: ['Read', 'Write'], disallowedTools: [], subagents: ['coder', 'explore'] },
      });
      const policy = ctx.get(IAgentToolPolicyService);
      expect(policy.isToolActive('Read')).toBe(true);
      expect(policy.isToolActive('Write')).toBe(false);
      expect(svc.data().disallowedTools).toContain('Bash');
      expect(svc.data().subagents).toEqual(['coder', 'explore']);
      expect(svc.data().bindingAdvisories).toEqual([
        expect.objectContaining({
          code: 'model_not_allowed',
          ruleSource: 'profile-file:/workspace/role.md.allowed_models',
          effectiveValue: 'mock-model',
        }),
      ]);
      const apply = await svc.prepareResumeBinding({});
      apply();
      expect(policy.isToolActive('Write')).toBe(false);
      expect(JSON.stringify(svc.data().boundProfile)).toContain('/workspace/role.md');
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });
  it('does not freeze advisory recommendations into a pinned file hard ceiling', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: reviewer\ndescription: File role\nsubagent_policy: advisory\nsubagents: [researcher]\n---\nFile role',
    } as unknown as IHostFileSystem });
    const loaded = await loadDispatchProfileFile('role.md', fake, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
      subagentPolicy: 'advisory', subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });
    expect(loaded.snapshot.publicProfiles.get('reviewer')).toMatchObject({
      subagentPolicy: 'advisory',
      subagents: ['researcher'],
    });
  });

  it('propagates an explicit strict caller subagent ceiling into a profile file', async () => {
    const original = normalizeAgentProfile({ name: 'coder', systemPrompt: () => '' });
    const catalog = { getDefault: () => original, list: () => [original] } as unknown as ISessionAgentProfileCatalog;
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => '---\nname: reviewer\ndescription: File role\nsubagents: [researcher, explore]\n---\nFile role',
    } as unknown as IHostFileSystem });
    const loaded = await loadDispatchProfileFile('role.md', fake, { workDir: '/workspace' }, catalog, {
      thinkingLevel: 'off', systemPrompt: '', modelCapabilities: UNKNOWN_CAPABILITY,
      subagentPolicy: 'strict', subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });
    expect(loaded.snapshot.publicProfiles.get('reviewer')).toMatchObject({
      subagentPolicy: 'strict',
      subagents: ['explore'],
    });
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
