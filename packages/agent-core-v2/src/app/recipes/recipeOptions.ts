import { modelSteeringSourceIds, type RecipeOption, type RecipeOptionValues, type RecipeDiagnostic } from '@kiki/protocol';
import { recipeFailure } from './recipePrimitives';
import type { RecipeContent, RecipeDeclaration, TextValue } from './recipeParser';

export interface RecipeTextPart { text: string; origins: TextValue['origins']; when?: string; unless?: string }
export interface RecipeTextPatch { slot: string; section?: string; action: 'prepend' | 'append' | 'before' | 'after' | 'replace' | 'remove'; content?: TextValue }
export interface RecipeOptionDeclaration extends Omit<RecipeOption, 'id'> { patch?: RecipeTextPatch[] }
export function recipeOptionEntries(declaration: Pick<RecipeDeclaration, 'options' | 'optionOrder'>): [string, RecipeOptionDeclaration][] {
  return (declaration.optionOrder ?? Object.keys(declaration.options ?? {})).map((id) => [id, declaration.options![id]!]);
}
export const recipePatchSlotPattern = new RegExp(`^(common|main|independent)\\.(system|steering|anchor|steering_sources\\.(${modelSteeringSourceIds.join('|')}))$`, 'u');

export function recipeTextParts(value: TextValue): RecipeTextPart[] { return value.parts ?? [{ text: value.text, origins: value.origins }]; }
export function recipeTextValue(parts: RecipeTextPart[]): TextValue { return { text: parts.map((part) => part.text).join('\n\n'), origins: parts.flatMap((part) => part.origins), parts }; }

function textSlots(content: RecipeContent): Map<string, { get(): TextValue | 'off' | undefined; set(value: TextValue): void }> {
  const slots = new Map<string, { get(): TextValue | 'off' | undefined; set(value: TextValue): void }>();
  for (const key of ['system', 'steering'] as const) slots.set(key, { get: () => content[key], set: (value) => { content[key] = value; } });
  slots.set('anchor', { get: () => content.anchor === 'off' ? 'off' : content.anchor?.content, set: (value) => { if (typeof content.anchor === 'object') content.anchor.content = value; } });
  for (const [source, setting] of Object.entries(content.steering_sources ?? {})) slots.set(`steering_sources.${source}`, {
    get: () => setting.custom?.steering,
    set: (value) => { if (setting.custom !== undefined) setting.custom.steering = value; },
  });
  return slots;
}

function declarationSlots(declaration: RecipeDeclaration) {
  const slots = new Map<string, { get(): TextValue | 'off' | undefined; set(value: TextValue): void }>();
  for (const branch of ['common', 'main', 'independent'] as const) {
    const content = branch === 'common' ? declaration : declaration[branch];
    if (typeof content !== 'object') continue;
    for (const [slot, access] of textSlots(content)) slots.set(`${branch}.${slot}`, access);
  }
  return slots;
}

