/**
 * Reading and writing a Recipe package's own files.
 *
 * The package is TOML plus the Markdown it references, and the manifest is the
 * only thing that decides what is declared. `resolved` is deliberately not a
 * writable source: it has already lost the differences between "absent",
 * "explicitly same", "explicitly off" and "inherited from the parent", and
 * writing it back would silently promote all four into the same thing.
 *
 * So this module reads declarations out of the package's own TOML, and writes
 * prose back where it came from:
 *   - an inline `{text}` declaration edits its own `text` key;
 *   - a `{file}` declaration edits that file's buffer, leaving every other byte
 *     of the manifest alone;
 *   - a segment array edits each segment in place, keeping order and boundaries
 *     rather than collapsing the group into one string.
 *
 * `smol-toml` is a semantic serializer, not a TOML CST: it does not preserve
 * comments or original layout. Editing only a Markdown file therefore never
 * rewrites the manifest at all, and the one case that does lose formatting is
 * reported to the caller as an explicit, confirmed action rather than done
 * quietly.
 */

import { parse, stringify } from 'smol-toml';

export const RECIPE_MANIFEST = 'recipe.toml';

type TomlTable = Record<string, unknown>;

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One prompt slot's declaration, exactly as the manifest spells it. */
export type SlotDeclaration =
  | { readonly kind: 'off' }
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'segments'; readonly parts: readonly SegmentDeclaration[] };

export interface SegmentDeclaration {
  readonly kind: 'inline' | 'file';
  /** The prose, for an inline segment. */
  readonly text?: string;
  /** The package-relative path, for a file segment. */
  readonly file?: string;
}

export interface PromptGroupDeclaration {
  system?: SlotDeclaration;
  steering?: SlotDeclaration;
  anchor?: SlotDeclaration;
  fields?: Record<string, string | false>;
  steering_on_turn?: boolean;
  steering_on_input?: boolean;
  steering_interval_steps?: number;
}

export interface RecipeDeclarationView {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  /** Present when the package inherits a parent Recipe. */
  extends?: { source?: string; revision?: string };
  /** `'off'` clears the parent's parameter overrides; absent inherits them. */
  model?: TomlTable | 'off' | undefined;
  prompts?: PromptGroupDeclaration;
  main?: PromptGroupDeclaration | 'same' | 'off';
  independent?: PromptGroupDeclaration | 'same' | 'off';
}

/** Parse failure carries the parser's own message and, when it has one, a path. */
export class RecipeManifestError extends Error {
  constructor(readonly detail: string, readonly path?: string) {
    super(path === undefined ? detail : `${path}: ${detail}`);
    this.name = 'RecipeManifestError';
  }
}

export function parseRecipeManifest(text: string): TomlTable {
  try {
    const parsed = parse(text);
    if (!isTable(parsed)) throw new RecipeManifestError('Expected a table at the top level');
    return parsed;
  } catch (error) {
    if (error instanceof RecipeManifestError) throw error;
    throw new RecipeManifestError(error instanceof Error ? error.message : String(error));
  }
}

