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
  goal: NoteSectionSchema.optional().describe('The user’s original request and what success requires. Keep this current so omitted history remains understandable.'),
  directives: NoteSectionSchema.optional().describe('Still-active user instructions for this task: quote closely and include t<turn>. Reference saved memory as [m_id].'),
  decided: NoteSectionSchema.optional().describe('Decisions already made; include previous decisions you still need to keep.'),
  rejected: NoteSectionSchema.optional().describe('Options ruled out and why.'),
  evidence: NoteSectionSchema.optional().describe('Verified observations and checks supporting the work.'),
  files: NoteSectionSchema.optional().describe('Relevant files and their roles or changes.'),
  next: NoteSectionSchema.optional().describe('The concrete next step to take.'),
  open: NoteSectionSchema.optional().describe('Remaining questions or blockers.'),
}).strict();

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
  notes: TodoNotesSchema.nullable().optional().describe('Each supplied working-note section replaces that section entirely. To keep earlier content in a section, include all of it when updating. Record the user request and success criteria in goal. Empty text deletes one section; null clears all notes. Omit notes to leave them unchanged. Each section is limited to 1,500 characters and all sections together to 7,500.'),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
