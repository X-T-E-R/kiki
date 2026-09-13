import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AgentForest, SessionViewState } from '@kiki/session-core/session';
import { SessionController } from '@kiki/session-core/session';
import type { SessionTransport } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';

export interface BoardTodoController {
  readonly sessionId: string;
  readonly getForest: () => AgentForest | undefined;
  readonly getState: () => SessionViewState;
  readonly getAgentState: (agentId: string) => SessionViewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeAgent: (agentId: string, listener: () => void) => () => void;
  readonly open: () => Promise<void>;
  readonly close: () => void;
}

export interface BoardAssociatedTodoSnapshot {
  readonly sessionId: string;
  readonly main: SessionViewState;
  readonly agents: Readonly<Record<string, SessionViewState>>;
  readonly forest: AgentForest | undefined;
  readonly error?: string;
}

export interface BoardAssociatedTodoLease {
  readonly sessionId: string;
  readonly getSnapshot: () => BoardAssociatedTodoSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly release: () => void;
}

export interface BoardAssociatedTodoManager {
  acquire(sessionId: string): BoardAssociatedTodoLease;
  dispose(): void;
}

export interface BoardAssociatedTodoManagerOptions {
  readonly sessionClient?: SessionTransport;
  readonly klient?: {
    readonly session: (sessionId: string) => { readonly view: ConstructorParameters<typeof SessionController>[1] };
  };
  readonly createController?: (sessionId: string) => BoardTodoController;
  readonly registry?: Iterable<BoardTodoController>;
}

interface SourceRecord {
  readonly sessionId: string;
  readonly controller: BoardTodoController;
  readonly borrowed: boolean;
  owners: number;
  readonly listeners: Set<() => void>;
  readonly agentUnsubscribers: Map<string, () => void>;
  mainUnsubscribe?: () => void;
  snapshot: BoardAssociatedTodoSnapshot;
  disposed: boolean;
}

function sourceError(state: SessionViewState): string | undefined {
  return state.loadError ?? state.resyncError?.message;
}

function makeSnapshot(controller: BoardTodoController): BoardAssociatedTodoSnapshot {
  const forest = controller.getForest();
  const agents: Record<string, SessionViewState> = {};
  for (const agentId of Object.keys(forest?.byId ?? {})) {
    if (agentId !== 'main') agents[agentId] = controller.getAgentState(agentId);
  }
  const main = controller.getState();
  return {
    sessionId: controller.sessionId,
    main,
    agents,
    forest,
    error: sourceError(main),
  };
}

class BoardAssociatedTodoManagerImpl implements BoardAssociatedTodoManager {
  private readonly sources = new Map<string, SourceRecord>();
  private disposed = false;

  constructor(private readonly options: {
    readonly createController: (sessionId: string) => BoardTodoController;
    readonly registry?: Iterable<BoardTodoController>;
  }) {}

