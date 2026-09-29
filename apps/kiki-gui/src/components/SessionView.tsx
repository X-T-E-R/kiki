/**
 * SessionView — session command and composer owner for /s/:id and child routes.
 *
 * Renders main and child through AgentWorkspace while retaining the resident
 * ConversationShell composer seat across /new → /s/:id.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';

import type { DeferredAppendTiming, MessageContent, PermissionMode, PromptPlanGate, Session } from '@kiki/protocol';

import { AgentWorkspace, HEADER_ICON_BUTTON, PanelIcon, ResyncStatusBanner, WorkspaceHeader, type AgentWorkspaceNavigation } from './agent-workspace';
import { ConfirmDialog } from './ConfirmDialog';
import { Composer, DEFAULT_AGENT_PROFILE, resolveSelectedEffort } from './Composer';
import { ContextBreakdownProvider } from './ContextMeter';
import { useLastResponseAt } from './composerWorking';
import { useContextMeterAutoCompact } from './useContextMeterAutoCompact';
import {
  useConversationShell,
  useRegisterSeat,
  type ConversationPhase,
  type ConversationSeat,
} from './ConversationShell';
import { ComposerHeader, type ComposerHeaderSection } from './ComposerHeader';
import { GoalCard, GoalHeaderSummary, goalShowsInHeader, RecoveryHoldBar } from './GoalCard';
import type { DraftSkillHandoff } from './NewSessionDraft';
import { QueueHeaderSummary, QueueStrip } from './QueueStrip';
import { RightRail } from './rail-variants/RailSwitch';
import { useInspectorFocusTracking } from './inspectorFocus';
import { SelectionQuoteButton } from './SelectionQuoteButton';
import { TerminalPanel } from './TerminalPanel';
import { useStableForest, type TranscriptRowActions } from './Transcript';
import { Icon } from './icons';
import { WorktreeMark } from './WorktreeMark';
import { MediaPreviewProvider, PreviewToggleButton, useMediaPreview } from './mediaPreview';
import type { MediaPreviewApi } from './mediaPreviewContext';
import {
  SESSION_REWRITTEN_EVENT,
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '@kiki/session-core/commands';
import {
  addAnnotation,
  buildAnnotationsPrefix,
  buildPromptContent,
  buildQuotePrefix,
  buildSkillActivation,
  flushDrafts,
  readComposerState,
  readDraft,
  removeAnnotation,
  subscribeDraftAppends,
  writeComposerState,
  writeDraft,
  type ComposerAttachment,
  type SelectionAnnotation,
} from '@kiki/session-core/composer';
import {
  assertSessionWritable,
  MAIN_AGENT_ID,
  SessionController,
  assistantMessageIdFromBlock,
  createViewState,
  filterBlocksToDirectChildren,
  pendingQuestionCount,
  queuedPromptPreviews,
  sessionAgentForest,
  type ApprovalBlock,
  type QuestionBlock,
  type AssistantBlock,
  type Block,
  type SubagentBlock,
  type UserBlock,
} from '@kiki/session-core/session';
import { shortCwd } from '@kiki/session-core/sessions';
import {
  composerDefaultsForProfile,
  readDesktopPrefs,
  readLastSessionId,
  readSettings,
  readTerminalPanelPrefs,
  markSessionSeen,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeLastSessionId,
  writeTerminalPanelPrefs,
  type ComposerModelSource,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import {
  agentProfileCatalogQueryKey,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../lib/agentProfileCatalog';
import { API_CODES, ApiError, isSessionNotFoundMessage, type UpdateAgentGoalInput } from '../lib/client';
import { locateInTimeline, normalizeTurnId } from '../lib/timelineLocate';
import { AnnotationTray } from './AnnotationTray';
import { InteractionPlacementContext, type InteractionPlacement } from './Interactions';
import { NeedsYouTray, type NeedsYouTrayHandle } from './NeedsYouTray';
import { pushToast } from '../lib/toasts';
import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';
import { useConnection, useControllerRegistry } from '../state/connection';
import {
  activeTerminalManager,
  terminalCapabilityAvailable,
  TerminalManager,
} from '../state/terminalManager';

/** Renew cadence for a queue-edit hold (the server lets it lapse after 5 minutes). */
export const QUEUE_EDIT_HOLD_RENEW_MS = 60_000;

export async function replaceQueuedPrompt(
  promptId: string,
  text: string,
  replace: (id: string, replacement: string) => Promise<void>,
): Promise<void> {
  await replace(promptId, text);
}

