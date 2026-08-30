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
import { Composer, DEFAULT_AGENT_PROFILE, resolveSelectedEffort } from './Composer';
import { ContextBreakdownProvider, ContextMeter } from './ContextMeter';
import {
  useConversationShell,
  useRegisterSeat,
  type ConversationPhase,
  type ConversationSeat,
} from './ConversationShell';
import type { DraftSkillHandoff } from './NewSessionDraft';
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
import { composerDefaultsForProfile } from '../lib/agentSettings';
import { API_CODES, ApiError, isSessionNotFoundMessage } from '../lib/client';
import { readComposerState, readDraft, writeComposerState, writeDraft } from '../lib/drafts';
import { isMainWindowVisibleAndFocused, showDesktopNotification } from '../lib/desktop';
import {
  addAnnotation,
  buildAnnotationsPrefix,
  buildQuotePrefix,
  removeAnnotation,
  type SelectionAnnotation,
} from '../lib/selectionQuote';
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
import { shortCwd } from '../lib/sessionList';
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
import { agentPath } from '../state/agentTree';
import {
  MAIN_AGENT_ID,
  assistantMessageIdFromBlock,
  createViewState,
  filterBlocksToDirectChildren,
  pendingQuestionCount,
  queuedPromptPreviews,
  sessionAgentForest,
  type ApprovalBlock,
  type AssistantBlock,
  type Block,
  type SessionViewState,
  type SubagentBlock,
  type UserBlock,
} from '../state/transcript';

export async function replaceQueuedPrompt(
  promptId: string,
  text: string,
  replace: (id: string, replacement: string) => Promise<void>,
): Promise<void> {
  await replace(promptId, text);
}

/** VS Code's terminal binding, and the only keyboard path to the panel now
 * that its toggle lives in the header's overflow menu. */
export const TERMINAL_SHORTCUT_LABEL = 'Ctrl+`';

export function isTerminalShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === '`';
}

function MoreIcon({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" className={className}>
      <circle cx="3.2" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.8" cy="8" r="1.35" />
    </svg>
  );
}

function PanelIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M10 3v10" />
    </svg>
  );
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
  onToggleRail,
  onToggleTerminal,
  onToggleSidebar,
  onRenameSession,
  onSessionAction,
  onRequestBatchResolve,
}: {
  controller: SessionController | null;
  railOpen: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleRail: () => void;
  onToggleTerminal: () => void;
  onToggleSidebar: () => void;
  onRenameSession: (title: string) => Promise<void>;
  onSessionAction: (action: 'fork' | 'undo' | 'compact' | 'export') => void;
  onRequestBatchResolve: (decision: 'approved' | 'rejected', ids: readonly string[]) => void;
}) {
  const { t, tp } = useI18n();
  const [renaming, setRenaming] = useState(false);
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
          <SessionTitle
            title={session.title}
            cwd={session.metadata.cwd}
            editing={renaming}
            onEditingChange={setRenaming}
            onRename={onRenameSession}
            onOpenRail={onToggleRail}
          />
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
          <SessionActionsMenu
            terminalAvailable={terminalAvailable}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
            onBeginRename={() => { setRenaming(true); }}
            onAction={onSessionAction}
          />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <PreviewToggleButton />
      <button
        type="button"
        onClick={onToggleRail}
        title={railOpen ? t('sv.hidePanel') : t('sv.showPanel')}
        aria-label={t('sv.togglePanelAria')}
        aria-expanded={railOpen}
        data-rail-toggle
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
          railOpen
            ? 'bg-accent-soft text-accent'
            : 'text-ink-faint hover:bg-paper hover:text-ink'
        }`}
      >
        <PanelIcon className="h-[13px] w-[13px]" />
      </button>
    </header>
  );
}

/**
 * Session title + cwd. The title renames in place (Enter commits, Esc
 * reverts, blur commits) through the same profile patch the sidebar's
 * dialog uses; the cwd beside it is quiet text, not a control — clicking it
 * opens the rail, which is where the rest of that context lives.
 */
export function SessionTitle({
  title,
  cwd,
  editing,
  onEditingChange,
  onRename,
  onOpenRail,
}: {
  title: string;
  cwd: string | undefined;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onRename: (title: string) => Promise<void>;
  onOpenRail: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the blur handler: Esc and a committed Enter both blur the input,
  // and neither should submit a second time.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settledRef.current = false;
    setDraft(title);
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [editing, title]);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    onEditingChange(false);
    if (next === '' || next === title) return;
    void onRename(next);
  };

  const shown = title !== '' ? title : t('sidebar.untitled');
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
      {editing ? (
        <input
          ref={inputRef}
          data-session-rename-input
          aria-label={t('sv.renameAria')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              settledRef.current = true;
              onEditingChange(false);
            }
          }}
          onBlur={commit}
          className="min-w-0 max-w-md flex-1 rounded-md border border-accent bg-paper px-1.5 py-0.5 font-display text-[15px] font-semibold tracking-tight text-ink outline-none"
        />
      ) : (
        <h1 className="min-w-0 max-w-full">
          <button
            type="button"
            data-session-title
            onClick={() => { onEditingChange(true); }}
            title={t('sv.renameAria')}
            aria-label={`${shown} — ${t('sv.renameAria')}`}
            className="block max-w-full truncate rounded-md px-1 py-0.5 text-left font-display text-[15px] font-semibold tracking-tight text-ink transition-colors hover:bg-paper"
          >
            {shown}
          </button>
        </h1>
      )}
      {cwd !== undefined && cwd !== '' && !editing ? (
        <button
          type="button"
          data-session-cwd
          onClick={onOpenRail}
          title={cwd}
          className="hidden shrink-0 truncate font-mono text-[10.5px] text-ink-faint transition-colors hover:text-ink-soft sm:block"
        >
          {shortCwd(cwd)}
        </button>
      ) : null}
    </div>
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

const noopSubscribe = () => () => {};

/**
 * Header overflow menu. Everything that acts on the open session but is not
 * a per-message decision lives here: rename, the terminal panel, and the
 * fork / export / compact / undo quartet.
 */
export function SessionActionsMenu({
  terminalAvailable,
  terminalOpen,
  onToggleTerminal,
  onBeginRename,
  onAction,
}: {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onBeginRename: () => void;
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
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
          open ? 'bg-paper text-ink' : 'text-ink-faint hover:bg-paper hover:text-ink'
        }`}
      >
        <MoreIcon className="h-[13px] w-[13px]" />
      </button>
      {open ? (
        <div className="anim-enter absolute right-0 top-7 z-40 w-56 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)]">
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            data-session-rename
            onClick={() => {
              setOpen(false);
              onBeginRename();
            }}
          >
            {t('menu.rename')}
          </button>
          {terminalAvailable ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={terminalOpen}
              data-terminal-toggle
              className={`${itemClass} flex items-center justify-between gap-3`}
              onClick={() => {
                setOpen(false);
                onToggleTerminal();
              }}
            >
              <span className={terminalOpen ? 'text-accent' : undefined}>{t('term.menuItem')}</span>
              <span className="font-mono text-[10px] text-ink-faint">{TERMINAL_SHORTCUT_LABEL}</span>
            </button>
          ) : null}
          <div className="my-1 h-px bg-hairline" />
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

interface SessionCreateHandoff {
  readonly initialPrompt?: string;
  readonly initialAttachments?: readonly ComposerAttachment[];
  readonly initialSkill?: DraftSkillHandoff;
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly goalObjective?: string;
}

export type SessionCreateSubmission =
  | {
      readonly kind: 'prompt';
      readonly text: string;
      readonly attachments: readonly ComposerAttachment[];
    }
  | {
      readonly kind: 'skill';
      readonly name: string;
      readonly args: string;
      readonly attachments: readonly ComposerAttachment[];
      readonly goalObjective?: string;
    };

function isDraftSkillHandoff(value: unknown): value is DraftSkillHandoff {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; args?: unknown; attachments?: unknown };
  return (
    typeof candidate.name === 'string' &&
    candidate.name !== '' &&
    typeof candidate.args === 'string' &&
    Array.isArray(candidate.attachments)
  );
}

