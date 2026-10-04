import { isAbsolute, normalize } from 'pathe';
import { z } from 'zod';

export type PromptDelegationPosition = 'main' | 'sub' | 'independent';
export type PromptIdentityBranch<T> = 'same' | 'off' | T;

export interface PromptOverrideContent {
  readonly files?: readonly string[];
  readonly fields?: Readonly<Record<string, string>>;
}

export interface PromptOverrides extends PromptOverrideContent {
  readonly main?: PromptIdentityBranch<PromptOverrideContent>;
  readonly independent?: PromptIdentityBranch<PromptOverrideContent>;
}

const PromptOverridePathSchema = z.string().trim().min(1).refine((value) => {
  try { validatePromptOverridePath(value); return true; } catch { return false; }
}, { message: 'Prompt override paths must be relative to and inside the Kiki home directory' });
const PromptOverrideContentSchema = z.object({
  files: z.array(PromptOverridePathSchema).optional(),
  fields: z.record(z.string(), z.string()).optional(),
}).strict();
const hasPromptOverrideContent = (value: PromptOverrideContent): boolean =>
  (value.files?.length ?? 0) > 0 || Object.keys(value.fields ?? {}).length > 0;
const PromptOverrideBranchSchema = z.union([
  z.enum(['same', 'off']),
  PromptOverrideContentSchema.refine(hasPromptOverrideContent, { message: 'Set files or fields, or use off' }),
]);
export const PromptOverridesSchema: z.ZodType<PromptOverrides> = PromptOverrideContentSchema.extend({
  main: PromptOverrideBranchSchema.optional(),
  independent: PromptOverrideBranchSchema.optional(),
}).superRefine((value, ctx) => {
  for (const position of ['main', 'independent'] as const) {
    if (value[position] === 'same' && !hasPromptOverrideContent(value)) {
      ctx.addIssue({ code: 'custom', path: [position], message: 'same requires common files or fields' });
    }
  }
});

export function selectPromptIdentityContent<T>(
  common: T | undefined,
  branch: PromptIdentityBranch<T> | undefined,
): T | undefined {
  if (branch === 'off') return undefined;
  return branch === undefined || branch === 'same' ? common : branch;
}

export function selectPromptOverrides(
  overrides: PromptOverrides,
  position: PromptDelegationPosition = 'main',
): PromptOverrideContent | undefined {
  return selectPromptIdentityContent(
    { files: overrides.files, fields: overrides.fields },
    position === 'sub' ? undefined : overrides[position],
  );
}

export const PromptOverrideDocumentSchema = z.object({
  schema_version: z.literal(1),
  fields: z.record(z.string(), z.string()),
}).strict();

export interface PromptOverrideDocument {
  readonly schema_version: 1;
  readonly fields: Readonly<Record<string, string>>;
}

export type PromptOverrideSurface =
  | 'global'
  | 'model'
  | 'profile'
  | 'profile-model'
  | 'caller-lease-model'
  | 'system';

export interface PromptOverrideSource {
  readonly surface: PromptOverrideSurface;
  readonly kind: 'file' | 'inline';
  readonly path?: string;
  readonly fileIndex?: number;
  readonly line?: number;
  readonly selection?: 'common' | 'main' | 'independent';
  readonly declarationIndex?: number;
}

export interface ResolvedPromptOverrides {
  readonly values: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, readonly PromptOverrideSource[]>>;
}

export interface PromptOverrideFieldPolicy {
  readonly allowEmpty: boolean;
}

export interface ResolvePromptOverrideLayerInput {
  readonly surface: PromptOverrideSurface;
  readonly files?: readonly {
    readonly ref: string;
    readonly document: PromptOverrideDocument;
    readonly lines?: Readonly<Record<string, number>>;
  }[];
  readonly inline?: Readonly<Record<string, string>>;
  readonly fieldPolicy?: (id: string) => PromptOverrideFieldPolicy | undefined;
  readonly inlinePath?: string;
}

export class PromptOverrideParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PromptOverrideParseError';
  }
}

