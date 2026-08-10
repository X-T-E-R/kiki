/**
 * App shell — 3-column layout: 264px sidebar / fluid transcript (max ~760px
 * centered) / 300px collapsible right rail. Owns the active-session
 * controller lifecycle, the sessions poll that feeds both sidebar and the
 * live session record, the connection-lost banner, and the global y/n
 * approval keyboard shortcut.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { PermissionMode, Session } from '@moonshot-ai/protocol';

import { Composer } from './components/Composer';
import { RightRail } from './components/RightRail';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { KikiMark, Wordmark } from './components/Wordmark';
import { readDraft, writeDraft } from './lib/drafts';
import { anyOverlayOpen, registerOverlay } from './lib/uiBusy';
import { useConnection, useControllerRegistry } from './state/connection';
import { SessionController } from './state/sessionController';
import {
  createViewState,
  pendingApprovalCount,
  pendingQuestionCount,
  type SessionViewState,
  type UserBlock,
} from './state/transcript';

function useActiveController(sessionId: string | undefined): SessionController | null {
  const { client, socket } = useConnection();
  const registry = useControllerRegistry();
  const [controller, setController] = useState<SessionController | null>(null);

  useEffect(() => {
    if (sessionId === undefined) {
      setController(null);
      return;
    }
    const next = new SessionController(client, socket, sessionId);
    registry.add(next);
    setController(next);
    void next.open().catch(() => {
      // snapshot failure leaves the controller unloaded; the transcript shows
      // "Opening session…" until a resync succeeds
    });
    return () => {
      registry.delete(next);
      next.close();
      setController(null);
    };
  }, [client, socket, sessionId, registry]);

  return controller;
}

function Header({
  controller,
  railOpen,
  onToggleRail,
  onToggleSidebar,
  onJumpTurn,
}: {
  controller: SessionController | null;
  railOpen: boolean;
  onToggleRail: () => void;
  onToggleSidebar: () => void;
  onJumpTurn: (blockId: string) => void;
}) {
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );
  const session = state.session;
  const approvals = pendingApprovalCount(state);
  const questions = pendingQuestionCount(state);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Open session menu"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
      >
        <span aria-hidden>☰</span>
      </button>
      {session !== undefined ? (
        <>
          <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
            {session.title !== '' ? session.title : 'Untitled session'}
          </h1>
          {approvals > 0 || questions > 0 ? (
            <span className="shrink-0 rounded-full bg-amber-card px-2 py-0.5 text-[10.5px] font-semibold text-amber-ink">
              {approvals > 0 ? `${approvals} approval${approvals === 1 ? '' : 's'}` : ''}
              {approvals > 0 && questions > 0 ? ' · ' : ''}
              {questions > 0 ? `${questions} question${questions === 1 ? '' : 's'}` : ''}
            </span>
          ) : null}
          {state.busy ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              working
            </span>
          ) : null}
          {state.model !== undefined && state.model !== '' ? (
            <span className="shrink-0 rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
              {state.model}
            </span>
          ) : null}
          <TurnsMenu state={state} onJump={onJumpTurn} />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <button
        type="button"
        onClick={onToggleRail}
        title={railOpen ? 'Hide panel' : 'Show panel'}
        className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
          railOpen
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline text-ink-soft hover:border-hairline-strong'
        }`}
      >
        ☰ Panel
      </button>
    </header>
  );
}

/**
 * Turn-jump dropdown (grok-build's `/jump` concept, minimal): lists the
 * session's user turns; clicking one scrolls that block into view.
 */
