import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime, RuntimeCapability, RuntimeStatus } from '#/runtime/runtime';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSystemPrompt } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import {
  BUILTIN_SKILL_SOURCE_ID,
  PLUGIN_SKILL_SOURCE_ID,
} from '#/app/skillCatalog/skillSource';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { DEFAULT_PRODUCT_NAME } from '#/app/agentProfileCatalog/profile-shared';
import { renderPromptTemplateResult } from '@kiki/agent-profiles/profileShared';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { resolveAgentProfileRoute } from '@kiki/agent-profiles/agentProfileRoute';
import { freezeBoundProfile } from '#/agent/profile/boundProfile';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IMemoryScopes } from '#/app/memory/memoryScopes';
import type { PromptConfig } from '#/app/prompt/configSection';
import {
  ISessionAgentProfileCatalog,
  type ISessionAgentProfileCatalog as SessionAgentProfileCatalog,
} from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import { stubAgentIdentity } from '../../app/agentIdentity/stubs';

import {
  agentService,
  appService,
  createTestAgent,
  execEnvServices,
  hostEnvironmentServices,
  homeDirServices,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const profile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'agents-profile',
  systemPrompt: (context) =>
    typeof context['agentsMd'] === 'string' ? (context['agentsMd'] as string) : '',
  tools: [],
});

const pluginProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'plugin-profile',
  systemPrompt: (context) =>
    typeof context['pluginSections'] === 'string' ? context['pluginSections'] : '',
  tools: [],
});

const skillsProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'skills-profile',
  systemPrompt: (context) => `skills:${context.skills ?? ''}`,
  tools: ['Skill'],
});

const agentsAndPluginsProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'agents-and-plugins-profile',
  systemPrompt: (context) =>
    `agents:${typeof context['agentsMd'] === 'string' ? context['agentsMd'] : ''}\n` +
    `plugins:${context['pluginSections'] ?? ''}`,
  tools: [],
});

const exactProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'exact-profile',
  systemPrompt: (context) =>
    [
      `cwd:${context.cwd ?? ''}`,
      `os:${context.osKind ?? ''}`,
      `shell:${context.shellName ?? ''}:${context.shellPath ?? ''}`,
      `agents:${context.agentsMd ?? ''}`,
      `ls:${context.cwdListing ?? ''}`,
      `extra:${context.additionalDirsInfo ?? ''}`,
    ].join('\n'),
  tools: ['Read', 'Write'],
});

