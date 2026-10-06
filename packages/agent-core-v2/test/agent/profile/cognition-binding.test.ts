import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { resolvedRecipeSchema } from '@kiki/protocol';
import { IRecipeService } from '#/app/recipes/recipes';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { GenerateOptions } from '#/kosong/contract/provider';
import { emptyUsage } from '#/kosong/contract/usage';
import { IWireService } from '#/wire/wire';
import { IConfigService } from '#/app/config/config';
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
  InMemoryWireRecordPersistence,
  homeDirServices,
  appServices,
  llmGenerateServices,
  sessionService,
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
        ...Object.fromEntries(Object.entries(extraModels ?? {}).map(([alias, model]) => [alias, { defaultEffort: 'off', ...model }])),
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
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, recipe: 'recipe-install', cognition: { overlay: 'missing.md', steering: 'missing.md' }, promptOverrides: { files: ['missing.toml'] } } } };
    const profile = ctx.get(IAgentProfileService);
    const role = normalizeAgentProfile({ name: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: () => 'ROLE HOST BODY', modelProfiles: [{ alias: MOCK_MODEL, promptMode: 'prepend', prompt: 'IGNORED MODEL ROLE' }] });
    await profile.bind({ resolvedProfile: role, model: MOCK_MODEL, delegationPosition: position, personaSnapshot: { revision: 'persona-r1', definition: { id: 'sample', name: 'Sample', description: 'PERSONA BODY' } }, roomPrompt: 'ROOM BODY' });
    const system = profile.getSystemPrompt();
    expect(system).toContain('ROLE HOST BODY'); expect(system).toContain('PERSONA BODY'); expect(system).toContain('ROOM BODY'); expect(system).not.toContain('IGNORED MODEL ROLE');
    const cognition = await profile.getCognitionBinding();
    expect(cognition.slots?.overlay).toBe(selected.branches[position].system);
    expect(profile.getRecipeModelSettings()).toEqual(selected.model);
    expect(profile.getModelCapabilities().max_context_tokens).toBe(position === 'independent' ? 2048 : 8192);
    if (position === 'main') {
      expect(profile.getPromptFieldSnapshot()?.values['tool.read.description']).toBe('RECIPE READ DESCRIPTION');
      expect(cognition.config).toMatchObject({ steeringOnTurn: false, steeringOnInput: true, steeringIntervalSteps: 4 });
      const anchor = await ctx.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false });
      expect(anchor).toContain('RECIPE ANCHOR'); expect(anchor).toContain('ROLE HOST BODY'); expect(anchor).toContain('PERSONA BODY'); expect(anchor).toContain('ROOM BODY'); expect(anchor).not.toContain('RECIPE MAIN');
    }
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
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...base, recipe: 'recipe-install', cognition: { overlay: 'missing.md' }, parameters: { temperature: 0.1 } }, [OTHER_MODEL]: { ...base, model: OTHER_MODEL, parameters: { temperature: 0.1 } } } };
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

  it.each(['modified', 'deleted'] as const)('cold-recovers frozen prompt inputs after their files are %s', async (change) => {
    const persistence = new InMemoryWireRecordPersistence();
    await writeFile(join(homeDir, 'cognition/anchor.md'), 'OLD ANCHOR');
    await writeFile(join(homeDir, 'fields.toml'), 'schema_version = 1\n[fields]\n"system.shared" = "OLD SHARED"\n"tool.read.description" = "OLD READ"');
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition: { overlay: 'cognition/overlay.md', steering: 'cognition/steering.md', anchor: 'cognition/anchor.md' }, promptOverrides: { files: ['fields.toml'] } } } };
      return ctx;
    };
    let agent = create();
    let profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    const fields = profile.getPromptFieldSnapshot();
    const cognition = await profile.getCognitionBinding();
    await agent.get(IWireService).flush();
    await agent.dispose();
    for (const file of ['cognition/overlay.md', 'cognition/steering.md', 'cognition/anchor.md', 'fields.toml']) {
      if (change === 'deleted') await rm(join(homeDir, file));
      else await writeFile(join(homeDir, file), file.endsWith('.toml') ? 'schema_version = 1\n[fields]\n"system.shared" = "NEW SHARED"\n"tool.read.description" = "NEW READ"' : 'NEW CONTENT');
    }
    agent = create();
    await agent.restorePersisted();
    profile = agent.get(IAgentProfileService);
    await profile.syncBindingMetadata();
    expect(profile.getSystemPrompt()).toBe(prompt);
    expect(profile.getPromptFieldSnapshot()).toEqual(fields);
    expect(await profile.getCognitionBinding()).toEqual(cognition);
    expect(await profile.preparePromptConfiguration()).toBe(false);
    agent.get(IAgentModelSteeringService);
    await runWillBeginStepHooks(agent.get(IAgentLoopService), true);
    expect(agent.get(IAgentContextMemoryService).get().some((message) => message.origin?.kind === 'injection' && message.origin.variant === 'model_steering' && message.content.some((part) => part.type === 'text' && part.text === 'FLASH STEERING'))).toBe(true);
    expect(await agent.get(IAgentCognitionAnchorService).project({ sourceType: 'turn', turnId: 0, step: 1, hasExplicitSystemPrompt: false })).toBe('OLD ANCHOR');
  });

  it('keeps prompt variables and overrides frozen until an explicit context rebuild', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md' });
    const config = agent.get(IConfigService);
    const get = config.get.bind(config);
    let value = 'OLD VARIABLE';
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'prompt'
      ? { variables: { example: value }, overrides: { fields: { 'system.shared': '${example}', 'tool.read.description': '${example}' } } }
      : get(domain)) as IConfigService['get']);
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    value = 'NEW VARIABLE';
    expect(await profile.preparePromptConfiguration()).toBe(false);
    await profile.refreshSystemPrompt();
    expect(profile.getSystemPrompt()).toContain('OLD VARIABLE');
    expect(profile.getSystemPrompt()).not.toContain('NEW VARIABLE');
    expect(profile.data().boundProfile?.promptBase?.inputs?.variables).toEqual({ example: 'OLD VARIABLE' });
    await profile.rebuildPromptContext();
    expect(profile.getSystemPrompt()).toContain('NEW VARIABLE');
    expect(profile.data().boundProfile?.promptBase?.inputs?.variables).toEqual({ example: 'NEW VARIABLE' });
  });

  it.each(['body-only', 'unchanged-projections', 'missing-projections', 'corrupt-inputs', 'pre-diagnostics'] as const)('recovers legacy evidence or reports the exact missing inputs: %s', async (format) => {
    const persistence = new InMemoryWireRecordPersistence();
    const cognition = { overlay: 'cognition/overlay.md', steering: format.includes('projections') ? 'cognition/steering.md' : undefined };
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition } } };
      return ctx;
    };
    let agent = create();
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    await agent.get(IWireService).flush();
    await agent.dispose();
    for (const record of persistence.records) {
      if (record.type !== 'profile.bind') continue;
      const bound = record['boundProfile'] as { promptBase: { inputs?: { revision: string }; promptDiagnostics?: unknown } };
      if (format === 'corrupt-inputs') bound.promptBase.inputs!.revision = 'corrupt';
      else delete bound.promptBase.inputs;
      if (format === 'pre-diagnostics') delete bound.promptBase.promptDiagnostics;
    }
    if (format !== 'unchanged-projections') await rm(join(homeDir, 'cognition'), { recursive: true });
    agent = create();
    await agent.restorePersisted();
    const restored = agent.get(IAgentProfileService);
    if (format === 'missing-projections') await expect(restored.syncBindingMetadata()).rejects.toThrow(/legacy binding.*cognition.steering/);
    else if (format === 'corrupt-inputs') await expect(restored.syncBindingMetadata()).rejects.toThrow(/saved prompt inputs are incomplete or invalid/);
    else {
      await restored.syncBindingMetadata();
      expect(restored.getSystemPrompt()).toBe(prompt);
      expect(await restored.preparePromptConfiguration()).toBe(false);
    }
  });

  it.each([false, true])('commits explicit model resume with new_window=%s and freezes its new inputs for cold recovery', async (newWindow) => {
    const persistence = new InMemoryWireRecordPersistence();
    const create = () => {
      ctx = createTestAgent({ persistence, autoConfigure: false }, homeDirServices(homeDir));
      ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, [MOCK_MODEL]: { ...ctx.kimiConfig.models![MOCK_MODEL]!, cognition: { overlay: 'cognition/overlay.md' } }, [OTHER_MODEL]: { provider: 'test-provider', model: OTHER_MODEL, maxContextSize: 1_000_000, defaultEffort: 'off', cognition: { overlay: 'cognition/steering.md' } } } };
      return ctx;
    };
    let agent = create();
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await agent.get(ISessionMetadata).registerAgent('main', { type: 'main' });
    await expect(profile.prepareResumeBinding({ modelAlias: OTHER_MODEL })).rejects.toThrow(/allow_model_change/);
    const binding = await profile.prepareResumeBinding({ modelAlias: OTHER_MODEL, allowModelChange: !newWindow, newWindow });
    await agent.get(IAgentModelSwitchService).execute({ operationId: `frozen-resume-${newWindow}`, model: binding.model, thinking: binding.thinking, mode: newWindow ? 'fresh' : 'direct' }, { binding });
    expect(profile.getSystemPrompt()).toContain('FLASH STEERING');
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
    await agent.get(IWireService).flush();
    await agent.dispose();
    await rm(join(homeDir, 'cognition'), { recursive: true });
    agent = create();
    await agent.restorePersisted();
    const restored = agent.get(IAgentProfileService);
    await restored.syncBindingMetadata();
    expect(restored.data().modelAlias).toBe(OTHER_MODEL);
    expect(restored.getSystemPrompt()).toContain('FLASH STEERING');
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
