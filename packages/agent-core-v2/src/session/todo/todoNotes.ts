import { createHash } from 'node:crypto';
import type { ContextMessage } from '#/agent/contextMemory/types';

export const NOTE_SECTIONS = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'] as const;
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

export function coveredMessageIndex(history: readonly ContextMessage[], meta?: NotesMeta): number {
  if (meta === undefined) return -1;
  if (meta.coveredMessageId === 'compaction_summary') return history.findLastIndex((message) => message.origin?.kind === 'compaction_summary');
  return history.findIndex((message) => message.id === meta.coveredMessageId ||
    (meta.coveredMessageId.startsWith('toolcall:') && message.toolCalls.some((call) => call.id === meta.coveredMessageId.slice(9))));
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
  if (NOTE_SECTIONS.reduce((sum, key) => sum + (next[key]?.length ?? 0), 0) > 7_500) {
    throw new Error('Working notes must be at most 7,500 characters in total.');
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function hashTodoNotes(notes: TodoNotes | undefined): string {
  const sections = notes?.directives === undefined ? NOTE_SECTIONS.filter((key) => key !== 'directives') : NOTE_SECTIONS;
  return createHash('sha256').update(JSON.stringify(sections.map((key) => notes?.[key] ?? ''))).digest('hex').slice(0, 16);
}

export function renderTodoNotes(notes: TodoNotes | undefined): string {
  if (notes === undefined) return '';
  return NOTE_SECTIONS.flatMap((key) => notes[key] ? [`${key}: ${notes[key]}`] : []).join('\n');
}
