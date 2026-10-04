import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TODO_LIST_TOOL_NAME, renderTodoList } from '#/session/todo/todoItem';
import { NOTE_SECTIONS, mergeTodoNotes, renderTodoNotes } from '#/session/todo/todoNotes';
import { ITodoListTool, TodoListInputSchema, type TodoListInput } from './todo-list';
import DESCRIPTION from './todo-list.md?raw';

export class TodoListTool implements ITodoListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description = args.todos === undefined
      ? args.notes === undefined && !args.review_handoff ? 'Reading todo list' : 'Updating working notes'
      : args.todos.length === 0 ? 'Clearing todo list' : 'Updating todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async (ctx) => {
        const before = this.todo.getNotes(this.scope.agentId);
        if (args.todos === undefined && args.notes === undefined && !args.review_handoff) {
          const notes = renderTodoNotes(before.notes);
          return { isError: false, output: `${renderTodoList(this.todo.getTodos(this.scope.agentId))}\nNotes revision: ${before.meta?.rev ?? 0}${notes ? `\n\n## Working notes\n${notes}` : ''}` };
        }
        const changed: string[] = [];
        const cleared: string[] = [];
        const sectionChars: Record<string, number> = {};
        if (args.notes !== undefined || args.review_handoff) {
          if (ctx.step === undefined) return { isError: true, output: 'Working notes require a turn step. No state was changed.' };
          try {
            const after = mergeTodoNotes(before.notes, args.notes === undefined ? {} : args.notes);
            for (const section of NOTE_SECTIONS) {
              if (before.notes?.[section] === after?.[section]) continue;
              (after?.[section] === undefined ? cleared : changed).push(`notes.${section}`);
              sectionChars[section] = after?.[section]?.length ?? 0;
            }
            if (args.notes === null && before.notes !== undefined) {
              cleared.splice(0, cleared.length, 'notes');
            }
            this.todo.setNotes(args.notes === undefined ? {} : args.notes, { turnId: ctx.turnId, step: ctx.step, toolCallId: ctx.toolCallId, reviewHandoff: args.review_handoff }, this.scope.agentId);
          } catch (error) {
            return { isError: true, output: `${error instanceof Error ? error.message : 'Invalid working notes.'} No state was changed.` };
          }
        }
        if (args.todos !== undefined) {
          const next = args.todos.map(({ title, status }) => ({ title, status }));
          if (JSON.stringify(this.todo.getTodos(this.scope.agentId)) !== JSON.stringify(next)) {
            this.todo.setTodos(next, this.scope.agentId);
            (next.length === 0 ? cleared : changed).push('todos');
          }
        }
        const stored = this.todo.getNotes(this.scope.agentId);
        const todos = args.todos === undefined ? undefined : this.todo.getTodos(this.scope.agentId);
        return { isError: false, output: JSON.stringify({
          changed, cleared, unchanged: changed.length === 0 && cleared.length === 0 && !args.review_handoff,
          notes_revision: stored.meta?.rev ?? 0,
          section_chars: sectionChars,
          notes_chars: NOTE_SECTIONS.reduce((sum, section) => sum + (stored.notes?.[section]?.length ?? 0), 0),
          todos: todos === undefined ? undefined : { count: todos.length, pending: todos.filter((item) => item.status === 'pending').length,
            in_progress: todos.filter((item) => item.status === 'in_progress').length, done: todos.filter((item) => item.status === 'done').length },
          handoff_reviewed: args.review_handoff ? true : undefined,
        }) };
      },
    };
  }
}

registerAgentToolService(ITodoListTool, TodoListTool, { name: 'TodoList', domain: 'todo' });
