import { recipeDigest, recipeFailure, validateRecipePath } from './recipePrimitives';
import { parse } from 'smol-toml';
import { valid } from 'semver';
import { z } from 'zod';
import { modelSteeringSourceIds, modelSteeringSourcesSchema, mergeModelSteeringSources, type ModelSteeringSources, recipeBranchSchema, recipeSourceSchema, type RecipeSource, type RecipeValueOrigin, type ResolvedRecipe, type ResolvedRecipeBranch, type RecipeLockEntry } from '@kiki/protocol';
import type { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import type { RecipePackageReader } from './recipes';
import { Error2, ErrorCodes } from '#/errors';
import { recipeModelSettingsFromToml, mergeRecipeModelSettings, recipeModelLeaves } from './recipeModelSettings';
import { recipeHookManifestSchema } from './recipeHooks';
import { evaluateRecipeOptions, recipePatchSlotPattern, type RecipeOptionDeclaration, type RecipeTextPart, type RecipeTextPatch } from './recipeOptions';
import { recipeOptionOrder } from './recipeOptionOrder';
export { recipeDigest, recipeFailure, validateRecipePath } from './recipePrimitives';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u);
const plainSourceSchema = z.union([z.object({ text: z.string() }).strict(), z.object({ file: z.string().min(1) }).strict()]);
const gate = { when: idSchema.optional(), unless: idSchema.optional() };
const sourceSchema = z.union([z.object({ text: z.string(), ...gate }).strict(), z.object({ file: z.string().min(1), ...gate }).strict()])
  .refine((value) => value.when === undefined || value.unless === undefined, 'when and unless are mutually exclusive');
const slotSchema = z.union([sourceSchema, z.array(sourceSchema).min(1).max(64), z.literal('off')]);
const insertionSlotSchema = z.union([plainSourceSchema, z.array(plainSourceSchema).min(1).max(64)]);
const insertionContentSchema = z.object({ system: insertionSlotSchema.optional(), steering: insertionSlotSchema.optional(), anchor: insertionSlotSchema.optional(),
  steering_sources: z.partialRecord(z.enum(modelSteeringSourceIds), insertionSlotSchema).optional() }).strict();