/** Parse the one-shot /new → /s/:id navigation state. */
export function parseSessionCreateHandoff(state: unknown): SessionCreateHandoff {
  if (typeof state !== 'object' || state === null) return {};
  const raw = state as SessionCreateHandoff;
  return {
    initialPrompt: typeof raw.initialPrompt === 'string' ? raw.initialPrompt : undefined,
    initialAttachments: Array.isArray(raw.initialAttachments) ? raw.initialAttachments : undefined,
    initialSkill: isDraftSkillHandoff(raw.initialSkill) ? raw.initialSkill : undefined,
    model: raw.model,
    thinking: raw.thinking,
    permissionMode: raw.permissionMode,
    planMode: raw.planMode,
    swarmMode: raw.swarmMode,
    goalObjective: raw.goalObjective,
  };
}

/** Resolve the one action consumed after the new session snapshot lands. */
export function resolveSessionCreateSubmission(
  handoff: SessionCreateHandoff,
): SessionCreateSubmission | undefined {
  if (handoff.initialSkill !== undefined) {
    return {
      kind: 'skill',
      name: handoff.initialSkill.name,
      args: handoff.initialSkill.args,
      attachments: handoff.initialSkill.attachments,
      goalObjective: handoff.goalObjective,
    };
  }
  if (handoff.initialPrompt === undefined) return undefined;
  return {
    kind: 'prompt',
    text: handoff.initialPrompt,
    attachments: handoff.initialAttachments ?? [],
  };
}

interface ComposerSubmissionSnapshot {
  readonly draft: string;
  readonly attachments: readonly ComposerAttachment[];
}

