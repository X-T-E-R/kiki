import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { ISessionTodoService } from './sessionTodo';
import { todoKey, ToolsUpdateStore } from './todoOps';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { TODO_LIST_REMINDER_VARIANT, todoListStaleReminder } from './todoListReminder';

const MAIN_AGENT_ID = 'main';

export class SessionTodoService extends Service implements ISessionTodoService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<readonly TodoItem[]>());
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChangeAgentEmitter = this._register(
    new Emitter<{ agentId: string; todos: readonly TodoItem[] }>(),
  );
  readonly onDidChangeAgent = this.onDidChangeAgentEmitter.event;

  private readonly agentBindings = new Map<string, IDisposable[]>();
  private readonly lastKnownTodos = new Map<string, readonly TodoItem[]>();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();

    this._register(
      this.agentLifecycle.onWillCreate((handle) => {
        this.prepareAgent(handle);
      }),
    );
    this._register(
      this.agentLifecycle.onDidCreate((handle) => {
        this.activateAgent(handle);
      }),
    );
    this._register(
      this.agentLifecycle.onDidDispose((agentId) => this.disposeAgentBindings(agentId)),
    );

    for (const handle of this.agentLifecycle.list()) {
      this.prepareAgent(handle);
      this.activateAgent(handle);
    }

    this._register(
      toDisposable(() => {
        for (const agentId of Array.from(this.agentBindings.keys())) {
          this.disposeAgentBindings(agentId);
        }
      }),
    );
  }

  getTodos(agentId = MAIN_AGENT_ID): readonly TodoItem[] {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) return [];
    return handle.accessor.get(IAgentStateService).get(todoKey);
  }

  setTodos(todos: readonly TodoItem[], agentId = MAIN_AGENT_ID): void {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) return;
    const next: readonly TodoItem[] = todos.map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
    void handle.accessor.get(IEventDispatcher).dispatch(
      new ToolsUpdateStore({ key: 'todo', value: next }),
    );
    this.publishTodos(handle);
  }

  clear(agentId = MAIN_AGENT_ID): void {
    this.setTodos([], agentId);
  }

  private publishTodos(handle: IAgentScopeHandle): void {
    const todos = handle.accessor.get(IAgentStateService).get(todoKey);
    this.lastKnownTodos.set(handle.id, todos);
    this.onDidChangeAgentEmitter.fire({ agentId: handle.id, todos });
    if (handle.id === MAIN_AGENT_ID) this.onDidChangeEmitter.fire(todos);
  }

  private prepareAgent(handle: IAgentScopeHandle): void {
    handle.accessor.get(IAgentStateService).contributeState(todoKey);
    const injector = handle.accessor.get(IAgentContextInjectorService);
    this.trackAgentBinding(
      handle.id,
      injector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder(handle)),
    );
  }

  private activateAgent(handle: IAgentScopeHandle): void {
    this.lastKnownTodos.set(handle.id, handle.accessor.get(IAgentStateService).get(todoKey));
    this.trackAgentBinding(
      handle.id,
      handle.accessor.get(IEventBus).subscribe(ContextUndone, () => {
        const current = handle.accessor.get(IAgentStateService).get(todoKey);
        if (todoItemsEqual(current, this.lastKnownTodos.get(handle.id) ?? [])) return;
        this.publishTodos(handle);
      }),
    );
  }

  private staleReminder(handle: IAgentScopeHandle): string | undefined {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const toolPolicy = handle.accessor.get(IAgentToolPolicyService);
    return todoListStaleReminder({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(),
      todos: handle.accessor.get(IAgentStateService).get(todoKey),
    });
  }

  private trackAgentBinding(agentId: string, disposable: IDisposable): void {
    const list = this.agentBindings.get(agentId);
    if (list === undefined) {
      this.agentBindings.set(agentId, [disposable]);
    } else {
      list.push(disposable);
    }
  }

  private disposeAgentBindings(agentId: string): void {
    const bindings = this.agentBindings.get(agentId);
    if (bindings === undefined) return;
    for (const disposable of bindings) {
      disposable.dispose();
    }
    this.agentBindings.delete(agentId);
    this.lastKnownTodos.delete(agentId);
  }
}

function todoItemsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => item.title === b[index]?.title && item.status === b[index]?.status)
  );
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTodoService,
  SessionTodoService,
  ScopeActivation.OnScopeCreated,
  'todo',
);
