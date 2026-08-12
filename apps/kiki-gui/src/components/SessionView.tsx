/**
 * SessionView — live transcript + composer for /s/:id.
 *
 * Mirrors the previous App-session surface, now isolated as a route target.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';

import type { PermissionMode, Session } from '@moonshot-ai/protocol';

import { Composer } from './Composer';
import { QueueStrip } from './QueueStrip';
import { RightRail } from './RightRail';
import { TerminalPanel } from './TerminalPanel';
import { Transcript } from './Transcript';
import { KikiMark } from './Wordmark';
import {
  buildPromptContent,
  buildSkillActivation,
  type ComposerAttachment,
} from '../lib/attachments';
import { API_CODES, ApiError, isSessionNotFoundMessage } from '../lib/client';
import { readDraft, writeDraft } from '../lib/drafts';
import { isMainWindowVisibleAndFocused, showDesktopNotification } from '../lib/desktop';
import { useI18n } from '../i18n';
import {
  SESSION_REWRITTEN_EVENT,
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '../lib/sessionActions';
import {
  readTerminalPanelPrefs,
  writeTerminalPanelPrefs,
} from '../lib/terminalPrefs';
import { pushToast } from '../lib/toasts';
import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';
import { readDesktopPrefs, readLastSessionId, readSettings, writeLastSessionId } from '../lib/settings';
import { useConnection, useControllerRegistry } from '../state/connection';
import { SessionController } from '../state/sessionController';
import {
  activeTerminalManager,
  terminalCapabilityAvailable,
  TerminalManager,
} from '../state/terminalManager';
import {
  agentTranscriptToBlocks,
  createViewState,
  pendingQuestionCount,
  queuedPromptPreviews,
  type ApprovalBlock,
  type AssistantBlock,
  type NoticeBlock,
  type SessionViewState,
  type SubagentBlock,
  type UserBlock,
} from '../state/transcript';

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
  terminalAvailable,
  terminalOpen,
  onToggleRail,
  onToggleTerminal,
  onToggleSidebar,
  onJumpTurn,
  onSessionAction,
}: {
  controller: SessionController | null;
  railOpen: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleRail: () => void;
  onToggleTerminal: () => void;
  onToggleSidebar: () => void;
  onJumpTurn: (blockId: string) => void;
  onSessionAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
}) {
  const { t, tp } = useI18n();
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );
  const session = state.session;
  const unresolvedApprovalIds = useMemo(
    () =>
      state.blocks
        .filter(
          (block): block is ApprovalBlock =>
            block.kind === 'approval' && block.resolution === undefined,
        )
        .map((block) => block.request.approval_id),
    [state.blocks],
  );
  const approvals = unresolvedApprovalIds.length;
  const questions = pendingQuestionCount(state);

  // The amber badge doubles as a locator: clicking it smooth-scrolls the
  // transcript to the first unresolved approval card.
  const scrollToFirstApproval = () => {
    document
      .querySelector('[data-approval-id]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const resolveAll = (decision: 'approved' | 'rejected') => {
    if (controller === null || unresolvedApprovalIds.length === 0) return;
    const ids = unresolvedApprovalIds;
    void resolveAllApprovals(controller, ids, decision).then(({ total, failed }) => {
      if (failed === 0) {
        pushToast({ tone: 'success', text: tp('sv.batchResolved', total) });
      } else {
        pushToast({ tone: 'error', text: t('sv.batchFailed', { failed, total }) });
      }
    });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('sv.openMenuAria')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
      >
        <span aria-hidden>☰</span>
      </button>
      {session !== undefined ? (
        <>
          <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
            {session.title !== '' ? session.title : t('sidebar.untitled')}
          </h1>
          {approvals > 0 || questions > 0 ? (
            <button
              type="button"
              onClick={approvals > 0 ? scrollToFirstApproval : undefined}
              title={approvals > 0 ? t('sv.scrollToApprovals') : undefined}
              className={`shrink-0 rounded-full bg-amber-card px-2 py-0.5 text-[10.5px] font-semibold text-amber-ink ${
                approvals > 0 ? 'cursor-pointer transition-colors hover:bg-amber-rule/30' : ''
              }`}
            >
              {approvals > 0 ? tp('sv.approvals', approvals) : ''}
              {approvals > 0 && questions > 0 ? ' · ' : ''}
              {questions > 0 ? tp('sv.questions', questions) : ''}
            </button>
          ) : null}
          {approvals >= 2 ? (
            <span className="flex shrink-0 items-center gap-1" data-approval-batch>
              <button
                type="button"
                onClick={() => { resolveAll('approved'); }}
                className="rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
              >
                {t('sv.approveAll')}
              </button>
              <button
                type="button"
                onClick={() => { resolveAll('rejected'); }}
                className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-danger hover:text-danger"
              >
                {t('sv.rejectAll')}
              </button>
            </span>
          ) : null}
          {state.busy ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('sv.working')}
            </span>
          ) : null}
          {state.model !== undefined && state.model !== '' ? (
            <span className="shrink-0 rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
              {state.model}
            </span>
          ) : null}
          <TurnsMenu state={state} onJump={onJumpTurn} />
          <SessionActionsMenu onAction={onSessionAction} />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <TerminalToggle
        available={terminalAvailable}
        open={terminalOpen}
        onToggle={onToggleTerminal}
      />
      <button
        type="button"
        onClick={onToggleRail}
        title={railOpen ? t('sv.hidePanel') : t('sv.showPanel')}
        aria-label={t('sv.togglePanelAria')}
        aria-expanded={railOpen}
        className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
          railOpen
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline text-ink-soft hover:border-hairline-strong'
        }`}
      >
        {t('sv.panel')}
      </button>
    </header>
  );
}

export function TerminalToggle({
  available,
  open,
  onToggle,
}: {
  available: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? t('term.hidePanel') : t('term.showPanel')}
      aria-label={t('term.toggleAria')}
      aria-expanded={open}
      data-terminal-toggle
      className={`shrink-0 rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors ${
        open
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-hairline text-ink-soft hover:border-hairline-strong'
      }`}
    >
      {t('term.toggle')}
    </button>
  );
}

/**
 * Route boundary for `/s/:id/*`. The child key is the synchronous ownership
 * fence: changing A -> B unmounts every A-specific controller/terminal handler
 * instead of letting React reuse them for B.
 */
