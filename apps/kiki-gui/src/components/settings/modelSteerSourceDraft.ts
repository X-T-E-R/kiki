/**
 * The model page's per-source steer draft.
 *
 * The steering a user message gets is the basic configuration and lives in the
 * model page's existing cognition fields. Everything else that can start a turn
 * — another thread, a discussion room, a subagent, a background task, a cron
 * run, a hook result, an automatic continuation, an activated skill, an external
 * client — is one of nine fixed sources, each with its own answer.
 *
 * Three rules are load-bearing and are what this module exists to protect:
 *
 *   - **A source is a mode plus a private draft.** `off` and `inherit` are
 *     decisions about *this run*; the words a person typed under `custom` are
 *     their own configuration and survive switching away. Dropping them on an
 *     `off` round trip would make a source impossible to set up in two steps.
 *   - **`inherit` is a live statement, not a copy.** It resolves against the
 *     user's setting at the model / Recipe / profile layer whenever a new
 *     binding is made. Writing the current user value into the source would
 *     freeze it and quietly stop being an inheritance.
 *   - **A source with no words says nothing.** `custom` with an empty body is
 *     empty, never the user's body. Falling back would make a source
 *     indistinguishable from `inherit` while claiming to be a separate setting.
 *
 * The two layers are separate. `common` / `main` / `independent` say which
 * identity's steer object is on screen; a mode says what one source does inside
 * it. A branch that is still following the shared object cannot hold a source
 * decision of its own, so writing one there is what makes that branch a custom
 * branch — a change with a real effect on the model, not a UI state.
 */

import {
  modelSteeringSourceIds,
  type ModelEntity,
  type ModelSteeringSource,
  type ModelSteeringSourceMode,
} from '@kiki/protocol';

import type { EditScope } from './modelEditScope';

/** The three levels a steer declaration can sit at. */
export type SteerScope = 'common' | 'main' | 'independent';

export const STEER_SCOPES: readonly SteerScope[] = ['common', 'main', 'independent'] as const;

export const STEER_SOURCES: readonly ModelSteeringSource[] = modelSteeringSourceIds;

/** The one scope each edit scope reads and writes. */
export function steerScopeFor(scope: EditScope): SteerScope {
  return scope === 'shared' ? 'common' : scope;
}

/** Steer timing for one source, as the person left it. */
export interface SteerCadenceDraft {
  onTurn: boolean;
  onInput: boolean;
  intervalSteps: string;
}

/** What a custom source holds: its own words, and when they are delivered. */
export interface SteerCustomDraft {
  readonly text: string;
  readonly cadence: SteerCadenceDraft;
}

const EMPTY_CUSTOM: SteerCustomDraft = {
  text: '',
  cadence: { onTurn: true, onInput: true, intervalSteps: '0' },
};

/** One source's answer, with the draft kept whatever the mode is. */
export interface SteerSourceDraft {
  readonly mode: ModelSteeringSourceMode;
  /**
   * Kept for every mode, including one this person has never set. A draft that
   * only existed while `custom` was selected would be destroyed by the
   * `custom` -> `off` -> `custom` round trip the interface invites.
   */
  readonly custom: SteerCustomDraft;
}

export interface ModelSteerSourcesDraft {
  readonly common: Readonly<Record<string, SteerSourceDraft>>;
  readonly main: Readonly<Record<string, SteerSourceDraft>>;
  readonly independent: Readonly<Record<string, SteerSourceDraft>>;
}

export type SteerScopeDraft = Readonly<Record<string, SteerSourceDraft>>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const isMode = (value: unknown): value is ModelSteeringSourceMode =>
  value === 'off' || value === 'inherit' || value === 'custom';

/**
 * Read one source's stored body.
 *
 * A custom body is the same union the model itself stores: text stored on the
 * model, a path the engine resolves, or an array of them. A path is shown as
 * its own text here rather than resolved, because the engine's
 * `cognition_bodies` projection is what knows the current content of a file,
 * and this draft is only the words on their way there.
 */
function readCustomText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}

/** Whether a stored custom body refers to a file rather than to model text. */
export function customIsFileBacked(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body['file'] === 'string' || Array.isArray(body['files']) || Array.isArray(body['text']);
}

const readCadence = (value: Record<string, unknown>, custom: SteerCustomDraft | undefined): SteerCadenceDraft => {
  const fallback = custom?.cadence ?? EMPTY_CUSTOM.cadence;
  const interval = value['steering_interval_steps'];
  return {
    onTurn: typeof value['steering_on_turn'] === 'boolean' ? value['steering_on_turn'] : fallback.onTurn,
    onInput: typeof value['steering_on_input'] === 'boolean' ? value['steering_on_input'] : fallback.onInput,
    intervalSteps: typeof interval === 'number' ? String(interval) : fallback.intervalSteps,
  };
};

function readSource(value: unknown): SteerSourceDraft {
  if (typeof value !== 'object' || value === null) return { mode: 'off', custom: EMPTY_CUSTOM };
  const entry = value as Record<string, unknown>;
  const custom = entry['custom'];
  const customEntry = typeof custom === 'object' && custom !== null && !Array.isArray(custom)
    ? custom as Record<string, unknown>
    : undefined;
  return {
    mode: isMode(entry['mode']) ? entry['mode'] : 'off',
    custom: customEntry === undefined
      ? EMPTY_CUSTOM
      : { text: readCustomText(customEntry['steering']), cadence: readCadence(customEntry, undefined) },
  };
}

