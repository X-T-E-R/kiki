export type PromptBranchMode = 'same' | 'off' | 'custom';
export type PromptPosition = 'main' | 'independent';
export interface PromptBranchDraft<T> {
  mode: PromptBranchMode;
  explicitSame: boolean;
  content: T;
}
export interface PromptIdentityDraft<T> {
  common: T;
  main: PromptBranchDraft<T>;
  independent: PromptBranchDraft<T>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const paths = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : '';

export function promptIdentityDraft<T>(value: unknown, read: (value: unknown) => T): PromptIdentityDraft<T> {
  const source = record(value);
  const branch = (position: PromptPosition): PromptBranchDraft<T> => ({
    mode: source[position] === 'off' ? 'off' : typeof source[position] === 'object' && source[position] !== null ? 'custom' : 'same',
    explicitSame: source[position] === 'same',
    content: read(source[position]),
  });
  return { common: read(source), main: branch('main'), independent: branch('independent') };
}

export function promptIdentityBody<T, U extends Record<string, unknown>>(draft: PromptIdentityDraft<T>, write: (value: T) => U) {
  const branch = (value: PromptBranchDraft<T>): U | 'off' | 'same' | undefined => value.mode === 'custom' ? write(value.content)
    : value.mode === 'off' ? 'off' : value.explicitSame ? 'same' : undefined;
  return { ...write(draft.common), main: branch(draft.main), independent: branch(draft.independent) };
}

export function changePromptBranch<T>(draft: PromptIdentityDraft<T>, position: PromptPosition, mode: PromptBranchMode): PromptIdentityDraft<T> {
  return { ...draft, [position]: { ...draft[position], mode, explicitSame: false } };
}

export interface PromptOverrideRow { id: string; name: string; value: string }
export interface PromptOverridesDraft { files: string; fields: PromptOverrideRow[] }
let rowId = 0;
export const newPromptOverrideRow = (): PromptOverrideRow => ({ id: `prompt-field-new-${++rowId}`, name: '', value: '' });

export function promptOverridesDraft(value: unknown): PromptOverridesDraft {
  const source = record(value);
  return {
    files: paths(source['files']),
    fields: Object.entries(record(source['fields'])).map(([name, value], index) => ({ id: `prompt-field-${index}`, name, value: text(value) })),
  };
}
export function promptOverridesBody(draft: PromptOverridesDraft) {
  const files = draft.files.split('\n').map((value) => value.trim()).filter(Boolean);
  return {
    files: files.length > 0 ? files : undefined,
    fields: draft.fields.length > 0 ? Object.fromEntries(draft.fields.map((row) => [row.name.trim(), row.value])) : undefined,
  };
}
export function promptOverridesProblem(draft: PromptOverridesDraft): 'fieldName' | 'duplicateField' | undefined {
  const names = draft.fields.map((row) => row.name.trim());
  if (names.some((name) => !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(name))) return 'fieldName';
  if (new Set(names).size !== names.length) return 'duplicateField';
  return undefined;
}

export interface CognitionDraft {
  overlay: string;
  overlayMode: '' | 'append' | 'prepend' | 'wrap' | 'persona' | 'replace';
  steering: string;
  anchor: string;
  anchorSteps: string;
  anchorScope: '' | 'session' | 'turn';
}
export function cognitionDraft(value: unknown): CognitionDraft {
  const source = record(value);
  return {
    overlay: paths(source['overlay']), overlayMode: text(source['overlay_mode']) as CognitionDraft['overlayMode'],
    steering: paths(source['steering']), anchor: paths(source['anchor']),
    anchorSteps: typeof source['anchor_steps'] === 'number' ? String(source['anchor_steps']) : text(source['anchor_steps']),
    anchorScope: text(source['anchor_scope']) as CognitionDraft['anchorScope'],
  };
}
const pathBody = (value: string): string | string[] | undefined => {
  const refs = value.split('\n').map((ref) => ref.trim()).filter(Boolean);
  return refs.length === 0 ? undefined : refs.length === 1 ? refs[0] : refs;
};
export function cognitionBody(draft: CognitionDraft) {
  return {
    overlay: pathBody(draft.overlay), overlay_mode: draft.overlayMode || undefined,
    steering: pathBody(draft.steering), anchor: pathBody(draft.anchor),
    anchor_steps: draft.anchorSteps.trim() === '' ? undefined : Number(draft.anchorSteps),
    anchor_scope: draft.anchorScope || undefined,
  };
}
export function cognitionProblem(draft: CognitionDraft): 'anchorSteps' | undefined {
  return draft.anchorSteps.trim() !== '' && (!/^\d+$/.test(draft.anchorSteps.trim()) || Number(draft.anchorSteps) < 1 || !Number.isSafeInteger(Number(draft.anchorSteps))) ? 'anchorSteps' : undefined;
}

export interface ModelPromptDraft { mode: '' | 'prepend' | 'append' | 'wrap'; prompt: string }
export function modelPromptDraft(value: unknown): ModelPromptDraft {
  const source = record(value);
  return { mode: text(source['prompt_mode']) as ModelPromptDraft['mode'], prompt: text(source['prompt']) };
}
export function modelPromptBody(draft: ModelPromptDraft) {
  return { prompt_mode: draft.mode || undefined, prompt: draft.mode !== '' || draft.prompt !== '' ? draft.prompt : undefined };
}
export function modelPromptProblem(draft: ModelPromptDraft): 'promptPair' | undefined {
  return (draft.mode === '') !== (draft.prompt === '') ? 'promptPair' : undefined;
}

export type PromptDraftProblem = 'emptyBranch' | 'missingCommon' | 'fieldName' | 'duplicateField' | 'anchorSteps' | 'promptPair';
export function promptIdentityProblem<T>(draft: PromptIdentityDraft<T>, write: (value: T) => Record<string, unknown>, validate: (value: T) => PromptDraftProblem | undefined): PromptDraftProblem | undefined {
  const hasContent = (content: T) => Object.values(write(content)).some((value) => value !== undefined);
  const commonProblem = validate(draft.common);
  if (commonProblem !== undefined) return commonProblem;
  for (const position of ['main', 'independent'] as const) {
    const branch = draft[position];
    if (branch.mode === 'same' && branch.explicitSame && !hasContent(draft.common)) return 'missingCommon';
    if (branch.mode !== 'custom') continue;
    if (!hasContent(branch.content)) return 'emptyBranch';
    const problem = validate(branch.content);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

export interface PromptTableDraft<T> {
  raw: string;
  rawActive: boolean;
  value: PromptIdentityDraft<T>;
}
export function promptTableDraft<T>(source: unknown, read: (value: unknown) => T): PromptTableDraft<T> {
  return { raw: source === undefined ? '' : JSON.stringify(source, null, 2), rawActive: false, value: promptIdentityDraft(source, read) };
}
export function updatePromptTable<T>(draft: PromptTableDraft<T>, value: PromptIdentityDraft<T>, write: (value: T) => Record<string, unknown>): PromptTableDraft<T> {
  return { ...draft, value, raw: JSON.stringify(promptIdentityBody(value, write), null, 2), rawActive: false };
}
export function promptTableText<T>(draft: PromptTableDraft<T>, write: (value: T) => Record<string, unknown>): string {
  return draft.rawActive ? draft.raw : JSON.stringify(promptIdentityBody(draft.value, write), null, 2);
}

export function modelPromptIdentityBody(draft: PromptIdentityDraft<ModelPromptDraft>) {
  return {
    ...promptIdentityBody(draft, (content) => ({ prompt_mode: content.mode || 'append' as const, prompt: content.prompt })),
    ...modelPromptBody(draft.common),
  };
}
