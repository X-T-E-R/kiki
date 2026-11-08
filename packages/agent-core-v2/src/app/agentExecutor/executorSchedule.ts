import { createHash } from 'node:crypto';
import {
  executorInstanceIdSchema,
  publicExecutorInstance,
  publicExecutorLaunch,
  type ExecutionSchedule,
  type ExecutionValueSource,
  type ExecutorAutoContinuationPolicy,
  type ExecutorInstanceChoice,
  type ExecutorInstanceConfig,
  type ExecutorLaunch,
  type ExecutorLaunchPatch,
  type HarnessQuotaReading,
} from '@kiki/protocol';

import type { AgentExecutorDescriptor } from './agentExecutor';
import { materializeExecutorInstance } from './executorInstances';
import { EXECUTOR_OVERRIDE_SOURCE_ID, executorOverrideSource } from './executorOverrides';

export interface ScheduleInstanceView {
  readonly id: string;
  readonly label: string;
  readonly sourceExecutor: string;
  readonly quotaAccountId?: string;
  readonly configuration: ExecutorInstanceConfig['configuration'];
  readonly proxy: ExecutorInstanceConfig['proxy'];
  readonly launch?: ExecutorLaunch;
}

export interface ScheduleChoiceInput {
  readonly requestedExecutor: string;
  readonly familyId: string;
  readonly sessionChoice?: ExecutorInstanceChoice | null;
  readonly sessionLaunch?: ExecutorLaunchPatch | null;
  readonly freshSessionChoice?: boolean;
  readonly profileChoice?: ExecutorInstanceChoice;
  readonly profileLaunch?: ExecutorLaunchPatch;
  readonly profileExecutor?: string;
  readonly profileIdentity?: string;
  readonly defaultsChoice?: ExecutorInstanceChoice;
  readonly autoContinuationPolicy?: ExecutorAutoContinuationPolicy;
  readonly instances: readonly ScheduleInstanceView[];
  readonly quotaSourceId?: string;
  readonly previous?: {
    readonly schedule?: ExecutionSchedule;
    readonly profileIdentity?: string;
    readonly executorId?: string;
  };
  readonly excludedInstances?: readonly ('main' | string)[];
  readonly lockedExecutorId?: string;
  readonly targetModel?: string;
}

export interface ScheduleChoice {
  readonly reused: boolean;
  readonly needsQuota: boolean;
  readonly quotaSourceId?: string;
  readonly choice: ExecutorInstanceChoice;
  readonly source: ExecutionValueSource;
  readonly launchId: string;
  readonly instance: 'main' | string;
  readonly missingInstance: boolean;
  readonly exhaustedAutoReselection?: boolean;
  readonly quotaConsulted: boolean;
}

export function instanceAccountId(instance: ScheduleInstanceView): string | undefined {
  if (instance.quotaAccountId !== undefined) return instance.quotaAccountId;
  return instance.configuration.kind === 'plugin_account' ? instance.configuration.account_id : undefined;
}

function isInstanceId(value: string): boolean {
  return executorInstanceIdSchema.safeParse(value).success;
}

function sameChoice(left: ExecutorInstanceChoice, right: ExecutorInstanceChoice): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function winningScheduleChoice(input: ScheduleChoiceInput): { readonly choice: ExecutorInstanceChoice; readonly source: ExecutionValueSource } {
  if (input.sessionChoice !== undefined && input.sessionChoice !== null) return { choice: input.sessionChoice, source: 'session' };
  if (isInstanceId(input.requestedExecutor)) return { choice: input.requestedExecutor, source: 'session' };
  if (input.profileChoice !== undefined && (input.profileExecutor === undefined || input.profileExecutor === input.familyId || input.profileExecutor === input.requestedExecutor)) {
    return { choice: input.profileChoice, source: 'profile' };
  }
  if (input.defaultsChoice !== undefined) return { choice: input.defaultsChoice, source: 'harness-settings' };
  return { choice: 'main', source: 'harness-default' };
}