export function parsePromptOverrides(value: unknown, location: string): PromptOverrides {
  const result = PromptOverridesSchema.safeParse(value);
  if (!result.success) {
    throw new PromptOverrideParseError(`Invalid prompt overrides in ${location}: ${result.error.issues[0]?.message ?? 'validation failed'}`, result.error);
  }
  return result.data;
}

export function validatePromptOverridePath(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new PromptOverrideParseError('Prompt override file path must not be empty');
  }
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    throw new PromptOverrideParseError(`Prompt override file path "${trimmed}" must be relative to the Kiki home directory`);
  }
  if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new PromptOverrideParseError(`Prompt override file path "${trimmed}" must not contain directory traversal`);
  }
  const normalized = normalize(trimmed.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new PromptOverrideParseError(`Prompt override file path "${trimmed}" escapes the Kiki home directory`);
  }
  return normalized;
}

export function parsePromptOverrideDocument(
  value: unknown,
  options: { readonly path: string; readonly text?: string },
): { readonly document: PromptOverrideDocument; readonly lines: Readonly<Record<string, number>> } {
  const result = PromptOverrideDocumentSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path.length === 0 ? '' : ` at ${issue?.path.join('.')}`;
    throw new PromptOverrideParseError(
      `Invalid prompt override TOML ${options.path}${at}: ${issue?.message ?? 'validation failed'}`,
      result.error,
    );
  }
  return {
    document: result.data,
    lines: options.text === undefined ? {} : promptOverrideFieldLines(options.text),
  };
}

export function resolvePromptOverrideLayer(input: ResolvePromptOverrideLayerInput): ResolvedPromptOverrides {
  const values = new Map<string, string>();
  const sources = new Map<string, PromptOverrideSource[]>();
  const assign = (fields: Readonly<Record<string, string>>, source: PromptOverrideSource, lines?: Readonly<Record<string, number>>): void => {
    for (const [id, value] of Object.entries(fields)) {
      validateEmptyValue(id, value, input.fieldPolicy);
      values.set(id, value);
      const chain = sources.get(id) ?? [];
      chain.push({ ...source, line: lines?.[id] });
      sources.set(id, chain);
    }
  };
  for (const [fileIndex, file] of (input.files ?? []).entries()) {
    assign(file.document.fields, {
      surface: input.surface,
      kind: 'file',
      path: file.ref,
      fileIndex,
    }, file.lines);
  }
  if (input.inline !== undefined) {
    assign(input.inline, {
      surface: input.surface,
      kind: 'inline',
      path: input.inlinePath,
    });
  }
  return {
    values: Object.fromEntries(values),
    sources: Object.fromEntries(sources),
  };
}

export function mergeResolvedPromptOverrides(
  ...layers: readonly (ResolvedPromptOverrides | undefined)[]
): ResolvedPromptOverrides {
  const values = new Map<string, string>();
  const sources = new Map<string, PromptOverrideSource[]>();
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const [id, value] of Object.entries(layer.values)) {
      values.set(id, value);
      sources.set(id, [...(sources.get(id) ?? []), ...(layer.sources[id] ?? [])]);
    }
  }
  return {
    values: Object.fromEntries(values),
    sources: Object.fromEntries(sources),
  };
}

function validateEmptyValue(
  id: string,
  value: string,
  fieldPolicy: ResolvePromptOverrideLayerInput['fieldPolicy'],
): void {
  if (value.length !== 0) return;
  const policy = fieldPolicy?.(id);
  if (policy !== undefined && !policy.allowEmpty) {
    throw new PromptOverrideParseError(`Prompt field "${id}" does not allow an empty override`);
  }
}

function promptOverrideFieldLines(text: string): Readonly<Record<string, number>> {
  const lines = new Map<string, number>();
  let inFields = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inFields = line === '[fields]';
      continue;
    }
    if (!inFields || line === '' || line.startsWith('#')) continue;
    const match = /^(?:"([^"]+)"|'([^']+)'|([^=\s]+))\s*=/.exec(line);
    const key = match?.[1] ?? match?.[2] ?? match?.[3];
    if (key !== undefined && !lines.has(key)) lines.set(key, index + 1);
  }
  return Object.fromEntries(lines);
}
