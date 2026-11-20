import { escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';

import type {
  SkillCatalog,
  SkillDefinition,
  SkillMetadata,
  SkillSource,
  SkippedSkill,
} from './types';
import { isInlineSkillType, normalizeSkillName } from './types';

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

export const MODEL_SKILL_LISTING_LIMIT_ENV = 'KIKI_MODEL_SKILL_LISTING_LIMIT';
export const DEFAULT_MODEL_SKILL_LISTING_LIMIT = 128;
export const MODEL_SKILL_LISTING_MAX_CHARS_ENV = 'KIKI_MODEL_SKILL_LISTING_MAX_CHARS';
export const DEFAULT_MODEL_SKILL_LISTING_MAX_CHARS = 32_768;

function resolvePositiveLimit(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class InMemorySkillCatalog implements SkillCatalog {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly commands = new Map<string, SkillDefinition>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  private readonly disabledNames = new Set<string>();
  private readonly roots: string[] = [];
  private readonly rootSet = new Set<string>();
  private readonly skipped: SkippedSkill[] = [];
  private cachedCommands: { readonly list: readonly SkillDefinition[]; readonly byName: ReadonlyMap<string, SkillDefinition> } | undefined;
  private cachedAllSkills: readonly SkillDefinition[] | undefined;
  private cachedEnabledSkills: readonly SkillDefinition[] | undefined;

  private invalidateDerivedCaches(): void {
    this.cachedCommands = undefined;
    this.cachedAllSkills = undefined;
    this.cachedEnabledSkills = undefined;
  }

  setDisabledSkills(names: Iterable<string>): void {
    this.disabledNames.clear();
    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed !== '') this.disabledNames.add(normalizeSkillName(trimmed));
    }
    this.cachedEnabledSkills = undefined;
  }

  isSkillDisabled(name: string): boolean {
    return this.disabledNames.has(normalizeSkillName(name));
  }

  private isDisabledDefinition(skill: SkillDefinition): boolean {
    if (this.disabledNames.size === 0) return false;
    if (this.disabledNames.has(normalizeSkillName(skill.name))) return true;
    return skill.metadata.name !== undefined && this.disabledNames.has(normalizeSkillName(skill.metadata.name));
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const command = skill.metadata.promptCommand === true;
    const name = command ? skill.metadata.name ?? skill.name : skill.name;
    const key = normalizeSkillName(name);
    const target = command ? this.commands : this.byName;
    if (options.replace === true || !target.has(key)) {
      target.set(key, name === skill.name ? skill : { ...skill, name });
      this.invalidateDerivedCaches();
    }
    this.indexPluginSkill(skill, options);
  }

  recordSkipped(skills: readonly SkippedSkill[]): void {
    this.skipped.push(...skills);
  }

  addRoots(roots: readonly string[]): void {
    for (const root of roots) {
      if (!this.rootSet.has(root)) {
        this.rootSet.add(root);
        this.roots.push(root);
      }
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    const key = normalizeSkillName(name);
    const found = this.byName.get(key) ?? this.resolvedCommands().byName.get(key);
    return found !== undefined && !this.isDisabledDefinition(found) ? found : undefined;
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    const found = this.byPluginAndName.get(pluginSkillKey(pluginId, name));
    return found !== undefined && !this.isDisabledDefinition(found) ? found : undefined;
  }

  renderSkillPrompt(
    skill: SkillDefinition,
    rawArgs: string,
    context?: { readonly sessionId?: string },
  ): string {
    const argumentNames = skillArgumentNames(skill.metadata);
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: context?.sessionId,
      argumentNames,
    });
    const plugin = skill.plugin;
    if (plugin === undefined) return content;
    const instructions = plugin.instructions;
    if (instructions === undefined || instructions.trim().length === 0) return content;
    return (
      `<plugin-instructions plugin="${escapeXmlAttr(plugin.id)}">\n` +
      `${instructions}\n` +
      `</plugin-instructions>\n\n${content}`
    );
  }

  listAllSkills(): readonly SkillDefinition[] {
    if (this.cachedAllSkills !== undefined) return this.cachedAllSkills;
    const combined = [...this.byName.values(), ...this.resolvedCommands().list];
    combined.sort((a, b) => a.name.localeCompare(b.name));
    this.cachedAllSkills = combined;
    return combined;
  }

  listSkills(): readonly SkillDefinition[] {
    if (this.cachedEnabledSkills !== undefined) return this.cachedEnabledSkills;
    const all = this.listAllSkills();
    this.cachedEnabledSkills =
      this.disabledNames.size === 0
        ? all
        : all.filter((skill) => !this.isDisabledDefinition(skill));
    return this.cachedEnabledSkills;
  }

  private resolvedCommands(): {
    readonly list: readonly SkillDefinition[];
    readonly byName: ReadonlyMap<string, SkillDefinition>;
  } {
    if (this.cachedCommands !== undefined) return this.cachedCommands;
    if (this.commands.size === 0) {
      this.cachedCommands = { list: [], byName: new Map() };
      return this.cachedCommands;
    }
    const occupied = new Set([...this.byName.keys(), ...this.commands.keys()]);
    const list: SkillDefinition[] = [];
    const byName = new Map<string, SkillDefinition>();
    for (const skill of this.commands.values()) {
      let name = skill.name;
      if (this.byName.has(normalizeSkillName(name))) {
        do { name = `command:${name}`; } while (occupied.has(normalizeSkillName(name)));
        occupied.add(normalizeSkillName(name));
      }
      const entry =
        name === skill.name
          ? skill
          : { ...skill, name, metadata: { ...skill.metadata, name: skill.name } };
      list.push(entry);
      byName.set(normalizeSkillName(entry.name), entry);
    }
    this.cachedCommands = { list, byName };
    return this.cachedCommands;
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) =>
        skill.metadata.disableModelInvocation !== true && isInlineSkillType(skill.metadata.type),
    );
  }

  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  getKimiSkillsDescription(): string {
    const rendered = renderGroupedSkills(this.listSkills(), formatFullSkill);
    return rendered.length === 0 ? 'No skills' : rendered;
  }

  getModelSkillListing(): string {
    const header = 'Current available skills replace earlier listings. Invoke Skill by the listed name; its result supplies the resolved source path and full instructions.';
    const eligible = this.listInvocableSkills().filter((skill) => skill.metadata.isSubSkill !== true);
    if (eligible.length === 0) return '';
    const maxSkills = resolvePositiveLimit(
      MODEL_SKILL_LISTING_LIMIT_ENV,
      DEFAULT_MODEL_SKILL_LISTING_LIMIT,
    );
    const maxChars = resolvePositiveLimit(
      MODEL_SKILL_LISTING_MAX_CHARS_ENV,
      DEFAULT_MODEL_SKILL_LISTING_MAX_CHARS,
    );
    const rendered = renderBoundedGroupedSkills(eligible, formatModelSkill, maxSkills, maxChars, header.length + 1);
    if (rendered.text.length === 0) return '';
    const lines = [header, rendered.text];
    if (rendered.omitted > 0) {
      lines.push(`... and ${rendered.omitted} more available skills omitted; invoke any known skill by its exact name via Skill.`);
    }
    return lines.join('\n');
  }

  private indexPluginSkill(
    skill: SkillDefinition,
    options: { readonly replace?: boolean } = {},
  ): void {
    if (skill.plugin === undefined) return;
    const key = pluginSkillKey(skill.plugin.id, skill.name);
    if (options.replace === true || !this.byPluginAndName.has(key)) {
      this.byPluginAndName.set(key, skill);
    }
  }
}