function familyInstance(input: ScheduleChoiceInput, id: string): ScheduleInstanceView | undefined {
  return input.instances.find((instance) => instance.id === id && instance.sourceExecutor === input.familyId);
}

function decision(
  input: ScheduleChoiceInput,
  choice: ExecutorInstanceChoice,
  source: ExecutionValueSource,
  launchId: string,
  instance: 'main' | string,
  flags: {
    readonly reused?: boolean;
    readonly needsQuota?: boolean;
    readonly missingInstance?: boolean;
    readonly exhaustedAutoReselection?: boolean;
    readonly quotaConsulted?: boolean;
  } = {},
): ScheduleChoice {
  return {
    reused: flags.reused === true,
    needsQuota: flags.needsQuota === true,
    quotaSourceId: input.quotaSourceId,
    choice,
    source,
    launchId,
    instance,
    missingInstance: flags.missingInstance === true,
    exhaustedAutoReselection: flags.exhaustedAutoReselection === true ? true : undefined,
    quotaConsulted: flags.quotaConsulted === true,
  };
}

const QUOTA_EXPLICIT_PATTERN = /RESOURCE_EXHAUSTED|quota[\s_-]*reached|quota[\s_-]*exceeded|rate[\s_-]*limit[\s_-]*exceeded|insufficient[\s_-]*quota|usage[\s_-]*limit|额度|余额不足/i;
const QUOTA_STATUS_PATTERN = /\b429\b|\btoo\s+many\s+requests\b/i;
const NETWORK_DISCONNECT_PATTERN = /\b(?:wsarecv|wsasend|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|socket\s+hang\s+up|read\s+tcp|write\s+tcp|connection\s+was\s+forcibly\s+closed|network\s+(?:error|issue|disconnected)/i;

function extractErrorTexts(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === undefined || error === null || seen.has(error)) return [];
  if (typeof error === 'string') return [error];
  if (typeof error !== 'object') return [];
  seen.add(error);
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record['message'] === 'string') parts.push(record['message']);
  if (typeof record['code'] === 'string') parts.push(record['code']);
  const details = record['details'];
  if (typeof details === 'object' && details !== null) {
    const detailRec = details as Record<string, unknown>;
    if (typeof detailRec['stderrTail'] === 'string') parts.push(detailRec['stderrTail']);
    if (typeof detailRec['reason_code'] === 'string') parts.push(detailRec['reason_code']);
    if (typeof detailRec['message'] === 'string') parts.push(detailRec['message']);
  }
  parts.push(...extractErrorTexts(record['cause'], seen));
  parts.push(...extractErrorTexts(record['error'], seen));
  return parts;
}

export function isQuotaExhaustedTurnError(error: unknown): boolean {
  const combined = extractErrorTexts(error).join('\n');
  if (combined.length === 0) return false;
  if (QUOTA_EXPLICIT_PATTERN.test(combined)) return true;
  if (NETWORK_DISCONNECT_PATTERN.test(combined)) return false;
  return QUOTA_STATUS_PATTERN.test(combined);
}