function TurnsMenu({
  state,
  onJump,
}: {
  state: SessionViewState;
  onJump: (blockId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const turns = useMemo(
    () =>
      state.blocks
        .filter((block): block is UserBlock => block.kind === 'user')
        .map((block, index) => ({
          id: block.id,
          index: index + 1,
          label: block.text.replaceAll(/\s+/g, ' ').trim().slice(0, 60),
        })),
    [state.blocks],
  );

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay('turns-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-turns-menu]') === null
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  if (turns.length < 2) return null;
  return (
    <div className="relative shrink-0" data-turns-menu>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Jump to a turn"
        className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
          open
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline text-ink-soft hover:border-hairline-strong'
        }`}
      >
        ↕ {turns.length} turns
      </button>
      {open ? (
        <div className="anim-enter absolute right-0 top-7 z-40 max-h-80 w-72 overflow-y-auto rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]">
          {turns.map((turn) => (
            <button
              key={turn.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onJump(turn.id);
              }}
              className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-paper"
            >
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">{turn.index}</span>
              <span className="min-w-0 truncate text-[12px] text-ink">{turn.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const noopSubscribe = () => () => {};
const emptyView = createViewState('');
const emptyState = () => emptyView;

type ModelSource = 'server-default' | 'session' | 'override';

/**
 * Decide which approval the global y/n shortcut should target. Preference:
 *   1. Focus is inside an approval card (unambiguous context).
 *   2. Exactly one approval card is visible in the viewport.
 * If more than one is visible and none is focused, the shortcut is ambiguous
 * and must not act.
 */
function resolveApprovalShortcutTarget(): string | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const focusedCard = active.closest('[data-approval-id]') as HTMLElement | null;
    if (focusedCard !== null) {
      const id = focusedCard.dataset['approvalId'];
      if (id !== undefined) return id;
    }
  }
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-approval-id]'));
  const visible = cards.filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });
  if (visible.length === 1) {
    const id = visible[0]!.dataset['approvalId'];
    if (id !== undefined) return id;
  }
  return undefined;
}

export function App() {
  const { client, wsStatus } = useConnection();
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual');
  const [planMode, setPlanMode] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | null>(null);
  const [abortError, setAbortError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const controller = useActiveController(activeSessionId);

  // Close mobile panels on Escape and when the active session changes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        setRailOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Per-session composer drafts: restore on switch, persist on edit, clear on send.
  useEffect(() => {
    setDraft(activeSessionId !== undefined ? readDraft(activeSessionId) : '');
    setSendError(null);
    setAbortError(null);
  }, [activeSessionId]);
  const updateDraft = (text: string) => {
    setDraft(text);
    if (activeSessionId !== undefined) writeDraft(activeSessionId, text);
  };
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['sessions', showArchived],
    queryFn: ({ pageParam }) =>
      client.listSessions({
        page_size: 100,
        include_archive: showArchived || undefined,
        before_id: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.items.at(-1)?.id : undefined,
    initialPageParam: undefined as string | undefined,
    refetchInterval: 5000,
  });
  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [sessionsQuery.data],
  );

  // The server's configured default model backs sessions that bind none.
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const serverDefaultModel = configQuery.data?.default_model;

  // Merge polled session records into the live controller.
  useEffect(() => {
    if (controller === null || sessionsQuery.data === undefined) return;
    const record = sessions.find((item) => item.id === controller.sessionId);
    if (record !== undefined) controller.handleSessionRecord(record);
  }, [controller, sessions, sessionsQuery.data]);

  // Global y / n shortcut for the focused-or-unambiguous visible approval.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (controller === null) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Escape aborts the running turn — but never while a menu/dialog is
      // open, and never while typing in a real form field (the composer
      // textarea, marked data-composer, is fair game).
      if (event.key === 'Escape') {
        if (anyOverlayOpen()) return;
        const inFormField =
          target !== null &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable ||
            (target.tagName === 'TEXTAREA' && !Object.hasOwn(target.dataset, 'composer')));
        if (inFormField) return;
        const current = controller.getState();
        if (current.busy && current.activePromptId !== undefined) {
          event.preventDefault();
          setAbortError(null);
          void controller
            .abortActive()
            .then(() => setAbortError(null))
            .catch((error: unknown) => {
              setAbortError(
                error instanceof Error
                  ? error.message
                  : 'Could not abort — the turn may still be running',
              );
            });
        }
        return;
      }
      if (event.key !== 'y' && event.key !== 'n') return;
      const approvalId = resolveApprovalShortcutTarget();
      if (approvalId === undefined) return;
      event.preventDefault();
      void controller.resolveApproval(
        approvalId,
        event.key === 'y' ? 'approved' : 'rejected',
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  const sessionModel = state.model;
  const effectiveModel = modelOverride ?? sessionModel ?? serverDefaultModel;

  // Thinking effort: only when the catalog advertises support_efforts for the
  // effective model (honest degradation — the UI hides it entirely otherwise).
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const catalogItem = (modelsQuery.data?.items ?? []).find(
    (item) => item.model === effectiveModel,
  );
  const supportedEfforts = catalogItem?.support_efforts;
  useEffect(() => {
    setEffortOverride(undefined);
  }, [effectiveModel]);
  const effectiveEffort =
    supportedEfforts !== undefined && supportedEfforts.length > 0
      ? (effortOverride ?? catalogItem?.default_effort ?? supportedEfforts[0])
      : undefined;

  const actions = useMemo(() => {
    if (controller === null) return null;
    return {
      send: (text: string) => {
        setSendError(null);
        void controller
          .sendPrompt({
            text,
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
          })
          .then(() => {
            if (activeSessionId !== undefined) writeDraft(activeSessionId, '');
            setDraft('');
          })
          .catch((error: unknown) => {
            setSendError(error instanceof Error ? error.message : String(error));
          });
      },
      abort: () => {
        setAbortError(null);
        return controller
          .abortActive()
          .then(() => setAbortError(null))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'Abort failed';
            setAbortError(`${message} — this turn may still be running`);
            throw error;
          });
      },
      resolveApproval: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', scope?: 'session') =>
        controller.resolveApproval(approvalId, decision, scope),
      answerQuestion: (questionId: string, answers: Parameters<SessionController['answerQuestion']>[1]) =>
        controller.answerQuestion(questionId, answers),
      dismissQuestion: (questionId: string) => controller.dismissQuestion(questionId),
      cancelTask: (taskId: string) => void controller.cancelTask(taskId).catch(() => undefined),
    };
  }, [controller, effectiveModel, effectiveEffort, permissionMode, planMode, activeSessionId]);

  const composerDisabled = controller === null || !state.loaded || state.loadError !== undefined;
  const modelSource: ModelSource =
    modelOverride !== undefined
      ? 'override'
      : sessionModel !== undefined
        ? 'session'
        : 'server-default';

  const showBackdrop = sidebarOpen || (railOpen && controller !== null);

  return (
    <div className="flex h-full overflow-hidden bg-paper">
      <Sidebar
        className={`app-sidebar ${sidebarOpen ? 'open' : ''}`}
        activeSessionId={activeSessionId}
        onSelectSession={(sessionId) => {
          setSidebarOpen(false);
          setActiveSessionId(sessionId);
        }}
        onCreatedSession={(session: Session) => {
          setSidebarOpen(false);
          setActiveSessionId(session.id);
        }}
        sessions={sessions}
        sessionsQuery={sessionsQuery}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((value) => !value)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          controller={controller}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((value) => !value)}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          onJumpTurn={(blockId) => {
            document
              .querySelector(`[data-block-id="${blockId}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />

        {wsStatus !== 'open' ? (
          <div className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink">
            {wsStatus === 'connecting'
              ? 'Connection lost — reconnecting…'
              : 'Disconnected from the server. Events will resume on reconnect.'}
          </div>
        ) : null}

        {controller === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="opacity-40">
              <Wordmark size="lg" />
            </div>
            <p className="max-w-64 text-center text-[13px] leading-relaxed text-ink-faint">
              Pick a session from the sidebar, or start a new one — kiki keeps the bench warm.
            </p>
          </div>
        ) : (
          <>
            <Transcript
              state={state}
              onLoadOlder={() => controller.loadOlderMessages()}
              onResolveApproval={(id, decision, scope) =>
                actions?.resolveApproval(id, decision, scope) ?? Promise.resolve()
              }
              onAnswerQuestion={(id, answers) =>
                actions?.answerQuestion(id, answers) ?? Promise.resolve()
              }
              onDismissQuestion={(id) => actions?.dismissQuestion(id) ?? Promise.resolve()}
              onRetryLoad={() => controller.retryOpen()}
            />
            {sendError !== null ? (
              <div className="px-6 pb-1">
                <div className="mx-auto max-w-[760px] rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 font-mono text-[11.5px] text-danger">
                  {sendError}
                </div>
              </div>
            ) : null}
            {abortError !== null ? (
              <div className="px-6 pb-1">
                <div className="mx-auto max-w-[760px] rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 font-mono text-[11.5px] text-danger">
                  {abortError}
                  <button
                    type="button"
                    onClick={() => actions?.abort()}
                    className="ml-2 underline"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-2 px-6 pt-1">
              {state.resyncing || state.resyncFailed ? (
                <span className="mx-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <KikiMark className="status-dot-busy" />
                  {state.resyncFailed ? 'Resync failed — retrying…' : 'Resyncing…'}
                </span>
              ) : null}
            </div>
            {state.queuedPromptIds.length > 0 ? (
              <div className="px-6 pb-1.5">
                <div className="mx-auto flex max-w-[760px]">
                  <span className="rounded-full border border-amber-rule/40 bg-amber-card px-2.5 py-0.5 text-[11px] font-medium text-amber-ink">
                    ◔ {state.queuedPromptIds.length} prompt{state.queuedPromptIds.length === 1 ? '' : 's'} queued — starts when the current turn finishes
                  </span>
                </div>
              </div>
            ) : null}
            <Composer
              busy={state.busy && state.activePromptId !== undefined}
              disabled={composerDisabled}
              value={draft}
              onChange={updateDraft}
              model={modelOverride}
              defaultModel={sessionModel}
              serverDefaultModel={serverDefaultModel}
              modelSource={modelSource}
              permissionMode={permissionMode}
              planMode={planMode}
              efforts={supportedEfforts}
              effort={effectiveEffort}
              onChangeModel={setModelOverride}
              onChangePermissionMode={setPermissionMode}
              onChangePlanMode={setPlanMode}
              onChangeEffort={setEffortOverride}
              onSend={(text) => actions?.send(text)}
              onAbort={() => actions?.abort()}
            />
          </>
        )}
      </main>

      {railOpen && controller !== null ? (
        <RightRail
          className={`app-rail ${railOpen ? 'open' : ''}`}
          state={state}
          onCancelTask={(taskId) => actions?.cancelTask(taskId)}
        />
      ) : null}

      {showBackdrop ? (
        <div
          role="button"
          tabIndex={-1}
          aria-label="Close panels"
          className="app-overlay-backdrop lg:hidden"
          onClick={() => {
            setSidebarOpen(false);
            setRailOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSidebarOpen(false);
              setRailOpen(false);
            }
          }}
        />
      ) : null}

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {state.pendingInteraction === 'approval'
          ? 'Awaiting approval'
          : state.pendingInteraction === 'question'
            ? 'Awaiting answer'
            : state.busy
              ? 'Kiki is working'
              : ''}
      </div>
    </div>
  );
}
