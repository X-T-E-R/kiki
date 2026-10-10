/**
 * The model page's prompt prose, read from the engine's own projection.
 *
 * `cognition_bodies` is the authority on what a slot actually contains and
 * where that text came from. The GUI does not decide between "a file reference"
 * and "text stored on the model" by reading `cognition` itself: a slot may hold
 * a path, an array of paths, or inline text, and only the engine's projection
 * knows which text those currently resolve to.
 *
 * The one behaviour worth being explicit about is conversion. A slot backed by
 * files is read-only here — its prose is shown, selectable and copyable, and the
 * file paths are shown so the original can be restored. Saving from a file-backed
 * slot writes the text into the model and leaves the file alone; it never writes
 * the file. That conversion happens when the person saves, never when they look,
 * switch identity, or choose a Recipe.
 */

import type { ModelCognitionBodies, ModelEntity } from '@kiki/protocol';

import type { EditScope } from './modelEditScope';

export const COGNITION_SLOTS = ['overlay', 'steering', 'anchor'] as const;
export type CognitionSlot = (typeof COGNITION_SLOTS)[number];

type Branch = ModelCognitionBodies['branches']['common'];
type Slot = Branch['slots'][CognitionSlot];

export interface SlotView {
  readonly slot: CognitionSlot;
  /** `inline` and `unset` are editable here; `files` is not. */
  readonly source: Slot['source'];
  readonly text: string;
  readonly files: readonly { path: string; text: string }[];
  readonly writable: boolean;
  readonly sourceReadOnly: boolean;
  readonly error: string | undefined;
}

/** The branch key a scope reads. Shared maps to `common`. */
export function branchKeyFor(scope: EditScope): 'common' | 'main' | 'independent' {
  return scope === 'shared' ? 'common' : scope;
}

/** One slot's view for a scope, or undefined when the engine sent none. */
export function slotView(bodies: ModelCognitionBodies | undefined, scope: EditScope, slot: CognitionSlot): SlotView | undefined {
  if (bodies === undefined) return undefined;
  const branch = bodies.branches[branchKeyFor(scope)];
  if (branch === undefined) return undefined;
  // `off` carries no slots at all; an empty projection is not an empty prompt.
  if (branch.selection === 'off') return undefined;
  const entry: Slot | undefined = branch.slots[slot];
  if (entry === undefined) return undefined;
  return {
    slot,
    source: entry.source,
    text: entry.text ?? '',
    files: entry.files ?? [],
    writable: entry.writable,
    sourceReadOnly: entry.source_read_only,
    error: entry.error,
  };
}

/**
 * Whether saving this slot would turn file-backed prose into model-owned text.
 *
 * Shown next to the control before the save, because it is irreversible from
 * this page: after the save the slot no longer refers to the file, and the only
 * way back is to configure the original reference again.
 */
export function savesAsInlineText(view: SlotView): boolean {
  return view.source === 'files';
}

/** A file reference a person can paste back in to undo the conversion. */
export function restoreHint(view: SlotView): string | undefined {
  return view.files.length === 0 ? undefined : view.files.map((file) => file.path).join('\n');
}

/**
 * The patch for one slot, written from the stored object.
 *
 * `inline` writes `{text}`, which is a real value including the empty string: an
 * empty body means "this model says nothing here", not "fall back to something
 * else". `unset` removes the key, which is the one way to ask for the fallback.
 */
export function cognitionSlotPatch(entity: ModelEntity, group: 'cognition', slot: CognitionSlot, text: string | undefined): Record<string, unknown> {
  const stored = entity.cognition === undefined || entity.cognition === null
    ? {}
    : { ...(entity.cognition as Record<string, unknown>) };
  if (text === undefined) delete stored[slot];
  else stored[slot] = { text };
  return { cognition: stored };
}

/**
 * The same write, addressed at the identity that is on screen.
 *
 * `shared` is the model's own declaration and sits at the root of the object.
 * An identity scope is a whole object for that identity, so the slot is written
 * inside the branch: the branch is a *replacement*, so it must already contain
 * the sibling slots it had, or saving one slot would drop the others.
 *
 * Every change is applied to the object read from the server, never rebuilt from
 * the branch currently on screen, so two slots saved in one transaction both
 * survive and an untouched branch keeps its `same` or `off`.
 */
export function cognitionSlotPatchAtScope(
  entity: ModelEntity,
  scope: EditScope,
  slot: CognitionSlot,
  text: string | undefined,
): { cognition: Record<string, unknown> } {
  const stored = entity.cognition === undefined || entity.cognition === null
    ? {}
    : { ...(entity.cognition as Record<string, unknown>) };
  if (scope === 'shared') {
    if (text === undefined) delete stored[slot];
    else stored[slot] = { text };
    return { cognition: stored };
  }
  const next = cognitionContentAtScope(entity, scope);
  if (text === undefined) delete next[slot];
  else next[slot] = { text };
  stored[scope] = next;
  return { cognition: stored };
}

/** Raw effective group for an identity, preserving references rather than resolved prose. */
export function cognitionContentAtScope(entity: ModelEntity, scope: EditScope): Record<string, unknown> {
  const stored: Record<string, unknown> = entity.cognition ?? {};
  const branch = scope === 'shared' ? undefined : stored[scope];
  if (branch === 'off') return {};
  if (typeof branch === 'object' && branch !== null && !Array.isArray(branch)) return { ...branch };
  const { main: _main, independent: _independent, ...common } = stored;
  return common;
}

/** The body text a slot should open with, preferring what the engine resolved. */
export function initialSlotText(view: SlotView | undefined): string {
  return view?.text ?? '';
}