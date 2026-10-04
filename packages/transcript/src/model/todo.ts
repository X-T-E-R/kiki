import type { ContentWindow } from '../contract/content';
import type { TodoId } from './ids';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export type TodoNoteSection = 'goal' | 'directives' | 'decided' | 'rejected' | 'evidence' | 'files' | 'next' | 'open';
export type TranscriptTodoNotes = Partial<Record<TodoNoteSection, string>> & Readonly<Record<string, string | undefined>>;

export interface TranscriptTodoNotesMeta {
  readonly rev: number;
  readonly hash: string;
  readonly writtenTurn: number;
  readonly writtenStep: string;
  readonly coveredMessageId: string;
  readonly windowEpoch: number;
  readonly reviewedMessageId?: string;
  readonly reviewedWindowEpoch?: number;
}

export interface TranscriptTodoNotesStatus {
  readonly state: 'incompatible';
  readonly wireOrdinal: number;
  readonly schemaVersion: number;
  readonly fields: readonly string[];
}

export interface TranscriptTodo extends ContentWindow {
  readonly todoId: TodoId;
  readonly items: readonly TodoItem[];
  readonly notes?: TranscriptTodoNotes;
  readonly notesMeta?: TranscriptTodoNotesMeta;
  readonly notesStatus?: TranscriptTodoNotesStatus;
  readonly updatedAt?: string;
}