describe('AgentProfileService.applyProfile', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-apply-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-apply-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function buildContext(
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): { ctx: TestAgentContext; profile: IAgentProfileService } {
    const fs = new HostFileSystem();
    ctx = createTestAgent(
      execEnvServices({ hostFs: fs }),
      hostEnvironmentServices(homeDir, process.platform === 'win32' ? 'win32' : 'posix'),
      { cwd: workDir },
      ...extra,
    );
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  it('keeps a fresh binding byte-stable while clock and directory snapshots change', async () => {
    const { ctx: host, profile: svc } = buildContext();
    const { IAgentStateService } = await import('#/agent/state/agentState');
    const { profileKey } = await import('#/agent/profile/profileOps');
    const { dynamicPromptKey, IDynamicPromptInjection } = await import('#/agent/profile/dynamicPrompt');
    const { IAgentContextInjectorService } = await import('#/agent/contextInjector/contextInjector');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');
    const { IHostClock } = await import('#/os/interface/hostClock');
    const states = host.get(IAgentStateService);
    states.set(profileKey, { ...states.get(profileKey), systemPrompt: '', renderGeneration: 0 });
    const native = normalizeAgentProfile({ name: 'stable-runtime', tools: [], renderSystemPrompt: (context) =>
      renderPromptTemplateResult('BASE ${now}|${cwd}|${cwd_listing}|${agents_md}', context, { skillActive: false }) });
    await svc.applyProfile(native);
    host.get(IDynamicPromptInjection);
    const injector = host.get(IAgentContextInjectorService);
    await injector.reconcileAllAtSafeBoundary();
    const first = svc.data().systemPrompt;
    const original = [...host.get(IAgentContextMemoryService).get()];
    vi.spyOn(host.get(IHostClock), 'now').mockReturnValue(new Date('2030-01-01T00:00:00.000Z'));
    await writeFile(join(workDir, 'changed.txt'), 'new work');
    await svc.refreshSystemPrompt();
    expect(svc.data().systemPrompt).toBe(first);
    expect(states.get(dynamicPromptKey)?.content).not.toContain('changed.txt');
    await injector.reconcileAllAtSafeBoundary();
    expect(host.get(IAgentContextMemoryService).get().slice(0, original.length)).toEqual(original);
    const messages = host.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'runtime_snapshot');
    expect(messages).toHaveLength(2);
    const delta = messages[1]!.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
    expect(delta).toContain('other sections unchanged since revision 1');
    expect(delta).toContain('## Runtime/workspace');
    expect(delta).not.toContain('## Applicable workspace instructions');
    expect(delta).not.toContain('## Scoped memory');
    await injector.reconcileAllAtSafeBoundary();
    expect(host.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'runtime_snapshot')).toHaveLength(2);
    const { ISessionContext } = await import('#/session/sessionContext/sessionContext');
    Object.defineProperty(host.get(ISessionContext), 'cwd', { configurable: true, get: () => homeDir });
    await writeFile(join(homeDir, 'new-cwd.txt'), 'new directory');
    await svc.refreshSystemPrompt();
    expect(states.get(dynamicPromptKey)?.context.cwdListing).toContain('new-cwd.txt');
    expect(states.get(dynamicPromptKey)?.context.cwdListing).not.toContain('changed.txt');
  });

  it('coalesces committed memory changes into a complete section replacement without touching system, tools or old messages', async () => {
    const { ctx: host, profile: svc } = buildContext({ initialConfig: { memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} } } },
      homeDirServices(homeDir),
      appService(IMemoryScopes, { _serviceBrand: undefined, resolve: async (scope) => scope.kind === 'global' ? 'memory/global' : scope.kind === 'workspace' ? 'memory/workspace' : `memory/personas/${scope.personaId}/${scope.kind}` }));
    const { IAgentStateService } = await import('#/agent/state/agentState');
    const { profileKey } = await import('#/agent/profile/profileOps');
    const { dynamicPromptKey, IDynamicPromptInjection } = await import('#/agent/profile/dynamicPrompt');
    const { IAgentContextInjectorService } = await import('#/agent/contextInjector/contextInjector');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');
    const { IMemoryStore } = await import('#/app/memory/memoryStore');
    const { IAgentMemorySnapshot } = await import('#/app/memory/memorySnapshot');
    const states = host.get(IAgentStateService);
    states.set(profileKey, { ...states.get(profileKey), renderGeneration: 0 });
    const native = normalizeAgentProfile({ name: 'memory-runtime', tools: ['Read'], renderSystemPrompt: (context) =>
      renderPromptTemplateResult('BASE ${now}|${cwd}|${memory}', context, { skillActive: false }) });
    await svc.applyProfile(native);
    host.get(IDynamicPromptInjection);
    const injector = host.get(IAgentContextInjectorService);
    const context = host.get(IAgentContextMemoryService);
    const store = host.get(IMemoryStore);
    const mutation = { action: 'create' as const, scope: { kind: 'global' as const }, type: 'feedback' as const, title: 'Saved build rule', body: 'Use the package manager.', reason: 'user instruction', source: { writer: 'user' as const } };
    await injector.reconcileAllAtSafeBoundary();
    const system = svc.getSystemPrompt();
    const tools = svc.getActiveToolNames();
    const original = JSON.parse(JSON.stringify(context.get()));
    const oldContext = states.get(dynamicPromptKey)!.context;
    const created = await store.put(mutation);
    const edited = await store.put({ ...mutation, action: 'update', id: created.entry.id, expectedRevision: created.entry.revision, body: 'Use the checked-in lockfile.' });
    expect(context.get()).toEqual(original);
    const scans = vi.spyOn(store, 'list');
    await injector.reconcileAllAtSafeBoundary();
    expect(scans).toHaveBeenCalledTimes(2);
    expect(states.get(dynamicPromptKey)?.context.memory).toContain(edited.entry.body);
    const snapshots = () => context.get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'runtime_snapshot');
    const textOf = (message: ReturnType<typeof snapshots>[number]) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
    expect(snapshots()).toHaveLength(2);
    const delta = textOf(snapshots()[1]!);
    expect(delta).toContain('Only the sections below replace earlier values');
    expect(delta).toContain('## Scoped memory');
    expect(delta).toContain(edited.entry.body);
    expect(delta).not.toContain(created.entry.body);
    expect(delta).not.toContain('## Runtime/workspace');
    expect(delta).not.toContain('## Available skills');
    expect(delta).not.toContain('MemorySearch');
    expect(delta).not.toContain('MemoryRead');
    expect({ ...states.get(dynamicPromptKey)!.context, memory: oldContext.memory }).toEqual(oldContext);
    expect(svc.getSystemPrompt()).toBe(system);
    expect(svc.getActiveToolNames()).toEqual(tools);
    expect(context.get().slice(0, original.length)).toEqual(original);
    await injector.reconcileAllAtSafeBoundary();
    expect(snapshots()).toHaveLength(2);
    expect(scans).toHaveBeenCalledTimes(2);
    scans.mockRestore();
    const transient = await store.put({ ...mutation, title: 'Transient rule' });
    await store.delete(mutation.scope, transient.entry.id, transient.entry.revision);
    await injector.reconcileAllAtSafeBoundary();
    expect(snapshots()).toHaveLength(2);
    await store.put({ ...mutation, scope: { kind: 'persona', personaId: 'other' } });
    await injector.reconcileAllAtSafeBoundary();
    expect(snapshots()).toHaveLength(2);
    await store.undo(mutation.scope, edited.operationId);
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).toContain(created.entry.body);
    const current = (await store.get(mutation.scope, created.entry.id))!;
    await store.put({ ...mutation, action: 'archive', id: current.id, expectedRevision: current.revision });
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).not.toContain(created.entry.body);
    expect(textOf(snapshots().at(-1)!)).toContain('status=empty');
    const retainedDelta = context.get().at(-1)!;
    context.clear();
    context.append(retainedDelta);
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).toContain('Full snapshot; all sections replace earlier values.');
    expect(textOf(snapshots().at(-1)!)).toContain('## Runtime/workspace');
    context.applyCompaction({ summary: 'handoff', compactedCount: context.get().length, tokensBefore: 100 });
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).toContain('Full snapshot; all sections replace earlier values.');
    const last = await host.get(IAgentMemorySnapshot).get();
    await store.put({ ...mutation, title: 'Post-compaction rule' });
    vi.spyOn(store, 'list').mockRejectedValue(new Error('render unavailable'));
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).toContain('status=stale/degraded');
    expect(last).toContain('status=empty');
    expect(svc.getSystemPrompt()).toBe(system);
  });

  it('leaves legacy memory frozen on commits and explicit memory refresh until its migration boundary', async () => {
    const { ctx: host, profile: svc } = buildContext({ initialConfig: { memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} } } },
      homeDirServices(homeDir),
      appService(IMemoryScopes, { _serviceBrand: undefined, resolve: async (scope) => scope.kind === 'global' ? 'memory/global' : scope.kind === 'workspace' ? 'memory/workspace' : `memory/personas/${scope.personaId}/${scope.kind}` }));
    const { IAgentStateService } = await import('#/agent/state/agentState');
    const { dynamicPromptKey, IDynamicPromptInjection } = await import('#/agent/profile/dynamicPrompt');
    const { IAgentContextInjectorService } = await import('#/agent/contextInjector/contextInjector');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');
    const { IMemoryStore } = await import('#/app/memory/memoryStore');
    const native = normalizeAgentProfile({ name: 'legacy-memory', tools: [], renderSystemPrompt: (context) =>
      renderPromptTemplateResult('BASE ${memory}', context, { skillActive: false }) });
    await svc.applyProfile(native);
    expect(host.get(IAgentStateService).get(dynamicPromptKey)?.enabled).toBe(false);
    host.get(IDynamicPromptInjection);
    const before = svc.getSystemPrompt();
    const store = host.get(IMemoryStore);
    await store.put({ action: 'create', scope: { kind: 'global' }, type: 'feedback', title: 'Legacy new rule', body: 'New saved rule.', reason: 'user instruction', source: { writer: 'user' } });
    const scans = vi.spyOn(store, 'list');
    await svc.refreshMemorySnapshot();
    await host.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
    await svc.refreshSystemPrompt();
    expect(scans).not.toHaveBeenCalled();
    expect(svc.getSystemPrompt()).toBe(before);
    expect(host.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'runtime_snapshot')).toEqual([]);
  });

  it('discloses skill catalog changes only in snapshot deltas, not body edits', async () => {
    const { ctx: host, profile: svc } = buildContext();
    const { IAgentStateService } = await import('#/agent/state/agentState');
    const { profileKey } = await import('#/agent/profile/profileOps');
    const { IDynamicPromptInjection } = await import('#/agent/profile/dynamicPrompt');
    const { IAgentProfileCapabilityChangesService } = await import('#/agent/toolSelect/profileCapabilityChanges');
    const { IAgentContextInjectorService } = await import('#/agent/contextInjector/contextInjector');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');
    const { SessionSkillCatalogService } = await import('#/session/sessionSkillCatalog/skillCatalogService');
    const states = host.get(IAgentStateService);
    states.set(profileKey, { ...states.get(profileKey), renderGeneration: 0 });
    await svc.applyProfile(skillsProfile);
    host.get(IDynamicPromptInjection);
    host.get(IAgentProfileCapabilityChangesService);
    const injector = host.get(IAgentContextInjectorService);
    await injector.reconcileAllAtSafeBoundary();
    const catalog = host.get(ISessionSkillCatalog) as InstanceType<typeof SessionSkillCatalogService>;
    const skill = { name: 'catalog-test', description: 'Catalog test.', path: '/example/SKILL.md', dir: '/example', content: 'body one', source: 'project' as const, metadata: {} };
    catalog.set('test', { skills: [skill] }, { priority: 50 });
    await injector.reconcileAllAtSafeBoundary();
    const snapshots = () => host.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'runtime_snapshot');
    const textOf = (message: (ReturnType<typeof snapshots>)[number]) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
    expect(snapshots()).toHaveLength(2);
    expect(textOf(snapshots()[1]!)).toContain('catalog-test');
    expect(textOf(snapshots()[1]!)).not.toContain('## Runtime/workspace');
    expect(host.get(IAgentContextMemoryService).get().some((message) => JSON.stringify(message.origin).includes('profile_capabilities_changed'))).toBe(false);
    catalog.set('test', { skills: [{ ...skill, content: 'body two' }] }, { priority: 50 });
    await injector.reconcileAllAtSafeBoundary();
    expect(snapshots()).toHaveLength(2);
    catalog.set('test', { skills: [] }, { priority: 50 });
    await injector.reconcileAllAtSafeBoundary();
    expect(snapshots()).toHaveLength(3);
    expect(textOf(snapshots()[2]!)).toContain('## Available skills\n(none)');
    expect(textOf(snapshots()[2]!)).not.toContain('## Runtime/workspace');
    host.get(IAgentContextMemoryService).applyCompaction({ summary: 'handoff', compactedCount: 1, tokensBefore: 100 });
    await injector.reconcileAllAtSafeBoundary();
    expect(textOf(snapshots().at(-1)!)).toContain('Full snapshot; all sections replace earlier values.');
    expect(textOf(snapshots().at(-1)!)).toContain('## Runtime/workspace');
  });

  it('migrates a legacy layout only when a natural compaction lands', async () => {
    const { ctx: host, profile: svc } = buildContext();
    const { IAgentStateService } = await import('#/agent/state/agentState');
    const { dynamicPromptKey } = await import('#/agent/profile/dynamicPrompt');
    const { IAgentContextMemoryService } = await import('#/agent/contextMemory/contextMemory');

    const native = normalizeAgentProfile({ name: 'legacy-runtime', tools: [], renderSystemPrompt: (context) =>
      renderPromptTemplateResult('BASE ${now}|${cwd}|${cwd_listing}', context, { skillActive: false }) });
    await svc.applyProfile(native);
    expect(host.get(IAgentStateService).get(dynamicPromptKey)?.enabled).toBe(false);
    const prior = svc.data().systemPrompt;
    await writeFile(join(workDir, 'new-file.txt'), 'new work');
    await svc.refreshSystemPrompt();
    expect(svc.data().systemPrompt).toBe(prior);
    const context = host.get(IAgentContextMemoryService);
    context.append({ role: 'user', content: [{ type: 'text', text: 'request' }], toolCalls: [], origin: { kind: 'user' } });
    context.applyCompaction({ summary: 'handoff', compactedCount: context.get().length, tokensBefore: 100 });
    await svc.refreshSystemPrompt();
    expect(host.get(IAgentStateService).get(dynamicPromptKey)?.enabled).toBe(true);
    expect(svc.data().systemPrompt).not.toBe(prior);
  });

  it.each(['main-role', 'standalone-role'])('renders configured variables in %s without inheriting SYSTEM.md', async (name) => {
    const { ctx: host, profile: svc } = buildContext();
    const config = host.get(IConfigService);
    const get = config.get.bind(config);
    let prompt: PromptConfig = { variables: { search_guidance: 'Native GMA ${literal}' }, overrides: { fields: { 'system.shared': 'REQUEST_ONLY_SHARED' } } };
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'prompt' ? prompt : get(domain)) as IConfigService['get']);
    const standalone = normalizeAgentProfile({ name, tools: [], renderSystemPrompt: (context) => renderPromptTemplateResult('${search_guidance}|${cwd}', context, { skillActive: false }) });
    await svc.applyProfile(standalone);
    expect(svc.getSystemPrompt().replaceAll('\\', '/')).toBe(`Native GMA \${literal}|${workDir}\n\nREQUEST_ONLY_SHARED`);
    expect(svc.data().systemPrompt).not.toContain('REQUEST_ONLY_SHARED');
    prompt = { variables: { search_guidance: 'Updated guidance' } };
    await svc.refreshSystemPrompt();
    expect(svc.getSystemPrompt().replaceAll('\\', '/')).toBe(`Updated guidance|${workDir}`);
  });

  it('keeps the last valid external field snapshot when the next turn sees invalid TOML', async () => {
    const { ctx: host, profile: svc } = buildContext();
    const promptHome = host.get(IBootstrapService).homeDir;
    await writeFile(join(promptHome, 'prompt-fields.toml'), 'schema_version = 1\n[fields]\n"system.shared" = "VALID"\n');
    const config = host.get(IConfigService);
    const get = config.get.bind(config);
    const prompt: PromptConfig = { overrides: { files: ['prompt-fields.toml'] } };
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'prompt' ? prompt : get(domain)) as IConfigService['get']);
    const standalone = normalizeAgentProfile({ name: 'file-fields', tools: [], systemPrompt: () => 'BASE' });
    await svc.applyProfile(standalone);
    expect(svc.getSystemPrompt()).toBe('BASE\n\nVALID');
    await writeFile(join(promptHome, 'prompt-fields.toml'), 'schema_version = 1\n[fields\n');
    await expect(svc.preparePromptConfiguration()).resolves.toBe(false);
    expect(svc.getSystemPrompt()).toBe('BASE\n\nVALID');
  });

  it.each(['file', 'route', 'file-sources'] as const)('refreshes a cold %s from its stored definition without changing its lease or duplicating shared text', async (kind) => {
    const { ctx: host, profile: svc } = buildContext();
    const config = host.get(IConfigService);
    const get = config.get.bind(config);
    let prompt: PromptConfig = { variables: { guidance: 'old' }, overrides: { fields: { 'system.shared': 'GLOBAL' } } };
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'prompt' ? prompt : get(domain)) as IConfigService['get']);
    const definition = parseAgentFileText({ path: join(workDir, 'stored.md'), source: 'explicit', text: '---\nname: frozen-worker\ndescription: Fixture stored profile\ntools: [Read]\n---\nRole ${guidance}', definitionId: 'frozen-source', contributionRoot: workDir });
    const base = agentProfileFromFile(definition, (context) => renderPromptTemplateResult('BASE', context, { skillActive: false }));
    const selected = kind !== 'route' ? base : resolveAgentProfileRoute({ id: 'frozen-route', profile: base.name, description: 'Fixture route', promptMode: 'append', prompt: 'Route ${guidance}', overriddenFields: [], path: join(workDir, 'route.md') }, base).effectiveProfile;
    await svc.applyProfile(selected);
    const bound = freezeBoundProfile(selected);
    const frozen = kind === 'file-sources' ? { ...bound, fileSources: { root: definition, scopedBindings: {}, sourceDefinitions: { [definition.definitionId]: definition }, dependencyIndex: {}, diagnostics: [] } } : bound;
    const before = { ...svc.data(), routeId: kind === 'route' ? 'frozen-route' : undefined, boundProfile: frozen };
    svc.applyBindingSnapshot(before);
    prompt = { variables: { guidance: 'new ${literal}' }, overrides: { fields: { 'system.shared': 'GLOBAL_NEW' } } };
    await svc.preparePromptConfiguration();
    expect(svc.getSystemPrompt()).toContain('Role new ${literal}');
    if (kind === 'route') expect(svc.getSystemPrompt()).toContain('Route new ${literal}');
    expect(svc.getSystemPrompt().split('GLOBAL_NEW')).toHaveLength(2);
    expect(svc.data().activeToolNames).toEqual(before.activeToolNames);
    expect({ ...svc.data().boundProfile, promptBase: undefined }).toEqual({ ...frozen, promptBase: undefined });
    expect(svc.data().boundProfile?.promptBase?.text).toContain('Role new ${literal}');
    expect(svc.data().systemPrompt).not.toContain('GLOBAL_NEW');
    svc.applyBindingSnapshot(svc.data());
    prompt = {};
    await svc.preparePromptConfiguration();
    expect(svc.getSystemPrompt()).toContain('Role ${guidance}');
    expect(svc.getSystemPrompt()).not.toContain('GLOBAL_NEW');
  });

  it('restores a bound replace-mode file profile without resolving the current default profile', async () => {
    const getDefault = vi.fn(() => {
      throw new Error('Default agent profile is unavailable');
    });
    const catalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as SessionAgentProfileCatalog['onDidChange'],
      get: () => undefined,
      getDefault,
      list: () => [],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => {
        throw new Error('No live profile is available');
      },
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    } satisfies SessionAgentProfileCatalog;
    const { profile: svc } = buildContext(sessionService(ISessionAgentProfileCatalog, catalog));
    const definition = parseAgentFileText({
      path: join(workDir, 'stored.md'),
      source: 'explicit',
      text: '---\nname: frozen-worker\ndescription: Fixture stored profile\n---\nStored role',
      definitionId: 'frozen-source',
      contributionRoot: workDir,
    });
    const selected = agentProfileFromFile(definition, () => {
      throw new Error('base prompt should not render');
    });
    await svc.applyProfile(selected);
    const snapshot = { ...svc.data(), systemPrompt: 'HISTORIC_FROZEN_PROMPT', boundProfile: freezeBoundProfile(selected) };
    svc.applyBindingSnapshot(snapshot);

    await expect(svc.refreshSystemPrompt()).resolves.toBeUndefined();

    expect(svc.getSystemPrompt()).toContain('Stored role');
    expect(svc.getSystemPrompt()).not.toContain('HISTORIC_FROZEN_PROMPT');
  });

  it('reports an unavailable saved source instead of silently keeping stale configured variables', async () => {
    const { ctx: host, profile: svc } = buildContext();
    const config = host.get(IConfigService);
    const get = config.get.bind(config);
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'prompt' ? { variables: { guidance: 'new' } } : get(domain)) as IConfigService['get']);
    svc.applyBindingSnapshot({ ...svc.data(), profileName: 'missing-fixture-role', profileDefinitionId: 'missing-fixture-source' });
    await expect(svc.preparePromptConfiguration()).resolves.toBe(false);
  });

  it('does not rerender an unconfigured cold file profile merely because the prompt domain exists', async () => {
    const { profile: svc } = buildContext();
    const definition = parseAgentFileText({ path: join(workDir, 'unchanged.md'), source: 'explicit', text: '---\nname: unchanged\ndescription: Fixture\n---\nCurrent file text', definitionId: 'unchanged-source', contributionRoot: workDir });
    const parsed = agentProfileFromFile(definition, (context) => renderPromptTemplateResult('BASE', context, { skillActive: false }));
    await svc.applyProfile(parsed);
    const snapshot = { ...svc.data(), systemPrompt: 'HISTORIC_FROZEN_PROMPT', boundProfile: freezeBoundProfile(parsed) };
    svc.applyBindingSnapshot(snapshot);
    await svc.preparePromptConfiguration();
    expect(svc.getSystemPrompt()).toBe('HISTORIC_FROZEN_PROMPT');
    expect(svc.data().renderGeneration).toBe(snapshot.renderGeneration);
  });

  describe('custom identity', () => {
    const selfNaming: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'self-naming',
      systemPrompt: (context) => `You are ${context.productName ?? DEFAULT_PRODUCT_NAME}`,
      tools: [],
    });

    it('names the agent after the configured identity', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity({ displayName: 'Acme Dev', slug: 'acme' })),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe('You are Acme Dev');
    });

    it('keeps the built-in product name when no identity is configured', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity()),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe(`You are ${DEFAULT_PRODUCT_NAME}`);
    });
  });

  it('loads AGENTS.md into the rendered system prompt', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain('project instructions');
    expect(svc.data().systemPrompt).toContain(`<!-- From: ${join(workDir, 'AGENTS.md')} -->`);
    expect(svc.data().agentsMdPaths).toEqual([join(workDir, 'AGENTS.md')]);
    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('does not mark discovered AGENTS.md as disclosed when a custom prompt omits it', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();
    const custom = normalizeAgentProfile({
      name: 'custom-without-instructions',
      systemPrompt: () => 'Custom role only',
      tools: [],
    });

    await svc.applyProfile(custom);

    expect(svc.data().systemPrompt).toBe('Custom role only');
    expect(svc.data().agentsMdPaths).toEqual([]);
  });

  it('renders the complete runtime context exactly', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(exactProfile);

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'project instructions'));
  });

  it('maps prompt context roots through the bound runtime workspace view', async () => {
    const mappedDir = await mkdtemp(join(tmpdir(), 'kimi-apply-mapped-'));
    const localExtra = await mkdtemp(join(tmpdir(), 'kimi-apply-extra-local-'));
    const mappedExtra = await mkdtemp(join(tmpdir(), 'kimi-apply-extra-mapped-'));
    try {
      await writeFile(join(workDir, 'local-only.txt'), 'x', 'utf-8');
      await writeFile(join(mappedDir, 'mapped-only.txt'), 'x', 'utf-8');
      await writeFile(join(localExtra, 'extra-local.txt'), 'x', 'utf-8');
      await writeFile(join(mappedExtra, 'extra-mapped.txt'), 'x', 'utf-8');
      const mapping = new Map([
        [workDir, mappedDir],
        [localExtra, mappedExtra],
      ]);
      const fs = new HostFileSystem();
      const { profile: svc } = buildContext(
        agentService(
          IAgentRuntimeService,
          mappedRuntimeService(fs, homeDir, (path) => mapping.get(path) ?? path),
        ),
      );

      await svc.applyProfile(exactProfile, { additionalDirs: [localExtra] });

      const prompt = svc.data().systemPrompt;
      expect(prompt).toContain(`cwd:${mappedDir}`);
      expect(prompt).toContain('mapped-only.txt');
      expect(prompt).not.toContain('local-only.txt');
      expect(prompt).toContain(`### ${mappedExtra}`);
      expect(prompt).toContain('extra-mapped.txt');
      expect(prompt).not.toContain('extra-local.txt');
    } finally {
      await rm(mappedDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(localExtra, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(mappedExtra, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('skips the directory listing when the bound runtime has no fs capability', async () => {
    const fs = new HostFileSystem();
    const { profile: svc } = buildContext(
      agentService(IAgentRuntimeService, mappedRuntimeService(fs, homeDir, (path) => path, [])),
    );

    await svc.applyProfile(exactProfile);

    const prompt = svc.data().systemPrompt;
    expect(prompt).toContain(`cwd:${workDir.replaceAll('\\', '/')}`);
    expect(prompt).toContain('ls:\nextra:');
  });

  it('refreshes the active profile system prompt exactly without resetting active tools', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const { profile: svc } = buildContext();
    await svc.applyProfile(exactProfile);
    svc.update({ activeToolNames: ['Read'] });
    await writeFile(join(workDir, 'AGENTS.md'), 'new instructions', 'utf-8');

    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'new instructions'));
    expect(svc.getActiveToolNames()).toEqual(['Read']);
  });

  it('caches an agents-md warning when the content exceeds the 32 KB soft budget', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');
    const { ctx: context, profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain(largeContent);
    const warning = svc.getAgentsMdWarning();
    expect(warning).toBeDefined();
    expect(warning).toContain('exceeds the recommended');

    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    expect(
      events.some(
        (entry) => entry.event === 'warning' && entry.args?.code === 'agents-md-oversized',
      ),
    ).toBe(true);
  });

  it('does not cache a warning when the content is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('injects enabled plugin system-prompt sections into the rendered prompt', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'Always cite sources.' }] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));

    await svc.applyProfile(pluginProfile);

    expect(svc.data().systemPrompt).toBe(
      '<!-- From: plugin demo -->\nAlways cite sources.',
    );
  });

  it('keeps the rendered prompt frozen when the plugin skill source reloads', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      skillCatalogWithChange(change),
    );
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;
    expect(before).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
    change.dispose();
  });

  it('does not change a live agent prompt when the contributing plugin is uninstalled', async () => {
    const sections = {
      value: [
        { pluginId: 'demo', content: 'Always cite sources.' },
      ] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;

    sections.value = [];
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
  });

  it('does not change a live agent prompt when a plugin is installed', async () => {
    const sections = { value: [] as readonly EnabledPluginSystemPrompt[] };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;

    sections.value = [{ pluginId: 'demo', content: 'Always cite sources.' }];
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
  });

  it('freezes plugin sections only once the plugin snapshot has loaded', async () => {
    const sections = { value: [] as readonly EnabledPluginSystemPrompt[] };
    const loaded = { value: false };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections, loaded)));
    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toBe('');

    loaded.value = true;
    sections.value = [{ pluginId: 'demo', content: 'V1' }];
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('<!-- From: plugin demo -->');
  });

  it('lets a freshly built agent snapshot the current plugin sections', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const first = buildContext(appService(IPluginService, pluginStub(sections)));
    await first.profile.applyProfile(pluginProfile);
    expect(first.profile.data().systemPrompt).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    const second = buildContext(appService(IPluginService, pluginStub(sections)));
    await second.profile.applyProfile(pluginProfile);

    expect(second.profile.data().systemPrompt).toContain('V2');
    await first.ctx.dispose();
  });

  it('keeps plugin sections frozen while other prompt inputs still refresh', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const sections = {
      value: [{ pluginId: 'demo', content: 'cite' }] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(agentsAndPluginsProfile);
    expect(svc.data().systemPrompt).toContain('old instructions');
    expect(svc.data().systemPrompt).toContain('cite');

    sections.value = [];
    await writeFile(join(workDir, 'AGENTS.md'), 'new instructions', 'utf-8');
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('new instructions');
    expect(svc.data().systemPrompt).toContain('cite');
  });

  it('keeps the skill listing frozen when the builtin skill source reloads', async () => {
    const change = new Emitter<string>();
    const listing = { value: 'before' };
    const catalog = {
      getModelSkillListing: () => listing.value,
    } as unknown as SkillCatalog;
    const { profile: svc } = buildContext(skillCatalogWithChange(change, catalog));
    await svc.applyProfile(skillsProfile);
    expect(svc.data().systemPrompt).toBe('skills:before');

    listing.value = 'after';
    change.fire(BUILTIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe('skills:before');
    change.dispose();
  });

  it('does not rebuild the system prompt when the plugin skill source changes', async () => {
    let renders = 0;
    const countingProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'counting-profile',
      systemPrompt: () => `render:${++renders}`,
      tools: [],
    });
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(skillCatalogWithChange(change));
    await svc.applyProfile(countingProfile);
    expect(svc.data().systemPrompt).toBe('render:1');

    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(svc.data().systemPrompt).toBe('render:1');
    change.dispose();
  });

  it('rebuilds the system prompt when the builtin skill source changes', async () => {
    let renders = 0;
    const countingProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'counting-profile',
      systemPrompt: () => `render:${++renders}`,
      tools: [],
    });
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(skillCatalogWithChange(change));
    await svc.applyProfile(countingProfile);
    expect(svc.data().systemPrompt).toBe('render:1');

    change.fire(BUILTIN_SKILL_SOURCE_ID);

    await vi.waitFor(() => {
      expect(svc.data().systemPrompt).toBe('render:2');
    });
    change.dispose();
  });

  it('skips plugin sections beyond the aggregate byte budget and warns once', async () => {
    const large = 'x'.repeat(48 * 1024);
    const sections = {
      value: [
        { pluginId: 'first', content: large },
        { pluginId: 'second', content: large },
      ] as readonly EnabledPluginSystemPrompt[],
    };
    const change = new Emitter<string>();
    const { ctx: context, profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      skillCatalogWithChange(change),
    );

    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toContain('<!-- From: plugin first -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin second -->');

    sections.value = [...sections.value, { pluginId: 'third', content: 'small' }];
    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('<!-- From: plugin first -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin second -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin third -->');
    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    const warnings = events.filter(
      (entry) => entry.event === 'warning' && entry.args?.code === 'plugin-sections-oversized',
    );
    expect(warnings).toHaveLength(1);
    change.dispose();
  });
});

