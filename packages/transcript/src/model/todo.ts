import type { TodoId } from './ids';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export type TodoNoteSection = 'goal' | 'decided' | 'rejected' | 'evidence' | 'files' | 'next' | 'open';
export type TranscriptTodoNotes = Partial<Record<TodoNoteSection, string>>;

export interface TranscriptTodoNotesMeta {
  readonly rev: number;
  readonly hash: string;
  readonly writtenTurn: number;
  readonly writtenStep: string;
  readonly coveredMessageId: string;
  readonly windowEpoch: number;
}

export interface TranscriptTodo {
  readonly todoId: TodoId;
  readonly items: readonly TodoItem[];
  readonly notes?: TranscriptTodoNotes;
  readonly notesMeta?: TranscriptTodoNotesMeta;
  readonly updatedAt?: string;
}
