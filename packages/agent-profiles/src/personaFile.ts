import { dump as dumpYaml } from 'js-yaml';

import { FrontmatterError, parseFrontmatter } from './frontmatter';

export const PERSONA_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PERSONA_FRONTMATTER_KEYS = [
  'name',
  'title',
  'job',
  'profile',
  'model_alias',
  'thinking_effort',
  'greeting',
  'greetings',
  'room_greeting',
  'delivery',
  'memory',
  'skills',
  'tags',
  'notes',
  'home_workspace',
] as const;

export type PersonaDelivery = 'reply' | 'message';
export type PersonaSharedMemoryScope = 'global' | 'workspace';

export interface PersonaMemoryDefinition {
  readonly shared: readonly PersonaSharedMemoryScope[];
}

export interface PersonaDefinition {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly job?: string;
  readonly profile?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly greeting?: string;
  readonly greetings?: readonly string[];
  readonly roomGreeting?: string;
  readonly delivery?: PersonaDelivery;
  readonly memory?: PersonaMemoryDefinition;
  readonly skills?: readonly string[];
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly homeWorkspace?: string;
  readonly description: string;
}

export interface PersonaSnapshot {
  readonly definition: PersonaDefinition;
  readonly revision: string;
  readonly examples?: string;
}

export interface ParsePersonaFileOptions {
  readonly path: string;
  readonly text: string;
  readonly id?: string;
}

export class PersonaFileParseError extends Error {
  readonly code = 'persona.validation_failed';
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PersonaFileParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export function parsePersonaFileText(options: ParsePersonaFileOptions): PersonaDefinition {
  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new PersonaFileParseError(`Invalid frontmatter in ${options.path}: ${error.message}`, error);
    }
    throw error;
  }
  if (parsed.data === null) throw new PersonaFileParseError(`Missing frontmatter in ${options.path}`);
  if (!isRecord(parsed.data)) {
    throw new PersonaFileParseError(`Frontmatter in ${options.path} must be a mapping at the top level`);
  }
  for (const key of Object.keys(parsed.data)) {
    if (!(PERSONA_FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      const suffix = isPermissionKey(key) ? '; permissions belong to the referenced profile' : '';
      throw new PersonaFileParseError(
        `Unknown frontmatter field "${key}" in ${options.path}; persona files have a closed key set${suffix}`,
      );
    }
  }
  const id = options.id ?? derivePersonaIdFromPath(options.path);
  if (!PERSONA_ID_PATTERN.test(id)) {
    throw new PersonaFileParseError(`Invalid persona id "${id}" in ${options.path}: expected kebab-case`);
  }
  const name = requiredString(parsed.data['name'], 'name', options.path);
  const description = parsed.body.trim();
  if (description.length === 0) throw new PersonaFileParseError(`Missing persona description body in ${options.path}`);
  const memory = parseMemory(parsed.data['memory'], options.path);
  const definition: PersonaDefinition = {
    id,
    name,
    title: optionalString(parsed.data['title'], 'title', options.path),
    job: optionalString(parsed.data['job'], 'job', options.path),
    profile: optionalString(parsed.data['profile'], 'profile', options.path),
    modelAlias: optionalString(parsed.data['model_alias'], 'model_alias', options.path),
    thinkingEffort: optionalString(parsed.data['thinking_effort'], 'thinking_effort', options.path),
    greeting: optionalString(parsed.data['greeting'], 'greeting', options.path),
    greetings: parseStringList(parsed.data['greetings'], 'greetings', options.path),
    roomGreeting: optionalString(parsed.data['room_greeting'], 'room_greeting', options.path),
    delivery: parseDelivery(parsed.data['delivery'], options.path),
    memory,
    skills: parseStringList(parsed.data['skills'], 'skills', options.path),
    tags: parseStringList(parsed.data['tags'], 'tags', options.path),
    notes: optionalString(parsed.data['notes'], 'notes', options.path),
    homeWorkspace: optionalString(parsed.data['home_workspace'], 'home_workspace', options.path),
    description,
  };
  return removeUndefined(definition);
}

