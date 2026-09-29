import { createHash } from 'node:crypto';

export const NOTE_SECTIONS = ['goal', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];
export type TodoNotes = Partial<Record<NoteSection, string>>;

export interface NotesMeta {
  readonly rev: number;
  readonly hash: string;
  readonly writtenTurn: number;
  readonly writtenStep: string;
  readonly coveredMessageId: string;
  readonly windowEpoch: number;
}

export function mergeTodoNotes(current: TodoNotes | undefined, patch: TodoNotes | null): TodoNotes | undefined {
  if (patch === null) return undefined;
  const next = { ...current };
  for (const key of NOTE_SECTIONS) {
    const text = patch[key];
    if (text === undefined) continue;
    if (text.length === 0) delete next[key];
    else next[key] = text;
  }
  if (NOTE_SECTIONS.some((key) => (next[key]?.length ?? 0) > 1_500)) {
    throw new Error('Each working notes section must be at most 1,500 characters.');
  }
  if (NOTE_SECTIONS.reduce((sum, key) => sum + (next[key]?.length ?? 0), 0) > 6_000) {
    throw new Error('Working notes must be at most 6,000 characters in total.');
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function hashTodoNotes(notes: TodoNotes | undefined): string {
  return createHash('sha256').update(JSON.stringify(NOTE_SECTIONS.map((key) => notes?.[key] ?? ''))).digest('hex').slice(0, 16);
}

export function renderTodoNotes(notes: TodoNotes | undefined): string {
  if (notes === undefined) return '';
  return NOTE_SECTIONS.flatMap((key) => notes[key] ? [`${key}: ${notes[key]}`] : []).join('\n');
}
