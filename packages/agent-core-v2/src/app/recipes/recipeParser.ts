import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { valid } from 'semver';
import { z } from 'zod';
import { recipeBranchSchema, recipeSourceSchema, type RecipeSource, type RecipeValueOrigin, type ResolvedRecipe, type ResolvedRecipeBranch, type RecipeLockEntry } from '@kiki/protocol';
import type { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import type { RecipePackageReader } from './recipes';
import { Error2, ErrorCodes } from '#/errors';
import { recipeModelSettingsFromToml, mergeRecipeModelSettings, recipeModelLeaves } from './recipeModelSettings';

const sourceSchema = z.union([z.object({ text: z.string() }).strict(), z.object({ file: z.string().min(1) }).strict()]);
const slotSchema = z.union([sourceSchema, z.array(sourceSchema).min(1).max(64), z.literal('off')]);
const cadenceSchema = recipeBranchSchema.pick({ steering_on_turn: true, steering_on_input: true, steering_interval_steps: true });
const contentSchema = cadenceSchema.extend({
  system: slotSchema.optional(), steering: slotSchema.optional(),
  anchor: z.union([z.literal('off'), z.object({ content: slotSchema, steps: z.number().int().positive().max(1000).default(1), scope: z.enum(['session', 'turn']).default('session') }).strict()]).optional(),
  fields: z.record(z.string(), z.union([z.string(), z.literal(false)])).optional(),
}).strict();
export const recipeManifestSchema = z.object({
  schema_version: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u), name: z.string().min(1),
  version: z.string().refine((v) => valid(v) !== null, 'Expected semver'), description: z.string().optional(),
  extends: z.object({ source: z.string().min(1), sha256: recipeSourceSchema.shape.sha256, revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional() }).strict().optional(),
  model: z.union([z.literal('off'), z.record(z.string(), z.unknown())]).optional(),
  prompts: contentSchema.extend({ main: z.union([z.enum(['off', 'same']), contentSchema]).optional(), independent: z.union([z.enum(['off', 'same']), contentSchema]).optional() }).strict().optional(),
}).strict();
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;
export type Origin = Omit<RecipeValueOrigin, 'position' | 'slot'>;
export interface TextValue { text: string; origins: Origin[] }
export interface RecipeContent extends z.infer<typeof cadenceSchema> {
  system?: TextValue | 'off'; steering?: TextValue | 'off';
  anchor?: { content: TextValue | 'off'; steps: number; scope: 'session' | 'turn' } | 'off';
  fields?: Record<string, { value: string | false; origin: Origin }>;
  cadenceOrigins?: Record<string, Origin>;
}
export interface RecipeDeclaration extends RecipeContent {
  main?: RecipeContent | 'same' | 'off'; independent?: RecipeContent | 'same' | 'off';
  model?: Record<string, unknown> | 'off'; modelOrigins?: Record<string, Origin>;
}
export interface RecipeSnapshot { source: RecipeSource; requestedSource: RecipeSource; manifest: RecipeManifest; files: Record<string, string>; declaration: RecipeDeclaration; resolved: ResolvedRecipe }

