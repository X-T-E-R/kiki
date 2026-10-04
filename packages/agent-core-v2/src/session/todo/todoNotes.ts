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
  readonly reviewedMessageId?: string;
  readonly reviewedWindowEpoch?: number;
}

export function coveredMessageIndex(history: readonly ContextMessage[], meta?: NotesMeta): number {
  const boundary = meta?.reviewedMessageId;
  if (boundary === undefined) return -1;
  return history.findIndex((message) => message.id === boundary ||
    (boundary.startsWith('toolcall:') && message.toolCalls.some((call) => call.id === boundary.slice(9))));
}

export function compactionDirectivesBudget(notes: TodoNotes | undefined, text: string): { sectionChars: number; totalChars: number; exceeded: boolean } {
  const previous = notes?.directives ?? '';
  const candidate = !previous || text.includes(previous) ? text : previous.includes(text) ? previous : `${previous}\n${text}`;
  const sectionChars = candidate.length;
  const totalChars = NOTE_SECTIONS.reduce((sum, key) => sum + (key === 'directives' ? sectionChars : notes?.[key]?.length ?? 0), 0);
  return { sectionChars, totalChars, exceeded: sectionChars > 1_500 || totalChars > 7_500 };
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
  const oversized = NOTE_SECTIONS.find((key) => (next[key]?.length ?? 0) > 1_500);
  if (oversized !== undefined) throw new Error(`Working notes section notes.${oversized} has ${next[oversized]!.length} characters (limit: 1,500).`);
  const total = NOTE_SECTIONS.reduce((sum, key) => sum + (next[key]?.length ?? 0), 0);
  if (total > 7_500) throw new Error(`Working notes have ${total} characters in total (limit: 7,500).`);
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
