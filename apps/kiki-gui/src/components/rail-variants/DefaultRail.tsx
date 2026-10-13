import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionController, SessionViewState, TodoItem } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { useOptionalControllerRegistry } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { FOCUS_RING } from './shell';

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;
const FOLD_DONE_AT = 2;
const noopSubscribe = (): (() => void) => () => {};

export interface RailTodosProps {
  sessionId: string;
  agentId: string;
  state?: SessionViewState;
}

export type TodoBaselineStatus = 'ready' | 'loading' | 'partial' | 'error' | 'unknown' | 'confirmed_empty';

const retainedTodosMap = new Map<string, readonly TodoItem[]>();

export function clearRetainedTodosCache(): void {
  retainedTodosMap.clear();
}

function useAgentState(sessionId: string, agentId: string): { controller: SessionController | undefined; agentState: SessionViewState | undefined } {
  const registry = useOptionalControllerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noopSubscribe() : registry.subscribe(listener)),
    [registry],
  );
  const generation = useSyncExternalStore(subscribeRegistry, () => registry?.snapshot() ?? 0, () => 0);
  const controller = useMemo(() => {
    if (registry === null) return undefined;
    for (const candidate of registry) if (candidate.sessionId === sessionId) return candidate;
    return undefined;
  }, [registry, generation, sessionId]);
  const subscribe = useCallback(
    (listener: () => void) => controller === undefined
      ? noopSubscribe()
      : agentId === MAIN_AGENT_ID ? controller.subscribe(listener) : controller.subscribeAgent(agentId, listener),
    [controller, agentId],
  );
  const read = useCallback(
    () => controller === undefined ? undefined : agentId === MAIN_AGENT_ID ? controller.getState() : controller.getAgentState(agentId),
    [controller, agentId],
  );
  const agentState = useSyncExternalStore(subscribe, read, read);
  return { controller, agentState };
}

/**
 * 待办: the agent's checklist in the right rail.
 * - Prioritizes the agent's live view state from the controller registry.
 * - Falls back to the routed session state ONLY for the main agent in the same session. Subagents never borrow main's todos.
 * - Differentiates unknown, loading, partial, error, and confirmed empty baselines.
 * - Preserves existing todos across transient loading/resync states ("同身份旧列表不瞬消").
 * - Does not resurrect stale todos once an empty baseline is confirmed ("reset确认空不回填陈旧todos").
 * - Renders a lightweight loading placeholder while the shell has loaded but the todo baseline is not confirmed.
 */
