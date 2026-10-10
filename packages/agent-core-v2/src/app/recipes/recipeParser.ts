import { recipeDigest, recipeFailure, validateRecipePath } from './recipePrimitives';
import { parse } from 'smol-toml';
import { valid } from 'semver';
import { z } from 'zod';
import { recipeBranchSchema, recipeSourceSchema, type RecipeSource, type RecipeValueOrigin, type ResolvedRecipe, type ResolvedRecipeBranch, type RecipeLockEntry } from '@kiki/protocol';
import type { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import type { RecipePackageReader } from './recipes';
import { Error2, ErrorCodes } from '#/errors';
import { recipeModelSettingsFromToml, mergeRecipeModelSettings, recipeModelLeaves } from './recipeModelSettings';
import { recipeHookManifestSchema } from './recipeHooks';
export { recipeDigest, recipeFailure, validateRecipePath } from './recipePrimitives';

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
  hooks: z.union([z.literal('off'), z.array(recipeHookManifestSchema).max(64)]).optional(),
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
  hooks?: import('@kiki/protocol').RecipeScriptHook[] | 'off';
}
export interface RecipeSnapshot { source: RecipeSource; requestedSource: RecipeSource; manifest: RecipeManifest; files: Record<string, string>; declaration: RecipeDeclaration; resolved: ResolvedRecipe }

export async function parseRecipe(reader: RecipePackageReader, registry: IPromptFieldRegistry): Promise<{ manifest: RecipeManifest; files: Record<string, string>; declaration: RecipeDeclaration }> {
  const files: Record<string, string> = {};
  files['recipe.toml'] = await reader.read('recipe.toml');
  let manifest: RecipeManifest;
  try { manifest = recipeManifestSchema.parse(parse(files['recipe.toml'])); }
  catch (cause) {
    const issues = cause instanceof z.ZodError ? cause.issues.flatMap((issue) => issue.code === 'invalid_union' ? issue.errors.flat() : [issue]) : [];
    const issue = issues.find((issue) => issue.code === 'custom') ?? issues[0];
    const detail = issue === undefined ? '' : `: ${issue.path.join('.')}: ${issue.message}`;
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Invalid Recipe manifest${detail}`, { cause, details: { source: reader.source.locator, path: issue?.path.join('.') } });
  }
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
  let hooks: RecipeDeclaration['hooks'] = manifest.hooks === 'off' ? 'off' : undefined;
  if (Array.isArray(manifest.hooks)) {
    hooks = [];
    for (const hook of manifest.hooks) {
      const resources: Record<string, string> = {};
      if (hook.root !== undefined) validateRecipePath(hook.root);
      for (const file of hook.files) {
        validateRecipePath(file); const location = hook.root === undefined ? file : `${hook.root}/${file}`;
        files[location] ??= await reader.read(location); resources[file] = files[location]!;
      }
      hooks.push({ event: hook.event, command: hook.command, matcher: hook.matcher, timeout: hook.timeout, files: resources, source: reader.source.locator, manifest_id: manifest.id });
    }
  }
  return { manifest, files, declaration: { ...await content(raw), model, modelOrigins, hooks,
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
  const hooks = child.hooks === 'off' ? 'off' : child.hooks === undefined ? parent.hooks : [...(Array.isArray(parent.hooks) ? parent.hooks : []), ...child.hooks];
  return { ...content(parent, child), model, modelOrigins, hooks, main: branch(parent.main, child.main), independent: branch(parent.independent, child.independent) };
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
  const hooks = Array.isArray(declaration.hooks) && declaration.hooks.length > 0 ? declaration.hooks : undefined;
  if (hooks !== undefined && (hooks.length > 64 || Buffer.byteLength(JSON.stringify(hooks)) > 4 * 1024 * 1024)) recipeFailure('Resolved Recipe hooks exceed package budget', undefined, 'hooks');
  const resolved = { branches, dependencies, origins, model, model_origins, hooks };
  return { revision: recipeDigest(resolved), ...resolved };
}
