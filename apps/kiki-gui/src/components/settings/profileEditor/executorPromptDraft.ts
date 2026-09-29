import type { ExecutorPrompt } from '@kiki/protocol';

/**
 * The profile's `executor_prompt` as the editor holds it: the wire shape with
 * empty strings dropped, so an untouched section compares equal to the saved
 * one and saving writes only what the user set. `null` = the field is absent.
 */
export type ExecutorPromptDelivery = NonNullable<ExecutorPrompt['delivery']>;
export interface ExecutorPromptSection {
  readonly delivery?: ExecutorPromptDelivery;
  readonly include?: readonly string[];
  readonly body?: string;
  readonly append?: string;
}
export interface ExecutorPromptDraft extends ExecutorPromptSection {
  readonly per_engine?: Readonly<Record<string, ExecutorPromptSection>>;
}

export const DELIVERIES: readonly ExecutorPromptDelivery[] = ['append', 'replace', 'preamble'];
/** Context blocks in the order the server appends them (externalPrompt.ts). */
export const CONTEXT_BLOCKS = ['agents_md', 'memory_snapshot', 'skill_catalog', 'workspace_info'] as const;
export const FIELD_WILDCARDS = ['system.*', 'delegation.*'] as const;
/** Mirrors executorPromptIncludeSchema's specific-field arm. */
export const FIELD_ID_PATTERN = /^(?:system|delegation)\.[a-z][a-z0-9_.-]*$/;

function cleanSection(section: ExecutorPromptSection | undefined): ExecutorPromptSection {
  const out: { -readonly [K in keyof ExecutorPromptSection]: ExecutorPromptSection[K] } = {};
  if (section?.delivery !== undefined) out.delivery = section.delivery;
  if (section?.include !== undefined) out.include = [...section.include];
  if (section?.body !== undefined && section.body !== '') out.body = section.body;
  if (section?.append !== undefined && section.append !== '') out.append = section.append;
  return out;
}

export function executorPromptDraftFrom(value: ExecutorPrompt | undefined): ExecutorPromptDraft | null {
  if (value === undefined) return null;
  const base = cleanSection(value);
  // The base include defaults to [] on the wire; keep that implicit.
  const include = base.include !== undefined && base.include.length > 0 ? base.include : undefined;
  const perEngine = value.per_engine === undefined ? undefined
    : Object.fromEntries(Object.entries(value.per_engine).map(([id, section]) => [id, cleanSection(section)]));
  return { ...base, include, ...(perEngine !== undefined && Object.keys(perEngine).length > 0 ? { per_engine: perEngine } : {}) };
}

/** The PATCH value: `null` clears the frontmatter key when nothing is set. */
export function executorPromptBody(draft: ExecutorPromptDraft | null): ExecutorPrompt | null {
  if (draft === null) return null;
  const base = cleanSection(draft);
  const perEngine = Object.entries(draft.per_engine ?? {}).map(([id, section]) => [id, cleanSection(section)] as const);
  const empty = base.delivery === undefined && (base.include ?? []).length === 0 && base.body === undefined
    && base.append === undefined && perEngine.length === 0;
  if (empty) return null;
  return {
    ...base,
    include: [...(base.include ?? [])],
    ...(perEngine.length > 0 ? { per_engine: Object.fromEntries(perEngine.map(([id, section]) => [id, {
      ...section, ...(section.include !== undefined ? { include: [...section.include] } : {}),
    }])) } : {}),
  } as ExecutorPrompt;
}

/**
 * What the server resolves for one engine (resolveExecutorPrompt). An
 * override section replaces the base value per key.
 */
export function resolvedSection(draft: ExecutorPromptDraft | null, engineId: string): {
  readonly delivery: ExecutorPromptDelivery;
  readonly include: readonly string[];
  readonly body?: string;
  readonly append?: string;
} {
  const section = draft?.per_engine?.[engineId];
  return {
    delivery: section?.delivery ?? draft?.delivery ?? 'append',
    include: section?.include ?? draft?.include ?? [],
    body: section?.body ?? draft?.body,
    append: section?.append ?? draft?.append,
  };
}

/** Every include id is one the server's schema accepts. */
export function executorPromptIncludesValid(draft: ExecutorPromptDraft | null): boolean {
  const known = new Set<string>([...CONTEXT_BLOCKS, ...FIELD_WILDCARDS]);
  const sections = [draft, ...Object.values(draft?.per_engine ?? {})];
  return sections.every((section) => (section?.include ?? []).every((id) => known.has(id) || FIELD_ID_PATTERN.test(id)));
}

/** The server's downgrade rule (capabilities.ts resolvePromptDelivery). */
export function actualDelivery(requested: ExecutorPromptDelivery, supported: readonly ExecutorPromptDelivery[] | undefined): ExecutorPromptDelivery {
  if (supported === undefined || supported.length === 0 || supported.includes(requested)) return requested;
  return supported.includes('preamble') ? 'preamble' : supported[0]!;
}

/**
 * Blocks the server appends after the instructions, in its order: context
 * blocks first, then prompt fields. Specific ids covered by a wildcard are
 * folded into it.
 */
export function deliveredBlocks(include: readonly string[]): { readonly context: string[]; readonly fields: string[] } {
  const selected = new Set(include);
  const context = CONTEXT_BLOCKS.filter((id) => selected.has(id));
  const fields = include.filter((id) => !(CONTEXT_BLOCKS as readonly string[]).includes(id))
    .filter((id) => id.endsWith('.*') || !selected.has(`${id.split('.')[0]}.*`));
  return { context, fields };
}