function skillCatalogWithChange(
  change: Emitter<string>,
  catalog: SkillCatalog = new InMemorySkillCatalog(),
): TestAgentServiceOverride {
  return sessionService(ISessionSkillCatalog, {
    _serviceBrand: undefined,
    catalog,
    ready: Promise.resolve(),
    onDidChange: change.event,
    load: async () => {},
    reload: async () => {},
    list: async () => [],
  });
}

function pluginStub(
  sections: { value: readonly EnabledPluginSystemPrompt[] },
  loaded: { value: boolean } = { value: true },
): IPluginService {
  return {
    onDidReload: Event.None as IPluginService['onDidReload'],
    hasLoadedSnapshot: () => loaded.value,
    pluginSkillRoots: async () => [],
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => sections.value,
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
    listPluginCommands: async () => [],
    listPlugins: async () => [],
  } as unknown as IPluginService;
}

function exactSystemPrompt(workDir: string, agentsMd: string): string {
  const cwd = process.platform === 'win32' ? workDir.replaceAll('/', '\\') : workDir;
  return [
    `cwd:${cwd}`,
    'os:Linux',
    'shell:bash:/bin/bash',
    `agents:<!-- From: ${join(workDir, 'AGENTS.md')} -->\n${agentsMd}`,
    'ls:\u2514\u2500\u2500 AGENTS.md',
    'extra:',
  ].join('\n');
}

