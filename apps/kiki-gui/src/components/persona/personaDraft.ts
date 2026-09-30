/**
 * Persona editor draft — the flat form state and its round trip to the wire
 * `PersonaDefinition`. Fields the editor does not show (greetings, room
 * greeting, delivery, skills, tags, notes, home workspace) ride along from
 * the loaded definition untouched, so saving never drops what an import or a
 * hand edit of persona.md put there.
 */

import type { PersonaDefinition, PersonaSnapshot } from '@kiki/protocol';

export const PERSONA_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type PersonaMemoryMode = 'shared' | 'own';

export interface PersonaDraft {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly job: string;
  /** '' = the default main profile. */
  readonly profile: string;
  /** '' = follow the profile's pin. */
  readonly modelAlias: string;
  /** '' = follow the model. */
  readonly thinkingEffort: string;
  readonly greeting: string;
  readonly description: string;
  readonly memory: PersonaMemoryMode;
}

export const EMPTY_PERSONA_DRAFT: PersonaDraft = {
  id: '',
  name: '',
  title: '',
  job: '',
  profile: '',
  modelAlias: '',
  thinkingEffort: '',
  greeting: '',
  description: '',
  memory: 'shared',
};

export function draftFromDefinition(definition: PersonaDefinition): PersonaDraft {
  return {
    id: definition.id,
    name: definition.name,
    title: definition.title ?? '',
    job: definition.job ?? '',
    profile: definition.profile ?? '',
    modelAlias: definition.modelAlias ?? '',
    thinkingEffort: definition.thinkingEffort ?? '',
    greeting: definition.greeting ?? '',
    description: definition.description,
    // `shared: []` is the only "own memory only" spelling; absent means the default pair.
    memory: definition.memory !== undefined && definition.memory.shared.length === 0 ? 'own' : 'shared',
  };
}

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Merge the draft over the loaded definition (or build a new one). */
export function definitionFromDraft(draft: PersonaDraft, base?: PersonaDefinition): PersonaDefinition {
  const { title: _title, job: _job, profile: _profile, modelAlias: _model, thinkingEffort: _effort, greeting: _greeting, memory: _memory, ...kept } = base ?? {} as Partial<PersonaDefinition>;
  const title = optional(draft.title);
  const job = optional(draft.job);
  const profile = optional(draft.profile);
  const modelAlias = optional(draft.modelAlias);
  const thinkingEffort = optional(draft.thinkingEffort);
  // The greeting is shown verbatim, so only a blank one is dropped.
  const greeting = draft.greeting.trim() === '' ? undefined : draft.greeting;
  return {
    ...kept,
    id: base?.id ?? draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    ...(title !== undefined ? { title } : {}),
    ...(job !== undefined ? { job } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(modelAlias !== undefined ? { modelAlias } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(greeting !== undefined ? { greeting } : {}),
    ...(draft.memory === 'own' ? { memory: { shared: [] } } : base?.memory !== undefined && base.memory.shared.length > 0 ? { memory: base.memory } : {}),
  };
}

export function draftsEqual(a: PersonaDraft, b: PersonaDraft): boolean {
  return (Object.keys(a) as (keyof PersonaDraft)[]).every((key) => a[key] === b[key]);
}

export type PersonaDraftIssue = 'nameRequired' | 'descriptionRequired' | 'idInvalid' | 'idTaken';

export function validatePersonaDraft(
  draft: PersonaDraft,
  options: { readonly creating: boolean; readonly takenIds?: ReadonlySet<string> },
): Partial<Record<'name' | 'description' | 'id', PersonaDraftIssue>> {
  const issues: Partial<Record<'name' | 'description' | 'id', PersonaDraftIssue>> = {};
  if (draft.name.trim() === '') issues.name = 'nameRequired';
  if (draft.description.trim() === '') issues.description = 'descriptionRequired';
  if (options.creating) {
    const id = draft.id.trim();
    if (!PERSONA_ID_PATTERN.test(id)) issues.id = 'idInvalid';
    else if (options.takenIds?.has(id) === true) issues.id = 'idTaken';
  }
  return issues;
}

/**
 * The id a new persona gets from its name: an ASCII slug when the name has
 * one, otherwise `persona-<6 hex>` (a Chinese name has no useful slug). The
 * suffix comes from the caller so tests stay deterministic.
 */
export function personaIdFromName(name: string, randomHex: () => string = randomSuffix): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  return slug !== '' && PERSONA_ID_PATTERN.test(slug) ? slug : `persona-${randomHex()}`;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A snapshot's avatar-ready identity, for places that hold a full snapshot. */
export function snapshotIdentity(snapshot: PersonaSnapshot): { readonly id: string; readonly name: string } {
  return { id: snapshot.definition.id, name: snapshot.definition.name };
}
