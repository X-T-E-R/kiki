import { executionSelectionSchema } from '@kiki/protocol';
import type { ExecutionBinding, ExecutionOverrides, ExecutionSelection, NamedAgentProfile } from '@kiki/protocol';

export type ExecutionContextGroup = NonNullable<ExecutionOverrides['kiki_context']>[number];
export const NATIVE_EXECUTOR = 'native';

export function profileExecutor(profile: Pick<NamedAgentProfile, 'executor'>): string {
  const executor = profile.executor;
  return executor === undefined || executor === '' ? NATIVE_EXECUTOR : executor;
}

export function isNativeExecutor(executor: string | undefined): boolean {
  return executor === undefined || executor === '' || executor === NATIVE_EXECUTOR;
}

export interface ExecutionChoice {
  readonly executor: string;
  readonly profile: string | undefined;
  readonly profile_file?: string;
  readonly external_connection_id?: string;
  readonly external_connection_name?: string;
  readonly overrides: ExecutionOverrides | undefined;
}

export const NATIVE_CHOICE: ExecutionChoice = { executor: NATIVE_EXECUTOR, profile: undefined, profile_file: undefined, overrides: undefined };

export function executionChoice(selection: ExecutionSelection | undefined): ExecutionChoice {
  if (selection === undefined) return NATIVE_CHOICE;
  return { executor: selection.executor, profile: selection.profile, profile_file: selection.profile_file, overrides: selection.overrides };
}

export function profileFileLabel(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name === '' ? path : name;
}

export function parseExecutionChoice(value: unknown): ExecutionChoice | undefined {
  if (typeof value === 'object' && value !== null && 'external_connection_id' in value) {
    const rec = value as Record<string, unknown>;
    if (typeof rec['external_connection_id'] === 'string') {
      return {
        executor: typeof rec['executor'] === 'string' ? rec['executor'] : 'external-client',
        profile: undefined,
        external_connection_id: rec['external_connection_id'],
        external_connection_name: typeof rec['external_connection_name'] === 'string' ? rec['external_connection_name'] : undefined,
        overrides: undefined,
      };
    }
  }
  const parsed = executionSelectionSchema.safeParse(value);
  return parsed.success ? executionChoice(parsed.data) : undefined;
}

export function readExecutionChoice(value: unknown): ExecutionChoice | undefined {
  return parseExecutionChoice(value);
}

export function executionSelectionOf(choice: ExecutionChoice): ExecutionSelection {
  return { executor: choice.executor, profile: choice.profile, profile_file: choice.profile_file, overrides: choice.overrides };
}

export function namesLegacyControl(choice: ExecutionChoice | undefined, control: 'model' | 'thinking' | 'permission_mode'): boolean {
  const overrides = choice?.overrides;
  return overrides !== undefined && Object.hasOwn(overrides, control);
}

export function sendsLegacyControl(choice: ExecutionChoice | undefined, control: 'model' | 'thinking' | 'permission_mode', touched: boolean): boolean {
  if (namesLegacyControl(choice, control)) return false;
  if (touched) return true;
  return choice === undefined || isNativeExecutor(choice.executor) || choice.profile !== undefined;
}

export function isBareExternalChoice(choice: ExecutionChoice | undefined): boolean {
  return choice !== undefined && !isNativeExecutor(choice.executor) && choice.profile === undefined
    && choice.profile_file === undefined && choice.external_connection_id === undefined && choice.overrides === undefined;
}

export function sameExecutionChoice(left: ExecutionChoice | undefined, right: ExecutionChoice | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.executor === right.executor && left.profile === right.profile && left.profile_file === right.profile_file
    && left.external_connection_id === right.external_connection_id && sameOverrides(left.overrides, right.overrides);
}

function sameOverrides(left: ExecutionOverrides | undefined, right: ExecutionOverrides | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return isEmptyOverrides(left) && isEmptyOverrides(right);
  if (isEmptyOverrides(left) || isEmptyOverrides(right)) return isEmptyOverrides(left) && isEmptyOverrides(right);
  return left.model === right.model && left.thinking === right.thinking && left.permission_mode === right.permission_mode
    && left.allow_kiki_subagents === right.allow_kiki_subagents && sameContext(left.kiki_context, right.kiki_context);
}

function isEmptyOverrides(value: ExecutionOverrides | undefined): boolean {
  return value === undefined || Object.values(value).every((entry) => entry === undefined);
}

function sameContext(left: readonly ExecutionContextGroup[] | null | undefined, right: readonly ExecutionContextGroup[] | null | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  return left.length === right.length && left.every((group, index) => group === right[index]);
}

export function boundExecutionChoice(binding: ExecutionBinding | undefined, fallbackProfile?: string): ExecutionChoice {
  if (binding !== undefined) return executionChoice(binding.selection);
  if (fallbackProfile !== undefined && fallbackProfile !== '') return { executor: NATIVE_EXECUTOR, profile: fallbackProfile, profile_file: undefined, overrides: undefined };
  return NATIVE_CHOICE;
}

export function profilesForExecutor(profiles: readonly NamedAgentProfile[], executor: string, pickable: (profile: NamedAgentProfile) => boolean): NamedAgentProfile[] {
  return profiles.filter((profile) => pickable(profile) && profileExecutor(profile) === executor);
}

export function profileMatchesExecutor(profile: NamedAgentProfile | undefined, executor: string): boolean {
  return profile === undefined || profileExecutor(profile) === executor;
}

export type ExecutionValueSource = ExecutionBinding['sources'][string];

export function executionSource(binding: ExecutionBinding | undefined, field: keyof ExecutionBinding['effective']): ExecutionValueSource | undefined {
  return binding?.sources[field];
}

export function overrideFor<K extends keyof ExecutionOverrides>(field: K, value: ExecutionOverrides[K] | undefined): Pick<ExecutionOverrides, K> | Record<string, never> {
  return value === undefined ? {} : { [field]: value } as Pick<ExecutionOverrides, K>;
}
