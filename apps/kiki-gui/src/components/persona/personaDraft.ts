/**
 * Persona editor draft — the flat form state and its round trip to the wire
 * `PersonaDefinition`.
 *
 * Two things this file is careful about:
 *
 *  - **Fine-grained memory policy.** A persona's `memory.shared` is a list
 *    (`['global','workspace']` is the default pair, `[]` means "own memory
 *    only", a single entry means exactly that one). The draft keeps the list,
 *    so a half-set value never collapses into a boolean and back.
 *  - **Default workspace.** The selector holds a *choice* (`ws:<id>` for a
 *    registered workspace), while the asset stores the workspace's real root
 *    directory — the same value the session routes pass to the agent as its
 *    working directory. Loading accepts either spelling: the older editor wrote
 *    a workspace id, and the service reads both.
 *
 * Fields the editor does not show (`skills`) ride along from the loaded
 * definition untouched, so saving never drops what an import or a hand edit of
 * persona.md put there.
 */

import type { PersonaDefinition, PersonaSnapshot } from '@kiki/protocol';
import { roomWorkspaceId } from '@kiki/session-core/sessions/conversationList';

export const PERSONA_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type PersonaMemoryScope = 'global' | 'workspace';
export type PersonaDeliveryMode = 'reply' | 'message';

/** The default pair a persona reads when its own policy is absent. */
export const DEFAULT_MEMORY_SHARED: readonly PersonaMemoryScope[] = ['global', 'workspace'];

/**
 * `''` = automatic (a dedicated directory under the Kiki home);
 * `ws:<id>` = a registered workspace; `path:<root>` = a directory the persona
 * already points at that matches no registered workspace.
 */
export type HomeWorkspaceChoice = string;

export const HOME_WORKSPACE_AUTO: HomeWorkspaceChoice = '';
const WORKSPACE_PREFIX = 'ws:';
const PATH_PREFIX = 'path:';

/** The workspace fields the mapping needs; the GUI's `Workspace` satisfies it. */
export interface WorkspaceRef {
  readonly id: string;
  readonly root: string;
}

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
  /** `''` | `ws:<id>` | `path:<root>` — see `HomeWorkspaceChoice`. */
  readonly homeWorkspace: HomeWorkspaceChoice;
  /** The loaded choice; unchanged choices preserve the stored root across catalog refreshes. */
  readonly initialHomeWorkspace?: HomeWorkspaceChoice;
  readonly delivery: PersonaDeliveryMode;
  readonly greeting: string;
  /** Alternate greetings, one per line as the asset stores them. */
  readonly greetings: string;
  readonly roomGreeting: string;
  /** Comma-separated tags, as the roster shows them. */
  readonly tags: string;
  readonly notes: string;
  readonly description: string;
  /** The persona's own read policy; `[]` means "own memory only". */
  readonly memoryShared: readonly PersonaMemoryScope[];
}

export const EMPTY_PERSONA_DRAFT: PersonaDraft = {
  id: '',
  name: '',
  title: '',
  job: '',
  profile: '',
  modelAlias: '',
  thinkingEffort: '',
  homeWorkspace: HOME_WORKSPACE_AUTO,
  delivery: 'reply',
  greeting: '',
  greetings: '',
  roomGreeting: '',
  tags: '',
  notes: '',
  description: '',
  memoryShared: DEFAULT_MEMORY_SHARED,
};

/**
 * The choice that reproduces a stored `homeWorkspace`: a registered workspace
 * (by root, or by id from the older editor's spelling), otherwise the stored
 * path itself, otherwise "automatic".
 */
export function homeWorkspaceChoiceOf(
  stored: string | undefined,
  workspaces: readonly WorkspaceRef[],
): HomeWorkspaceChoice {
  const value = stored?.trim() ?? '';
  if (value === '') return HOME_WORKSPACE_AUTO;
  const resolvedId = roomWorkspaceId(value, workspaces);
  if (workspaces.some((workspace) => workspace.id === resolvedId)) return `${WORKSPACE_PREFIX}${resolvedId}`;
  return `${PATH_PREFIX}${value}`;
}

/**
 * The value written to the asset. A registered workspace saves its **root**
 * (the path the session routes hand to the agent), never the workspace id.
 * An id that no longer resolves is written through unchanged rather than
 * dropped: the roster still shows it, and the user can repoint it.
 */