function readScope(value: unknown): SteerScopeDraft {
  const stored = record(value);
  const draft: Record<string, SteerSourceDraft> = {};
  for (const source of STEER_SOURCES) {
    // A source nobody declared is off, and the editor shows it as such without
    // writing a declaration the source never had.
    draft[source] = source in stored ? readSource(stored[source]) : { mode: 'off', custom: EMPTY_CUSTOM };
  }
  return draft;
}

/** Read all three levels off the model's own steer declaration. */
export function modelSteerSourcesDraft(entity: ModelEntity): ModelSteerSourcesDraft {
  const cognition = record(entity.cognition);
  return {
    common: readScope(cognition['steering_sources']),
    main: readScope(record(cognition['main'])['steering_sources']),
    independent: readScope(record(cognition['independent'])['steering_sources']),
  };
}

export function steerSourcesEqual(a: ModelSteerSourcesDraft | null, b: ModelSteerSourcesDraft | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether one level changed, so an untouched identity never enters the patch. */
function steerScopeEqual(a: SteerScopeDraft, b: SteerScopeDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The draft a source opens with, so a row never reads as an unstored gap. */
export function steerSourceDraft(draft: ModelSteerSourcesDraft | null, scope: SteerScope, source: ModelSteeringSource): SteerSourceDraft {
  return draft?.[scope][source] ?? { mode: 'off', custom: EMPTY_CUSTOM };
}

/** The draft for one scope on its own, for readers that hold a single level. */
export function steerScopeDraft(draft: ModelSteerSourcesDraft, scope: SteerScope): SteerScopeDraft {
  return draft[scope];
}

/**
 * Choose a mode, keeping the custom draft.
 *
 * Moving to `custom` with nothing written yet starts from the stored draft,
 * which for a source that has one is the words already there — so switching
 * modes never loses work and never invents any.
 */
export function withSteerMode(draft: SteerSourceDraft, mode: ModelSteeringSourceMode): SteerSourceDraft {
  return mode === draft.mode ? draft : { mode, custom: draft.custom };
}

export function withSteerCustomText(draft: SteerSourceDraft, text: string): SteerSourceDraft {
  return { ...draft, custom: { ...draft.custom, text } };
}

export function withSteerCadence(draft: SteerSourceDraft, cadence: SteerCadenceDraft): SteerSourceDraft {
  return { ...draft, custom: { ...draft.custom, cadence } };
}

/** A cadence field a person can get wrong before it reaches the model. */
export function steerCadenceProblem(intervalSteps: string): string | undefined {
  if (intervalSteps.trim() === '') return 'empty';
  if (!/^\d+$/.test(intervalSteps.trim())) return 'count';
  const value = Number(intervalSteps);
  if (!Number.isSafeInteger(value)) return 'count';
  return undefined;
}

/**
 * The wire entry for one source, or `undefined` when nothing about it changed.
 *
 * `custom` carries only the fields that differ from the baseline, because the
 * server merges a source entry field by field: sending the whole object would
 * replace a stored value a person never touched this save.
 *
 * A mode switch sends the mode alone when the custom draft did not also change.
 * When both changed — the `off` -> `custom` that writes words for the first
 * time — the differing fields ride along with it, or the words would be typed
 * and never stored.
 */
function sourcePatch(
  draft: SteerSourceDraft,
  baseline: SteerSourceDraft | undefined,
): { mode: ModelSteeringSourceMode; custom?: Record<string, unknown> } | undefined {
  const before = baseline ?? { mode: 'off' as ModelSteeringSourceMode, custom: EMPTY_CUSTOM };
  const custom: Record<string, unknown> = {};
  if (draft.custom.text !== before.custom.text) custom['steering'] = { text: draft.custom.text };
  if (draft.custom.cadence.onTurn !== before.custom.cadence.onTurn) custom['steering_on_turn'] = draft.custom.cadence.onTurn;
  if (draft.custom.cadence.onInput !== before.custom.cadence.onInput) custom['steering_on_input'] = draft.custom.cadence.onInput;
  if (draft.custom.cadence.intervalSteps !== before.custom.cadence.intervalSteps) {
    custom['steering_interval_steps'] = Number(draft.custom.cadence.intervalSteps);
  }
  if (draft.mode === before.mode) {
    return Object.keys(custom).length === 0 ? undefined : { mode: draft.mode, custom };
  }
  return Object.keys(custom).length === 0 ? { mode: draft.mode } : { mode: draft.mode, custom };
}

function scopePatch(draft: SteerScopeDraft, baseline: SteerScopeDraft): Record<string, unknown> | undefined {
  const entries: Record<string, unknown> = {};
  for (const source of STEER_SOURCES) {
    const patch = sourcePatch(draft[source] ?? { mode: 'off', custom: EMPTY_CUSTOM }, baseline[source]);
    if (patch !== undefined) entries[source] = patch;
  }
  return Object.keys(entries).length === 0 ? undefined : entries;
}

export type SteerSourcesPatch = { [scope in SteerScope]?: Record<string, unknown> | null };

/**
 * The source declarations to send, or `undefined` when nothing changed.
 *
 * Returned as its own patch field rather than merged into `cognition`: it is a
 * field-level write with its own merge, and a source edit that also happens to
 * touch an identity's prose must not have one shadow the other. Both travel in
 * the same transaction and under the same `base_revision`.
 */
export function steerSourcesPatch(
  draft: ModelSteerSourcesDraft,
  baseline: ModelSteerSourcesDraft,
): SteerSourcesPatch | undefined {
  const patch: SteerSourcesPatch = {};
  for (const scope of STEER_SCOPES) {
    if (steerScopeEqual(draft[scope], baseline[scope])) continue;
    const value = scopePatch(draft[scope], baseline[scope]);
    if (value !== undefined) patch[scope] = value;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}
