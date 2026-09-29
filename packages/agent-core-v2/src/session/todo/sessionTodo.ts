import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { TodoItem } from './todoItem';
import type { NotesMeta, TodoNotes } from './todoNotes';

export interface ISessionTodoService {
  readonly _serviceBrand: undefined;

  getTodos(agentId?: string): readonly TodoItem[];
  getNotes(agentId?: string): { notes?: TodoNotes; meta?: NotesMeta };
  setNotes(patch: TodoNotes | null, source: { turnId: number; step: number; toolCallId: string }, agentId?: string): void;
  setCompactionDirectives(directives: string, turnId: number, agentId?: string): void;
  setTodos(todos: readonly TodoItem[], agentId?: string): void;
  clear(agentId?: string): void;
  readonly onDidChange: Event<readonly TodoItem[]>;
  readonly onDidChangeAgent: Event<{ agentId: string; todos: readonly TodoItem[] }>;
}

export const ISessionTodoService = createDecorator<ISessionTodoService>('sessionTodoService');