export function serializePersonaFile(definition: PersonaDefinition): string {
  if (!PERSONA_ID_PATTERN.test(definition.id)) throw new PersonaFileParseError(`Invalid persona id "${definition.id}"`);
  const parsed = parsePersonaFileText({
    path: `personas/${definition.id}/persona.md`,
    id: definition.id,
    text: buildPersonaFile(definition),
  });
  return buildPersonaFile(parsed);
}

export function derivePersonaIdFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  const file = segments.at(-1) ?? '';
  if (file === 'persona.md' && segments.length > 1) return segments.at(-2)!;
  const stem = file.replace(/\.[^.]*$/, '');
  return stem;
}

function buildPersonaFile(definition: PersonaDefinition): string {
  const frontmatter: Record<string, unknown> = {
    name: definition.name,
    title: definition.title,
    job: definition.job,
    profile: definition.profile,
    model_alias: definition.modelAlias,
    thinking_effort: definition.thinkingEffort,
    greeting: definition.greeting,
    greetings: definition.greetings,
    room_greeting: definition.roomGreeting,
    delivery: definition.delivery,
    memory: definition.memory,
    skills: definition.skills,
    tags: definition.tags,
    notes: definition.notes,
    home_workspace: definition.homeWorkspace,
  };
  for (const key of Object.keys(frontmatter)) {
    if (frontmatter[key] === undefined) delete frontmatter[key];
  }
  const yaml = dumpYaml(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
  return `---\n${yaml}\n---\n${definition.description.trim()}\n`;
}

function parseMemory(value: unknown, path: string): PersonaMemoryDefinition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new PersonaFileParseError(`Frontmatter field "memory" in ${path} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (key !== 'shared') throw new PersonaFileParseError(`Frontmatter field "memory" in ${path} contains unknown key "${key}"`);
  }
  const shared = parseStringList(value['shared'], 'memory.shared', path);
  if (shared === undefined) throw new PersonaFileParseError(`Frontmatter field "memory.shared" in ${path} is required`);
  for (const item of shared) {
    if (item !== 'global' && item !== 'workspace') {
      throw new PersonaFileParseError(`Frontmatter field "memory.shared" in ${path} must contain global or workspace`);
    }
  }
  return { shared: unique(shared) as readonly PersonaSharedMemoryScope[] };
}

function parseDelivery(value: unknown, path: string): PersonaDelivery | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'reply' || value === 'message') return value;
  throw new PersonaFileParseError(`Frontmatter field "delivery" in ${path} must be reply or message`);
}

function parseStringList(value: unknown, field: string, path: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    if (typeof value === 'string' && value.trim() !== '') return value.split(',').map((item) => item.trim()).filter(Boolean);
    throw new PersonaFileParseError(`Frontmatter field "${field}" in ${path} must be a list of non-empty strings`);
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PersonaFileParseError(`Frontmatter field "${field}" in ${path} must be a list of non-empty strings`);
    }
    values.push(item.trim());
  }
  return unique(values);
}

function requiredString(value: unknown, field: string, path: string): string {
  const result = optionalString(value, field, path);
  if (result === undefined) throw new PersonaFileParseError(`Missing required frontmatter field "${field}" in ${path}`);
  return result;
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PersonaFileParseError(`Frontmatter field "${field}" in ${path} must be a non-empty string`);
  }
  return value.trim();
}

function isPermissionKey(key: string): boolean {
  return key === 'tools' || key === 'disallowedTools' || key === 'disabled-tool-groups' || key === 'subagents' || key === 'allowed_subagents' || key === 'preferred_subagents' || key === 'deny_subagents' || key === 'can_spawn_subagents' || key === 'executor';
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeUndefined<T extends object>(value: T): T {
  const output = { ...value } as T & Record<string, unknown>;
  for (const key of Object.keys(output)) {
    if (output[key] === undefined) delete output[key];
  }
  return output;
}
