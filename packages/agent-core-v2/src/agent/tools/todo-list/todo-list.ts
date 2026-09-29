import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { type TodoStatus } from '#/session/todo/todoItem';
import type { TodoNotes } from '#/session/todo/todoNotes';

const TodoItemSchema = z.object({
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
});

export interface TodoListInput {
  todos?: Array<{ title: string; status: TodoStatus }>;
  notes?: TodoNotes | null;
}

const NoteSectionSchema = z.string().max(1_500);
const TodoNotesSchema = z.object({
  goal: NoteSectionSchema.optional(),
  decided: NoteSectionSchema.optional(),
  rejected: NoteSectionSchema.optional(),
  evidence: NoteSectionSchema.optional(),
  files: NoteSectionSchema.optional(),
  next: NoteSectionSchema.optional(),
  open: NoteSectionSchema.optional(),
}).strict();

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
  notes: TodoNotesSchema.nullable().optional().describe('Merge supplied working-note sections; empty text deletes a section, null clears all notes. Omit to keep notes unchanged. Each section is limited to 1,500 characters and all sections together to 6,000.'),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