/** The manifest as a declaration view, without validating it against a schema. */
export function readDeclaration(manifest: TomlTable): RecipeDeclarationView {
  const prompts = isTable(manifest['prompts']) ? manifest['prompts'] : undefined;
  const group = (raw: unknown): PromptGroupDeclaration | undefined => {
    if (!isTable(raw)) return undefined;
    const out: {
      system?: SlotDeclaration; steering?: SlotDeclaration; anchor?: SlotDeclaration;
      fields?: Record<string, string | false>;
      steering_on_turn?: boolean; steering_on_input?: boolean; steering_interval_steps?: number;
    } = {};
    const slot = (value: unknown, name: string): SlotDeclaration | undefined => {
      if (value === 'off') return { kind: 'off' };
      if (typeof value === 'string') throw new RecipeManifestError('Expected a table, an array or off', name);
      if (Array.isArray(value)) return { kind: 'segments', parts: value.map((part, index) => segment(part, `${name}[${index}]`)) };
      if (!isTable(value)) return undefined;
      if (typeof value['text'] === 'string') return { kind: 'inline', text: value['text'] };
      if (typeof value['file'] === 'string') return { kind: 'file', file: value['file'] };
      return undefined;
    };
    if (raw['system'] !== undefined) out.system = slot(raw['system'], 'system');
    if (raw['steering'] !== undefined) out.steering = slot(raw['steering'], 'steering');
    if (raw['anchor'] !== undefined) out.anchor = slot(raw['anchor'], 'anchor');
    if (isTable(raw['fields'])) {
      const fields: Record<string, string | false> = {};
      for (const [id, value] of Object.entries(raw['fields'])) {
        if (value === false || typeof value === 'string') fields[id] = value;
      }
      out.fields = fields;
    }
    if (typeof raw['steering_on_turn'] === 'boolean') out.steering_on_turn = raw['steering_on_turn'];
    if (typeof raw['steering_on_input'] === 'boolean') out.steering_on_input = raw['steering_on_input'];
    if (typeof raw['steering_interval_steps'] === 'number') out.steering_interval_steps = raw['steering_interval_steps'];
    return out;
  };
  const branch = (value: unknown, name: string): PromptGroupDeclaration | 'same' | 'off' | undefined => {
    if (value === 'same' || value === 'off') return value;
    if (value === undefined) return undefined;
    const groupValue = group(value);
    if (groupValue === undefined) throw new RecipeManifestError('Expected a table, same or off', name);
    return groupValue;
  };
  const model = manifest['model'];
  return {
    id: typeof manifest['id'] === 'string' ? manifest['id'] : undefined,
    name: typeof manifest['name'] === 'string' ? manifest['name'] : undefined,
    version: typeof manifest['version'] === 'string' ? manifest['version'] : undefined,
    description: typeof manifest['description'] === 'string' ? manifest['description'] : undefined,
    extends: isTable(manifest['extends'])
      ? {
        source: typeof manifest['extends']['source'] === 'string' ? manifest['extends']['source'] : undefined,
        revision: typeof manifest['extends']['revision'] === 'string' ? manifest['extends']['revision'] : undefined,
      }
      : undefined,
    model: model === 'off' ? 'off' : isTable(model) ? model : undefined,
    prompts: group(prompts),
    main: branch(prompts?.['main'], 'prompts.main'),
    independent: branch(prompts?.['independent'], 'prompts.independent'),
  };
}

/** Which files a declaration references, so a rename can follow its reference. */
export function referencedFiles(declaration: RecipeDeclarationView): string[] {
  const names = new Set<string>();
  const walk = (group: PromptGroupDeclaration | 'same' | 'off' | undefined): void => {
    if (group === undefined || group === 'same' || group === 'off') return;
    for (const slot of [group.system, group.steering, group.anchor]) {
      if (slot?.kind === 'file') names.add(slot.file);
      if (slot?.kind === 'segments') {
        for (const part of slot.parts) {
          if (part.kind === 'file' && part.file !== undefined) names.add(part.file);
        }
      }
    }
  };
  walk(declaration.prompts);
  walk(declaration.main);
  walk(declaration.independent);
  return [...names].toSorted();
}

/**
 * Where one slot's prose actually lives, so an editor can open the right
 * buffer: the manifest itself for inline text, the named file for a reference.
 */
export function slotBufferTarget(slot: SlotDeclaration | undefined): { file: string; inline: boolean } | undefined {
  if (slot === undefined) return undefined;
  if (slot.kind === 'inline') return { file: RECIPE_MANIFEST, inline: true };
  if (slot.kind === 'file') return { file: slot.file, inline: false };
  if (slot.kind === 'off') return undefined;
  if (slot.parts.some((part) => part.kind === 'inline')) return { file: RECIPE_MANIFEST, inline: true };
  const file = slot.parts.find((part) => part.file !== undefined)?.file;
  return file === undefined ? undefined : { file, inline: false };
}

/**
 * Write one slot's prose back into the manifest.
 *
 * Only the slot's own key is replaced. Every other declaration in the file —
 * including an explicit `same`, an `off`, a `false` field and an empty array —
 * is carried through untouched, because those are values the engine reads
 * apart from "not declared".
 */
export function writeSlot(
  manifest: TomlTable,
  groupKey: 'prompts' | 'main' | 'independent',
  slotName: 'system' | 'steering' | 'anchor',
  value: SlotDeclaration,
): TomlTable {
  const next = cloneManifest(manifest);
  const { root, group } = promptGroups(next, groupKey);
  group[slotName] = slotToToml(value);
  next['prompts'] = root;
  return next;
}

/** Remove a slot's declaration, so the slot goes back to inheriting. */
export function deleteSlot(
  manifest: TomlTable,
  groupKey: 'prompts' | 'main' | 'independent',
  slotName: 'system' | 'steering' | 'anchor',
): TomlTable {
  const next = cloneManifest(manifest);
  const { root, group } = promptGroups(next, groupKey);
  delete group[slotName];
  next['prompts'] = root;
  return next;
}

/** Write one prompt field's body, or `false` to hide an inherited one. */
export function writeField(
  manifest: TomlTable,
  groupKey: 'prompts' | 'main' | 'independent',
  id: string,
  value: string | false,
): TomlTable {
  const next = cloneManifest(manifest);
  const { root, group } = promptGroups(next, groupKey);
  const fields = isTable(group['fields']) ? group['fields'] as TomlTable : {};
  fields[id] = value;
  group['fields'] = fields;
  next['prompts'] = root;
  return next;
}

