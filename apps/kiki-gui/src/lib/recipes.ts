/**
 * GUI-side Recipe access.
 *
 * Every Recipe type and every call shape belongs to the shared protocol and
 * the shared `global.recipes` facade; this module only re-exports the names the
 * settings surfaces use and adds the few reads the GUI derives locally. It
 * deliberately defines no Recipe DTO of its own, so a contract change lands
 * here as a type error rather than as a second, drifting shape.
 */

import type {
  ModelEntity,
  RecipeDetail,
  RecipeDiagnostic,
  RecipeMarket,
  RecipePreview,
  RecipeScriptHook,
  RecipeSummary,
  RecipeUpdateMode,
  RecipeValueOrigin,
  ResolvedRecipe,
  ResolvedRecipeBranch,
} from '@kiki/protocol';

export type {
  RecipeDetail,
  RecipeDiagnostic,
  RecipeMarket,
  RecipePreview,
  RecipeScriptHook,
  RecipeSummary,
  RecipeUpdateMode,
  RecipeValueOrigin,
  ResolvedRecipe,
  ResolvedRecipeBranch,
};

/**
 * The script-hook projection a preview carries.
 *
 * Derived from `RecipePreview` rather than imported under a name of its own: the
 * contract exports the hook schema and the preview that embeds it, and a second
 * exported alias for the same shape would be a second thing to keep in step.
 */
export type RecipeHookPreview = NonNullable<RecipePreview['hooks']>;
/** One script inside that projection, as the confirmation has to render it. */
export type RecipeScriptPreview = RecipeHookPreview['scripts'][number];

/** The three identity branches a resolved Recipe can speak for. */
export const RECIPE_POSITIONS = ['main', 'sub', 'independent'] as const;
export type RecipePosition = (typeof RECIPE_POSITIONS)[number];

/** The prompt slots a branch can carry; `anchor` is optional on every one. */
export const RECIPE_SLOTS = ['system', 'steering', 'anchor'] as const;
export type RecipeSlot = (typeof RECIPE_SLOTS)[number];

/**
 * A short, readable form of a content revision. The full digest stays in the
 * drawer; a 12-hex prefix is enough to recognise "the same revision" in a
 * summary row without wrapping the line.
 */
export function recipeRevisionShort(revision: string): string {
  const digest = revision.startsWith('sha256:') ? revision.slice('sha256:'.length) : revision;
  return digest.length > 12 ? digest.slice(0, 12) : digest;
}

/**
 * Whether a Recipe can be bound right now. `ready + last_error` is usable: a
 * failed update check leaves the accepted copy intact, so it must stay offered
 * instead of reading as "unavailable".
 */
export function recipeIsSelectable(summary: RecipeSummary): boolean {
  return summary.health === 'ready';
}

/** Whether the row should surface an update hint or a stored failure. */
export function recipeNeedsAttention(summary: RecipeSummary): boolean {
  return summary.update_available === true || summary.last_error !== undefined;
}

/**
 * Count the model-level prompt items a bound Recipe keeps out of assembly
 * without deleting them. Only counts what is actually saved, so an untouched
 * model does not claim to be hiding something.
 *
 * Takes a `ModelEntity` directly: these keys are snake_case on the wire, and
 * naming them here by hand is how a caller ends up reading a key that is
 * always absent.
 */
export function recipeKeptManualPromptCount(entity: Pick<ModelEntity, 'cognition' | 'prompt_overrides'>): number {
  const filled = (value: unknown) =>
    value === undefined || value === null ? 0
      : typeof value === 'object' && Object.keys(value).length > 0 ? 1 : 0;
  return filled(entity.cognition) + filled(entity.prompt_overrides);
}

/** Find the per-slot provenance the resolver recorded, if it recorded one. */
export function recipeOriginFor(
  resolved: ResolvedRecipe,
  position: RecipePosition,
  slot: string,
): RecipeValueOrigin | undefined {
  return resolved.origins.find((origin) => origin.position === position && origin.slot === slot);
}

/**
 * Whether a branch actually carries prompt content. A branch switched off
 * resolves to an empty object and must not be shown as an empty document.
 */
export function recipeBranchIsEmpty(branch: ResolvedRecipeBranch): boolean {
  return branch.system === undefined && branch.steering === undefined && branch.anchor === undefined
    && Object.keys(branch.fields).length === 0;
}

/** The file names a Recipe package carries, TOML first, then its Markdown. */
export function recipeFileNames(files: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(files);
  const markdown = names.filter((name) => name !== 'recipe.toml').toSorted();
  // TOML last: the manifest is the reference the other files answer to, so it
  // reads as the anchor of the list rather than one more body file.
  return names.includes('recipe.toml') ? [...markdown, 'recipe.toml'] : markdown;
}

/**
 * A source locator shown to a person: the tail of a URL or path, not the whole
 * machine-local string. Still enough to recognise which source it is.
 */
export function recipeLocatorLabel(locator: string): string {
  const text = locator.startsWith('installation:') ? locator : locator.replace(/[?#].*$/u, '');
  const parts = text.split(/[\\/]/u).filter((part) => part.length > 0);
  const last = parts.at(-1);
  return last === undefined || last.length === 0 ? text : last;
}

/** Human-readable one-liner for a stored diagnostic. */
export function recipeDiagnosticText(diagnostic: RecipeDiagnostic): string {
  return diagnostic.path === undefined ? diagnostic.message : `${diagnostic.path}: ${diagnostic.message}`;
}