export function withoutQueuedAttachment(content: readonly MessageContent[], attachmentIndex: number): MessageContent[] {
  let index = 0;
  return content.filter((part) => {
    if (part.type !== 'image' && part.type !== 'video' && part.type !== 'file') return part.type !== 'text';
    return index++ !== attachmentIndex;
  });
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

function useActiveController(
  sessionId: string | undefined,
  focusedAgentId?: string,
): SessionController | null {
  const { client } = useConnection();
  const registry = useControllerRegistry();
  const [controller, setController] = useState<SessionController | null>(null);

  useEffect(() => {
    if (sessionId === undefined) {
      setController(null);
      return;
    }
    const next = new SessionController(client.sessions, client.sessionView(sessionId), sessionId);
    next.setFocusedAgent(focusedAgentId);
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
  }, [client, sessionId, registry]);

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
}) {
  const { t, tp } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );
  const session = state.session;
  const approvals = useMemo(
    () => state.blocks.filter((block) => block.kind === 'approval' && block.resolution === undefined).length,
    [state.blocks],
  );
  const questions = pendingQuestionCount(state);
  const waiting = approvals + questions;
  const runningTasks = state.tasks.filter((task) => task.status === 'running').length;

  return (
    <WorkspaceHeader main>
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('sv.openMenuAria')}
        className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden"
      >
        <Icon name="menu" size={16} />
      </button>
      {session !== undefined ? (
        <>
          <SessionTitle
            title={session.title}
            cwd={session.metadata.cwd}
            worktree={session.worktree}
            editing={renaming}
            onEditingChange={setRenaming}
            onRename={onRenameSession}
            onOpenRail={onToggleRail}
          />
          {/* What is waiting on you — the count and the batch decisions —
              lives in the tray above the composer, which lists the items
              themselves. The header keeps one quiet state word and ONE
              overflow menu. */}
          {state.busy ? (
            <span data-header-working className="hidden shrink-0 items-center gap-1.5 text-[12px] text-ink-soft sm:flex">
              <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
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
        data-rail-hint={waiting > 0 ? 'needs-you' : state.busy || runningTasks > 0 ? 'running' : undefined}
        className={`relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent lg:h-8 lg:min-w-8 ${
          railOpen
            ? 'bg-canvas text-ink'
            : 'text-ink-faint hover:bg-canvas hover:text-ink'
        }`}
      >
        <PanelIcon />
        {/* The closed inspector stays discoverable: what is waiting on you
            (accent), else a quiet running mark with the task count. */}
        {waiting > 0 ? (
          // A bare count, no fill: the tray already carries the loud mark.
          <span data-rail-toggle-badge className="text-[12px] leading-[18px] font-medium text-accent-ink tabular-nums" aria-label={tp('inspector.waiting', waiting)} title={tp('inspector.waiting', waiting)}>
            {waiting}
          </span>
        ) : state.busy || runningTasks > 0 ? (
          <span data-rail-toggle-running className="flex items-center gap-1 text-[12px] text-ink-soft" title={runningTasks > 0 ? tp('inspector.tasks', runningTasks) : t('inspector.running')}>
            <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
            {runningTasks > 0 ? <span className="tabular-nums">{runningTasks}</span> : null}
          </span>
        ) : null}
      </button>
    </WorkspaceHeader>
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
  worktree,
  editing,
  onEditingChange,
  onRename,
  onOpenRail,
}: {
  title: string;
  cwd: string | undefined;
  /** Present only for a session running in a Kiki-managed worktree. */
  worktree?: Session['worktree'];
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
  // Title keeps its width; the cwd beside it yields first (shrink-[100]) so a
  // roomy header never truncates the name to make space for the path.
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
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
          className="min-w-0 max-w-md flex-1 rounded-md border border-hairline-strong bg-panel px-1.5 py-0.5 font-display text-[16px] font-semibold tracking-tight text-ink outline-none focus:border-accent"
        />
      ) : (
        <h1 className="-ml-1.5 min-w-0 max-w-full">
          <button
            type="button"
            data-session-title
            onClick={() => { onEditingChange(true); }}
            title={t('sv.renameAria')}
            aria-label={`${shown} — ${t('sv.renameAria')}`}
            className="block max-w-full truncate rounded-md px-1.5 py-0.5 text-left font-display text-[16px] leading-tight font-semibold tracking-tight text-ink transition-colors hover:bg-canvas"
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
          className="hidden min-w-0 shrink-[100] truncate text-[12px] text-ink-faint transition-colors hover:text-ink-soft sm:block"
        >
          {/* A worktree checkout path is Kiki's own; the project reads by its source. */}
          {shortCwd(worktree?.source_root ?? cwd)}
        </button>
      ) : null}
      {!editing ? <WorktreeMark worktree={worktree} className="max-w-[8rem] shrink-[50] self-center sm:max-w-[12rem]" /> : null}
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
    'flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-ink transition-colors hover:bg-paper';
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
        className={HEADER_ICON_BUTTON}
      >
        <MoreIcon className="h-[15px] w-[15px]" />
      </button>
      {open ? (
        <div role="menu" className="anim-enter absolute right-0 top-full z-40 mt-1 w-56 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
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
              <span className={terminalOpen ? 'font-medium' : undefined}>{t('term.menuItem')}</span>
              <span className="text-[12px] text-ink-faint">{TERMINAL_SHORTCUT_LABEL}</span>
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
 * Permission/plan pills are controlled by the server-reported store
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
  readonly goalObjective?: string;
}

export type SessionCreateSubmission =
  | {
      readonly kind: 'prompt';
      readonly text: string;
      readonly attachments: readonly ComposerAttachment[];
      readonly goalObjective?: string;
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
    goalObjective: handoff.goalObjective,
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
 * Effective plan gate for the next prompt: the session pick wins, then the
 * global `[plan] gate` default, then the engine's built-in 'free'. Unlike the
 * mode pills there is no store leg — the agent never echoes its gate back.
 */
export function resolvePlanGate(
  override: PromptPlanGate | undefined,
  configGate: PromptPlanGate | undefined,
): PromptPlanGate {
  return override ?? configGate ?? 'free';
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

export function sessionAgentProfileWorkspaceId(session: Session | undefined): string | undefined {
  return session?.workspace_id;
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

export function withOptimisticUserBlock(
  blocks: readonly Block[],
  pending: { id: string; text: string; createdAt: string; slow: boolean } | undefined,
): readonly Block[] {
  if (pending === undefined) return blocks;
  return [...blocks, {
    kind: 'user', id: `optimistic-${pending.id}`, text: pending.text,
    createdAt: pending.createdAt, optimisticStatus: pending.slow ? 'slow' : 'sending',
  } satisfies UserBlock];
}

/** Put a failed prompt's notes back in front of any the user added since. */
export function restoreSentAnnotations(
  current: readonly SelectionAnnotation[],
  sent: readonly SelectionAnnotation[],
): readonly SelectionAnnotation[] {
  const present = new Set(current.map((annotation) => annotation.id));
  const missing = sent.filter((annotation) => !present.has(annotation.id));
  return missing.length === 0 ? current : [...missing, ...current];
}

export function recoverFailedSubmission(
  currentText: string,
  currentAttachments: readonly ComposerAttachment[],
  sentText: string,
  sentAttachments: readonly ComposerAttachment[],
): { text: string; attachments: readonly ComposerAttachment[] } | undefined {
  if (currentText !== '' || currentAttachments.length !== 0) return undefined;
  return { text: sentText, attachments: sentAttachments };
}

/**
 * A failed send clears the pending profile pick only when the SERVER answered
 * with a business rejection (e.g. route-locked) — the pick was definitively
 * refused. Network failures (-1) and timeouts (API_CODES.TIMEOUT) prove
 * nothing about the pick: keep the selection (and the draft) so the user can
 * retry deliberately; nothing is resent automatically.
 */
export function shouldClearPendingProfileOnSendError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.code !== -1 && error.code !== API_CODES.TIMEOUT
  );
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

/** Route and visible tab timelines may coexist; a global y/n press belongs to
 * one workspace, never to the first matching card elsewhere in the document. */
export function approvalShortcutRoot(
  root: ParentNode,
  target: EventTarget | null,
  routedAgentId?: string,
  previewCoversMain = false,
): ParentNode | null {
  const element = target instanceof Element ? target : null;
  const focusedPreview = element?.closest<HTMLElement>('[data-preview-workspace]');
  const preview = focusedPreview ?? (previewCoversMain
    ? root.querySelector<HTMLElement>('[data-preview-workspace]:not([hidden])') : null);
  if (preview !== null && preview !== undefined && !preview.hidden) {
    return preview.querySelector('[data-preview-tabpanel]:not([hidden]) [data-agent-workspace-target]');
  }
  return Array.from(root.querySelectorAll<HTMLElement>('[data-agent-workspace-target]')).find(
    (workspace) => workspace.dataset['agentWorkspaceTarget'] === (routedAgentId ?? MAIN_AGENT_ID),
  ) ?? null;
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

export function shouldHandleGlobalAbortOnEscape(input: {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  terminalFocused: boolean;
  terminalOpen: boolean;
  inFormField: boolean;
  fullscreenPreviewOpen?: boolean;
}): boolean {
  if (input.key !== 'Escape') return false;
  return !input.defaultPrevented && !input.overlayOpen && !input.terminalFocused &&
    !input.terminalOpen && !input.inFormField && !input.fullscreenPreviewOpen;
}

export function canAbortActiveTurn(
  state: Pick<ReturnType<SessionController['getState']>, 'busy' | 'abortablePromptId' | 'abortableTurnId'>,
): boolean {
  return state.busy && (state.abortablePromptId !== undefined || state.abortableTurnId !== undefined);
}

export function promptGoalObjective(
  options?: { readonly goalObjective?: string },
): string | undefined {
  return options?.goalObjective;
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

/**
 * Focus bridge — one `useMediaPreview()` consumer rendered inside
 * MediaPreviewProvider, reporting the active agent panel tab up to this view.
 * The provider owns tab state, and the shared right rail renders above it,
 * so the focus travels through a callback instead of context re-entry.
 */
/** Focus an agent's preview tab once it has rendered (a few frames at most). */
function focusAgentTabWhenMounted(agentId: string, framesLeft = 10): void {
  requestAnimationFrame(() => {
    const key = `panel:${agentId}`;
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-preview-tab-key]')]
      .find((element) => element.dataset['previewTabKey'] === key) ?? null;
    if (tab !== null && tab.getAttribute('aria-selected') === 'true') {
      tab.focus({ preventScroll: true });
      return;
    }
    if (framesLeft > 0) focusAgentTabWhenMounted(agentId, framesLeft - 1);
  });
}

export function PreviewFocusBridge({ onFocusedAgent }: { onFocusedAgent: (agentId: string | undefined) => void }) {
  const preview = useMediaPreview();
  const focused = preview?.activeAgentPanelId;
  useEffect(() => {
    onFocusedAgent(focused);
  }, [focused, onFocusedAgent]);
  return null;
}

export function SessionView({
  onToggleSidebar,
  sessions,
}: {
  onToggleSidebar: () => void;
  /** Polled session records owned by App (page-1 polling there). */
  sessions: readonly Session[];
}) {
  const host = useHost();
  const { id } = useParams<{ id: string }>();
  const sessionId = id!;
  const { client, socket, meta, wsStatus } = useConnection();
  const { slots } = useConversationShell();
  const terminalAvailable = terminalCapabilityAvailable(meta.capabilities);
  const { t, tp, locale } = useI18n();
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
  // Deep-link locators: /s/{id}?turn=N (search hits, the /usage drilldown)
  // and ?block={blockId} go through the timeline's one locate entry, which
  // pages older history in, opens folds, and says so when the place is gone.
  const locatorParams = new URLSearchParams(location.search);
  const turnLocator = locatorParams.get('turn');
  const blockLocator = locatorParams.get('block');
  useEffect(() => {
    if (turnLocator === null && blockLocator === null) return;
    const target = blockLocator !== null
      ? { kind: 'block' as const, blockId: blockLocator }
      : { kind: 'turn' as const, turnId: normalizeTurnId(turnLocator!) };
    void locateInTimeline(target, { sessionId, agentId: selectedAgentIdRef.current });
  }, [turnLocator, blockLocator, sessionId]);
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
  // The inspector starts open on wide windows (Settings › General can turn
  // that off). Below lg it is a fixed overlay drawer, so it always starts
  // closed there and opens from the header toggle.
  const railIsOverlay = useMediaQuery('(max-width: 1023px)');
  const [railOpen, setRailOpen] = useState(() => defaults.railOpenByDefault && !railIsOverlay);
  // A desktop rail becomes a fixed drawer on resize. Do not let that drawer
  // cover a full-width preview tab that was already open; a deliberate rail
  // toggle while narrow still works because this runs only at the breakpoint.
  useEffect(() => { if (railIsOverlay) setRailOpen(false); }, [railIsOverlay]);
  // Focused panel-tab agent: the active agent panel tab in the preview
  // workspace, reported up by the bridge below. This is the shared right
  // rail's owner when the user is looking at an embedded subagent view — the
  // routed agent page (selectedAgentId) owns the rail through AgentWorkspace.
  const [panelFocusAgent, setPanelFocusAgent] = useState<string | undefined>(undefined);
  // Permission/plan are store-controlled (see resolveControlledValue):
  // local state is only the optimistic echo of an uncommitted pill click.
  const [permissionOverride, setPermissionOverride] = useState<PermissionMode | undefined>(
    restoredComposer.permissionMode ?? initialOptionsRef.current.permissionMode,
  );
  const [planOverride, setPlanOverride] = useState(
    restoredComposer.planMode ?? initialOptionsRef.current.planMode,
  );
  // Plan gate: session-scoped pick restored from composer chrome. Unlike the
  // mode pills there is no server echo to reconcile against (the wire only
  // takes `plan_gate` per prompt), so the override simply persists.
  const [planGateOverride, setPlanGateOverride] = useState<PromptPlanGate | undefined>(
    restoredComposer.planGate,
  );
  // Goal mode (composer toggle): the next plain message becomes the goal. A
  // successful goal send disarms it; run-state control lives on the GoalCard.
  const [goalMode, setGoalMode] = useState(false);
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
  // Queue edit round-trip: the queued text being edited lives in the composer;
  // `savedDraft` is what the composer held before the edit parked itself there.
  const [queueEdit, setQueueEdit] = useState<{
    readonly promptId: string;
    readonly savedDraft: string;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingSubmission, setPendingSubmission] = useState<{
    id: string; text: string; createdAt: string; slow: boolean;
  } | undefined>();
  const pendingSendRef = useRef(false);
  useEffect(() => {
    if (pendingSubmission === undefined || pendingSubmission.slow) return;
    const timer = setTimeout(() => {
      setPendingSubmission((current) => current?.id === pendingSubmission.id
        ? { ...current, slow: true } : current);
    }, 10_000);
    return () => { clearTimeout(timer); };
  }, [pendingSubmission]);
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
  // of the quote chip — any number ride the same prompt, and unsent ones return
  // with the session's in-memory composer chrome after navigation.
  const [annotations, setAnnotations] = useState<readonly SelectionAnnotation[]>(
    () => restoredComposer.annotations ?? [],
  );
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
  const handleUpdateAnnotation = useCallback((id: string, comment: string) => {
    setAnnotations((current) => current.map((annotation) => (annotation.id === id ? { ...annotation, comment } : annotation)));
  }, []);

  const controller = useActiveController(sessionId, selectedAgentId);
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
    return () => { flushDrafts(); };
  }, [sessionId]);
  // Stable identity: the shell-seat memo depends on these (fresh functions per
  // render would re-publish the composer on every keystroke's render).
  const updateDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    writeDraft(sessionId, text);
  }, [sessionId]);
  // External draft appends (「加入对话」 from the preview workspace): the
  // draft store owns the text; this mirrors it into the mounted composer and
  // returns focus so the follow-up can be typed at once.
  useEffect(
    () =>
      subscribeDraftAppends((target) => {
        if (target !== sessionId) return;
        const next = readDraft(sessionId);
        draftRef.current = next;
        setDraft(next);
        focusComposer();
      }),
    [sessionId, focusComposer],
  );
  const updateAttachments = useCallback((
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => {
    const updated = typeof next === 'function' ? next(attachmentsRef.current) : next;
    attachmentsRef.current = updated;
    setAttachments(updated);
  }, []);

  // Capture in-memory chrome for session switches. The storage owner mirrors
  // only model/effort overrides to disk, never attachments, unsent annotations
  // or run controls.
  useEffect(() => {
    writeComposerState(sessionId, {
      attachments,
      annotations,
      permissionMode: permissionOverride,
      planMode: planOverride,
      planGate: planGateOverride,
      goalObjective: '',
      modelOverride,
      effortOverride,
    });
  }, [
    sessionId,
    attachments,
    annotations,
    permissionOverride,
    planOverride,
    planGateOverride,
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

  // Read state: while a session is on screen, keep its seen-mark at the newest
  // event the user has therefore looked at. This clears the session from the
  // activity inbox and from the sidebar's unread state, and re-arms both the
  // moment a later turn pushes `last_seq` past the mark.
  const seenSeq = state.session?.last_seq;
  useEffect(() => {
    if (seenSeq === undefined) return;
    markSessionSeen(sessionId, seenSeq);
  }, [sessionId, seenSeq]);

  // Store-controlled pills: the server-reported value wins unless a local
  // click is still waiting to be committed with the next prompt.
  const permissionMode = resolveControlledValue(
    permissionOverride,
    state.permissionMode,
    defaults.defaultPermissionMode,
  );
  const planMode = resolveControlledFlag(planOverride, state.planMode, state.loaded, defaults.defaultPlanMode);
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

  // Effective plan gate for the next prompt: the session pick wins, then the
  // global `[plan] gate` default, then the engine's built-in 'free'. The agent
  // never echoes its gate, so nothing clears the override once set.
  const planGate = resolvePlanGate(planGateOverride, configQuery.data?.plan?.gate);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  // Subagent tasks register under the dispatching (parent) agent's task
  // service, so bulk/detail actions retain that owner scope.
  const stopAgentTask = useCallback(
    (ownerAgentId: string, taskId: string) =>
      client.stopAgentTask(sessionId, ownerAgentId, taskId),
    [client, sessionId],
  );
  const profileWorkspaceId = sessionAgentProfileWorkspaceId(state.session);
  const profileCwd = state.session?.metadata.cwd;
  const agentProfileCatalogMode = useMemo<AgentProfileCatalogMode>(
    () => profileCwd !== undefined && profileCwd !== ''
      ? { mode: 'cwd', cwd: profileCwd, effective: true }
      : profileWorkspaceId === undefined
        ? { mode: 'disabled' }
        : { mode: 'workspace', workspaceId: profileWorkspaceId, effective: true },
    [profileCwd, profileWorkspaceId],
  );
  const agentProfilesQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(agentProfileCatalogMode),
    queryFn: () => loadAgentProfileCatalog(client, agentProfileCatalogMode),
    enabled: agentProfileCatalogMode.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
  });

  const sessionModel = state.model;
  const inheritedDefault = serverDefaultModel ?? liveSettings.defaultModel;
  const effectiveModel = resolveEffectiveModel(modelOverride, sessionModel, inheritedDefault);
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.id === effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  // Keep the local choice through delayed bindings and catalog changes. The
  // Composer diagnoses incompatibility without destroying the saved value.
  const effectiveEffort = effortOverride ?? resolveSelectedEffort(
    supportedEfforts,
    effectiveModel === sessionModel ? state.thinkingEffort : undefined,
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
  const handleEffortChange = useCallback((effort: string | undefined) => {
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
  const refetchAgentProfiles = agentProfilesQuery.refetch;
  const handleContextRebuild = useCallback(async () => {
    const result = await client.rebuildContext(sessionId);
    void refetchAgentProfiles();
    return result;
  }, [client, refetchAgentProfiles, sessionId]);

  // Global y / n shortcut for the focused-or-unambiguous visible approval.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (controller === null) return;
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape') {
        // A child route or a focused preview tab owns its own keyboard surface.
        // Escape there must never abort the main agent behind the panel.
        if (selectedAgentId !== undefined ||
          (target?.closest('[data-preview-workspace]') as HTMLElement | null)?.hidden === false ||
          (railIsOverlay && document.querySelector('[data-preview-workspace]:not([hidden])') !== null)) return;
        const inFormField =
          target !== null &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable ||
            (target.tagName === 'TEXTAREA' && !Object.hasOwn(target.dataset, 'composer')));
        if (!shouldHandleGlobalAbortOnEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          overlayOpen: anyOverlayOpen(),
          terminalFocused: isTerminalEscapeTarget(event.target),
          terminalOpen,
          inFormField,
          // Focus falls back to body when Hide panel unmounts its button. The
          // visible fullscreen preview still owns Escape at desktop widths.
          fullscreenPreviewOpen: document.querySelector('[data-preview-workspace][data-preview-fullscreen]:not([hidden])') !== null,
        })) return;
        const current = controller.getState();
        if (canAbortActiveTurn(current)) {
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
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
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
      const shortcutRoot = approvalShortcutRoot(document, event.target, selectedAgentId, railIsOverlay);
      if (shortcutRoot === null) return;
      const cards = collectApprovalShortcutCards(shortcutRoot);
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
  }, [controller, t, terminalOpen, selectedAgentId, railIsOverlay]);

  const actions = useMemo(() => {
    if (controller === null) return null;
    return {
      send: (text: string, composerAttachments: readonly ComposerAttachment[], options?: { readonly goalObjective?: string; readonly now?: boolean }) => {
        // Selection carry-overs ride the prompt text as plain-text prefixes —
        // annotations first (blockquote + comment per segment), then the plain
        // quote as a Markdown blockquote — exactly what the transcript renders
        // back. The wire protocol stays untouched.
        const prefix = `${buildAnnotationsPrefix(annotations)}${quote !== null ? buildQuotePrefix(quote) : ''}`;
        const quotedText = prefix === '' ? text : `${prefix}${text}`;
        const content = buildPromptContent(quotedText, composerAttachments);
        if (content === null || pendingSendRef.current) return;
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
        pendingSendRef.current = true;
        const submissionId = crypto.randomUUID();
        setPendingSubmission({ id: submissionId, text: echoText, createdAt: new Date().toISOString(), slow: false });
        updateDraft('');
        updateAttachments([]);
        // The notes riding this prompt leave the composer with its text; a
        // failed submit hands them back (next to any added meanwhile).
        const sentAnnotations = annotations;
        const sentIds = new Set(sentAnnotations.map((annotation) => annotation.id));
        setAnnotations((current) => current.filter((annotation) => !sentIds.has(annotation.id)));
        // Returned to the composer: it holds its send latch until this round
        // settles, which is what blocks a rapid duplicate send (and releases
        // for a retry when the submit fails).
        return controller
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
            planGate,
            goalObjective: promptGoalObjective(options),
            appendTiming: liveSettings.defaultAppendTiming,
          })
          .then((result) => {
            setQuote(null);
            setGoalMode(false);
            // "Send now" (⌘/Ctrl+Enter while busy): the prompt parked behind the
            // running turn joins it right away through the queue's steer route.
            if (options?.now === true && result.status === 'queued') {
              void controller.steerQueued(result.prompt_id).catch((error: unknown) => {
                pushToast({
                  tone: 'error',
                  text: t('sv.steerQueuedFailed', {
                    detail: error instanceof Error ? error.message : String(error),
                  }),
                });
              });
            }
            if (profileSwitch.profile !== undefined) {
              setPendingProfile(undefined);
              setProfileModelTouched(false);
              // No WS frame carries the binding — re-read the record so the
              // pill shows the new profile immediately.
              void controller.refreshSession();
            }
          })
          .catch((error: unknown) => {
            setAnnotations((current) => restoreSentAnnotations(current, sentAnnotations));
            const recovery = recoverFailedSubmission(draftRef.current, attachmentsRef.current, text, composerAttachments);
            if (recovery !== undefined) {
              updateDraft(recovery.text);
              updateAttachments(recovery.attachments);
            }
            const isApi = error instanceof ApiError;
            pushToast({
              tone: 'error',
              text: error instanceof Error ? error.message : String(error),
              code: isApi ? error.code : undefined,
              requestId: isApi ? error.requestId : undefined,
              detail: error instanceof Error ? error.stack : undefined,
              retry: {
                run: () => {
                  void actions?.send(text, composerAttachments, options);
                },
              },
            });
            // Only a definitive server-side business rejection (e.g.
            // route-locked) drops the pending pick; a network failure or
            // timeout keeps the selection and the draft for a manual retry.
            if (
              profileSwitch.profile !== undefined &&
              shouldClearPendingProfileOnSendError(error)
            ) {
              setPendingProfile(undefined);
              setProfileModelTouched(false);
            }
          })
          .finally(() => {
            pendingSendRef.current = false;
            setPendingSubmission((current) => current?.id === submissionId ? undefined : current);
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
        // Returned for the composer's send latch, same contract as `send`.
        return activateSkillWithConditionalClear({
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
          const isApi = error instanceof ApiError;
          const text =
            error instanceof ApiError && error.code === API_CODES.SKILL_NOT_FOUND
              ? t('sv.skillGone', { name })
              : error instanceof ApiError && error.code === API_CODES.SKILL_NOT_ACTIVATABLE
                ? t('sv.skillReference', { name })
                : error instanceof Error
                  ? error.message
                  : String(error);
          pushToast({
            tone: 'error',
            text,
            code: isApi ? error.code : undefined,
            requestId: isApi ? error.requestId : undefined,
            detail: error instanceof Error ? error.stack : undefined,
            retry: {
              run: () => {
                void actions?.activateSkill(name, args, composerAttachments, goalObjectiveOverride);
              },
            },
          });
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
        selectedOptionId?: string,
      ) => controller.resolveApproval(approvalId, decision, scope, selectedOptionId),
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
    planGate,
    liveSettings.defaultAppendTiming,
    quote,
    annotations,
    sessionId,
    t,
    updateDraft,
    updateAttachments,
  ]);

  const handleCancelTask = useCallback(
    (taskId: string, ownerAgentId?: string) => {
      if (ownerAgentId === undefined) {
        actions?.cancelTask(taskId);
        return;
      }
      void client
        .cancelTask(sessionId, taskId, { agent_id: ownerAgentId })
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.stopTaskFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
    },
    [actions, client, sessionId, t],
  );

  const actionContext: SessionActionContext = useMemo(
    () => ({
      client,
      host,
      refreshSessions: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
      navigate,
    }),
    [client, host, queryClient, navigate],
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
      // Resume after a user stop re-runs the stopped reply (same path as regenerate).
      onResumeStopped: handleRegenerate,
    }),
    [state.busy, state.resyncing, state.resyncFailed, handleEditMessage, handleRegenerate, handleForkMessage],
  );

  const forestRaw = useMemo(
    () => controller?.getForest() ?? sessionAgentForest(state),
    [controller, state],
  );
  // Content-stabilized forest: rebuilt per publish above, but identical in
  // content across streaming deltas — keep the previous object so downstream
  // derivations (mainTranscriptBlocks) and Transcript's row/page memos are
  // not broken by unrelated state publishes.
  const forest = useStableForest(forestRaw);

  const previewRef = useRef<MediaPreviewApi | null>(null);
  // Read at open time; kept off openAgent's deps so its identity (a memo
  // input across the transcript) does not change when the rail toggles.
  const overlayRailOpenRef = useRef(false);
  overlayRailOpenRef.current = railIsOverlay && railOpen;

  const openAgent = useCallback(
    (agentId: string) => {
      if (agentId === MAIN_AGENT_ID) {
        void navigate(`/s/${sessionId}`);
        return;
      }
      const mode = liveSettings.subagentPanelOpenMode;
      // A narrow viewport uses the same preview tab as desktop. Its shell
      // becomes a full-width overlay; only the explicit fullscreen preference
      // or action navigates to the agent route.
      if (mode === 'fullscreen' || previewRef.current === null) {
        void navigate(agentDetailPath(sessionId, agentId));
        return;
      }
      const node = forest.byId[agentId];
      const title = node?.label ?? agentId;
      previewRef.current.openAgentPanel(agentId, title);
      // On narrow viewports the rail is an overlay over the preview: an agent
      // opened from it (a row, a Needs-you origin, a relation) would get its
      // tab underneath. The overlay steps aside and the new tab takes focus.
      // The docked rail stays open.
      if (overlayRailOpenRef.current) {
        setRailOpen(false);
        focusAgentTabWhenMounted(agentId);
      }
    },
    [forest, liveSettings.subagentPanelOpenMode, navigate, sessionId],
  );
  // Route-shell seams for the agent workspace: back-to-session and the
  // route-level agent open (no preview interception — the spawn jump-back).
  const openSession = useCallback(() => {
    void navigate(`/s/${sessionId}`);
  }, [navigate, sessionId]);
  const openAgentRoute = useCallback(
    (agentId: string) => {
      const path = agentDetailPath(sessionId, agentId);
      if (location.pathname !== path) void navigate(path);
    },
    [location.pathname, navigate, sessionId],
  );
  const toggleRail = useCallback(() => { setRailOpen((value) => !value); }, []);
  const closeRail = useCallback(() => { setRailOpen(false); }, []);
  const agentWorkspaceNavigation = useMemo<AgentWorkspaceNavigation>(
    () => ({ openAgent, openAgentRoute, openSession, sharedRail: { open: railOpen, toggle: toggleRail } }),
    [openAgent, openAgentRoute, openSession, railOpen, toggleRail],
  );

  // ---- shared-rail focus (panel-tab subagent) ----
  // The routed agent page owns the rail through AgentWorkspace; when the user
  // is instead looking at an embedded agent panel tab, the main view's shared
  // rail retargets at that agent: same rail, this subagent's task/nav chapters
  // and identity badge. Data comes from the same channel AgentWorkspace reads
  // — the parent transcript's spawning card, plus the agent's own live view
  // for the pending-interaction count.
  const panelFocusBlock = useMemo(
    () =>
      panelFocusAgent === undefined
        ? undefined
        : state.blocks.find(
            (block): block is SubagentBlock =>
              block.kind === 'subagent' && block.subagentId === panelFocusAgent,
          ),
    [state.blocks, panelFocusAgent],
  );
  const subscribePanelAgent = useCallback(
    (listener: () => void) =>
      controller === null || panelFocusAgent === undefined
        ? () => {}
        : controller.subscribeAgent(panelFocusAgent, listener),
    [controller, panelFocusAgent],
  );
  const panelAgentState = useSyncExternalStore(
    subscribePanelAgent,
    () => (controller !== null && panelFocusAgent !== undefined ? controller.getAgentState(panelFocusAgent) : emptyView),
  );
  const panelFocusPendingCount = useMemo(
    () =>
      panelAgentState.blocks.filter(
        (block) =>
          (block.kind === 'approval' && block.resolution === undefined) ||
          (block.kind === 'question' && block.outcome === undefined),
      ).length,
    [panelAgentState.blocks],
  );
  const handlePanelFocusJumpToSpawn = useCallback(() => {
    if (panelFocusAgent === undefined) return;
    const parentId = forest.byId[panelFocusAgent]?.parentAgentId ?? panelFocusBlock?.parentAgentId;
    if (parentId === undefined || parentId === MAIN_AGENT_ID) {
      // Already on the main timeline: locate the spawning card in place.
      void locateInTimeline({ kind: 'subagent', agentId: panelFocusAgent }, { sessionId });
      return;
    }
    openAgent(parentId);
  }, [panelFocusAgent, panelFocusBlock, forest, openAgent]);
  const focusSubagent =
    panelFocusAgent === undefined
      ? undefined
      : {
          agentId: panelFocusAgent,
          block: panelFocusBlock,
          pendingInteractionCount: panelFocusPendingCount,
          onJumpToSpawn: handlePanelFocusJumpToSpawn,
        };
  // Panel-focus rail state: the background-task bar lists only the focused
  // agent's own tasks (registered on its parent's task service), and the
  // cancel/detail owner scope is that agent — mixing main-session tasks in
  // would stop/detail them against the wrong service (task-not-found) and
  // read as foreign entries under the "X's panel" badge. Main focus keeps the
  // session-wide set unchanged.
  const focusTaskOwner = panelFocusAgent;
  // The inspector's now / needs-you / recent chapters read the focused
  // agent's own blocks and run state too; the session record stays main's.
  const focusState = useMemo(
    () =>
      panelFocusAgent === undefined
        ? state
        : {
            ...state,
            tasks: panelAgentState.tasks,
            blocks: panelAgentState.blocks,
            busy: panelAgentState.busy,
            model: panelAgentState.model,
            thinkingEffort: panelAgentState.thinkingEffort,
          },
    [panelFocusAgent, panelAgentState, state],
  );
  // Inspector follows the user's focus (inspectorFocus.ts): click / keyboard
  // focus into main's column pins main; into a subagent card, tree node or
  // embedded pane pins that subagent. Hover only peeks. The routed agent page
  // owns its own rail, so tracking runs on the main view only.
  const forestRef = useRef(forest);
  forestRef.current = forest;
  const isKnownAgent = useCallback((agentId: string) => forestRef.current.byId[agentId] !== undefined, []);
  useInspectorFocusTracking({
    onPin: setPanelFocusAgent,
    isKnown: isKnownAgent,
  });
  const inspectMain = useCallback(() => { setPanelFocusAgent(undefined); }, []);
  const openFileInPreview = useCallback((path: string) => { previewRef.current?.openFile(path); }, []);
  const openImageInPreview = useCallback((src: string, name: string) => { previewRef.current?.openImage(src, name); }, []);

  const handleResolveApproval = useCallback(
    (
      approvalId: string,
      decision: 'approved' | 'rejected' | 'cancelled',
      scope?: 'session',
      selectedOptionId?: string,
    ) =>
      controller?.resolveApproval(approvalId, decision, scope, selectedOptionId) ??
      Promise.resolve(),
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
  const handleClearQueue = useCallback(() => {
    if ((actions?.clearQueue) === undefined) return;
    setConfirmClearQueue(true);
  }, [actions]);
  const queuedItems = useMemo(() => queuedPromptPreviews(state), [state]);
  const handleRemoveQueuedAttachment = useCallback((promptId: string, attachmentIndex: number) => {
    const item = queuedItems.find((entry) => entry.promptId === promptId);
    if (controller === null || item?.content === undefined) return Promise.resolve();
    return controller.replaceQueued(promptId, item.text, withoutQueuedAttachment(item.content, attachmentIndex))
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('sv.editQueuedFailed', { detail: error instanceof Error ? error.message : String(error) }),
        });
      });
  }, [controller, queuedItems, t]);
  // Queue edit round-trip: "edit" parks the queued text in the composer
  // (remembering the in-progress draft); confirm replaces it in place via
  // actions.editQueued, cancel/remove hand the saved draft back.
  const handleStartQueueEdit = useCallback(
    (promptId: string) => {
      if (queueEdit !== null) return;
      const item = queuedItems.find((entry) => entry.promptId === promptId);
      if (item === undefined || (item.text === '' && (item.media?.length ?? 0) === 0)) return;
      setQueueEdit({ promptId, savedDraft: draftRef.current });
      updateDraft(item.text);
    },
    [queueEdit, queuedItems, updateDraft],
  );
  const handleQueueEditConfirm = useCallback(
    (text: string): Promise<void> => {
      const edit = queueEdit;
      if (edit === null) return Promise.resolve();
      const exit = () => {
        setQueueEdit(null);
        updateDraft(edit.savedDraft);
      };
      const item = queuedItems.find((entry) => entry.promptId === edit.promptId);
      // Row vanished (sent/cleared elsewhere) or text unchanged: nothing to
      // replace — just restore the draft.
      if (item === undefined || item.text === text || actions === null) {
        exit();
        return Promise.resolve();
      }
      return actions
        .editQueued(edit.promptId, text)
        .then(() => { exit(); })
        // editQueued already toasted the failure; keep the edit open so the
        // text can be retried or cancelled.
        .catch(() => undefined);
    },
    [queueEdit, queuedItems, actions, updateDraft],
  );
  const handleQueueEditCancel = useCallback(() => {
    if (queueEdit === null) return;
    updateDraft(queueEdit.savedDraft);
    setQueueEdit(null);
  }, [queueEdit, updateDraft]);
  const handleQueueEditRemove = useCallback(() => {
    const edit = queueEdit;
    if (edit === null) return;
    setQueueEdit(null);
    updateDraft(edit.savedDraft);
    void handleCancelQueued(edit.promptId);
  }, [queueEdit, updateDraft, handleCancelQueued]);
  const handleMoveQueued = useCallback(
    (promptId: string, targetIndex: number) =>
      controller?.moveQueued(promptId, targetIndex).catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('queue.moveFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }) ?? Promise.resolve(),
    [controller, t],
  );
  const handleQueuedTiming = useCallback(
    (promptId: string, timing: DeferredAppendTiming) =>
      controller?.setQueuedTiming(promptId, timing).catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('queue.timingFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }) ?? Promise.resolve(),
    [controller, t],
  );
  // Self-heal: if the row being edited leaves the queue (steered, cleared, or
  // aborted from another surface), leave edit mode and restore the draft.
  useEffect(() => {
    if (queueEdit === null || !state.loaded) return;
    if (!state.queuedPromptIds.includes(queueEdit.promptId)) {
      handleQueueEditCancel();
    }
  }, [queueEdit, state.loaded, state.queuedPromptIds, handleQueueEditCancel]);
  // Edit hold: while a queued prompt sits in the composer for editing, the
  // engine must not launch it (nor anything queued behind it; prompts ahead
  // of it still run). The server lets an unrenewed hold lapse, so renew it
  // while the edit stays open; leaving the edit (save, cancel, remove, the
  // row vanishing) releases it and the queue resumes in order.
  const editHoldPromptId = queueEdit?.promptId;
  useEffect(() => {
    if (editHoldPromptId === undefined || controller === null) return;
    const hold = () => { void controller.holdQueued(editHoldPromptId, true).catch(() => undefined); };
    hold();
    const renew = setInterval(hold, QUEUE_EDIT_HOLD_RENEW_MS);
    return () => {
      clearInterval(renew);
      void controller.holdQueued(editHoldPromptId, false).catch(() => undefined);
    };
  }, [controller, editHoldPromptId]);
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
      void actions.activateSkill(
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
    void actions.send(
      submission.text,
      submission.attachments,
      submission.goalObjective === undefined
        ? undefined
        : { goalObjective: submission.goalObjective },
    );
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
    if (!readDesktopPrefs().notifications || host.isWindowVisibleAndFocused === undefined) return;
    void host.isWindowVisibleAndFocused().then((visibleAndFocused) => {
      if (visibleAndFocused) return;
      void host.notify?.({
        title: 'Kiki',
        body: t('sv.notificationBody'),
      });
    });
  }, [host, state.pendingInteraction, t]);

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
  // The main agent's automatic-compaction point, read from the server for the
  // meter's adjustable track (absent on engines that do not report one).
  const contextAutoCompact = useContextMeterAutoCompact({
    sessionId,
    agentId: MAIN_AGENT_ID,
    modelId: sessionModel,
    modelLabel: catalogItem?.display_name ?? sessionModel,
    maxContextTokens: contextLimit,
    running: canAbortActiveTurn(state),
    profileName: boundProfile,
    profileCatalog: agentProfileCatalogMode,
  });

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
    (
      text: string,
      composerAttachments: readonly ComposerAttachment[],
      options?: { readonly goalObjective?: string },
    ) => actions?.send(text, composerAttachments, options),
    [actions],
  );
  const handleComposerSendNow = useCallback(
    (text: string, composerAttachments: readonly ComposerAttachment[]) =>
      actions?.send(text, composerAttachments, { now: true }),
    [actions],
  );
  const handleComposerAbort = useCallback(() => void actions?.abort(), [actions]);

  // ---- goal card + recovered-queue gate (main view dock) ----
  const handleGoalRefresh = useCallback(
    () => client.getSessionGoal(sessionId),
    [client, sessionId],
  );
  const handleGoalUpdate = useCallback(
    (input: UpdateAgentGoalInput) => client.updateAgentGoal(sessionId, input),
    [client, sessionId],
  );
  const handleGoalPause = useCallback(() => client.pauseAgentGoal(sessionId), [client, sessionId]);
  const handleGoalResume = useCallback(
    () => client.resumeAgentGoal(sessionId, { continueIfPaused: true, continueIfBlocked: true }),
    [client, sessionId],
  );
  const handleGoalCancel = useCallback(() => client.cancelAgentGoal(sessionId), [client, sessionId]);

  // ---- composer header: goal + queue as the card's top row ----
  // Readiness mirrors the engine's timing rule (promptService.isTimingReady)
  // from the client's view: idle, then no running subagent, then no running
  // task. Display only — the engine stays the authority on dispatch.
  const agentIdle = !state.busy;
  const runningSubagents = state.tasks.some((task) => task.status === 'running' && task.kind === 'subagent');
  const anyRunningTask = state.tasks.some((task) => task.status === 'running');
  const queueTimingReady = useCallback(
    (timing: DeferredAppendTiming) =>
      agentIdle &&
      (timing === 'agent_idle' || (timing === 'subagents_done' ? !runningSubagents : !anyRunningTask)),
    [agentIdle, runningSubagents, anyRunningTask],
  );
  const headerGoal = goalShowsInHeader(state.goal) ? state.goal : undefined;
  const headerGoalSection = useMemo<ComposerHeaderSection | undefined>(() => (
    headerGoal === undefined ? undefined : {
      summary: <GoalHeaderSummary goal={headerGoal} />,
      ariaLabel: t('goal.cardAria'),
      title: headerGoal.objective,
      panel: (
        <GoalCard goal={headerGoal} onRefresh={handleGoalRefresh} onUpdate={handleGoalUpdate}
          onPause={handleGoalPause} onResume={handleGoalResume} onCancel={handleGoalCancel} />
      ),
    }
  ), [headerGoal, t, handleGoalRefresh, handleGoalUpdate, handleGoalPause, handleGoalResume, handleGoalCancel]);
  const headerQueueSection = useMemo<ComposerHeaderSection | undefined>(() => {
    if (queuedItems.length === 0) return undefined;
    const first = queuedItems[0]!;
    return {
      summary: (
        <QueueHeaderSummary
          count={queuedItems.length}
          preview={first.text === '' ? t('sv.queueNoText') : first.text}
          editing={queueEdit !== null}
          alone={headerGoal === undefined}
        />
      ),
      ariaLabel: t('sv.queueAria'),
      count: queuedItems.length,
      // The round-trip edit keeps its row (and the hold notice) in sight.
      forceOpen: queueEdit !== null,
      panel: (
        <QueueStrip
          items={queuedItems} onSendNow={handleSendNowQueued} onRemove={handleCancelQueued}
          onRemoveAttachment={handleRemoveQueuedAttachment} onEdit={handleStartQueueEdit}
          onMove={handleMoveQueued} onChangeTiming={handleQueuedTiming}
          editingPromptId={queueEdit?.promptId} onClearAll={handleClearQueue}
          sendNowDisabled={state.resyncing || state.resyncFailed}
          timingReady={queueTimingReady}
        />
      ),
    };
  }, [
    queuedItems, queueEdit, headerGoal, t, handleSendNowQueued, handleCancelQueued,
    handleRemoveQueuedAttachment, handleStartQueueEdit, handleMoveQueued, handleQueuedTiming,
    handleClearQueue, state.resyncing, state.resyncFailed, queueTimingReady,
  ]);
  const composerHeader = headerGoalSection === undefined && headerQueueSection === undefined ? undefined : (
    <ComposerHeader goal={headerGoalSection} queue={headerQueueSection} settled={state.loaded} />
  );

  // Keep recovery controls mounted until the engine releases the queue hold.
  const [recoveryPending, setRecoveryPending] = useState(false);
  const recoveryHold = state.promptQueueHold !== undefined;
  const handleRecoveryConfirm = useCallback(() => {
    setRecoveryPending(true);
    void client
      .resumeRecoveredQueue(sessionId)
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('sv.queueRecovered.failed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      })
      .finally(() => {
        setRecoveryPending(false);
      });
  }, [client, sessionId, t]);

  const composerBusy = canAbortActiveTurn(state);
  // The working line under the composer: only while the agent itself is
  // busy (an approval or question hands the floor to the tray instead).
  const composerWorking = composerBusy && state.pendingInteraction === 'none';
  const lastResponseAt = useLastResponseAt(composerWorking, state.blocks, state.turnStartedAt);
  const composerWorkingInfo = useMemo(
    () => (composerWorking ? { lastResponseAt } : undefined),
    [composerWorking, lastResponseAt],
  );
  // Child routes dock their mailbox composer locally in AgentWorkspace;
  // only main publishes the resident prompt composer to ConversationShell.
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
            planGate={planGate}
            goalMode={goalMode}
            efforts={supportedEfforts}
            effort={effectiveEffort}
            contextUsage={
              contextUsed !== undefined && contextLimit !== undefined
                ? { used: contextUsed, limit: contextLimit }
                : undefined
            }
            contextAutoCompact={contextAutoCompact}
            sessionUsage={usage}
            sessionId={sessionId}
            workspaceId={profileWorkspaceId}
            agentProfileCatalogMode={agentProfileCatalogMode}
            fsSearch={handleFsSearch}
            attachments={queueEdit === null ? attachments : []}
            onChangeAttachments={updateAttachments}
            quote={queueEdit === null ? quote : null}
            onRemoveQuote={handleRemoveQuote}
            annotations={queueEdit === null ? annotations : []}
            onRemoveAnnotation={handleRemoveAnnotation}
            onActivateSkill={handleActivateSkill}
            onSessionAction={runSessionAction}
            onCompactContext={handleCompactContext}
            onChangeModel={handleModelChange}
            onChangeAgentProfile={handleAgentProfileChange}
            onRebuildContext={handleContextRebuild}
            onChangePermissionMode={setPermissionOverride}
            onChangePlanMode={setPlanOverride}
            onChangePlanGate={setPlanGateOverride}
            onChangeGoalMode={setGoalMode}
            onChangeEffort={handleEffortChange}
            onSend={handleComposerSend}
            onSendNow={handleComposerSendNow}
            working={composerWorkingInfo}
            onAbort={handleComposerAbort}
            queueEditing={queueEdit !== null}
            onQueueEditConfirm={handleQueueEditConfirm}
            onQueueEditCancel={handleQueueEditCancel}
            onQueueEditRemove={handleQueueEditRemove}
            header={composerHeader}
            onOpenImage={openImageInPreview}
          />
        </ContextBreakdownProvider>
      ),
  }), [
    selectedAgentId,
    state.loaded,
    state.resyncing,
    state.resyncFailed,
    state.contextBreakdown,
    composerBusy,
    composerWorkingInfo,
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
    planGate,
    goalMode,
    supportedEfforts,
    effectiveEffort,
    contextUsed,
    contextLimit,
    contextAutoCompact,
    sessionId,
    profileWorkspaceId,
    agentProfileCatalogMode,
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
    handleComposerSendNow,
    handleComposerAbort,
    queueEdit,
    handleQueueEditConfirm,
    handleQueueEditCancel,
    handleQueueEditRemove,
    composerHeader,
    openImageInPreview,
    handleModelChange,
    handleEffortChange,
    handleAgentProfileChange,
    handleContextRebuild,
    t,
  ]);
  useRegisterSeat(seat);

  // Main-transcript projection, memoized so unrelated publishes don't rescan
  // the full block list; per-delta publishes reuse it when blocks/forest are
  // untouched.
  const mainTranscriptBlocks = useMemo(
    () => withOptimisticUserBlock(filterBlocksToDirectChildren(state.blocks, forest, MAIN_AGENT_ID), pendingSubmission),
    [state.blocks, forest, pendingSubmission],
  );
  // "Needs you" tray: every pending approval/question in the session (main
  // and subagents) answers above the composer; the timeline keeps one-line
  // records (InteractionPlacementContext) whose Review action focuses the
  // tray item.
  const trayRef = useRef<NeedsYouTrayHandle>(null);
  const trayItems = useMemo(
    () => state.blocks.filter(
      (block): block is ApprovalBlock | QuestionBlock =>
        (block.kind === 'approval' && block.resolution === undefined) ||
        (block.kind === 'question' && block.outcome === undefined),
    ),
    [state.blocks],
  );
  const trayAgentNames = useMemo(() => {
    const names = new Map<string, string>();
    if (forest !== undefined) {
      for (const node of Object.values(forest.byId)) names.set(node.agentId, node.label);
    }
    return names;
  }, [forest]);
  const interactionPlacement = useMemo<InteractionPlacement>(
    () => ({ inTray: true, onReview: (kind, id) => { trayRef.current?.focusItem(kind, id); } }),
    [],
  );
  // The subagent route branch: the shell resolves the target and navigation;
  // the workspace owns header, timeline, resync, details, and actions.
  if (selectedAgentId !== undefined) {
    return (
      <>
        <AgentWorkspace
          target={{ sessionId, agentId: selectedAgentId }}
          controller={controller}
          sessionState={state}
          forest={forest}
          navigation={agentWorkspaceNavigation}
          railOpen={railOpen}
          railIsOverlay={railIsOverlay}
          onToggleRail={toggleRail}
          onCloseRail={closeRail}
          onCancelTask={handleCancelTask}
          onStopAgentTask={stopAgentTask}
          previewApiRef={previewRef}
        />
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
      </>
    );
  }

  return (
    <MediaPreviewProvider
      sessionId={sessionId}
      cwd={state.session?.metadata?.cwd}
      sessionViewState={state}
      agentForest={forest}
      onOpenSubagent={openAgent}
      apiRef={previewRef}
      controller={controller}
      workspaceNavigation={agentWorkspaceNavigation}
      onCancelTask={handleCancelTask}
      onStopAgentTask={stopAgentTask}
    >
      <PreviewFocusBridge onFocusedAgent={setPanelFocusAgent} />
      <InteractionPlacementContext.Provider value={interactionPlacement}>
      <AgentWorkspace
        target={{ sessionId, agentId: MAIN_AGENT_ID }}
        controller={controller}
        sessionState={state}
        forest={forest}
        navigation={agentWorkspaceNavigation}
        railOpen={railOpen}
        railIsOverlay={railIsOverlay}
        onToggleRail={toggleRail}
        onCloseRail={closeRail}
        onCancelTask={handleCancelTask}
        onStopAgentTask={stopAgentTask}
        inheritMediaPreview
        main={{
          header: <Header
            controller={controller} railOpen={railOpen}
            terminalAvailable={terminalAvailable} terminalOpen={terminalOpen}
            onToggleRail={toggleRail} onToggleTerminal={toggleTerminalPanel}
            onToggleSidebar={onToggleSidebar} onRenameSession={renameSession}
            onSessionAction={runSessionAction}
          />,
          timeline: {
            state: { ...state, blocks: mainTranscriptBlocks },
            onLoadOlder: handleLoadOlder,
            onResolveApproval: handleResolveApproval,
            onAnswerQuestion: handleAnswerQuestion,
            onDismissQuestion: handleDismissQuestion,
            onCancelQueued: handleCancelQueuedChips,
            onRetryLoad: handleRetryLoad,
            forest,
            onOpenAgent: openAgent,
            rowActions: transcriptRowActions,
          },
          timelineRef: transcriptQuoteRef,
          timelineOverlay: <SelectionQuoteButton
            containerRef={transcriptQuoteRef}
            onQuote={handleQuoteSelection} onAnnotate={handleAnnotateSelection}
          />,
          dock: <>
            <ResyncStatusBanner
              resyncing={state.resyncing} resyncFailed={state.resyncFailed}
              error={state.resyncError}
              onRetry={controller === null ? undefined : () => { void controller.resync(); }}
            />
            {recoveryHold ? (
              <RecoveryHoldBar count={state.queuedPromptIds.length} pending={recoveryPending}
                onConfirm={handleRecoveryConfirm} />
            ) : null}
            <AnnotationTray
              sessionId={sessionId}
              blocks={mainTranscriptBlocks}
              pending={queueEdit === null ? annotations : []}
              onUpdatePending={handleUpdateAnnotation}
              onRemovePending={handleRemoveAnnotation}
            />
            <NeedsYouTray
              ref={trayRef}
              items={trayItems}
              agentNames={trayAgentNames}
              onResolveApproval={handleResolveApproval}
              onAnswerQuestion={handleAnswerQuestion}
              onDismissQuestion={handleDismissQuestion}
              onRequestBatchResolve={handleBatchResolve}
            />
          </>,
          rail: <RightRail
            className={`app-rail ${railOpen ? 'open' : ''}`}
            state={focusState} forest={forest} selectedAgentId={panelFocusAgent}
            subagent={focusSubagent} taskOwnerAgentId={focusTaskOwner}
            onCancelTask={handleCancelTask} onStopAgentTask={stopAgentTask}
            onOpenSubagent={openAgent} onClose={closeRail}
            onInspectMain={inspectMain} onOpenFile={openFileInPreview}
            onReviewPending={(kind, id) => { trayRef.current?.focusItem(kind, id); }}
            sessionPending={trayItems} onResolveApproval={handleResolveApproval}
          />,
        }}
      />
      </InteractionPlacementContext.Provider>
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
