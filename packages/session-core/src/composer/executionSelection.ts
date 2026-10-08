/**
 * Execution selection: which engine runs the session's main agent, and which
 * profile of that engine when the user wants Kiki's profile layer.
 *
 * The wire already separates three layers (session override > profile > engine
 * settings > engine default), and the three "unset" forms are not the same
 * thing: an absent key inherits, `null` falls through to the next layer, and
 * `[]` / `false` explicitly turn a capability off. This module keeps those
 * three apart on the way out, and never turns a value the server resolved back
 * into an override.
 */

import { executionSelectionSchema } from '@kiki/protocol';
import type {
  ExecutionBinding,
  ExecutionOverrides,
  ExecutionSelection,
  NamedAgentProfile,
} from '@kiki/protocol';

/** One `kiki_context` group name, as the wire's list spells it. */
export type ExecutionContextGroup = NonNullable<ExecutionOverrides['kiki_context']>[number];

/** The native engine's executor id, as the catalog and the wire both spell it. */
export const NATIVE_EXECUTOR = 'native';

/** `executor` on a profile; `''` and `'native'` both mean the native engine. */
export function profileExecutor(profile: Pick<NamedAgentProfile, 'executor'>): string {
  const executor = profile.executor;
  return executor === undefined || executor === '' ? NATIVE_EXECUTOR : executor;
}

export function isNativeExecutor(executor: string | undefined): boolean {
  return executor === undefined || executor === '' || executor === NATIVE_EXECUTOR;
}

/**
 * The composer's selection, in the two forms callers need: the wire value to
 * send, and the display pair the chip reads. `overrides` is absent until the
 * user actually sets one, so an untouched pick sends a bare selection.
 */
export interface ExecutionChoice {
  readonly executor: string;
  /** Absent = run the harness with its own configuration. */
  readonly profile: string | undefined;
  /**
   * A profile Markdown file chosen directly on the connected host, instead of a
   * registered profile name. The two are mutually exclusive on the wire: a file
   * is loaded and projected as its own profile, the registry is never rewritten,
   * and a file whose declared name matches a registered profile does not replace
   * it. A session that carries a file keeps carrying it — dropping it would
   * silently turn a profiled run into a bare harness.
   */
  /** Optional for callers that still construct legacy choices by hand. */
  readonly profile_file?: string;
  /** Absent = every override inherits. */
  readonly overrides: ExecutionOverrides | undefined;
}

export const NATIVE_CHOICE: ExecutionChoice = {
  executor: NATIVE_EXECUTOR,
  profile: undefined,
  profile_file: undefined,
  overrides: undefined,
};

export function executionChoice(selection: ExecutionSelection | undefined): ExecutionChoice {
  if (selection === undefined) return NATIVE_CHOICE;
  return {
    executor: selection.executor,
    profile: selection.profile,
    profile_file: selection.profile_file,
    overrides: selection.overrides,
  };
}

/**
 * What to call a profile file in a control that has one line: its own file name.
 * The path itself stays available as the row's detail, so a reader who picked
 * `/home/dev/profiles/research.md` sees `research.md` and the path beside it.
 */
export function profileFileLabel(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name === '' ? path : name;
}

/** Recover a saved selection without interpreting an invalid or unknown record as native. */
export function readExecutionChoice(value: unknown): ExecutionChoice | undefined {
  const parsed = executionSelectionSchema.safeParse(value);
  return parsed.success ? executionChoice(parsed.data) : undefined;
}

/** The wire value, with the untouched fields left absent rather than `null`. */
export function executionSelectionOf(choice: ExecutionChoice): ExecutionSelection {
  return {
    executor: choice.executor,
    ...(choice.profile === undefined ? {} : { profile: choice.profile }),
    ...(choice.profile_file === undefined ? {} : { profile_file: choice.profile_file }),
    ...(choice.overrides === undefined ? {} : { overrides: choice.overrides }),
  };
}

/**
 * Whether one legacy top-level control may ride along on this request.
 *
 * On the execution path `model`, `thinking` and `permission_mode` are session
 * overrides, so a value the user never chose would have Kiki's own default
 * decide for a harness whose configuration they explicitly asked to keep. The
 * test is therefore **per control**: a run is bare for a control when the
 * engine is external, no Kiki profile is selected, and that control has no
 * matching `overrides` key. An `overrides` object naming `model` and `thinking`
 * still leaves `permission_mode` to the harness — the two are separate choices.
 *
 * A `null` in `overrides` is an explicit instruction to fall through to the
 * next layer, not a licence to send the displayed default back. So the test is
 * **key presence**, and a present key means the execution selection owns that
 * control outright: the caller sends no legacy field for it at all, whether
 * its value is a real id or `null`.
 *
 * A profile *file* is deliberately not one of the "a Kiki profile supplies it"
 * cases: this process has not resolved that file, so it cannot know which model
 * or effort the file declares, and promoting the value the page happens to
 * display would invent an override the user never made. The file's own
 * configuration owns the untouched controls; a control the user really moved is
 * still sent, which is the third case below.
 */
