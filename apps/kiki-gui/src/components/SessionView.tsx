/**
 * SessionView — live transcript + composer for /s/:id.
 *
 * Mirrors the previous App-session surface, now isolated as a route target.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';

import type { PermissionMode, Session } from '@moonshot-ai/protocol';

import { AgentBreadcrumb, AgentRelations } from './AgentBreadcrumb';
import { ConfirmDialog } from './ConfirmDialog';
import { Composer, resolveSelectedEffort } from './Composer';
import { ContextBreakdownProvider, ContextMeter } from './ContextMeter';
import {
  useConversationShell,
  useRegisterSeat,
  type ConversationPhase,
  type ConversationSeat,
} from './ConversationShell';
import { QueueStrip } from './QueueStrip';
import { RightRail } from './RightRail';
import { SelectionQuoteButton } from './SelectionQuoteButton';
import { TerminalPanel } from './TerminalPanel';
import { Transcript, useStableForest, type TranscriptRowActions } from './Transcript';
import { MediaPreviewProvider, PreviewToggleButton } from './mediaPreview';
import { KikiMark } from './Wordmark';
import {
  buildPromptContent,
  buildSkillActivation,
  type ComposerAttachment,
} from '../lib/attachments';
import { API_CODES, ApiError, isSessionNotFoundMessage } from '../lib/client';
import { readComposerState, readDraft, writeComposerState, writeDraft } from '../lib/drafts';
import { isMainWindowVisibleAndFocused, showDesktopNotification } from '../lib/desktop';
import { buildQuotePrefix } from '../lib/selectionQuote';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n/locale';
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
import {
  readDesktopPrefs,
  readLastSessionId,
  readSettings,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeLastSessionId,
  type ComposerModelSource,
} from '../lib/settings';
import { useConnection, useControllerRegistry } from '../state/connection';
import { assertSessionWritable, SessionController } from '../state/sessionController';
import {
  activeTerminalManager,
  terminalCapabilityAvailable,
  TerminalManager,
} from '../state/terminalManager';
import {
  agentPath,
  applyNewestAgentPage,
  blockTurnId,
  mergeAgentTranscript,
  prependOlderAgentPage,
  type AgentHistoryCache,
} from '../state/agentTree';
import {
  MAIN_AGENT_ID,
  agentBusyFromMeta,
  agentTranscriptPageFromResponse,
  agentTranscriptToBlocks,
  assistantMessageIdFromBlockId,
  countToolBlocks,
  createViewState,
  filterBlocksToDirectChildren,
  oldestTurnIdFromResponse,
  pendingQuestionCount,
  queuedPromptPreviews,
  resolveSpawnInstruction,
  sessionAgentForestFromTranscript,
  type ApprovalBlock,
  type AssistantBlock,
  type Block,
  type NoticeBlock,
  type SessionViewState,
  type SubagentBlock,
  type UserBlock,
} from '../state/transcript';

/** Queue edit wire fallback: remove the old prompt, then resubmit at the tail. */
export async function replaceQueuedPrompt(
  promptId: string,
  text: string,
  abort: (id: string) => Promise<void>,
  resend: (replacement: string) => Promise<void>,
): Promise<void> {
  await abort(promptId);
  await resend(text);
}

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
  effectiveModel,
  modelSource,
  onToggleRail,
  onToggleTerminal,
  onToggleSidebar,
  onJumpTurn,
  onSessionAction,
  onRequestBatchResolve,
}: {
  controller: SessionController | null;
  railOpen: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  effectiveModel: string | undefined;
  modelSource: ModelSource;
  onToggleRail: () => void;
  onToggleTerminal: () => void;
  onToggleSidebar: () => void;
  onJumpTurn: (blockId: string) => void;
  onSessionAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
  onRequestBatchResolve: (decision: 'approved' | 'rejected', ids: readonly string[]) => void;
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

  const requestBatch = (decision: 'approved' | 'rejected') => {
    if (unresolvedApprovalIds.length === 0) return;
    onRequestBatchResolve(decision, unresolvedApprovalIds);
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
                onClick={() => { requestBatch('approved'); }}
                className="rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
              >
                {t('sv.approveAll')}
              </button>
              <button
                type="button"
                onClick={() => { requestBatch('rejected'); }}
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
          {effectiveModel !== undefined && effectiveModel !== '' ? (
            <span
              className="shrink-0 rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft"
              title={t('composer.modelTitle', { source: t(`composer.modelSource.${modelSource}`) })}
            >
              {effectiveModel}
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
      <PreviewToggleButton />
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

type ModelSource = ComposerModelSource;

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

/**
 * The session route's seat phase for the conversation shell: a cold open
 * (transcript still loading, no first-prompt hand-off in the nav state)
 * settles — the seat stays mounted but hidden so no wrong layout flashes.
 * The /new hand-off knows the session is blank-about-to-run, so it docks
 * straight into active. A loaded-but-empty session is also active: the blank
 * transcript keeps its in-column wordmark empty state with the composer
 * docked, the long-standing geometry.
 */
export function resolveSessionSeatPhase(input: {
  loaded: boolean;
  hasInitialPrompt: boolean;
}): ConversationPhase {
  return !input.loaded && !input.hasInitialPrompt ? 'settling' : 'active';
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

export interface ApprovalShortcutCard {
  readonly id: string;
  readonly pending: boolean;
  readonly visible: boolean;
  readonly focused: boolean;
}

/**
 * y/n target: the focused pending approval, or the only visible pending card.
 * Multiple visible pending cards with no focus, and any resolved card, miss.
 */
export function resolveApprovalShortcutTarget(
  cards: readonly ApprovalShortcutCard[],
): string | undefined {
  const focused = cards.find((card) => card.focused);
  if (focused !== undefined) return focused.pending ? focused.id : undefined;
  const visiblePending = cards.filter((card) => card.pending && card.visible);
  return visiblePending.length === 1 ? visiblePending[0]!.id : undefined;
}

/**
 * True when a y/n press cannot pick a target but pending cards are on screen
 * (several visible, none focused): the press is a silent no-op, so the caller
 * surfaces a hint instead of leaving the shortcut looking broken.
 */
export function isApprovalShortcutAmbiguous(
  cards: readonly ApprovalShortcutCard[],
): boolean {
  if (cards.some((card) => card.focused && card.pending)) return false;
  return cards.filter((card) => card.pending && card.visible).length > 1;
}

/** y/n must not fire while a dialog, overlay, or popover owns the keyboard. */
export function shouldHandleApprovalShortcut(input: {
  key: string;
  overlayOpen: boolean;
  inEditable: boolean;
}): boolean {
  if (input.overlayOpen || input.inEditable) return false;
  return input.key === 'y' || input.key === 'n';
}

export function collectApprovalShortcutCards(
  root: ParentNode = document,
  viewport: { innerHeight: number } = window,
  active: Element | null = document.activeElement,
): ApprovalShortcutCard[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-approval-id]')).flatMap((card) => {
    const id = card.dataset['approvalId'];
    if (id === undefined) return [];
    const rect = card.getBoundingClientRect();
    return [{
      id,
      // Only pending cards mount `[data-approval-id]`; resolved cards drop it.
      pending: true,
      visible: rect.top < viewport.innerHeight && rect.bottom > 0,
      focused: active instanceof Node && card.contains(active),
    }];
  });
}

/** True when Escape should go to the PTY instead of closing chrome or aborting. */
export function isTerminalEscapeTarget(target: EventTarget | null): boolean {
  if (target === null || typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  return (
    target.closest('[data-terminal-canvas]') !== null ||
    target.closest('.xterm') !== null ||
    target.closest('.xterm-helper-textarea') !== null
  );
}

/**
 * Global Escape closer for rail / terminal. Overlay and PTY own the key first;
 * abort stays in the other listener and must not double-fire.
 */
export function shouldCloseSessionChromeOnEscape(input: {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  terminalFocused: boolean;
}): boolean {
  if (input.key !== 'Escape') return false;
  if (input.defaultPrevented || input.overlayOpen || input.terminalFocused) return false;
  return true;
}

export function agentTranscriptPoll(input: {
  selectedAgentId: string | undefined;
}): { pageSize: number; refetchInterval: number } {
  return input.selectedAgentId === undefined
    ? { pageSize: 1, refetchInterval: 5000 }
    : { pageSize: 100, refetchInterval: 1500 };
}

export interface AgentOlderFetchGate {
  readonly generation: number;
  readonly inFlight: boolean;
}

export interface AgentOlderRequest {
  readonly generation: number;
  readonly sessionId: string;
  readonly agentId: string;
}

export const INITIAL_AGENT_OLDER_FETCH_GATE: AgentOlderFetchGate = {
  generation: 0,
  inFlight: false,
};

/** Bump the token so a previous agent's in-flight request can no longer commit. */
export function resetAgentOlderFetchGate(gate: AgentOlderFetchGate): AgentOlderFetchGate {
  return { generation: gate.generation + 1, inFlight: false };
}

export function beginAgentOlderFetch(input: {
  selectedAgentId: string | undefined;
  sessionId: string;
  oldestTurnId: string | undefined;
  hasMore: boolean;
  gate: AgentOlderFetchGate;
}): { gate: AgentOlderFetchGate; request: AgentOlderRequest } | undefined {
  if (
    input.selectedAgentId === undefined ||
    input.oldestTurnId === undefined ||
    !input.hasMore ||
    input.gate.inFlight
  ) {
    return undefined;
  }
  return {
    gate: { generation: input.gate.generation, inFlight: true },
    request: {
      generation: input.gate.generation,
      sessionId: input.sessionId,
      agentId: input.selectedAgentId,
    },
  };
}

export function isLiveAgentOlderRequest(
  gate: AgentOlderFetchGate,
  request: AgentOlderRequest,
  current: { sessionId: string; selectedAgentId: string | undefined },
): boolean {
  return (
    request.generation === gate.generation &&
    request.sessionId === current.sessionId &&
    request.agentId === current.selectedAgentId
  );
}

/** Drop a stale finally so it cannot clear a newer agent's in-flight bit. */
export function finishAgentOlderFetch(
  gate: AgentOlderFetchGate,
  request: Pick<AgentOlderRequest, 'generation'>,
): AgentOlderFetchGate {
  if (request.generation !== gate.generation) return gate;
  return { generation: gate.generation, inFlight: false };
}

export async function settleAgentOlderFetch<T>(input: {
  getGate: () => AgentOlderFetchGate;
  setGate: (next: AgentOlderFetchGate) => void;
  request: AgentOlderRequest;
  current: () => { sessionId: string; selectedAgentId: string | undefined };
  work: () => Promise<T>;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
}): Promise<{ committed: boolean; value?: T }> {
  try {
    const value = await input.work();
    if (!isLiveAgentOlderRequest(input.getGate(), input.request, input.current())) {
      return { committed: false };
    }
    input.onSuccess(value);
    return { committed: true, value };
  } catch (error) {
    if (!isLiveAgentOlderRequest(input.getGate(), input.request, input.current())) {
      return { committed: false };
    }
    input.onError(error);
    return { committed: false };
  } finally {
    input.setGate(finishAgentOlderFetch(input.getGate(), input.request));
  }
}

export function agentOlderErrorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

export function agentDetailPath(sessionId: string, agentId: string): string {
  return `/s/${sessionId}/agent/${encodeURIComponent(agentId)}`;
}

function ResyncStatusBanner({
  resyncing,
  resyncFailed,
  onRetry,
}: {
  resyncing: boolean;
  resyncFailed: boolean;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (!resyncing && !resyncFailed) return null;
  return (
    <div className="flex items-center gap-2 px-6 pt-1">
      <span className="mx-auto flex items-center gap-2 text-[11px] text-ink-faint">
        <KikiMark className="status-dot-busy" />
        <span>
          {resyncing ? t('sv.resyncing') : t('sv.resyncFailed')}
          {' · '}
          {t('sv.sendPaused')}
        </span>
        {resyncFailed && !resyncing && onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            {t('sv.resyncRetryNow')}
          </button>
        ) : null}
      </span>
    </div>
  );
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
  const { slots } = useConversationShell();
  const terminalAvailable = terminalCapabilityAvailable(meta.capabilities);
  const { t, tp, time, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const agentMatch = useMatch('/s/:id/agent/:agentId');
  const selectedAgentId = agentMatch?.params.agentId;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Throttle for the ambiguous y/n hint (epoch ms of the last toast).
  const lastAmbiguityToastRef = useRef(0);
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
  const liveSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const defaults = useMemo(() => readSettings(), []);
  // Composer chrome captured the last time this session was open (memory
  // only): attachment chips and pill overrides restore instead of vanishing
  // on every session switch. The /new hand-off state wins on first mount.
  const restoredComposer = useMemo(() => readComposerState(sessionId), [sessionId]);
  // Below lg the rail is a fixed overlay drawer (see .app-rail in index.css):
  // start it closed there so no backdrop sits over the transcript uninvited.
  const railIsOverlay = useMediaQuery('(max-width: 1023px)');
  const [railOpen, setRailOpen] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches,
  );
  // Permission/plan/swarm are store-controlled (see resolveControlledValue):
  // local state is only the optimistic echo of an uncommitted pill click.
  const [permissionOverride, setPermissionOverride] = useState<PermissionMode | undefined>(
    restoredComposer.permissionMode ?? initialOptionsRef.current.permissionMode,
  );
  const [planOverride, setPlanOverride] = useState(
    restoredComposer.planMode ?? initialOptionsRef.current.planMode,
  );
  const [swarmOverride, setSwarmOverride] = useState(
    restoredComposer.swarmMode ?? initialOptionsRef.current.swarmMode,
  );
  const [goalObjective, setGoalObjective] = useState(
    restoredComposer.goalObjective ?? initialOptionsRef.current.goalObjective ?? '',
  );
  const [goalControl, setGoalControl] = useState<'pause' | 'resume' | 'cancel' | undefined>();
  const [modelOverride, setModelOverride] = useState(() =>
    restoredComposer.modelOverride ??
    resolveSessionModelOverride(initialOptionsRef.current.model),
  );
  // The effort visible in Composer is the value sent with the next prompt.
  // A restored or /new hand-off choice still wins over the catalog default.
  const [effortOverride, setEffortOverride] = useState(
    restoredComposer.effortOverride ?? initialOptionsRef.current.thinking,
  );
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState<
    { decision: 'approved' | 'rejected'; ids: readonly string[] } | undefined
  >(undefined);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    () => initialOptionsRef.current.initialAttachments ?? restoredComposer.attachments ?? [],
  );
  // Transcript text quoted into the composer via the floating selection
  // button. The route keys this component by session id, so the quote resets
  // with the session; send (and the chip's ×) clear it explicitly.
  const [quote, setQuote] = useState<string | null>(null);
  const transcriptQuoteRef = useRef<HTMLDivElement>(null);
  const handleQuoteSelection = useCallback((text: string) => {
    setQuote(text);
    // Return focus to the composer so the user can type the follow-up at once.
    document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus();
  }, []);
  const handleRemoveQuote = useCallback(() => { setQuote(null); }, []);

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

  // Close the rail drawer on Escape (the app-level sidebar closes itself).
  // Overlay / PTY own the key first; abort lives in the other listener and
  // skips when the terminal panel is open so the two cannot double-fire.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldCloseSessionChromeOnEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          overlayOpen: anyOverlayOpen(),
          terminalFocused: isTerminalEscapeTarget(event.target),
        })
      ) {
        return;
      }
      if (!railOpen && !terminalOpen) return;
      event.preventDefault();
      setRailOpen(false);
      if (terminalOpen) toggleTerminalPanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [railOpen, terminalOpen, toggleTerminalPanel]);

  // Per-session composer drafts + chrome. Attachments and pill overrides are
  // seeded by the initializers on first mount (the /new hand-off wins, then
  // memory); only the draft text needs this effect because it has no
  // initializer. The route keys this component by session id, so this runs
  // once per session mount.
  useEffect(() => {
    setDraft(readDraft(sessionId));
  }, [sessionId]);
  // Stable identity: the shell-seat memo depends on it (a fresh function per
  // render would re-publish the composer on every keystroke's render).
  const updateDraft = useCallback((text: string) => {
    setDraft(text);
    writeDraft(sessionId, text);
  }, [sessionId]);

  // Capture the composer chrome that should survive a session switch:
  // attachment chips and pill overrides, memory-only (see lib/drafts.ts).
  useEffect(() => {
    writeComposerState(sessionId, {
      attachments,
      permissionMode: permissionOverride,
      planMode: planOverride,
      swarmMode: swarmOverride,
      goalObjective,
      modelOverride,
      effortOverride,
    });
  }, [
    sessionId,
    attachments,
    permissionOverride,
    planOverride,
    swarmOverride,
    goalObjective,
    modelOverride,
    effortOverride,
  ]);

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

  const rosterAgentId = selectedAgentId ?? MAIN_AGENT_ID;
  const agentPoll = agentTranscriptPoll({ selectedAgentId });
  const agentTranscriptQuery = useQuery({
    queryKey: ['agent-transcript', sessionId, rosterAgentId, agentPoll.pageSize],
    queryFn: () => client.getAgentTranscript(sessionId, rosterAgentId, { pageSize: agentPoll.pageSize }),
    refetchInterval: agentPoll.refetchInterval,
  });
  const [agentHistory, setAgentHistory] = useState<(AgentHistoryCache & { blocks: readonly Block[] }) | null>(null);
  const agentHistoryRef = useRef(agentHistory);
  agentHistoryRef.current = agentHistory;
  const [loadingOlderAgent, setLoadingOlderAgent] = useState(false);
  const agentOlderFetchGateRef = useRef<AgentOlderFetchGate>(INITIAL_AGENT_OLDER_FETCH_GATE);
  const [agentOlderError, setAgentOlderError] = useState<string | undefined>(undefined);
  useEffect(() => {
    agentOlderFetchGateRef.current = resetAgentOlderFetchGate(agentOlderFetchGateRef.current);
    setAgentHistory(null);
    setLoadingOlderAgent(false);
    setAgentOlderError(undefined);
  }, [selectedAgentId, sessionId]);
  useEffect(() => {
    if (selectedAgentId === undefined || agentTranscriptQuery.data === undefined) return;
    const response = agentTranscriptQuery.data;
    const serverBlocks = agentTranscriptToBlocks(response);
    const newestPage = agentTranscriptPageFromResponse(response, serverBlocks);
    setAgentHistory((current) => {
      const next = applyNewestAgentPage(current, selectedAgentId, newestPage);
      return { ...next, blocks: next.page.blocks as readonly Block[] };
    });
  }, [agentTranscriptQuery.data, selectedAgentId]);

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
  // Server default first: the local mirror is a stale-prone echo of the same
  // server field, so it only fills in when the server has not reported one.
  const inheritedDefault = serverDefaultModel ?? liveSettings.defaultModel;
  const effectiveModel = resolveEffectiveModel(modelOverride, sessionModel, inheritedDefault);
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.model === effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  // Retire an explicit effort override only when the effective model's catalog
  // no longer lists it — never on mere model resolution, so a user pick (or a
  // /new hand-off) survives the snapshot landing.
  useEffect(() => {
    if (effortOverride === undefined) return;
    if (supportedEfforts === undefined || supportedEfforts.length === 0) return;
    if (!supportedEfforts.includes(effortOverride)) setEffortOverride(undefined);
  }, [effortOverride, supportedEfforts]);
  const effectiveEffort = resolveSelectedEffort(
    supportedEfforts,
    effortOverride,
    catalogItem?.default_effort,
  );

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
        if (isTerminalEscapeTarget(event.target)) return;
        if (terminalOpen) return;
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
      if (
        !shouldHandleApprovalShortcut({
          key: event.key,
          overlayOpen: anyOverlayOpen(),
          inEditable: false,
        })
      ) {
        return;
      }
      const cards = collectApprovalShortcutCards();
      const approvalId = resolveApprovalShortcutTarget(cards);
      if (approvalId === undefined) {
        // Ambiguous press (several visible cards, nothing focused): a plain
        // no-op reads as a broken shortcut — point at the cards instead.
        // Throttled so holding the key does not flood the toast stack.
        if (isApprovalShortcutAmbiguous(cards) && Date.now() - lastAmbiguityToastRef.current > 1500) {
          lastAmbiguityToastRef.current = Date.now();
          pushToast({ tone: 'info', text: t('sv.approvalAmbiguous') });
        }
        return;
      }
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
  }, [controller, t, terminalOpen]);

  const actions = useMemo(() => {
    if (controller === null) return null;
    return {
      send: (text: string, composerAttachments: readonly ComposerAttachment[]) => {
        // A quoted transcript selection rides the prompt text as a Markdown
        // blockquote prefix — exactly what the transcript renders back.
        const quotedText = quote !== null ? `${buildQuotePrefix(quote)}${text}` : text;
        const content = buildPromptContent(quotedText, composerAttachments);
        if (content === null) return;
        const textPart = content.find((part) => part.type === 'text');
        // Local echo shows the mention-folded text; a media-only message
        // echoes the same placeholder the transcript uses for those parts.
        const echoText =
          textPart !== undefined && textPart.type === 'text'
            ? textPart.text
            : composerAttachments.some((item) => item.kind === 'upload')
              ? t('sv.fileEcho')
              : t('sv.imageEcho');
        void controller
          .sendPrompt({
            text: echoText,
            content,
            model: effectiveModel,
            // FU7: the select's visible value is the prompt's wire value,
            // including the catalog default when the user leaves it untouched.
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
            setQuote(null);
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
        try {
          assertSessionWritable(controller.getState());
        } catch (error: unknown) {
          pushToast({
            tone: 'error',
            text: error instanceof Error ? error.message : t('sv.sendPaused'),
          });
          return;
        }
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
      editQueued: (promptId: string, text: string) =>
        replaceQueuedPrompt(
          promptId,
          text,
          (id) => controller.abortPrompt(id),
          (replacement) => controller.sendPrompt({
            text: replacement,
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
            swarmMode,
            goalObjective,
            goalControl,
          }),
        ).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.editQueuedFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
          throw error;
        }),
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
      clearQueue: () =>
        controller.clearQueue().then((result) => {
          if (result.failed > 0) {
            pushToast({
              tone: 'error',
              text: t('sv.queueClearFailed', { failed: result.failed, total: result.total }),
            });
          }
          return result;
        }),
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
    quote,
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

  const confirmClearQueueRun = useCallback(() => {
    setConfirmClearQueue(false);
    void actions?.clearQueue();
  }, [actions]);
  const handleBatchResolve = useCallback(
    (decision: 'approved' | 'rejected', ids: readonly string[]) => {
      setBatchConfirm({ decision, ids });
    },
    [],
  );
  const confirmBatchRun = useCallback(() => {
    if (controller === null || batchConfirm === undefined) return;
    const { decision, ids } = batchConfirm;
    setBatchConfirm(undefined);
    void resolveAllApprovals(controller, ids, decision).then(({ total, failed }) => {
      if (failed === 0) {
        pushToast({ tone: 'success', text: tp('sv.batchResolved', total) });
      } else {
        pushToast({ tone: 'error', text: t('sv.batchFailed', { failed, total }) });
      }
    });
  }, [batchConfirm, controller, t, tp]);

  // Stable transcript callbacks: inline arrows would change identity on every
  // publish, re-registering TopEdge's scroll listener and defeating the
  // memoized block components.
  const handleLoadOlder = useCallback(
    () => controller?.loadOlderMessages() ?? Promise.resolve(false),
    [controller],
  );

  // ---- message-closure row actions (edit-resend / regenerate / fork) ----

  const handleEditMessage = useCallback(
    (block: UserBlock, text: string) => {
      if (controller === null || block.userMessageId === undefined) return;
      controller.editMessage(block.userMessageId, { text }).catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.editFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
    },
    [controller, t, locale],
  );

  /**
   * Wire message id behind an assistant row. Snapshot-derived block ids embed
   * it; live-finalized ones don't, and while regenerate/fork is eligible (idle
   * session, latest reply) the newest assistant message on the server IS that
   * reply — resolve it with one messages fetch.
   */
  const resolveAssistantMessageId = useCallback(
    async (block: AssistantBlock): Promise<string | undefined> => {
      const fromBlock = assistantMessageIdFromBlockId(block.id);
      if (fromBlock !== undefined) return fromBlock;
      const page = await client.listMessages(sessionId, { page_size: 50 });
      const assistants = page.items
        .filter((message) => message.role === 'assistant')
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      return assistants.at(-1)?.id;
    },
    [client, sessionId],
  );

  const handleRegenerate = useCallback(
    (block: AssistantBlock) => {
      if (controller === null) return;
      void (async () => {
        const messageId = await resolveAssistantMessageId(block);
        if (messageId === undefined) {
          pushToast({ tone: 'error', text: t('error.messageActionUnavailable') });
          return;
        }
        await controller.regenerateMessage(messageId);
      })().catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.regenerateFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
    },
    [controller, resolveAssistantMessageId, t, locale],
  );

  const handleForkMessage = useCallback(
    (block: UserBlock | AssistantBlock) => {
      if (controller === null) return;
      void (async () => {
        const messageId =
          block.kind === 'user'
            ? block.userMessageId
            : await resolveAssistantMessageId(block);
        if (messageId === undefined) {
          pushToast({ tone: 'error', text: t('error.messageActionUnavailable') });
          return;
        }
        // Open-tail fork: navigate only — nothing auto-runs in the copy.
        const fork = await controller.forkFromMessage(messageId);
        queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined);
        pushToast({ tone: 'success', text: t('action.forkDoneSession') });
        void navigate(`/s/${fork.id}`);
      })().catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
    },
    [controller, resolveAssistantMessageId, queryClient, navigate, t, locale],
  );

  const transcriptRowActions = useMemo<TranscriptRowActions>(
    () => ({
      disabled: state.busy || state.resyncing || state.resyncFailed,
      onEditMessage: handleEditMessage,
      onRegenerate: handleRegenerate,
      onFork: handleForkMessage,
    }),
    [state.busy, state.resyncing, state.resyncFailed, handleEditMessage, handleRegenerate, handleForkMessage],
  );

  const openAgent = useCallback(
    (agentId: string) => {
      if (agentId === MAIN_AGENT_ID) {
        void navigate(`/s/${sessionId}`);
        return;
      }
      void navigate(agentDetailPath(sessionId, agentId));
    },
    [navigate, sessionId],
  );
  const handleLoadOlderAgent = useCallback(async (): Promise<boolean> => {
    if (selectedAgentId === undefined) return false;
    const currentHistory = agentHistoryRef.current;
    const cursor = currentHistory?.agentId === selectedAgentId ? currentHistory.page.oldestTurnId : undefined;
    const started = beginAgentOlderFetch({
      selectedAgentId,
      sessionId,
      oldestTurnId: cursor,
      hasMore: currentHistory?.page.hasMore === true,
      gate: agentOlderFetchGateRef.current,
    });
    if (started === undefined) return false;
    agentOlderFetchGateRef.current = started.gate;
    setLoadingOlderAgent(true);
    setAgentOlderError(undefined);
    const settled = await settleAgentOlderFetch({
      getGate: () => agentOlderFetchGateRef.current,
      setGate: (next) => {
        agentOlderFetchGateRef.current = next;
        if (next.generation === started.request.generation) {
          setLoadingOlderAgent(next.inFlight);
        }
      },
      request: started.request,
      current: () => ({
        sessionId: sessionIdRef.current,
        selectedAgentId: selectedAgentIdRef.current,
      }),
      work: async () => {
        const older = await client.getAgentTranscript(sessionId, selectedAgentId, { beforeTurn: cursor });
        const olderBlocks = agentTranscriptToBlocks(older);
        return { olderBlocks, olderPage: agentTranscriptPageFromResponse(older, olderBlocks) };
      },
      onSuccess: ({ olderBlocks, olderPage }) => {
        setAgentHistory((current) => {
          if (current === null || current.agentId !== selectedAgentId) {
            return { agentId: selectedAgentId, page: olderPage, blocks: olderBlocks };
          }
          const nextPage = prependOlderAgentPage(current.page, olderPage);
          return {
            agentId: selectedAgentId,
            page: nextPage,
            blocks: nextPage.blocks as readonly Block[],
          };
        });
        setAgentOlderError(undefined);
      },
      onError: (error) => {
        setAgentOlderError(agentOlderErrorText(error));
      },
    });
    return settled.committed && (settled.value?.olderBlocks.length ?? 0) > 0;
  }, [client, selectedAgentId, sessionId]);
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
  const handleEditQueued = useCallback(
    (promptId: string, text: string) => actions?.editQueued(promptId, text) ?? Promise.resolve(),
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
  const handleClearQueue = useCallback(() => {
    if ((actions?.clearQueue) === undefined) return;
    setConfirmClearQueue(true);
  }, [actions]);
  const queuedItems = useMemo(() => queuedPromptPreviews(state), [state]);
  const handleRetryLoad = useCallback(() => void controller?.retryOpen(), [controller]);

  // Submit the prompt that was drafted on /new, now that the live controller is
  // subscribed and will receive the stream.
  useEffect(() => {
    if (
      controller === null ||
      actions === null ||
      !state.loaded ||
      state.resyncing ||
      state.resyncFailed ||
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
  }, [controller, actions, state.loaded, state.resyncing, state.resyncFailed, location.pathname, navigate, sessionId]);

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

  const composerDisabled =
    controller === null ||
    !state.loaded ||
    state.loadError !== undefined ||
    state.resyncing ||
    state.resyncFailed;
  const modelSource: ModelSource = resolveModelSource(
    modelOverride,
    sessionModel,
    liveSettings.defaultModel,
    serverDefaultModel,
  );
  // The composer footer's mini meter reads the same usage fields as the rail.
  const usage = state.session?.usage;
  const contextUsed = state.contextTokens ?? usage?.context_tokens;
  const contextLimit =
    state.maxContextTokens ??
    (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined);

  // ---- conversation shell seat ----
  // The composer element is published into ConversationShell's seat (stable
  // tree position) instead of rendering here, so the textarea DOM node
  // survives the /new → /s/:id transition. The seat object MUST stay memoized
  // — the registration effect keys on identity — so every reactive value the
  // composer element reads is a dep below, and every handler is stabilized.
  const handleFsSearch = useCallback(
    (query: string) =>
      client.fsSearch(sessionId, { query, limit: 30 }).then((result) => result.items),
    [client, sessionId],
  );
  const handleActivateSkill = useCallback(
    (name: string, args: string, skillAttachments: readonly ComposerAttachment[]) =>
      actions?.activateSkill(name, args, skillAttachments),
    [actions],
  );
  const handleCompactContext = useCallback(() => { runSessionAction('compact'); }, [runSessionAction]);
  const handleComposerSend = useCallback(
    (text: string, composerAttachments: readonly ComposerAttachment[]) =>
      actions?.send(text, composerAttachments),
    [actions],
  );
  const handleComposerAbort = useCallback(() => void actions?.abort(), [actions]);

  const composerBusy = state.busy && state.activePromptId !== undefined;
  // The subagent page is read-only chrome over the same session: active
  // geometry, no composer (as before this change).
  const seat = useMemo<ConversationSeat>(() => ({
    phase:
      selectedAgentId === undefined
        ? // initialPromptRef is a mount-time constant until the auto-send
          // consumes it post-load — safe to read here, and `state.loaded`
          // covers the reactive edge.
          resolveSessionSeatPhase({
            loaded: state.loaded,
            hasInitialPrompt: initialPromptRef.current !== undefined,
          })
        : 'active',
    composer:
      selectedAgentId !== undefined ? null : (
        <ContextBreakdownProvider value={state.contextBreakdown}>
          <Composer
            busy={composerBusy}
            disabled={composerDisabled}
            busyPlaceholder={state.resyncing || state.resyncFailed ? t('sv.sendPaused') : undefined}
            value={draft}
            onChange={updateDraft}
            model={modelOverride}
            defaultModel={sessionModel}
            serverDefaultModel={inheritedDefault}
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
            sessionUsage={usage}
            sessionId={sessionId}
            fsSearch={handleFsSearch}
            attachments={attachments}
            onChangeAttachments={setAttachments}
            quote={quote}
            onRemoveQuote={handleRemoveQuote}
            onActivateSkill={handleActivateSkill}
            onSessionAction={runSessionAction}
            onCompactContext={handleCompactContext}
            onChangeModel={setModelOverride}
            onChangePermissionMode={setPermissionOverride}
            onChangePlanMode={setPlanOverride}
            onChangeSwarmMode={setSwarmOverride}
            onChangeGoalObjective={setGoalObjective}
            onChangeGoalControl={setGoalControl}
            onChangeEffort={setEffortOverride}
            onSend={handleComposerSend}
            onAbort={handleComposerAbort}
          />
        </ContextBreakdownProvider>
      ),
  }), [
    selectedAgentId,
    state.loaded,
    state.resyncing,
    state.resyncFailed,
    state.goal?.status,
    state.contextBreakdown,
    composerBusy,
    composerDisabled,
    draft,
    updateDraft,
    modelOverride,
    sessionModel,
    inheritedDefault,
    modelSource,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
    goalControl,
    supportedEfforts,
    effectiveEffort,
    contextUsed,
    contextLimit,
    sessionId,
    handleFsSearch,
    attachments,
    quote,
    handleRemoveQuote,
    handleActivateSkill,
    runSessionAction,
    handleCompactContext,
    handleComposerSend,
    handleComposerAbort,
    t,
  ]);
  useRegisterSeat(seat);

  // The backdrop exists only while a drawer actually overlays the transcript:
  // below lg the rail becomes a fixed overlay (see .app-rail in index.css).
  // The app-level sidebar renders its own backdrop from App.
  const showBackdrop = railIsOverlay && railOpen;
  const forestRaw = useMemo(
    () => sessionAgentForestFromTranscript(state, agentTranscriptQuery.data),
    [state, agentTranscriptQuery.data],
  );
  // Content-stabilized forest: rebuilt per publish above, but identical in
  // content across streaming deltas — keep the previous object so downstream
  // derivations (mainTranscriptBlocks) and Transcript's row/page memos are
  // not broken by unrelated state publishes.
  const forest = useStableForest(forestRaw);
  // Main-transcript projection, memoized so unrelated publishes don't rescan
  // the full block list; per-delta publishes reuse it when blocks/forest are
  // untouched.
  const mainTranscriptBlocks = useMemo(
    () => filterBlocksToDirectChildren(state.blocks, forest, MAIN_AGENT_ID),
    [state.blocks, forest],
  );
  const selectedNode = selectedAgentId === undefined ? undefined : forest.byId[selectedAgentId];
  const selectedSubagent =
    selectedAgentId === undefined
      ? undefined
      : state.blocks.find(
          (block): block is SubagentBlock =>
            block.kind === 'subagent' && block.subagentId === selectedAgentId,
        );
  const crumbs = useMemo(
    () => (selectedAgentId === undefined ? [] : agentPath(forest, selectedAgentId)),
    [forest, selectedAgentId],
  );

  if (selectedAgentId !== undefined) {
    const historyForAgent = agentHistory?.agentId === selectedAgentId ? agentHistory : null;
    const serverPage =
      historyForAgent?.page ??
      (agentTranscriptQuery.data === undefined
        ? {
            blocks: [],
            hasMore: false,
            oldestTurnId: oldestTurnIdFromResponse(agentTranscriptQuery.data),
          }
        : agentTranscriptPageFromResponse(
            agentTranscriptQuery.data,
            agentTranscriptToBlocks(agentTranscriptQuery.data),
          ));
    const liveLoaded = agentLiveState.loaded && agentLiveState.blocks.length > 0;
    const liveBlocks = agentLiveState.blocks;
    const fallbackBlocks = selectedSubagent?.transcript ?? [];
    const merged = mergeAgentTranscript(
      serverPage,
      {
        blocks: liveBlocks,
        model: agentLiveState.model,
        thinkingEffort: agentLiveState.thinkingEffort,
        contextTokens: agentLiveState.contextTokens,
        maxContextTokens: agentLiveState.maxContextTokens,
        usage: agentLiveState.usage,
        busy: liveLoaded ? agentLiveState.busy : undefined,
        toolCallCount: liveLoaded ? countToolBlocks(liveBlocks) : undefined,
      },
      {
        blocks: fallbackBlocks,
        toolCallCount: selectedSubagent?.toolCallCount,
      },
    );
    const capturedBlocks = merged.blocks as Block[];
    // Pre-patch transcripts may lack the initial subagent turn prompt. Keep the
    // spawn tool input as a conversation-flow fallback, but prefer real turn
    // prompts so initial and follow-up parent messages preserve turn order.
    const spawnInstruction = resolveSpawnInstruction({
      response: agentTranscriptQuery.data,
      blocks: state.blocks,
      agentId: selectedAgentId,
      parentToolCallId: selectedSubagent?.parentToolCallId,
    });
    const spawnTurnId =
      spawnInstruction?.turnId === undefined
        ? undefined
        : blockTurnId({ id: '', kind: 'user', turnId: spawnInstruction.turnId });
    const hasEquivalentSpawnPrompt = capturedBlocks.some((block) => {
      if (block.kind !== 'user') return false;
      const turnId = blockTurnId(block);
      return turnId !== undefined && (spawnTurnId === undefined || turnId === spawnTurnId);
    });
    const spawnFallbackBlock: UserBlock | undefined =
      spawnInstruction?.source === 'spawn-call' && !hasEquivalentSpawnPrompt
        ? {
            kind: 'user',
            id: `user-agent-spawn-${selectedAgentId}`,
            text: spawnInstruction.text,
            createdAt: selectedNode?.startedAt ?? selectedSubagent?.startedAt ?? '',
            turnId: spawnInstruction.turnId,
          }
        : undefined;
    const historyKey =
      agentTranscriptQuery.data !== undefined || historyForAgent !== null
        ? merged.hasMore
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
    const headerBusy =
      selectedNode?.busy === true ||
      merged.busy ||
      agentBusyFromMeta(agentTranscriptQuery.data) === true;
    const statusLabel =
      selectedNode !== undefined
        ? t(`subagent.status.${selectedNode.status}` as I18nKey)
        : selectedSubagent !== undefined
          ? t(`subagent.status.${selectedSubagent.status}` as I18nKey)
          : t('sv.historyUnavailable');
    const displayName = selectedNode?.label ?? selectedSubagent?.name ?? selectedAgentId;
    const displayModel = merged.model ?? selectedNode?.model ?? selectedSubagent?.model;
    const displayEffort =
      merged.thinkingEffort ?? selectedNode?.thinkingEffort ?? selectedSubagent?.thinkingEffort;
    const displayContextTokens = merged.contextTokens ?? selectedNode?.contextTokens;
    const displayMaxContextTokens = merged.maxContextTokens ?? selectedNode?.maxContextTokens;
    const displayUsage = merged.usage ?? selectedNode?.usage;
    const totalUsage = displayUsage?.total;
    const cumulativeTokens =
      totalUsage === undefined
        ? undefined
        : totalUsage.inputOther +
          totalUsage.inputCacheRead +
          totalUsage.inputCacheCreation +
          totalUsage.output;
    const agentState: SessionViewState = {
      ...state,
      blocks: [
        historyNotice,
        ...(spawnFallbackBlock === undefined ? [] : [spawnFallbackBlock]),
        ...filterBlocksToDirectChildren(capturedBlocks, forest, selectedAgentId),
        ...(reportBlock === undefined ? [] : [reportBlock]),
      ],
      busy: headerBusy,
      model: displayModel,
      thinkingEffort: displayEffort,
      contextTokens: displayContextTokens,
      maxContextTokens: displayMaxContextTokens,
      contextBreakdown: undefined,
      usage: displayUsage,
      pendingInteraction: 'none',
      hasMoreHistory: merged.hasMore,
      loadingOlder: loadingOlderAgent,
      fetchedOlder: historyForAgent !== null && historyForAgent.page.oldestTurnId !== undefined,
      olderError: agentOlderError,
    };
    return (
      <MediaPreviewProvider cwd={state.session?.metadata?.cwd}>
        {slots.header !== null
          ? createPortal(
              <>
                <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-hairline bg-panel px-4 py-2">
                  <button
                    type="button"
                    onClick={() => void navigate(`/s/${sessionId}`)}
                    className="rounded-lg border border-hairline px-2 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
                  >
                    {t('sv.backToSession')}
                  </button>
                  <div className="min-w-0 flex-1">
                    <AgentBreadcrumb
                      crumbs={crumbs}
                      onOpenSession={() => void navigate(`/s/${sessionId}`)}
                      onOpenAgent={openAgent}
                    />
                    <h1 className="truncate font-display text-[15px] font-semibold text-ink">
                      {displayName}
                    </h1>
                    <p className="truncate text-[10.5px] text-ink-faint">
                      {t('sv.subagentNote')}
                      {' · '}
                      {t('sv.agentReadOnly')}
                    </p>
                  </div>
                  {displayModel !== undefined ? (
                    <span className="rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
                      {displayModel}
                    </span>
                  ) : null}
                  {displayEffort !== undefined ? (
                    <span
                      data-agent-effort
                      className="rounded-full border border-hairline bg-paper px-2 py-0.5 text-[10.5px] text-ink-soft"
                    >
                      {t('subagent.effort', { effort: displayEffort })}
                    </span>
                  ) : null}
                  {displayContextTokens !== undefined &&
                  displayMaxContextTokens !== undefined &&
                  displayMaxContextTokens > 0 ? (
                    <ContextMeter
                      used={displayContextTokens}
                      limit={displayMaxContextTokens}
                      placement="below"
                    />
                  ) : displayContextTokens !== undefined ? (
                    <span
                      data-agent-context
                      className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10.5px] text-ink-soft"
                    >
                      {t('sv.agentContext', { tokens: time.formatTokens(displayContextTokens) })}
                    </span>
                  ) : null}
                  {cumulativeTokens !== undefined ? (
                    <span
                      data-agent-tokens
                      className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10.5px] text-ink-soft"
                    >
                      {t('sv.agentTokens', { tokens: time.formatTokens(cumulativeTokens) })}
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
                      headerBusy ? 'border-accent/50 text-accent' : 'border-hairline text-ink-soft'
                    }`}
                  >
                    {headerBusy ? t('sv.working') : statusLabel}
                  </span>
                  <PreviewToggleButton />
                  <button
                    type="button"
                    onClick={() => { setRailOpen((value) => !value); }}
                    title={railOpen ? t('sv.hidePanel') : t('sv.showPanel')}
                    aria-label={t('sv.togglePanelAria')}
                    aria-expanded={railOpen}
                    data-agent-rail-toggle
                    className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                      railOpen
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-hairline text-ink-soft hover:border-hairline-strong'
                    }`}
                  >
                    {t('sv.panel')}
                  </button>
                </header>
                <div className="shrink-0 border-b border-hairline px-4 py-2 text-[11px]">
                  <AgentRelations
                    key={selectedAgentId}
                    forest={forest}
                    currentAgentId={selectedAgentId}
                    onOpen={openAgent}
                  />
                </div>
              </>,
              slots.header,
            )
          : null}
        <Transcript
          state={agentState}
          onLoadOlder={handleLoadOlderAgent}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
          forest={forest}
          onOpenAgent={openAgent}
        />
        {slots.dock !== null
          ? createPortal(
              <ResyncStatusBanner
                resyncing={state.resyncing}
                resyncFailed={state.resyncFailed}
                onRetry={controller === null ? undefined : () => { void controller.resync(); }}
              />,
              slots.dock,
            )
          : null}
        {slots.rail !== null && railOpen
          ? createPortal(
              <RightRail
                className={`app-rail ${railOpen ? 'open' : ''}`}
                state={state}
                forest={forest}
                selectedAgentId={selectedAgentId}
                onCancelTask={(taskId) => actions?.cancelTask(taskId)}
                onOpenSubagent={openAgent}
              />,
              slots.rail,
            )
          : null}
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
        <ConfirmDialog
          open={confirmUndo}
          overlayId="confirm-undo"
          title={t('undo.title')}
          body={t('undo.bodySession')}
          confirmLabel={t('undo.confirm')}
          onConfirm={confirmUndoRun}
          onCancel={() => { setConfirmUndo(false); }}
        />
        <ConfirmDialog
          open={batchConfirm !== undefined}
          overlayId="confirm-batch-approvals"
          title={
            batchConfirm?.decision === 'rejected'
              ? t('sv.rejectAllTitle', { count: batchConfirm.ids.length })
              : t('sv.approveAllTitle', { count: batchConfirm?.ids.length ?? 0 })
          }
          body={
            batchConfirm?.decision === 'rejected'
              ? t('sv.rejectAllBody')
              : t('sv.approveAllBody')
          }
          confirmLabel={batchConfirm?.decision === 'rejected' ? t('sv.rejectAll') : t('sv.approveAll')}
          tone={batchConfirm?.decision === 'rejected' ? 'danger' : 'default'}
          onConfirm={confirmBatchRun}
          onCancel={() => { setBatchConfirm(undefined); }}
        />
        <ConfirmDialog
          open={confirmClearQueue}
          overlayId="confirm-clear-queue"
          title={t('sv.queueClearTitle', { count: queuedItems.length })}
          body={t('sv.queueClearBody')}
          confirmLabel={t('sv.queueClearAll')}
          onConfirm={confirmClearQueueRun}
          onCancel={() => { setConfirmClearQueue(false); }}
        />
      </MediaPreviewProvider>
    );
  }

  return (
    <MediaPreviewProvider cwd={state.session?.metadata?.cwd}>
      {slots.header !== null
        ? createPortal(
            <Header
              controller={controller}
              railOpen={railOpen}
              terminalAvailable={terminalAvailable}
              terminalOpen={terminalOpen}
              effectiveModel={effectiveModel}
              modelSource={modelSource}
              onToggleRail={() => { setRailOpen((value) => !value); }}
              onToggleTerminal={toggleTerminalPanel}
              onToggleSidebar={onToggleSidebar}
              onJumpTurn={(blockId) => {
                document
                  .querySelector(`[data-block-id="${blockId}"]`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              onSessionAction={runSessionAction}
              onRequestBatchResolve={handleBatchResolve}
            />,
            slots.header,
          )
        : null}

      {/* The contents wrapper keeps the transcript's flex geometry untouched
          while giving the selection-quote button a containment root. */}
      <div ref={transcriptQuoteRef} className="contents">
        <Transcript
          state={{
            ...state,
            blocks: mainTranscriptBlocks,
          }}
          onLoadOlder={handleLoadOlder}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
          onCancelQueued={handleCancelQueuedChips}
          onRetryLoad={handleRetryLoad}
          forest={forest}
          onOpenAgent={openAgent}
          rowActions={transcriptRowActions}
        />
      </div>
      <SelectionQuoteButton containerRef={transcriptQuoteRef} onQuote={handleQuoteSelection} />
      {slots.dock !== null
        ? createPortal(
            <>
              <ResyncStatusBanner
                resyncing={state.resyncing}
                resyncFailed={state.resyncFailed}
                onRetry={controller === null ? undefined : () => { void controller.resync(); }}
              />
              {queuedItems.length > 0 ? (
                <QueueStrip
                  items={queuedItems}
                  onSendNow={handleSendNowQueued}
                  onRemove={handleCancelQueued}
                  onEdit={handleEditQueued}
                  onClearAll={handleClearQueue}
                  sendNowDisabled={state.resyncing || state.resyncFailed}
                />
              ) : null}
            </>,
            slots.dock,
          )
        : null}
      {slots.footer !== null && terminalOpen && currentTerminalManager !== null
        ? createPortal(
            <TerminalPanel
              manager={currentTerminalManager}
              height={terminalHeight}
              wsStatus={wsStatus}
              onHeightChange={handleTerminalHeightChange}
              onClose={toggleTerminalPanel}
            />,
            slots.footer,
          )
        : null}

      {slots.rail !== null && railOpen
        ? createPortal(
            <RightRail
              className={`app-rail ${railOpen ? 'open' : ''}`}
              state={state}
              forest={forest}
              selectedAgentId={selectedAgentId}
              onCancelTask={(taskId) => actions?.cancelTask(taskId)}
              onOpenSubagent={openAgent}
            />,
            slots.rail,
          )
        : null}

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

      <ConfirmDialog
        open={confirmUndo}
        overlayId="confirm-undo"
        title={t('undo.title')}
        body={t('undo.bodySession')}
        confirmLabel={t('undo.confirm')}
        onConfirm={confirmUndoRun}
        onCancel={() => { setConfirmUndo(false); }}
      />
      <ConfirmDialog
        open={batchConfirm !== undefined}
        overlayId="confirm-batch-approvals"
        title={
          batchConfirm?.decision === 'rejected'
            ? t('sv.rejectAllTitle', { count: batchConfirm.ids.length })
            : t('sv.approveAllTitle', { count: batchConfirm?.ids.length ?? 0 })
        }
        body={
          batchConfirm?.decision === 'rejected'
            ? t('sv.rejectAllBody')
            : t('sv.approveAllBody')
        }
        confirmLabel={batchConfirm?.decision === 'rejected' ? t('sv.rejectAll') : t('sv.approveAll')}
        tone={batchConfirm?.decision === 'rejected' ? 'danger' : 'default'}
        onConfirm={confirmBatchRun}
        onCancel={() => { setBatchConfirm(undefined); }}
      />
      <ConfirmDialog
        open={confirmClearQueue}
        overlayId="confirm-clear-queue"
        title={t('sv.queueClearTitle', { count: queuedItems.length })}
        body={t('sv.queueClearBody')}
        confirmLabel={t('sv.queueClearAll')}
        onConfirm={confirmClearQueueRun}
        onCancel={() => { setConfirmClearQueue(false); }}
      />
    </MediaPreviewProvider>
  );
}