export function SessionRouteView({
  sessionId,
  onToggleSidebar,
  sessions,
}: {
  sessionId: string | undefined;
  onToggleSidebar: () => void;
  sessions: readonly Session[];
}) {
  return (
    <SessionView
      key={sessionId}
      onToggleSidebar={onToggleSidebar}
      sessions={sessions}
    />
  );
}

function TurnsMenu({
  state,
  onJump,
}: {
  state: SessionViewState;
  onJump: (blockId: string) => void;
}) {
  const { t } = useI18n();
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
        onClick={() => { setOpen((value) => !value); }}
        title={t('sv.jumpTitle')}
        className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
          open
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline text-ink-soft hover:border-hairline-strong'
        }`}
      >
        {t('sv.turns', { count: turns.length })}
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

/** Header overflow menu: fork / export / compact / undo for the open session. */
function SessionActionsMenu({
  onAction,
}: {
  onAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay('session-actions-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.closest('[data-session-actions]') === null
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

  const itemClass =
    'w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper';
  const pick = (action: 'fork' | 'undo' | 'compact' | 'export') => {
    setOpen(false);
    onAction(action);
  };
  return (
    <div className="relative shrink-0" data-session-actions>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        title={t('sv.actionsAria')}
        aria-label={t('sv.actionsAria')}
        aria-expanded={open}
        className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
          open
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline text-ink-soft hover:border-hairline-strong'
        }`}
      >
        {t('sv.actions')}
      </button>
      {open ? (
        <div className="anim-enter absolute right-0 top-7 z-40 w-48 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]">
          <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('fork'); }}>
            {t('menu.fork')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('export'); }}>
            {t('menu.export')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('compact'); }}>
            {t('menu.compact')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} hover:text-danger`}
            onClick={() => { pick('undo'); }}
          >
            {t('menu.undo')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
const emptyView = createViewState('');
const emptyState = () => emptyView;
/** Stable no-op handler for the read-only agent transcript (keeps BlockView memos). */
const noopLoadOlder = () => Promise.resolve(false);

/** Live media query (resize-aware) for overlay-vs-inline layout decisions. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => { setMatches(event.matches); };
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => { list.removeEventListener('change', onChange); };
  }, [query]);
  return matches;
}

type ModelSource = 'server-default' | 'session' | 'override';

/** How long the not-found card stays before /s/:id falls back home. */
export const NOT_FOUND_FALLBACK_MS = 3000;

/**
 * Permission/plan/swarm pills are controlled by the server-reported store
 * fields (snapshot agent_config + `agent.status.updated`): another client —
 * or the server itself — can move them. The local override is only an
 * optimistic echo: an uncommitted pill click wins until the store reports the
 * same value, then `shouldClearModeOverride` retires it.
 */
export function resolveControlledValue<T>(
  override: T | undefined,
  storeValue: T | undefined,
  fallback: T,
): T {
  return override ?? storeValue ?? fallback;
}

export function resolveControlledFlag(
  override: boolean | undefined,
  storeValue: boolean,
  loaded: boolean,
  fallback: boolean,
): boolean {
  // Before the snapshot lands the store holds zero-value defaults, so the
  // caller's configured default still wins over them.
  return override ?? (loaded ? storeValue : fallback);
}

export function shouldClearModeOverride<T>(
  override: T | undefined,
  storeValue: T | undefined,
): boolean {
  return override !== undefined && storeValue === override;
}

/**
 * Batch approval resolution: settles every pending card, reporting how many
 * decisions failed to send (individual cards keep their own retry path).
 */
export async function resolveAllApprovals(
  controller: Pick<SessionController, 'resolveApproval'>,
  approvalIds: readonly string[],
  decision: 'approved' | 'rejected',
): Promise<{ total: number; failed: number }> {
  const results = await Promise.allSettled(
    approvalIds.map((id) => controller.resolveApproval(id, decision)),
  );
  return {
    total: approvalIds.length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

/** Sticky toast for a failed abort; the retry button re-runs it and re-toasts on failure. */
function pushAbortFailureToast(controller: SessionController, message: string): void {
  pushToast({
    tone: 'error',
    text: message,
    retry: {
      run: () => {
        void controller
          .abortActive()
          .catch(() => { pushAbortFailureToast(controller, message); });
      },
    },
  });
}

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
  // With no focused card, y/n acts on the topmost visible pending card — the
  // <kbd> hints on every pending card advertise exactly that target.
  if (visible.length > 0) {
    const id = visible[0]!.dataset['approvalId'];
    if (id !== undefined) return id;
  }
  return undefined;
}

export function SessionView({
  onToggleSidebar,
  sessions,
}: {
  onToggleSidebar: () => void;
  /** Polled session records owned by App (page-1 polling there). */
  sessions: readonly Session[];
}) {
  const { id } = useParams<{ id: string }>();
  const sessionId = id!;
  const { client, socket, meta, wsStatus } = useConnection();
  const terminalAvailable = terminalCapabilityAvailable(meta.capabilities);
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const agentMatch = useMatch('/s/:id/agent/:agentId');
  const selectedAgentId = agentMatch?.params.agentId;
  const initialPromptRef = useRef(
    (location.state as { initialPrompt?: string } | null)?.initialPrompt,
  );
  const initialOptionsRef = useRef(
    (location.state as {
      model?: string;
      thinking?: string;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      swarmMode?: boolean;
      goalObjective?: string;
      initialAttachments?: ComposerAttachment[];
    } | null) ?? {},
  );
  const defaults = useMemo(() => readSettings(), []);
  // Below lg the rail is a fixed overlay drawer (see .app-rail in index.css):
  // start it closed there so no backdrop sits over the transcript uninvited.
  const railIsOverlay = useMediaQuery('(max-width: 1023px)');
  const [railOpen, setRailOpen] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches,
  );
  // Permission/plan/swarm are store-controlled (see resolveControlledValue):
  // local state is only the optimistic echo of an uncommitted pill click.
  const [permissionOverride, setPermissionOverride] = useState<PermissionMode | undefined>(
    initialOptionsRef.current.permissionMode,
  );
  const [planOverride, setPlanOverride] = useState(
    initialOptionsRef.current.planMode,
  );
  const [swarmOverride, setSwarmOverride] = useState(
    initialOptionsRef.current.swarmMode,
  );
  const [goalObjective, setGoalObjective] = useState(
    initialOptionsRef.current.goalObjective ?? '',
  );
  const [goalControl, setGoalControl] = useState<'pause' | 'resume' | 'cancel' | undefined>();
  const [modelOverride, setModelOverride] = useState(
    initialOptionsRef.current.model ?? defaults.defaultModel,
  );
  const [effortOverride, setEffortOverride] = useState(
    initialOptionsRef.current.thinking ?? defaults.defaultEffort,
  );
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    () => initialOptionsRef.current.initialAttachments ?? [],
  );

  const controller = useActiveController(sessionId);
  const queryClient = useQueryClient();

  // Embedded terminal panel: per-session manager (terminal list + attach
  // state) and per-session persisted panel chrome (open, height). The
  // manager opens lazily — no PTY attaches until the panel is shown.
  const [terminalManager, setTerminalManager] = useState<TerminalManager | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(
    () => readTerminalPanelPrefs(sessionId).open,
  );
  const [terminalHeight, setTerminalHeight] = useState(
    () => readTerminalPanelPrefs(sessionId).height,
  );
  useEffect(() => {
    if (!terminalAvailable) {
      setTerminalManager(null);
      return;
    }
    const manager = new TerminalManager({ sessionId, client, transport: socket });
    setTerminalManager(manager);
    return () => {
      manager.dispose();
      setTerminalManager(null);
    };
  }, [client, socket, sessionId, terminalAvailable]);
  // React can reuse SessionView for /s/A -> /s/B. The keyed route remounts the
  // owner, while this synchronous identity guard also ensures the old manager
  // cannot render or receive UI actions during reconciliation.
  const currentTerminalManager = activeTerminalManager(
    terminalManager,
    sessionId,
    terminalAvailable,
  );
  useEffect(() => {
    const prefs = readTerminalPanelPrefs(sessionId);
    setTerminalOpen(prefs.open);
    setTerminalHeight(prefs.height);
  }, [sessionId]);
  useEffect(() => {
    currentTerminalManager?.setTransportConnected(wsStatus === 'open');
  }, [currentTerminalManager, wsStatus]);
  useEffect(() => {
    // Gate on the socket: attach frames need an open, hello'd connection.
    if (terminalOpen && currentTerminalManager !== null && wsStatus === 'open') {
      void currentTerminalManager.open();
    }
  }, [terminalOpen, currentTerminalManager, wsStatus]);
  const toggleTerminalPanel = useCallback(() => {
    setTerminalOpen((value) => {
      writeTerminalPanelPrefs(sessionId, { open: !value });
      return !value;
    });
  }, [sessionId]);
  const handleTerminalHeightChange = useCallback(
    (height: number, final: boolean) => {
      setTerminalHeight(height);
      if (final) writeTerminalPanelPrefs(sessionId, { height });
    },
    [sessionId],
  );

  // Remember this session as the redirect target for `/`.
  useEffect(() => {
    try {
      localStorage.setItem('kiki.lastSessionId', sessionId);
    } catch {
      // ignore
    }
  }, [sessionId]);

  // Close the rail drawer on Escape (the app-level sidebar closes itself);
  // the terminal panel gets the same treatment, and while it is open it is a
  // registered overlay so Escape cannot also abort the running turn.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRailOpen(false);
      if (terminalOpen) toggleTerminalPanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [terminalOpen, toggleTerminalPanel]);
  useEffect(() => {
    if (!terminalOpen) return;
    return registerOverlay('terminal-panel');
  }, [terminalOpen]);

  // Per-session composer drafts.
  useEffect(() => {
    setDraft(readDraft(sessionId));
    setAttachments([]);
  }, [sessionId]);
  const updateDraft = (text: string) => {
    setDraft(text);
    writeDraft(sessionId, text);
  };

  // A sidebar-initiated undo rewrites this session's history; resync the open
  // controller so the transcript matches the server.
  useEffect(() => {
    const onRewritten = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId === sessionId) void controller?.resync();
    };
    window.addEventListener(SESSION_REWRITTEN_EVENT, onRewritten);
    return () => { window.removeEventListener(SESSION_REWRITTEN_EVENT, onRewritten); };
  }, [controller, sessionId]);

  // The undo-confirm dialog is an overlay: Escape closes it (and must not
  // fall through to the global Escape-to-abort handler).
  useEffect(() => {
    if (!confirmUndo) return;
    const unregister = registerOverlay('confirm-undo');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmUndo(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [confirmUndo]);

  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );

  // Store-controlled pills: the server-reported value wins unless a local
  // click is still waiting to be committed with the next prompt.
  const permissionMode = resolveControlledValue(
    permissionOverride,
    state.permissionMode,
    defaults.defaultPermissionMode,
  );
  const planMode = resolveControlledFlag(planOverride, state.planMode, state.loaded, defaults.defaultPlanMode);
  const swarmMode = resolveControlledFlag(swarmOverride, state.swarmMode, state.loaded, false);
  useEffect(() => {
    if (shouldClearModeOverride(permissionOverride, state.permissionMode)) {
      setPermissionOverride(undefined);
    }
  }, [permissionOverride, state.permissionMode]);
  useEffect(() => {
    if (state.loaded && shouldClearModeOverride(planOverride, state.planMode)) {
      setPlanOverride(undefined);
    }
  }, [planOverride, state.loaded, state.planMode]);
  useEffect(() => {
    if (state.loaded && shouldClearModeOverride(swarmOverride, state.swarmMode)) {
      setSwarmOverride(undefined);
    }
  }, [swarmOverride, state.loaded, state.swarmMode]);

  // A deleted/unknown session can never recover: toast the reason, keep the
  // card visible for a beat, then fall back home (clearing the remembered id
  // so `/` doesn't redirect straight back into the 404).
  const loadError = state.loadError;
  useEffect(() => {
    if (loadError === undefined || !isSessionNotFoundMessage(loadError)) return;
    pushToast({ tone: 'info', text: t('sv.sessionGone') });
    const timer = setTimeout(() => {
      if (readLastSessionId() === sessionId) writeLastSessionId(undefined);
      void navigate('/new', { replace: true });
    }, NOT_FOUND_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [loadError, sessionId, navigate, t]);

  const agentTranscriptQuery = useQuery({
    queryKey: ['agent-transcript', sessionId, selectedAgentId],
    queryFn: () => client.getAgentTranscript(sessionId, selectedAgentId!),
    enabled: selectedAgentId !== undefined,
    refetchInterval: selectedAgentId === undefined ? false : 1500,
  });

  // Live per-agent channel: child-agent frames land in their own sub-store, so
  // an open agent page re-renders from here without the main transcript
  // republishing for every hidden child delta.
  const subscribeAgent = useCallback(
    (listener: () => void) =>
      controller === null || selectedAgentId === undefined
        ? () => {}
        : controller.subscribeAgent(selectedAgentId, listener),
    [controller, selectedAgentId],
  );
  const agentLiveState = useSyncExternalStore(subscribeAgent, () =>
    controller !== null && selectedAgentId !== undefined
      ? controller.getAgentState(selectedAgentId)
      : emptyView,
  );

  // The sessions list lives in App (single owner, page-1 polling); this view
  // only merges the polled record for ITS session into the live controller.
  useEffect(() => {
    if (controller === null) return;
    const record = sessions.find((item) => item.id === controller.sessionId);
    if (record !== undefined) controller.handleSessionRecord(record);
  }, [controller, sessions]);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const serverDefaultModel = configQuery.data?.default_model;

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });

  const sessionModel = state.model;
  const effectiveModel = modelOverride ?? sessionModel ?? serverDefaultModel;
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.model === effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  useEffect(() => {
    setEffortOverride(undefined);
  }, [effectiveModel]);
  const effectiveEffort =
    supportedEfforts !== undefined && supportedEfforts.length > 0
      ? (effortOverride ?? catalogItem?.default_effort ?? supportedEfforts[0])
      : undefined;

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
          void controller
            .abortActive()
            .catch((error: unknown) => {
              pushAbortFailureToast(
                controller,
                error instanceof Error ? error.message : t('sv.abortMaybeRunning'),
              );
            });
        }
        return;
      }
      if (event.key !== 'y' && event.key !== 'n') return;
      const approvalId = resolveApprovalShortcutTarget();
      if (approvalId === undefined) return;
      event.preventDefault();
      void controller
        .resolveApproval(approvalId, event.key === 'y' ? 'approved' : 'rejected')
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.approvalShortcutFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [controller, t]);

  const actions = useMemo(() => {
    if (controller === null) return null;
    return {
      send: (text: string, composerAttachments: readonly ComposerAttachment[]) => {
        const content = buildPromptContent(text, composerAttachments);
        if (content === null) return;
        const textPart = content.find((part) => part.type === 'text');
        // Local echo shows the mention-folded text; an image-only message
        // echoes the same placeholder the transcript uses for image parts.
        const echoText =
          textPart !== undefined && textPart.type === 'text' ? textPart.text : t('sv.imageEcho');
        void controller
          .sendPrompt({
            text: echoText,
            content,
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
            swarmMode,
            goalObjective,
            goalControl,
          })
          .then(() => {
            writeDraft(sessionId, '');
            setDraft('');
            setAttachments([]);
            setGoalControl(undefined);
          })
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: error instanceof Error ? error.message : String(error),
            });
          });
      },
      activateSkill: (
        name: string,
        args: string,
        composerAttachments: readonly ComposerAttachment[],
      ) => {
        const activation = buildSkillActivation(args, composerAttachments);
        void client
          .activateSkill(sessionId, name, {
            args: activation.args === '' ? undefined : activation.args,
            attachments: activation.attachments,
          })
          .then(() => {
            writeDraft(sessionId, '');
            setDraft('');
            setAttachments([]);
          })
          .catch((error: unknown) => {
            const text =
              error instanceof ApiError && error.code === API_CODES.SKILL_NOT_FOUND
                ? t('sv.skillGone', { name })
                : error instanceof ApiError && error.code === API_CODES.SKILL_NOT_ACTIVATABLE
                  ? t('sv.skillReference', { name })
                  : error instanceof Error
                    ? error.message
                    : String(error);
            pushToast({ tone: 'error', text });
          });
      },
      abort: () =>
        controller.abortActive().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : t('sv.abortFailed');
          pushAbortFailureToast(controller, `${message}${t('sv.abortStillRunning')}`);
          // Not rethrown: the sticky toast (with retry) carries the failure.
        }),
      resolveApproval: (
        approvalId: string,
        decision: 'approved' | 'rejected' | 'cancelled',
        scope?: 'session',
      ) => controller.resolveApproval(approvalId, decision, scope),
      answerQuestion: (questionId: string, answers: Parameters<SessionController['answerQuestion']>[1]) =>
        controller.answerQuestion(questionId, answers),
      dismissQuestion: (questionId: string) => controller.dismissQuestion(questionId),
      cancelTask: (taskId: string) => {
        void controller.cancelTask(taskId).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.stopTaskFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
      },
      cancelQueued: (promptId: string) => {
        // Returned so the queue strip can hold its row pending until settle.
        return controller.abortPrompt(promptId).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.cancelQueuedFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
      },
      sendNowQueued: (promptId: string) => {
        return controller.steerQueued(promptId).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.steerQueuedFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
      },
      clearQueue: () => {
        // clearQueue settles per-prompt (allSettled) — nothing to surface.
        void controller.clearQueue();
      },
    };
  }, [
    controller,
    client,
    effectiveModel,
    effectiveEffort,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
    goalControl,
    sessionId,
    t,
  ]);

  const actionContext: SessionActionContext = useMemo(
    () => ({
      client,
      refreshSessions: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
      navigate,
    }),
    [client, queryClient, navigate],
  );

  const runSessionAction = useCallback(
    (action: 'fork' | 'undo' | 'compact' | 'export') => {
      const record = state.session;
      if (record === undefined) return;
      if (action === 'undo') {
        setConfirmUndo(true);
        return;
      }
      if (action === 'fork') {
        void forkSession(actionContext, record).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }),
          });
        });
      } else if (action === 'export') {
        void exportSessionArchive(actionContext, record)
          .then((saved) => {
            if (saved) pushToast({ tone: 'success', text: t('action.exportDoneSession') });
          })
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('action.exportFailed', { detail: sessionActionErrorText(locale, error) }),
            });
          });
      } else {
        void compactSessionContext(actionContext, record)
          .then(() => { pushToast({ tone: 'success', text: t('action.compactRequestedSession') }); })
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }),
            });
          });
      }
    },
    [actionContext, state.session, t, locale],
  );

  const confirmUndoRun = useCallback(() => {
    const record = state.session;
    setConfirmUndo(false);
    if (record === undefined) return;
    void undoLastTurn(actionContext, record)
      .then(() => { pushToast({ tone: 'success', text: t('action.undoDoneSession') }); })
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.undoFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
  }, [actionContext, state.session, t, locale]);

  // Stable transcript callbacks: inline arrows would change identity on every
  // publish, re-registering TopEdge's scroll listener and defeating the
  // memoized block components.
  const handleLoadOlder = useCallback(
    () => controller?.loadOlderMessages() ?? Promise.resolve(false),
    [controller],
  );
  const handleResolveApproval = useCallback(
    (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', scope?: 'session') =>
      controller?.resolveApproval(approvalId, decision, scope) ?? Promise.resolve(),
    [controller],
  );
  const handleAnswerQuestion = useCallback(
    (questionId: string, answers: Parameters<SessionController['answerQuestion']>[1]) =>
      controller?.answerQuestion(questionId, answers) ?? Promise.resolve(),
    [controller],
  );
  const handleDismissQuestion = useCallback(
    (questionId: string) => controller?.dismissQuestion(questionId) ?? Promise.resolve(),
    [controller],
  );
  const handleCancelQueued = useCallback(
    (promptId: string) => actions?.cancelQueued(promptId) ?? Promise.resolve(),
    [actions],
  );
  // Transcript's prop type predates the queue strip and wants a void return:
  // hand it a memoized fire-and-forget view of the same action.
  const handleCancelQueuedChips = useCallback(
    (promptId: string) => { void handleCancelQueued(promptId); },
    [handleCancelQueued],
  );
  const handleSendNowQueued = useCallback(
    (promptId: string) => actions?.sendNowQueued(promptId),
    [actions],
  );
  const handleClearQueue = useCallback(() => actions?.clearQueue(), [actions]);
  const queuedItems = useMemo(() => queuedPromptPreviews(state), [state]);
  const handleRetryLoad = useCallback(() => void controller?.retryOpen(), [controller]);

  // Submit the prompt that was drafted on /new, now that the live controller is
  // subscribed and will receive the stream.
  useEffect(() => {
    if (
      controller === null ||
      actions === null ||
      !state.loaded ||
      initialPromptRef.current === undefined
    ) {
      return;
    }
    const text = initialPromptRef.current;
    const initialAttachments = initialOptionsRef.current.initialAttachments ?? [];
    initialPromptRef.current = undefined;
    initialOptionsRef.current = {};
    // Fire-and-forget: strip the one-shot nav state from history so a refresh
    // doesn't resend the drafted prompt.
    void navigate(location.pathname, { replace: true });
    // Seed the session draft first: if this send fails, the text stays
    // recoverable in the composer (and in localStorage across reloads).
    writeDraft(sessionId, text);
    setDraft(text);
    setAttachments(initialAttachments);
    actions.send(text, initialAttachments);
  }, [controller, actions, state.loaded, location.pathname, navigate]);

  // Desktop approval notification: if the window is hidden or blurred, nudge
  // the user once per approval request.
  const lastNotifiedInteractionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.pendingInteraction !== 'approval') {
      lastNotifiedInteractionRef.current = state.pendingInteraction;
      return;
    }
    if (lastNotifiedInteractionRef.current === 'approval') return;
    lastNotifiedInteractionRef.current = 'approval';
    if (!readDesktopPrefs().notifications) return;
    void isMainWindowVisibleAndFocused().then((visibleAndFocused) => {
      if (visibleAndFocused) return;
      void showDesktopNotification({
        title: 'Kiki',
        body: t('sv.notificationBody'),
      });
    });
  }, [state.pendingInteraction, t]);

  const composerDisabled = controller === null || !state.loaded || state.loadError !== undefined;
  const modelSource: ModelSource =
    modelOverride !== undefined ? 'override' : sessionModel !== undefined ? 'session' : 'server-default';
  // The composer footer's mini meter reads the same usage fields as the rail.
  const usage = state.session?.usage;
  const contextUsed = state.contextTokens ?? usage?.context_tokens;
  const contextLimit =
    state.maxContextTokens ??
    (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined);

  // The backdrop exists only while a drawer actually overlays the transcript:
  // below lg the rail becomes a fixed overlay (see .app-rail in index.css).
  // The app-level sidebar renders its own backdrop from App.
  const showBackdrop = railIsOverlay && railOpen;
  const selectedSubagent =
    selectedAgentId === undefined
      ? undefined
      : state.blocks.find(
          (block): block is SubagentBlock =>
            block.kind === 'subagent' && block.subagentId === selectedAgentId,
        );

  if (selectedAgentId !== undefined) {
    const serverBlocks =
      agentTranscriptQuery.data === undefined
        ? undefined
        : agentTranscriptToBlocks(agentTranscriptQuery.data);
    // Live per-agent channel: frames captured since this client opened the
    // session. The polled server transcript wins when available (it carries
    // pre-open history); the live channel covers fresh activity and servers
    // without the transcript route.
    const liveBlocks = agentLiveState.blocks.length > 0 ? agentLiveState.blocks : undefined;
    const capturedBlocks = serverBlocks ?? liveBlocks ?? selectedSubagent?.transcript ?? [];
    const historyKey =
      serverBlocks !== undefined
        ? agentTranscriptQuery.data?.has_more === true
          ? 'sv.agentHistoryMore'
          : 'sv.agentHistoryLive'
        : agentTranscriptQuery.isError
          ? 'sv.agentHistoryUnavailable'
          : 'sv.agentHistoryLoading';
    const historyNotice: NoticeBlock = {
      kind: 'notice',
      id: `subagent-history-${selectedAgentId}`,
      text: t(historyKey),
      tone: 'neutral',
      i18n: { key: historyKey },
    };
    const includesReport =
      selectedSubagent?.summary !== undefined &&
      capturedBlocks.some(
        (block) => block.kind === 'assistant' && block.text.includes(selectedSubagent.summary ?? ''),
      );
    const reportBlock: AssistantBlock | undefined =
      selectedSubagent?.summary !== undefined && !includesReport
        ? {
            kind: 'assistant',
            id: `subagent-report-${selectedAgentId}`,
            text: selectedSubagent.summary,
            streaming: false,
            createdAt: selectedSubagent.endedAt,
          }
        : undefined;
    const agentState: SessionViewState = {
      ...state,
      blocks: [historyNotice, ...capturedBlocks, ...(reportBlock === undefined ? [] : [reportBlock])],
      busy: false,
      pendingInteraction: 'none',
      hasMoreHistory: false,
      loadingOlder: false,
      fetchedOlder: false,
    };
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
          <button
            type="button"
            onClick={() => void navigate(`/s/${sessionId}`)}
            className="rounded-lg border border-hairline px-2 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            {t('sv.backToSession')}
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[15px] font-semibold text-ink">
              {selectedSubagent?.name ?? selectedAgentId}
            </h1>
            <p className="truncate text-[10.5px] text-ink-faint">
              {t('sv.subagentNote')}
            </p>
          </div>
          {selectedSubagent?.model !== undefined ? (
            <span className="rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
              {selectedSubagent.model}
            </span>
          ) : null}
          <span className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-ink-soft">
            {selectedSubagent !== undefined
              ? t(`subagent.status.${selectedSubagent.status}`)
              : t('sv.historyUnavailable')}
          </span>
        </header>
        <Transcript
          state={agentState}
          onLoadOlder={noopLoadOlder}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
        />
      </main>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header
          controller={controller}
          railOpen={railOpen}
          terminalAvailable={terminalAvailable}
          terminalOpen={terminalOpen}
          onToggleRail={() => { setRailOpen((value) => !value); }}
          onToggleTerminal={toggleTerminalPanel}
          onToggleSidebar={onToggleSidebar}
          onJumpTurn={(blockId) => {
            document
              .querySelector(`[data-block-id="${blockId}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          onSessionAction={runSessionAction}
        />

        <Transcript
          state={state}
          onLoadOlder={handleLoadOlder}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
          onCancelQueued={handleCancelQueuedChips}
          onRetryLoad={handleRetryLoad}
        />
        <div className="flex items-center gap-2 px-6 pt-1">
          {state.resyncing || state.resyncFailed ? (
            <span className="mx-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
              <KikiMark className="status-dot-busy" />
              {state.resyncFailed ? t('sv.resyncFailed') : t('sv.resyncing')}
            </span>
          ) : null}
        </div>
        {queuedItems.length > 0 ? (
          <QueueStrip
            items={queuedItems}
            onSendNow={handleSendNowQueued}
            onRemove={handleCancelQueued}
            onClearAll={handleClearQueue}
          />
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
          swarmMode={swarmMode}
          goalObjective={goalObjective}
          goalStatus={state.goal?.status}
          goalControl={goalControl}
          efforts={supportedEfforts}
          effort={effectiveEffort}
          contextUsage={
            contextUsed !== undefined && contextLimit !== undefined
              ? { used: contextUsed, limit: contextLimit }
              : undefined
          }
          sessionId={sessionId}
          fsSearch={(query) =>
            client.fsSearch(sessionId, { query, limit: 30 }).then((result) => result.items)
          }
          attachments={attachments}
          onChangeAttachments={setAttachments}
          onActivateSkill={(name, args, skillAttachments) =>
            actions?.activateSkill(name, args, skillAttachments)
          }
          onSessionAction={runSessionAction}
          onCompactContext={() => { runSessionAction('compact'); }}
          onChangeModel={setModelOverride}
          onChangePermissionMode={setPermissionOverride}
          onChangePlanMode={setPlanOverride}
          onChangeSwarmMode={setSwarmOverride}
          onChangeGoalObjective={setGoalObjective}
          onChangeGoalControl={setGoalControl}
          onChangeEffort={setEffortOverride}
          onSend={(text, composerAttachments) => actions?.send(text, composerAttachments)}
          onAbort={() => void actions?.abort()}
        />
        {terminalOpen && currentTerminalManager !== null ? (
          <TerminalPanel
            manager={currentTerminalManager}
            height={terminalHeight}
            wsStatus={wsStatus}
            onHeightChange={handleTerminalHeightChange}
            onClose={toggleTerminalPanel}
          />
        ) : null}
      </main>

      {railOpen ? (
        <RightRail
          className={`app-rail ${railOpen ? 'open' : ''}`}
          state={state}
          onCancelTask={(taskId) => actions?.cancelTask(taskId)}
          onOpenSubagent={(agentId) => void navigate(`/s/${sessionId}/agent/${agentId}`)}
        />
      ) : null}

      {showBackdrop ? (
        <div
          role="button"
          tabIndex={-1}
          aria-label={t('sv.closePanel')}
          className="app-overlay-backdrop lg:hidden"
          onClick={() => {
            setRailOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setRailOpen(false);
            }
          }}
        />
      ) : null}

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {state.pendingInteraction === 'approval'
          ? t('sv.ariaAwaitingApproval')
          : state.pendingInteraction === 'question'
            ? t('sv.ariaAwaitingAnswer')
            : state.busy
              ? t('sv.ariaWorking')
              : ''}
      </div>

      {confirmUndo ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20"
          onClick={() => { setConfirmUndo(false); }}
        >
          <div
            className="anim-enter w-full max-w-[360px] rounded-2xl border border-hairline bg-panel p-5 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
            onClick={(event) => { event.stopPropagation(); }}
          >
            <h2 className="font-display text-[16px] font-semibold text-ink">{t('undo.title')}</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              {t('undo.bodySession')}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setConfirmUndo(false); }}
                className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:text-ink"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmUndoRun}
                className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep"
              >
                {t('undo.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