export function namesLegacyControl(choice: ExecutionChoice | undefined, control: 'model' | 'thinking' | 'permission_mode'): boolean {
  const overrides = choice?.overrides;
  return overrides !== undefined && Object.hasOwn(overrides, control);
}

/**
 * Whether the legacy top-level field for `control` may be sent at all.
 *
 * Three cases, in order:
 * - The selection names the control in `overrides` → the execution owns it, so
 *   nothing is sent. This covers the `null` "fall through" form as well.
 * - The user moved the control → their choice is sent, so an explicit
 *   `permission_mode` on a bare harness still reaches the engine.
 * - Otherwise a bare external engine is being run as it is, and Kiki's default
 *   must not be promoted into a session override on the user's behalf.
 */
export function sendsLegacyControl(
  choice: ExecutionChoice | undefined,
  control: 'model' | 'thinking' | 'permission_mode',
  touched: boolean,
): boolean {
  if (namesLegacyControl(choice, control)) return false;
  if (touched) return true;
  return choice === undefined || isNativeExecutor(choice.executor) || choice.profile !== undefined;
}

/** A selection that asks for the harness as it is: external, no profile, no overrides at all. */
export function isBareExternalChoice(choice: ExecutionChoice | undefined): boolean {
  return choice !== undefined
    && !isNativeExecutor(choice.executor)
    && choice.profile === undefined
    && choice.profile_file === undefined
    && choice.overrides === undefined;
}

/** Two picks are the same request when the engine, profile and every override match. */
export function sameExecutionChoice(left: ExecutionChoice | undefined, right: ExecutionChoice | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.executor === right.executor
    && left.profile === right.profile
    && left.profile_file === right.profile_file
    && sameOverrides(left.overrides, right.overrides);
}

function sameOverrides(left: ExecutionOverrides | undefined, right: ExecutionOverrides | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return isEmptyOverrides(left) && isEmptyOverrides(right);
  // An overrides object that names nothing is not a request: it is the same
  // binding as carrying none, so a re-render cannot invent a pending switch.
  if (isEmptyOverrides(left) || isEmptyOverrides(right)) return isEmptyOverrides(left) && isEmptyOverrides(right);
  return left.model === right.model
    && left.thinking === right.thinking
    && left.permission_mode === right.permission_mode
    && left.allow_kiki_subagents === right.allow_kiki_subagents
    && sameContext(left.kiki_context, right.kiki_context);
}

function isEmptyOverrides(value: ExecutionOverrides | undefined): boolean {
  if (value === undefined) return true;
  return Object.values(value).every((entry) => entry === undefined);
}

function sameContext(left: readonly ExecutionContextGroup[] | null | undefined, right: readonly ExecutionContextGroup[] | null | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  return left.length === right.length && left.every((group, index) => group === right[index]);
}

/**
 * The choice a session is actually running, read off its committed binding.
 * A server without the `execution` projection reports the legacy top-level
 * `profile`, which is a native main profile.
 */
export function boundExecutionChoice(binding: ExecutionBinding | undefined, fallbackProfile?: string): ExecutionChoice {
  if (binding !== undefined) return executionChoice(binding.selection);
  if (fallbackProfile !== undefined && fallbackProfile !== '') {
    return { executor: NATIVE_EXECUTOR, profile: fallbackProfile, profile_file: undefined, overrides: undefined };
  }
  return NATIVE_CHOICE;
}

/**
 * Main profiles for one engine. The empty row (`profile: undefined`) is added
 * by the caller: it is the bare-harness execution, not a profile.
 */
export function profilesForExecutor(
  profiles: readonly NamedAgentProfile[],
  executor: string,
  pickable: (profile: NamedAgentProfile) => boolean,
): NamedAgentProfile[] {
  return profiles.filter((profile) => pickable(profile) && profileExecutor(profile) === executor);
}

/** A selected profile that belongs to another engine is not a legal selection. */
export function profileMatchesExecutor(profile: NamedAgentProfile | undefined, executor: string): boolean {
  return profile === undefined || profileExecutor(profile) === executor;
}

/** Where one resolved value came from, in words a reader can act on. */
export type ExecutionValueSource = ExecutionBinding['sources'][string];

export function executionSource(
  binding: ExecutionBinding | undefined,
  field: keyof ExecutionBinding['effective'],
): ExecutionValueSource | undefined {
  return binding?.sources[field];
}

/**
 * The override value to write for `field`, given the user's current intent.
 * `undefined` means "do not send this key": an untouched value stays inherited,
 * and a value the server already resolved is never echoed back as an override.
 */
export function overrideFor<K extends keyof ExecutionOverrides>(
  field: K,
  value: ExecutionOverrides[K] | undefined,
): Pick<ExecutionOverrides, K> | Record<string, never> {
  return value === undefined ? {} : { [field]: value } as Pick<ExecutionOverrides, K>;
}