export function decideExecutorSchedule(input: ScheduleChoiceInput): ScheduleChoice {
  if (input.lockedExecutorId !== undefined) {
    const locked = input.lockedExecutorId;
    if (locked === input.familyId || locked === 'native' || !isInstanceId(locked)) {
      return decision(input, 'main', 'harness-default', input.familyId, 'main', { reused: true });
    }
    return decision(input, locked, 'harness-default', locked, locked, { reused: true, missingInstance: familyInstance(input, locked) === undefined && locked !== input.requestedExecutor });
  }
  const next = winningScheduleChoice(input);
  const previous = input.previous?.schedule;
  const sameProfile = input.previous?.profileIdentity === input.profileIdentity;
  const policy = input.autoContinuationPolicy ?? 'prefer_current';
  const freshExplicitSessionAuto = input.sessionChoice === 'auto' && (
    input.freshSessionChoice === true ||
    previous === undefined ||
    previous.choice !== 'auto' ||
    previous.source !== 'session'
  );
  const forceAutoReselect = next.choice === 'auto' && (
    freshExplicitSessionAuto ||
    policy === 'prefer_quota' ||
    (input.excludedInstances?.length ?? 0) > 0
  );
  if (!forceAutoReselect && previous !== undefined && sameProfile && previous.source === next.source && sameChoice(previous.choice, next.choice)) {
    const instance = previous.instance;
    const launchId = instance === 'main' ? input.familyId : instance;
    return decision(input, next.choice, next.source, launchId, instance, { reused: true, quotaConsulted: previous.quota_consulted });
  }
  const sessionUntouched = (input.sessionChoice === undefined || input.sessionChoice === null) && (input.sessionLaunch === undefined || input.sessionLaunch === null);
  if (!forceAutoReselect && previous === undefined && input.previous?.executorId !== undefined && sessionUntouched && sameProfile && !isInstanceId(input.requestedExecutor)) {
    const saved = input.previous.executorId;
    const fallbackChoice = next.choice === 'auto' ? 'auto' : saved === input.familyId || !isInstanceId(saved) ? 'main' : saved;
    const fallbackSource = next.choice === 'auto' ? next.source : 'harness-default';
    if (saved === input.familyId || !isInstanceId(saved)) return decision(input, fallbackChoice, fallbackSource, input.familyId, 'main', { reused: true });
    if (familyInstance(input, saved) !== undefined) return decision(input, fallbackChoice, fallbackSource, saved, saved, { reused: true });
  }
  return resolveChoice(input, next.choice, next.source);
}

function resolveChoice(input: ScheduleChoiceInput, choice: ExecutorInstanceChoice, source: ExecutionValueSource): ScheduleChoice {
  if (choice === 'main') return decision(input, choice, source, input.familyId, 'main');
  if (choice === 'auto') {
    const hasExcluded = (input.excludedInstances?.length ?? 0) > 0;
    const needsQuota = input.quotaSourceId !== undefined;
    return decision(input, choice, source, input.familyId, 'main', {
      needsQuota,
      exhaustedAutoReselection: hasExcluded && !needsQuota,
    });
  }
  if (typeof choice === 'string') {
    return decision(input, choice, source, choice, choice, { missingInstance: familyInstance(input, choice) === undefined });
  }
  const match = input.instances.find((instance) => instance.sourceExecutor === input.familyId && instanceAccountId(instance) === choice.account_id);
  if (match === undefined) return decision(input, choice, source, input.familyId, 'main', { missingInstance: true });
  return decision(input, choice, source, match.id, match.id);
}

function readingCanRoute(reading: HarnessQuotaReading, model: string | undefined): boolean {
  if (reading.remaining === undefined) return false;
  const modelIds = reading.modelIds ?? [];
  if (reading.pool !== undefined && modelIds.length === 0) return false;
  if (modelIds.length === 0) return reading.pool === undefined;
  return model !== undefined && modelIds.includes(model);
}

function pickPositiveQuotaInstance(
  instances: readonly ScheduleInstanceView[],
  readings: readonly HarnessQuotaReading[],
  familyId: string,
  targetModel: string | undefined,
  excludedInstances: readonly ('main' | string)[] = [],
): string | undefined {
  const excludedIds = new Set(excludedInstances);
  const excludedAccounts = new Set(
    instances
      .filter((instance) => instance.sourceExecutor === familyId && excludedIds.has(instance.id))
      .map((instance) => instanceAccountId(instance))
      .filter((account): account is string => account !== undefined),
  );
  const candidates = instances.filter(
    (instance) =>
      instance.sourceExecutor === familyId &&
      !excludedIds.has(instance.id) &&
      instanceAccountId(instance) !== undefined &&
      !excludedAccounts.has(instanceAccountId(instance)!),
  );
  const usable = readings.filter((reading) => readingCanRoute(reading, targetModel));
  const counts = new Map<HarnessQuotaReading['unit'], number>();
  for (const reading of usable) {
    if ((reading.remaining ?? 0) <= 0) continue;
    if (!candidates.some((instance) => instanceAccountId(instance) === reading.accountId)) continue;
    counts.set(reading.unit, (counts.get(reading.unit) ?? 0) + 1);
  }
  const unit = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  if (unit === undefined) return undefined;
  const scored = candidates.flatMap((instance) => {
    const account = instanceAccountId(instance);
    const windows = usable.filter((reading) => reading.accountId === account && reading.unit === unit);
    if (windows.length === 0) return [];
    const remaining = Math.min(...windows.map((reading) => reading.remaining ?? 0));
    if (remaining <= 0) return [];
    return [{ id: instance.id, remaining }];
  }).sort((left, right) => right.remaining - left.remaining || left.id.localeCompare(right.id));
  return scored[0]?.id;
}

