import { createHash } from 'node:crypto';
import type { RecipePreview, RecipeScriptHook, ResolvedRecipe } from '@kiki/protocol';
import { z } from 'zod';
import { HookDefSchema } from '#/features/externalHooks/configSection';
import { recipeDigest, recipeFailure, validateRecipePath } from './recipePrimitives';

const sessionEvents = new Set(['SessionStart', 'SessionEnd', 'SessionHeartbeat', 'SubagentStart', 'SubagentStop']);
export const recipeHookManifestSchema = HookDefSchema.extend({
  event: HookDefSchema.shape.event.refine((event) => !sessionEvents.has(event), 'Recipe hooks require an Agent-bound event'),
  files: z.array(z.string().min(1)).min(1).max(128), root: z.string().min(1).optional(),
}).strict();

export function hookExecution(hook: RecipeScriptHook) {
  return { event: hook.event, command: hook.command, matcher: hook.matcher, timeout: hook.timeout,
    files: Object.fromEntries(Object.entries(hook.files).toSorted(([a], [b]) => a.localeCompare(b))) };
}
export function recipeHookFingerprint(hooks: readonly RecipeScriptHook[] | undefined): string | undefined {
  return hooks?.length ? recipeDigest(hooks.map((hook) => ({ ...hookExecution(hook), source: hook.source }))) : undefined;
}
export function recipeHookPreview(recipe: ResolvedRecipe, trusted: readonly string[] = []): NonNullable<RecipePreview['hooks']> {
  const fingerprint = recipeHookFingerprint(recipe.hooks);
  return { fingerprint, consent_required: fingerprint !== undefined && !trusted.includes(fingerprint),
    scripts: (recipe.hooks ?? []).map((hook) => ({ event: hook.event, command: hook.command, matcher: hook.matcher, timeout: hook.timeout, source: hook.source,
      files: Object.entries(hook.files).map(([path, text]) => ({ path, sha256: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`, bytes: Buffer.byteLength(text) })) })) };
}
export function validateHookResources(hook: RecipeScriptHook): void {
  recipeHookManifestSchema.parse({ ...hookExecution(hook), files: Object.keys(hook.files) });
  let bytes = 0;
  for (const [file, text] of Object.entries(hook.files)) {
    validateRecipePath(file);
    bytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > 256 * 1024 || bytes > 4 * 1024 * 1024) recipeFailure('Recipe hook resources exceed text budget', hook.source, file);
  }
}