export function RailTodos({ sessionId, agentId, state }: RailTodosProps) {
  const { t } = useI18n();
  const { controller, agentState } = useAgentState(sessionId, agentId);

  const isMain = agentId === MAIN_AGENT_ID;
  const canFallback = controller === undefined && isMain && state !== undefined && state.sessionId === sessionId;
  const effectiveState = agentState ?? (canFallback ? state : undefined);

  let status: TodoBaselineStatus = 'unknown';
  let isConfirmedEmpty = false;

  if (agentState !== undefined) {
    const todoCoverage = agentState.globalCoverage?.todos;
    const todoRefs = agentState.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' && ref.path[0] === 'items') ?? [];
    const todoReadFailed = todoRefs.some((ref) => agentState.detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') ||
      (todoCoverage?.hasMore === true && agentState.detailLoads['entities:todo']?.status === 'error');
    const hasLoadError = !agentState.loaded && agentState.loadError !== undefined;
    const isError = todoReadFailed || hasLoadError;
    const shellLoaded = state?.loaded === true || agentState.loaded;
    const isLoading = shellLoaded && (!agentState.loaded || todoRefs.length > 0 || (todoCoverage?.hasMore === true && !isError));
    const rawTodos = agentState.todos ?? [];

    if (isError) {
      status = 'error';
    } else if (isLoading) {
      status = rawTodos.length > 0 ? 'partial' : 'loading';
    } else if (!agentState.loaded) {
      status = 'unknown';
    } else if (rawTodos.length === 0) {
      status = 'confirmed_empty';
      isConfirmedEmpty = true;
    } else {
      status = 'ready';
    }
  } else if (canFallback && state !== undefined) {
    const hasLoadError = !state.loaded && state.loadError !== undefined;
    const rawTodos = state.todos ?? [];

    if (hasLoadError) {
      status = 'error';
    } else if (state.loaded && !state.transcriptReady) {
      status = rawTodos.length > 0 ? 'partial' : 'loading';
    } else if (!state.loaded) {
      status = 'unknown';
    } else if (rawTodos.length === 0) {
      status = 'confirmed_empty';
      isConfirmedEmpty = true;
    } else {
      status = 'ready';
    }
  } else {
    status = 'unknown';
  }

  const rawItems = effectiveState?.todos ?? [];
  const activeTodos = useMemo(() =>
    rawItems.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done'),
    [rawItems],
  );

  const identityKey = `${sessionId}:${agentId}`;

  useEffect(() => {
    if (isConfirmedEmpty) {
      retainedTodosMap.delete(identityKey);
    } else if (activeTodos.length > 0) {
      if (retainedTodosMap.size > 50) {
        const oldest = retainedTodosMap.keys().next().value;
        if (oldest !== undefined) retainedTodosMap.delete(oldest);
      }
      retainedTodosMap.set(identityKey, activeTodos);
    }
  }, [identityKey, isConfirmedEmpty, activeTodos]);

  let displayedTodos: readonly TodoItem[] = [];
  if (isConfirmedEmpty) {
    displayedTodos = [];
  } else if (activeTodos.length > 0) {
    displayedTodos = activeTodos;
  } else {
    const retained = retainedTodosMap.get(identityKey);
    if (retained !== undefined && retained.length > 0) {
      displayedTodos = retained;
    }
  }

  const [open, setOpen] = useState(true);
  const [showDone, setShowDone] = useState(false);

  if (displayedTodos.length === 0) {
    if (status === 'loading') {
      return (
        <section data-rail-todos="" data-rail-todos-loading="" className="pt-0.5">
          <div className="flex h-7 items-center gap-1.5 px-0.5 text-ink-faint">
            <span className={`${INSPECTOR_HEAD}`}>{t('inspector.todos')}</span>
            <span className="flex-1" />
            <span role="status" className="text-[12px] text-ink-faint">{t('agentPanel.todos.loading')}</span>
          </div>
        </section>
      );
    }
    return null;
  }

  const doneCount = displayedTodos.filter((todo) => todo.status === 'done').length;
  const foldDone = doneCount >= FOLD_DONE_AT && !showDone;
  const rows = foldDone ? displayedTodos.filter((todo) => todo.status !== 'done') : displayedTodos;

  return (
    <section data-rail-todos="">
      <button type="button" aria-expanded={open} onClick={() => { setOpen((v) => !v); }} className={SECTION_BUTTON}>
        <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{t('inspector.todos')}</span>
        <span className="text-[12px] text-ink-faint tabular-nums">{doneCount}/{displayedTodos.length}</span>
        <span className="flex-1" />
        <InspectorChevron open={open} />
      </button>
      {open ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto pt-1 pr-0.5">
          {doneCount >= FOLD_DONE_AT ? (
            <li>
              <button
                type="button"
                data-rail-todos-done-toggle=""
                aria-expanded={showDone}
                onClick={() => { setShowDone((v) => !v); }}
                className={`-ml-1.5 flex h-7 w-[calc(100%+0.375rem)] items-center gap-2 rounded-md pl-1.5 text-left text-[12.5px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink ${FOCUS_RING}`}
              >
                <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-ink/[0.08] text-ink-soft"><Icon name="check" size={12} /></span>
                <span className="flex-1">{showDone ? t('rail.todos.hideDone') : t('rail.todos.doneCount', { count: doneCount })}</span>
                <InspectorChevron open={showDone} />
              </button>
            </li>
          ) : null}
          {rows.map((todo, index) => (
            <li key={`${index}:${todo.title}`} data-rail-todo={todo.status} className="flex items-start gap-2 py-0.5">
              <span
                aria-hidden
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
                  todo.status === 'done'
                    ? 'border-transparent bg-ink/[0.08] text-ink-soft'
                    : todo.status === 'in_progress' ? 'border-ink-soft text-ink-soft' : 'border-hairline-strong bg-panel'
                }`}
              >
                {todo.status === 'done' ? <Icon name="check" size={12} /> : todo.status === 'in_progress' ? <Icon name="dot" size={12} /> : null}
              </span>
              <span className={`text-[13px] leading-snug break-words ${
                todo.status === 'done' ? 'text-ink-faint line-through' : todo.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-soft'
              }`}>
                <span className="sr-only">{t(todo.status === 'done' ? 'rail.todo.srDone' : todo.status === 'in_progress' ? 'rail.todo.srInProgress' : 'rail.todo.srPending')}</span>
                {todo.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
