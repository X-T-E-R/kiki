/**
 * App shell — 3-column layout: 264px sidebar / fluid transcript (max ~760px
 * centered) / 300px collapsible right rail. Owns the active-session
 * controller lifecycle, the sessions poll that feeds both sidebar and the
 * live session record, the connection-lost banner, and the global y/n
 * approval keyboard shortcut.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';

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
  onJumpTurn,
}: {
  controller: SessionController | null;
  railOpen: boolean;
  onToggleRail: () => void;
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

export function App() {
  const { client, wsStatus } = useConnection();
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [railOpen, setRailOpen] = useState(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual');
  const [planMode, setPlanMode] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const controller = useActiveController(activeSessionId);

  // Per-session composer drafts: restore on switch, persist on edit, clear on send.
  useEffect(() => {
    setDraft(activeSessionId !== undefined ? readDraft(activeSessionId) : '');
  }, [activeSessionId]);
  const updateDraft = (text: string) => {
    setDraft(text);
    if (activeSessionId !== undefined) writeDraft(activeSessionId, text);
  };
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );

  const sessionsQuery = useQuery({
    queryKey: ['sessions', false],
    queryFn: () => client.listSessions({ page_size: 100 }),
    refetchInterval: 5000,
  });

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
    const record = sessionsQuery.data.items.find((item) => item.id === controller.sessionId);
    if (record !== undefined) controller.handleSessionRecord(record);
  }, [controller, sessionsQuery.data]);

  // Global y / n shortcut for the oldest pending approval.
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
          void controller.abortActive();
        }
        return;
      }
      if (event.key !== 'y' && event.key !== 'n') return;
      const pending = controller
        .getState()
        .blocks.find(
          (block) => block.kind === 'approval' && block.resolution === undefined,
        );
      if (pending === undefined || pending.kind !== 'approval') return;
      event.preventDefault();
      void controller.resolveApproval(
        pending.request.approval_id,
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
        if (activeSessionId !== undefined) writeDraft(activeSessionId, '');
        setDraft('');
        void controller
          .sendPrompt({
            text,
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
          })
          .catch((error: unknown) => {
            setSendError(error instanceof Error ? error.message : String(error));
          });
      },
      abort: () => void controller.abortActive(),
      resolveApproval: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', scope?: 'session') =>
        controller.resolveApproval(approvalId, decision, scope),
      answerQuestion: (questionId: string, answers: Parameters<SessionController['answerQuestion']>[1]) =>
        void controller.answerQuestion(questionId, answers).catch(() => undefined),
      dismissQuestion: (questionId: string) =>
        void controller.dismissQuestion(questionId).catch(() => undefined),
      cancelTask: (taskId: string) => void controller.cancelTask(taskId).catch(() => undefined),
    };
  }, [controller, effectiveModel, effectiveEffort, permissionMode, planMode, activeSessionId]);

  return (
    <div className="flex h-full bg-paper">
      <Sidebar
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onCreatedSession={(session: Session) => setActiveSessionId(session.id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          controller={controller}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((value) => !value)}
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
              onAnswerQuestion={(id, answers) => actions?.answerQuestion(id, answers)}
              onDismissQuestion={(id) => actions?.dismissQuestion(id)}
            />
            {sendError !== null ? (
              <div className="px-6 pb-1">
                <div className="mx-auto max-w-[760px] rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 font-mono text-[11.5px] text-danger">
                  {sendError}
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-2 px-6 pt-1">
              {state.resyncing ? (
                <span className="mx-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <KikiMark className="status-dot-busy" /> Resyncing…
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
              disabled={false}
              value={draft}
              onChange={updateDraft}
              model={modelOverride}
              defaultModel={sessionModel}
              serverDefaultModel={serverDefaultModel}
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
        <RightRail state={state} onCancelTask={(taskId) => actions?.cancelTask(taskId)} />
      ) : null}
    </div>
  );
}
