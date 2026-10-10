/**
 * The model page's own prompt-group draft.
 *
 * The two prompt objects are whole objects with a branch per identity, and the
 * engine reads four states apart: a branch is absent, explicitly `same`,
 * explicitly `off`, or its own content. This draft therefore keeps each branch
 * in the state the manifest actually used rather than normalizing it into a
 * mode: turning `same` into "absent" and back would write on an edit round trip
 * that changed nothing, and the server would see a change nobody made.
 *
 * The patch it produces is sparse per branch, built from the original object.
 * Rebuilding the whole object from the draft would drop a branch the person did
 * not open, including an explicit `same`, an empty array and a `false` field —
 * all of which the engine distinguishes from "not set".
 */

import type { ModelEntity } from '@kiki/protocol';

import {
  cognitionBody, cognitionDraft, promptOverridesBody, promptOverridesDraft,
  type CognitionDraft, type PromptOverridesDraft,
} from './promptIdentityDraft';

/** One identity branch: absent stays absent until somebody chooses a mode. */
export type BranchState<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'same' }
  | { readonly kind: 'off' }
  | { readonly kind: 'custom'; readonly content: T };

export interface PromptGroupDraft<T> {
  /** What is at the shared level of the object. */
  readonly common: T;
  readonly main: BranchState<T>;
  readonly independent: BranchState<T>;
}

export interface ModelPromptsDraft {
  cognition: PromptGroupDraft<CognitionDraft>;
  fields: PromptGroupDraft<PromptOverridesDraft>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const branchOf = <T>(raw: unknown, read: (value: unknown) => T): BranchState<T> => {
  if (raw === undefined) return { kind: 'absent' };
  if (raw === 'same') return { kind: 'same' };
  if (raw === 'off') return { kind: 'off' };
  return { kind: 'custom', content: read(raw) };
};

export function modelPromptsDraft(entity: ModelEntity): ModelPromptsDraft {
  const cognition = record(entity.cognition);
  const fields = record(entity.prompt_overrides);
  return {
    cognition: {
      common: cognitionDraft(cognition),
      main: branchOf(cognition['main'], cognitionDraft),
      independent: branchOf(cognition['independent'], cognitionDraft),
    },
    fields: {
      common: promptOverridesDraft(fields),
      main: branchOf(fields['main'], promptOverridesDraft),
      independent: branchOf(fields['independent'], promptOverridesDraft),
    },
  };
}


/** Structural equality, so an untouched draft is never reported as dirty. */
export function modelPromptsEqual(a: ModelPromptsDraft, b: ModelPromptsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The sparse patch for one prompt object.
 *
 * Returns `undefined` for an object nobody touched, so the surrounding patch
 * stays small and a model with no prompt configuration is not rewritten. When
 * something did change, the untouched branches are carried over verbatim from
 * the stored object rather than rebuilt from the draft.
 */
export function modelPromptsPatch(
  entity: ModelEntity,
  draft: ModelPromptsDraft,
  baseline: ModelPromptsDraft,
): { cognition?: Record<string, unknown>; prompt_overrides?: Record<string, unknown> } {
  const patch: { cognition?: Record<string, unknown>; prompt_overrides?: Record<string, unknown> } = {};
  if (!sameBranch(draft.cognition, baseline.cognition)) {
    patch.cognition = branchPatch(record(entity.cognition), draft.cognition, baseline.cognition, cognitionBody);
  }
  if (!sameBranch(draft.fields, baseline.fields)) {
    patch.prompt_overrides = branchPatch(record(entity.prompt_overrides), draft.fields, baseline.fields, promptOverridesBody);
  }
  return patch;
}

const sameBranch = <T>(a: PromptGroupDraft<T>, b: PromptGroupDraft<T>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function branchPatch<T>(
  base: Record<string, unknown>,
  draft: PromptGroupDraft<T>,
  baseline: PromptGroupDraft<T>,
  write: (value: T) => Record<string, unknown>,
): Record<string, unknown> {
  const next = contentPatch(base, write(draft.common), write(baseline.common));
  for (const position of ['main', 'independent'] as const) {
    const branch = draft[position];
    const before = baseline[position];
    if (JSON.stringify(branch) === JSON.stringify(before)) continue;
    if (branch.kind === 'absent') delete next[position];
    else if (branch.kind === 'same' || branch.kind === 'off') next[position] = branch.kind;
    else {
      // Changing selection replaces this identity; editing a field within an
      // existing custom branch touches only that field on the chosen base.
      next[position] = before.kind === 'custom'
        ? contentPatch(record(base[position]), write(branch.content), write(before.content))
        : definedContent(write(branch.content));
    }
  }
  return next;
}

const definedContent = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, content]) => content !== undefined));

/** Slots are atomic; the named prompt fields alone have individual edit intent. */
function contentPatch(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(draft)])) {
    if (JSON.stringify(draft[key]) === JSON.stringify(baseline[key])) continue;
    if (key === 'fields') {
      const fields = { ...record(base[key]) };
      const before = record(baseline[key]);
      const after = record(draft[key]);
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (after[name] === before[name]) continue;
        if (after[name] === undefined) delete fields[name];
        else fields[name] = after[name];
      }
      if (Object.keys(fields).length === 0) delete next[key];
      else next[key] = fields;
    } else if (draft[key] === undefined) delete next[key];
    else next[key] = draft[key];
  }
  return next;
}

/** Steer cadence for one identity, with the engine defaults kept distinct. */
export interface CadenceDraft {
  onTurn: boolean;
  onInput: boolean;
  intervalSteps: string;
}

export const DEFAULT_CADENCE: CadenceDraft = { onTurn: true, onInput: true, intervalSteps: '0' };

export function cadenceFromCognition(draft: CognitionDraft | undefined): CadenceDraft {
  if (draft === undefined) return DEFAULT_CADENCE;
  return { ...DEFAULT_CADENCE };
}

/** Whether the cadence row is showing engine defaults rather than saved values. */
export function cadenceIsDefault(draft: CognitionDraft | undefined): boolean {
  return draft === undefined;
}

/** The identity layer a scope addresses; shared values live at the model root. */
export function positionOf(scope: 'shared' | 'main' | 'independent'): 'main' | 'independent' | undefined {
  return scope === 'shared' ? undefined : scope;
}
/**
 * What an identity's prompt group is doing, as the editor shows it.
 *
 * `common` means the shared group, either edited in place at the shared scope
 * or followed by an absent/`same` identity branch. `off` is a real switch-off
 * and hides the prose; `custom` replaces the whole object for that identity.
 */
export function branchSelectionFor(
  scope: 'shared' | 'main' | 'independent',
  draft: ModelPromptsDraft | null,
): 'common' | 'custom' | 'off' {
  if (scope === 'shared' || draft === null) return 'common';
  const branch = draft.cognition[scope];
  return branch.kind === 'off' ? 'off' : branch.kind === 'custom' ? 'custom' : 'common';
}