export function chooseAutoInstance(
  instances: readonly ScheduleInstanceView[],
  readings: readonly HarnessQuotaReading[],
  familyId: string,
  targetModel: string | undefined,
  excludedInstances: readonly ('main' | string)[] = [],
): 'main' | string {
  return pickPositiveQuotaInstance(instances, readings, familyId, targetModel, excludedInstances) ?? 'main';
}

function applyLaunchPatch(base: ExecutorLaunch, patch: ExecutorLaunchPatch | null | undefined): ExecutorLaunch {
  if (patch === undefined || patch === null) return base;
  const next: ExecutorLaunch = { ...base };
  if (patch.bin_path === null) delete next.bin_path;
  else if (patch.bin_path !== undefined) next.bin_path = patch.bin_path;
  if (patch.home_dir === null) delete next.home_dir;
  else if (patch.home_dir !== undefined) next.home_dir = patch.home_dir;
  if (patch.configuration === null) delete next.configuration;
  else if (patch.configuration !== undefined) next.configuration = patch.configuration;
  if (patch.proxy === null) delete next.proxy;
  else if (patch.proxy !== undefined) {
    if (patch.proxy.kind === 'url' && patch.proxy.authorization === null) {
      const { authorization: _authorization, ...proxy } = patch.proxy;
      next.proxy = proxy;
    } else if (patch.proxy.kind === 'url') next.proxy = { kind: 'url', url: patch.proxy.url, authorization: patch.proxy.authorization ?? undefined };
    else next.proxy = patch.proxy;
  }
  if (patch.args === null || (patch.args !== undefined && patch.args.length === 0)) delete next.args;
  else if (patch.args !== undefined) next.args = [...patch.args];
  if (patch.env === null) delete next.env;
  else if (patch.env !== undefined) {
    const env = { ...next.env };
    for (const [key, value] of Object.entries(patch.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    if (Object.keys(env).length === 0) delete next.env;
    else next.env = env;
  }
  if (patch.options === null) delete next.options;
  else if (patch.options !== undefined) {
    const options = { ...next.options };
    for (const [key, value] of Object.entries(patch.options)) {
      if (value === null) delete options[key];
      else options[key] = value;
    }
    if (Object.keys(options).length === 0) delete next.options;
    else next.options = options;
  }
  return next;
}

export function mergeLaunchLayers(
  instance: ExecutorLaunch | undefined,
  profile: ExecutorLaunchPatch | null | undefined,
  session: ExecutorLaunchPatch | null | undefined,
): ExecutorLaunch {
  return applyLaunchPatch(applyLaunchPatch({ ...instance }, profile), session);
}

export function mergeExecutorOptions(
  instance: Readonly<Record<string, string | number | boolean>> | undefined,
  profile: Readonly<Record<string, string | number | boolean | null>> | null | undefined,
  session: Readonly<Record<string, string | number | boolean | null>> | null | undefined,
): Record<string, string | number | boolean> | undefined {
  let merged: Record<string, string | number | boolean> = { ...instance };
  if (profile === null) {
    merged = {};
  } else if (profile !== undefined) {
    for (const [key, value] of Object.entries(profile)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  if (session === null) {
    merged = {};
  } else if (session !== undefined) {
    for (const [key, value] of Object.entries(session)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function launchStamp(launch: ExecutorLaunch): string {
  return JSON.stringify({
    bin_path: launch.bin_path,
    home_dir: launch.home_dir,
    configuration: launch.configuration,
    proxy: launch.proxy,
    env: launch.env === undefined ? undefined : Object.fromEntries(Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right))),
    args: launch.args,
    options: launch.options,
  });
}

export function applyInstanceLaunch(descriptor: AgentExecutorDescriptor, launch: ExecutorLaunch | undefined): AgentExecutorDescriptor {
  if (launch === undefined) return descriptor;
  const scalars: ExecutorLaunch = { bin_path: launch.bin_path, home_dir: launch.home_dir, env: launch.env, args: launch.args };
  if (scalars.bin_path === undefined && scalars.home_dir === undefined && scalars.env === undefined && scalars.args === undefined) return descriptor;
  return applyLaunchScalars(descriptor, scalars);
}

function applyLaunchScalars(descriptor: AgentExecutorDescriptor, launch: ExecutorLaunch): AgentExecutorDescriptor {
  let next = descriptor;
  if (launch.bin_path !== undefined) {
    next = { ...next, sources: [executorOverrideSource(launch.bin_path)], source: next.source === undefined ? next.source : EXECUTOR_OVERRIDE_SOURCE_ID };
  }
  if (launch.home_dir !== undefined) next = { ...next, homeDir: launch.home_dir };
  if (launch.env !== undefined) {
    const secrets = Object.values(launch.env).filter((value) => value.length > 0);
    const explicitKeys = new Set(Object.keys(launch.env).map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
    next = {
      ...next,
      env: { ...next.env, ...launch.env },
      envUnset: next.envUnset?.filter((key) => !explicitKeys.has(process.platform === 'win32' ? key.toLowerCase() : key)),
      launchSecrets: [...(next.launchSecrets ?? []), ...secrets].sort((left, right) => right.length - left.length),
    };
  }
  if (launch.args !== undefined) next = { ...next, extraArgs: launch.args.length > 0 ? [...launch.args] : undefined };
  const stamp = launchStamp(launch);
  if (stamp === '{}') return next;
  return { ...next, revision: createHash('sha256').update(`${descriptor.revision}\n${stamp}`).digest('hex') };
}

export function overlayScheduleLaunch(
  selected: AgentExecutorDescriptor,
  family: AgentExecutorDescriptor,
  patch: ExecutorLaunch,
  stored: ScheduleInstanceView | undefined,
  hostEnv: (name: string) => string | undefined,
): AgentExecutorDescriptor {
  const configuration = patch.configuration;
  const proxy = patch.proxy;
  let descriptor = family;
  if (stored !== undefined) {
    const baseInstance: ExecutorInstanceConfig = {
      source_executor: family.id,
      label: stored.label,
      configuration: stored.configuration,
      proxy: stored.proxy,
      quota_account_id: stored.quotaAccountId,
      launch: stored.launch,
    };
    const effectiveConfiguration = configuration ?? stored.configuration;
    const effectiveProxy = proxy ?? stored.proxy;
    const materialized = materializeExecutorInstance(stored.id, {
      ...baseInstance,
      configuration: effectiveConfiguration,
      proxy: effectiveProxy,
    }, family, hostEnv);
    const publishedInstance = publicExecutorInstance(baseInstance);
    const effectivePublicProxy = publicExecutorInstance({ ...baseInstance, proxy: effectiveProxy }).proxy;
    descriptor = {
      ...materialized,
      instance: {
        ...publishedInstance,
        configuration: effectiveConfiguration,
        proxy: effectivePublicProxy,
      },
    };
  } else if ((configuration !== undefined || proxy !== undefined) && family.protocol !== 'native') {
    const materialized = materializeExecutorInstance(family.id, {
      source_executor: family.id,
      label: selected.label ?? family.label ?? family.id,
      configuration: configuration ?? { kind: 'inherit' },
      proxy: proxy ?? { kind: 'inherit' },
    }, family, hostEnv);
    descriptor = { ...materialized, id: family.id, label: family.label, instance: undefined, defaultProfile: family.defaultProfile };
  }
  return applyInstanceLaunch(descriptor, patch);
}

export function scheduleRecord(
  choice: ScheduleChoice,
  launch: ExecutorLaunch,
): ExecutionSchedule {
  const projected = publicExecutorLaunch(launch);
  return {
    instance: choice.instance === 'main' ? 'main' : choice.instance,
    choice: choice.choice,
    source: choice.source,
    ...(choice.quotaSourceId === undefined ? {} : { quota_source: choice.quotaSourceId }),
    quota_consulted: choice.quotaConsulted,
    ...(projected === undefined ? {} : { launch: projected }),
  };
}

export async function resolveExecutorSchedule(
  input: ScheduleChoiceInput,
  readQuota: ((sourceId: string) => Promise<readonly HarnessQuotaReading[]>) | undefined,
): Promise<{ readonly choice: ScheduleChoice; readonly launch: ExecutorLaunch; readonly schedule: ExecutionSchedule }> {
  const decided = decideExecutorSchedule(input);
  const selected = decided.launchId === input.familyId ? undefined : input.instances.find((instance) => instance.id === decided.launchId);
  const launch = mergeLaunchLayers(selected?.launch, input.profileLaunch, input.sessionLaunch);
  const hasExcluded = (input.excludedInstances?.length ?? 0) > 0;
  if (!decided.needsQuota || decided.quotaSourceId === undefined || readQuota === undefined) {
    const choice = { ...decided, needsQuota: false, ...(hasExcluded && decided.choice === 'auto' ? { exhaustedAutoReselection: true } : {}) };
    return { choice, launch, schedule: scheduleRecord(choice, launch) };
  }
  const currentInstance = input.previous?.schedule?.instance ?? (
    input.previous?.executorId === undefined ? undefined
      : input.previous.executorId === input.familyId || !isInstanceId(input.previous.executorId) ? 'main' : input.previous.executorId
  );
  try {
    const readings = await readQuota(decided.quotaSourceId);
    const positive = pickPositiveQuotaInstance(input.instances, readings, input.familyId, input.targetModel, input.excludedInstances);
    if (positive === undefined && hasExcluded) {
      const kept = currentInstance ?? 'main';
      const choice = { ...decided, needsQuota: false, quotaConsulted: true, exhaustedAutoReselection: true, launchId: kept === 'main' ? input.familyId : kept, instance: kept };
      const keptInstance = kept === 'main' ? undefined : input.instances.find((instance) => instance.id === kept);
      const keptLaunch = mergeLaunchLayers(keptInstance?.launch, input.profileLaunch, input.sessionLaunch);
      return { choice, launch: keptLaunch, schedule: scheduleRecord(choice, keptLaunch) };
    }
    const picked = positive ?? 'main';
    const choice = { ...decided, needsQuota: false, quotaConsulted: true, launchId: picked === 'main' ? input.familyId : picked, instance: picked };
    const pickedInstance = picked === 'main' ? undefined : input.instances.find((instance) => instance.id === picked);
    const pickedLaunch = mergeLaunchLayers(pickedInstance?.launch, input.profileLaunch, input.sessionLaunch);
    return { choice, launch: pickedLaunch, schedule: scheduleRecord(choice, pickedLaunch) };
  } catch {
    if (hasExcluded) {
      const kept = currentInstance ?? 'main';
      const choice = { ...decided, needsQuota: false, quotaConsulted: false, exhaustedAutoReselection: true, launchId: kept === 'main' ? input.familyId : kept, instance: kept };
      const keptInstance = kept === 'main' ? undefined : input.instances.find((instance) => instance.id === kept);
      const keptLaunch = mergeLaunchLayers(keptInstance?.launch, input.profileLaunch, input.sessionLaunch);
      return { choice, launch: keptLaunch, schedule: scheduleRecord(choice, keptLaunch) };
    }
    const choice = { ...decided, needsQuota: false, quotaConsulted: true, launchId: input.familyId, instance: 'main' as const };
    const failedLaunch = mergeLaunchLayers(undefined, input.profileLaunch, input.sessionLaunch);
    return { choice, launch: failedLaunch, schedule: scheduleRecord(choice, failedLaunch) };
  }
}