/** Clear a completed skill submission only if the composer still shows that submission. */
export async function activateSkillWithConditionalClear(input: {
  readonly prepare?: () => Promise<unknown>;
  readonly activate: () => Promise<unknown>;
  readonly submitted: ComposerSubmissionSnapshot;
  readonly current: () => ComposerSubmissionSnapshot;
  readonly clear: () => void;
}): Promise<void> {
  await input.prepare?.();
  await input.activate();
  const current = input.current();
  if (
    current.draft === input.submitted.draft &&
    current.attachments === input.submitted.attachments
  ) {
    input.clear();
  }
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
 * Send-time resolution for a confirmed profile switch. A switch rides the
 * next prompt as `profile`; model/thinking are withheld so the new profile's
 * own pins apply — unless the user explicitly re-picked them after
 * confirming, in which case those explicit choices win.
 */
export function sessionHasStartedConversation(blocks: readonly Block[]): boolean {
  return blocks.some((block) => block.kind === 'user');
}

export function resolveProfileSwitchSubmission(input: {
  pendingProfile: string | undefined;
  boundProfile: string;
  modelTouched: boolean;
  model: string | undefined;
  thinking: string | undefined;
}): { profile?: string; model?: string; thinking?: string } {
  const switching =
    input.pendingProfile !== undefined && input.pendingProfile !== input.boundProfile;
  if (!switching) return { model: input.model, thinking: input.thinking };
  return {
    profile: input.pendingProfile,
    model: input.modelTouched ? input.model : undefined,
    thinking: input.modelTouched ? input.thinking : undefined,
  };
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

export function agentTranscriptPoll(_input: {
  selectedAgentId: string | undefined;
}): { pageSize: number; refetchInterval: false } {
  return { pageSize: 20, refetchInterval: false };
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
  const createHandoff = parseSessionCreateHandoff(location.state);
  const initialPromptRef = useRef(createHandoff.initialPrompt);
  const initialSkillRef = useRef(createHandoff.initialSkill);
  const initialOptionsRef = useRef(createHandoff);
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
  // Mid-session main-profile switch: the pick waits as `pendingProfile` until
  // the next prompt carries it; `profileModelTouched` remembers whether the
  // user re-picked model/effort AFTER confirming (those then ride along,
  // overriding the new profile's pins — see resolveProfileSwitchSubmission).
  const [pendingProfile, setPendingProfile] = useState<string | undefined>(undefined);
  const [profileSwitchConfirm, setProfileSwitchConfirm] = useState<string | undefined>(undefined);
  const [profileModelTouched, setProfileModelTouched] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState<
    { decision: 'approved' | 'rejected'; ids: readonly string[] } | undefined
  >(undefined);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    () =>
      initialOptionsRef.current.initialSkill?.attachments ??
      initialOptionsRef.current.initialAttachments ??
      restoredComposer.attachments ??
      [],
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Transcript text quoted into the composer via the floating selection
  // button. The route keys this component by session id, so the quote resets
  // with the session; send (and the chip's ×) clear it explicitly.
  const [quote, setQuote] = useState<string | null>(null);
  // Selection annotations (quote + one-line comment) accumulate independently
  // of the quote chip — any number of them ride the same prompt.
  const [annotations, setAnnotations] = useState<readonly SelectionAnnotation[]>([]);
  const transcriptQuoteRef = useRef<HTMLDivElement>(null);
  const focusComposer = useCallback(() => {
    // Return focus to the composer so the user can type the follow-up at once.
    document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus();
  }, []);
  const handleQuoteSelection = useCallback((text: string) => {
    setQuote(text);
    focusComposer();
  }, [focusComposer]);
  const handleAnnotateSelection = useCallback((text: string, comment: string) => {
    setAnnotations((current) => addAnnotation(current, text, comment));
    focusComposer();
  }, [focusComposer]);
  const handleRemoveQuote = useCallback(() => { setQuote(null); }, []);
  const handleRemoveAnnotation = useCallback((id: string) => {
    setAnnotations((current) => removeAnnotation(current, id));
  }, []);

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
  // Ctrl+` is the terminal's keyboard path now that its toggle sits in the
  // header menu. It stays out of an editable target only when that target is
  // the PTY itself — the composer must not swallow it, or the binding would
  // be dead exactly where the user is typing.
  useEffect(() => {
    if (!terminalAvailable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalShortcut(event)) return;
      if (isTerminalEscapeTarget(event.target)) return;
      event.preventDefault();
      toggleTerminalPanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [terminalAvailable, toggleTerminalPanel]);

  const handleTerminalHeightChange = useCallback(
    (height: number, final: boolean) => {
      setTerminalHeight(height);
      if (final) writeTerminalPanelPrefs(sessionId, { height });
    },
    [sessionId],
  );

  // Remember this session as the redirect target for `/`.
  useEffect(() => {
    writeLastSessionId(sessionId);
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
    const stored = readDraft(sessionId);
    draftRef.current = stored;
    setDraft(stored);
  }, [sessionId]);
  // Stable identity: the shell-seat memo depends on these (fresh functions per
  // render would re-publish the composer on every keystroke's render).
  const updateDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    writeDraft(sessionId, text);
  }, [sessionId]);
  const updateAttachments = useCallback((
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => {
    const updated = typeof next === 'function' ? next(attachmentsRef.current) : next;
    attachmentsRef.current = updated;
    setAttachments(updated);
  }, []);

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

  useEffect(() => {
    controller?.setFocusedAgent(selectedAgentId);
  }, [controller, selectedAgentId]);

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
  const agentProfilesQuery = useQuery({
    queryKey: ['agentProfiles'],
    queryFn: () => client.listNamedAgentProfiles(),
    staleTime: 60_000,
    retry: false,
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

  // The live main-agent binding, from the snapshot's agent_config echo.
  const boundProfile = state.profile ?? DEFAULT_AGENT_PROFILE;
  const profilePending = pendingProfile !== undefined && pendingProfile !== boundProfile;

  // A model/effort pick made while a profile switch is pending is explicit:
  // it overrides the incoming profile's pins on the switch prompt.
  const handleModelChange = useCallback((model: string | undefined) => {
    setModelOverride(model);
    if (pendingProfile !== undefined) setProfileModelTouched(true);
  }, [pendingProfile]);
  const handleEffortChange = useCallback((effort: string) => {
    setEffortOverride(effort);
    if (pendingProfile !== undefined) setProfileModelTouched(true);
  }, [pendingProfile]);

  const applyPendingProfile = useCallback((name: string) => {
    const defaults = composerDefaultsForProfile(agentProfilesQuery.data?.items ?? [], name);
    setPendingProfile(name);
    setModelOverride(defaults.model);
    setEffortOverride(defaults.thinking);
    setProfileModelTouched(false);
  }, [agentProfilesQuery.data]);
  const handleAgentProfileChange = useCallback(
    (name: string) => {
      if (name === (pendingProfile ?? boundProfile)) return;
      if (name === boundProfile) {
        // Reverting to the live binding needs no confirm — drop the pending pick.
        setPendingProfile(undefined);
        setProfileModelTouched(false);
        return;
      }
      if (state.loaded && !sessionHasStartedConversation(state.blocks)) {
        applyPendingProfile(name);
        return;
      }
      setProfileSwitchConfirm(name);
    },
    [applyPendingProfile, boundProfile, pendingProfile, state.blocks, state.loaded],
  );
  const confirmProfileSwitchRun = useCallback(() => {
    if (profileSwitchConfirm === undefined) return;
    applyPendingProfile(profileSwitchConfirm);
    setProfileSwitchConfirm(undefined);
  }, [applyPendingProfile, profileSwitchConfirm]);

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
        // Selection carry-overs ride the prompt text as plain-text prefixes —
        // annotations first (blockquote + comment per segment), then the plain
        // quote as a Markdown blockquote — exactly what the transcript renders
        // back. The wire protocol stays untouched.
        const prefix = `${buildAnnotationsPrefix(annotations)}${quote !== null ? buildQuotePrefix(quote) : ''}`;
        const quotedText = prefix === '' ? text : `${prefix}${text}`;
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
        const profileSwitch = resolveProfileSwitchSubmission({
          pendingProfile,
          boundProfile,
          modelTouched: profileModelTouched,
          model: effectiveModel,
          thinking: effectiveEffort,
        });
        void controller
          .sendPrompt({
            text: echoText,
            content,
            profile: profileSwitch.profile,
            model: profileSwitch.model,
            // FU7: the select's visible value is the prompt's wire value,
            // including the catalog default when the user leaves it untouched.
            thinking: profileSwitch.thinking,
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
            setAnnotations([]);
            setGoalControl(undefined);
            if (profileSwitch.profile !== undefined) {
              setPendingProfile(undefined);
              setProfileModelTouched(false);
              // No WS frame carries the binding — re-read the record so the
              // pill shows the new profile immediately.
              void controller.refreshSession();
            }
          })
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: error instanceof Error ? error.message : String(error),
            });
            // A rejected rebind (e.g. route-locked) drops the pending pick so
            // the pill falls back to the live binding.
            if (profileSwitch.profile !== undefined) {
              setPendingProfile(undefined);
              setProfileModelTouched(false);
            }
          });
      },
      activateSkill: (
        name: string,
        args: string,
        composerAttachments: readonly ComposerAttachment[],
        goalObjectiveOverride?: string,
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
        const submitted = {
          draft: draftRef.current,
          attachments: composerAttachments,
        };
        void activateSkillWithConditionalClear({
          prepare:
            goalObjectiveOverride !== undefined && goalObjectiveOverride !== ''
              ? () =>
                  client.updateSessionProfile(sessionId, {
                    agent_config: { goal_objective: goalObjectiveOverride },
                  })
              : undefined,
          activate: () =>
            client.activateSkill(sessionId, name, {
              args: activation.args === '' ? undefined : activation.args,
              attachments: activation.attachments,
            }),
          submitted,
          current: () => ({
            draft: draftRef.current,
            attachments: attachmentsRef.current,
          }),
          clear: () => {
            const emptyAttachments: readonly ComposerAttachment[] = [];
            draftRef.current = '';
            attachmentsRef.current = emptyAttachments;
            writeDraft(sessionId, '');
            setDraft('');
            setAttachments(emptyAttachments);
          },
        }).catch((error: unknown) => {
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
          (id, replacement) => controller.replaceQueued(id, replacement),
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
    pendingProfile,
    boundProfile,
    profileModelTouched,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
    goalControl,
    quote,
    annotations,
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

  // Same bare-title patch the sidebar's rename dialog sends: omitting
  // `metadata` leaves the stored custom document (pins included) alone.
  const renameSession = useCallback(
    async (title: string) => {
      try {
        await client.updateSessionProfile(sessionId, { title });
        actionContext.refreshSessions();
      } catch (error: unknown) {
        pushToast({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [client, sessionId, actionContext],
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
    () => controller?.loadOlderMessages(MAIN_AGENT_ID) ?? Promise.resolve(false),
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
   * Wire message id behind an assistant row. Canonical frames carry `messageId`;
   * snapshot-derived block ids still embed it as a fallback.
   */
  const resolveAssistantMessageId = useCallback(
    async (block: AssistantBlock): Promise<string | undefined> => {
      return block.messageId ?? assistantMessageIdFromBlock(block);
    },
    [],
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
    if (selectedAgentId === undefined || controller === null) return false;
    return controller.loadOlderMessages(selectedAgentId);
  }, [controller, selectedAgentId]);
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

  // Submit the prompt or skill that was drafted on /new, now that the live
  // controller is subscribed and will receive the stream.
  useEffect(() => {
    if (
      controller === null ||
      actions === null ||
      !state.loaded ||
      state.resyncing ||
      state.resyncFailed
    ) {
      return;
    }
    const submission = resolveSessionCreateSubmission({
      ...initialOptionsRef.current,
      initialPrompt: initialPromptRef.current,
      initialSkill: initialSkillRef.current,
    });
    if (submission === undefined) return;
    initialSkillRef.current = undefined;
    initialPromptRef.current = undefined;
    initialOptionsRef.current = {};
    // Fire-and-forget: strip the one-shot nav state from history so a refresh
    // doesn't resend the drafted prompt or re-activate the skill.
    void navigate(location.pathname, { replace: true });
    if (submission.kind === 'skill') {
      const recovery = `/${submission.name}${submission.args === '' ? '' : ` ${submission.args}`}`;
      updateDraft(recovery);
      updateAttachments(submission.attachments);
      actions.activateSkill(
        submission.name,
        submission.args,
        submission.attachments,
        submission.goalObjective,
      );
      return;
    }
    // Seed the session draft first: if this send fails, the text stays
    // recoverable in the composer (and in localStorage across reloads).
    updateDraft(submission.text);
    updateAttachments(submission.attachments);
    actions.send(submission.text, submission.attachments);
  }, [
    controller,
    actions,
    state.loaded,
    state.resyncing,
    state.resyncFailed,
    location.pathname,
    navigate,
    updateDraft,
    updateAttachments,
  ]);

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
        ? // initialPromptRef / initialSkillRef are mount-time constants until
          // the auto-send consumes them post-load — safe to read here, and
          // `state.loaded` covers the reactive edge.
          resolveSessionSeatPhase({
            loaded: state.loaded,
            hasInitialPrompt:
              initialPromptRef.current !== undefined || initialSkillRef.current !== undefined,
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
            agentProfile={pendingProfile ?? boundProfile}
            agentProfilePending={profilePending}
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
            onChangeAttachments={updateAttachments}
            quote={quote}
            onRemoveQuote={handleRemoveQuote}
            annotations={annotations}
            onRemoveAnnotation={handleRemoveAnnotation}
            onActivateSkill={handleActivateSkill}
            onSessionAction={runSessionAction}
            onCompactContext={handleCompactContext}
            onChangeModel={handleModelChange}
            onChangeAgentProfile={handleAgentProfileChange}
            onChangePermissionMode={setPermissionOverride}
            onChangePlanMode={setPlanOverride}
            onChangeSwarmMode={setSwarmOverride}
            onChangeGoalObjective={setGoalObjective}
            onChangeGoalControl={setGoalControl}
            onChangeEffort={handleEffortChange}
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
    pendingProfile,
    boundProfile,
    profilePending,
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
    updateAttachments,
    quote,
    annotations,
    handleRemoveQuote,
    handleRemoveAnnotation,
    handleActivateSkill,
    runSessionAction,
    handleCompactContext,
    handleComposerSend,
    handleComposerAbort,
    handleModelChange,
    handleEffortChange,
    handleAgentProfileChange,
    t,
  ]);
  useRegisterSeat(seat);

  // The backdrop exists only while a drawer actually overlays the transcript:
  // below lg the rail becomes a fixed overlay (see .app-rail in index.css).
  // The app-level sidebar renders its own backdrop from App.
  const showBackdrop = railIsOverlay && railOpen;
  const forestRaw = useMemo(
    () => controller?.getForest() ?? sessionAgentForest(state),
    [controller, state],
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
    const capturedBlocks = agentLiveState.blocks;
    const headerBusy = selectedNode?.busy === true || agentLiveState.busy;
    const statusLabel =
      selectedNode !== undefined
        ? t(`subagent.status.${selectedNode.status}` as I18nKey)
        : selectedSubagent !== undefined
          ? t(`subagent.status.${selectedSubagent.status}` as I18nKey)
          : t('sv.historyUnavailable');
    const displayName = selectedNode?.label ?? selectedSubagent?.name ?? selectedAgentId;
    const displayModel = agentLiveState.model ?? selectedNode?.model ?? selectedSubagent?.model;
    const displayEffort =
      agentLiveState.thinkingEffort ?? selectedNode?.thinkingEffort ?? selectedSubagent?.thinkingEffort;
    const displayContextTokens = agentLiveState.contextTokens ?? selectedNode?.contextTokens;
    const displayMaxContextTokens = agentLiveState.maxContextTokens ?? selectedNode?.maxContextTokens;
    const displayUsage = agentLiveState.usage ?? selectedNode?.usage;
    const totalUsage = displayUsage?.total;
    const cumulativeTokens =
      totalUsage === undefined
        ? undefined
        : totalUsage.inputOther +
          totalUsage.inputCacheRead +
          totalUsage.inputCacheCreation +
          totalUsage.output;
    const agentState: SessionViewState = {
      ...agentLiveState,
      session: state.session,
      blocks: filterBlocksToDirectChildren(capturedBlocks, forest, selectedAgentId),
      loaded: agentLiveState.loaded || state.loaded,
      loadError: agentLiveState.loadError ?? state.loadError,
      busy: headerBusy,
      model: displayModel,
      thinkingEffort: displayEffort,
      contextTokens: displayContextTokens,
      maxContextTokens: displayMaxContextTokens,
      contextBreakdown: undefined,
      usage: displayUsage,
      pendingInteraction: 'none',
    };
    return (
      <MediaPreviewProvider sessionId={sessionId} cwd={state.session?.metadata?.cwd}>
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
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      railOpen
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-faint hover:bg-paper hover:text-ink'
                    }`}
                  >
                    <PanelIcon className="h-[13px] w-[13px]" />
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
    <MediaPreviewProvider sessionId={sessionId} cwd={state.session?.metadata?.cwd}>
      {slots.header !== null
        ? createPortal(
            <Header
              controller={controller}
              railOpen={railOpen}
              terminalAvailable={terminalAvailable}
              terminalOpen={terminalOpen}
              onToggleRail={() => { setRailOpen((value) => !value); }}
              onToggleTerminal={toggleTerminalPanel}
              onToggleSidebar={onToggleSidebar}
              onRenameSession={renameSession}
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
      <SelectionQuoteButton
        containerRef={transcriptQuoteRef}
        onQuote={handleQuoteSelection}
        onAnnotate={handleAnnotateSelection}
      />
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
      <ConfirmDialog
        open={profileSwitchConfirm !== undefined}
        overlayId="confirm-profile-switch"
        title={t('profile.switchTitle', { profile: profileSwitchConfirm ?? '' })}
        body={t('profile.switchBody')}
        consequences={[t('profile.switchModelReset'), t('profile.switchSubagents')]}
        confirmLabel={t('profile.switchConfirm')}
        tone="default"
        onConfirm={confirmProfileSwitchRun}
        onCancel={() => { setProfileSwitchConfirm(undefined); }}
      />
    </MediaPreviewProvider>
  );
}
