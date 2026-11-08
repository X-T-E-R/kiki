import { describe, expect, it } from 'vitest';

import { applyExecutorInstancePatch, materializeExecutorInstance } from '#/app/agentExecutor/executorInstances';
import {
  applyInstanceLaunch,
  chooseAutoInstance,
  decideExecutorSchedule,
  isQuotaExhaustedTurnError,
  mergeExecutorOptions,
  mergeLaunchLayers,
  overlayScheduleLaunch,
  resolveExecutorSchedule,
  winningScheduleChoice,
  type ScheduleInstanceView,
} from '#/app/agentExecutor/executorSchedule';
import { AGENT_EXECUTOR_OVERRIDES_SECTION, agentExecutorOverridesFromToml, agentExecutorOverridesToToml, AgentExecutorOverridesSchema } from '#/app/agentExecutor/executorOverrides';
import type { AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import { publicExecutorInstance, type ExecutorInstanceConfig, type HarnessQuotaReading } from '@kiki/protocol';

const family = 'agy-cli';

function instance(id: string, account?: string, launch?: ScheduleInstanceView['launch']): ScheduleInstanceView {
  return {
    id, label: id, sourceExecutor: family, quotaAccountId: account,
    configuration: { kind: 'inherit' }, proxy: { kind: 'inherit' }, launch,
  };
}

const work = instance('instance-work', 'work', { home_dir: '/work', env: { KEEP: '1', REPLACE: 'old' }, args: ['--old'] });
const personal = instance('instance-personal', 'personal', { home_dir: '/personal' });
const instances = [work, personal];

function input(overrides: Partial<Parameters<typeof decideExecutorSchedule>[0]> = {}) {
  return { requestedExecutor: family, familyId: family, instances, ...overrides };
}

describe('executor schedule', () => {
  it('lets an explicit main replace a lower auto, and a session choice replace a profile', () => {
    expect(winningScheduleChoice(input({ sessionChoice: 'main', defaultsChoice: 'auto' }))).toEqual({ choice: 'main', source: 'session' });
    expect(winningScheduleChoice(input({ sessionChoice: 'auto', profileChoice: 'instance-work', profileExecutor: family }))).toEqual({ choice: 'auto', source: 'session' });
    expect(winningScheduleChoice(input({ profileChoice: 'instance-personal', profileExecutor: family, defaultsChoice: 'auto' }))).toEqual({ choice: 'instance-personal', source: 'profile' });
    expect(winningScheduleChoice(input({ requestedExecutor: 'instance-work', profileChoice: 'auto', profileExecutor: family }))).toEqual({ choice: 'instance-work', source: 'session' });
    expect(winningScheduleChoice(input())).toEqual({ choice: 'main', source: 'harness-default' });
  });

  it('reuses a saved auto result, locks a restore id, and keeps a legacy executor id', () => {
    const previous = { instance: 'instance-work', choice: 'auto' as const, source: 'harness-settings' as const, quota_consulted: true };
    const reused = decideExecutorSchedule(input({
      defaultsChoice: 'auto', quotaSourceId: 'plugin:fixture-quota/example', profileIdentity: 'same',
      previous: { schedule: previous, profileIdentity: 'same', executorId: family },
    }));
    expect(reused).toMatchObject({ reused: true, needsQuota: false, instance: 'instance-work', quotaConsulted: true });

    expect(decideExecutorSchedule(input({ lockedExecutorId: 'instance-personal', defaultsChoice: 'auto' }))).toMatchObject({
      reused: true, instance: 'instance-personal', needsQuota: false,
    });

    expect(decideExecutorSchedule(input({
      profileIdentity: 'same',
      previous: { profileIdentity: 'same', executorId: 'instance-work' },
    }))).toMatchObject({ reused: true, instance: 'instance-work', choice: 'instance-work' });
  });

  it('matches an account without reading quota and marks an unmatched account as missing while preserving saved bindings', () => {
    expect(decideExecutorSchedule(input({ sessionChoice: { account_id: 'personal' }, quotaSourceId: 'plugin:fixture-quota/example' }))).toMatchObject({
      instance: 'instance-personal', needsQuota: false, launchId: 'instance-personal', missingInstance: false,
    });
    expect(decideExecutorSchedule(input({ sessionChoice: { account_id: 'missing' } }))).toMatchObject({
      choice: { account_id: 'missing' }, missingInstance: true, needsQuota: false,
    });
    const savedSchedule = { instance: 'instance-work', choice: { account_id: 'retired-account' }, source: 'session' as const, quota_consulted: false };
    expect(decideExecutorSchedule(input({
      sessionChoice: { account_id: 'retired-account' }, profileIdentity: 'same',
      previous: { schedule: savedSchedule, profileIdentity: 'same', executorId: 'instance-work' },
    }))).toMatchObject({ reused: true, instance: 'instance-work', launchId: 'instance-work', missingInstance: false });
  });

  it('picks the highest positive comparable remaining, rejects exhausted zero, and stays stable on a tie', () => {
    const readings: HarnessQuotaReading[] = [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 20 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 80 },
      { accountId: 'work', unit: 'percent', remaining: undefined },
      { accountId: 'pooled', pool: 'display', unit: 'percent', remaining: 100 },
    ];
    expect(chooseAutoInstance([...instances, instance('instance-pooled', 'pooled')], readings, family, 'fixture-model')).toBe('instance-personal');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 40 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 40 },
    ], family, 'fixture-model')).toBe('instance-personal');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 5 },
    ], family, 'fixture-model')).toBe('instance-personal');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
    ], family, 'fixture-model')).toBe('main');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 50 },
      { accountId: 'work', modelIds: ['fixture-model'], window: 'daily', unit: 'percent', remaining: 0 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: undefined },
    ], family, 'fixture-model')).toBe('main');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'tokens', remaining: 120 },
    ], family, 'fixture-model')).toBe('instance-work');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', unit: 'percent', remaining: 10 },
    ], family, undefined)).toBe('instance-work');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['other-model'], unit: 'percent', remaining: 90 },
    ], family, 'fixture-model')).toBe('main');
    expect(chooseAutoInstance(instances, [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'tokens', remaining: 1 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 2 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 9 },
    ], family, 'fixture-model')).toBe('instance-personal');
    expect(chooseAutoInstance(instances, [], family, 'fixture-model')).toBe('main');
  });

  it('falls back to main when a quota read fails and does not read for an explicit main', async () => {
    let reads = 0;
    const failed = await resolveExecutorSchedule(input({ defaultsChoice: 'auto', quotaSourceId: 'plugin:fixture-quota/example', targetModel: 'fixture-model' }), async () => {
      reads += 1;
      throw new Error('quota down');
    });
    expect(failed.choice).toMatchObject({ instance: 'main', quotaConsulted: true });
    expect(failed.schedule.quota_consulted).toBe(true);
    const explicit = await resolveExecutorSchedule(input({ sessionChoice: 'main', defaultsChoice: 'auto', quotaSourceId: 'plugin:fixture-quota/example' }), async () => {
      reads += 1;
      return [];
    });
    expect(explicit.choice).toMatchObject({ instance: 'main', quotaConsulted: false });
    expect(reads).toBe(1);
  });

  it('merges env by key, replaces extra args, and prevents cleared launch fields from resurfacing from the instance descriptor', () => {
    expect(mergeLaunchLayers(work.launch, { env: { REPLACE: null, ADDED: '1' } }, { args: ['--next'] })).toEqual({
      home_dir: '/work', env: { KEEP: '1', ADDED: '1' }, args: ['--next'],
    });
    expect(mergeLaunchLayers(work.launch, { args: [] }, { env: null }).env).toBeUndefined();
    expect(mergeLaunchLayers(work.launch, { args: [] }, { env: null }).args).toBeUndefined();

    const familyDescriptor: AgentExecutorDescriptor = {
      id: family,
      protocol: 'acp-v1',
      command: 'agy-base',
      homeEnv: 'INSTANCE_HOME',
      args: ['--base'],
      env: { BASE_ENV: 'base' },
      revision: 'family-rev',
    };
    const storedConfig: ExecutorInstanceConfig = {
      source_executor: family,
      label: 'Work',
      configuration: { kind: 'config_directory', path: '/config-dir' },
      proxy: { kind: 'url', url: 'http://127.0.0.1:8080' },
      quota_account_id: 'work',
      launch: {
        bin_path: '/instance-bin',
        home_dir: '/instance-home',
        env: { KEEP: '1', DROP: 'secret' },
        args: ['--instance-arg'],
        options: { optA: 'instance', optB: true },
      },
    };
    const storedView: ScheduleInstanceView = {
      id: 'instance-work',
      label: storedConfig.label,
      sourceExecutor: family,
      quotaAccountId: storedConfig.quota_account_id,
      configuration: storedConfig.configuration,
      proxy: storedConfig.proxy,
      launch: storedConfig.launch,
    };
    const selectedDescriptor = applyInstanceLaunch(
      { ...materializeExecutorInstance('instance-work', storedConfig, familyDescriptor, () => undefined), instance: publicExecutorInstance(storedConfig) },
      storedConfig.launch,
    );
    expect(selectedDescriptor.homeDir).toBe('/instance-home');
    expect(selectedDescriptor.env).toMatchObject({ KEEP: '1', DROP: 'secret', HTTP_PROXY: 'http://127.0.0.1:8080' });
    expect(selectedDescriptor.extraArgs).toEqual(['--instance-arg']);

    const clearedPatch = mergeLaunchLayers(
      storedView.launch,
      { home_dir: null, bin_path: null, env: { DROP: null }, args: [] },
      { proxy: { kind: 'direct' } },
    );
    expect(clearedPatch).toEqual({
      env: { KEEP: '1' },
      options: { optA: 'instance', optB: true },
      proxy: { kind: 'direct' },
    });
    const overlaid = overlayScheduleLaunch(selectedDescriptor, familyDescriptor, clearedPatch, storedView, () => undefined);
    expect(overlaid.homeDir).toBe('/config-dir');
    expect(overlaid.sources).toBeUndefined();
    expect(overlaid.extraArgs).toBeUndefined();
    expect(overlaid.env).toEqual({ BASE_ENV: 'base', KEEP: '1' });
    expect(overlaid.env).not.toHaveProperty('DROP');
    expect(overlaid.env).not.toHaveProperty('HTTP_PROXY');
    expect(overlaid.launchSecrets).toEqual(['1']);
    expect(storedView.launch).toEqual(storedConfig.launch);

    const inheritedPatch = mergeLaunchLayers(storedView.launch, undefined, undefined);
    const inherited = overlayScheduleLaunch(selectedDescriptor, familyDescriptor, inheritedPatch, storedView, () => undefined);
    expect(inherited.homeDir).toBe('/instance-home');
    expect(inherited.extraArgs).toEqual(['--instance-arg']);
    expect(inherited.env).toMatchObject({ BASE_ENV: 'base', KEEP: '1', DROP: 'secret', HTTP_PROXY: 'http://127.0.0.1:8080' });

    expect(mergeExecutorOptions(storedConfig.launch?.options, { optA: null, optC: 2 }, { optB: null })).toEqual({ optC: 2 });
    expect(mergeExecutorOptions(storedConfig.launch?.options, null, undefined)).toBeUndefined();
  });

  it('isolates Grok Build config_directory instances from host auth overrides while keeping explicit launch env', () => {
    const grokFamily: AgentExecutorDescriptor = {
      id: 'grok-acp',
      protocol: 'acp-v1',
      command: 'grok',
      homeEnv: 'GROK_HOME',
      apiKeyEnv: 'XAI_API_KEY',
      args: ['--no-auto-update', 'agent', 'stdio'],
      revision: 'grok-rev',
    };
    const materialized = materializeExecutorInstance('instance-grok-a', {
      source_executor: 'grok-acp',
      label: 'Grok Account A',
      configuration: { kind: 'config_directory', path: '/grok-home-a' },
      proxy: { kind: 'direct' },
      quota_account_id: 'acct-a@example.test',
    }, grokFamily, () => undefined);
    expect(materialized.homeDir).toBe('/grok-home-a');
    expect(materialized.envUnset).toEqual(expect.arrayContaining([
      'GROK_AUTH',
      'GROK_AUTH_PATH',
      'GROK_AUTH_PROVIDER_COMMAND',
      'GROK_AUTH_EXPIRED',
      'XAI_API_KEY',
    ]));
    const withLaunchEnv = applyInstanceLaunch(materialized, { env: { XAI_API_KEY: 'explicit-instance-key' } });
    expect(withLaunchEnv.env?.['XAI_API_KEY']).toBe('explicit-instance-key');
    expect(withLaunchEnv.envUnset).not.toContain('XAI_API_KEY');
    expect(withLaunchEnv.envUnset).toContain('GROK_AUTH_PATH');
  });

  it('distinguishes explicit quota exhaustion from network disconnects and applies auto_continuation_policy', async () => {
    expect(isQuotaExhaustedTurnError(new Error('AGY terminal status ERROR: RESOURCE_EXHAUSTED (code 429): Individual quota reached.'))).toBe(true);
    expect(isQuotaExhaustedTurnError({ message: 'External turn failed', details: { stderrTail: 'rate_limit_exceeded: insufficient_quota' } })).toBe(true);
    expect(isQuotaExhaustedTurnError(new Error('read tcp 127.0.0.1:52100->127.0.0.1:7897: wsarecv: An existing connection was forcibly closed by the remote host.'))).toBe(false);
    expect(isQuotaExhaustedTurnError(new Error('network error: ECONNRESET socket hang up'))).toBe(false);

    const previous = { instance: 'instance-work', choice: 'auto' as const, source: 'harness-settings' as const, quota_consulted: true };
    const readings: HarnessQuotaReading[] = [
      { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
      { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: 75 },
    ];

    let quotaReads = 0;
    const preferCurrentReused = await resolveExecutorSchedule(input({
      defaultsChoice: 'auto',
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: previous, profileIdentity: 'same', executorId: 'instance-work' },
    }), async () => {
      quotaReads += 1;
      return readings;
    });
    expect(preferCurrentReused.choice).toMatchObject({
      reused: true,
      instance: 'instance-work',
      launchId: 'instance-work',
      quotaConsulted: true,
    });
    expect(quotaReads).toBe(0);

    const preferCurrentAfterQuotaFailure = await resolveExecutorSchedule(input({
      defaultsChoice: 'auto',
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: previous, profileIdentity: 'same', executorId: 'instance-work' },
      excludedInstances: ['instance-work'],
    }), async () => {
      quotaReads += 1;
      return readings;
    });
    expect(preferCurrentAfterQuotaFailure.choice).toMatchObject({
      reused: false,
      instance: 'instance-personal',
      launchId: 'instance-personal',
      quotaConsulted: true,
    });
    expect(quotaReads).toBe(1);

    const preferQuotaDirect = await resolveExecutorSchedule(input({
      defaultsChoice: 'auto',
      autoContinuationPolicy: 'prefer_quota',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: previous, profileIdentity: 'same', executorId: 'instance-work' },
    }), async () => {
      quotaReads += 1;
      return readings;
    });
    expect(preferQuotaDirect.choice).toMatchObject({
      reused: false,
      instance: 'instance-personal',
      launchId: 'instance-personal',
      quotaConsulted: true,
    });
    expect(quotaReads).toBe(2);

    const savedSessionAuto = { instance: 'instance-work', choice: 'auto' as const, source: 'session' as const, quota_consulted: true };
    const savedSessionAutoReused = await resolveExecutorSchedule(input({
      sessionChoice: 'auto',
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: savedSessionAuto, profileIdentity: 'same', executorId: 'instance-work' },
    }), async () => {
      quotaReads += 1;
      return readings;
    });
    expect(savedSessionAutoReused.choice).toMatchObject({
      reused: true,
      instance: 'instance-work',
      launchId: 'instance-work',
      choice: 'auto',
      source: 'session',
      quotaConsulted: true,
    });
    expect(quotaReads).toBe(2);

    const freshExplicitAutoReselected = await resolveExecutorSchedule(input({
      sessionChoice: 'auto',
      freshSessionChoice: true,
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: savedSessionAuto, profileIdentity: 'same', executorId: 'instance-work' },
    }), async () => {
      quotaReads += 1;
      return readings;
    });
    expect(freshExplicitAutoReselected.choice).toMatchObject({
      reused: false,
      instance: 'instance-personal',
      launchId: 'instance-personal',
      choice: 'auto',
      source: 'session',
      quotaConsulted: true,
    });
    expect(quotaReads).toBe(3);

    const legacySmoke = instance('instance-cockpit-smoke', undefined);
    const instancesWithLegacy = [legacySmoke, ...instances];
    const excludedMainExhausted = await resolveExecutorSchedule(input({
      instances: instancesWithLegacy,
      sessionChoice: 'auto',
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: { ...savedSessionAuto, instance: 'main' }, profileIdentity: 'same', executorId: family },
      excludedInstances: ['main'],
    }), async () => {
      quotaReads += 1;
      return [
        { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 0 },
        { accountId: 'personal', modelIds: ['fixture-model'], unit: 'percent', remaining: undefined },
      ];
    });
    expect(excludedMainExhausted.choice).toMatchObject({
      exhaustedAutoReselection: true,
      quotaConsulted: true,
      choice: 'auto',
      instance: 'main',
    });
    expect(excludedMainExhausted.schedule.choice).toBe('auto');

    const excludedMainReaderError = await resolveExecutorSchedule(input({
      instances: instancesWithLegacy,
      sessionChoice: 'auto',
      autoContinuationPolicy: 'prefer_current',
      quotaSourceId: 'plugin:fixture-quota/example',
      profileIdentity: 'same',
      targetModel: 'fixture-model',
      previous: { schedule: { ...savedSessionAuto, instance: 'main' }, profileIdentity: 'same', executorId: family },
      excludedInstances: ['main'],
    }), async () => {
      quotaReads += 1;
      throw new Error('quota plugin offline');
    });
    expect(excludedMainReaderError.choice).toMatchObject({
      exhaustedAutoReselection: true,
      quotaConsulted: false,
      choice: 'auto',
      instance: 'main',
    });
    expect(excludedMainReaderError.schedule.quota_consulted).toBe(false);
    expect(excludedMainReaderError.schedule.choice).toBe('auto');

    const rawToml = {
      [family]: {
        quota_source: 'plugin:fixture-quota/example',
        defaults: {
          executor_instance: 'auto',
          auto_continuation_policy: 'prefer_current',
        },
      },
    };
    const parsed = AgentExecutorOverridesSchema.parse(agentExecutorOverridesFromToml(rawToml));
    expect(parsed[family]?.defaults?.auto_continuation_policy).toBe('prefer_current');
    expect(agentExecutorOverridesToToml(parsed)).toEqual(rawToml);
    expect(AGENT_EXECUTOR_OVERRIDES_SECTION).toBe('agentExecutorOverrides');
  });
});

