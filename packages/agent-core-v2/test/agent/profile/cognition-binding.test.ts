import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { resolvedRecipeSchema } from '@kiki/protocol';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { IRecipeService, IRecipeSourceReader } from '#/app/recipes/recipes';
import { RecipeService } from '#/app/recipes/recipeService';
import { RecipeSourceReader } from '#/os/backends/node-fs/recipeSourceReader';
import { stringify } from 'smol-toml';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentExternalHooksService } from '#/features/externalHooks/agent/agentExternalHooks';
import { makeHookRunner } from '../../features/externalHooks/runner-stub';
import { IModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutation';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { GenerateOptions } from '#/kosong/contract/provider';
import { emptyUsage } from '#/kosong/contract/usage';
import { DEFAULT_AGENT_PROFILE_NAME, normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { CognitionConfig, ModelRecord } from '#/kosong/model/model';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ProfileErrors } from '#/agent/profile/errors';
import { CognitionConfigSchema, modelsFromToml, modelsToToml } from '#/app/kosongConfig/configSection';
import { IAgentCognitionAnchorService } from '#/agent/cognition/cognitionAnchor';
import { selectCognitionConfig } from '#/agent/cognition/cognitionConfig';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentModelSteeringService } from '#/features/modelSteering/modelSteering';
import '#/features/modelSteering/modelSteeringFeature';
import { runWillBeginStepHooks } from '../loop/stubs';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import {
  createTestAgent,
  homeDirServices,
  appServices,
  llmGenerateServices,
  sessionService,
  externalHookServices,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';
const OTHER_MODEL = 'other-model';

describe('per-model cognition overlay', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-cognition-bind-'));
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/overlay.md'), 'FLASH OVERLAY');
    await writeFile(join(homeDir, 'cognition/steering.md'), 'FLASH STEERING');
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
  });

  function createBoundAgent(cognition?: CognitionConfig, extraModels?: Record<string, ModelRecord>): TestAgentContext {
    ctx = createTestAgent(homeDirServices(homeDir));
    const current = ctx.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]:
          cognition === undefined
            ? current!
            : { ...current!, cognition },
        ...extraModels,
      },
    };
    return ctx;
  }

  function recipe(revision = 'old', temperature = 0.35) {
    return resolvedRecipeSchema.parse({ revision, branches: {
      main: { system: 'RECIPE MAIN', steering: 'RECIPE MAIN CUE', anchor: { content: 'RECIPE ANCHOR', steps: 1, scope: 'session' }, steering_on_turn: false, steering_on_input: true, steering_interval_steps: 4, fields: { 'tool.read.description': 'RECIPE READ DESCRIPTION' } },
      sub: { system: 'RECIPE SUB', fields: {} }, independent: { fields: {} },
    }, dependencies: [], origins: [], model: { autoCompact: 4096, contextBudget: 8192, parameters: { temperature, topP: 0.8, serviceTier: 'priority', maxCompletionTokens: 1024 }, usage: { independent: { contextBudget: 2048 } } }, model_origins: {} });
  }

  it.each(['main', 'sub', 'independent'] as const)('Recipe freezes legal model templates and cadence for %s while retaining the role, persona and room', async (position) => {
    const selected = recipe();
    ctx = createTestAgent(homeDirServices(homeDir), appServices((reg) => reg.definePartialInstance(IRecipeService, { resolve: async () => selected, onDidChange: Event.None as Event<void> })));
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, recipe: 'recipe-install', cognition: { overlay: 'cognition/overlay.md', steering: 'cognition/steering.md' }, promptOverrides: { fields: { 'system.shared': 'SAVED MODEL SHARED' } } } } };
    const profile = ctx.get(IAgentProfileService);
    const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => 'ROLE HOST BODY', modelProfiles: [{ alias: MOCK_MODEL, promptMode: 'prepend', prompt: 'MODEL ROLE BODY' }] });
    await profile.bind({ resolvedProfile: role, model: MOCK_MODEL, delegationPosition: position, personaSnapshot: { revision: 'persona-r1', definition: { id: 'sample', name: 'Sample', description: 'PERSONA BODY' } }, roomPrompt: 'ROOM BODY' });
    const system = profile.getSystemPrompt();
    expect(system).toContain('ROLE HOST BODY'); expect(system).toContain('PERSONA BODY'); expect(system).toContain('ROOM BODY'); expect(system).toContain('MODEL ROLE BODY');
    expect(system).toContain('SAVED MODEL SHARED'); expect(system).toContain('FLASH OVERLAY');
    if (selected.branches[position].system !== undefined) expect(system).toContain(selected.branches[position].system);
    const cognition = await profile.getCognitionBinding();
    expect(cognition.slots?.overlay).toBe('FLASH OVERLAY');
    expect(cognition.slots?.steering).toBe(selected.branches[position].steering ?? 'FLASH STEERING');
    expect(profile.getRecipeModelSettings()).toMatchObject(selected.model);
    expect(profile.getModelCapabilities().max_context_tokens).toBe(position === 'independent' ? 2048 : 8192);
    if (position === 'main') {
      expect(profile.getPromptFieldSnapshot()?.values['tool.read.description']).toBe('RECIPE READ DESCRIPTION');
      expect(cognition.config).toMatchObject({ steeringOnTurn: false, steeringOnInput: true, steeringIntervalSteps: 4 });
      const anchor = await ctx.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false });
      expect(anchor).toContain('RECIPE ANCHOR'); expect(anchor).toContain('ROLE HOST BODY'); expect(anchor).toContain('PERSONA BODY'); expect(anchor).toContain('ROOM BODY'); expect(anchor).not.toContain('RECIPE MAIN');
    }
  });

  it('runs consented Recipe scripts through the real prompt and request, cold-freezes them and disables only the removed layer', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const directory = join(homeDir, 'bundle'); await mkdir(directory);
    const script = (text: string) => `let input = ''; for await (const part of process.stdin) input += part; const value = JSON.parse(input); if (value.hook_event_name === 'UserPromptSubmit') console.log(JSON.stringify({ message: ${JSON.stringify(text)} }));`;
    await writeFile(join(directory, 'cue.mjs'), script('OLD SCRIPT GUIDANCE'));
    await writeFile(join(directory, 'recipe.toml'), stringify({ schema_version: 1, id: 'example-hooks', name: 'Example hooks', version: '1.0.0', hooks: [{ event: 'UserPromptSubmit', command: 'node cue.mjs', files: ['cue.mjs'], timeout: 5 }] }));
    let installation: string | undefined; let observed = '';
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir), appServices((reg) => {
        reg.define(IRecipeService, RecipeService); reg.define(IRecipeSourceReader, RecipeSourceReader);
      }), externalHookServices(makeHookRunner([])), llmGenerateServices(async (_provider, _system, _tools, messages) => {
        observed = JSON.stringify(messages);
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, recipe: installation }, [OTHER_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, model: OTHER_MODEL, recipe: 'off' } } };
      return ctx;
    };
    let agent = create(); let recipes = agent.get(IRecipeService);
    const preview = await recipes.preview({ source: { locator: directory } });
    await expect(recipes.install({ preview_id: preview.preview_id })).rejects.toMatchObject({ details: { code: 'recipe-hook-consent-required' } });
    expect(await recipes.list()).toEqual([]);
    installation = (await recipes.install({ preview_id: preview.preview_id, consent: true, update_mode: 'pinned' })).installation_id;
    await agent.dispose(); agent = create(); recipes = agent.get(IRecipeService);
    let profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    agent.get(IAgentExternalHooksService);
    const submit = async () => {
      const input = { promptMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }], toolCalls: [], origin: { kind: 'user' as const } }, isSteer: false, block: false };
      expect(await profile.getRecipeScriptHooks()).toHaveLength(1);
      await agent.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.run(input);
      expect(input.block).toBe(false);
      expect(JSON.stringify(agent.get(IAgentContextMemoryService).get())).toContain('SCRIPT GUIDANCE');
      await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    };
    await submit(); expect(observed).toContain('OLD SCRIPT GUIDANCE');
    const frozen = structuredClone(await profile.getCognitionBinding());
    await writeFile(join(directory, 'cue.mjs'), script('NEW SCRIPT GUIDANCE'));
    const updated = await recipes.preview({ source: preview.summary.source, installation_id: installation, expected_revision: preview.digest });
    await recipes.install({ preview_id: updated.preview_id, consent: true });
    await agent.get(IWireService).flush(); await agent.dispose();
    await rm(directory, { recursive: true });
    agent = create(); await agent.restorePersisted(); profile = agent.get(IAgentProfileService); recipes = agent.get(IRecipeService);
    await profile.syncBindingMetadata(); agent.get(IAgentExternalHooksService);
    expect(await profile.getCognitionBinding()).toEqual(frozen);
    await submit(); expect(observed).toContain('OLD SCRIPT GUIDANCE'); expect(observed).not.toContain('NEW SCRIPT GUIDANCE');
    await profile.rebuildPromptContext(); await submit(); expect(observed).toContain('NEW SCRIPT GUIDANCE');
    const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, recipe: installation, systemPrompt: () => 'ROLE BODY' });
    await profile.bind({ resolvedProfile: role, model: OTHER_MODEL }); expect(await profile.getRecipeScriptHooks()).toHaveLength(1);
    await profile.bind({ resolvedProfile: { ...role, recipe: 'off' }, model: OTHER_MODEL }); expect(await profile.getRecipeScriptHooks()).toEqual([]);
    expect(await recipes.list()).toHaveLength(1);
  });

  it('freezes the effective request and cold recovery, adopts explicit rebuilds, and restores original model settings when switching away', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    let selected = recipe();
    let observed: { system: string; options?: GenerateOptions } | undefined;
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir), appServices((reg) => reg.definePartialInstance(IRecipeService, { resolve: async () => structuredClone(selected), onDidChange: Event.None as Event<void> })), llmGenerateServices(async (_provider, system, _tools, _messages, _callbacks, options) => {
        observed = { system, options };
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      const base = ctx.kimiConfig.models![MOCK_MODEL]!;
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...base, recipe: 'recipe-install', cognition: { overlay: 'cognition/overlay.md' }, parameters: { temperature: 0.1 } }, [OTHER_MODEL]: { ...base, model: OTHER_MODEL, parameters: { temperature: 0.1 } } } };
      return ctx;
    };
    let agent = create(); let profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const oldPrompt = profile.getSystemPrompt();
    await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(observed?.system).toContain('RECIPE MAIN');
    expect(observed?.options).toMatchObject({ sampling: { temperature: 0.35, topP: 0.8 }, serviceTier: 'priority', maxCompletionTokens: 1024 });
    selected = recipe('new', 0.75); selected.branches.main.system = 'UPDATED RECIPE MAIN';
    await agent.get(IWireService).flush(); await agent.dispose();
    agent = create(); await agent.restorePersisted(); profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata(); expect(profile.getSystemPrompt()).toBe(oldPrompt);
    expect(profile.getRecipeModelSettings()?.['parameters']).toMatchObject({ temperature: 0.35 });
    await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(observed?.options?.sampling?.temperature).toBe(0.35);
    await profile.rebuildPromptContext();
    expect(profile.getSystemPrompt()).toContain('UPDATED RECIPE MAIN'); expect(profile.getRecipeModelSettings()?.['parameters']).toMatchObject({ temperature: 0.75 });
    await profile.setModel(OTHER_MODEL);
    expect(profile.getRecipeModelSettings()).toBeUndefined(); expect(profile.getSystemPrompt()).not.toContain('RECIPE MAIN');
    await agent.get(IAgentLLMRequesterService).request({ tools: [] }); expect(observed?.options?.sampling?.temperature).toBe(0.1);
  });

  it('freezes native multiline bodies through actual requests and cold recovery until explicit rebuild', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    let body = 'NATIVE OLD\n完整正文\n';
    let observed = '';
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir), llmGenerateServices(async (_provider, system) => {
        observed = system;
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition: { overlay: { text: body }, steering: { text: `cue:${body}` }, anchor: { text: `anchor:${body}` }, anchorSteps: 1 }, promptOverrides: { fields: { 'system.shared': `shared:${body}` } } } } };
      const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => 'ROLE BODY' });
      vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'get').mockImplementation((name) => name === role.name ? role : undefined);
      vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'getDefault').mockReturnValue(role);
      return ctx;
    };
    let agent = create(); let profile = agent.get(IAgentProfileService);
    await profile.bind({ resolvedProfile: normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => 'ROLE BODY' }), model: MOCK_MODEL, personaSnapshot: { revision: 'persona-r1', definition: { id: 'sample', name: 'Sample', description: 'PERSONA BODY' } }, roomPrompt: 'ROOM BODY' });
    const old = await profile.getCognitionBinding();
    expect(old.slots).toEqual({ overlay: body, steering: `cue:${body}`, anchor: `anchor:${body}` });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain('ROLE BODY'); expect(prompt).toContain('PERSONA BODY'); expect(prompt).toContain('ROOM BODY'); expect(prompt).toContain(body);
    await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(observed).toContain(body); expect(observed).toContain(`shared:${body}`);
    expect(await agent.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false })).toBe(`anchor:${body}`);
    agent.get(IAgentModelSteeringService);
    await runWillBeginStepHooks(agent.get(IAgentLoopService), true);
    expect(agent.get(IAgentContextMemoryService).get().some((message) => message.content.some((part) => part.type === 'text' && part.text === `cue:${body}`))).toBe(true);
    await agent.get(IWireService).flush(); await agent.dispose();
    body = 'NATIVE NEW\n新的正文\n';
    agent = create(); await agent.restorePersisted(); profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata();
    expect(profile.getSystemPrompt()).toBe(prompt);
    expect(await profile.getCognitionBinding()).toEqual(old);
    expect(await profile.preparePromptConfiguration()).toBe(false);
    await profile.rebuildPromptContext();
    expect((await profile.getCognitionBinding()).slots?.overlay).toBe(body);
    expect(profile.getSystemPrompt()).toContain('ROLE BODY'); expect(profile.getSystemPrompt()).toContain('PERSONA BODY'); expect(profile.getSystemPrompt()).toContain('ROOM BODY');
  });

  it('keeps explicit empty native slots without inheriting common or replacing the role with an empty anchor', async () => {
    const agent = createBoundAgent({ overlay: { text: 'COMMON BODY' }, steering: { text: 'COMMON CUE' }, anchor: { text: 'COMMON ANCHOR' }, main: { overlay: { text: '' }, steering: { text: '' }, anchor: { text: '' } } });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ resolvedProfile: normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => 'ROLE BODY' }), model: MOCK_MODEL });
    const binding = await profile.getCognitionBinding();
    expect(binding.config?.anchor).toEqual({ text: '' });
    expect(binding.slots).toEqual({ overlay: undefined, steering: undefined, anchor: undefined });
    expect(profile.getSystemPrompt()).toContain('ROLE BODY');
    expect(profile.getSystemPrompt()).not.toContain('COMMON BODY');
    expect(await agent.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false })).toBeUndefined();
    agent.get(IAgentModelSteeringService);
    await runWillBeginStepHooks(agent.get(IAgentLoopService), true);
    expect(agent.get(IAgentContextMemoryService).get().some((message) => message.role === 'user' && message.content.some((part) => part.type === 'text' && part.text === ''))).toBe(false);
  });

  it.each(['main', 'sub', 'independent'] as const)('selects native body and provenance for %s without per-slot inheritance', async (position) => {
    const agent = createBoundAgent({ overlay: { text: 'COMMON BODY' }, steering: { text: 'COMMON CUE' }, main: { overlay: { text: 'MAIN BODY' } }, independent: 'off' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL, delegationPosition: position });
    const binding = await profile.getCognitionBinding();
    expect(binding.slots?.overlay).toBe(position === 'main' ? 'MAIN BODY' : position === 'sub' ? 'COMMON BODY' : undefined);
    expect(binding.slots?.steering).toBe(position === 'sub' ? 'COMMON CUE' : undefined);
    const diagnostics = await profile.getPromptDiagnostics();
    expect(diagnostics.channels.find((channel) => channel.id === 'cognition.overlay')).toMatchObject({ selection: position === 'main' ? 'main' : position === 'sub' ? 'common' : 'off', state: position === 'independent' ? 'inactive' : 'effective' });
    if (position !== 'independent') expect(diagnostics.channels.find((channel) => channel.id === 'cognition.overlay')?.sources[0]).toMatchObject({ surface: 'model-cognition', kind: 'inline' });
  });

  it('combines a profile Recipe with frozen native inline bodies and uncovered steering cadence', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    let body = 'NATIVE INLINE\n原正文';
    let selected = resolvedRecipeSchema.parse({ ...recipe('profile-inline-old'), branches: { main: { system: 'PROFILE SEGMENT', fields: {} }, sub: { fields: {} }, independent: { fields: {} } } });
    let observed = '';
    const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, recipe: 'profile-inline', systemPrompt: () => 'ROLE BODY' });
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir), appServices((reg) => reg.definePartialInstance(IRecipeService, { resolve: async () => structuredClone(selected), onDidChange: Event.None as Event<void> })), llmGenerateServices(async (_provider, system) => {
        observed = system;
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition: { overlay: { text: body }, steering: { text: `cue:${body}` }, steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 2 } } } };
      vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'get').mockReturnValue(role);
      return ctx;
    };
    let agent = create(); let profile = agent.get(IAgentProfileService);
    await profile.bind({ resolvedProfile: role, model: MOCK_MODEL });
    await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(observed).toContain(body); expect(observed).toContain('PROFILE SEGMENT'); expect(observed).toContain('ROLE BODY');
    const frozen = await profile.getCognitionBinding();
    expect(frozen.slots).toMatchObject({ overlay: body, steering: `cue:${body}` });
    expect(frozen.config).toMatchObject({ steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 2 });
    expect((await profile.getPromptDiagnostics()).recipe_model_binding?.references).toEqual([{ surface: 'profile', installation_id: 'profile-inline', revision: 'profile-inline-old' }]);
    await agent.get(IWireService).flush(); await agent.dispose();
    body = 'NATIVE NEW\n新正文'; selected = { ...selected, revision: 'profile-inline-new' };
    agent = create(); await agent.restorePersisted(); profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata(); await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(await profile.getCognitionBinding()).toEqual(frozen); expect(observed).toContain('NATIVE INLINE\n原正文'); expect(observed).not.toContain(body);
    await profile.rebuildPromptContext(); await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(observed).toContain(body); expect((await profile.getCognitionBinding()).config?.steeringIntervalSteps).toBe(2);
  });

  it('resolves two writable profile Recipe references on one model through real requests without changing the global model', async () => {
    const packages = new Map([['model-pack', recipe('model-revision')], ['profile-a', resolvedRecipeSchema.parse({ ...recipe('profile-a-revision'), model: { parameters: { topP: 0.6, serviceTier: 'flex' } }, branches: { main: { system: 'PROFILE A SEGMENT', fields: { 'tool.read.description': 'PROFILE A READ' } }, sub: { fields: {} }, independent: { fields: {} } } })], ['profile-b', resolvedRecipeSchema.parse({ ...recipe('profile-b-revision'), model: { parameters: { topP: 0.9 } }, branches: { main: { system: 'PROFILE B SEGMENT', fields: {} }, sub: { fields: {} }, independent: { fields: {} } } })]]);
    let observed: { system: string; options?: GenerateOptions } | undefined;
    for (const id of ['profile-a', 'profile-b']) {
      ctx = createTestAgent(homeDirServices(homeDir), appServices((reg) => reg.definePartialInstance(IRecipeService, { resolve: async (ref) => structuredClone(packages.get(ref)!), onDidChange: Event.None as Event<void> })), llmGenerateServices(async (_provider, system, _tools, _messages, _callbacks, options) => {
        observed = { system, options };
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      const saved = { ...ctx.kimiConfig.models![MOCK_MODEL]!, recipe: 'model-pack', cognition: { overlay: 'cognition/overlay.md' }, overrides: { requestParams: { temperature: 0.4 } } };
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: saved } };
      if (id === 'profile-a') {
        const entity = await ctx.get(IModelCatalogMutationService).readModel(MOCK_MODEL);
        expect(entity.effective_parameters?.temperature).toBe(0.4);
        expect(entity.parameter_sources?.['temperature']).toContain('overrides');
        expect(entity.recipe_model_binding?.revision).toBe('model-revision');
      }
      const text = `---\nname: agent\ndescription: Example role\nmodel_alias: ${MOCK_MODEL}\nrecipe: installation:${id}\n${id === 'profile-a' ? 'service_tier: default\nrequest_params:\n  temperature: 0.2\ncontext_budget: 4096\nmax_completion_tokens: 512\nmodel_profiles:\n  - alias: mock-model\n    max_completion_tokens: 256\n    prompt_mode: append\n    prompt: LOCAL MODEL ROLE\n    prompt_overrides:\n      fields:\n        tool.read.description: LOCAL PROFILE MODEL READ\n' : ''}---\nPROFILE ROLE BODY`;
      const definition = parseAgentFileText({ path: join(homeDir, 'agent.md'), source: 'explicit', text });
      const role = agentProfileFromFile(definition, () => ({ text: 'HOST BASE', environment: { cwd: homeDir, date: { disclosed: false } } }));
      vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'get').mockImplementation(() => role);
      const profile = ctx.get(IAgentProfileService);
      await profile.bind({ resolvedProfile: role, model: MOCK_MODEL });
      await ctx.get(IAgentLLMRequesterService).request({ tools: [] });
      expect(observed?.system).toContain(id === 'profile-a' ? 'PROFILE A SEGMENT' : 'PROFILE B SEGMENT');
      expect(observed?.system).not.toContain('RECIPE MAIN');
      expect(observed?.system).toContain('PROFILE ROLE BODY'); expect(observed?.system).toContain('FLASH OVERLAY');
      expect(observed?.options).toMatchObject({ sampling: { temperature: id === 'profile-a' ? 0.2 : 0.4, topP: id === 'profile-a' ? 0.6 : 0.9 }, serviceTier: id === 'profile-a' ? 'default' : 'priority', maxCompletionTokens: id === 'profile-a' ? 256 : 1024 });
      expect(profile.getModelCapabilities().max_context_tokens).toBe(id === 'profile-a' ? 4096 : 8192);
      expect((await profile.getCognitionBinding()).slots?.steering).toBe('RECIPE MAIN CUE');
      const diagnostics = await profile.getPromptDiagnostics();
      expect(diagnostics.recipe_model_binding?.references).toEqual([{ surface: 'model', installation_id: 'model-pack', revision: 'model-revision' }, { surface: 'profile', installation_id: id, revision: `${id}-revision` }]);
      expect(diagnostics.disk_changed).toBe(false);
      if (id === 'profile-a') {
        expect(observed?.system).toContain('LOCAL MODEL ROLE');
        expect(profile.getPromptFieldSnapshot().values['tool.read.description']).toBe('LOCAL PROFILE MODEL READ');
      }
      expect(ctx.kimiConfig.models![MOCK_MODEL]).toEqual(saved);
      await ctx.dispose(); ctx = undefined;
    }
  });

  it('cold-restores profile Recipe revisions and local declarations, rebuilds explicitly, and preserves the binding on an invalid reference', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    let selected = recipe('profile-old', 0.45);
    delete (selected.model['parameters'] as Record<string, unknown>)['topP'];
    let reference = 'profile-pack';
    let temperature = 0.2;
    let lowerTopP = 0.65;
    let observed: GenerateOptions | undefined;
    const role = () => normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, recipe: reference, systemPrompt: () => 'ROLE PROFILE', requestParams: { temperature } });
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir), appServices((reg) => reg.definePartialInstance(IRecipeService, { resolve: async (id) => { if (id !== 'profile-pack') throw new Error('Recipe installation not found'); return structuredClone(selected); }, onDidChange: Event.None as Event<void> })), llmGenerateServices(async (_provider, _system, _tools, _messages, _callbacks, options) => {
        observed = options;
        return { id: 'response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] }, usage: emptyUsage(), finishReason: 'completed', rawFinishReason: 'stop' };
      }));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, parameters: { topP: lowerTopP } } } };
      vi.spyOn(ctx.get(ISessionAgentProfileCatalog), 'get').mockImplementation(() => role());
      return ctx;
    };
    let agent = create(); let profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const oldPrompt = profile.getSystemPrompt();
    await agent.get(IWireService).flush(); await agent.dispose();
    selected = recipe('profile-new', 0.75); selected.branches.main.system = 'UPDATED PROFILE PACK'; temperature = 0.25; lowerTopP = 0.95;
    delete (selected.model['parameters'] as Record<string, unknown>)['topP'];
    agent = create(); await agent.restorePersisted(); profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata(); await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(profile.getSystemPrompt()).toBe(oldPrompt); expect(observed?.sampling).toMatchObject({ temperature: 0.2, topP: 0.65 });
    expect((await profile.getPromptDiagnostics()).recipe_model_binding?.references?.[0]?.revision).toBe('profile-old');
    await profile.rebuildPromptContext(); await agent.get(IAgentLLMRequesterService).request({ tools: [] });
    expect(profile.getSystemPrompt()).toContain('UPDATED PROFILE PACK'); expect(observed?.sampling).toMatchObject({ temperature: 0.25, topP: 0.95 });
    const valid = profile.getSystemPrompt(); reference = 'missing-pack';
    await expect(profile.rebuildPromptContext()).rejects.toThrow('Recipe installation not found');
    expect(profile.getSystemPrompt()).toBe(valid); await agent.get(IAgentLLMRequesterService).request({ tools: [] }); expect(observed?.sampling?.temperature).toBe(0.25);
  });

  it.each(['main', 'sub', 'independent'] as const)('keeps common overlays for two models but delivers main-only cues only to %s', async (position) => {
    await writeFile(join(homeDir, 'cognition/second-steering.md'), 'SECOND MAIN CUE');
    const first: CognitionConfig = { overlay: 'cognition/overlay.md', main: { overlay: 'cognition/overlay.md', steering: 'cognition/steering.md' } };
    const agent = createBoundAgent(first, { [OTHER_MODEL]: { provider: 'test-provider', model: OTHER_MODEL, maxContextSize: 1_000_000, cognition: { overlay: 'cognition/overlay.md', main: { overlay: 'cognition/overlay.md', steering: 'cognition/second-steering.md' } } } });
    const profile = agent.get(IAgentProfileService);
    agent.get(IAgentModelSteeringService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL, delegationPosition: position });
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
    await runWillBeginStepHooks(agent.get(IAgentLoopService), true);
    const cues = () => agent.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'model_steering');
    expect(cues()).toHaveLength(position === 'main' ? 1 : 0);
    await profile.setModel(OTHER_MODEL);
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
    await runWillBeginStepHooks(agent.get(IAgentLoopService), true);
    expect(cues()).toHaveLength(position === 'main' ? 2 : 0);
    if (position === 'main') expect(cues().at(-1)?.content[0]).toMatchObject({ text: 'SECOND MAIN CUE' });
    await agent.get(ISessionMetadata).registerAgent('main', { type: 'main' });
    const binding = await profile.prepareResumeBinding({ modelAlias: MOCK_MODEL, allowModelChange: true });
    await agent.get(IAgentModelSwitchService).execute({ operationId: `cognition-resume-${position}`, model: binding.model, thinking: binding.thinking, mode: 'direct' }, { binding });
    expect((await profile.getCognitionBinding()).config?.steering).toBe(position === 'main' ? 'cognition/steering.md' : undefined);
    const diagnostic = await profile.getPromptDiagnostics();
    expect(diagnostic.identity.delegation_position).toBe(position);
    expect(diagnostic.disk_changed).toBe(false);
  });

  it('uses a whole independent main object without flat steering, anchor or replace defaults', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'replace', steering: 'cognition/missing.md', anchor: 'cognition/missing.md', anchorScope: 'turn', anchorSteps: 3, main: { overlay: 'cognition/overlay.md' } });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).not.toBe('FLASH OVERLAY');
    expect((await profile.getCognitionBinding()).config).toMatchObject({ overlay: 'cognition/overlay.md' });
    expect((await profile.getCognitionBinding()).config?.steering).toBeUndefined();
    expect(await agent.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false })).toBeUndefined();
    const diagnostic = await profile.getPromptDiagnostics();
    expect(diagnostic.channels.find((channel) => channel.id === 'cognition.anchor')?.state).toBe('inactive');
    expect(diagnostic.channels.find((channel) => channel.id === 'cognition.overlay')?.selection).toBe('main');
    expect(diagnostic.file_checks).toBeUndefined();
    const bindingBefore = structuredClone(await profile.getCognitionBinding());
    const checked = await profile.getPromptDiagnostics({ checkAllPromptFiles: true });
    expect(checked.file_checks).toMatchObject([
      { channel: 'cognition_overlay', branch: 'common', status: 'ok' },
      { channel: 'cognition_steering', branch: 'common', path: 'cognition/missing.md', status: 'error' },
      { channel: 'cognition_anchor', branch: 'common', path: 'cognition/missing.md', status: 'error' },
      { channel: 'cognition_overlay', branch: 'main', status: 'ok' },
    ]);
    expect(await profile.getCognitionBinding()).toEqual(bindingBefore);
    expect(checked.binding_revision).toBe(diagnostic.binding_revision);
  });

  it('keeps the previous cognition and binding when model resume fails after loading its candidate cognition', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', main: { overlay: 'cognition/overlay.md', steering: 'cognition/steering.md' } }, {
      [OTHER_MODEL]: { provider: 'test-provider', model: OTHER_MODEL, maxContextSize: 1_000_000, cognition: { overlay: 'cognition/overlay.md' }, promptOverrides: { main: { files: ['missing-candidate-fields.toml'] } } },
    });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const before = structuredClone(await profile.getCognitionBinding());
    const promptBefore = profile.getSystemPrompt();
    await expect(profile.prepareResumeBinding({ modelAlias: OTHER_MODEL, allowModelChange: true })).rejects.toThrow(/could not be resolved/);
    expect(profile.data().modelAlias).toBe(MOCK_MODEL);
    expect(profile.getSystemPrompt()).toBe(promptBefore);
    expect(await profile.getCognitionBinding()).toEqual(before);
    expect((await profile.getPromptDiagnostics()).binding_revision).toBe(before.bindingRevision);
  });

  it('steering cadence validates and round-trips model and identity policy fields', () => {
    for (const steeringIntervalSteps of [-1, 1.5, '2']) expect(CognitionConfigSchema.safeParse({ steeringIntervalSteps }).success).toBe(false);
    expect(CognitionConfigSchema.safeParse({ steeringOnInput: 'false' }).success).toBe(false);
    expect(CognitionConfigSchema.safeParse({ steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 0 }).success).toBe(true);
    expect(CognitionConfigSchema.safeParse({ steeringIntervalSteps: 1_000_000 }).success).toBe(true);
    const raw = { example: { model: 'example', cognition: {
      steering: 'common.md', steering_on_turn: false, steering_on_input: false, steering_interval_steps: 4,
      main: { steering: 'main.md', steering_on_input: true, steering_interval_steps: 2 }, independent: 'same',
    } } };
    const parsed = modelsFromToml(raw);
    expect(parsed).toMatchObject({ example: { cognition: { steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 4,
      main: { steeringOnInput: true, steeringIntervalSteps: 2 }, independent: 'same' } } });
    expect(modelsToToml(parsed, {})).toEqual(raw);
  });

  it('steering cadence uses the existing common, same, off and whole-object identity selection', () => {
    const common: CognitionConfig = { steering: 'common.md', steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 4 };
    expect(selectCognitionConfig(common, 'sub')).toMatchObject(common);
    expect(selectCognitionConfig({ ...common, main: 'same' }, 'main')).toMatchObject(common);
    expect(selectCognitionConfig({ ...common, independent: 'same' }, 'independent')).toMatchObject(common);
    expect(selectCognitionConfig({ ...common, independent: 'off' }, 'independent')).toBeUndefined();
    expect(selectCognitionConfig({ ...common, main: { steering: 'main.md', steeringIntervalSteps: 2 } }, 'main')).toEqual({ steering: 'main.md', steeringIntervalSteps: 2 });
  });

  it('steering cadence cold-recovers frozen policy and text despite changed current model configuration', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    let interval = 3;
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: {
        ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition: { steering: 'cognition/steering.md', steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: interval },
      } } };
      return ctx;
    };
    let agent = create();
    await agent.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const binding = await agent.get(IAgentProfileService).getCognitionBinding();
    expect(binding.config?.steeringIntervalSteps).toBe(3);
    await agent.get(IWireService).flush();
    await agent.dispose();
    interval = 1;
    await writeFile(join(homeDir, 'cognition/steering.md'), 'CHANGED STEERING');
    agent = create();
    await agent.restorePersisted();
    const profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata();
    expect(await profile.getCognitionBinding()).toEqual(binding);
    agent.get(IAgentModelSteeringService);
    const loop = agent.get(IAgentLoopService);
    const memory = agent.get(IAgentContextMemoryService);
    const cues = () => memory.get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'model_steering');
    await runWillBeginStepHooks(loop, true);
    await runWillBeginStepHooks(loop, false);
    expect(cues()).toHaveLength(0);
    await runWillBeginStepHooks(loop, false);
    expect(cues()).toHaveLength(1);
    expect(cues()[0]!.content).toEqual([{ type: 'text', text: 'FLASH STEERING' }]);
  });

  it('validates every branch structure and path without requiring unselected files', () => {
    for (const value of [{ main: {} }, { main: 'same' }, { independent: true }, { main: { main: 'off' } }, { main: { overlay: '../escape.md' } }, { independent: { anchor: 'C:/escape.md' } }, { sub: 'off' }]) expect(CognitionConfigSchema.safeParse(value).success).toBe(false);
    expect(CognitionConfigSchema.safeParse({ anchorSteps: 2 }).success).toBe(true);
    const raw = { example: { model: 'example', cognition: { overlay: 'common.md', main: { overlay_mode: 'prepend', anchor_steps: 2, anchor_scope: 'turn' }, independent: 'off' } } };
    const parsed = modelsFromToml(raw);
    expect(parsed).toMatchObject({ example: { cognition: { main: { overlayMode: 'prepend', anchorSteps: 2, anchorScope: 'turn' } } } });
    expect(modelsToToml(parsed, {})).toEqual(raw);
  });

  it('appends overlay when the bound model declares it', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
    expect(profile.getSystemPrompt()).toMatch(/FLASH OVERLAY\s*$/);
  });

  it('prepends overlay when overlay_mode is prepend', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'prepend' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toMatch(/^FLASH OVERLAY\n\n/);
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('wraps overlay around the profile when overlay_mode is wrap', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'wrap' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toMatch(/^FLASH OVERLAY\n\n/);
    expect(prompt).toContain('End of assignment');
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('replaces the opening identity when overlay_mode is persona', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'persona' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toMatch(/^FLASH OVERLAY\n\n/);
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('replaces the whole prompt when overlay_mode is replace', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'replace' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toBe('FLASH OVERLAY');
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });


  it('does not rewrite a model that has no cognition block', async () => {
    const agent = createBoundAgent();
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
  });

  it('keeps the explore profile identity when overlaying Flash', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: 'explore', model: MOCK_MODEL });
    expect(profile.data().profileName).toBe('explore');
    expect(profile.data().routeId).toBeUndefined();
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
  });

  it('fails closed when overlay is declared but the file is missing', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/missing.md' });
    const profile = agent.get(IAgentProfileService);
    await expect(
      profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL }),
    ).rejects.toMatchObject({
      code: ProfileErrors.codes.COGNITION_FILE_MISSING,
    });
  });

  it('fails closed when steering is declared but the file is missing', async () => {
    const agent = createBoundAgent({ steering: 'cognition/missing.md' });
    const profile = agent.get(IAgentProfileService);
    await expect(
      profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL }),
    ).rejects.toMatchObject({
      code: ProfileErrors.codes.COGNITION_FILE_MISSING,
    });
  });

  it('drops the overlay when setModel switches to a model without one', async () => {
    const agent = createBoundAgent(
      { overlay: 'cognition/overlay.md' },
      {
        [OTHER_MODEL]: {
          provider: 'test-provider',
          model: OTHER_MODEL,
          maxContextSize: 1_000_000,
        },
      },
    );
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');

    await profile.setModel(OTHER_MODEL);
    expect(profile.data().modelAlias).toBe(OTHER_MODEL);
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('picks the overlay up when setModel switches to a model that declares one', async () => {
    const agent = createBoundAgent(
      { overlay: 'cognition/overlay.md' },
      {
        [OTHER_MODEL]: {
          provider: 'test-provider',
          model: OTHER_MODEL,
          maxContextSize: 1_000_000,
        },
      },
    );
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: OTHER_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');

    await profile.setModel(MOCK_MODEL);
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
  });

  it('does not overlay a different model in the same catalog', async () => {
    const agent = createBoundAgent(
      { overlay: 'cognition/overlay.md' },
      {
        [OTHER_MODEL]: {
          provider: 'test-provider',
          model: OTHER_MODEL,
          maxContextSize: 1_000_000,
        },
      },
    );
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: OTHER_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
  });

  it('applies a matching model_profiles prompt before the cognition overlay', async () => {
    const custom = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      modelProfiles: [
        {
          alias: MOCK_MODEL,
          when: 'When the live alias matches.',
          promptMode: 'prepend',
          prompt: 'ROLE DELTA',
        },
      ],
      systemPrompt: () => 'PROFILE BODY',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => (name === custom.name ? custom : undefined),
      getDefault: () => custom,
      list: () => [custom],
      listRoutes: () => [],
      routeDiagnostics: () => [],
      resolveSelection: () => ({ profile: custom, baseProfile: custom, route: undefined }),
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(
      homeDirServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    const current = ctx.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]: { ...current!, cognition: { overlay: 'cognition/overlay.md' } },
      },
    };
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toMatch(/^ROLE DELTA\n\nPROFILE BODY/);
    expect(prompt).toMatch(/FLASH OVERLAY\s*$/);
    expect(prompt.indexOf('ROLE DELTA')).toBeLessThan(prompt.indexOf('FLASH OVERLAY'));
    expect(prompt).not.toContain('When the live alias matches.');
  });
});
