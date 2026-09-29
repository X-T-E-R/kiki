import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';

import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  TODO_LIST_TOOL_NAME,
  renderTodoList,
  type TodoItem,
} from '#/session/todo/todoItem';
import { mergeTodoNotes, renderTodoNotes } from '#/session/todo/todoNotes';

import {
  ITodoListTool,
  TodoListInputSchema,
  type TodoListInput,
} from './todo-list';
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
      ? args.notes === undefined ? 'Reading todo list' : 'Updating working notes'
      : args.todos.length === 0 ? 'Clearing todo list' : 'Updating todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async (ctx) => {
        if (args.todos === undefined && args.notes === undefined) {
          const notes = renderTodoNotes(this.todo.getNotes(this.scope.agentId).notes);
          return { isError: false, output: `${renderTodoList(this.todo.getTodos(this.scope.agentId))}${notes ? `\n\n## Working notes\n${notes}` : ''}` };
        }
        if (args.notes !== undefined) {
          if (ctx.step === undefined) return { isError: true, output: 'Working notes require a turn step.' };
          try {
            mergeTodoNotes(this.todo.getNotes(this.scope.agentId).notes, args.notes);
          } catch (error) {
            return { isError: true, output: error instanceof Error ? error.message : 'Invalid working notes.' };
          }
          this.todo.setNotes(args.notes, { turnId: ctx.turnId, step: ctx.step, toolCallId: ctx.toolCallId }, this.scope.agentId);
        }
        if (args.todos === undefined) {
          return { isError: false, output: `Working notes updated.\n${renderTodoNotes(this.todo.getNotes(this.scope.agentId).notes) || '(empty)'}` };
        }
        const next: readonly TodoItem[] = args.todos.map((todo) => ({ title: todo.title, status: todo.status }));
        this.todo.setTodos(next, this.scope.agentId);
        const stored = this.todo.getTodos(this.scope.agentId);
        const output = stored.length === 0 ? 'Todo list cleared.' : `Todo list updated.\n${renderTodoList(stored)}`;
        return { isError: false, output };
      },
    };
  }
}

registerAgentToolService(ITodoListTool, TodoListTool, { name: 'TodoList', domain: 'todo' });
