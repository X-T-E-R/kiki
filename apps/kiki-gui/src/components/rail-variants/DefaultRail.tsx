import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import type { SessionController, SessionViewState, TodoItem } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import { useOptionalControllerRegistry } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { FOCUS_RING } from './shell';

const noopSubscribe = (): (() => void) => () => {};

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

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;
const FOLD_DONE_AT = 2;

export interface RailTodosProps {
  sessionId: string;
  agentId: string;
  state?: SessionViewState;
}

export type TodoBaselineStatus = 'ready' | 'loading' | 'partial' | 'error' | 'unknown' | 'confirmed_empty';

/**
 * The focused agent's checklist in the right rail.
 * Renders live todos from the session controller, with routed session fallback
 * for the main agent when the controller registry is initializing.
 */
export function RailTodos({ sessionId, agentId, state }: RailTodosProps) {
  const { t } = useI18n();
  const { controller, agentState } = useAgentState(sessionId, agentId);
  const { id: routeSessionId } = useParams<{ id?: string }>();

  const isMain = agentId === MAIN_AGENT_ID;
  const routeMatches = routeSessionId === undefined || routeSessionId === sessionId;
  const sessionMatches = state?.session === undefined || state.session.id === sessionId;
  const canFallback = agentState === undefined && isMain && state !== undefined && state.sessionId === sessionId && routeMatches && sessionMatches;
  const effectiveState = agentState ?? (canFallback ? state : undefined);

  let status: TodoBaselineStatus = 'unknown';
  let baselineConfirmed = false;

  if (agentState !== undefined) {
    const todoCoverage = agentState.globalCoverage?.todos;
    const todoRefs = agentState.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' && ref.path[0] === 'items') ?? [];
    const todoReadFailed = todoRefs.some((ref) => agentState.detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') ||
      (todoCoverage?.hasMore === true && agentState.detailLoads['entities:todo']?.status === 'error');
    const hasLoadError = !agentState.loaded && agentState.loadError !== undefined;
    const isError = todoReadFailed || hasLoadError;

    baselineConfirmed = agentState.loaded === true && agentState.transcriptReady === true;
    const rawTodos = agentState.todos ?? [];
    const hasMoreOrRefs = todoCoverage?.hasMore === true || todoRefs.length > 0;

    if (isError) {
      status = 'error';
    } else if (!agentState.loaded) {
      status = 'unknown';
    } else if (!baselineConfirmed || hasMoreOrRefs) {
      status = rawTodos.length > 0 ? 'partial' : 'loading';
    } else if (rawTodos.length === 0) {
      status = 'confirmed_empty';
    } else {
      status = 'ready';
    }
  } else if (canFallback && state !== undefined) {
    const fallbackCoverage = state.globalCoverage?.todos;
    const fallbackRefs = state.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' && ref.path[0] === 'items') ?? [];
    const hasMoreOrRefs = fallbackCoverage?.hasMore === true || fallbackRefs.length > 0;
    const hasLoadError = !state.loaded && state.loadError !== undefined;
    const rawTodos = state.todos ?? [];
    baselineConfirmed = state.loaded === true && state.transcriptReady === true;

    if (hasLoadError) {
      status = 'error';
    } else if (!state.loaded) {
      status = 'unknown';
    } else if (!baselineConfirmed || hasMoreOrRefs) {
      status = rawTodos.length > 0 ? 'partial' : 'loading';
    } else if (rawTodos.length === 0) {
      status = 'confirmed_empty';
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

  const displayedTodos: readonly TodoItem[] =
    status === 'ready' || status === 'partial' || status === 'loading' || status === 'error' ? activeTodos : [];

  const [open, setOpen] = useState(true);
  const [showDone, setShowDone] = useState(false);

  if (displayedTodos.length === 0) {
    if (status === 'error') {
      return (
        <section data-rail-todos="" data-rail-todos-error="" className="pt-0.5">
          <div className="flex h-7 items-center gap-1.5 px-0.5 text-ink-faint">
            <span className={INSPECTOR_HEAD}>{t('inspector.todos')}</span>
            <span className="flex-1" />
            <span role="status" className="text-[12px] text-ink-faint">
              {t('agentPanel.todos.loadFailed')}
              {controller !== undefined ? (
                <button
                  type="button"
                  data-rail-todos-retry=""
                  onClick={() => { void controller.refreshSession?.(); }}
                  className={`ml-1.5 rounded font-medium text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}
                >
                  {t('common.retry')}
                </button>
              ) : null}
            </span>
          </div>
        </section>
      );
    }
    if (status === 'loading') {
      return (
        <section data-rail-todos="" data-rail-todos-loading="" className="pt-0.5">
          <div className="flex h-7 items-center gap-1.5 px-0.5 text-ink-faint">
            <span className={INSPECTOR_HEAD}>{t('inspector.todos')}</span>
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
        {status === 'loading' || status === 'partial' ? (
          <span role="status" className="pr-1 text-[11px] text-ink-faint">{t('agentPanel.todos.loading')}</span>
        ) : status === 'error' ? (
          <span role="status" className="pr-1 text-[11px] text-ink-faint">{t('agentPanel.todos.loadFailed')}</span>
        ) : null}
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