function mappedRuntimeService(
  fs: HostFileSystem,
  homeDir: string,
  map: (path: string) => string,
  capabilities: readonly RuntimeCapability[] = ['fs'],
): IAgentRuntimeService {
  const runtime: Runtime = {
    identity: { workspaceId: 'workspace-1', runtimeId: 'mapped', generation: 'g1' },
    capabilities: new Set(capabilities),
    environment: {
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir,
    },
    path: {
      separator: '/',
      delimiter: ':',
      isAbsolute: (path) => isAbsolute(path),
      join: (...paths) => join(...paths),
      relative: (from, to) => relative(from, to),
      resolve: (...paths) => resolve(...paths),
      basename: (path) => basename(path),
      dirname: (path) => dirname(path),
    },
    workspace: {
      mapRoots: (roots) => ({
        workDir: map(roots.workDir),
        additionalDirs: roots.additionalDirs?.map(map),
      }),
    },
    fs,
    status: 'ready',
    onDidChangeStatus: Event.None as Event<RuntimeStatus>,
    dispose: () => {},
  };
  return {
    _serviceBrand: undefined,
    onDidChange: Event.None as Event<void>,
    isAvailable: (required = []) =>
      required.every((capability) => runtime.capabilities.has(capability)),
    inspect: () => runtime,
    acquire: () => ({
      runtime,
      track: <T,>(resource: T): T => resource,
      dispose: () => {},
    }),
  };
}
