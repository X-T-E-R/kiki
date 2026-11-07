import { describe, expect, it } from 'vitest';

import { applyExecutorInstancePatch } from '#/app/agentExecutor/executorInstances';
import {
  chooseAutoInstance,
  decideExecutorSchedule,
  mergeLaunchLayers,
  resolveExecutorSchedule,
  winningScheduleChoice,
  type ScheduleInstanceView,
} from '#/app/agentExecutor/executorSchedule';
import type { HarnessQuotaReading } from '@kiki/protocol';

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

  it('matches an account without reading quota and uses main when nothing matches', () => {
    expect(decideExecutorSchedule(input({ sessionChoice: { account_id: 'personal' }, quotaSourceId: 'plugin:fixture-quota/example' }))).toMatchObject({
      instance: 'instance-personal', needsQuota: false, launchId: 'instance-personal',
    });
    expect(decideExecutorSchedule(input({ sessionChoice: { account_id: 'missing' } }))).toMatchObject({ instance: 'main', needsQuota: false });
  });

  it('picks the highest comparable remaining and stays stable on a tie', () => {
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

  it('merges env by key and replaces extra args', () => {
    expect(mergeLaunchLayers(work.launch, { env: { REPLACE: null, ADDED: '1' } }, { args: ['--next'] })).toEqual({
      home_dir: '/work', env: { KEEP: '1', ADDED: '1' }, args: ['--next'],
    });
    expect(mergeLaunchLayers(work.launch, { args: [] }, { env: null }).env).toBeUndefined();
    expect(mergeLaunchLayers(work.launch, { args: [] }, { env: null }).args).toBeUndefined();
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