interface SkillExpandContext {
  readonly skillDir: string;
  readonly sessionId?: string;
  readonly argumentNames?: readonly string[];
}

function expandSkillParameters(
  body: string,
  rawArgs: string,
  context: SkillExpandContext,
): string {
  const tokens = tokenizeArgs(rawArgs);
  const named = new Map((context.argumentNames ?? []).map((name, index) => [name, tokens[index] ?? '']));
  const names = [...named.keys()].map(escapeRegExp).join('|');
  const pattern = new RegExp(
    '\\$\\{KIKI_SKILL_DIR\\}|\\$\\{KIKI_SESSION_ID\\}|\\$ARGUMENTS\\[(\\d+)\\]|\\$ARGUMENTS(?![\\w\\[])|\\$(\\d+)(?!\\w)'
      + (names === '' ? '' : `|\\$(${names})(?![\\[\\w])`),
    'g',
  );
  let hasArgumentPlaceholder = false;
  const content = body.replaceAll(pattern, (match: string, indexed: string | undefined, positional: string | undefined, name: string | undefined) => {
    if (match === '${KIKI_SKILL_DIR}') return context.skillDir;
    if (match === '${KIKI_SESSION_ID}') return context.sessionId ?? '';
    hasArgumentPlaceholder = true;
    if (match === '$ARGUMENTS') return escapeXmlTags(rawArgs);
    const index = indexed ?? positional;
    return escapeXmlTags(index !== undefined ? tokens[Number.parseInt(index, 10)] ?? '' : named.get(name ?? '') ?? '');
  });

  if (!hasArgumentPlaceholder && rawArgs.length > 0) {
    return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`;
  }
  return content;
}

function skillArgumentNames(metadata: SkillMetadata): readonly string[] {
  const value = metadata.arguments;
  const isValidName = (name: string): boolean =>
    name.trim() !== '' && !/^\d+$/.test(name);
  if (typeof value === 'string') return value.split(/\s+/).filter(isValidName);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && isValidName(item));
}

function pluginSkillKey(pluginId: string, skillName: string): string {
  return `${pluginId}\0${normalizeSkillName(skillName)}`;
}

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'builtin', label: 'Built-in' },
];

function groupSkillsBySource(
  skills: readonly SkillDefinition[],
): ReadonlyMap<SkillSource, SkillDefinition[]> {
  const bySource = new Map<SkillSource, SkillDefinition[]>();
  for (const skill of skills) {
    let list = bySource.get(skill.source);
    if (list === undefined) {
      list = [];
      bySource.set(skill.source, list);
    }
    list.push(skill);
  }
  return bySource;
}

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const bySource = groupSkillsBySource(skills);
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = bySource.get(group.source);
    if (groupSkills === undefined || groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) {
      lines.push(...format(skill));
    }
  }
  return lines.join('\n');
}

function renderBoundedGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
  maxSkills: number,
  maxChars: number,
  baseChars: number,
): { readonly text: string; readonly omitted: number } {
  const bySource = groupSkillsBySource(skills);
  const lines: string[] = [];
  let included = 0;
  let totalChars = baseChars;
  let totalEligible = 0;
  for (const group of SOURCE_GROUPS) {
    const groupSkills = bySource.get(group.source);
    if (groupSkills === undefined || groupSkills.length === 0) continue;
    totalEligible += groupSkills.length;
  }
  for (const group of SOURCE_GROUPS) {
    if (included >= maxSkills) break;
    const groupSkills = bySource.get(group.source);
    if (groupSkills === undefined || groupSkills.length === 0) continue;
    const heading = `### ${group.label}`;
    let headingEmitted = false;
    for (const skill of groupSkills) {
      if (included >= maxSkills) break;
      const entryLines = format(skill);
      const entryChars = entryLines.reduce((sum, line) => sum + line.length + 1, 0);
      const headingChars = headingEmitted ? 0 : heading.length + 1;
      if (included > 0 && totalChars + headingChars + entryChars > maxChars) {
        return { text: lines.join('\n'), omitted: totalEligible - included };
      }
      if (!headingEmitted) {
        lines.push(heading);
        totalChars += heading.length + 1;
        headingEmitted = true;
      }
      lines.push(...entryLines);
      totalChars += entryChars;
      included += 1;
    }
  }
  return { text: lines.join('\n'), omitted: Math.max(0, totalEligible - included) };
}

function formatFullSkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}`, `  - Path: ${skill.path}`, `  - Description: ${skill.description}`];
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const lines = [`- ${skill.name}: ${skill.description}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0 && skill.metadata.whenToUse !== skill.description) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  return lines;
}

function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasContent = false;

  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
        hasContent = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (hasContent) out.push(current);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