export function homeWorkspaceValueOf(
  choice: HomeWorkspaceChoice,
  workspaces: readonly WorkspaceRef[],
): string | undefined {
  if (choice === HOME_WORKSPACE_AUTO) return undefined;
  if (choice.startsWith(WORKSPACE_PREFIX)) {
    const id = choice.slice(WORKSPACE_PREFIX.length);
    if (id === '') return undefined;
    return workspaces.find((workspace) => workspace.id === id)?.root ?? id;
  }
  if (choice.startsWith(PATH_PREFIX)) {
    const path = choice.slice(PATH_PREFIX.length).trim();
    return path === '' ? undefined : path;
  }
  return undefined;
}

export function draftFromDefinition(
  definition: PersonaDefinition,
  workspaces: readonly WorkspaceRef[] = [],
): PersonaDraft {
  return {
    id: definition.id,
    name: definition.name,
    title: definition.title ?? '',
    job: definition.job ?? '',
    profile: definition.profile ?? '',
    modelAlias: definition.modelAlias ?? '',
    thinkingEffort: definition.thinkingEffort ?? '',
    homeWorkspace: homeWorkspaceChoiceOf(definition.homeWorkspace, workspaces),
    initialHomeWorkspace: homeWorkspaceChoiceOf(definition.homeWorkspace, workspaces),
    delivery: definition.delivery === 'message' ? 'message' : 'reply',
    greeting: definition.greeting ?? '',
    greetings: (definition.greetings ?? []).join('\n'),
    roomGreeting: definition.roomGreeting ?? '',
    tags: (definition.tags ?? []).join(', '),
    notes: definition.notes ?? '',
    description: definition.description,
    memoryShared: [...(definition.memory?.shared ?? DEFAULT_MEMORY_SHARED)],
  };
}

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** One entry per non-blank line. */
export function lineList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** One entry per comma, both separators people actually type. */
export function tagList(text: string): string[] {
  return text
    .split(/[,，]/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** The wire spelling of a read policy: absent for the default pair. */
export function memorySharedValueOf(
  shared: readonly PersonaMemoryScope[],
): PersonaDefinition['memory'] | undefined {
  const unique = DEFAULT_MEMORY_SHARED.filter((scope) => shared.includes(scope));
  if (unique.length === DEFAULT_MEMORY_SHARED.length) return undefined;
  return { shared: unique };
}

/** Merge the draft over the loaded definition, preserving an unchanged home value. */
export function definitionFromDraft(
  draft: PersonaDraft,
  base?: PersonaDefinition,
  workspaces: readonly WorkspaceRef[] = [],
): PersonaDefinition {
  const {
    title: _title,
    job: _job,
    profile: _profile,
    modelAlias: _model,
    thinkingEffort: _effort,
    homeWorkspace: _homeWorkspace,
    delivery: _delivery,
    greeting: _greeting,
    greetings: _greetings,
    roomGreeting: _roomGreeting,
    tags: _tags,
    notes: _notes,
    memory: _memory,
    ...kept
  } = base ?? ({} as Partial<PersonaDefinition>);

  const title = optional(draft.title);
  const job = optional(draft.job);
  const profile = optional(draft.profile);
  const modelAlias = optional(draft.modelAlias);
  const thinkingEffort = optional(draft.thinkingEffort);
  const homeWorkspace = base !== undefined && draft.homeWorkspace === (draft.initialHomeWorkspace ?? homeWorkspaceChoiceOf(base.homeWorkspace, workspaces))
    ? base.homeWorkspace
    : homeWorkspaceValueOf(draft.homeWorkspace, workspaces);
  const greeting = draft.greeting.trim() === '' ? undefined : draft.greeting;
  const greetings = lineList(draft.greetings);
  const roomGreeting = optional(draft.roomGreeting);
  const tags = tagList(draft.tags);
  const notes = optional(draft.notes);
  const memory = memorySharedValueOf(draft.memoryShared);

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
    ...(homeWorkspace !== undefined ? { homeWorkspace } : {}),
    ...(draft.delivery !== 'reply' ? { delivery: draft.delivery } : {}),
    ...(greeting !== undefined ? { greeting } : {}),
    ...(greetings.length > 0 ? { greetings } : {}),
    ...(roomGreeting !== undefined ? { roomGreeting } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(memory !== undefined ? { memory } : {}),
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function draftsEqual(a: PersonaDraft, b: PersonaDraft): boolean {
  return (Object.keys(a) as (keyof PersonaDraft)[]).every((key) => {
    const left = a[key];
    const right = b[key];
    return Array.isArray(left) && Array.isArray(right)
      ? sameList(left as readonly string[], right as readonly string[])
      : left === right;
  });
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