  acquire(sessionId: string): BoardAssociatedTodoLease {
    if (this.disposed) throw new Error('The associated Todo manager is disposed.');
    let source = this.sources.get(sessionId);
    if (source === undefined) {
      const mounted = this.findMountedController(sessionId);
      const controller = mounted ?? this.options.createController(sessionId);
      source = {
        sessionId,
        controller,
        borrowed: mounted !== undefined,
        owners: 0,
        listeners: new Set(),
        agentUnsubscribers: new Map(),
        snapshot: makeSnapshot(controller),
        disposed: false,
      };
      this.sources.set(sessionId, source);
      this.startSource(source);
    }
    source.owners += 1;
    let released = false;
    return {
      sessionId,
      getSnapshot: () => source!.snapshot,
      subscribe: (listener) => {
        source!.listeners.add(listener);
        return () => { source!.listeners.delete(listener); };
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseSource(source!);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources.values()) this.stopSource(source);
    this.sources.clear();
  }

  private findMountedController(sessionId: string): BoardTodoController | undefined {
    for (const controller of this.options.registry ?? []) {
      if (controller.sessionId === sessionId) return controller;
    }
    return undefined;
  }

  private startSource(source: SourceRecord): void {
    const publish = () => this.publishSource(source);
    source.mainUnsubscribe = source.controller.subscribe(publish);
    this.reconcileAgentSubscriptions(source, publish);
    if (!source.borrowed) {
      void source.controller.open().catch((error: unknown) => {
        if (source.disposed) return;
        source.snapshot = {
          ...source.snapshot,
          error: error instanceof Error ? error.message : 'Could not open the associated session.',
        };
        this.notify(source);
      });
    }
  }

  private publishSource(source: SourceRecord): void {
    if (source.disposed) return;
    this.reconcileAgentSubscriptions(source, () => this.publishSource(source));
    source.snapshot = makeSnapshot(source.controller);
    this.notify(source);
  }

  private reconcileAgentSubscriptions(source: SourceRecord, publish: () => void): void {
    const wanted = new Set(Object.keys(source.controller.getForest()?.byId ?? {}).filter((id) => id !== 'main'));
    for (const [agentId, unsubscribe] of source.agentUnsubscribers) {
      if (wanted.has(agentId)) continue;
      unsubscribe();
      source.agentUnsubscribers.delete(agentId);
    }
    for (const agentId of wanted) {
      if (source.agentUnsubscribers.has(agentId)) continue;
      source.agentUnsubscribers.set(agentId, source.controller.subscribeAgent(agentId, publish));
    }
  }

  private notify(source: SourceRecord): void {
    for (const listener of source.listeners) listener();
  }

  private releaseSource(source: SourceRecord): void {
    if (source.disposed) return;
    source.owners = Math.max(0, source.owners - 1);
    if (source.owners === 0) {
      this.sources.delete(source.sessionId);
      this.stopSource(source);
    }
  }

  private stopSource(source: SourceRecord): void {
    if (source.disposed) return;
    source.disposed = true;
    source.mainUnsubscribe?.();
    source.mainUnsubscribe = undefined;
    for (const unsubscribe of source.agentUnsubscribers.values()) unsubscribe();
    source.agentUnsubscribers.clear();
    source.listeners.clear();
    if (!source.borrowed) source.controller.close();
  }
}

export function createBoardAssociatedTodoManager(options: BoardAssociatedTodoManagerOptions): BoardAssociatedTodoManager {
  const createController = options.createController ?? ((sessionId: string) => {
    if (options.sessionClient === undefined || options.klient === undefined) {
      throw new Error('A session client is required to create an associated Todo source.');
    }
    return new SessionController(
      options.sessionClient,
      options.klient.session(sessionId).view,
      sessionId,
    );
  });
  return new BoardAssociatedTodoManagerImpl({ registry: options.registry, createController });
}

const BoardAssociatedTodoManagerContext = createContext<BoardAssociatedTodoManager | null>(null);

export function BoardAssociatedTodosProvider({
  manager,
  children,
}: {
  readonly manager: BoardAssociatedTodoManager | null;
  readonly children: ReactNode;
}) {
  const generation = useRef(0);
  const activeManager = useRef<BoardAssociatedTodoManager | null>(null);
  useEffect(() => {
    const previous = activeManager.current;
    if (previous !== null && previous !== manager) previous.dispose();
    activeManager.current = manager;
    const currentGeneration = ++generation.current;
    return () => {
      queueMicrotask(() => {
        if (generation.current === currentGeneration) {
          manager?.dispose();
          activeManager.current = null;
        }
      });
    };
  }, [manager]);
  return (
    <BoardAssociatedTodoManagerContext.Provider value={manager}>
      {children}
    </BoardAssociatedTodoManagerContext.Provider>
  );
}

function uniqueSessionIds(sessionIds: readonly string[]): readonly string[] {
  return [...new Set(sessionIds.filter((sessionId) => sessionId !== ''))];
}

function todoTone(status: string): { readonly icon: string; readonly className: string } {
  if (status === 'done') return { icon: '✓', className: 'border-success/40 bg-success/10 text-success' };
  if (status === 'in_progress') return { icon: '●', className: 'border-accent/60 bg-accent-soft text-accent' };
  return { icon: '', className: 'border-hairline-strong bg-panel text-transparent' };
}

function agentLabel(
  agentId: string,
  forest: AgentForest | undefined,
  mainLabel: string,
): string {
  if (agentId === 'main') return mainLabel;
  return forest?.byId[agentId]?.label || forest?.byId[agentId]?.name || agentId;
}

function TodoItems({ todos }: { readonly todos: SessionViewState['todos'] }) {
  const { t } = useI18n();
  const doneCount = todos.filter((todo) => todo.status === 'done').length;
  return (
    <div data-board-associated-todo-list className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-ink-faint">
        <span>{t('agentPanel.todoTitle')}</span>
        <span>{doneCount}/{todos.length}</span>
      </div>
      {todos.length === 0 ? (
        <p className="py-1 text-[11.5px] text-ink-faint">{t('agentPanel.noTodos')}</p>
      ) : (
        <ul className="space-y-1">
          {todos.map((todo, index) => {
            const tone = todoTone(todo.status);
            return (
              <li key={`${index}:${todo.title}`} className="flex items-start gap-2 text-[12px] leading-snug">
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px] font-bold ${tone.className}`} aria-hidden>
                  {tone.icon}
                </span>
                <input
                  type="checkbox"
                  checked={todo.status === 'done'}
                  disabled
                  readOnly
                  aria-label={t('agentPanel.markTodo', { title: todo.title })}
                  className="sr-only"
                />
                <span className={todo.status === 'done' ? 'text-ink-faint line-through' : todo.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-soft'}>
                  {todo.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface BoardAssociatedTodosProps {
  readonly sessionIds: readonly string[];
  readonly sessionLabels?: Readonly<Record<string, string>>;
}

export const BoardAssociatedTodos = memo(function BoardAssociatedTodos({
  sessionIds,
  sessionLabels = {},
}: BoardAssociatedTodosProps) {
  const { t } = useI18n();
  const manager = useContext(BoardAssociatedTodoManagerContext);
  const ids = useMemo(() => uniqueSessionIds(sessionIds), [sessionIds]);
  const sessionKey = ids.join('\u0000');
  const [expanded, setExpanded] = useState(false);
  const [, setVersion] = useState(0);
  const leasesRef = useRef<readonly BoardAssociatedTodoLease[]>([]);
  const leaseKeyRef = useRef('');

  useEffect(() => {
    for (const lease of leasesRef.current) lease.release();
    leasesRef.current = [];
    leaseKeyRef.current = sessionKey;
    if (!expanded || ids.length === 0 || manager === null) {
      setVersion((value) => value + 1);
      return;
    }
    const leases = ids.map((sessionId) => manager.acquire(sessionId));
    leasesRef.current = leases;
    const unsubscribers = leases.map((lease) => lease.subscribe(() => { setVersion((value) => value + 1); }));
    setVersion((value) => value + 1);
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const lease of leases) lease.release();
      if (leaseKeyRef.current === sessionKey) {
        leasesRef.current = [];
        leaseKeyRef.current = '';
      }
    };
  }, [expanded, ids, manager, sessionKey]);

  if (ids.length === 0) return null;
  const ready = expanded && leaseKeyRef.current === sessionKey && leasesRef.current.length === ids.length;
  const snapshots = ready ? leasesRef.current.map((lease) => lease.getSnapshot()) : [];
  const todoCount = snapshots.reduce((sum, snapshot) => {
    const childCount = Object.values(snapshot.agents).reduce((agentSum, state) => agentSum + state.todos.length, 0);
    return sum + snapshot.main.todos.length + childCount;
  }, 0);
  const doneCount = snapshots.reduce((sum, snapshot) => {
    const childDone = Object.values(snapshot.agents).reduce(
      (agentSum, state) => agentSum + state.todos.filter((todo) => todo.status === 'done').length,
      0,
    );
    return sum + snapshot.main.todos.filter((todo) => todo.status === 'done').length + childDone;
  }, 0);

  return (
    <div
      data-board-associated-todos
      className="mt-2 border-t border-hairline pt-2"
      onClick={(event) => { event.stopPropagation(); }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => { setExpanded((value) => !value); }}
        className="flex w-full items-center justify-between gap-2 text-left text-[11px] font-semibold tracking-[0.06em] text-ink-faint uppercase transition-colors hover:text-ink"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={`shrink-0 text-[8px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="truncate">{t('agentPanel.todoTitle')}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {doneCount}/{todoCount}
        </span>
      </button>
      {expanded ? (
        <div data-board-associated-todos-content className="mt-2 space-y-2">
          {!ready ? (
            <p role="status" className="text-[11.5px] text-ink-faint">{manager === null ? t('diagnostics.unavailable') : t('diagnostics.loading')}</p>
          ) : snapshots.map((snapshot) => {
            const agentIds = ['main', ...Object.keys(snapshot.agents)];
            return (
              <section key={snapshot.sessionId} data-board-associated-todos-session={snapshot.sessionId} className="space-y-2 border-t border-hairline/70 pt-2 first:border-t-0 first:pt-0">
                <div className="font-mono text-[10.5px] font-semibold text-ink-soft">{sessionLabels[snapshot.sessionId] ?? snapshot.sessionId}</div>
                {snapshot.error ? <p role="alert" className="text-[11.5px] text-danger">{t('diagnostics.error')} · {snapshot.error}</p> : null}
                {agentIds.map((agentId) => {
                  const state = agentId === 'main' ? snapshot.main : snapshot.agents[agentId];
                  if (state === undefined) return null;
                  return (
                    <div key={agentId} data-board-associated-todos-agent={agentId} className="space-y-1.5 border-t border-hairline/60 pt-1.5">
                      <div className="mb-1 font-mono text-[10.5px] font-semibold text-ink-faint">{agentLabel(agentId, snapshot.forest, t('agentPanel.mainBadge'))}</div>
                      {state.loaded ? <TodoItems todos={state.todos} /> : <p role="status" className="text-[11.5px] text-ink-faint">{t('diagnostics.loading')}</p>}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