export function recipeFailure(message: string, source?: string, path?: string): never {
  throw new Error2(ErrorCodes.VALIDATION_FAILED, message, { details: { source, path } });
}
export function validateRecipePath(file: string): string {
  if (file.includes('\\') || file.includes(':') || file.startsWith('/') || file.includes('\0') || file.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) recipeFailure('Recipe file must be a relative path inside its package', undefined, file);
  return file;
}
export async function parseRecipe(reader: RecipePackageReader, registry: IPromptFieldRegistry): Promise<{ manifest: RecipeManifest; files: Record<string, string>; declaration: RecipeDeclaration }> {
  const files: Record<string, string> = {};
  files['recipe.toml'] = await reader.read('recipe.toml');
  let manifest: RecipeManifest;
  try { manifest = recipeManifestSchema.parse(parse(files['recipe.toml'])); }
  catch (cause) { throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Invalid Recipe manifest', { cause, details: { source: reader.source.locator } }); }
  const base: Origin = { source: reader.source.locator, manifest_id: manifest.id, version: manifest.version };
  const text = async (slot: z.infer<typeof slotSchema>): Promise<TextValue | 'off'> => {
    if (slot === 'off') return 'off';
    const parts = Array.isArray(slot) ? slot : [slot];
    const values: string[] = []; const origins: Origin[] = [];
    for (const part of parts) {
      if ('text' in part) { values.push(part.text); origins.push(base); }
      else {
        const file = validateRecipePath(part.file);
        if (!/\.md$/iu.test(file)) recipeFailure('Recipe prompt files must be Markdown', reader.source.locator, file);
        const value = files[file] ?? await reader.read(file); files[file] = value;
        values.push(value); origins.push({ ...base, file });
      }
    }
    return { text: values.join('\n\n'), origins };
  };
  const content = async (raw: z.infer<typeof contentSchema>): Promise<RecipeContent> => {
    const fields: NonNullable<RecipeContent['fields']> = {};
    for (const [id, value] of Object.entries(raw.fields ?? {})) {
      const definition = registry.get(id);
      if (definition === undefined || definition.readonly) recipeFailure('Recipe field is not model-overridable', reader.source.locator, id);
      if (value !== false) registry.validate({ values: { [id]: value }, sources: { [id]: [] } });
      fields[id] = { value, origin: base };
    }
    const cadence = cadenceSchema.parse(raw);
    return { ...cadence, cadenceOrigins: Object.fromEntries(Object.keys(cadence).map((key) => [key, base])),
      system: raw.system === undefined ? undefined : await text(raw.system), steering: raw.steering === undefined ? undefined : await text(raw.steering),
      anchor: raw.anchor === undefined || raw.anchor === 'off' ? raw.anchor : { ...raw.anchor, content: await text(raw.anchor.content) }, fields };
  };
  const raw = manifest.prompts ?? {};
  let model: RecipeDeclaration['model'];
  try { model = manifest.model === undefined || manifest.model === 'off' ? manifest.model : recipeModelSettingsFromToml(manifest.model); }
  catch (cause) { throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Invalid Recipe model settings', { cause, details: { source: reader.source.locator, path: 'model' } }); }
  const modelOrigins = typeof model === 'object' ? Object.fromEntries(recipeModelLeaves(model).map((key) => [key, base])) : {};
  return { manifest, files, declaration: { ...await content(raw), model, modelOrigins,
    main: typeof raw.main === 'object' ? await content(raw.main) : raw.main, independent: typeof raw.independent === 'object' ? await content(raw.independent) : raw.independent } };
}
export function mergeRecipe(parent: RecipeDeclaration, child: RecipeDeclaration): RecipeDeclaration {
  const content = (a: RecipeContent, b: RecipeContent): RecipeContent => ({
    system: b.system ?? a.system, steering: b.steering ?? a.steering, anchor: b.anchor ?? a.anchor, fields: { ...a.fields, ...b.fields },
    steering_on_turn: b.steering_on_turn ?? a.steering_on_turn, steering_on_input: b.steering_on_input ?? a.steering_on_input,
    steering_interval_steps: b.steering_interval_steps ?? a.steering_interval_steps, cadenceOrigins: { ...a.cadenceOrigins, ...b.cadenceOrigins },
  });
  const branch = (a: RecipeDeclaration['main'], b: RecipeDeclaration['main']): RecipeDeclaration['main'] => b === undefined ? a : typeof a === 'object' && typeof b === 'object' ? content(a, b) : b;
  const model = child.model === undefined ? parent.model : typeof child.model === 'object' && typeof parent.model === 'object' ? mergeRecipeModelSettings(parent.model, child.model) : child.model;
  const modelOrigins = child.model === 'off' ? {} : { ...(parent.model === 'off' ? {} : parent.modelOrigins), ...child.modelOrigins };
  return { ...content(parent, child), model, modelOrigins, main: branch(parent.main, child.main), independent: branch(parent.independent, child.independent) };
}
export function resolveRecipe(declaration: RecipeDeclaration, dependencies: RecipeLockEntry[]): ResolvedRecipe {
  const origins: RecipeValueOrigin[] = [];
  const resolve = (position: 'main' | 'sub' | 'independent'): ResolvedRecipeBranch => {
    const branch = position === 'sub' ? undefined : declaration[position];
    const content = branch === 'off' ? {} : typeof branch === 'object' ? branch : declaration;
    const fields: Record<string, string> = {};
    const slot = (id: string, value: TextValue | 'off' | undefined): string | undefined => {
      if (value === undefined || value === 'off') return undefined;
      origins.push(...value.origins.map((origin) => ({ ...origin, position, slot: id })));
      return value.text;
    };
    for (const [id, value] of Object.entries(content.fields ?? {})) if (value.value !== false) { fields[id] = value.value; origins.push({ ...value.origin, position, slot: id }); }
    const cadence = cadenceSchema.parse(content);
    for (const [id, origin] of Object.entries(content.cadenceOrigins ?? {})) origins.push({ ...origin, position, slot: id });
    const anchor = content.anchor;
    const anchorText = anchor === undefined || anchor === 'off' ? undefined : slot('anchor', anchor.content);
    return { ...cadence, system: slot('system', content.system), steering: slot('steering', content.steering), anchor: anchorText === undefined || anchor === undefined || anchor === 'off' ? undefined : { content: anchorText, steps: anchor.steps, scope: anchor.scope }, fields };
  };
  const branches = { main: resolve('main'), sub: resolve('sub'), independent: resolve('independent') };
  const model = typeof declaration.model === 'object' ? declaration.model : {};
  const model_origins = declaration.modelOrigins ?? {};
  const resolved = { branches, dependencies, origins, model, model_origins };
  return { revision: recipeDigest(resolved), ...resolved };
}
export function recipeDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