export function deleteField(
  manifest: TomlTable,
  groupKey: 'prompts' | 'main' | 'independent',
  id: string,
): TomlTable {
  const next = cloneManifest(manifest);
  const { root, group } = promptGroups(next, groupKey);
  if (!isTable(group['fields'])) return next;
  const fields = { ...(group['fields'] as TomlTable) };
  delete fields[id];
  group['fields'] = fields;
  next['prompts'] = root;
  return next;
}

/** Choose one prompt group for an identity: inherit, custom, or off. */
export function writeBranchMode(
  manifest: TomlTable,
  groupKey: 'main' | 'independent',
  mode: 'same' | 'off' | 'custom',
  content?: TomlTable,
): TomlTable {
  const next = cloneManifest(manifest);
  const root = isTable(next['prompts']) ? { ...(next['prompts'] as TomlTable) } : {};
  root[groupKey] = mode === 'custom' ? (content ?? {}) : mode;
  next['prompts'] = root;
  return next;
}

/** Steer cadence, three independent values rather than one mode. */
export function writeCadence(
  manifest: TomlTable,
  groupKey: 'prompts' | 'main' | 'independent',
  cadence: { onTurn: boolean; onInput: boolean; intervalSteps: number },
): TomlTable {
  const next = cloneManifest(manifest);
  const { root, group } = promptGroups(next, groupKey);
  group['steering_on_turn'] = cadence.onTurn;
  group['steering_on_input'] = cadence.onInput;
  group['steering_interval_steps'] = cadence.intervalSteps;
  next['prompts'] = root;
  return next;
}

/**
 * Copy the manifest and hand back fresh tables for the group being edited.
 *
 * The copy has to be deep at every level the write touches. A shallow copy that
 * reuses the nested `prompts` object lets one group's write mutate the original,
 * which turns a single edit into a self-referential structure that no longer
 * serializes — and it would do that to the caller's baseline object too.
 */
function cloneManifest(manifest: TomlTable): TomlTable {
  return { ...manifest, prompts: isTable(manifest['prompts']) ? { ...(manifest['prompts'] as TomlTable) } : manifest['prompts'] };
}

/**
 * The root prompts table plus a fresh group table, already wired into the root.
 *
 * The fresh group has to be written back here: the caller mutates the returned
 * group and then assigns `next['prompts'] = root`, so a group that was only
 * read would leave the edit in a table nothing points at.
 */
function promptGroups(next: TomlTable, groupKey: 'prompts' | 'main' | 'independent'): { root: TomlTable; group: TomlTable } {
  const root = isTable(next['prompts']) ? { ...(next['prompts'] as TomlTable) } : {};
  const group = groupKey === 'prompts'
    ? root
    : isTable(root[groupKey]) ? { ...(root[groupKey] as TomlTable) } : {};
  if (groupKey !== 'prompts') root[groupKey] = group;
  return { root, group };
}

/** Write declared model parameters. A missing leaf falls back to inheriting. */
export function writeModel(manifest: TomlTable, model: TomlTable | 'off' | undefined): TomlTable {
  const next = structuredClone(manifest);
  if (model === undefined) delete next['model'];
  else next['model'] = model;
  return next;
}

/**
 * Render the manifest back to TOML.
 *
 * `stringify` is a semantic serializer: comments and the original layout are
 * not reproduced. Callers compare the rendered text with the original and
 * offer the reformat as an explicit action instead of silently rewriting a
 * file someone annotated.
 */
export function renderManifest(manifest: TomlTable): string {
  return stringify(manifest);
}

export function stringifyRecipeFiles(files: Readonly<Record<string, string>>): Record<string, string> {
  return { ...files };
}

/** Whether a rendering would drop the author's formatting or comments. */
export function manifestWouldReformat(original: string, rendered: string): boolean {
  return original.trim() !== rendered.trim();
}

function slotToToml(value: SlotDeclaration): unknown {
  switch (value.kind) {
    case 'off':
      return 'off';
    case 'inline':
      return { text: value.text };
    case 'file':
      return { file: value.file };
    case 'segments':
      return value.parts.map((part) => (part.kind === 'inline' ? { text: part.text ?? '' } : { file: part.file ?? '' }));
  }
}

function segment(value: unknown, path: string): SegmentDeclaration {
  if (!isTable(value)) throw new RecipeManifestError('Expected a segment table', path);
  if (typeof value['text'] === 'string') return { kind: 'inline', text: value['text'] };
  if (typeof value['file'] === 'string') return { kind: 'file', file: value['file'] };
  throw new RecipeManifestError('A segment needs text or file', path);
}