const insertionSchema = z.object({ common: insertionContentSchema.optional(), main: insertionContentSchema.optional(), independent: insertionContentSchema.optional() }).strict();
const patchSchema = z.object({ slot: z.string().regex(recipePatchSlotPattern), section: z.string().min(1).optional(), action: z.enum(['prepend', 'append', 'before', 'after', 'replace', 'remove']), content: insertionSlotSchema.optional() }).strict().superRefine((value, ctx) => {
  if (value.section === undefined && value.action !== 'prepend' && value.action !== 'append') ctx.addIssue({ code: 'custom', path: ['action'], message: 'Without section only prepend and append are allowed' });
  if ((value.action === 'remove') === (value.content !== undefined)) ctx.addIssue({ code: 'custom', path: ['content'], message: value.action === 'remove' ? 'remove cannot have content' : 'This action requires content' });
});
const optionSchema = z.object({ name: z.string().min(1), description: z.string().optional(), default: z.boolean(), prepend: insertionSchema.optional(), append: insertionSchema.optional(), patch: z.array(patchSchema).max(64).optional() }).strict();
const cadenceSchema = recipeBranchSchema.pick({ steering_on_turn: true, steering_on_input: true, steering_interval_steps: true });
const contentSchema = cadenceSchema.extend({
  system: slotSchema.optional(), steering: slotSchema.optional(),
  steering_sources: modelSteeringSourcesSchema(slotSchema).optional(),
  anchor: z.union([z.literal('off'), z.object({ content: slotSchema, steps: z.number().int().positive().max(1000).default(1), scope: z.enum(['session', 'turn']).default('session') }).strict()]).optional(),
  fields: z.record(z.string(), z.union([z.string(), z.literal(false)])).optional(),
}).strict();
export const recipeManifestSchema = z.object({
  schema_version: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u), name: z.string().min(1),
  version: z.string().refine((v) => valid(v) !== null, 'Expected semver'), description: z.string().optional(),
  extends: z.object({ source: z.string().min(1), sha256: recipeSourceSchema.shape.sha256, revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional() }).strict().optional(),
  model: z.union([z.literal('off'), z.record(z.string(), z.unknown())]).optional(),
  hooks: z.union([z.literal('off'), z.array(recipeHookManifestSchema).max(64)]).optional(),
  options: z.record(idSchema, optionSchema).optional(),
  prompts: contentSchema.extend({ main: z.union([z.enum(['off', 'same']), contentSchema]).optional(), independent: z.union([z.enum(['off', 'same']), contentSchema]).optional() }).strict().optional(),
}).strict();
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;
export type Origin = Omit<RecipeValueOrigin, 'position' | 'slot'>;
export interface TextValue { text: string; origins: Origin[]; parts?: RecipeTextPart[] }
export interface RecipeContent extends z.infer<typeof cadenceSchema> {
  system?: TextValue | 'off'; steering?: TextValue | 'off';
  steering_sources?: ModelSteeringSources<TextValue | 'off'>;
  anchor?: { content: TextValue | 'off'; steps: number; scope: 'session' | 'turn' } | 'off';
  fields?: Record<string, { value: string | false; origin: Origin }>;
  cadenceOrigins?: Record<string, Origin>;
}
export interface RecipeDeclaration extends RecipeContent {
  main?: RecipeContent | 'same' | 'off'; independent?: RecipeContent | 'same' | 'off';
  model?: Record<string, unknown> | 'off'; modelOrigins?: Record<string, Origin>;
  hooks?: import('@kiki/protocol').RecipeScriptHook[] | 'off';
  options?: Record<string, RecipeOptionDeclaration>;
  optionOrder?: string[];
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
    const values: RecipeTextPart[] = [];
    for (const part of parts) {
      if ('text' in part) values.push({ text: part.text, origins: [base], when: part.when, unless: part.unless });
      else {
        const file = validateRecipePath(part.file);
        if (!/\.md$/iu.test(file)) recipeFailure('Recipe prompt files must be Markdown', reader.source.locator, file);
        const value = files[file] ?? await reader.read(file); files[file] = value;
        values.push({ text: value, origins: [{ ...base, file }], when: part.when, unless: part.unless });
      }
    }
    return { text: values.map((part) => part.text).join('\n\n'), origins: values.flatMap((part) => part.origins), parts: values.some((part) => part.when !== undefined || part.unless !== undefined) ? values : undefined };
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
    const steering_sources: RecipeContent['steering_sources'] = raw.steering_sources === undefined ? undefined : {};
    for (const source of modelSteeringSourceIds) {
      const setting = raw.steering_sources?.[source];
      if (setting !== undefined) steering_sources![source] = { mode: setting.mode, custom: setting.custom === undefined ? undefined : { ...setting.custom, steering: setting.custom.steering === undefined ? undefined : await text(setting.custom.steering) } };
    }
    return { ...cadence, steering_sources, cadenceOrigins: Object.fromEntries(Object.keys(cadence).map((key) => [key, base])),
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
  const options: RecipeDeclaration['options'] = manifest.options === undefined ? undefined : {};
  const optionOrder = manifest.options === undefined ? undefined : recipeOptionOrder(files['recipe.toml']);
  for (const id of optionOrder ?? []) {
    const option = manifest.options![id]!;
    const patch: RecipeTextPatch[] = [];
    for (const action of ['prepend', 'append'] as const) for (const [branch, slots] of Object.entries(option[action] ?? {})) {
      for (const slot of ['system', 'steering', 'anchor'] as const) {
        const source = slots[slot];
        if (source !== undefined) patch.push({ slot: `${branch}.${slot}`, action, content: await text(source) as TextValue });
      }
      for (const [kind, body] of Object.entries(slots.steering_sources ?? {})) patch.push({ slot: `${branch}.steering_sources.${kind}`, action, content: await text(body) as TextValue });
    }
    for (const item of option.patch ?? []) patch.push({ ...item, content: item.content === undefined ? undefined : await text(item.content) as TextValue });
    options![id] = { name: option.name, description: option.description, default: option.default, patch: patch.length === 0 ? undefined : patch };
  }
  return { manifest, files, declaration: { ...await content(raw), model, modelOrigins, hooks, options, optionOrder,
    main: typeof raw.main === 'object' ? await content(raw.main) : raw.main, independent: typeof raw.independent === 'object' ? await content(raw.independent) : raw.independent } };
}
export function mergeRecipe(parent: RecipeDeclaration, child: RecipeDeclaration): RecipeDeclaration {
  const content = (a: RecipeContent, b: RecipeContent): RecipeContent => ({
    system: b.system ?? a.system, steering: b.steering ?? a.steering, anchor: b.anchor ?? a.anchor, fields: { ...a.fields, ...b.fields },
    steering_sources: mergeModelSteeringSources(a.steering_sources, b.steering_sources),
    steering_on_turn: b.steering_on_turn ?? a.steering_on_turn, steering_on_input: b.steering_on_input ?? a.steering_on_input,
    steering_interval_steps: b.steering_interval_steps ?? a.steering_interval_steps, cadenceOrigins: { ...a.cadenceOrigins, ...b.cadenceOrigins },
  });
  const branch = (a: RecipeDeclaration['main'], b: RecipeDeclaration['main']): RecipeDeclaration['main'] => b === undefined ? a : typeof a === 'object' && typeof b === 'object' ? content(a, b) : b;
  const model = child.model === undefined ? parent.model : typeof child.model === 'object' && typeof parent.model === 'object' ? mergeRecipeModelSettings(parent.model, child.model) : child.model;
  const modelOrigins = child.model === 'off' ? {} : { ...(parent.model === 'off' ? {} : parent.modelOrigins), ...child.modelOrigins };
  const hooks = child.hooks === 'off' ? 'off' : child.hooks === undefined ? parent.hooks : [...(Array.isArray(parent.hooks) ? parent.hooks : []), ...child.hooks];
  const options = parent.options === undefined && child.options === undefined ? undefined : { ...parent.options, ...child.options };
  const optionOrder = options === undefined ? undefined : [...new Set([...(parent.optionOrder ?? Object.keys(parent.options ?? {})), ...(child.optionOrder ?? Object.keys(child.options ?? {}))])];
  return { ...content(parent, child), model, modelOrigins, hooks, options, optionOrder, main: branch(parent.main, child.main), independent: branch(parent.independent, child.independent) };
}
export function resolveRecipe(input: RecipeDeclaration, dependencies: RecipeLockEntry[], selection?: import('@kiki/protocol').RecipeOptionValues): ResolvedRecipe {
  const { declaration, options, option_values, diagnostics } = evaluateRecipeOptions(input, selection);
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
    const steering_sources: ResolvedRecipeBranch['steering_sources'] = content.steering_sources === undefined ? undefined : {};
    for (const source of modelSteeringSourceIds) {
      const setting = content.steering_sources?.[source];
      if (setting !== undefined) steering_sources![source] = { mode: setting.mode, custom: setting.custom === undefined ? undefined : { ...setting.custom, steering: setting.custom.steering === 'off' ? '' : slot(`steering_sources.${source}`, setting.custom.steering) } };
    }
    return { ...cadence, steering_sources, system: slot('system', content.system), steering: slot('steering', content.steering), anchor: anchorText === undefined || anchor === undefined || anchor === 'off' ? undefined : { content: anchorText, steps: anchor.steps, scope: anchor.scope }, fields };
  };
  const branches = { main: resolve('main'), sub: resolve('sub'), independent: resolve('independent') };
  const model = typeof declaration.model === 'object' ? declaration.model : {};
  const model_origins = declaration.modelOrigins ?? {};
  const hooks = Array.isArray(declaration.hooks) && declaration.hooks.length > 0 ? declaration.hooks : undefined;
  if (hooks !== undefined && (hooks.length > 64 || Buffer.byteLength(JSON.stringify(hooks)) > 4 * 1024 * 1024)) recipeFailure('Resolved Recipe hooks exceed package budget', undefined, 'hooks');
  const resolved = { branches, dependencies, origins, model, model_origins, hooks, options, option_values };
  return { revision: recipeDigest(resolved), ...resolved, diagnostics };
}