describe('executor instance config merge', () => {
  const saved = {
    'instance-work': {
      source_executor: 'agy-cli', label: 'Work', configuration: { kind: 'inherit' as const }, proxy: { kind: 'inherit' as const },
      quota_account_id: 'work', launch: { home_dir: '/work', env: { KEEP: '1' }, args: ['--old'] },
    },
  };

  it('keeps omitted launch and quota, and clears only an explicit empty value', () => {
    const entry = { source_executor: 'agy-cli', label: 'Work', configuration: { kind: 'inherit' }, proxy: { kind: 'inherit' } };
    expect(applyExecutorInstancePatch(saved, { 'instance-work': entry })['instance-work']).toEqual(saved['instance-work']);
    expect(applyExecutorInstancePatch(saved, { 'instance-work': { ...entry, launch: {} } })['instance-work']?.launch).toEqual({ env: { KEEP: '1' } });
    expect(applyExecutorInstancePatch(saved, { 'instance-work': { ...entry, launch: { env: {} } } })['instance-work']?.launch).toBeUndefined();
    expect(applyExecutorInstancePatch(saved, { 'instance-work': { ...entry, quota_account_id: null } })['instance-work']?.quota_account_id).toBeUndefined();
    expect(applyExecutorInstancePatch(saved, { 'instance-work': { ...entry, launch: null } })['instance-work']?.launch).toBeUndefined();
  });
});