interface Heading { title: string; level: number; start: number; body: number }
function markdownHeadings(text: string): Heading[] {
  const lines = text.split('\n');
  const headings: Heading[] = [];
  let offset = 0; let fence: { character: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== undefined) {
      if (marker !== null && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined;
      offset += line.length + 1; continue;
    }
    if (marker !== null && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }; offset += line.length + 1; continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[\t ]+(.*?)|[\t ]*)\r?$/u.exec(line);
    if (atx !== null) headings.push({ title: (atx[2] ?? '').replace(/[\t ]+#+[\t ]*$/u, '').trim(), level: atx[1]!.length, start: offset, body: offset + line.length + 1 });
    else if (line.trim() !== '' && !/^ {4}|^\t/u.test(line) && index + 1 < lines.length) {
      const setext = /^ {0,3}(=+|-+)[\t ]*\r?$/u.exec(lines[index + 1]!);
      if (setext !== null) { headings.push({ title: line.trim(), level: setext[1]![0] === '=' ? 1 : 2, start: offset, body: offset + line.length + lines[index + 1]!.length + 2 }); offset += line.length + 1; index++; }
    }
    offset += lines[index]!.length + 1;
  }
  return headings;
}

function joinBlocks(...blocks: string[]): string {
  return blocks.filter((block) => block !== '').reduce((left, right) => {
    if (left === '') return right;
    const trailing = /(?:\r?\n)*$/u.exec(left)![0].match(/\n/gu)?.length ?? 0;
    const leading = /^(?:\r?\n)*/u.exec(right)![0].match(/\n/gu)?.length ?? 0;
    return left + '\n'.repeat(Math.max(0, 2 - trailing - leading)) + right;
  }, '');
}
function patchSection(text: string, patch: RecipeTextPatch, option: string): string {
  const headings = markdownHeadings(text);
  const matches = headings.filter((heading) => heading.title === patch.section);
  if (matches.length !== 1) recipeFailure(`Recipe option '${option}' section '${patch.section}' matched ${matches.length} headings; expected exactly one`, undefined, `options.${option}.patch.${patch.section}`);
  const heading = matches[0]!;
  const end = headings.find((next) => next.start > heading.start && next.level <= heading.level)?.start ?? text.length;
  const before = text.slice(0, heading.start); const after = text.slice(end);
  const content = patch.content?.text ?? '';
  switch (patch.action) {
    case 'before': return joinBlocks(before, content, text.slice(heading.start));
    case 'after': return joinBlocks(text.slice(0, end), content, after);
    case 'replace': return joinBlocks(before, content, after);
    case 'remove': return joinBlocks(before, after);
    case 'prepend': return joinBlocks(text.slice(0, heading.body), content, text.slice(heading.body));
    case 'append': return joinBlocks(text.slice(0, end), content, after);
  }
}

export function evaluateRecipeOptions(declaration: RecipeDeclaration, selection: RecipeOptionValues = {}): {
  declaration: RecipeDeclaration; options?: RecipeOption[]; option_values?: RecipeOptionValues; diagnostics?: RecipeDiagnostic[];
} {
  const result = structuredClone(declaration);
  const definitions = declaration.options;
  const values = Object.fromEntries(recipeOptionEntries(declaration).map(([id, option]) => [id, selection[id] ?? option.default]));
  const diagnostics = Object.keys(selection).filter((id) => !Object.hasOwn(definitions ?? {}, id)).map((id) => ({ code: 'recipe-option-unknown', message: `Recipe option '${id}' is no longer declared and was ignored.`, path: `recipe_options.${id}` }));
  const slots = declarationSlots(result);
  const additions = new Map<string, { prepend: RecipeTextPart[]; append: RecipeTextPart[] }>();
  for (const [id, option] of recipeOptionEntries(declaration)) for (const patch of option.patch ?? []) {
    const access = slots.get(patch.slot); const value = access?.get();
    if (value === undefined || value === 'off') recipeFailure(`Recipe option '${id}' targets missing or off slot '${patch.slot}'`, undefined, `options.${id}.patch.${patch.slot}`);
    if (patch.section !== undefined) continue;
    const parts = recipeTextParts(patch.content!).map((part) => ({ ...part, when: id }));
    const target = additions.get(patch.slot) ?? { prepend: [], append: [] };
    if (patch.action === 'prepend') target.prepend.push(...parts); else target.append.push(...parts);
    additions.set(patch.slot, target);
  }
  for (const [slot, access] of slots) {
    const value = access.get(); if (value === undefined || value === 'off') continue;
    const extra = additions.get(slot);
    const parts = [...extra?.prepend ?? [], ...recipeTextParts(value), ...extra?.append ?? []];
    for (const part of parts) for (const id of [part.when, part.unless]) if (id !== undefined && !Object.hasOwn(definitions ?? {}, id)) recipeFailure(`Recipe gate references undeclared option '${id}'`, part.origins[0]?.source, slot);
    const kept = parts.filter((part) => (part.when === undefined || values[part.when] === true) && (part.unless === undefined || values[part.unless] === false));
    access.set({ text: kept.map((part) => part.text).join('\n\n'), origins: kept.flatMap((part) => part.origins) });
  }
  for (const [id, option] of recipeOptionEntries(declaration)) if (values[id]) for (const patch of option.patch ?? []) {
    if (patch.section === undefined) continue;
    const access = slots.get(patch.slot)!; const value = access.get() as TextValue;
    access.set({ text: patchSection(value.text, patch, id), origins: [...value.origins, ...patch.content?.origins ?? []] });
  }
  return { declaration: result, options: definitions === undefined ? undefined : recipeOptionEntries(declaration).map(([id, option]) => ({ id, name: option.name, description: option.description, default: option.default })),
    option_values: definitions === undefined ? undefined : values, diagnostics: diagnostics.length === 0 ? undefined : diagnostics };
}
