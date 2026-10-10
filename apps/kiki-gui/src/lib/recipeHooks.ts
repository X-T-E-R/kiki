/**
 * Reading a Recipe's script hooks, and deciding what a person is agreeing to.
 *
 * A Recipe may carry shell scripts that run inside the host when a bound Agent
 * reaches an event. That makes them the only part of a package that executes
 * rather than supplies words, so the GUI's job here is narrow and specific:
 * show the command that will actually run, the event that fires it, where it
 * came from and which resource files ship with it — and then fold that into the
 * confirmation the person was already going to read for the install.
 *
 * Three facts drive the whole surface, and none of them are GUI inventions:
 *
 *   - `consent_required` is the server's own answer to "is this execution
 *     content already authorized on this machine". A package whose scripts match
 *     what an installation already trusts updates without asking, which is why
 *     an unchanged package must not grow a confirmation.
 *   - `fingerprint` identifies that trusted execution content. It is machine
 *     trust: it is deliberately absent from a shared export, so the first person
 *     to install a copied package is asked once.
 *   - `scripts[]` is the frozen candidate. What is confirmed is exactly what the
 *     preview resolved, and nothing re-downloads at install time.
 *
 * The error path is the mirror of that. `update` and `saveLocal` still exist and
 * still validate, so an unconsented script reaches the GUI as a validation
 * failure carrying `details.code = recipe-hook-consent-required`. That is not a
 * dead end: it is the same decision, arriving late, and the caller answers it by
 * going through the very same preview → confirm → install path it would have
 * taken anyway.
 */

import { LEGACY_HOOK_EVENTS } from '@kiki/protocol';
import { ApiError } from '@kiki/session-core/transport';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { RecipeHookPreview, RecipeScriptPreview, RecipeSummary } from './recipes';

/**
 * The dictionary key for a hook event, when there is one.
 *
 * The event arrives as a plain string off the wire, so the template-literal
 * lookup is only type-safe against the known event names. An event this build
 * has no wording for returns `undefined` rather than a key that resolves to the
 * raw string at runtime — the caller then shows the event as it was spelled.
 */
export function recipeHookEventKey(event: string): I18nKey | undefined {
  return (LEGACY_HOOK_EVENTS as readonly string[]).includes(event)
    ? `st.hooks.event.${event}` as I18nKey
    : undefined;
}

/** The one detail code that means "this write needs the script consent first". */
export const RECIPE_HOOK_CONSENT_CODE = 'recipe-hook-consent-required';

/** An installation whose scripts are authorized to run as they stand. */
export function recipeHooksTrusted(summary: RecipeSummary): boolean {
  return summary.hooks_fingerprint !== undefined;
}

/**
 * Whether an update is waiting on a decision the person has not made yet.
 *
 * Distinct from `hooks_fingerprint`: the fingerprint says the installed copy is
 * trusted, this says the newer content is not yet. A package can be trusted and
 * still have an update that needs one confirmation.
 */
export function recipeHookConsentPending(summary: RecipeSummary): boolean {
  return summary.hook_consent_required === true;
}

/**
 * Whether a preview needs the consent paragraph and an explicit `consent: true`.
 *
 * A package with no scripts at all reports an absent `hooks`, and one whose
 * scripts are already trusted reports `consent_required: false` with a
 * fingerprint. Both install from the same button with the same payload as they
 * always did — the difference is that only this case sends the extra flag.
 */
export function recipePreviewNeedsConsent(preview: { hooks?: RecipeHookPreview }): boolean {
  return preview.hooks?.consent_required === true;
}

/** Whether a failed write is asking for that same consent, by its own code. */
export function isRecipeHookConsentRequired(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return typeof error.details === 'object' && error.details !== null
    && (error.details as { code?: unknown }).code === RECIPE_HOOK_CONSENT_CODE;
}

/**
 * Scripts grouped by the event that fires them, so a package with six hooks on
 * two events reads as two things rather than six.
 *
 * Order inside a group follows the server's order. Re-sorting commands would
 * make the list disagree with the resolved manifest for no benefit.
 */
export function recipeHookScriptsByEvent(scripts: readonly RecipeScriptPreview[]): { event: string; scripts: RecipeScriptPreview[] }[] {
  const groups = new Map<string, RecipeScriptPreview[]>();
  for (const script of scripts) {
    const group = groups.get(script.event);
    if (group === undefined) groups.set(script.event, [script]);
    else group.push(script);
  }
  return [...groups].map(([event, entries]) => ({ event, scripts: entries }));
}

/** Every resource file any script in the package ships, deduplicated by path. */
export function recipeHookResourceFiles(scripts: readonly RecipeScriptPreview[]): { path: string; bytes: number; count: number }[] {
  const byPath = new Map<string, { path: string; bytes: number; count: number }>();
  for (const script of scripts) {
    for (const file of script.files) {
      const seen = byPath.get(file.path);
      // A resource two hooks share is one file in the package, and saying so
      // twice would imply it is packed twice.
      if (seen === undefined) byPath.set(file.path, { path: file.path, bytes: file.bytes, count: 1 });
      else seen.count += 1;
    }
  }
  return [...byPath.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

/** A file size a reader can place: bytes under a kilobyte, kilobytes above it. */
export function recipeHookFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
}

/**
 * The `consent` field for an install, which is only ever sent when the preview
 * asked for it.
 *
 * Sending `consent: false`, or `consent: true` for scripts the machine already
 * trusts, would both make the client's answer mean something the server did not
 * ask. An absent flag is the same call it always was.
 */
export function recipeConsentField(preview: { hooks?: RecipeHookPreview }): { consent?: true } {
  return recipePreviewNeedsConsent(preview) ? { consent: true } : {};
}
