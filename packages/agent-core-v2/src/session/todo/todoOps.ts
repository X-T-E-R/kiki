/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import '#/agent/contextMemory/conversationTime';

import { readTodoItems, type TodoItem } from './todoItem';
import type { NotesMeta, TodoNotes } from './todoNotes';

export interface TodoState {
  readonly items: readonly TodoItem[];
  readonly notes?: TodoNotes;
  readonly notesMeta?: NotesMeta;
  readonly remindedEpoch?: number;
}

export function readTodoState(value: TodoState | readonly TodoItem[]): TodoState {
  return Array.isArray(value) ? { items: value as readonly TodoItem[] } : value as TodoState;
}

const toolsUpdateStoreSchema = z.object({ key: z.string(), value: z.unknown() });

export class ToolsUpdateStore extends Event2<z.infer<typeof toolsUpdateStoreSchema>> {
  static override readonly type = 'tools.update_store';
  static override readonly durable = true;
  static override readonly schema = toolsUpdateStoreSchema;
}
export interface ToolsUpdateStore extends z.infer<typeof toolsUpdateStoreSchema> {}

export const todoKey = defineState('todo', (): TodoState => ({ items: [] }))
  .replayable({ schema: z.custom<TodoState>() })
  .undoable()
  .on(ToolsUpdateStore, (s, e) => {
    if (e.key === 'todo') return { ...readTodoState(s), items: readTodoItems(e.value) };
    if (e.key === 'todo_notes') {
      const current = readTodoState(s);
      const value = e.value as { notes?: TodoNotes; notesMeta?: NotesMeta };
      return { ...current, notes: value.notes, notesMeta: value.notesMeta };
    }
    if (e.key === 'todo_reminder' && typeof e.value === 'number') return { ...readTodoState(s), remindedEpoch: e.value };
  });
