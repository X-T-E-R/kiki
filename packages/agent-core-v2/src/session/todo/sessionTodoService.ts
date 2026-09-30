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
import { IConfigService } from '#/app/config/config';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from '#/app/memory/configSection';
import { continuityClockKey } from './continuityState';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionTodoService } from './sessionTodo';
import { readTodoState, todoKey, ToolsUpdateStore, type TodoState } from './todoOps';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { hashTodoNotes, mergeTodoNotes, type NotesMeta, type TodoNotes } from './todoNotes';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { TODO_LIST_REMINDER_VARIANT, TodoListReminderTracker, legacyDirectiveShadow } from './todoListReminder';
import { ContinuityDecision } from './continuityDecision';

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
  private readonly lastKnownTodos = new Map<string, { items: readonly TodoItem[]; rev?: number }>();
  private readonly reminderTrackers = new Map<string, TodoListReminderTracker>();
  private readonly decisionKeys = new Map<string, string>();

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
    return readTodoState(handle.accessor.get(IAgentStateService).get(todoKey)).items;
  }

  getNotes(agentId = MAIN_AGENT_ID): { notes?: TodoNotes; meta?: NotesMeta } {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) return {};
    const current = readTodoState(handle.accessor.get(IAgentStateService).get(todoKey));
    return { notes: current.notes, meta: current.notesMeta };
  }

  setNotes(patch: TodoNotes | null, source: { turnId: number; step: number; toolCallId: string }, agentId = MAIN_AGENT_ID): void {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) return;
    const states = handle.accessor.get(IAgentStateService);
    const current = readTodoState(states.get(todoKey));
    const notes = mergeTodoNotes(current.notes, patch);
    const hash = hashTodoNotes(notes);
    const history = handle.accessor.get(IAgentContextMemoryService).get();
    const assistant = history.findLast((message) => message.role === 'assistant' && message.toolCalls.some((call) => call.id === source.toolCallId));
    const same = current.notesMeta?.hash === hash;
    const meta: NotesMeta = {
      rev: same ? current.notesMeta!.rev : (current.notesMeta?.rev ?? 0) + 1,
      hash,
      writtenTurn: source.turnId,
      writtenStep: `t${source.turnId}.${source.step}`,
      coveredMessageId: same ? current.notesMeta!.coveredMessageId : assistant?.id ?? `toolcall:${source.toolCallId}`,
      windowEpoch: states.get(contextWindowEpochKey),
    };
    void handle.accessor.get(IEventDispatcher).dispatch(new ToolsUpdateStore({ key: 'todo_notes', value: { notes, notesMeta: meta } }));
    this.publishTodos(handle);
  }

  setCompactionDirectives(directives: string, turnId: number, agentId = MAIN_AGENT_ID): void {
    const handle = this.agentLifecycle.get(agentId);
    const text = directives.trim();
    if (handle === undefined || !text || text === '(none)') return;
    const states = handle.accessor.get(IAgentStateService);
    const current = readTodoState(states.get(todoKey));
    const previous = current.notes?.directives?.trim() ?? '';
    const combined = !previous || text.includes(previous) ? text : previous.includes(text) ? previous : `${previous}\n${text}`;
    const otherLength = Object.entries(current.notes ?? {}).reduce((sum, [key, value]) => sum + (key === 'directives' ? 0 : value.length), 0);
    const clipped = combined.slice(0, Math.max(0, Math.min(1_500, 7_500 - otherLength)));
    if (!clipped || clipped === previous) return;
    const notes = mergeTodoNotes(current.notes, { directives: clipped });
    const meta: NotesMeta = {
      rev: (current.notesMeta?.rev ?? 0) + 1, hash: hashTodoNotes(notes),
      writtenTurn: turnId, writtenStep: `t${turnId}.0`,
      coveredMessageId: 'compaction_summary', windowEpoch: states.get(contextWindowEpochKey),
    };
    void handle.accessor.get(IEventDispatcher).dispatch(new ToolsUpdateStore({ key: 'todo_notes', value: { notes, notesMeta: meta, writer: 'compaction' } }));
    this.publishTodos(handle);
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
    const { items: todos, notesMeta } = readTodoState(handle.accessor.get(IAgentStateService).get(todoKey));
    this.lastKnownTodos.set(handle.id, { items: todos, rev: notesMeta?.rev });
    this.onDidChangeAgentEmitter.fire({ agentId: handle.id, todos });
    if (handle.id === MAIN_AGENT_ID) this.onDidChangeEmitter.fire(todos);
  }

  private publishRollback(handle: IAgentScopeHandle, current: TodoState, itemsChanged: boolean, notesChanged: boolean): void {
    const dispatcher = handle.accessor.get(IEventDispatcher);
    if (itemsChanged) {
      void dispatcher.dispatch(new ToolsUpdateStore({ key: 'todo', value: current.items }));
    }
    if (notesChanged) {
      void dispatcher.dispatch(new ToolsUpdateStore({ key: 'todo_notes', value: { notes: current.notes, notesMeta: current.notesMeta } }));
    }
  }

  private prepareAgent(handle: IAgentScopeHandle): void {
    handle.accessor.get(IAgentStateService).contributeState(todoKey);
    handle.accessor.get(IAgentStateService).contributeState(continuityClockKey);
    this.reminderTrackers.set(handle.id, new TodoListReminderTracker());
    const injector = handle.accessor.get(IAgentContextInjectorService);
    this.trackAgentBinding(
      handle.id,
      injector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder(handle)),
    );
  }

  private activateAgent(handle: IAgentScopeHandle): void {
    const initial = readTodoState(handle.accessor.get(IAgentStateService).get(todoKey));
    this.lastKnownTodos.set(handle.id, { items: initial.items, rev: initial.notesMeta?.rev });
    this.trackAgentBinding(
      handle.id,
      handle.accessor.get(IEventBus).subscribe(ContextUndone, () => {
        const current = readTodoState(handle.accessor.get(IAgentStateService).get(todoKey));
        const previous = this.lastKnownTodos.get(handle.id);
        const itemsChanged = !todoItemsEqual(current.items, previous?.items ?? []);
        const notesChanged = previous?.rev !== current.notesMeta?.rev;
        if (!itemsChanged && !notesChanged) return;
        this.publishTodos(handle);
        this.publishRollback(handle, current, itemsChanged, notesChanged);
      }),
    );
  }

  private staleReminder(handle: IAgentScopeHandle) {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const toolPolicy = handle.accessor.get(IAgentToolPolicyService);
    const state = readTodoState(handle.accessor.get(IAgentStateService).get(todoKey));
    const compact = handle.accessor.get(IAgentFullCompactionService);
    const counting = handle.accessor.get(IAgentTokenCountingService);
    const config = handle.accessor.get(IConfigService);
    const settings = config.get<MemoryConfig>(MEMORY_SECTION);
    const clock = handle.accessor.get(IAgentStateService).get(continuityClockKey);
    const epoch = handle.accessor.get(IAgentStateService).get(contextWindowEpochKey);
    const cues = config.get<LoopControl>(LOOP_CONTROL_SECTION).directiveCues;
    return this.reminderTrackers.get(handle.id)?.evaluate({
      active: toolPolicy.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: memory.get(), todos: state.items, notes: state.notes, notesMeta: state.notesMeta,
      threshold: compact.getAutoCompact().tokens, currentTokens: counting.get().size,
      epoch, remindedEpoch: state.remindedEpoch, clock,
      cadence: config.get<LoopControl>(LOOP_CONTROL_SECTION).continuityCadence,
      humanAuthorized: handle.id === MAIN_AGENT_ID,
      cues,
      onDecision: (decision) => {
        const key = `${handle.id}:${decision.classId}`;
        const signature = `${clock.humanInputRevision}/${clock.stateRevision}/${epoch}/${decision.reason}`;
        if (this.decisionKeys.get(key) === signature) return;
        this.decisionKeys.set(key, signature);
        void handle.accessor.get(IEventDispatcher).dispatch(new ContinuityDecision({ ...decision, epoch,
          inputRevision: clock.humanInputRevision, stateRevision: clock.stateRevision,
          legacyCandidate: decision.classId === 'E1' && legacyDirectiveShadow(clock.latestInput?.text ?? '', cues) }));
      },
      memoryAvailable: handle.id === MAIN_AGENT_ID && memoryEnabled(settings, handle.accessor.get(ISessionContext).workspaceId) && settings.approval !== 'off',
      estimateMessage: (message) => counting.estimateMessage(message),
      onNearWindow: (epoch) => { void handle.accessor.get(IEventDispatcher).dispatch(new ToolsUpdateStore({ key: 'todo_reminder', value: epoch })); },
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
    this.reminderTrackers.delete(agentId);
    for (const classId of ['E1', 'E2', 'T0', 'T1']) this.decisionKeys.delete(`${agentId}:${classId}`);
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
