/**
 * SessionView — session command and composer owner for /s/:id and child routes.
 *
 * Renders main and child through AgentWorkspace while retaining the resident
 * ConversationShell composer seat across /new → /s/:id.
 */

import { randomUuid } from '@kiki/session-core/util';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@base-ui/react/popover';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';

import type { DeferredAppendTiming, MessageContent, PermissionMode, PromptPlanGate, PromptSkillActivation, PromptSubmission, Session, SessionPendingInteraction, SessionSeedMode } from '@kiki/protocol';
import { mediaFromContentParts, mediaRefWithAttachmentDetail } from '@kiki/session-core/composer/media';

import { AgentWorkspace, countPendingInteractions, HEADER_ICON_BUTTON, PanelIcon, ResyncStatusBanner, sendNowNotice, sendNowQueuedNotice, useAgentWorkspaceCore, WorkspaceHeader, type AgentWorkspaceNavigation } from './agent-workspace';
import { ConfirmDialog } from './ConfirmDialog';
import { NavBackButton } from './NavBackButton';
import { PhoneRemoteSpaceLine } from './PageChrome';
import { invalidatePersonaSessionLists } from '../lib/personaFreshness';
import { placeNewPath, placeRoutePrefix, placeSessionPath, stripPlacePrefix } from '../lib/placeRoutes';
import { useGuardedNavigate } from './dirtyGuard';
import { Composer, DEFAULT_AGENT_PROFILE, resolveSelectedEffort, type ComposerEngine, type PendingRuntimeControls } from './Composer';
import { ContextBreakdownProvider } from './ContextMeter';
import { useCompactionProgress } from './useCompactionProgress';
import { useLastResponseAt } from './composerWorking';
import { useRequestGovernance } from '../lib/useRequestGovernance';
import { profileThinkingDefault } from '../lib/profileThinking';
import {
  useConversationShell,
  useRegisterSeat,
  type ConversationPhase,
  type ConversationSeat,
} from './ConversationShell';
import { ComposerHeader, type ComposerHeaderSection } from './ComposerHeader';
import { GoalCard, GoalHeaderSummary, GoalPauseButton, goalShowsInHeader, RecoveryHoldBar } from './GoalCard';
import type { DraftSkillHandoff } from './NewSessionDraft';
import { QueueHeaderSummary, QueueStrip } from './QueueStrip';
import { SubmissionRecovery } from './SubmissionRecovery';
import { AdmissionScope, filterIngressForAgent, useAdmissionScope, withAdmissionUserBlocks, withOptimisticUserBlock } from './timeline/AdmissionLine';
import { RightRail } from './RightRail';
import { ModelSwitchDialog } from './model-switch/ModelSwitchDialog';
import { canFaithfullyRetryUserBlock } from './timeline/TurnTailSurface';
import { ModelSwitchActionsContext } from './model-switch/ModelSwitchNotice';
import { PromptEffectiveDrawer } from './agent-panel/PromptEffectiveDrawer';
import { useInspectorFocusTracking } from './inspectorFocus';
import { ActionSheet } from './overlays/ActionSheet';
import {
  restoreSentAnnotations,
  serializeSelectionCarryover,
  updateStoredAnnotations,
} from './agent-workspace/useConversationAnnotations';
import { registerTurnLocateHint, useStableForest, type TranscriptRowActions } from './Transcript';
import { mergeLoadedAttachments } from './RowActions';
import { Icon } from './icons';
import { useSidebarContext } from './sidebarContext';
import { MessageViewContext } from './message/messageViewContext';
import { isTimelineViewShortcut, useTimelineView, type TimelineView } from './message/messageViewMode';
import { TimelineMenuRows, TimelineViewSwitch } from './message/TimelineViewSwitch';
import { PersonaSessionIdentity } from './persona/PersonaSessionIdentity';
import { PersonaSettingsDialog } from './persona/PersonaSettingsUpdate';
import { sessionPersonaId } from './persona/personaSessionUtils';
import { WorktreeMark } from './WorktreeMark';
import { PromotedFromMark } from './PromotedFromMark';
import { BtwFloatingCard } from './fork/BtwFloatingCard';
import { ForkLaunchPopover } from './fork/ForkLaunchPopover';
import { ForkProvenanceMark } from './fork/ForkProvenanceMark';
import {
  buildSessionForkItems,
  buildSessionForkLineage,
  hasActiveOrMergedBranches,
  type ForkOriginSummary,
  type SessionForkLineage,
} from './fork/forkLineageModel';
import { waitingAgentIds as collectWaitingAgentIds } from './rail-variants/model';
import {
  contentSegmentKey,
  isSessionRemainderRef,
  useAutomaticSessionRead,
  TranscriptDetailProvider,
  type ContentContinuationHandle,
} from './transcriptDetail';
import { contentTextPresentation, projectPresentedText, readTextPresentation, type ContentRef } from '@kiki/transcript';
import { MediaPreviewProvider, PreviewToggleButton, useMediaPreview } from './mediaPreview';
import { getBackEntry } from '../lib/navHistory';
import type { MediaPreviewApi } from './mediaPreviewContext';
import {
  SESSION_REWRITTEN_EVENT,
  compactReceiptOutcome,
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '@kiki/session-core/commands';
import {
  addAnnotation,
  selectionCarryoverPresentation,
  stripThreadRefContext,
  buildPromptContent,
  retainedAttachmentsFromContent,
  fileToImageAttachment,
  buildSkillActivation,
  parseSelectionCarryovers,
  reconcileEditedThreadRefs,
  readComposerState,
  resolveComposerModelOverrides,
  recoverSubmittedDraft,
  restorePromptToDraft,
  writeComposerState,
  writeDraft,
  type ComposerAttachment,
  type RetainedAttachment,
  type FileMention,
  type ComposerModelChoice,
  type ComposerModelBindingChange,
  type SelectionAnnotation,
  sendsLegacyControl,
  namesLegacyControl,
  executionSelectionOf,
  forgetUnconfirmedSubmission,
  sameExecutionChoice,
  isEffortOnlyExecutionChange,
  isNativeExecutor,
  profileExecutor,
  type ExecutionChoice,
} from '@kiki/session-core/composer';
import {
  assertSessionWritable,
  MAIN_AGENT_ID,
  SendNowError,
  SessionController,
  assistantMessageIdFromBlock,
  createViewState,
  filterBlocksToDirectChildren,
  isOrdinaryQueueItem,
  pendingQuestionCount,
  queuedPromptPreviews,
  sessionAgentForest,
  type SessionViewState,
  type ApprovalBlock,
  type QuestionBlock,
  type AssistantBlock,
  type Block,
  type SubagentBlock,
  type UserBlock,
} from '@kiki/session-core/session';
import { sessionAttentionCursor, shortCwd, type SessionListData } from '@kiki/session-core/sessions';
import { errorText } from '@kiki/session-core/i18n';
import { readFirstSessionMessage, writeFirstSessionMessage, clearFirstSessionMessage, submitFirstSessionMessage, type FirstSessionMessageRecord, type FirstSessionSubmission } from '../lib/newSessionCreation';
import { spaceStorage } from '../lib/spaceStorage';
import {
  composerDefaultsForProfile,
  readLastSessionId,
  readSettings,
  readTerminalPanelPrefs,
  resolveCatalogModel,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeLastSessionId,
  writeLayoutPreferences,
  writeTerminalPanelPrefs,
  type AttentionCursor,
  type ComposerModelSource,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { useI18n } from '../i18n';
import { invalidateAgentProfileCatalogs } from '../lib/agentProfileCatalog';
import { API_CODES, ApiError, isSessionNotFoundMessage, isUnconfirmedTransportError, type ModelSwitchMode, type UpdateAgentGoalInput } from '../lib/client';
import { isMediaPreviewUnavailable } from './mediaParts';
import { invalidatePluginQueries } from '../lib/pluginFreshness';
import { locateInTimeline, locateSpawnTarget, normalizeTurnId } from '../lib/timelineLocate';
import { activeFindHost } from '../lib/timelineFind';
import { getReadingSnapshot, timelineSnapshotKey } from '../lib/navViewState';
import { useNavVisitId } from '../lib/useNavSnapshot';
import { useTimelineNavigation } from '../lib/useTimelineNavigation';
import { EphemeralBar, TemporaryMark } from './EphemeralBar';
import { PrivateMark } from './PrivateSessionOption';
import { isSubagentSession } from './room/threadRooms';
import { InteractionPlacementContext, type InteractionPlacement } from './Interactions';
import { externalClientsFacade } from '../lib/externalClients';
import { ExternalClientMark, ExternalSessionComposer, useExternalClientMark } from './externalClients/ExternalClientSession';
import { HarnessMark } from './harness/HarnessMark';
import {
  formatExternalCompactPrompt,
  harnessAdvertisesCompact,
  harnessDenies,
  type SessionHarness,
} from './harness/sessionHarness';
import { NeedsYouTray, type NeedsYouTrayHandle } from './NeedsYouTray';
import { reportAttention } from '../lib/awayNotify';
import { useViewedSession } from '../lib/useAwayNotifications';
import { pushToast, pushUndoToast } from '../lib/toasts';
import { useThreadTitle } from '../lib/threadTitles';
import { actionChordText, matchesShortcutAction, useShortcutState } from '../lib/shortcuts';
import { anyOverlayOpen, floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';
import { POPOVER_SURFACE_CLASS } from './SearchableSelect';
import { useLayerHistory } from '../lib/layerHistory';
import { useCoarsePointer, useLayoutPreferences, useMediaQuery, usePhoneMode } from '../lib/layoutHooks';
import { resolveControllerSubagentSearch } from '../lib/subagentSearch';
import { useConnection, useControllerRegistry } from '../state/connection';
import {
  activeTerminalManager,
  terminalCapabilityAvailable,
  TerminalManager,
} from '../state/terminalManager';

// The embedded terminal brings xterm.js and its addons; it renders only once
// the panel is open, so it loads then instead of with the app.
const TerminalPanel = lazy(() => import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })));

/** Renew cadence for a queue-edit hold (the server lets it lapse after 5 minutes). */
export const QUEUE_EDIT_HOLD_RENEW_MS = 60_000;

export async function replaceQueuedPrompt(
  promptId: string,
  text: string,
  replace: (id: string, replacement: string) => Promise<void>,
): Promise<void> {
  await replace(promptId, text);
}

type QueuedMediaContent = Extract<MessageContent, { type: 'image' | 'video' | 'file' }>;

type QueuedAttachmentRemoval = {
  readonly text: string;
  readonly media: readonly QueuedMediaContent[];
  readonly presentation?: import('@kiki/transcript').TextPresentation;
};

function isQueuedMediaContent(part: MessageContent): part is QueuedMediaContent {
  return part.type === 'image' || part.type === 'video' || part.type === 'file';
}

function adjustPresentationAfterTextRemoval(
  span: import('@kiki/transcript').TextPresentationSpan,
  removeStart: number,
  removeEnd: number,
  removedLength: number,
): import('@kiki/transcript').TextPresentationSpan[] {
  if (span.end <= removeStart) return [span];
  if (span.start >= removeEnd) return [{ ...span, start: span.start - removedLength, end: span.end - removedLength }];
  const pieces: import('@kiki/transcript').TextPresentationSpan[] = [];
  if (span.start < removeStart) pieces.push({ ...span, end: Math.min(span.end, removeStart) });
  if (span.end > removeEnd) {
    pieces.push({
      ...span,
      start: Math.max(span.start, removeEnd) - removedLength,
      end: span.end - removedLength,
    });
  }
  return pieces.filter((piece) => piece.end > piece.start);
}

export function removeQueuedAttachment(
  content: readonly MessageContent[],
  attachmentIndex: number,
  separator = '\n\n',
): QueuedAttachmentRemoval {
  const media = content.filter(isQueuedMediaContent);
  const textParts = content.filter((part): part is Extract<MessageContent, { type: 'text' }> => part.type === 'text');
  const text = textParts.map((part) => part.text).join(separator);
  const presentation = contentTextPresentation(content, separator);
  const structuredCount = media.length;
  if (attachmentIndex < structuredCount) {
    return {
      text,
      media: media.filter((_, index) => index !== attachmentIndex),
      presentation,
    };
  }

  const attachmentSpans = (presentation?.spans ?? []).flatMap((span, index) => (
    span.kind === 'attachment' && span.attachment !== undefined ? [{ span, index }] : []
  ));
  const target = attachmentSpans[attachmentIndex - structuredCount];
  if (target === undefined) return { text, media, presentation };
  const targetStart = target.span.start;
  const targetEnd = target.span.end;
  const textRanges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [index, part] of textParts.entries()) {
    const end = cursor + part.text.length;
    textRanges.push({ start: cursor, end });
    cursor = end + (index === textParts.length - 1 ? 0 : separator.length);
  }
  const targetPartIndex = textRanges.findIndex((range) => targetStart >= range.start && targetEnd <= range.end);
  const targetPart = targetPartIndex === -1 ? undefined : textRanges[targetPartIndex];
  let removeStart = targetStart;
  let removeEnd = targetEnd;
  if (targetPart !== undefined && targetStart === targetPart.start && targetEnd === targetPart.end) {
    if (targetPartIndex > 0) removeStart -= separator.length;
    else if (textParts.length > 1) removeEnd += separator.length;
  }
  const removedLength = removeEnd - removeStart;
  const nextPresentationSpans = (presentation?.spans ?? []).flatMap((span, index) => (
    index === target.index ? [] : adjustPresentationAfterTextRemoval(span, removeStart, removeEnd, removedLength)
  ));
  return {
    text: `${text.slice(0, removeStart)}${text.slice(removeEnd)}`,
    media,
    presentation: nextPresentationSpans.length === 0 ? undefined : { spans: nextPresentationSpans },
  };
}

export function withoutQueuedAttachment(content: readonly MessageContent[], attachmentIndex: number): MessageContent[] {
  return [...removeQueuedAttachment(content, attachmentIndex).media];
}

export function fileMentionFromPathMedia(media: NonNullable<UserBlock['media']>[number]): FileMention | undefined {
  if (media.kind !== 'file' || media.fileId !== undefined || media.detail !== undefined || media.path === undefined || media.path === '') return undefined;
  const pathParts = media.path.split(/[\\/]/u).filter((part) => part !== '');
  return {
    kind: 'file',
    path: media.path,
    name: media.name ?? pathParts.at(-1) ?? media.path,
    isDir: false,
  };
}

/** The saved terminal chord (VS Code's Ctrl+` unless remapped), and the only
 * keyboard path to the panel now that its toggle lives in the header menu. */
export function isTerminalShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return matchesShortcutAction(event, 'terminal-toggle');
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
  persistenceHint?: 'temporary' | 'saved' | 'unknown',
): { controller: SessionController | null; leaseReady: boolean } {
  const { client } = useConnection();
  const registry = useControllerRegistry();
  const [active, setActive] = useState<{ sessionId: string | undefined; controller: SessionController | null; leaseReady: boolean }>({
    sessionId: undefined,
    controller: null,
    leaseReady: false,
  });

  useLayoutEffect(() => {
    if (sessionId === undefined) {
      setActive({ sessionId: undefined, controller: null, leaseReady: false });
      return;
    }
    // The registry keeps a recently left view parked (bounded LRU), so coming
    // back reuses its window instead of waiting for a fresh reset. Running in
    // useLayoutEffect parks/cancels the previous session's history reads and
    // acquires the next session before paint so cached views repaint in 0ms
    // and cold views show immediate loading feedback without stale-session flash.
    const lease = registry.acquire(
      sessionId,
      client,
      () => new SessionController(client.sessions, client.sessionView(sessionId), sessionId),
      focusedAgentId ?? MAIN_AGENT_ID,
    );
    const next = lease.controller;
    let activeLease = true;
    next.setPersistenceHint?.(persistenceHint);
    setActive({ sessionId, controller: next, leaseReady: false });
    void lease.ready.then(
      () => {
        if (activeLease) setActive({ sessionId, controller: next, leaseReady: true });
      },
      () => {
        // Snapshot failure leaves the controller unloaded; the transcript shows
        // "Opening session…" until a resync succeeds, but the lease is settled.
        if (activeLease) setActive({ sessionId, controller: next, leaseReady: true });
      },
    );
    return () => {
      activeLease = false;
      lease.release();
      setActive({ sessionId: undefined, controller: null, leaseReady: false });
    };
  }, [client, sessionId, registry]);

  const currentController = active.controller !== null && active.sessionId === sessionId &&
    active.controller.sessionId === sessionId
    ? active.controller
    : null;
  const currentLeaseReady = currentController !== null && active.leaseReady;

  useEffect(() => {
    currentController?.setPersistenceHint?.(persistenceHint);
  }, [currentController, persistenceHint]);

  return { controller: currentController, leaseReady: currentLeaseReady };
}

/** The ☰ count on a phone: the same inbox the sidebar's bell reports. */
export interface SidebarBadge {
  readonly total: number;
  readonly needsYou: boolean;
  readonly needsYouCount?: number;
}

const Header = memo(function Header({
  controller,
  railOpen,
  railAvailable = true,
  terminalAvailable,
  terminalOpen,
  onToggleRail,
  onToggleTerminal,
  onToggleSidebar,
  sidebarBadge,
  onRenameSession,
  onTogglePrivate,
  privateBusy = false,
  onSessionAction,
  freshContextAvailable = false,
  onSideQuestion,
  onOpenBranch,
  forkLineage,
  forkPopoverOpenRequest,
  forkLaunchBusy = false,
  onOpenForkSession,
  onOpenBranchAgent,
  onForkSessionWithSeed,
  onStartBranchWithSeed,
  view,
  onView,
  onDelivery,
  deliveryPending,
  harness,
}: {
  /** External engine behind main: its mark beside the title, and no fork when it refused one. */
  harness?: SessionHarness;
  controller: SessionController | null;
  railOpen: boolean;
  railAvailable?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleRail: () => void;
  onToggleTerminal: () => void;
  onToggleSidebar: () => void;
  sidebarBadge?: SidebarBadge;
  onRenameSession: (title: string) => Promise<void>;
  onTogglePrivate?: () => void;
  privateBusy?: boolean;
  onSessionAction: (action: 'fork' | 'undo' | 'compact' | 'export' | 'fresh-context') => void;
  freshContextAvailable?: boolean;
  onSideQuestion?: () => void;
  onOpenBranch?: () => void;
  forkLineage?: SessionForkLineage;
  forkPopoverOpenRequest?: { readonly seq: number; readonly focusBranch?: boolean };
  forkLaunchBusy?: boolean;
  onOpenForkSession?: (sessionId: string) => void;
  onOpenBranchAgent?: (agentId: string) => void;
  onForkSessionWithSeed?: (seed: SessionSeedMode) => void;
  onStartBranchWithSeed?: (task: string, seed: SessionSeedMode, openMode?: 'route' | 'split') => void;
  view: TimelineView;
  onView: (view: TimelineView) => void;
  onDelivery: (delivery: 'reply' | 'message') => void;
  deliveryPending: boolean;
}) {
  const { t, tp } = useI18n();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [promptDetailsOpen, setPromptDetailsOpen] = useState(false);
  const [personaSettingsOpen, setPersonaSettingsOpen] = useState(false);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptyState,
  );
  const session = state.session;
  // A session driven by an outside client carries that fact in its own
  // metadata; an ordinary session has none and renders exactly as before.
  const externalClient = useExternalClientMark(session?.metadata);
  // Two different questions the old single `isBotSession` answered at once:
  // whose conversation this is (persona), and whether the reply mode makes
  // 消息|过程 meaningful (a message-delivering session). An ordinary persona
  // session is not a Bot and never gets the message view it did not ask for.
  const persona = session?.agent_config.persona;
  const personaId = session === undefined ? undefined : sessionPersonaId(session);
  const deliveryCapable = session?.delivery === 'message';
  const approvals = useMemo(
    () => state.blocks.filter((block) => block.kind === 'approval' && block.resolution === undefined).length,
    [state.blocks],
  );
  const questions = pendingQuestionCount(state);
  const waiting = approvals + questions;
  const runningTasks = state.tasks.filter((task) => task.status === 'running').length;
  const isNarrow = useMediaQuery('(max-width: 639px)');
  // Below lg the rail is an overlay drawer owned by the routed agent page, so
  // the header's rail toggle is dead weight there (same rule the cockpit
  // switch already follows inside the rail).
  const railToggleVisible = useMediaQuery('(min-width: 1024px)');
  const headerRef = useRef<HTMLElement>(null);
  const [headerNarrow, setHeaderNarrow] = useState(false);
  useEffect(() => {
    const el = headerRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      const width = el.getBoundingClientRect().width || el.clientWidth;
      if (width > 0) setHeaderNarrow((prev) => {
        const next = width < 560;
        return prev === next ? prev : next;
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  const { sidebarOpen } = useSidebarContext();


  return (
    <WorkspaceHeader main headerRef={headerRef}>
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('sv.openMenuAria')}
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
        data-sidebar-menu=""
        className="relative -ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden"
      >
        <Icon name="menu" size={16} />
        {sidebarBadge !== undefined ? (
          sidebarBadge.needsYou ? (
            <span
              data-activity-badge={sidebarBadge.total}
              data-activity-badge-tone="needs-you"
              aria-hidden
              className="pointer-events-none absolute top-1.5 right-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-attention px-[3px] text-[10px] leading-none font-normal tabular-nums text-on-accent ring-2 ring-paper"
            >
              {(() => {
                const count = sidebarBadge.needsYouCount ?? sidebarBadge.total;
                return count > 99 ? '99+' : count;
              })()}
            </span>
          ) : (
            <span
              data-activity-badge={sidebarBadge.total}
              data-activity-badge-tone="unread"
              aria-hidden
              className="pointer-events-none absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full bg-ink-soft/65 ring-2 ring-paper"
            />
          )
        ) : null}
      </button>
      {/* The one history-return entry for this visit: it appears in the title
          row only while a predecessor visit exists. */}
      <NavBackButton />
      {session !== undefined ? (
        <>
          <div className="flex min-w-0 flex-1 items-center">
            {persona !== undefined ? (
              <PersonaSessionIdentity
                session={session}
                title={
                  <SessionTitle
                    title={session.title}
                    stripPrefix={persona.name}
                    cwd={session.metadata.cwd}
                    worktree={session.worktree}
                    promotedFrom={session.promoted_from}
                    forkOrigin={isNarrow ? undefined : forkLineage?.origin}
                    editing={renaming}
                    onEditingChange={setRenaming}
                    onRename={onRenameSession}
                    onOpenRail={railAvailable ? onToggleRail : undefined}
                  />
                }
              />
            ) : (
              <SessionTitle
                title={session.title}
                cwd={session.metadata.cwd}
                worktree={session.worktree}
                promotedFrom={session.promoted_from}
                forkOrigin={isNarrow ? undefined : forkLineage?.origin}
                editing={renaming}
                onEditingChange={setRenaming}
                onRename={onRenameSession}
                onOpenRail={railAvailable ? onToggleRail : undefined}
              />
            )}
            {isNarrow && forkLineage?.origin !== undefined && !renaming ? (
              <ForkProvenanceMark origin={forkLineage.origin} className="max-w-full text-[11px] leading-3.5" />
            ) : null}
            <PhoneRemoteSpaceLine />
          </div>
          {session.ephemeral === true ? <TemporaryMark className="self-center" /> : null}
          {session.private === true ? <PrivateMark className="self-center" /> : null}
          {harness !== undefined ? <HarnessMark harness={harness} /> : null}
          {/* An externally driven session says which client drives it instead
              of naming a model, because no Kiki model runs it. */}
          {externalClient !== undefined ? <ExternalClientMark mark={externalClient} /> : null}
          {/* What is waiting on you — the count and the batch decisions —
              lives in the tray above the composer, which lists the items
              themselves. The header keeps one quiet state word and ONE
              overflow menu. */}
          {state.busy ? (
            <span
              data-header-working
              title={t('sv.working')}
              aria-label={t('sv.working')}
              className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft"
            >
              <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              <span className="hidden @[560px]/center:inline">{t('sv.working')}</span>
            </span>
          ) : null}
          {/* 消息 | 过程 exists for a message-delivering conversation, on the
              header from 560px container width up; the ⋯ menu carries it below. */}
          {deliveryCapable ? <TimelineViewSwitch view={view} onChange={onView} className="hidden @[560px]/center:flex" /> : null}
          {forkLineage !== undefined &&
          onOpenForkSession !== undefined &&
          onOpenBranchAgent !== undefined &&
          onForkSessionWithSeed !== undefined &&
          onStartBranchWithSeed !== undefined ? (
            <ForkLaunchPopover
              origin={forkLineage.origin}
              offshoots={forkLineage.allOffshoots}
              canFork={!harnessDenies(harness, 'fork')}
              canBranch={!harnessDenies(harness, 'fork')}
              canSideQuestion={!harnessDenies(harness, 'fork') && onSideQuestion !== undefined}
              busy={forkLaunchBusy}
              openRequest={forkPopoverOpenRequest}
              onOpenSession={onOpenForkSession}
              onOpenBranch={onOpenBranchAgent}
              onForkSession={onForkSessionWithSeed}
              onStartBranch={onStartBranchWithSeed}
              onStartSideQuestion={() => { onSideQuestion?.(); }}
            />
          ) : null}
          <SessionActionsMenu
            terminalAvailable={terminalAvailable}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
            onBeginRename={() => { setRenaming(true); }}
            isPrivate={session.private === true}
            privateBusy={privateBusy}
            onTogglePrivate={session.ephemeral === true || isSubagentSession(session) ? undefined : onTogglePrivate}
            onPromptDetails={() => { setPromptDetailsOpen(true); }}
            // Below lg the header has no rail toggle (and on a phone the cwd
            // that also opens it is hidden), so the overview's way in is here.
            // The same toggle opens the overlay layer the back button closes.
            onOpenOverview={railAvailable && !railToggleVisible ? onToggleRail : undefined}
            onAction={onSessionAction}
            freshContextAvailable={freshContextAvailable}
            canFork={!harnessDenies(harness, 'fork')}
            onSideQuestion={harnessDenies(harness, 'fork') ? undefined : onSideQuestion}
            onOpenBranch={harnessDenies(harness, 'fork') ? undefined : onOpenBranch}
            leading={personaId !== undefined || deliveryCapable ? (close) => (
              <>
                {/* This person's other surfaces: the conversations this
                    session belongs to, their settings, their memories. */}
                {personaId === undefined ? null : ([
                  ['persona.menu.conversations', `/personas?persona=${encodeURIComponent(personaId)}&view=conversations`],
                  ['persona.menu.settings', `/personas?persona=${encodeURIComponent(personaId)}&view=settings`],
                  ['persona.menu.memory', `/memory?persona=${encodeURIComponent(personaId)}${session.workspace_id === undefined ? '' : `&workspace=${encodeURIComponent(session.workspace_id)}`}`],
                ] as const).map(([key, href]) => (
                  <button
                    key={key}
                    type="button"
                    role="menuitem"
                    data-persona-menu={key}
                    className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper"
                    onClick={() => { close(); void navigate(href); }}
                  >
                    {t(key)}
                  </button>
                ))}
                {/* The other three entries leave for the persona's own pages;
                    this one stays on the conversation and is about the copy of
                    the persona it runs. It is the way in on a narrow screen,
                    where the rail's chapter does not exist. */}
                {personaId === undefined ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    data-persona-menu="persona.menu.binding"
                    className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper"
                    onClick={() => { close(); setPersonaSettingsOpen(true); }}
                  >
                    {t('persona.binding.menu')}
                  </button>
                )}
                {personaId === undefined ? null : <div className="my-1 h-px bg-hairline" />}
                <TimelineMenuRows
                  view={view}
                  onView={(next) => { close(); onView(next); }}
                  delivery={session.delivery ?? 'reply'}
                  onDelivery={(next) => { close(); onDelivery(next); }}
                  deliveryPending={deliveryPending}
                  // When the header switch hides (narrow viewport or <560px center
                  // column), the view choice stays reachable in this menu.
                  showView={(isNarrow || headerNarrow) && deliveryCapable}
                />
              </>
            ) : undefined}
          />
          {promptDetailsOpen ? <PromptEffectiveDrawer sessionId={state.sessionId} agentId={MAIN_AGENT_ID}
            onClose={() => { setPromptDetailsOpen(false); }} /> : null}
          {personaSettingsOpen ? <PersonaSettingsDialog sessionId={state.sessionId}
            onClose={() => { setPersonaSettingsOpen(false); }} /> : null}
        </>
      ) : (
        <span className="flex-1" />
      )}
      <PreviewToggleButton sessionId={session?.id} workspaceId={session?.workspace_id} />
      {railAvailable && railToggleVisible ? (() => {
        const attentionLabel = waiting > 0
          ? tp('inspector.waiting', waiting)
          : runningTasks > 0
            ? tp('inspector.tasks', runningTasks)
            : state.busy
              ? t('inspector.running')
              : undefined;
        const toggleTitle = railOpen
          ? t('sv.hidePanel')
          : attentionLabel !== undefined
            ? `${t('sv.showPanel')} · ${attentionLabel}`
            : t('sv.showPanel');
        const toggleAriaLabel = attentionLabel !== undefined
          ? `${t('sv.togglePanelAria')} · ${attentionLabel}`
          : t('sv.togglePanelAria');
        return (
        <button
          type="button"
          onClick={onToggleRail}
          title={toggleTitle}
          aria-label={toggleAriaLabel}
          aria-expanded={railOpen}
          data-rail-toggle
          data-rail-hint={waiting > 0 ? 'needs-you' : state.busy || runningTasks > 0 ? 'running' : undefined}
          className={`relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-1.5 transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 lg:min-w-8 @[480px]/center:px-2 ${
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
            <span data-rail-toggle-badge className="text-[12px] leading-[18px] font-normal text-accent-ink tabular-nums" aria-label={tp('inspector.waiting', waiting)} title={tp('inspector.waiting', waiting)}>
              {waiting}
            </span>
          ) : state.busy || runningTasks > 0 ? (
            <span data-rail-toggle-running className="flex items-center gap-1 text-[12px] text-ink-soft" title={runningTasks > 0 ? tp('inspector.tasks', runningTasks) : t('inspector.running')}>
              <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-ink-soft" />
              {runningTasks > 0 ? <span className="tabular-nums">{runningTasks}</span> : null}
            </span>
          ) : null}
        </button>
        );
      })() : null}
    </WorkspaceHeader>
  );
});

/**
 * Session title + cwd. The title renames in place (Enter commits, Esc
 * reverts, blur commits) through the same profile patch the sidebar's
 * dialog uses; the cwd beside it is quiet text, not a control — clicking it
 * opens the rail when that surface is available, which is where the rest of
 * that context lives.
 */
function stripLeadingPersonaPrefix(title: string, prefix: string | undefined): string {
  const cleanPrefix = prefix?.trim();
  if (cleanPrefix === undefined || cleanPrefix === '') return title;
  const trimmed = title.trimStart();
  if (!trimmed.startsWith(cleanPrefix)) return title;
  const rest = trimmed.slice(cleanPrefix.length);
  const sepMatch = /^[\s·—–\-:：/|]+/.exec(rest);
  if (sepMatch === null) return title;
  const stripped = rest.slice(sepMatch[0].length).trimStart();
  return stripped !== '' ? stripped : title;
}

export function SessionTitle({
  title,
  stripPrefix,
  cwd,
  worktree,
  promotedFrom,
  forkOrigin,
  editing,
  onEditingChange,
  onRename,
  onOpenRail,
}: {
  title: string;
  stripPrefix?: string;
  cwd: string | undefined;
  /** Present only for a session running in a Kiki-managed worktree. */
  worktree?: Session['worktree'];
  /** Present only for a thread opened from a subagent. */
  promotedFrom?: Session['promoted_from'];
  /** Present only for a session forked from an earlier conversation. */
  forkOrigin?: ForkOriginSummary;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Rejects when the rename did not land; the caller has already reported why. */
  onRename: (title: string) => Promise<void>;
  onOpenRail?: () => void;
}) {
  const { t } = useI18n();
  // The committed name shows at once: the list refetch that brings it back
  // as `title` waits on the patch, and the old name used to flash back in
  // between. It retires when the authoritative title changes or the rename fails.
  const [renamed, setRenamed] = useState<{ readonly from: string; readonly to: string } | undefined>(undefined);
  const renameSequence = useRef(0);
  const renameFlight = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    if (renamed !== undefined && title !== renamed.from) setRenamed(undefined);
  }, [title, renamed]);
  const current = renamed !== undefined && renamed.from === title ? renamed.to : title;
  const currentRef = useRef(current);
  currentRef.current = current;
  const [draft, setDraft] = useState(current);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the blur handler: Esc and a committed Enter both blur the input,
  // and neither should submit a second time.
  const settledRef = useRef(false);

  // Seeded once per edit: a title that lands while the user types (the
  // auto-title of a fresh session) must not replace the draft and select it.
  useEffect(() => {
    if (!editing) return;
    settledRef.current = false;
    setDraft(currentRef.current);
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [editing]);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    onEditingChange(false);
    if (next === '' || next === current) return;
    const sequence = ++renameSequence.current;
    const attempt = { from: title, to: next };
    setRenamed(attempt);
    const submit = () => sequence !== renameSequence.current ? Promise.resolve() : onRename(next).catch(() => {
      if (renameSequence.current === sequence) setRenamed((value) => (value === attempt ? undefined : value));
    });
    const flight = renameFlight.current === undefined ? submit() : renameFlight.current.then(submit);
    renameFlight.current = flight;
    void flight.then(() => { if (renameFlight.current === flight) renameFlight.current = undefined; });
  };

  const displaySource = current !== '' ? stripLeadingPersonaPrefix(current, stripPrefix) : t('sidebar.untitled');
  const shown = useThreadTitle(displaySource);
  // On a phone the title fills the top of the screen, where a stray tap would
  // open the rename field and its keyboard; there rename is the ⋯ menu's row.
  const phoneMode = usePhoneMode();
  // Title keeps its width; the cwd beside it yields first (shrink-[100]) so a
  // roomy header never truncates the name to make space for the path.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          data-session-rename-input
          aria-label={t('sv.renameAria')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={(event) => {
            // Enter / Escape that confirm or cancel an IME candidate belong to
            // the IME, not to the rename.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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
          className="min-w-0 max-w-md flex-1 rounded-md border border-hairline-strong bg-panel px-1.5 py-0.5 font-sans text-[13.5px] font-normal text-ink outline-none focus:border-accent"
        />
      ) : (
        <h1 className="-ml-1.5 min-w-0 max-w-full">
          {phoneMode ? (
            <span
              data-session-title
              className="block max-w-full truncate px-1.5 py-0.5 font-sans text-[13.5px] leading-5 font-normal text-ink"
            >
              {shown}
            </span>
          ) : (
            <button
              type="button"
              data-session-title
              onClick={() => { onEditingChange(true); }}
              title={t('sv.renameAria')}
              aria-label={`${shown} — ${t('sv.renameAria')}`}
              className="block max-w-full truncate rounded-md px-1.5 py-0.5 text-left font-sans text-[13.5px] leading-5 font-normal text-ink transition-colors hover:bg-canvas"
            >
              {shown}
            </button>
          )}
        </h1>
      )}
      {cwd !== undefined && cwd !== '' && !editing ? (
        onOpenRail !== undefined ? (
          <button
            type="button"
            data-session-cwd
            onClick={onOpenRail}
            title={cwd}
            className="hidden min-w-0 shrink-[100] truncate text-[12px] text-ink-faint transition-colors hover:text-ink-soft @[720px]/center:block"
          >
            {/* A worktree checkout path is Kiki's own; the project reads by its source. */}
            {shortCwd(worktree?.source_root ?? cwd)}
          </button>
        ) : (
          <span
            data-session-cwd
            title={cwd}
            className="hidden min-w-0 shrink-[100] truncate text-[12px] text-ink-faint @[720px]/center:block"
          >
            {/* A worktree checkout path is Kiki's own; the project reads by its source. */}
            {shortCwd(worktree?.source_root ?? cwd)}
          </span>
        )
      ) : null}
      {!editing ? <WorktreeMark worktree={worktree} className="hidden max-w-[8rem] shrink-[50] self-center @[560px]/center:inline-flex @[680px]/center:max-w-[12rem]" /> : null}
      {!editing ? <PromotedFromMark origin={promotedFrom} className="hidden max-w-[10rem] shrink-[60] self-center @[560px]/center:inline-flex @[680px]/center:max-w-[14rem]" /> : null}
      {!editing ? <ForkProvenanceMark origin={forkOrigin} className="hidden max-w-[12rem] shrink-[55] self-center @[560px]/center:inline-flex @[680px]/center:max-w-[16rem]" /> : null}
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
  sidebarBadge,
}: {
  sessionId: string | undefined;
  onToggleSidebar: () => void;
  sessions: readonly Session[];
  sidebarBadge?: SidebarBadge;
}) {
  const { spaceKey } = useConnection();
  return (
    <SessionView
      key={`${spaceKey}:${sessionId ?? ''}`}
      onToggleSidebar={onToggleSidebar}
      sessions={sessions}
      sidebarBadge={sidebarBadge}
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
  isPrivate = false,
  privateBusy = false,
  onTogglePrivate,
  onAction,
  onSideQuestion,
  onOpenBranch,
  onPromptDetails,
  onOpenOverview,
  freshContextAvailable = false,
  leading,
  canFork = true,
}: {
  /** False when the session's engine cannot fork; the row leaves the menu. */
  canFork?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onBeginRename: () => void;
  isPrivate?: boolean;
  privateBusy?: boolean;
  onTogglePrivate?: () => void;
  /**
   * Opens the session overview (the right rail) where the header has no
   * rail toggle of its own; the row is hidden without it.
   */
  onOpenOverview?: () => void;
  onAction: (action: 'fork' | 'undo' | 'compact' | 'export' | 'fresh-context') => void;
  /**
   * True once the conversation holds something to carry over: starts a fresh
   * context on the CURRENT model (the same-model fresh switch).
   */
  freshContextAvailable?: boolean;
  /** Opens a `/btw` side question beside the conversation; the row is hidden without it. */
  onSideQuestion?: () => void;
  /** Opens an in-session branch; the row is hidden without it. */
  onOpenBranch?: () => void;
  onPromptDetails?: () => void;
  /** Session-mode rows (view, delivery) above the actions; `close` dismisses the menu. */
  leading?: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const terminalChord = actionChordText('terminal-toggle', useShortcutState());
  const coarse = useCoarsePointer();
  // A phone keyboard has no Ctrl, Tab or arrows, so in phone mode the
  // terminal is offered only once this device opts in (Settings › General).
  // A panel that is already open keeps its row, so the menu can still close it.
  const phoneMode = usePhoneMode();
  // ActionSheet owns the back-history entry and Escape/scrim dismissal in phoneMode.
  useLayerHistory('session-actions-menu', open && coarse && !phoneMode, () => { setOpen(false); });
  const showTerminalOnPhone = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot).showTerminalOnPhone;
  const terminalOffered = terminalAvailable && (!phoneMode || showTerminalOnPhone || terminalOpen);

  useEffect(() => {
    if (!open || phoneMode) return;
    const unregister = registerOverlay('session-actions-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        (event.target.closest('[data-session-actions]') === null &&
          event.target.closest('[data-session-actions-menu]') === null)
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
  }, [open, phoneMode]);

  const itemClass =
    'flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper pointer-coarse:h-11';
  const sheetItemClass =
    'flex w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper';
  const pick = (action: 'fork' | 'undo' | 'compact' | 'export' | 'fresh-context') => {
    setOpen(false);
    onAction(action);
  };
  return (
    <div className="relative shrink-0" data-session-actions>
      <button
        ref={triggerRef}
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
      {open && phoneMode ? (
        <ActionSheet
          ariaLabel={t('sv.actionsAria')}
          overlayId="session-actions-menu"
          dataAttribute="data-session-actions-sheet"
          onClose={() => { setOpen(false); }}
        >
          {leading !== undefined ? (
            <>
              {leading(() => { setOpen(false); })}
              <div className="my-1 h-px bg-hairline" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={sheetItemClass}
            data-session-rename
            onClick={() => {
              setOpen(false);
              onBeginRename();
            }}
          >
            {t('menu.rename')}
          </button>
          {onTogglePrivate !== undefined ? (
            <button
              type="button"
              role="menuitem"
              disabled={privateBusy}
              className={`${sheetItemClass} disabled:cursor-default disabled:opacity-50`}
              data-session-private
              onClick={() => {
                setOpen(false);
                onTogglePrivate();
              }}
            >
              {t(isPrivate ? 'private.exitPrivate' : 'private.makePrivate')}
            </button>
          ) : null}
          {onOpenOverview !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className={sheetItemClass}
              data-session-overview-open
              onClick={() => { setOpen(false); onOpenOverview(); }}
            >
              {t('inspector.overview')}
            </button>
          ) : null}
          {onOpenBranch !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-open-branch
              className={sheetItemClass}
              onClick={() => {
                setOpen(false);
                onOpenBranch();
              }}
            >
              {t('menu.branch')}
            </button>
          ) : null}
          {onSideQuestion !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-side-question
              className={sheetItemClass}
              onClick={() => {
                setOpen(false);
                onSideQuestion();
              }}
            >
              {t('menu.sideQuestion')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-session-find
            className={sheetItemClass}
            onClick={() => {
              const returnFocus = triggerRef.current;
              setOpen(false);
              activeFindHost(returnFocus)?.open({ returnFocus });
            }}
          >
            {t('find.aria')}
          </button>
          <div className="my-1 h-px bg-hairline" />
          <button type="button" role="menuitem" className={sheetItemClass} onClick={() => { pick('compact'); }}>
            {t('menu.compact')}
          </button>
          {freshContextAvailable ? (
            <button
              type="button"
              role="menuitem"
              data-session-fresh-context
              className={sheetItemClass}
              onClick={() => { pick('fresh-context'); }}
            >
              {t('modelSwitch.menuFreshContext')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`${sheetItemClass} text-danger hover:bg-danger/10`}
            onClick={() => { pick('undo'); }}
          >
            {t('menu.undo')}
          </button>
          <div className="my-1 h-px bg-hairline" />
          {canFork ? (
            <button type="button" role="menuitem" className={sheetItemClass} onClick={() => { pick('fork'); }}>
              {t('menu.fork')}
            </button>
          ) : null}
          <button type="button" role="menuitem" className={sheetItemClass} onClick={() => { pick('export'); }}>
            {t('menu.export')}
          </button>
          {onPromptDetails !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className={sheetItemClass}
              data-prompt-details-open
              onClick={() => { setOpen(false); onPromptDetails(); }}
            >
              {t('agentPanel.prompt.title')}
            </button>
          ) : null}
          {terminalOffered ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={terminalOpen}
              data-terminal-toggle
              className={sheetItemClass}
              onClick={() => {
                setOpen(false);
                onToggleTerminal();
              }}
            >
              <span>{t('term.menuItem')}</span>
            </button>
          ) : null}
        </ActionSheet>
      ) : open ? (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) return;
            if (eventDetails.reason === 'escape-key') {
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            eventDetails.cancel();
          }}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
            >
              <Popover.Popup
                role="menu"
                data-session-actions-menu
                initialFocus={false}
                finalFocus={false}
                className={`anim-enter w-56 p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
          {leading !== undefined ? (
            <>
              {leading(() => { setOpen(false); })}
              <div className="my-1 h-px bg-hairline" />
            </>
          ) : null}
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
          {onTogglePrivate !== undefined ? (
            <button
              type="button"
              role="menuitem"
              disabled={privateBusy}
              className={`${itemClass} disabled:cursor-default disabled:opacity-50`}
              data-session-private
              onClick={() => {
                setOpen(false);
                onTogglePrivate();
              }}
            >
              {t(isPrivate ? 'private.exitPrivate' : 'private.makePrivate')}
            </button>
          ) : null}
          {onPromptDetails !== undefined ? <button type="button" role="menuitem" className={itemClass} data-prompt-details-open
            onClick={() => { setOpen(false); onPromptDetails(); }}>{t('agentPanel.prompt.title')}</button> : null}
          {onOpenOverview !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              data-session-overview-open
              onClick={() => { setOpen(false); onOpenOverview(); }}
            >
              {t('inspector.overview')}
            </button>
          ) : null}
          {terminalOffered ? (
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
              <span>{t('term.menuItem')}</span>
              {terminalChord !== undefined ? <span className="text-[12px] text-ink-faint pointer-coarse:hidden">{terminalChord}</span> : null}
            </button>
          ) : null}
          <div className="my-1 h-px bg-hairline" />
          {onOpenBranch !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-open-branch
              className={`${itemClass} flex items-center justify-between gap-3`}
              onClick={() => {
                setOpen(false);
                onOpenBranch();
              }}
            >
              <span>{t('menu.branch')}</span>
              <span className="font-mono text-[12px] text-ink-faint">/branch</span>
            </button>
          ) : null}
          {onSideQuestion !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-side-question
              className={`${itemClass} flex items-center justify-between gap-3`}
              onClick={() => {
                setOpen(false);
                onSideQuestion();
              }}
            >
              <span>{t('menu.sideQuestion')}</span>
              <span className="font-mono text-[12px] text-ink-faint">/btw</span>
            </button>
          ) : null}
          {canFork ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('fork'); }}>
              {t('menu.fork')}
            </button>
          ) : null}
          <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('export'); }}>
            {t('menu.export')}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={() => { pick('compact'); }}>
            {t('menu.compact')}
          </button>
          {freshContextAvailable ? (
            <button
              type="button"
              role="menuitem"
              data-session-fresh-context
              className={itemClass}
              onClick={() => { pick('fresh-context'); }}
            >
              {t('modelSwitch.menuFreshContext')}
            </button>
          ) : null}
          {/* Undo rewrites the conversation, so it sits apart from the safe
              metadata actions above and reads as danger before any hover. */}
          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} text-danger hover:bg-danger/10`}
            onClick={() => { pick('undo'); }}
          >
            {t('menu.undo')}
          </button>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}
const emptyView = createViewState('');
const emptyState = () => emptyView;
const EMPTY_TRAY_AGENT_NAMES: ReadonlyMap<string, string> = new Map();

type ModelSource = ComposerModelSource;

/** How long the not-found card stays before /s/:id falls back home. */
export const NOT_FOUND_FALLBACK_MS = 3000;

/** True when `pathname` is this session or one of its child routes (local or `/p/:connectionId`). */
export function sessionRouteOwnsSession(pathname: string, sessionId: string): boolean {
  const normalized = stripPlacePrefix(pathname);
  const prefix = `/s/${sessionId}`;
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

/** Leave for /new only when this session is definitely gone, the route is still its own, and no loaded roster row carries it. */
export function sessionAbsenceShouldLeaveRoute(message: string, sessionId: string, pathname: string, stillListed = false): boolean {
  return !stillListed && isSessionNotFoundMessage(message) && sessionRouteOwnsSession(pathname, sessionId);
}

/**
 * Permission/plan pills are controlled by the server-reported store
 * fields (snapshot agent_config + `agent.status.updated`): another client —
 * or the server itself — can move them. The local override is only an
 * optimistic echo: a local pick wins until its save settles and the store
 * reports the same value, then `shouldClearModeOverride` retires it.
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

/**
 * A shell snapshot is enough to send once its operation lease has settled;
 * transcript seed is independent presentation work.
 */
export function resolveSessionSendReady(input: {
  /** A controller exists and can submit the durable prompt command. */
  controllerAvailable: boolean;
  leaseReady: boolean;
  loaded: boolean;
  loadError?: string;
  resyncing: boolean;
  resyncFailed: boolean;
}): boolean {
  // Transcript/history readiness is presentation work. Once the session
  // controller is admitted, the prompt command is the independent durable
  // enqueue boundary; do not hold the send button behind snapshot, forest,
  // model-catalog, or ordered-view readiness.
  return input.controllerAvailable;
}

/** Session-operation reads start once the mounted controller can serve them. */
export function resolveComposerContext(state: SessionViewState, nativeCatalogLimit?: number) {
  const usage = state.session?.usage;
  const used = state.contextTokens ?? ((usage?.context_tokens ?? 0) > 0 ||
    (usage?.turn_count === 0 && state.blocks.length === 0) ? usage?.context_tokens : undefined);
  const limit = state.maxContextTokens === 0 ? undefined : [state.maxContextTokens, usage?.context_limit, nativeCatalogLimit]
    .find((value): value is number => value !== undefined && value > 0);
  return { used, limit };
}

export function sessionIdForSendReadyRead(sessionId: string | undefined, sendReady: boolean): string | undefined {
  return sendReady ? sessionId : undefined;
}

export function initialBindingStillPending(input: {
  expectedModel?: string;
  expectedThinking?: string;
  modelOverride?: string;
  effortOverride?: string;
  boundModel?: string;
  boundThinking?: string;
}): boolean {
  return input.expectedModel !== undefined && input.modelOverride === input.expectedModel && input.boundModel !== input.expectedModel
    || input.expectedThinking !== undefined && input.effortOverride === input.expectedThinking && input.boundThinking !== input.expectedThinking;
}

interface SessionCreateHandoff {
  readonly initialPromptId?: string;
  readonly initialPrompt?: string;
  readonly initialPresentation?: import('@kiki/transcript').TextPresentation;
  readonly initialAttachments?: readonly ComposerAttachment[];
  readonly initialSkill?: DraftSkillHandoff;
  readonly initialSkills?: readonly PromptSkillActivation[];
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly goalObjective?: string;
  readonly ephemeral?: boolean;
  /** The first message answers the persona's local greeting (see NewSessionDraft). */
  readonly personaGreetingReply?: boolean;
}

export type SessionCreateSubmission =
  | {
      readonly kind: 'prompt';
      readonly text: string;
      readonly presentation?: import('@kiki/transcript').TextPresentation;
      readonly attachments: readonly ComposerAttachment[];
      readonly skills?: readonly PromptSkillActivation[];
      readonly goalObjective?: string;
      readonly personaGreetingReply?: boolean;
    }
  | {
      readonly kind: 'skill';
      readonly name: string;
      readonly args: string;
      readonly attachments: readonly ComposerAttachment[];
      readonly userInput?: string;
      readonly goalObjective?: string;
    };

function isPromptSkillActivationList(value: unknown): value is readonly PromptSkillActivation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        (entry as { name: string }).name !== '',
    )
  );
}

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
    initialPromptId: typeof raw.initialPromptId === 'string' ? raw.initialPromptId : undefined,
    initialPrompt: typeof raw.initialPrompt === 'string' ? raw.initialPrompt : undefined,
    initialPresentation: readTextPresentation(raw.initialPresentation),
    initialAttachments: Array.isArray(raw.initialAttachments) ? raw.initialAttachments : undefined,
    initialSkill: isDraftSkillHandoff(raw.initialSkill) ? raw.initialSkill : undefined,
    initialSkills: isPromptSkillActivationList(raw.initialSkills) ? raw.initialSkills : undefined,
    model: raw.model,
    thinking: raw.thinking,
    permissionMode: raw.permissionMode,
    planMode: raw.planMode,
    goalObjective: raw.goalObjective,
    ephemeral: typeof raw.ephemeral === 'boolean' ? raw.ephemeral : undefined,
    personaGreetingReply: raw.personaGreetingReply === true ? true : undefined,
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
      userInput: handoff.initialSkill.userInput,
      goalObjective: handoff.goalObjective,
    };
  }
  if (handoff.initialPrompt === undefined) return undefined;
  return {
    kind: 'prompt',
    text: handoff.initialPrompt,
    presentation: handoff.initialPresentation,
    attachments: handoff.initialAttachments ?? [],
    skills: handoff.initialSkills,
    goalObjective: handoff.goalObjective,
    ...(handoff.personaGreetingReply === true ? { personaGreetingReply: true } : {}),
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
 * own pins apply unless the corresponding control is explicitly selected.
 */
export function sessionHasStartedConversation(blocks: readonly Block[]): boolean {
  return blocks.some((block) => block.kind === 'user');
}

/**
 * Whether a picked engine counts as a pending switch. A pick restored from
 * the /new draft before the first message is the session's own creation-time
 * binding: the server resolved it with defaults the draft never named, so an
 * identity comparison with the live binding would read a false switch (the
 * chip "… · next message" without the user touching anything). Before the
 * conversation starts the pick simply is the binding.
 */
export function executionPickIsPending(
  pendingExecution: ExecutionChoice | undefined,
  boundExecution: ExecutionChoice,
  conversationStarted: boolean,
): boolean {
  if (pendingExecution === undefined) return false;
  if (!conversationStarted) return false;
  return !sameExecutionChoice(pendingExecution, boundExecution);
}

export function sessionAgentProfileWorkspaceId(session: Session | undefined): string | undefined {
  return session?.workspace_id;
}

export function resolveProfileSwitchSubmission(input: {
  pendingProfile: string | undefined;
  boundProfile: string;
  /**
   * Whether the user moved the model, and whether they moved the effort. These
   * are tracked per control because a pick in one says nothing about the other:
   * only the control that was actually chosen may be promoted into an override.
   * Required rather than defaulted, so a caller cannot inherit one control's
   * touch by forgetting the other.
   */
  modelTouched: boolean;
  effortTouched: boolean;
  model: string | undefined;
  thinking: string | undefined;
  /**
   * Whether the user moved the approval mode for this message. A run the user
   * asked to be *bare* must not be handed an approval mode they did not pick:
   * on the execution path the legacy `permission_mode` is a session override,
   * so sending Kiki's current mode would decide approvals for a harness whose
   * own policy they meant to keep.
   */
  permissionTouched?: boolean;
  /** Absent when this caller never deals in approvals; nothing is then sent. */
  permissionMode?: PermissionMode;
  /** A confirmed engine pick; sent only while it differs from the bound one. */
  pendingExecution?: ExecutionChoice | undefined;
  boundExecution?: ExecutionChoice | undefined;
}): {
  profile?: string;
  execution?: ReturnType<typeof executionSelectionOf>;
  model?: string;
  thinking?: string | null;
  permissionMode?: PermissionMode;
} {
  const executionSwitching = input.pendingExecution !== undefined
    && !sameExecutionChoice(input.pendingExecution, input.boundExecution);
  // The execution that governs THIS message: the confirmed pick when one is
  // waiting, otherwise the session's own binding — a session already running a
  // bare harness must keep withholding Kiki's controls on later messages too,
  // not only on the message that switched.
  const governing = executionSwitching ? input.pendingExecution : input.boundExecution;
  // Displayed bindings are inherited, not message overrides. Carry only the
  // control the user picked, on continuations as well as binding switches.
  // A confirmed switch that names a control owns that value, so a stale touch
  // must not overwrite it. Effort on the engine already bound is the update
  // itself: send it even when the live selection stored the previous effort.
  // An empty string is the default capsule: null drops the user pin. Omitting
  // the field keeps the current override.
  const sendModel = input.modelTouched && !(executionSwitching && namesLegacyControl(input.pendingExecution, 'model'));
  const incomingOwnsThinking = executionSwitching && namesLegacyControl(input.pendingExecution, 'thinking');
  const clearThinking = input.effortTouched && input.thinking === '' && !incomingOwnsThinking;
  const sendThinking = input.effortTouched
    && typeof input.thinking === 'string'
    && input.thinking !== ''
    && !incomingOwnsThinking;
  const sendPermission = sendsLegacyControl(governing, 'permission_mode', input.permissionTouched === true);
  return {
    ...(input.pendingProfile !== undefined && input.pendingProfile !== input.boundProfile
      ? { profile: input.pendingProfile }
      : {}),
    ...(executionSwitching ? { execution: executionSelectionOf(input.pendingExecution!) } : {}),
    model: sendModel ? input.model : undefined,
    thinking: clearThinking ? null : (sendThinking ? input.thinking : undefined),
    permissionMode: sendPermission ? input.permissionMode : undefined,
  };
}

export function resolveControlledSkillSubmission(input: Parameters<typeof resolveProfileSwitchSubmission>[0] & {
  name: string;
  args: string;
  userInput: string;
  attachments: readonly ComposerAttachment[];
  modelSwitchMode?: ModelSwitchMode;
}): PromptSubmission | undefined {
  const controls = resolveProfileSwitchSubmission(input);
  if (!input.modelTouched && !input.effortTouched && input.permissionTouched !== true &&
    controls.profile === undefined && controls.execution === undefined) return undefined;
  const content = buildPromptContent(input.userInput, input.attachments);
  if (content === null) return undefined;
  return {
    content,
    skills: [{ name: input.name, args: input.args === '' ? undefined : input.args }],
    profile: controls.profile,
    execution: controls.execution,
    model: controls.model,
    thinking: controls.thinking,
    model_switch_mode: input.modelTouched && controls.profile === undefined && controls.execution === undefined ? input.modelSwitchMode : undefined,
    permission_mode: controls.permissionMode,
  };
}

export function captureSkillRequest<T extends object>(request: T): T & { prompt_id: string } {
  return { ...structuredClone(request), prompt_id: randomUuid() };
}

type SkillControlSelection = Pick<ReturnType<typeof readComposerState>, 'modelOverride' | 'effortOverride' | 'modelChoice' | 'effortChoice' | 'modelSwitchMode'> & {
  readonly pendingProfile?: string;
  readonly pendingExecution?: ExecutionChoice;
  readonly permissionOverride?: PermissionMode;
};

export function skillControlSelectionKey(input: SkillControlSelection): string {
  const { pendingProfile, pendingExecution, modelOverride, effortOverride, modelChoice, effortChoice, modelSwitchMode, permissionOverride } = input;
  return JSON.stringify({ pendingProfile, pendingExecution, modelOverride, effortOverride, modelChoice, effortChoice, modelSwitchMode, permissionOverride });
}

export function completeSkillControlSelection(input: {
  readonly controlled: import('@kiki/protocol').PromptSubmission;
  readonly capturedSelection: string;
  readonly currentSelection: string;
  readonly clear: () => void;
  readonly refresh: () => void;
  readonly binding?: ComposerModelChoice;
  readonly preserveBindingChange?: (change: ComposerModelBindingChange) => void;
}): void {
  if (input.controlled.profile !== undefined || input.controlled.execution !== undefined ||
    input.controlled.model !== undefined || input.controlled.thinking !== undefined) {
    if (input.currentSelection === input.capturedSelection) input.clear();
    else if (input.binding !== undefined && input.controlled.profile === undefined && input.controlled.execution === undefined) {
      input.preserveBindingChange?.({ previous: input.binding,
        next: { model: input.controlled.model ?? input.binding.model, thinking: input.controlled.thinking ?? input.binding.thinking } });
    }
    input.refresh();
  }
}

/**
 * How a pending engine switch names itself in the confirmation: the engine's
 * catalog label where one is known, the raw id otherwise. A switch to the
 * native engine is named "Kiki" like every other place that shows it.
 */
export function executionSwitchName(
  choice: ExecutionChoice | undefined,
  labels: Readonly<Record<string, string>>,
): string {
  if (choice === undefined) return '';
  if (choice.executor === 'native') return labels['__native'] ?? 'Kiki';
  return labels[choice.executor] ?? choice.executor;
}

/** Executor and profile identity, ignoring model/effort overrides. */
function sameExecutionIdentity(left: ExecutionChoice | undefined, right: ExecutionChoice | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.executor === right.executor && left.profile === right.profile
    && left.profile_file === right.profile_file && left.external_connection_id === right.external_connection_id;
}

function PromptRecordsRemainder({ continuation }: { readonly continuation: NonNullable<Parameters<typeof QueueStrip>[0]['promptContinuation']> }): ReactNode {
  const { t } = useI18n();
  const status = continuation.status?.status ?? 'idle';
  const label = status === 'error' ? t('queue.recordsFailed') : t('queue.records');
  return (
    <div data-prompt-records-remainder className="flex shrink-0 items-center">
      <button
        type="button"
        disabled={status === 'loading'}
        onClick={() => { continuation.onRequest(); }}
        title={label}
        aria-label={label}
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:opacity-50 ${
          status === 'error' ? 'text-danger' : 'text-ink-faint hover:text-ink'
        }`}
      >
        <Icon name="refresh" size={12} className={status === 'loading' ? 'spinner' : undefined} />
      </button>
    </div>
  );
}

/** Whether the server saved this prompt as a durable ingress record for the given agent. */
function hasDurableRecord(
  controller: Pick<SessionController, 'getDurableIngress'>,
  promptId: string,
  agentId = MAIN_AGENT_ID,
): boolean {
  return (controller.getDurableIngress?.() ?? []).some(
    (item) => item.prompt_id === promptId && (item.agent_id ?? MAIN_AGENT_ID) === agentId,
  );
}


export { restoreSentAnnotations };

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
 * refused. Transport-source failures and timeouts prove nothing about the
 * pick: keep the selection (and the draft) so the user can retry deliberately;
 * nothing is resent automatically.
 */
export function shouldClearPendingProfileOnSendError(error: unknown): boolean {
  return error instanceof ApiError && !isUnconfirmedTransportError(error) && error.code !== API_CODES.TIMEOUT;
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

/** Which saved approval chord (`y` / `n` unless remapped) the press matches. */
export function approvalShortcutDecision(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): 'approved' | 'rejected' | null {
  const keyEvent = {
    key: event.key,
    ctrlKey: event.ctrlKey ?? false,
    metaKey: event.metaKey ?? false,
    shiftKey: event.shiftKey ?? false,
    altKey: event.altKey ?? false,
  };
  if (matchesShortcutAction(keyEvent, 'approve')) return 'approved';
  if (matchesShortcutAction(keyEvent, 'reject')) return 'rejected';
  return null;
}

/** Approval chords must not fire while a dialog, overlay, or popover owns the keyboard. */
export function shouldHandleApprovalShortcut(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  overlayOpen: boolean;
  inEditable: boolean;
}): boolean {
  if (input.overlayOpen || input.inEditable) return false;
  return approvalShortcutDecision(input) !== null;
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
 * Escape in a text field — an input, a select, a textarea, or a contenteditable
 * surface, which includes the composer's editor — belongs to that field. It
 * never stops the running turn.
 */
export function isFormFieldEscapeTarget(target: EventTarget | null): boolean {
  if (target === null || typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' ||
    target.isContentEditable === true;
}

/**
 * Session Escape, in order: an open overlay, then the focused PTY, own the key;
 * then an open terminal panel or rail closes; only then does the turn stop.
 * The closer and the abort are two window listeners whose order changes as
 * their effects re-run, so each one checks the full order itself: the abort
 * stands down whenever there is chrome to close, and the closer acts only then.
 *
 * `railOpen` here means the rail as a layer over the conversation (narrow
 * screens). The docked rail on a wide screen is part of the layout, open by
 * default and remembered once closed — Escape passing through it would hide
 * the panel for every session when the user meant "stop".
 */
export function shouldCloseSessionChromeOnEscape(input: {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  terminalFocused: boolean;
  terminalOpen: boolean;
  railOpen: boolean;
}): boolean {
  if (input.key !== 'Escape') return false;
  if (input.defaultPrevented || input.overlayOpen || input.terminalFocused) return false;
  return input.terminalOpen || input.railOpen;
}

export function shouldHandleGlobalAbortOnEscape(input: {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  terminalFocused: boolean;
  terminalOpen: boolean;
  railOpen: boolean;
  inFormField: boolean;
  fullscreenPreviewOpen?: boolean;
}): boolean {
  if (input.key !== 'Escape') return false;
  return !input.defaultPrevented && !input.overlayOpen && !input.terminalFocused &&
    !input.terminalOpen && !input.railOpen && !input.inFormField && !input.fullscreenPreviewOpen;
}

/**
 * Stop is pending from the press until the abort settles, or until the turn
 * ends on its own, whichever is first: the abort waits on a request and a
 * refresh, and without this the button did nothing visible on a slow link and
 * invited a second press. `busy` ending always clears it, so Stop is never
 * left disabled.
 */
export function useAbortPending(busy: boolean): readonly [boolean, (abort: Promise<unknown>) => void] {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!busy) setPending(false);
  }, [busy]);
  const track = useCallback((abort: Promise<unknown>) => {
    setPending(true);
    const settle = () => { setPending(false); };
    void abort.then(settle, settle);
  }, []);
  return [pending, track] as const;
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

export function agentDetailPath(sessionId: string, agentId: string, connectionId?: string | null): string {
  return `${placeRoutePrefix(connectionId)}/s/${sessionId}/agent/${encodeURIComponent(agentId)}`;
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
  useLayoutEffect(() => {
    onFocusedAgent(focused);
  }, [focused, onFocusedAgent]);
  return null;
}

/**
 * The session's one screen-reader announcer, mounted by exactly one of the two
 * mutually exclusive view branches (agent workspace / main session) so the
 * same state machine never double-mounts. Priority: a pending approval or
 * question always wins (it waits on the user); while busy, a growing queue is
 * named alongside the working state so sending-into-queue is confirmed;
 * idle and empty stays silent. The text is a pure function of these three
 * props — no timers or relative time, so a re-render of unchanged state can
 * never re-announce.
 */
function SessionAnnouncer({
  pendingInteraction,
  busy,
  queuedItemCount,
}: {
  readonly pendingInteraction: SessionPendingInteraction;
  readonly busy: boolean;
  readonly queuedItemCount: number;
}) {
  const { t, tp } = useI18n();
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-session-announcer="">
      {pendingInteraction === 'approval'
        ? t('sv.ariaAwaitingApproval')
        : pendingInteraction === 'question'
          ? t('sv.ariaAwaitingAnswer')
          : busy
            ? queuedItemCount > 0
              ? `${t('sv.ariaWorking')} · ${tp('composer.queueStack.count', queuedItemCount)}`
              : t('sv.ariaWorking')
            : ''}
    </div>
  );
}

export function SessionView({
  onToggleSidebar,
  sessions,
  sidebarBadge,
}: {
  onToggleSidebar: () => void;
  /** Polled session records owned by App (page-1 polling there). */
  sessions: readonly Session[];
  sidebarBadge?: SidebarBadge;
}) {
  const host = useHost();
  const { id } = useParams<{ id: string }>();
  const sessionId = id!;
  const { client, socket, meta, wsStatus, scopeId, connectionId } = useConnection();
  const { slots, previewPresentation } = useConversationShell();
  const terminalAvailable = terminalCapabilityAvailable(meta.capabilities);
  const { t, tp, locale } = useI18n();
  const navigate = useNavigate();
  // Explicit in-page jumps ("在时间线中查看", 派发处, a note's passage) are
  // visits of their own, so the return arrow can undo them; plain scrolling,
  // find and filter changes never come through here.
  const navigateTimeline = useTimelineNavigation();
  const location = useLocation();
  const sessionPathRef = useRef(location.pathname);
  sessionPathRef.current = location.pathname;
  const localAgentMatch = useMatch('/s/:id/agent/:agentId');
  const placeAgentMatch = useMatch('/p/:connectionId/s/:id/agent/:agentId');
  const selectedAgentId = placeAgentMatch?.params.agentId ?? localAgentMatch?.params.agentId;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const rebuildOwner = useMemo(() => ({}), [client, scopeId, meta.server_id, meta.started_at, sessionId]);
  const rebuildOwnerRef = useRef(rebuildOwner);
  rebuildOwnerRef.current = rebuildOwner;
  // Throttle for the ambiguous y/n hint (epoch ms of the last toast).
  const lastAmbiguityToastRef = useRef(0);
  const firstMessageRef = useRef<FirstSessionMessageRecord | undefined>(readFirstSessionMessage(scopeId, sessionId));
  const createHandoff = parseSessionCreateHandoff(firstMessageRef.current?.message ?? location.state);
  // Deep-link locators: /s/{id}?turn=N (search hits, the /usage drilldown)
  // and ?block={blockId} go through the timeline's one locate entry, which
  // pages older history in, opens folds, and says so when the place is gone.
  const locatorParams = new URLSearchParams(location.search);
  const turnLocator = locatorParams.get('turn');
  const stepLocator = locatorParams.get('step');
  const queryLocator = locatorParams.get('q');
  const blockLocator = locatorParams.get('block');
  const interactionLocator = locatorParams.get('interaction');
  const navVisitId = useNavVisitId();
  useEffect(() => {
    if (turnLocator === null && blockLocator === null && interactionLocator === null) return;
    // Returning to a visit with an old ?turn/?block URL restores where the
    // reader actually was; the URL's first-entry target must not re-claim it.
    if (navVisitId !== null &&
      getReadingSnapshot(navVisitId, timelineSnapshotKey(sessionId, selectedAgentIdRef.current ?? MAIN_AGENT_ID)) !== undefined) return;
    const target = interactionLocator !== null
      ? { kind: 'interaction' as const, id: interactionLocator }
      : blockLocator !== null ? { kind: 'block' as const, blockId: blockLocator }
        : { kind: 'turn' as const, turnId: normalizeTurnId(turnLocator!) };
    if (target.kind === 'turn' && (stepLocator !== null || queryLocator !== null)) {
      registerTurnLocateHint(sessionId, selectedAgentId ?? MAIN_AGENT_ID, target.turnId, {
        stepId: stepLocator ?? undefined,
        query: queryLocator ?? undefined,
      });
    }
    const controller = new AbortController();
    void locateInTimeline(target, { sessionId, agentId: selectedAgentId, signal: controller.signal });
    return () => { controller.abort(); };
  }, [turnLocator, stepLocator, queryLocator, blockLocator, interactionLocator, sessionId, selectedAgentId, navVisitId]);
  const initialPromptRef = useRef(createHandoff.initialPrompt);
  const initialSkillRef = useRef(createHandoff.initialSkill);
  const hadInitialHandoffRef = useRef(
    createHandoff.initialPrompt !== undefined || createHandoff.initialSkill !== undefined,
  );
  const seatReachedActiveRef = useRef(hadInitialHandoffRef.current);
  const initialOptionsRef = useRef(createHandoff);
  const defaults = useMemo(() => readSettings(), []);
  // Composer chrome captured the last time this session was open (memory
  // only): attachment chips and pill overrides restore instead of vanishing
  // on every session switch. The /new hand-off state wins on first mount.
  const restoredComposer = useMemo(() => readComposerState(sessionId), [sessionId]);
  // Whether the user moved the approval mode for this session's messages, as
  // opposed to the mode merely being the session's current value. A bare
  // external engine is run as it is, so an untouched mode is not sent.
  const permissionTouchedRef = useRef(false);
  const isNarrowScreen = useMediaQuery('(max-width: 1023px)');
  const isPreviewPriorityBand = useMediaQuery('(min-width: 1024px) and (max-width: 1599px)');

  // The inline rail (lg and up) keeps the user's last open/closed choice in
  // the layout preferences, like the sidebar's collapse and the rail's width:
  // this view is keyed per session, so local state reset it on every switch.
  // Until the user picks, the Settings default decides.
  const layoutPrefs = useLayoutPreferences();
  const userRailOpen = layoutPrefs.railOpen ?? defaults.railOpenByDefault;
  // Below lg the rail is an overlay layer (full-screen on a phone): it opens
  // only from an explicit toggle this visit, never from the saved default —
  // a deep link must land on the conversation, not under a drawer. The wide
  // preference is untouched, so widening the window restores the inline rail.
  const [narrowRailOpen, setNarrowRailOpen] = useState(false);

  const previewRef = useRef<MediaPreviewApi | null>(null);
  const previewOpen = previewPresentation?.open === true;
  const previewMaximized = previewPresentation?.maximized === true;
  // Maximized preview keeps the inspector as a row overlay. In the 1024–1599px
  // preview-priority band (including 1440px), Preview and Inspector share the
  // docked right secondary stage instead of cramping into four panes or
  // layering a scrim over the conversation.
  const maximizedRailYielded = !isNarrowScreen && previewMaximized;
  const priorityBandSwap = !isNarrowScreen && !previewMaximized && isPreviewPriorityBand;
  const dockedRailYielded = maximizedRailYielded || (priorityBandSwap && previewOpen);
  const railRegimeKey = isNarrowScreen
    ? 'narrow'
    : previewMaximized
      ? 'maximized'
      : 'docked';
  const [yieldedRailState, setYieldedRailState] = useState<{ regime: string; open: boolean }>({
    regime: railRegimeKey,
    open: false,
  });
  const [priorityRailActive, setPriorityRailActive] = useState(false);
  const [priorityRestorePreviewOnClose, setPriorityRestorePreviewOnClose] = useState(false);
  const prevPreviewOpenRef = useRef(previewOpen);
  useEffect(() => {
    const becameOpen = previewOpen && !prevPreviewOpenRef.current;
    prevPreviewOpenRef.current = previewOpen;
    if (!priorityBandSwap) {
      if (priorityRestorePreviewOnClose && !isNarrowScreen && !previewMaximized) {
        setPriorityRestorePreviewOnClose(false);
        setPriorityRailActive(false);
        const api = previewRef.current;
        if (api !== null && api.previewTabCount > 0 && !api.previewPanelOpen) {
          api.togglePreviewPanel?.();
        }
      } else if (priorityRailActive || priorityRestorePreviewOnClose) {
        setPriorityRailActive(false);
        setPriorityRestorePreviewOnClose(false);
      }
      return;
    }
    if (becameOpen && (priorityRailActive || priorityRestorePreviewOnClose)) {
      setPriorityRailActive(false);
      setPriorityRestorePreviewOnClose(false);
    }
  }, [priorityBandSwap, previewOpen, priorityRailActive, priorityRestorePreviewOnClose, isNarrowScreen, previewMaximized]);
  const yieldedRailOverlayOpen =
    maximizedRailYielded && yieldedRailState.regime === railRegimeKey && yieldedRailState.open;

  const railOpen = isNarrowScreen
    ? narrowRailOpen
    : maximizedRailYielded
      ? yieldedRailOverlayOpen
      : priorityBandSwap
        ? (previewOpen ? false : (priorityRailActive || userRailOpen))
        : userRailOpen;
  // The rail works at every width now (an overlay layer below lg), so its
  // entry points — the header toggle, the session title, the preview tab —
  // render unconditionally.
  const railAvailable = true;
  const toggleRail = useCallback(() => {
    // Wide, maximized-overlay, priority-band swap, and narrow remember
    // separately: transient swaps never corrupt layoutPrefs.railOpen.
    if (isNarrowScreen) {
      setNarrowRailOpen((value) => !value);
      return;
    }
    if (maximizedRailYielded) {
      setYieldedRailState((current) => ({
        regime: railRegimeKey,
        open: current.regime === railRegimeKey ? !current.open : true,
      }));
      return;
    }
    if (priorityBandSwap) {
      if (previewOpen) {
        previewRef.current?.togglePreviewPanel?.();
        setPriorityRailActive(true);
        setPriorityRestorePreviewOnClose(true);
        return;
      }
      if (priorityRestorePreviewOnClose) {
        setPriorityRailActive(false);
        setPriorityRestorePreviewOnClose(false);
        const api = previewRef.current;
        if (api !== null && api.previewTabCount > 0 && !api.previewPanelOpen) {
          api.togglePreviewPanel?.();
        }
        return;
      }
      if (priorityRailActive) {
        setPriorityRailActive(false);
        writeLayoutPreferences({ railOpen: false });
        return;
      }
    }
    writeLayoutPreferences({ railOpen: !userRailOpen });
  }, [
    isNarrowScreen,
    maximizedRailYielded,
    priorityBandSwap,
    previewOpen,
    priorityRestorePreviewOnClose,
    priorityRailActive,
    railRegimeKey,
    userRailOpen,
  ]);
  const closeRail = useCallback(() => {
    if (isNarrowScreen) {
      setNarrowRailOpen(false);
      return;
    }
    if (maximizedRailYielded) {
      setYieldedRailState({ regime: railRegimeKey, open: false });
      return;
    }
    if (priorityBandSwap && priorityRestorePreviewOnClose) {
      setPriorityRailActive(false);
      setPriorityRestorePreviewOnClose(false);
      const api = previewRef.current;
      if (api !== null && api.previewTabCount > 0 && !api.previewPanelOpen) {
        api.togglePreviewPanel?.();
      }
      return;
    }
    if (priorityRailActive) setPriorityRailActive(false);
    writeLayoutPreferences({ railOpen: false });
  }, [isNarrowScreen, maximizedRailYielded, priorityBandSwap, priorityRestorePreviewOnClose, priorityRailActive, railRegimeKey]);
  const ensureDockedRailOpen = useCallback(() => {
    setYieldedRailState({ regime: railRegimeKey, open: false });
    if (priorityBandSwap && previewOpen) {
      previewRef.current?.togglePreviewPanel?.();
      setPriorityRailActive(true);
      setPriorityRestorePreviewOnClose(true);
      return;
    }
    if (!userRailOpen) writeLayoutPreferences({ railOpen: true });
  }, [priorityBandSwap, previewOpen, railRegimeKey, userRailOpen]);
  // The phone's back closes the rail layer before route navigation. The
  // session shell's rail never opens below lg, so the layer only arms where
  // an open is possible — otherwise its unwinding `history.back()` would
  // consume the route itself on a narrow → wide hop.
  useLayerHistory('session-rail', narrowRailOpen && isNarrowScreen, closeRail);
  const railIsOverlay = isNarrowScreen || maximizedRailYielded;
  const overlayRailOpen = railIsOverlay && railOpen;
  const previewCoversMain = isNarrowScreen || previewMaximized;
  // Focused panel-tab agent: the active agent panel tab in the preview
  // workspace, reported up by the bridge below. This is the shared right
  // rail's owner when the user is looking at an embedded subagent view — the
  // routed agent page (selectedAgentId) owns the rail through AgentWorkspace.
  const [panelFocusAgent, setPanelFocusAgent] = useState<string | undefined>(undefined);
  const [permissionOverride, setPermissionOverride] = useState<PermissionMode | undefined>(
    restoredComposer.permissionMode ?? initialOptionsRef.current.permissionMode,
  );
  const [planOverride, setPlanOverride] = useState(
    restoredComposer.planMode ?? initialOptionsRef.current.planMode,
  );
  const modeWriteQueue = useRef(Promise.resolve());
  const modeWriteRevision = useRef({ permission: 0, plan: 0 });
  const [permissionWriting, setPermissionWriting] = useState(false);
  const [planWriting, setPlanWriting] = useState(false);
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
  // New-session choices use the catalog default only when no effort was picked.
  // Existing conversations reconcile restored choices with their committed binding below.
  const [effortOverride, setEffortOverride] = useState(
    restoredComposer.effortOverride ?? initialOptionsRef.current.thinking,
  );
  // Mid-session main-profile switch: the pick waits as `pendingProfile` until
  // the next prompt carries it. Model and effort remember separately whether
  // the user moved THAT control — one shared flag made an
  // effort pick promote the untouched model id along with it, and a model pick
  // promote the displayed effort (often `off`), which on the execution path is
  // a session override the engine would inherit (see resolveProfileSwitchSubmission).
  const [pendingProfile, setPendingProfile] = useState<string | undefined>(undefined);
  const [switchConfirmation, setSwitchConfirmation] = useState<
    | { readonly kind: 'execution'; readonly execution: ExecutionChoice }
    | { readonly kind: 'model'; readonly fromModel: string; readonly toModel: string; readonly initialMode: ModelSwitchMode;
        readonly matchedRuleId?: string; readonly editingOperationId?: string; readonly editingRevision?: number }
    | undefined
  >(undefined);
  const executionSwitchConfirm = switchConfirmation?.kind === 'execution' ? switchConfirmation.execution : undefined;
  const modelSwitchDialog = switchConfirmation?.kind === 'model' ? switchConfirmation : undefined;
  const setExecutionSwitchConfirm = useCallback((execution: ExecutionChoice | undefined) => {
    setSwitchConfirmation(execution === undefined ? undefined : { kind: 'execution', execution });
  }, []);
  const [modelChoice, setModelChoice] = useState(restoredComposer.modelChoice);
  const [effortChoice, setEffortChoice] = useState(restoredComposer.effortChoice);
  const [modelTouched, setModelTouched] = useState(restoredComposer.modelChoice !== undefined);
  const [effortTouched, setEffortTouched] = useState(restoredComposer.effortChoice !== undefined);
  const [modelSwitchMode, setModelSwitchMode] = useState(restoredComposer.modelSwitchMode);
  // Mid-session engine switch, same two-step contract as the profile one: the
  // confirmed pick waits as `pendingExecution` and the next prompt carries it,
  // which starts a fresh remote generation instead of steering the running
  // turn. Restored from composer chrome so a session switch keeps the pick.
  const [pendingExecution, setPendingExecution] = useState<ExecutionChoice | undefined>(
    restoredComposer.execution,
  );
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState<
    { decision: 'approved' | 'rejected'; ids: readonly string[] } | undefined
  >(undefined);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);
  // Queue edit round-trip: the queued text being edited lives in the composer;
  // `savedDraft`/`savedAnnotations` are what the composer held before the edit.
  const [queueEdit, setQueueEdit] = useState<{
    readonly promptId: string;
    readonly owner: string;
    readonly abort: AbortController;
    readonly loading: boolean;
    readonly loadError: boolean;
    readonly attachments: readonly ComposerAttachment[];
    readonly initialAttachments: readonly ComposerAttachment[];
    readonly initialBody: string;
    readonly savedDraft: string;
    readonly savedAnnotations: readonly SelectionAnnotation[];
    readonly original: { readonly text: string; readonly presentation?: import('@kiki/transcript').TextPresentation };
  } | null>(null);
  const queueEditRef = useRef(queueEdit);
  queueEditRef.current = queueEdit;
  const [pendingSubmission, setPendingSubmission] = useState<{
    id: string;
    agentId: string;
    text: string;
    content: MessageContent[];
    contentKey: string;
    submissionKey: string;
    createdAt: string;
    slow: boolean;
    preserved: boolean;
    retryable: boolean;
    status: 'sending' | 'offline' | 'server';
  } | undefined>();
  const pendingSubmissionRef = useRef(pendingSubmission);
  pendingSubmissionRef.current = pendingSubmission;
  const pendingRetryRef = useRef<{ readonly id: string; readonly run: () => void } | undefined>(undefined);
  const pendingRecoveryRef = useRef<{ readonly id: string; readonly restore: () => void } | undefined>(undefined);
  const pendingSendRef = useRef(false);
  useEffect(() => {
    if (pendingSubmission === undefined || pendingSubmission.slow) return;
    const timer = setTimeout(() => {
      setPendingSubmission((current) => current?.id === pendingSubmission.id
        ? { ...current, slow: true } : current);
    }, 10_000);
    return () => { clearTimeout(timer); };
  }, [pendingSubmission]);
  const focusComposer = useCallback(() => {
    // Return focus to main's own composer so co-resident child tabs cannot steal it.
    const composers = [...document.querySelectorAll<HTMLElement>('[data-composer]')];
    const target =
      composers.find((node) => node.dataset['composerAgent'] === MAIN_AGENT_ID && node.dataset['composerSession'] === sessionId) ??
      composers.find((node) => node.dataset['composerAgent'] === MAIN_AGENT_ID) ??
      composers[0];
    target?.focus();
  }, [sessionId]);

  const queryClient = useQueryClient();
  const cachedSessionRecord = useMemo(() => {
    const fromProp = sessions.find((item) => item.id === sessionId);
    if (fromProp !== undefined) return fromProp;
    const direct = queryClient.getQueryData<Session>(['session', sessionId]);
    if (direct !== undefined && direct !== null) return direct;
    for (const [, data] of queryClient.getQueriesData<{ pages?: Array<{ items?: readonly Session[] }> }>({ queryKey: ['sessions'] })) {
      if (!Array.isArray(data?.pages)) continue;
      for (const page of data.pages) {
        const hit = Array.isArray(page?.items) ? page.items.find((item) => item.id === sessionId) : undefined;
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }, [sessions, sessionId, queryClient]);
  const sessionIdentityQuery = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => client.getSession(sessionId),
    enabled: cachedSessionRecord === undefined && createHandoff.ephemeral === undefined && typeof client.getSession === 'function',
    staleTime: 30_000,
    retry: false,
  });
  const knownSession = cachedSessionRecord ?? sessionIdentityQuery.data;
  const persistenceHint = createHandoff.ephemeral !== undefined
    ? createHandoff.ephemeral ? 'temporary' : 'saved'
    : knownSession === undefined ? 'unknown' : knownSession.ephemeral === true ? 'temporary' : 'saved';
  const { controller, leaseReady } = useActiveController(sessionId, selectedAgentId, persistenceHint);

  const initialBindingIntentRef = useRef({ model: initialOptionsRef.current.model, thinking: initialOptionsRef.current.thinking });
  const skillBindingChangeRef = useRef<ComposerModelBindingChange | undefined>(undefined);
  const setModelSwitchDialogState = useCallback((dialog: Omit<Extract<NonNullable<typeof switchConfirmation>, { kind: 'model' }>, 'kind'> | undefined) => {
    setSwitchConfirmation(dialog === undefined ? undefined : { ...dialog, kind: 'model' });
  }, []);
  const mainTarget = useMemo(() => ({ sessionId, agentId: MAIN_AGENT_ID }), [sessionId]);
  const initialMainAttachments = useMemo(
    () =>
      initialOptionsRef.current.initialSkill?.attachments ??
      initialOptionsRef.current.initialAttachments ??
      restoredComposer.attachments ??
      [],
    [restoredComposer.attachments],
  );

  // Unified workspace core: owns main's timeline, drafts/attachments/annotations,
  // durable steer receipts, catalog/config/profile queries, model switching,
  // auto-compact, MessageViewContext, and shared Composer/ModelSwitchDialog props.
  // Explicit policy differences: mountHost='seat', busyPlainSendMode='queue',
  // interactionPlacementMode='tray'.
  const mainCore = useAgentWorkspaceCore(mainTarget, controller, {
    mountHost: 'seat',
    busyPlainSendMode: 'queue',
    interactionPlacementMode: 'tray',
    storageKey: sessionId,
    visible: true,
    initialAttachments: initialMainAttachments,
    syncInitialDraft: false,
    extraComposerState: {
      permissionMode: permissionOverride,
      planMode: planOverride,
      planGate: planGateOverride,
      goalObjective: '',
      modelOverride,
      effortOverride,
      modelChoice,
      effortChoice,
      modelSwitchMode,
      execution: pendingExecution,
    },
    isAnnotationMutationLocked: () => queueEditRef.current?.loading === true,
    onDraftAppended: () => { focusComposer(); },
    onBeforeFlushUnmount: () => {
      // Restore the parked composition before flushing and releasing the hold.
      const edit = queueEditRef.current;
      if (edit !== null) {
        edit.abort.abort();
        queueEditRef.current = null;
        const chrome = readComposerState(sessionId);
        writeDraft(sessionId, edit.savedDraft);
        writeComposerState(sessionId, {
          ...chrome,
          attachments: attachmentsRef.current,
          annotations: edit.savedAnnotations,
          quotes: [],
          quote: null,
          quoteSource: undefined,
          permissionMode: chrome.permissionMode,
          planMode: chrome.planMode,
          planGate: chrome.planGate,
          goalObjective: chrome.goalObjective,
          modelOverride: chrome.modelOverride,
          effortOverride: chrome.effortOverride,
          execution: chrome.execution,
        });
      }
    },
    modelSwitchActive: selectedAgentId === undefined,
    controlledModelSwitchDialog: modelSwitchDialog,
    onChangeModelSwitchDialog: setModelSwitchDialogState,
    mainProfileCatalog: { pendingProfile, pendingExecution },
    resolveExecution: ({
      state: live,
      models,
      config,
      liveSettings: settings,
      modelSwitches: switches,
      agentProfileCatalogMode: profileCatalogMode,
      agentProfilesQuery: profilesQuery,
      fileProfilePreview: filePreview,
      harness: activeHarness,
      boundProfile: activeBoundProfile,
      boundExecution: activeBoundExecution,
      shownExecution: activeShownExecution,
    }) => {
      const serverDefault = config?.default_model;
      const liveSessionModel = live.model;
      const inherited = activeHarness === undefined ? serverDefault ?? settings.defaultModel : undefined;
      const started = live.loaded && sessionHasStartedConversation(live.blocks);
      const isProfilePending = pendingProfile !== undefined && pendingProfile !== activeBoundProfile;
      const isExecutionPending = isProfilePending || executionPickIsPending(pendingExecution, activeBoundExecution, started);
      const isInitialBindingPending = initialBindingStillPending({
        expectedModel: initialBindingIntentRef.current.model,
        expectedThinking: initialBindingIntentRef.current.thinking,
        modelOverride,
        effortOverride,
        boundModel: liveSessionModel,
        boundThinking: live.thinkingEffort,
      });
      const selection = resolveComposerModelOverrides({
        modelOverride,
        effortOverride,
        modelChoice,
        effortChoice,
        modelSwitchMode,
        conversationStarted: started,
        pendingBinding: pendingProfile !== undefined || isExecutionPending || isInitialBindingPending,
        binding: { model: liveSessionModel, thinking: live.thinkingEffort },
        acceptedBindingChange: skillBindingChangeRef.current,
      });
      const resolvedEffectiveModel = resolveEffectiveModel(selection.modelOverride, liveSessionModel, inherited);
      const resolvedCatalogItem = activeHarness === undefined && resolvedEffectiveModel !== undefined
        ? resolveCatalogModel(models ?? [], resolvedEffectiveModel) : undefined;
      const resolvedEfforts = resolvedCatalogItem?.support_efforts;
      const resolvedSelectedModelId = resolvedEffectiveModel === undefined
        ? undefined
        : resolveCatalogModel(models ?? [], resolvedEffectiveModel)?.id ?? resolvedEffectiveModel;
      const activeLiveModel = liveSessionModel || inherited;
      const resolvedBoundModelId = activeLiveModel === undefined
        ? undefined
        : resolveCatalogModel(models ?? [], activeLiveModel)?.id ?? activeLiveModel;
      const activeSelectedProfile = activeShownExecution.profile_file === undefined
        ? profilesQuery.data?.items.find((profile) => profile.name === activeShownExecution.profile)
        : filePreview.data?.profile;
      const activeProfileEffort = activeSelectedProfile !== undefined && profileExecutor(activeSelectedProfile) === activeShownExecution.executor
        ? profileThinkingDefault(activeSelectedProfile, resolvedEffectiveModel, models ?? []) : undefined;
      const isSelectionChanging = isExecutionPending || resolvedSelectedModelId !== resolvedBoundModelId;
      const activeInheritedEffort = isSelectionChanging ? activeProfileEffort : live.thinkingEffort;
      const activeManualEffort = effortTouched && selection.effortChoice === effortChoice
        ? selection.effortOverride : undefined;
      const resolvedEffectiveEffort = activeManualEffort ?? (isInitialBindingPending ? selection.effortOverride : undefined)
        ?? activeInheritedEffort ?? (activeHarness === undefined
          ? resolveSelectedEffort(resolvedEfforts, undefined, resolvedCatalogItem?.default_effort) : live.thinkingEffort);
      const isModelControlPending = modelTouched && selection.modelChoice === modelChoice && selection.modelOverride !== undefined
        && (resolvedSelectedModelId !== resolvedBoundModelId || modelSwitchMode === 'fresh' || modelSwitchMode === 'compact');
      const isEffortControlPending = effortTouched && selection.effortChoice === effortChoice && selection.effortOverride !== undefined
        && selection.effortOverride !== (live.thinkingEffort ?? resolvedCatalogItem?.default_effort);
      const activePendingControls = isModelControlPending || isEffortControlPending;

      const canonical = (value: string | undefined): string | undefined =>
        value === undefined ? undefined : resolveCatalogModel(models ?? [], value)?.id ?? value;
      const effortSource = switches.dependency ?? switches.switches.findLast((entry) =>
        entry.receipt.state === 'completed' && canonical(entry.receipt.toModel) === resolvedBoundModelId);
      const switchEffort = activeManualEffort ?? (effortSource !== undefined
        ? effortSource.input.thinking
        : live.session?.agent_config.execution?.sources['thinking'] === 'session'
          ? activeBoundExecution.overrides?.thinking
          : undefined);
      const carriedThinking = typeof switchEffort === 'string' && switchEffort !== '' ? switchEffort : undefined;
      const sendReady = resolveSessionSendReady({
        controllerAvailable: controller !== null,
        leaseReady,
        loaded: live.loaded,
        loadError: live.loadError,
        resyncing: live.resyncing,
        resyncFailed: live.resyncFailed,
      });
      const { limit: ctxLimit } = resolveComposerContext(live, resolvedCatalogItem?.max_context_size);
      const runningNow = canAbortActiveTurn(live);
      return {
        currentModel: resolvedBoundModelId,
        carriedThinking,
        profileDefaultEffort: (toModel: string) => {
          if (models === undefined) return undefined;
          return activeSelectedProfile !== undefined && profileExecutor(activeSelectedProfile) === activeShownExecution.executor
            ? profileThinkingDefault(activeSelectedProfile, toModel, models)
            : undefined;
        },
        autoCompact: {
          enabled: sessionIdForSendReadyRead(sessionId, sendReady) !== undefined,
          modelId: liveSessionModel,
          modelLabel: resolvedCatalogItem?.display_name ?? liveSessionModel,
          maxContextTokens: ctxLimit,
          running: runningNow,
          profileName: activeBoundProfile,
          profileCatalog: profileCatalogMode,
        },
        busy: runningNow,
        externalBindingSetting:
          activeHarness !== undefined && !isExecutionPending && pendingProfile === undefined && activePendingControls && resolvedEffectiveModel !== undefined
            ? { model: resolvedEffectiveModel, thinking: resolvedEffectiveEffort }
            : undefined,
        sendTimingDefault: settings.defaultAppendTiming,
        sessionRecord: live.session,
        durableIngress: filterIngressForAgent(live.durableIngress, MAIN_AGENT_ID),
      };
    },
  });

  const {
    liveSettings,
    timeline: { state, actions: mainTimelineActions },
    modelsQuery,
    configQuery,
    executorCatalog,
    agentProfileCatalogMode,
    agentProfilesQuery,
    fileProfilePreview,
    harness,
    boundProfile,
    boundExecution,
    shownExecution,
    draftRef,
    setDraft,
    updateDraft,
    attachments,
    attachmentsRef,
    setAttachments,
    updateAttachments,
    composerOwnerActive,
    timelineBlocksRef: mainTranscriptBlocksRef,
    annotations: {
      setAnnotations,
      annotationsRef: draftSelectionsRef,
      surface: annotationSurface,
    },
    trackNowReceipt,
    modelSwitches,
    modelSwitchFlow: {
      open: openModelSwitchFlow,
      applyEffortSetting: applyMainEffortSetting,
      noticeActions: modelSwitchActions,
    },
    contextAutoCompact,
    messageViewContext,
    revealOwnSend,
  } = mainCore;

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

  // Close the overlay rail and the terminal panel on Escape (the app-level sidebar
  // closes itself). Overlays / PTY own the key first; the abort lives in the
  // other listener and stands down while either is open, so whichever of the
  // two runs first, one Escape does one thing.
  useEffect(() => {
    const visibleTerminalOpen = terminalOpen && !previewMaximized;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldCloseSessionChromeOnEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          overlayOpen: anyOverlayOpen(),
          terminalFocused: isTerminalEscapeTarget(event.target),
          terminalOpen: visibleTerminalOpen,
          railOpen: overlayRailOpen,
        })
      ) {
        return;
      }
      event.preventDefault();
      if (overlayRailOpen) closeRail();
      else if (visibleTerminalOpen) toggleTerminalPanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [overlayRailOpen, terminalOpen, previewMaximized, closeRail, toggleTerminalPanel]);

  useEffect(() => controller?.subscribeInterruptedPrompt((content) => {
    restorePromptToDraft(sessionId, content);
  }), [controller, sessionId]);

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

  const [abortPending, trackAbort] = useAbortPending(state.busy);
  const sessionSendReady = resolveSessionSendReady({
    controllerAvailable: controller !== null,
    leaseReady,
    loaded: state.loaded,
    loadError: state.loadError,
    resyncing: state.resyncing,
    resyncFailed: state.resyncFailed,
  });
  const mainDurableIngress = useMemo(
    () => filterIngressForAgent(state.durableIngress, MAIN_AGENT_ID),
    [state.durableIngress],
  );
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (pending === undefined) return;
    const ingress = mainDurableIngress?.find((item) => item.prompt_id === pending.id);
    const row = state.blocks.find((block): block is UserBlock =>
      block.kind === 'user' &&
      (block.promptId === pending.id || block.userMessageId === pending.id || block.id === `user-${pending.id}`),
    );
    const admission = ingress?.admission;
    if (admission === 'failed') {
      // The server kept this message: its bubble carries "not sent" with a
      // same-id retry, so the composer and a toast stay out of it.
      if (pendingSendRef.current) return;
      if (pendingRecoveryRef.current?.id === pending.id) pendingRecoveryRef.current = undefined;
      setPendingSubmission((current) => current?.id === pending.id ? undefined : current);
      return;
    }
    if (admission === 'cancelled') {
      if (pendingSendRef.current) return;
      const recoveryEntry = pendingRecoveryRef.current?.id === pending.id ? pendingRecoveryRef.current : undefined;
      pendingRecoveryRef.current = undefined;
      if (recoveryEntry === undefined) {
        setPendingSubmission((current) => current?.id === pending.id ? undefined : current);
        return;
      }
      recoveryEntry.restore();
      setPendingSubmission((current) => current?.id === pending.id ? undefined : current);
      pushToast({
        tone: admission === 'cancelled' ? 'info' : 'error',
        text: t(admission === 'cancelled' ? 'sv.submissionRecovery.cancelled' : 'sv.submissionRecovery.failed'),
      });
      return;
    }
    // An active prompt id alone is not a visible hand-off: keep the local body
    // until the timeline row or queue projection actually owns this prompt.
    const canonical = row !== undefined || state.queuedPromptIds.includes(pending.id);
    if (canonical) {
      if (pendingRecoveryRef.current?.id === pending.id) pendingRecoveryRef.current = undefined;
      setPendingSubmission((current) => current?.id === pending.id ? undefined : current);
      return;
    }
    const serverState = admission === 'restoring' || admission === 'waiting_switch' || admission === 'admitted' || admission === 'held'
      ? { status: 'server' as const, retryable: admission === 'held' }
      : undefined;
    if (serverState !== undefined && (pending.status !== serverState.status || pending.retryable !== serverState.retryable)) {
      setPendingSubmission({ ...pending, ...serverState, slow: false });
    }
  }, [pendingSubmission?.id, pendingSubmission?.status, pendingSubmission?.retryable, state.blocks, mainDurableIngress, state.queuedPromptIds, t]);

  // Which projection of the timeline this session shows (remembered per
  // session; a `message` delivery opens in the message view) and the delivery
  // switch. Delivery freezes per turn on the server, so a change made mid-turn
  // is labelled "下一轮生效" until the turn ends.
  //
  // `deliveryCapable` is the reply mode, not the identity: a persona session
  // with ordinary replies has no message view to switch to, and the old
  // `isBotSession` showed it one anyway.
  const deliveryCapable = state.session?.delivery === 'message';
  const [storedTimelineView, setTimelineView] = useTimelineView(sessionId, state.session);
  // A session whose delivery is explicitly not `message` has no view switcher,
  // so a stale stored `'message'` choice must never trap it out of process view.
  const timelineView: TimelineView = state.session !== undefined && !deliveryCapable ? 'process' : storedTimelineView;
  useEffect(() => {
    if (!deliveryCapable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTimelineViewShortcut(event)) return;
      event.preventDefault();
      setTimelineView(timelineView === 'message' ? 'process' : 'message');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [deliveryCapable, timelineView, setTimelineView]);
  const [deliveryChangedInTurn, setDeliveryChangedInTurn] = useState(false);
  useEffect(() => { if (!state.busy) setDeliveryChangedInTurn(false); }, [state.busy]);
  const changeDelivery = useCallback((delivery: 'reply' | 'message') => {
    if ((state.session?.delivery ?? 'reply') === delivery) return;
    const busyNow = state.busy;
    void client.updateSessionProfile(sessionId, { delivery })
      .then(() => {
        if (busyNow) setDeliveryChangedInTurn(true);
        if (delivery === 'message') setTimelineView('message');
        void controller?.refreshSession();
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('message.deliverySwitchFailed', { detail: error instanceof Error ? error.message : String(error) }) });
      });
  }, [client, controller, sessionId, setTimelineView, state.busy, state.session?.delivery, t]);

  // Advance this conversation's seen-mark only while its route is visible
  // and focused. Prefer semantic `attention_cursor` over raw `last_seq` so
  // post-turn housekeeping ticks never resurrect unread dots.
  const listedSession = sessions.find((item) => item.id === sessionId);
  const viewedCursor = useMemo<AttentionCursor | undefined>(() => {
    if (state.session === undefined && listedSession === undefined) return undefined;
    const liveCursor = state.session !== undefined ? sessionAttentionCursor(state.session) : undefined;
    const listCursor = listedSession !== undefined ? sessionAttentionCursor(listedSession) : undefined;
    if (liveCursor?.epoch !== undefined || listCursor?.epoch !== undefined) {
      if (liveCursor?.epoch !== undefined && listCursor?.epoch !== undefined && liveCursor.epoch === listCursor.epoch) {
        return { epoch: liveCursor.epoch, seq: Math.max(liveCursor.seq, listCursor.seq) };
      }
      return liveCursor?.epoch !== undefined ? liveCursor : listCursor;
    }
    return { seq: Math.max(state.session?.last_seq ?? 0, state.cursor.seq, listedSession?.last_seq ?? 0) };
  }, [state.session, state.cursor.seq, listedSession]);
  useViewedSession(host, sessionId, viewedCursor);

  const permissionMode = resolveControlledValue(
    permissionOverride,
    state.permissionMode,
    defaults.defaultPermissionMode,
  );
  const planMode = resolveControlledFlag(planOverride, state.planMode, state.loaded, defaults.defaultPlanMode);
  useEffect(() => {
    if (!permissionWriting && shouldClearModeOverride(permissionOverride, state.permissionMode)) {
      setPermissionOverride(undefined);
    }
  }, [permissionOverride, permissionWriting, state.permissionMode]);
  useEffect(() => {
    if (!planWriting && state.loaded && shouldClearModeOverride(planOverride, state.planMode)) {
      setPlanOverride(undefined);
    }
  }, [planOverride, planWriting, state.loaded, state.planMode]);

  // A session that is definitely gone cannot recover: toast the reason, keep the
  // card visible for a beat, then fall back home (clearing the remembered id
  // so `/` doesn't redirect straight back into the 404). History and content
  // failures stay here, and the timer does not leave a route it no longer owns.
  // A loaded roster row still carrying the id is not a deletion event: the
  // session surface keeps the route, its error and its Retry until that row is
  // gone from the roster.
  const loadError = state.loadError;
  const sessionStillListed = sessions.some((item) => item.id === sessionId);
  useEffect(() => {
    if (loadError === undefined || !sessionAbsenceShouldLeaveRoute(loadError, sessionId, sessionPathRef.current, sessionStillListed)) return;
    pushToast({ tone: 'info', text: t('sv.sessionGone') });
    const timer = setTimeout(() => {
      if (!sessionAbsenceShouldLeaveRoute(loadError, sessionId, sessionPathRef.current, sessionStillListed)) return;
      if (readLastSessionId() === sessionId) writeLastSessionId(undefined);
      void navigate(connectionId !== null ? placeNewPath(connectionId) : '/new', { replace: true });
    }, NOT_FOUND_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [loadError, sessionId, navigate, t, sessionStillListed, connectionId]);

  // Demand for what this page shows. Focus is the routed timeline's `delta`
  // lease: main's on the main page, the agent's on an agent page (whose
  // workspace also holds its own). Moving it leaves main on the session's
  // `turn` lease, so coming back raises main once instead of reloading it
  // from nothing. The rail retargeted at a panel tab's agent reads that
  // agent's run state, tasks and pending interactions: `turn` carries them.
  useEffect(() => {
    controller?.setFocusedAgent(selectedAgentId ?? MAIN_AGENT_ID);
  }, [controller, selectedAgentId]);
  useEffect(() => {
    if (controller === null || panelFocusAgent === undefined || typeof controller.retainAgentView !== 'function') return;
    controller.retainAgentView('session-rail-focus', panelFocusAgent, 'turn');
    return () => { controller.releaseAgentView('session-rail-focus'); };
  }, [controller, panelFocusAgent]);

  // The sessions list lives in App (single owner, page-1 polling); this view
  // only merges the polled record for ITS session into the live controller.
  // Temporary conversations never enter that list; the sidebar's own query
  // for them (shared through the cache) carries their record instead.
  const ephemeralQuery = useInfiniteQuery({
    queryKey: ['sessions', 'ephemeral'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.listEphemeralSessions({ before_id: pageParam, page_size: 50 }),
    getNextPageParam: (page) => page.has_more ? page.next_cursor : undefined,
    refetchInterval: (query) =>
      wsStatus === 'open'
        ? ((Array.isArray(query.state.data?.pages) && Array.isArray(query.state.data.pages[0]?.items) ? query.state.data.pages[0].items.length : 0) > 0 ? 60_000 : false)
        : 15_000,
  });
  useEffect(() => {
    if (controller === null) return;
    const record = knownSession
      ?? sessions.find((item) => item.id === controller.sessionId)
      ?? (Array.isArray(ephemeralQuery.data?.pages)
        ? ephemeralQuery.data.pages.flatMap((page) => (Array.isArray(page?.items) ? page.items : [])).find((item) => item.id === controller.sessionId)
        : undefined);
    if (record !== undefined) controller.handleSessionRecord(record);
  }, [controller, knownSession, sessions, ephemeralQuery.data]);

  const serverDefaultModel = configQuery.data?.default_model;

  const planGate = resolvePlanGate(planGateOverride, state.session?.agent_config?.plan_gate ?? configQuery.data?.plan?.gate);

  // Subagent tasks register under the dispatching (parent) agent's task
  // service, so bulk/detail actions retain that owner scope.
  const stopAgentTask = useCallback(
    (ownerAgentId: string, taskId: string) =>
      client.stopAgentTask(sessionId, ownerAgentId, taskId),
    [client, sessionId],
  );
  const profileWorkspaceId = sessionAgentProfileWorkspaceId(state.session);
  const executionBinding = state.session?.agent_config.execution;
  const conversationStarted = state.loaded && sessionHasStartedConversation(state.blocks);
  const profilePending = pendingProfile !== undefined && pendingProfile !== boundProfile;
  const executionPending = profilePending || executionPickIsPending(pendingExecution, boundExecution, conversationStarted);
  // Engine names for the confirmation, from the same catalog the panel reads.
  const executorLabels = useMemo(() => ({
    __native: t('composer.agentDefaultName'),
    ...Object.fromEntries(executorCatalog.map((item) => [item.id, item.label])),
  }), [executorCatalog, t]);
  // A session driven by a client outside Kiki carries that fact in its own
  // metadata. It changes the composer and the header, so it is read once here
  // and passed down rather than re-derived in each of them.
  const externalClient = useExternalClientMark(state.session?.metadata);
  // What a local branch would carry, read by the server through its bounded
  // transcript read. It is asked only when the session is externally driven,
  // and only after it has loaded; the preview is not a second history chain
  // and never invents an empty state from an unread one.
  const externalClients = useMemo(() => externalClientsFacade(client.klient), [client]);
  const externalMaterials = useQuery({
    queryKey: ['external-clients', 'materials', sessionId],
    queryFn: () => externalClients!.materials(sessionId),
    staleTime: 30_000,
    retry: false,
    enabled: externalClient !== undefined && externalClients !== undefined && state.loaded,
  });
  const sessionModel = state.model;
  const inheritedDefault = harness === undefined ? serverDefaultModel ?? liveSettings.defaultModel : undefined;
  const initialBindingPending = initialBindingStillPending({
    expectedModel: initialBindingIntentRef.current.model,
    expectedThinking: initialBindingIntentRef.current.thinking,
    modelOverride,
    effortOverride,
    boundModel: sessionModel,
    boundThinking: state.thinkingEffort,
  });
  const composerSelection = resolveComposerModelOverrides({ modelOverride, effortOverride, modelChoice, effortChoice, modelSwitchMode,
    conversationStarted, pendingBinding: pendingProfile !== undefined || executionPending || initialBindingPending,
    binding: { model: sessionModel, thinking: state.thinkingEffort }, acceptedBindingChange: skillBindingChangeRef.current });
  useEffect(() => {
    if (composerSelection.modelOverride !== modelOverride) setModelOverride(composerSelection.modelOverride);
    if (composerSelection.effortOverride !== effortOverride) setEffortOverride(composerSelection.effortOverride);
    if (composerSelection.modelChoice !== modelChoice) {
      setModelChoice(composerSelection.modelChoice);
      if (composerSelection.modelChoice === undefined) setModelTouched(false);
    }
    if (composerSelection.effortChoice !== effortChoice) {
      setEffortChoice(composerSelection.effortChoice);
      if (composerSelection.effortChoice === undefined) setEffortTouched(false);
    }
    const change = skillBindingChangeRef.current;
    if (change !== undefined && (change.previous.model !== sessionModel || change.previous.thinking !== state.thinkingEffort)) {
      skillBindingChangeRef.current = undefined;
    }
  }, [composerSelection.modelOverride, composerSelection.effortOverride, composerSelection.modelChoice, composerSelection.effortChoice,
    modelOverride, effortOverride, modelChoice, effortChoice, sessionModel, state.thinkingEffort]);
  const effectiveModel = resolveEffectiveModel(composerSelection.modelOverride, sessionModel, inheritedDefault);
  const catalogItem = harness === undefined && effectiveModel !== undefined
    ? resolveCatalogModel(modelsQuery.data?.items ?? [], effectiveModel) : undefined;
  const supportedEfforts = catalogItem?.support_efforts;
  const selectedModelId = effectiveModel === undefined ? undefined : resolveCatalogModel(modelsQuery.data?.items ?? [], effectiveModel)?.id ?? effectiveModel;
  const liveModel = sessionModel || inheritedDefault;
  const boundModelId = liveModel === undefined ? undefined : resolveCatalogModel(modelsQuery.data?.items ?? [], liveModel)?.id ?? liveModel;
  const selectedProfile = shownExecution.profile_file === undefined
    ? agentProfilesQuery.data?.items.find((profile) => profile.name === shownExecution.profile)
    : fileProfilePreview.data?.profile;
  const profileEffort = selectedProfile !== undefined && profileExecutor(selectedProfile) === shownExecution.executor
    ? profileThinkingDefault(selectedProfile, effectiveModel, modelsQuery.data?.items ?? []) : undefined;
  const selectionChanging = executionPending || selectedModelId !== boundModelId;
  const inheritedEffort = selectionChanging ? profileEffort : state.thinkingEffort;
  const manualEffort = effortTouched && composerSelection.effortChoice === effortChoice
    ? composerSelection.effortOverride : undefined;
  const effectiveEffort = manualEffort ?? (initialBindingPending ? composerSelection.effortOverride : undefined)
    ?? inheritedEffort ?? (harness === undefined
      ? resolveSelectedEffort(supportedEfforts, undefined, catalogItem?.default_effort) : state.thinkingEffort);
  const modelControlPending = modelTouched && composerSelection.modelChoice === modelChoice && composerSelection.modelOverride !== undefined
    && (selectedModelId !== boundModelId || modelSwitchMode === 'fresh' || modelSwitchMode === 'compact');
  const effortControlPending = effortTouched && composerSelection.effortChoice === effortChoice && composerSelection.effortOverride !== undefined
    && composerSelection.effortOverride !== (state.thinkingEffort ?? catalogItem?.default_effort);
  const pendingRuntimeControls = useMemo<PendingRuntimeControls | undefined>(
    () => (modelControlPending || effortControlPending
      ? {
          model: modelControlPending ? effectiveModel : undefined,
          thinking: effortControlPending ? effectiveEffort : undefined,
        }
      : undefined),
    [modelControlPending, effortControlPending, effectiveModel, effectiveEffort],
  );
  const nativeSteeringUnavailable = harnessDenies(harness, 'native_steering');
  const harnessCatalogItem = harness === undefined
    ? undefined
    : executorCatalog.find((entry) => entry.id === harness.executorId);
  const harnessNativeCompact = harnessAdvertisesCompact(harness, harnessCatalogItem);
  const composerEngine = useMemo<ComposerEngine | undefined>(() => harness === undefined ? undefined : {
    label: harness.label, fork: !harnessDenies(harness, 'fork'), images: !harnessDenies(harness, 'image'),
    permissionModes: harness.negotiated?.permission_modes,
    modelThinkingLevels: harness.negotiated?.model_thinking_levels,
    advertisesCompact: harnessNativeCompact,
  }, [harness, harnessNativeCompact]);

  // Canonical ids on both sides: a bare alias lands on its provider row, so
  // "same model" reads as the same model and the panel names what it shows.
  const canonicalModel = useCallback(
    (value: string | undefined): string | undefined =>
      value === undefined ? undefined : resolveCatalogModel(modelsQuery.data?.items ?? [], value)?.id ?? value,
    [modelsQuery.data],
  );
  const currentBoundModel = boundModelId;
  const openModelSwitchPanel = useCallback((toModel: string, explicitMode?: ModelSwitchMode) => {
    void openModelSwitchFlow(toModel, explicitMode);
  }, [openModelSwitchFlow]);
  // A model/effort pick made while a profile switch is pending is explicit:
  // it overrides the incoming profile's pins on the switch prompt. The same
  // pick with nothing pending is what says "send this one", so it counts as
  // touched too — otherwise a bare engine would swallow the user's own pick
  // along with the display value it is withholding.
  const handleModelChange = useCallback((model: string | undefined) => {
    if (model === undefined) {
      // Explicit clear. A later unpinned profile switch must not put a model back.
      setModelOverride(undefined);
      setModelChoice(undefined);
      setModelTouched(false);
      setModelSwitchMode(undefined);
      return;
    }
    const target = canonicalModel(model);
    if (target === undefined) {
      setModelOverride(undefined);
      setModelChoice(undefined);
      setModelTouched(false);
      setModelSwitchMode(undefined);
      return;
    }
    // The bound model is still the model the user chose. Dropping it here left
    // modelTouched false, so a same-executor switch onto a profile with no pin
    // omitted it from the send while the composer kept showing it.
    const selectsBoundModel = target === currentBoundModel && pendingProfile === undefined && !executionPending;
    if (selectsBoundModel || harness !== undefined || pendingProfile !== undefined || executionPending || (state.loaded && !sessionHasStartedConversation(state.blocks))) {
      setModelOverride(model);
      setModelChoice({ model: sessionModel, thinking: state.thinkingEffort });
      setModelTouched(true);
      setModelSwitchMode(undefined);
      return;
    }
    openModelSwitchPanel(target);
  }, [canonicalModel, currentBoundModel, executionPending, harness, openModelSwitchPanel, pendingProfile, sessionModel, state.blocks, state.loaded, state.thinkingEffort]);
  const persistModeChange = useCallback((
    patch: { permission_mode?: PermissionMode; plan_mode?: boolean; plan_gate?: PromptPlanGate },
    onFailure: () => void,
    onSettled: () => void,
  ) => {
    modeWriteQueue.current = modeWriteQueue.current.then(async () => {
      await client.updateSessionProfile(sessionId, { agent_config: patch });
    }).catch((error: unknown) => {
      onFailure();
      pushToast({ tone: 'error', text: t('sv.modeUpdateFailed', {
        detail: error instanceof Error ? error.message : String(error),
      }) });
    }).finally(onSettled);
  }, [client, sessionId, t]);
  const handlePermissionChange = useCallback((mode: PermissionMode | undefined) => {
    permissionTouchedRef.current = true;
    setPermissionOverride(mode);
    if (mode === undefined) return;
    const revision = ++modeWriteRevision.current.permission;
    setPermissionWriting(true);
    persistModeChange({ permission_mode: mode }, () => {
      if (revision !== modeWriteRevision.current.permission) return;
      permissionTouchedRef.current = false;
      setPermissionOverride(undefined);
    }, () => {
      if (revision === modeWriteRevision.current.permission) setPermissionWriting(false);
    });
  }, [persistModeChange]);
  const handlePlanChange = useCallback((enabled: boolean) => {
    setPlanOverride(enabled);
    const revision = ++modeWriteRevision.current.plan;
    setPlanWriting(true);
    persistModeChange({ plan_mode: enabled }, () => {
      if (revision === modeWriteRevision.current.plan) setPlanOverride(undefined);
    }, () => {
      if (revision === modeWriteRevision.current.plan) setPlanWriting(false);
    });
  }, [persistModeChange]);
  const confirmedPlanGate = useRef<PromptPlanGate | undefined>(undefined);
  const planGateRevision = useRef(0);
  const handlePlanGateChange = useCallback((gate: PromptPlanGate) => {
    const revision = ++planGateRevision.current;
    setPlanGateOverride(gate);
    modeWriteQueue.current = modeWriteQueue.current.then(async () => {
      await client.updateSessionProfile(sessionId, { agent_config: { plan_gate: gate } });
      confirmedPlanGate.current = gate;
    }).catch((error: unknown) => {
      if (revision === planGateRevision.current) setPlanGateOverride(confirmedPlanGate.current);
      pushToast({ tone: 'error', text: t('sv.modeUpdateFailed', {
        detail: error instanceof Error ? error.message : String(error),
      }) });
    });
  }, [client, sessionId, t]);
  const handleEffortChange = useCallback((effort: string | undefined) => {
    if (pendingProfile !== undefined || executionPending || initialBindingPending || harness !== undefined || currentBoundModel === undefined) {
      setEffortOverride(effort);
      setEffortChoice({ model: sessionModel, thinking: state.thinkingEffort });
      setEffortTouched(true);
      return;
    }
    void applyMainEffortSetting(modelSwitches.dependency?.input.model ?? currentBoundModel, effort);
  }, [applyMainEffortSetting, currentBoundModel, executionPending, harness, initialBindingPending, modelSwitches.dependency, pendingProfile, sessionModel, state.thinkingEffort]);
  // Applying an incoming binding's pins is that binding taking ownership, not
  // the user moving a control, so both flags drop together. Kept as one helper
  // because the two flags are only ever cleared as a pair.
  const clearTouchedControls = useCallback(() => {
    setModelTouched(false);
    setEffortTouched(false);
    setModelChoice(undefined);
    setEffortChoice(undefined);
    setModelSwitchMode(undefined);
  }, []);
  const cancelPendingRuntimeControls = useCallback(() => {
    setPendingProfile(undefined);
    setPendingExecution(undefined);
    setSwitchConfirmation(undefined);
    setModelOverride(undefined);
    setEffortOverride(undefined);
    clearTouchedControls();
  }, [clearTouchedControls]);

  const applyPendingProfile = useCallback((name: string) => {
    const defaults = composerDefaultsForProfile(agentProfilesQuery.data?.items ?? [], name);
    setPendingProfile(name);
    setPendingExecution(undefined);
    if (defaults.model !== undefined || !modelTouched) {
      setModelOverride(defaults.model);
      setModelTouched(false);
      setModelChoice(undefined);
      setModelSwitchMode(undefined);
    }
    if (!effortTouched) {
      setEffortOverride(defaults.thinking);
      setEffortTouched(false);
      setEffortChoice(undefined);
    }
  }, [agentProfilesQuery.data, modelTouched, effortTouched]);
  const handleAgentProfileChange = useCallback(
    (name: string) => {
      if (name === (pendingProfile ?? boundProfile)) return;
      if (name === boundProfile) {
        // Reverting to the live binding needs no confirm — drop the pending pick.
        cancelPendingRuntimeControls();
        return;
      }
      // A profile pick inside the execution control flows through the engine
      // branch with a fresh-context confirm; direct profile changes are
      // reversible composer-control edits and apply at once with an undo toast.
      const before = { profile: pendingProfile, model: modelOverride, effort: effortOverride, modelTouched, effortTouched };
      applyPendingProfile(name);
      if (state.loaded && !sessionHasStartedConversation(state.blocks)) {
        pushUndoToast({
          text: t('profile.switched', { profile: name }),
          undoFailedText: t('toast.undoFailed'),
          undo: () => {
            setPendingProfile(before.profile);
            setModelOverride(before.model);
            setEffortOverride(before.effort);
            setModelTouched(before.modelTouched);
            setEffortTouched(before.effortTouched);
          },
        });
      }
    },
    [applyPendingProfile, boundProfile, pendingProfile, modelOverride, effortOverride, modelTouched, effortTouched, state.blocks, state.loaded, cancelPendingRuntimeControls, t],
  );

  // Engine pick. A live session that has already spoken asks once, because the
  // next message starts a fresh remote generation; an untouched session applies
  // immediately, as a profile pick does. Reverting to the live binding only
  // drops the pending pick. A new profile brings its model pin and effort
  // defaults; a manually selected effort keeps priority.
  const applyPendingExecution = useCallback((next: ExecutionChoice) => {
    const profile = next.profile;
    const selected = agentProfilesQuery.data?.items.find((item) => item.name === profile);
    const isTargetExecutor = selected !== undefined && profileExecutor(selected) === next.executor;
    const defaults = profile === undefined || !isTargetExecutor
      ? {}
      : composerDefaultsForProfile(agentProfilesQuery.data?.items ?? [], profile);
    const sameExecutor = next.executor === (pendingExecution?.executor ?? boundExecution.executor);
    setPendingProfile(undefined);
    setPendingExecution(next);
    if (defaults.model !== undefined || !sameExecutor || !modelTouched) {
      setModelOverride(defaults.model);
      setModelTouched(false);
      setModelChoice(undefined);
      setModelSwitchMode(undefined);
    }
    if (!effortTouched) {
      setEffortOverride(defaults.thinking);
      setEffortTouched(false);
      setEffortChoice(undefined);
    }
  }, [agentProfilesQuery.data, boundExecution.executor, pendingExecution?.executor, modelTouched, effortTouched]);
  const cancelPendingExecution = cancelPendingRuntimeControls;
  const handleExecutionChange = useCallback((selection: ExecutionChoice) => {
    const next = isNativeExecutor(selection.executor) && selection.profile === undefined && selection.profile_file === undefined
      ? { ...selection, profile: DEFAULT_AGENT_PROFILE }
      : selection;
    const current = pendingExecution ?? boundExecution;
    if (sameExecutionChoice(next, current)) return;
    // Effort capsules must not confirm an engine switch or rebind the model.
    // A caller that still publishes the choice only moves the effort control.
    if (isEffortOnlyExecutionChange(next, current)) {
      const thinking = next.overrides?.thinking;
      handleEffortChange(typeof thinking === 'string' ? thinking : '');
      return;
    }
    if (sameExecutionChoice(next, boundExecution)) {
      cancelPendingExecution();
      return;
    }
    // Re-selecting the live model on this same native engine is the composer
    // control above, not an engine switch. Storing it as an execution override
    // makes the next profile row (which sends no overrides) drop the model.
    const liveModel = next.overrides?.model;
    if (isNativeExecutor(next.executor)
      && sameExecutionIdentity(next, boundExecution)
      && (pendingExecution === undefined || sameExecutionIdentity(next, pendingExecution))
      && typeof liveModel === 'string'
      && canonicalModel(liveModel) === currentBoundModel) {
      return;
    }
    if (state.loaded && !sessionHasStartedConversation(state.blocks)) {
      applyPendingExecution(next);
      return;
    }
    // Same native engine, only the profile (and its own pins) moves: this is
    // the reversible composer-control branch, applied at once with an undo
    // toast instead of the fresh-context confirm a real engine switch keeps.
    if (isNativeExecutor(next.executor)
      && isNativeExecutor(current.executor)
      && next.profile !== current.profile) {
      const before = { profile: pendingProfile, execution: pendingExecution, model: modelOverride, effort: effortOverride, modelTouched, effortTouched };
      applyPendingExecution(next);
      pushUndoToast({
        text: t('profile.switched', { profile: next.profile ?? DEFAULT_AGENT_PROFILE }),
        undoFailedText: t('toast.undoFailed'),
        undo: () => {
          setPendingProfile(before.profile);
          setPendingExecution(before.execution);
          setModelOverride(before.model);
          setEffortOverride(before.effort);
          setModelTouched(before.modelTouched);
          setEffortTouched(before.effortTouched);
        },
      });
      return;
    }
    setExecutionSwitchConfirm(next);
  }, [applyPendingExecution, boundExecution, cancelPendingExecution, canonicalModel, currentBoundModel, handleEffortChange, pendingExecution, modelOverride, effortOverride, modelTouched, effortTouched, state.blocks, state.loaded, t]);
  const confirmExecutionSwitchRun = useCallback(() => {
    if (executionSwitchConfirm === undefined) return;
    applyPendingExecution(executionSwitchConfirm);
    setExecutionSwitchConfirm(undefined);
  }, [applyPendingExecution, executionSwitchConfirm]);
  const refetchAgentProfiles = agentProfilesQuery.refetch;
  const handleContextRebuild = useCallback(async () => {
    const result = await client.rebuildContext(sessionId);
    if (rebuildOwnerRef.current !== rebuildOwner) throw new DOMException('The conversation changed.', 'AbortError');
    // A rebuild changes what the conversation carries — the instructions, the
    // plugins, the skills a plugin brings, and the tools those contribute — so
    // every list that answers from those sources is re-read. Each one re-reads
    // its own source; none of them is re-created, and the session, its messages
    // and its history stay as they are.
    void invalidateAgentProfileCatalogs(queryClient);
    void invalidatePluginQueries(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
    void queryClient.invalidateQueries({ queryKey: ['tools'] });
    void queryClient.invalidateQueries({ queryKey: ['session-mcp-capabilities'] });
    void refetchAgentProfiles();
    return result;
  }, [client, queryClient, rebuildOwner, refetchAgentProfiles, sessionId]);

  // Global y / n shortcut for the focused-or-unambiguous visible approval.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (controller === null) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key === 'Escape') {
        // Escape that dismisses an IME candidate window belongs to the IME.
        if (event.isComposing || event.keyCode === 229) return;
        // A child route or a focused preview tab owns its own keyboard surface.
        // Escape there must never abort the main agent behind the panel.
        if (selectedAgentId !== undefined ||
          (target?.closest('[data-preview-workspace]') as HTMLElement | null)?.hidden === false ||
          (previewCoversMain && document.querySelector('[data-preview-workspace]:not([hidden])') !== null)) return;
        if (!shouldHandleGlobalAbortOnEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          overlayOpen: anyOverlayOpen(),
          terminalFocused: isTerminalEscapeTarget(event.target),
          terminalOpen,
          railOpen: overlayRailOpen,
          inFormField: isFormFieldEscapeTarget(event.target),
          // Focus falls back to body when Hide panel unmounts its button. The
          // visible fullscreen preview still owns Escape at desktop widths.
          fullscreenPreviewOpen: previewMaximized || document.querySelector('[data-preview-workspace][data-preview-fullscreen]:not([hidden])') !== null,
        })) return;
        const current = controller.getState();
        if (canAbortActiveTurn(current)) {
          event.preventDefault();
          trackAbort(controller
            .abortActive()
            .catch((error: unknown) => {
              pushAbortFailureToast(
                controller,
                error instanceof Error ? error.message : t('sv.abortMaybeRunning'),
              );
            }));
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
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          overlayOpen: anyOverlayOpen(),
          inEditable: false,
        })
      ) {
        return;
      }
      const shortcutRoot = approvalShortcutRoot(document, event.target, selectedAgentId, previewCoversMain);
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
        .resolveApproval(approvalId, approvalShortcutDecision(event) ?? 'rejected')
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
  }, [controller, t, terminalOpen, overlayRailOpen, selectedAgentId, previewCoversMain, previewMaximized, trackAbort]);

  const skillSelection = skillControlSelectionKey({ pendingProfile, pendingExecution, modelOverride, effortOverride,
    modelChoice, effortChoice, modelSwitchMode, permissionOverride });
  const skillSelectionRef = useRef(skillSelection);
  skillSelectionRef.current = skillSelection;

  const actions = useMemo(() => {
    if (controller === null) return null;
    return {
      send: (text: string, composerAttachments: readonly ComposerAttachment[], options?: { readonly goalObjective?: string; readonly now?: boolean; readonly personaGreetingReply?: boolean; readonly appendTiming?: DeferredAppendTiming; readonly presentation?: import('@kiki/transcript').TextPresentation; readonly skills?: readonly PromptSkillActivation[]; readonly firstMessage?: FirstSessionMessageRecord }) => {
        // The context block is generated for the model, never restored into the
        // user's editor. Its presentation span is the lossless way back to the draft.
        const submittedDraft = projectPresentedText(text, options?.presentation);
        // Selection carry-overs ride the prompt text as plain-text prefixes —
        // annotations first (blockquote + comment per segment), then the plain
        // quote as a Markdown blockquote — exactly what the transcript renders
        // back. The wire protocol stays untouched.
        const currentAnnotations = draftSelectionsRef.current;
        const carry = serializeSelectionCarryover(currentAnnotations, text, options?.presentation);
        const content = options?.firstMessage?.submission?.content ?? buildPromptContent(carry.quotedText, composerAttachments, carry.presentation);
        if (content === null || pendingSendRef.current) return;
        const textPart = content.find((part) => part.type === 'text');
        // Local echo carries only real user text; media-only prompts render
        // their attachment thumbnails directly without a synthetic placeholder bubble.
        const echoText = textPart !== undefined && textPart.type === 'text' ? textPart.text : '';
        const modelControlTouched = modelTouched && composerSelection.modelChoice === modelChoice;
        const profileSwitch = resolveProfileSwitchSubmission({
          pendingProfile,
          boundProfile,
          modelTouched: modelControlTouched,
          effortTouched: effortTouched && composerSelection.effortChoice === effortChoice,
          model: effectiveModel,
          thinking: effectiveEffort,
          permissionTouched: permissionTouchedRef.current,
          permissionMode: permissionOverride ?? state.permissionMode,
          pendingExecution,
          boundExecution,
        });
        pendingSendRef.current = true;
        const rebindsAgent = profileSwitch.profile !== undefined || profileSwitch.execution !== undefined;
        const completeControls = () => completeSkillControlSelection({
          controlled: { content, profile: profileSwitch.profile, execution: profileSwitch.execution,
            model: profileSwitch.model, thinking: profileSwitch.thinking },
          capturedSelection: skillSelection,
          currentSelection: skillSelectionRef.current,
          binding: { model: sessionModel, thinking: state.thinkingEffort },
          preserveBindingChange: (change) => { skillBindingChangeRef.current = change; },
          clear: () => {
            setPendingProfile(undefined);
            setPendingExecution(undefined);
            setModelOverride(undefined);
            setEffortOverride(undefined);
            clearTouchedControls();
          },
          refresh: () => { void controller.refreshSession(); },
        });
        if (options?.now === true) {
          const sentAnnotationsNow = currentAnnotations;
          const sentNowIds = new Set(sentAnnotationsNow.map((annotation) => annotation.id));
          let compositionReleased = false;
          const releaseComposition = () => {
            if (compositionReleased) return;
            compositionReleased = true;
            if (composerOwnerActive.current && draftRef.current === submittedDraft
              && JSON.stringify(attachmentsRef.current) === JSON.stringify(composerAttachments)) {
              updateDraft('');
              updateAttachments([]);
            }
            if (composerOwnerActive.current) {
              setAnnotations((current) => current.filter((annotation) => !sentNowIds.has(annotation.id)));
            } else {
              updateStoredAnnotations(sessionId, (current) => current.filter((item) => !sentNowIds.has(item.id)));
            }
          };
          return controller
            .sendPromptNow({
              text: echoText,
              content,
              profile: profileSwitch.profile,
              execution: profileSwitch.execution,
              model: profileSwitch.model,
              thinking: profileSwitch.thinking,
              modelSwitchMode: modelControlTouched && !rebindsAgent ? modelSwitchMode : undefined,
              afterModelSwitch: rebindsAgent ? undefined : modelSwitches.dependency?.input.operationId,
              permissionMode: profileSwitch.permissionMode,
              planMode,
              planGate,
              skills: options?.skills,
              onPreservation: (persisted) => {
                if (persisted) releaseComposition();
                else pushToast({ tone: 'info', text: t('sv.submissionRecovery.degraded') });
              },
              onAcknowledged: releaseComposition,
            })
            .then((result) => {
              if (result.outcome === 'failed' && hasDurableRecord(controller, result.promptId, MAIN_AGENT_ID)) {
                forgetUnconfirmedSubmission(sessionId, result.promptId, MAIN_AGENT_ID);
                releaseComposition();
                return;
              }
              if (result.outcome === 'failed' || result.outcome === 'cancelled') {
                if (composerOwnerActive.current) {
                  setAnnotations((current) => restoreSentAnnotations(current, sentAnnotationsNow));
                  const recovery = recoverFailedSubmission(draftRef.current, attachmentsRef.current, submittedDraft, composerAttachments);
                  if (recovery !== undefined) {
                    updateDraft(recovery.text);
                    updateAttachments(recovery.attachments);
                  }
                } else {
                  recoverSubmittedDraft(sessionId, submittedDraft, composerAttachments);
                  updateStoredAnnotations(sessionId, (current) => restoreSentAnnotations(current, sentAnnotationsNow));
                }
                pushToast({
                  tone: 'info',
                  text: t(result.outcome === 'cancelled' ? 'sv.submissionRecovery.cancelled' : 'sv.submissionRecovery.failed'),
                });
                return;
              }
              releaseComposition();
              completeControls();
              // The receipt says why a "Send now" did not join the turn. A
              // queued acknowledgement already carries its final reason; only
              // restoring/held receipts are open to a later durable read.
              const notice = sendNowNotice(result.outcome, result.reason);
              if (notice !== undefined) {
                pushToast({ tone: notice.tone, text: t(notice.key) });
              }
              if (result.outcome === 'restoring' || result.outcome === 'held') {
                // Restoring/held acknowledgements carry no reason yet: leave
                // the receipt open so the durable read can supply the final one.
                trackNowReceipt(result.promptId, null);
              }
            })
            .catch((error: unknown) => {
              const reason = error instanceof SendNowError ? error.reason : 'submit';
              if (reason !== 'unknown') {
                // Nothing reached the turn: the text goes back to its author.
                if (composerOwnerActive.current) {
                  setAnnotations((current) => restoreSentAnnotations(current, sentAnnotationsNow));
                  const recovery = recoverFailedSubmission(draftRef.current, attachmentsRef.current, submittedDraft, composerAttachments);
                  if (recovery !== undefined) {
                    updateDraft(recovery.text);
                    updateAttachments(recovery.attachments);
                  }
                } else {
                  recoverSubmittedDraft(sessionId, submittedDraft, composerAttachments);
                  updateStoredAnnotations(sessionId, (current) => restoreSentAnnotations(current, sentAnnotationsNow));
                }
              }
              const cause = error instanceof SendNowError ? error.cause : error;
              const detail = cause instanceof Error ? cause.message : String(cause);
              pushToast({
                tone: 'error',
                text: t(reason === 'refused' ? 'sv.steerRefused' : reason === 'unknown' ? 'sv.steerUnknown' : 'sv.steerFailed', { detail }),
                code: cause instanceof ApiError ? cause.code : undefined,
                requestId: cause instanceof ApiError ? cause.requestId : undefined,
              });
            })
            .finally(() => {
              pendingSendRef.current = false;
            });
        }
        const contentKey = JSON.stringify(content);
        const firstMessage = options?.firstMessage;
        const frozen = firstMessage?.message;
        const submissionBody = {
          text: echoText, content,
          profile: firstMessage === undefined ? profileSwitch.profile : undefined,
          execution: firstMessage === undefined ? profileSwitch.execution : undefined,
          model: firstMessage === undefined ? profileSwitch.model : frozen?.model,
          thinking: firstMessage === undefined ? profileSwitch.thinking : frozen?.thinking,
          modelSwitchMode: firstMessage === undefined && modelControlTouched && !rebindsAgent ? modelSwitchMode : undefined,
          afterModelSwitch: firstMessage === undefined && !rebindsAgent ? modelSwitches.dependency?.input.operationId : undefined,
          permissionMode: firstMessage === undefined ? profileSwitch.permissionMode : frozen?.permissionMode,
          planMode: firstMessage === undefined ? planMode : frozen?.planMode,
          planGate: firstMessage === undefined ? planGate : undefined,
          goalObjective: firstMessage === undefined ? promptGoalObjective(options) : frozen?.goalObjective,
          appendTiming: frozen?.appendTiming ?? options?.appendTiming ?? liveSettings.defaultAppendTiming,
          personaGreetingReply: options?.personaGreetingReply,
          skills: frozen?.initialSkill !== undefined
            ? [{ name: frozen.initialSkill.name, args: frozen.initialSkill.args === '' ? undefined : frozen.initialSkill.args }]
            : frozen?.initialSkills ?? options?.skills,
        };
        const submissionKey = JSON.stringify(submissionBody);
        const retryablePending = pendingSubmissionRef.current;
        const retryableStatus = retryablePending?.status === 'offline';
        const submissionId = frozen?.initialPromptId ?? (retryableStatus && retryablePending.submissionKey === submissionKey
          ? retryablePending.id
          : randomUuid());
        const retainedFirst = firstMessageRef.current;
        if (firstMessage === undefined && retainedFirst?.status === 'submitted' && retainedFirst.submission?.promptId === submissionId) {
          pendingSendRef.current = false;
          pendingRetryRef.current?.run();
          return;
        }
        // The captured payload, notes and identity belong to X, not whatever
        // the user composes after a failure toast appears.
        const sentAnnotations = currentAnnotations;
        const sentIds = new Set(sentAnnotations.map((annotation) => annotation.id));
        const restoreCapturedSubmission = () => {
          if (composerOwnerActive.current) {
            setAnnotations((current) => restoreSentAnnotations(current, sentAnnotations));
            const recovery = recoverFailedSubmission(draftRef.current, attachmentsRef.current, submittedDraft, composerAttachments);
            if (recovery !== undefined) {
              updateDraft(recovery.text);
              updateAttachments(recovery.attachments);
            }
          } else {
            recoverSubmittedDraft(sessionId, submittedDraft, composerAttachments);
            updateStoredAnnotations(sessionId, (current) => restoreSentAnnotations(current, sentAnnotations));
          }
        };
        pendingRecoveryRef.current = { id: submissionId, restore: restoreCapturedSubmission };
        // Returned to the composer: it holds its send latch until this round
        // settles, which is what blocks a rapid duplicate send (and releases
        // for a retry when the submit fails).
        const submission: FirstSessionSubmission = firstMessage?.submission ?? { ...submissionBody, promptId: submissionId };
        const firstStorage = spaceStorage.capture();
        let firstRecord: FirstSessionMessageRecord | undefined = firstMessage === undefined ? undefined : { ...firstMessage, submission };
        const saveFirstRecord = (record: FirstSessionMessageRecord) => {
          firstRecord = record;
          firstMessageRef.current = record;
          writeFirstSessionMessage(scopeId, sessionId, record, firstStorage);
        };
        if (firstRecord !== undefined) saveFirstRecord(firstRecord);
        const clearFirstRecord = () => {
          if (firstRecord === undefined) return;
          clearFirstSessionMessage(scopeId, sessionId, firstStorage);
          if (firstMessageRef.current?.message.initialPromptId === submissionId) firstMessageRef.current = undefined;
          firstRecord = undefined;
        };
        let accepted = false;
        const submitCaptured = (first = false): Promise<void> | undefined => {
          const currentPending = pendingSubmissionRef.current;
          const ingress = (controller.getDurableIngress?.() ?? []).find(
            (item) => item.prompt_id === submissionId && (item.agent_id ?? MAIN_AGENT_ID) === MAIN_AGENT_ID,
          );
          const resume = !first && (ingress?.admission === 'failed' || ingress?.admission === 'held') && controller.resumeDurableIngress !== undefined;
          const retryingHeld = resume && ingress?.admission === 'held' && currentPending?.id === submissionId;
          if (!composerOwnerActive.current || (!first && pendingSendRef.current)) return;
          if (!first && accepted && !retryingHeld) return;
          if (!first && currentPending?.status === 'server' && !retryingHeld) return;
          pendingSendRef.current = true;
          let compositionReleased = false;
          const releaseComposition = (force = false) => {
            if (compositionReleased) return;
            compositionReleased = true;
            // Only X's recovered composition leaves; a newer Y stays untouched.
            if (composerOwnerActive.current && (force || (draftRef.current === submittedDraft
              && JSON.stringify(attachmentsRef.current) === JSON.stringify(composerAttachments)))) {
              updateDraft('');
              updateAttachments([]);
            }
            if (composerOwnerActive.current) {
              setAnnotations((current) => current.filter((annotation) => !sentIds.has(annotation.id)));
            } else {
              updateStoredAnnotations(sessionId, (current) => current.filter((item) => !sentIds.has(item.id)));
            }
          };
          setPendingSubmission({
            id: submissionId,
            agentId: MAIN_AGENT_ID,
            text: echoText,
            content,
            contentKey,
            submissionKey,
            createdAt: new Date().toISOString(),
            slow: false,
            preserved: currentPending?.id === submissionId ? currentPending.preserved : false,
            retryable: false,
            status: 'sending',
          });
          const send = (captured: FirstSessionSubmission) => controller.sendPrompt({
            ...captured,
            onPreservation: (persisted: boolean) => {
              setPendingSubmission((current) => current?.id === submissionId ? { ...current, preserved: persisted } : current);
              if (persisted) releaseComposition(first && firstMessage === undefined);
              else pushToast({ tone: 'info', text: t('sv.submissionRecovery.degraded') });
            },
            onAcknowledged: () => releaseComposition(),
          });
          const request = resume
            ? controller.resumeDurableIngress(submissionId, {
              admission: 'durable', content: submission.content!, prompt_id: submission.promptId,
              profile: submission.profile, execution: submission.execution, model: submission.model,
              thinking: submission.thinking, permission_mode: submission.permissionMode,
              plan_mode: submission.planMode, plan_gate: submission.planGate,
              goal_objective: submission.goalObjective, append_timing: submission.appendTiming,
              persona_greeting_reply: submission.personaGreetingReply,
              skills: submission.skills === undefined ? undefined : [...submission.skills],
            })
            : firstRecord === undefined ? send(submission) : submitFirstSessionMessage({
              record: firstRecord, save: saveFirstRecord, submit: send, retryMissing: !first,
              read: async (promptId) => {
                if (client.sessions.getDurableIngress === undefined) throw new Error('Durable prompt recovery is unavailable on this transport');
                try {
                  const receipt = await client.sessions.getDurableIngress(sessionId, promptId);
                  void controller.refreshDurableIngress();
                  return receipt;
                } catch (cause) {
                  if (cause instanceof ApiError && cause.code === API_CODES.PROMPT_NOT_FOUND) return undefined;
                  throw cause;
                }
              },
            });
          return request
          .then((result) => {
            clearFirstRecord();
            const admissionRejected = result.admission === 'failed' || result.admission === 'cancelled';
            if (result.admission === 'failed' && hasDurableRecord(controller, result.prompt_id, MAIN_AGENT_ID)) {
              // Saved but not admitted: the message stays on the timeline as
              // a "not sent" bubble whose retry reuses this id.
              forgetUnconfirmedSubmission(sessionId, result.prompt_id, MAIN_AGENT_ID);
              releaseComposition();
              setPendingSubmission((current) => current?.id === submissionId ? undefined : current);
              pendingRecoveryRef.current = undefined;
              return;
            }
            if (admissionRejected) {
              restoreCapturedSubmission();
              setPendingSubmission((current) => current?.id === submissionId ? undefined : current);
              pendingRecoveryRef.current = undefined;
              pushToast({
                tone: result.admission === 'cancelled' ? 'info' : 'error',
                text: t(result.admission === 'cancelled' ? 'sv.submissionRecovery.cancelled' : 'sv.submissionRecovery.failed'),
              });
              return;
            }
            accepted = true;
            releaseComposition();
            setGoalMode(false);
            completeControls();
          })
          .catch((error: unknown) => {
            const isApi = error instanceof ApiError;
            const transportUnconfirmed = isUnconfirmedTransportError(error) || (isApi && error.code === API_CODES.TIMEOUT);
            if (transportUnconfirmed) {
              // Keep the captured identity visible and retryable without auto-refilling
              // the composer: a timeout or fetch failure has unknown delivery, so
              // refilling here risks duplicate submission if WS later confirms it.
              setPendingSubmission((current) => current?.id === submissionId
                ? { ...current, slow: true, retryable: true, status: 'offline' }
                : current);
              return;
            }
            restoreCapturedSubmission();
            if (resume) {
              setPendingSubmission((current) => current?.id === submissionId
                ? { ...current, slow: true, retryable: true, status: 'server' }
                : current);
              pendingRecoveryRef.current = undefined;
            } else {
              setPendingSubmission((current) => current?.id === submissionId ? undefined : current);
              pendingRecoveryRef.current = undefined;
            }
            pushToast({
              tone: 'error',
              text: error instanceof Error ? error.message : String(error),
              code: isApi ? error.code : undefined,
              requestId: isApi ? error.requestId : undefined,
              detail: error instanceof Error ? error.stack : undefined,
              retry: {
                run: () => {
                  void submitCaptured();
                },
              },
            });
          })
          .finally(() => {
            pendingSendRef.current = false;
          });
        };
        pendingRetryRef.current = { id: submissionId, run: () => { void submitCaptured(); } };
        return submitCaptured(true);
      },
      activateSkill: (
        name: string,
        args: string,
        composerAttachments: readonly ComposerAttachment[],
        goalObjectiveOverride?: string,
        userInput?: string,
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
          draft: userInput ?? draftRef.current,
          attachments: composerAttachments,
        };
        const resolvedSkill = resolveControlledSkillSubmission({
          name, args, userInput: userInput ?? `/${name} ${args}`.trim(), attachments: composerAttachments,
          pendingProfile, boundProfile, pendingExecution, boundExecution,
          modelTouched: modelTouched && composerSelection.modelChoice === modelChoice,
          effortTouched: effortTouched && composerSelection.effortChoice === effortChoice,
          model: effectiveModel, thinking: effectiveEffort,
          modelSwitchMode,
          permissionTouched: permissionTouchedRef.current,
          permissionMode: permissionOverride ?? state.permissionMode,
        });
        const controlled = resolvedSkill === undefined ? undefined : captureSkillRequest(resolvedSkill);
        const legacy = captureSkillRequest({ args: activation.args === '' ? undefined : activation.args,
          user_input: userInput, attachments: activation.attachments });
        let accepted = false;
        let prepared = false;
        let flight: Promise<void> | undefined;
        const submitCapturedSkill = (): Promise<void> | undefined => {
          if (!composerOwnerActive.current || accepted) return;
          if (flight !== undefined) return flight;
          flight = activateSkillWithConditionalClear({
            prepare: async () => {
              if (!prepared && goalObjectiveOverride !== undefined && goalObjectiveOverride !== '') {
                await client.updateSessionProfile(sessionId, { agent_config: { goal_objective: goalObjectiveOverride } });
              }
              prepared = true;
            },
            activate: async () => {
              if (controlled === undefined) await client.activateSkill(sessionId, name, legacy);
              else {
                await controller.sendPrompt({ promptId: controlled.prompt_id, text: submitted.draft,
                  content: controlled.content, skills: controlled.skills, profile: controlled.profile,
                  execution: controlled.execution, model: controlled.model, thinking: controlled.thinking,
                  modelSwitchMode: controlled.model_switch_mode, permissionMode: controlled.permission_mode });
                completeSkillControlSelection({ controlled, capturedSelection: skillSelection,
                  currentSelection: skillSelectionRef.current, binding: { model: sessionModel, thinking: state.thinkingEffort },
                  preserveBindingChange: (change) => { skillBindingChangeRef.current = change; },
                  clear: () => {
                    setPendingProfile(undefined);
                    setPendingExecution(undefined);
                    setModelOverride(undefined);
                    setEffortOverride(undefined);
                    clearTouchedControls();
                  },
                  refresh: () => { void controller.refreshSession(); },
                });
              }
              accepted = true;
            },
            submitted,
            current: () => ({ draft: draftRef.current, attachments: attachmentsRef.current }),
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
                  : error instanceof Error ? error.message : String(error);
            pushToast({
              tone: 'error', text,
              code: isApi ? error.code : undefined,
              requestId: isApi ? error.requestId : undefined,
              detail: error instanceof Error ? error.stack : undefined,
              retry: { run: () => { void submitCapturedSkill(); } },
            });
          }).finally(() => { flight = undefined; });
          return flight;
        };
        return submitCapturedSkill();
      },
      abort: () =>
        controller.abortActive().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : t('sv.abortFailed');
          pushAbortFailureToast(controller, `${message}${t('sv.abortStillRunning')}`);
          // Not rethrown: the sticky toast (with retry) carries the failure.
        }),
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
      editQueued: (promptId: string, text: string, media: readonly MessageContent[], presentation?: import('@kiki/transcript').TextPresentation) =>
        controller.replaceQueued(promptId, text, media, presentation).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.editQueuedFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
          throw error;
        }),
      sendNowQueued: (promptId: string) => {
        return controller.steerQueued(promptId).then((delivery) => {
          if (delivery.outcome === 'queued') pushToast({ tone: 'info', text: t(sendNowQueuedNotice(delivery.reason)) });
          else if (delivery.outcome === 'not_pending') pushToast({ tone: 'info', text: t('sv.steerQueuedNotPending') });
        }).catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('sv.steerQueuedFailed', {
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        });
      },
      clearQueue: async () => {
        // Clear the same mixed objects the strip counts, using existing commands.
        const switches = modelSwitches.switches.filter((entry) => entry.queueIndex >= 0);
        const [prompts, cancelled] = await Promise.all([
          controller.clearQueue(),
          Promise.allSettled(switches.map((entry) =>
            client.cancelAgentModelSwitch(sessionId, MAIN_AGENT_ID, entry.input.operationId),
          )),
        ]);
        if (switches.length > 0) modelSwitches.refresh();
        const result = {
          total: prompts.total + switches.length,
          failed: prompts.failed + cancelled.filter((entry) => entry.status === 'rejected').length,
        };
        if (result.failed > 0) {
          pushToast({
            tone: 'error',
            text: t('sv.queueClearFailed', { failed: result.failed, total: result.total }),
          });
        }
        return result;
      },
    };
  }, [
    controller,
    client,
    effectiveModel,
    effectiveEffort,
    pendingProfile,
    boundProfile,
    modelTouched,
    effortTouched,
    modelChoice,
    effortChoice,
    composerSelection.modelChoice,
    composerSelection.effortChoice,
pendingExecution,
boundExecution,
    permissionOverride,
    state.permissionMode,
    sessionModel,
    state.thinkingEffort,
    clearTouchedControls,
    skillSelection,
    planMode,
    planGate,
    liveSettings.defaultAppendTiming,
    modelSwitches.switches,
    modelSwitches.refresh,
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
      refreshSessions: () => {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        invalidatePersonaSessionLists(queryClient);
      },
      navigate,
    }),
    [client, host, queryClient, navigate],
  );

  // Same bare-title patch the sidebar's rename dialog sends: omitting
  // `metadata` leaves the stored custom document (pins included) alone.
  const renameSession = useCallback(
    async (title: string) => {
      try {
        const updated = await client.updateSessionProfile(sessionId, { title });
        const mergeUpdated = (existing: Session): Session => ({
          ...existing,
          ...(updated !== null && typeof updated === 'object' && 'id' in updated ? updated : undefined),
          title,
        });
        queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
          old === undefined || !Array.isArray(old.pages)
            ? old
            : {
                ...old,
                pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
                  ...page,
                  items: page.items.map((item) => (item.id === sessionId ? mergeUpdated(item) : item)),
                })),
              },
        );
        if (queryClient.getQueryData(['session', sessionId]) !== undefined) {
          queryClient.setQueryData<Session>(['session', sessionId], (old) =>
            old === undefined ? old : mergeUpdated(old),
          );
        }
        // Cache was already patched in-place above and WS session.metaUpdated
        // reconciles; avoid invalidating all ['sessions'] pages/pinned scans.
      } catch (error: unknown) {
        pushToast({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        // Reported above; rethrown so the header drops the name it showed early.
        throw error;
      }
    },
    [client, queryClient, sessionId, actionContext],
  );

  const pendingPrivacyRef = useRef(new Set<string>());
  const [pendingPrivacy, setPendingPrivacy] = useState<ReadonlySet<string>>(() => new Set());

  const toggleSessionPrivate = useCallback(() => {
    const record = state.session;
    if (record === undefined || pendingPrivacyRef.current.has(sessionId)) return;
    pendingPrivacyRef.current.add(sessionId);
    setPendingPrivacy((current) => new Set(current).add(sessionId));
    const nextPrivate = record.private !== true;
    void client.updateSession(sessionId, { private: nextPrivate })
      .then((updated) => {
        queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
          old === undefined || !Array.isArray(old.pages)
            ? old
            : {
                ...old,
                pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
                  ...page,
                  items: page.items.map((item) => (item.id === sessionId ? { ...item, ...updated, private: nextPrivate } : item)),
                })),
              },
        );
        if (queryClient.getQueryData(['session', sessionId]) !== undefined) {
          queryClient.setQueryData<Session>(['session', sessionId], (old) =>
            old === undefined ? old : { ...old, ...updated, private: nextPrivate },
          );
        }
        actionContext.refreshSessions();
        void queryClient.invalidateQueries({ queryKey: ['global-search'] });
        void controller?.refreshSession();
        pushToast({ tone: 'success', text: t(nextPrivate ? 'private.madeToast' : 'private.exitedToast') });
      })
      .catch((cause: unknown) => {
        pushToast({ tone: 'error', text: t('private.updateFailed', { detail: errorText(locale, cause) }) });
      })
      .finally(() => {
        pendingPrivacyRef.current.delete(sessionId);
        setPendingPrivacy((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      });
  }, [actionContext, client, controller, locale, queryClient, sessionId, state.session, t]);

  // One state fact for manual compaction: the receipt seeds it and live events
  // advance it. The composer meter renders it; a toast only stands in when no
  // meter is on screen to carry the state.
  const [manualCompactSessionId, setManualCompactSessionId] = useState<string>();
  const compactionActiveSessionId =
    manualCompactSessionId === sessionId ||
    state.busy ||
    (state.transcriptReady && state.historyRead?.source !== 'cold' && state.cursor.epoch?.startsWith('cold:') !== true)
      ? sessionId
      : undefined;
  const { progress: compactionProgress, seed: seedCompactionProgress } = useCompactionProgress(client, compactionActiveSessionId);
  const compactionHintShownRef = useRef(false);

  const [forkPopoverOpenRequest, setForkPopoverOpenRequest] = useState<{
    readonly seq: number;
    readonly focusBranch?: boolean;
  } | undefined>(undefined);
  const openForkPopover = useCallback((focusBranch = false) => {
    setForkPopoverOpenRequest((current) => ({ seq: (current?.seq ?? 0) + 1, focusBranch }));
  }, []);
  const [forkingSession, setForkingSession] = useState(false);
  const handleForkSessionWithSeed = useCallback(
    (seed: SessionSeedMode) => {
      const record = state.session;
      if (record === undefined || forkingSession) return;
      setForkingSession(true);
      void forkSession(actionContext, record, { seed })
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }),
          });
        })
        .finally(() => {
          setForkingSession(false);
        });
    },
    [actionContext, forkingSession, locale, state.session, t],
  );

  const runSessionAction = useCallback(
    (action: 'fork' | 'undo' | 'compact' | 'export' | 'fresh-context') => {
      const record = state.session;
      if (record === undefined) return;
      if (action === 'undo') {
        setConfirmUndo(true);
        return;
      }
      if (action === 'fresh-context') {
        // Same-model fresh: keep the current model, start a new context. The
        // preference decides whether the panel asks first.
        if (currentBoundModel !== undefined) openModelSwitchPanel(currentBoundModel, 'fresh');
        return;
      }
      if (action === 'fork') {
        openForkPopover(false);
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
      } else if (harnessNativeCompact && actions !== null) {
        void Promise.resolve(actions.send(formatExternalCompactPrompt(), []))
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }),
            });
          });
      } else {
        setManualCompactSessionId(sessionId);
        void compactSessionContext(actionContext, record)
          .then((receipt) => {
            const outcome = compactReceiptOutcome(receipt);
            if (outcome === 'duplicate') { pushToast({ tone: 'info', text: t('context.compaction.manual.duplicate') }); return; }
            seedCompactionProgress(receipt);
            if (outcome === 'requested' || !compactionHintShownRef.current) pushToast({ tone: 'success', text: t(outcome === 'requested' ? 'action.compactRequestedSession' : `context.compaction.manual.${outcome}`) });
          })
          .catch((error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }),
            });
          });
      }
    },
    [actionContext, actions, harnessNativeCompact, sessionId, state.session, t, locale, currentBoundModel, openModelSwitchPanel, seedCompactionProgress, openForkPopover],
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

  // ---- message-closure row actions (edit-resend / regenerate / fork) ----

  const loadMessageEditAttachments = useCallback(async (block: Pick<UserBlock, 'queuedContent' | 'media'>, signal?: AbortSignal): Promise<readonly ComposerAttachment[]> => {
    signal?.throwIfAborted();
    const mediaItems = block.queuedContent === undefined ? block.media ?? [] : mediaFromContentParts(block.queuedContent);
    const retained = block.queuedContent === undefined ? [] : retainedAttachmentsFromContent(block.queuedContent);
    return Promise.all(mediaItems.map(async (item, index): Promise<ComposerAttachment> => {
      let media = item;
      const existing = retained[index];
      if (existing !== undefined && (existing.content.type === 'image' || existing.content.type === 'video')) {
        const source = existing.content.source;
        if (source.kind === 'base64') return existing;
      }
      let url = media.blobHash === undefined ? media.url : `blobref:${media.mime};${media.blobHash}`;
      let fileId = media.fileId;
      if (media.detail !== undefined) {
        const detail = await client.klient.session(sessionId).view.transcript.detail?.({
          agentId: media.detail.agentId, kind: 'attachment', id: media.detail.attachmentId,
        }, { signal });
        signal?.throwIfAborted();
        if (detail?.kind !== 'attachment' || detail.attachment.source === undefined) throw new Error(t('preview.failed'));
        const source = detail.attachment.source;
        if (source.kind === 'url') url = source.url;
        else fileId = source.fileId;
        media = mediaRefWithAttachmentDetail(media, detail.attachment);
      }
      if (media.kind === 'file') {
        if (fileId === undefined) throw new Error(t('preview.failed'));
        return existing ?? { kind: 'retained', name: media.name ?? fileId, content: { type: 'file', file_id: fileId, name: media.name ?? fileId, media_type: media.mime ?? 'application/octet-stream', size: media.size ?? 0 } };
      }
      if (url !== undefined && url.startsWith('data:')) {
        return existing ?? {
          kind: 'retained',
          name: media.name ?? media.kind,
          content: { type: media.kind, name: media.name, source: { kind: 'url', url } },
          previewUrl: url,
        };
      }
      const blob = /^blobref:([^;]+);([0-9a-f]{64})$/.exec(url ?? '');
      const originalId = blob === null ? fileId : `blobref:main:${blob[2]}`;
      if (originalId !== undefined) {
        const baseRetained: RetainedAttachment = existing ?? {
          kind: 'retained',
          name: media.name ?? media.kind,
          content: { type: media.kind, name: media.name, source: url !== undefined ? { kind: 'url', url } : { kind: 'session_media', file_id: fileId! } },
        };
        try {
          const preview = await client.readSessionMediaPreviewBytes(sessionId, originalId, { ...client.readingOptions(), signal, mediaType: media.mime ?? blob?.[1] });
          signal?.throwIfAborted();
          const image = await fileToImageAttachment(new File([preview.bytes as Uint8Array<ArrayBuffer>], media.name ?? media.kind, { type: preview.mime }));
          signal?.throwIfAborted();
          return { ...baseRetained, previewUrl: image.previewUrl };
        } catch (error: unknown) {
          signal?.throwIfAborted();
          if (!isMediaPreviewUnavailable(error)) throw error;
          return baseRetained;
        }
      }
      if (url === undefined && fileId === undefined) throw new Error(t('preview.failed'));
      if (existing !== undefined) return existing;
      return {
        kind: 'retained', name: media.name ?? media.kind,
        content: { type: media.kind, name: media.name, source: url !== undefined ? { kind: 'url', url } : { kind: 'session_media', file_id: fileId! } },
      };
    }));
  }, [client, sessionId, t]);
  const handleEditMessage = useCallback(
    async (block: UserBlock, text: string, editedAttachments: readonly ComposerAttachment[] = [], presentation?: import('@kiki/transcript').TextPresentation) => {
      if (controller === null || block.userMessageId === undefined) return;
      const content = buildPromptContent(text, editedAttachments, presentation);
      if (content === null) return;
      try {
        await controller.editMessage(block.userMessageId, { text, content });
      } catch (error: unknown) {
        pushToast({
          tone: 'error',
          text: t('action.editFailed', { detail: sessionActionErrorText(locale, error) }),
        });
        throw error;
      }
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

  const pendingMessageForkRef = useRef(false);
  const [forkingMessage, setForkingMessage] = useState(false);
  const handleForkMessage = useCallback(
    (block: UserBlock | AssistantBlock, seed?: SessionSeedMode): Promise<void> | undefined => {
      if (controller === null || pendingMessageForkRef.current) return undefined;
      pendingMessageForkRef.current = true;
      setForkingMessage(true);
      return (async () => {
        const messageId =
          block.kind === 'user'
            ? block.userMessageId
            : await resolveAssistantMessageId(block);
        if (messageId === undefined) {
          pushToast({ tone: 'error', text: t('error.messageActionUnavailable') });
          return;
        }
        // Open-tail fork: navigate only — nothing auto-runs in the copy.
        const fork = await controller.forkFromMessage(messageId, seed);
        queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined);
        invalidatePersonaSessionLists(queryClient);
        pushToast({ tone: 'success', text: t('action.forkDoneSession') });
        void navigate(placeSessionPath(connectionId, fork.id));
      })()
        .catch((error: unknown) => {
          pushToast({
            tone: 'error',
            text: t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }),
          });
        })
        .finally(() => {
          pendingMessageForkRef.current = false;
          setForkingMessage(false);
        });
    },
    [controller, resolveAssistantMessageId, queryClient, navigate, connectionId, t, locale],
  );

  const transcriptRowActions = useMemo<TranscriptRowActions>(
    () => ({
      disabled: state.busy || state.resyncing || state.resyncFailed,
      onEditMessage: handleEditMessage,
      loadEditAttachments: loadMessageEditAttachments,
      onRegenerate: handleRegenerate,
      onFork: handleForkMessage,
      forkBusy: forkingMessage,
      canFork: composerEngine?.fork !== false,
      // Resume after a user stop re-runs the stopped reply (same path as regenerate).
      onResumeStopped: handleRegenerate,
    }),
    [state.busy, state.resyncing, state.resyncFailed, handleEditMessage, loadMessageEditAttachments, handleRegenerate, handleForkMessage, forkingMessage, composerEngine?.fork],
  );

  const [btwSessionKeys, setBtwSessionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const forestRaw = useMemo(() => {
    const raw = controller?.getForest() ?? sessionAgentForest(state);
    if (btwSessionKeys.size === 0) return raw;
    const prefix = `${sessionId}:`;
    let patchedById: Record<string, (typeof raw.byId)[string]> | undefined;
    for (const key of btwSessionKeys) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const node = raw.byId[id];
      if (node !== undefined && node.branchSealed !== true && node.toolsLocked !== true) {
        patchedById ??= { ...raw.byId };
        patchedById[id] = {
          ...node,
          isBranch: true,
          toolsLocked: true,
          label: 'BTW',
        };
      }
    }
    if (patchedById === undefined) return raw;
    return {
      byId: patchedById,
      roots: raw.roots.map((root) => patchedById[root.agentId] ?? root),
    };
  }, [btwSessionKeys, controller, sessionId, state]);
  // Content-stabilized forest: rebuilt per publish above, but identical in
  // content across streaming deltas — keep the previous object so downstream
  // derivations (mainTranscriptBlocks) and Transcript's row/page memos are
  // not broken by unrelated state publishes.
  const forest = useStableForest(forestRaw);

  // Opening an agent as a preview tab keeps the page; the two branches that
  // swap the page for another visit ask the dirty guard first, so an unsaved
  // preview buffer is never dropped silently.
  const navigateVisits = useGuardedNavigate();

  // Route-shell seams for the agent workspace: back-to-session and the
  // route-level agent open (the spawn jump-back and the preview tab's "open in
  // page" — returning via POP when main was the immediate previous visit keeps
  // main's exact scroll snapshot).
  const openSession = useCallback(() => {
    const sessionPath = placeSessionPath(connectionId, sessionId);
    const back = getBackEntry();
    if (back !== null && back.pathname === sessionPath && back.search === '' && back.hash === '') {
      void navigate(-1);
      return;
    }
    void navigateVisits(sessionPath);
  }, [connectionId, navigate, navigateVisits, sessionId]);

  const openAgent = useCallback(
    (agentId: string) => {
      if (agentId === MAIN_AGENT_ID) {
        openSession();
        return;
      }
      const node = forest.byId[agentId];
      const isBranch = node?.isBranch === true || node?.branchSealed === true;
      const mode = liveSettings.subagentPanelOpenMode;
      if (isBranch || mode === 'fullscreen' || previewRef.current === null) {
        void navigateVisits(agentDetailPath(sessionId, agentId, connectionId));
        return;
      }
      const title = node?.label ?? agentId;
      previewRef.current.openAgentPanel(agentId, title);
    },
    [connectionId, forest, liveSettings.subagentPanelOpenMode, navigateVisits, openSession, sessionId],
  );
  // `/btw` and the header's "Side question": fork a tool-less side agent from
  // the main context and anchor a compact ephemeral floating card right above
  // the main Composer so the main turn and any right-hand file preview stay
  // completely untouched.
  const [sideQuestionPending, setSideQuestionPending] = useState(false);
  const [activeBtw, setActiveBtw] = useState<{
    readonly sessionId: string;
    readonly agentId: string;
    readonly sendingInitial: boolean;
  } | null>(null);
  const shownBtw = activeBtw?.sessionId === sessionId ? activeBtw : null;
  const btwSeqRef = useRef(1);
  const handleSendBtwQuestion = useCallback(
    async (agentId: string, text: string) => {
      const seq = ++btwSeqRef.current;
      try {
        await client.sendAgentMessage(sessionId, agentId, text, undefined, `btw-${agentId}-${seq}`);
      } catch (error) {
        pushToast({ tone: 'error', text: t('btw.failed', { detail: sessionActionErrorText(locale, error) }) });
        throw error;
      }
    },
    [client, locale, sessionId, t],
  );
  const startSideQuestion = useCallback((question?: string) => {
    if (sideQuestionPending) return;
    setSideQuestionPending(true);
    void (async () => {
      let createdAgentId: string | undefined;
      try {
        const agentId = await client.startSideQuestion(sessionId);
        createdAgentId = agentId;
        setBtwSessionKeys((prev) => {
          const key = `${sessionId}:${agentId}`;
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        (client as { noteNativeAgent?: (sid: string, aid: string) => void }).noteNativeAgent?.(sessionId, agentId);
        const text = question?.trim() ?? '';
        setActiveBtw({ sessionId, agentId, sendingInitial: text !== '' });
        if (text !== '') {
          await client.sendAgentMessage(sessionId, agentId, text, undefined, `btw-${agentId}-1`);
        }
        void controller?.resync();
      } catch (error) {
        pushToast({ tone: 'error', text: t('btw.failed', { detail: sessionActionErrorText(locale, error) }) });
      } finally {
        if (createdAgentId !== undefined) {
          setActiveBtw((current) =>
            current !== null && current.agentId === createdAgentId
              ? { ...current, sendingInitial: false }
              : current,
          );
        }
        setSideQuestionPending(false);
      }
    })();
  }, [client, controller, locale, sessionId, sideQuestionPending, t]);

  const [branchPending, setBranchPending] = useState(false);
  const startBranch = useCallback(
    (task?: string, seed: SessionSeedMode = 'verbatim', openMode: 'route' | 'split' = 'route') => {
      if (branchPending) return;
      if (task === undefined) {
        openForkPopover(true);
        return;
      }
      setBranchPending(true);
      void (async () => {
        try {
          const cleanTask = task.trim();
          const created = await client.createBranch(sessionId, {
            seed,
            tools_locked: false,
            task: cleanTask === '' ? undefined : cleanTask,
            title: cleanTask === '' ? undefined : cleanTask.slice(0, 64),
          });
          await controller?.resync();
          const title = cleanTask === '' ? t('branch.tabTitle') : cleanTask.slice(0, 48);
          if (openMode === 'split' && previewRef.current !== null) {
            previewRef.current.openAgentPanel(created.agent_id, title);
            focusAgentTabWhenMounted(created.agent_id);
          } else {
            void navigateVisits(agentDetailPath(sessionId, created.agent_id, connectionId));
          }
        } catch (error) {
          pushToast({ tone: 'error', text: t('branch.failed', { detail: sessionActionErrorText(locale, error) }) });
        } finally {
          setBranchPending(false);
        }
      })();
    },
    [branchPending, client, connectionId, controller, locale, navigateVisits, openForkPopover, sessionId, t],
  );
  const openForkSession = useCallback(
    (targetSessionId: string) => {
      if (targetSessionId !== '' && targetSessionId !== sessionId) {
        void navigateVisits(placeSessionPath(connectionId, targetSessionId));
      }
    },
    [connectionId, navigateVisits, sessionId],
  );
  const openAgentRoute = useCallback(
    (agentId: string) => {
      const path = agentDetailPath(sessionId, agentId, connectionId);
      if (location.pathname !== path) void navigateVisits(path);
    },
    [connectionId, location.pathname, navigateVisits, sessionId],
  );
  const agentWorkspaceNavigation = useMemo<AgentWorkspaceNavigation>(
    () => ({
      openAgent,
      openAgentRoute,
      openSession,
      openProviderSettings: () => { void navigate('/settings/providers'); },
      sharedRail: {
        open: railOpen,
        toggle: toggleRail,
        close: closeRail,
        available: railAvailable,
        yielded: dockedRailYielded,
        ensureDockedOpen: ensureDockedRailOpen,
      },
    }),
    [
      navigate,
      openAgent,
      openAgentRoute,
      openSession,
      railOpen,
      toggleRail,
      closeRail,
      railAvailable,
      dockedRailYielded,
      ensureDockedRailOpen,
    ],
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
    () => countPendingInteractions(panelAgentState.blocks),
    [panelAgentState.blocks],
  );
  const handlePanelFocusJumpToSpawn = useCallback(() => {
    if (panelFocusAgent === undefined) return;
    const parentId = forest.byId[panelFocusAgent]?.parentAgentId ?? panelFocusBlock?.parentAgentId;
    // Both branches name the same thing — the parent's timeline AND this
    // child's spawning card — and both are one explicit visit, so the arrow
    // returns to what the reader was looking at before the jump.
    const spawn = locateSpawnTarget(sessionId, panelFocusAgent, parentId ?? MAIN_AGENT_ID);
    navigateTimeline(spawn.target, { ...spawn.options, route: spawn.route });
  }, [panelFocusAgent, panelFocusBlock, forest, navigateTimeline, sessionId]);
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

  // Transcript's prop type predates the queue strip and wants a void return:
  // hand it a memoized fire-and-forget view of the same action.
  const handleCancelQueuedChips = useCallback(
    (promptId: string) => { void mainTimelineActions.cancelQueued(promptId); },
    [mainTimelineActions.cancelQueued],
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
  // The composer header counts what the user is waiting to send. A scheduled
  // prompt held ahead of that order (`idle`/`steer`) is named separately so it
  // cannot read as one more of their own messages, but it keeps a row in the
  // opened detail — its text is real work waiting to be read.
  const ordinaryQueuedItems = useMemo(() => queuedItems.filter(isOrdinaryQueueItem), [queuedItems]);
  const heldCronItems = useMemo(() => queuedItems.filter((item) => !isOrdinaryQueueItem(item)), [queuedItems]);
  const queuedItemCount = ordinaryQueuedItems.length + modelSwitches.switches.filter((entry) => entry.queueIndex >= 0).length;
  const queueRowCount = queuedItems.length + modelSwitches.switches.filter((entry) => entry.queueIndex >= 0).length;
  const promptCoverage = state.globalCoverage?.prompts;
  const promptEntityLoad = state.detailLoads['entities:prompt'];
  const hasPromptContinuation = promptCoverage !== undefined && (promptCoverage.hasMore || promptEntityLoad !== undefined);
  const handleLoadPromptEntities = useCallback(() => { void controller?.loadTranscriptEntities(MAIN_AGENT_ID, 'prompt'); }, [controller]);
  const handleRemoveQueuedAttachment = useCallback((promptId: string, attachmentIndex: number) => {
    const item = queuedItems.find((entry) => entry.promptId === promptId);
    if (controller === null || item?.content === undefined) return Promise.resolve();
    const replacement = removeQueuedAttachment(item.content, attachmentIndex);
    return controller.replaceQueued(promptId, replacement.text, replacement.media, replacement.presentation)
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('sv.editQueuedFailed', { detail: error instanceof Error ? error.message : String(error) }),
        });
      });
  }, [controller, queuedItems, t]);
  // Queue edit round-trip: "edit" parks the queued text in the composer
  // (remembering the in-progress draft, quote and notes); confirm replaces it
  // in place via actions.editQueued, cancel/remove hand the saved state back.
  const handleStartQueueEdit = useCallback(
    (promptId: string) => {
      if (queueEditRef.current !== null || controller === null) return;
      const item = queuedItems.find((entry) => entry.promptId === promptId);
      const block = state.blocks.find(
        (candidate): candidate is UserBlock => candidate.kind === 'user' && candidate.promptId === promptId,
      );
      if (item === undefined || (item.text === '' && (item.media?.length ?? 0) === 0)) return;
      const pathFileMentions = (block?.media ?? item.media ?? []).flatMap((media) => {
        const mention = fileMentionFromPathMedia(media);
        return mention === undefined ? [] : [mention];
      });
      let initialAttachments = retainedAttachmentsFromContent(item.content ?? []);
      const abort = new AbortController();
      const incomplete = controller.contentRefsFor(MAIN_AGENT_ID, { kind: 'prompt', id: promptId }).some((ref) => ref.path[0] === 'content') === true;
      const original = { text: block?.text ?? item.text, presentation: block?.presentation ?? contentTextPresentation(item.content ?? [], '\n\n') };
      const carryovers = parseSelectionCarryovers(original.text, original.presentation);
      const startingAttachments = [...initialAttachments, ...pathFileMentions];
      const edit = {
        promptId, owner: randomUuid(), abort, loading: incomplete, loadError: false,
        attachments: startingAttachments,
        initialAttachments: startingAttachments,
        initialBody: carryovers.body,
        savedDraft: draftRef.current,
        savedAnnotations: draftSelectionsRef.current,
        original,
      };
      queueEditRef.current = edit;
      setQueueEdit(edit);
      updateDraft(carryovers.body);
      const annotationsFromCarryovers = (selections: typeof carryovers.selections) => selections.reduce<readonly SelectionAnnotation[]>(
        (current, note) => addAnnotation(current, note.quote, note.comment, note.source), [],
      );
      setAnnotations(annotationsFromCarryovers(carryovers.selections));
      const ownsEdit = () => !abort.signal.aborted && composerOwnerActive.current && sessionIdRef.current === sessionId && queueEditRef.current?.owner === edit.owner;
      void (async () => {
        try {
          const content = incomplete ? await controller.readQueuedPromptContent(promptId, abort.signal) : item.content ?? [];
          abort.signal.throwIfAborted();
          if (!ownsEdit()) return;
          if (content === undefined) throw new Error(t('preview.failed'));
          if (incomplete) {
            const completeAttachments = retainedAttachmentsFromContent(content);
            const previous = initialAttachments;
            const loadedOriginal = { text: content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n'), presentation: contentTextPresentation(content, '\n\n') };
            const complete = parseSelectionCarryovers(loadedOriginal.text, loadedOriginal.presentation);
            setQueueEdit((current) => current?.owner !== edit.owner ? current : {
              ...current,
              loading: false,
              original: loadedOriginal,
              initialBody: complete.body,
              attachments: mergeLoadedAttachments(current.attachments, completeAttachments, previous),
              initialAttachments: mergeLoadedAttachments(current.initialAttachments, completeAttachments, previous),
            });
            initialAttachments = completeAttachments;
            updateDraft(complete.body);
            setAnnotations(annotationsFromCarryovers(complete.selections));
          }
          const loaded = await loadMessageEditAttachments({ queuedContent: [...content] }, abort.signal).catch((error: unknown) => {
            abort.signal.throwIfAborted();
            if (ownsEdit()) pushToast({ tone: 'info', text: t('transcript.editAttachmentsLoadFailed'), detail: error instanceof Error ? error.message : String(error) });
            return undefined;
          });
          if (loaded !== undefined && ownsEdit()) setQueueEdit((current) => current?.owner !== edit.owner ? current : {
            ...current,
            attachments: mergeLoadedAttachments(current.attachments, loaded, initialAttachments),
            initialAttachments: mergeLoadedAttachments(current.initialAttachments, loaded, initialAttachments),
          });
        } catch (error: unknown) {
          if (!ownsEdit()) return;
          setQueueEdit((current) => current?.owner !== edit.owner ? current : { ...current, loading: false, loadError: true });
          pushToast({ tone: 'error', text: t('sv.editQueuedFailed', { detail: error instanceof Error ? error.message : String(error) }) });
        }
      })();
    },
    [queueEdit, queuedItems, state.blocks, updateDraft, controller, loadMessageEditAttachments, sessionId, t],
  );
  const updateQueueEditAttachments = useCallback((next: readonly ComposerAttachment[] | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[])) => {
    const owner = queueEdit?.owner;
    setQueueEdit((current) => current === null || current.owner !== owner || current.loading ? current : {
      ...current,
      attachments: typeof next === 'function' ? next(current.attachments) : next,
    });
  }, [queueEdit?.owner]);
  const handleQueueEditLeftQueue = useCallback((editedText?: string, editedAttachments?: readonly ComposerAttachment[]) => {
    const edit = queueEditRef.current;
    if (edit === null) return;
    edit.abort.abort();
    queueEditRef.current = null;
    setQueueEdit(null);
    const currentText = editedText ?? draftRef.current;
    const currentAttachments = editedAttachments ?? edit.attachments;
    const textModified = currentText.trim() !== edit.initialBody.trim();
    const addedAttachments = currentAttachments.filter((a) => !edit.initialAttachments.includes(a));
    const attachmentsModified =
      addedAttachments.length > 0 ||
      currentAttachments.length !== edit.initialAttachments.length ||
      currentAttachments.some((a, i) => a !== edit.initialAttachments[i]);
    if (textModified || attachmentsModified) {
      const mergedDraft = edit.savedDraft.trim() !== '' && currentText.trim() !== '' && edit.savedDraft !== currentText
        ? `${edit.savedDraft}\n\n${currentText}`
        : (currentText.trim() !== '' ? currentText : edit.savedDraft);
      updateDraft(mergedDraft);
      if (addedAttachments.length > 0) {
        setAttachments((current) => [...current, ...addedAttachments]);
      } else if (attachmentsModified && currentAttachments.length > 0) {
        setAttachments((current) => [...current, ...currentAttachments.filter((a) => !current.includes(a))]);
      }
      pushToast({
        tone: 'info',
        text: locale === 'zh'
          ? '原排队消息已开始执行或移出队列，你的修改已保留到输入框草稿中。'
          : 'The queued prompt already started or left the queue; your edits were kept in the draft.',
      });
      return;
    }
    updateDraft(edit.savedDraft);
    setAnnotations(edit.savedAnnotations);
  }, [updateDraft, locale]);
  const handleQueueEditConfirm = useCallback(
    (text: string, editedAttachments: readonly ComposerAttachment[], argumentPresentation?: import('@kiki/transcript').TextPresentation): Promise<void> => {
      const edit = queueEdit;
      if (edit === null || edit.loading || edit.loadError) return Promise.resolve();
      const exit = () => {
        if (!composerOwnerActive.current || queueEditRef.current?.owner !== edit.owner) return;
        edit.abort.abort();
        queueEditRef.current = null;
        setQueueEdit(null);
        updateDraft(edit.savedDraft);
        setAnnotations(edit.savedAnnotations);
      };
      const item = queuedItems.find((entry) => entry.promptId === edit.promptId);
      const carry = selectionCarryoverPresentation(draftSelectionsRef.current, []);
      const prepared = reconcileEditedThreadRefs(edit.original, { text, presentation: argumentPresentation });
      const presentation: import('@kiki/transcript').TextPresentation = {
        spans: [
          ...carry.presentation.spans,
          ...(prepared.presentation?.spans ?? []).map((span) => ({
            ...span,
            start: span.start + carry.prefix.length,
            end: span.end + carry.prefix.length,
          })),
        ],
      };
      const content = buildPromptContent(`${carry.prefix}${prepared.text}`, editedAttachments, presentation);
      if (item === undefined) {
        handleQueueEditLeftQueue(text, editedAttachments);
        return Promise.resolve();
      }
      if (actions === null || content === null) return Promise.resolve();
      const finalText = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
      const media = content.filter((part) => part.type !== 'text');
      return actions
        .editQueued(edit.promptId, finalText, media, contentTextPresentation(content, '\n\n'))
        .then(exit)
        .catch(() => undefined);
    },
    [queueEdit, queuedItems, actions, updateDraft, handleQueueEditLeftQueue],
  );
  const handleQueueEditCancel = useCallback(() => {
    const edit = queueEditRef.current;
    if (edit === null) return;
    edit.abort.abort();
    updateDraft(edit.savedDraft);
    setAnnotations(edit.savedAnnotations);
    queueEditRef.current = null;
    setQueueEdit(null);
  }, [updateDraft]);
  const handleQueueEditRemove = useCallback(() => {
    const edit = queueEditRef.current;
    if (edit === null) return;
    edit.abort.abort();
    queueEditRef.current = null;
    setQueueEdit(null);
    updateDraft(edit.savedDraft);
    setAnnotations(edit.savedAnnotations);
    void mainTimelineActions.cancelQueued(edit.promptId);
  }, [queueEdit, updateDraft, mainTimelineActions.cancelQueued]);
  const handleMoveQueued = useCallback(
    (promptId: string, targetIndex: number) =>
      controller?.moveQueued(promptId, targetIndex).then(() => {
        // Message moves also shift the control items' shared queue slots.
        if (modelSwitches.switches.some((entry) => entry.queueIndex >= 0)) modelSwitches.refresh();
      }).catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('queue.moveFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }) ?? Promise.resolve(),
    [controller, t, modelSwitches.switches, modelSwitches.refresh],
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
  // aborted from another surface), leave edit mode without discarding modified edits.
  useEffect(() => {
    if (queueEdit === null || !state.loaded) return;
    if (!state.queuedPromptIds.includes(queueEdit.promptId)) {
      handleQueueEditLeftQueue();
    }
  }, [queueEdit, state.loaded, state.queuedPromptIds, handleQueueEditLeftQueue]);
  // Edit hold: while a queued prompt sits in the composer for editing, the
  // engine must not launch it (nor anything queued behind it; prompts ahead
  // of it still run). The server lets an unrenewed hold lapse, so renew it
  // while the edit stays open; leaving the edit (save, cancel, remove, the
  // row vanishing) releases it and the queue resumes in order.
  const editHoldPromptId = queueEdit?.promptId;
  useEffect(() => {
    if (editHoldPromptId === undefined || controller === null) return;
    let active = true;
    let warned = false;
    let inFlight: Promise<unknown> = Promise.resolve();
    const hold = () => {
      if (!active) return;
      const flight = controller.holdQueued(editHoldPromptId, true).then((held) => {
        if (!active && held && queueEditRef.current?.promptId !== editHoldPromptId) {
          return controller.holdQueued(editHoldPromptId, false).catch(() => undefined);
        }
      }, () => {
        if (active && !warned) {
          warned = true;
          pushToast({
            tone: 'info',
            text: locale === 'zh'
              ? '未能暂停该排队消息，若当前轮次结束它可能提前发出（你的修改不会被清空）。'
              : 'Could not hold the queued prompt; if the current turn finishes it may run, while your edits stay safe.',
          });
        }
      });
      inFlight = flight;
    };
    hold();
    const renew = setInterval(hold, QUEUE_EDIT_HOLD_RENEW_MS);
    return () => {
      active = false;
      clearInterval(renew);
      void inFlight.finally(() => {
        if (queueEditRef.current?.promptId !== editHoldPromptId) {
          void controller.holdQueued(editHoldPromptId, false).catch(() => undefined);
        }
      });
    };
  }, [controller, editHoldPromptId, locale]);
  const retryPendingSubmission = useCallback((promptId: string) => {
    const pending = pendingRetryRef.current;
    if (pending?.id === promptId) pending.run();
  }, []);


  useEffect(() => {
    if (controller === null || actions === null) return;
    const handoff = {
      ...initialOptionsRef.current,
      initialPrompt: initialPromptRef.current,
      initialSkill: initialSkillRef.current,
    };
    const submission = resolveSessionCreateSubmission(handoff);
    if (submission === undefined) return;
    const record = firstMessageRef.current ?? {
      message: { ...handoff, initialPromptId: handoff.initialPromptId ?? `new-session:${sessionId}` },
      status: 'ready' as const,
    };
    firstMessageRef.current = record;
    writeFirstSessionMessage(scopeId, sessionId, record);
    initialSkillRef.current = undefined;
    initialPromptRef.current = undefined;
    initialOptionsRef.current = {};
    void navigate(location.pathname, { replace: true });
    const text = submission.kind === 'skill'
      ? submission.userInput ?? `/${submission.name}${submission.args === '' ? '' : ` ${submission.args}`}`
      : submission.text;
    if (draftRef.current === '') {
      updateDraft(stripThreadRefContext(text));
      updateAttachments(submission.attachments);
    }
    void actions.send(text, submission.attachments, {
      firstMessage: record,
      goalObjective: submission.goalObjective,
      personaGreetingReply: record.message.personaGreetingReply,
      presentation: submission.kind === 'prompt' ? submission.presentation : undefined,
      skills: submission.kind === 'prompt' ? submission.skills : undefined,
    });
  }, [controller, actions, scopeId, sessionId, location.pathname, navigate, updateDraft, updateAttachments]);

  // Away notifications from the live stream: the open session reports a new
  // approval / question or a turn that failed without waiting for the
  // list poll. The shared notifier only delivers while the window is in the
  // background, applies the per-kind switches and rate-limits per session,
  // so the list watcher reporting the same transition later stays quiet.
  const lastNotifiedInteractionRef = useRef<string | undefined>(undefined);
  const sessionTitle = state.session?.title ?? '';
  useEffect(() => {
    const pending = state.pendingInteraction;
    const previous = lastNotifiedInteractionRef.current;
    lastNotifiedInteractionRef.current = pending;
    if (pending === 'none' || pending === previous) return;
    const interaction = state.blocks.find((block): block is ApprovalBlock | QuestionBlock =>
      (pending === 'approval' && block.kind === 'approval' && block.resolution === undefined) ||
      (pending === 'question' && block.kind === 'question' && block.outcome === undefined));
    reportAttention([{ sessionId, kind: pending, title: sessionTitle,
      agentId: interaction?.originUnknown === true ? undefined : interaction?.originAgentId,
      interactionId: interaction?.originUnknown === true ? undefined : interaction?.id }]);
  }, [sessionId, sessionTitle, state.pendingInteraction, state.blocks]);
  // The first tail seen on open is history, not news.
  const lastTurnTailRef = useRef<string | null | undefined>(undefined);
  const turnTail = state.transcriptReady ? state.turnTail : undefined;
  useEffect(() => {
    if (!state.transcriptReady) return;
    const key = turnTail === undefined ? null : `${turnTail.turnId}:${turnTail.state ?? ''}`;
    const previous = lastTurnTailRef.current;
    lastTurnTailRef.current = key;
    if (previous === undefined || key === null || key === previous) return;
    if (turnTail?.state !== 'failed') return;
    reportAttention([{ sessionId, agentId: MAIN_AGENT_ID, turnId: turnTail.turnId, kind: turnTail.state, title: sessionTitle }]);
  }, [sessionId, sessionTitle, state.transcriptReady, turnTail]);

  const composerDisabled = controller === null || queueEdit?.loading === true;
  const modelSource: ModelSource = resolveModelSource(
    composerSelection.modelOverride,
    sessionModel,
    liveSettings.defaultModel,
    serverDefaultModel,
  );
  // The composer footer's mini meter reads the same usage fields as the rail.
  const usage = state.session?.usage;
  const usageError = state.session?.usage_error;
  const { used: contextUsed, limit: contextLimit } = resolveComposerContext(state, catalogItem?.max_context_size);
  compactionHintShownRef.current = contextUsed !== undefined && contextLimit !== undefined;
  const effectiveContextLimit = contextLimit ?? contextAutoCompact?.status.effectiveMaxContextTokens;

  // ---- conversation shell seat ----
  // The composer element is published into ConversationShell's seat (stable
  // tree position) instead of rendering here, so the textarea DOM node
  // survives the /new → /s/:id transition. The seat object MUST stay memoized
  // — the registration effect keys on identity — so every reactive value the
  // composer element reads is a dep below, and every handler is stabilized.
  const handleActivateSkill = useCallback(
    (name: string, args: string, skillAttachments: readonly ComposerAttachment[], userInput: string) => {
      revealOwnSend(false);
      return actions?.activateSkill(name, args, skillAttachments, undefined, userInput);
    },
    [actions, revealOwnSend],
  );
  const handleCompactContext = useCallback(() => { runSessionAction('compact'); }, [runSessionAction]);
  const handleRetryCompaction = useCallback((strategy: 'summarize' | 'relay') => {
    setManualCompactSessionId(sessionId);
    void client.compactSession(sessionId, { strategy })
      .then((receipt) => {
        const outcome = compactReceiptOutcome(receipt);
        if (outcome === 'duplicate') {
          pushToast({ tone: 'info', text: t('context.compaction.manual.duplicate') });
          return;
        }
        seedCompactionProgress(receipt);
        if (outcome === 'requested' || !compactionHintShownRef.current) {
          pushToast({
            tone: 'success',
            text: t(outcome === 'requested' ? 'action.compactRequestedSession' : `context.compaction.manual.${outcome}`),
          });
        }
      })
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
  }, [client, locale, seedCompactionProgress, sessionId, t]);
  const [recoveringInterruption, setRecoveringInterruption] = useState(false);
  const handleRecoverInterruption = useCallback(() => {
    if (recoveringInterruption || state.busy) return;
    setRecoveringInterruption(true);
    void client
      .recoverSession(sessionId)
      .then((receipt) => {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined);
        if (receipt?.status === 'nothing_to_recover') {
          void controller?.resync();
        }
      })
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: sessionActionErrorText(locale, error),
        });
      })
      .finally(() => {
        setRecoveringInterruption(false);
      });
  }, [client, controller, locale, queryClient, recoveringInterruption, sessionId, state.busy]);

  const handleContinueFailedTurn = useCallback(() => {
    if (state.busy || actions === null) return;
    revealOwnSend(false);
    void actions.send(locale === 'zh' ? '继续' : 'Continue', []);
  }, [actions, locale, revealOwnSend, state.busy]);
  const handleRetryFailedTurn = useCallback((failedUserBlock: UserBlock | undefined) => {
    if (state.busy || actions === null || failedUserBlock === undefined) return;
    if (failedUserBlock.userMessageId !== undefined && controller !== null) {
      void controller.regenerateMessage(failedUserBlock.userMessageId).catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('action.regenerateFailed', { detail: sessionActionErrorText(locale, error) }),
        });
      });
      return;
    }
    if (!canFaithfullyRetryUserBlock(failedUserBlock, false)) {
      const text = failedUserBlock.text.trim();
      if (text !== '') setDraft(text);
      return;
    }
    const text = failedUserBlock.text.trim();
    revealOwnSend(false);
    void actions.send(text, []);
  }, [actions, controller, locale, revealOwnSend, setDraft, state.busy, t]);
  const handleOpenModelPicker = useCallback(() => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-execution-trigger], [data-compact-model-trigger]');
    trigger?.focus();
    trigger?.click();
  }, []);
  const handleOpenProviderSettings = useCallback(() => {
    void navigate('/settings/providers');
  }, [navigate]);
  const handleCompactFromError = useCallback(() => {
    handleRetryCompaction('summarize');
  }, [handleRetryCompaction]);
  const handleComposerSend = useCallback(
    (
      text: string,
      composerAttachments: readonly ComposerAttachment[],
      options?: {
        readonly goalObjective?: string;
        readonly appendTiming?: DeferredAppendTiming;
        readonly presentation?: import('@kiki/transcript').TextPresentation;
        readonly skills?: readonly PromptSkillActivation[];
      },
    ) => {
      revealOwnSend(false);
      return actions?.send(text, composerAttachments, options);
    },
    [actions, revealOwnSend],
  );
  const handleComposerSendNow = useCallback(
    (
      text: string,
      composerAttachments: readonly ComposerAttachment[],
      presentation?: import('@kiki/transcript').TextPresentation,
      skills?: readonly PromptSkillActivation[],
    ) => {
      revealOwnSend(true);
      return actions?.send(text, composerAttachments, { now: true, presentation, skills });
    },
    [actions, revealOwnSend],
  );
  const handleComposerAbort = useCallback(() => {
    if (actions !== null) trackAbort(actions.abort());
  }, [actions, trackAbort]);

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
      actions: headerGoal.status === 'active' ? <GoalPauseButton onPause={handleGoalPause} /> : undefined,
      panel: (
        <GoalCard goal={headerGoal} onRefresh={handleGoalRefresh} onUpdate={handleGoalUpdate}
          onPause={handleGoalPause} onResume={handleGoalResume} onCancel={handleGoalCancel} />
      ),
    }
  ), [headerGoal, t, handleGoalRefresh, handleGoalUpdate, handleGoalPause, handleGoalResume, handleGoalCancel]);
  const composerBusy = canAbortActiveTurn(state);
  const recoveryHoldCount = state.promptQueueHold?.count ?? 0;
  const recoveryHold = recoveryHoldCount > 0;
  // The composer footer carries connection facts and actionable continuation only;
  // idle completed-history prompt caps stay out of the footer unless recovery
  // hold, held/failed durable ingress, or an explicit load error needs attention.
  const hasActionableDurableIngress = useMemo(
    () => mainDurableIngress?.some((item) => item.admission === 'held' || item.admission === 'failed') ?? false,
    [mainDurableIngress],
  );
  const showQueuePromptContinuation =
    hasPromptContinuation
    && promptCoverage !== undefined
    && (
      recoveryHold
      || hasActionableDurableIngress
      || promptEntityLoad !== undefined
      || queuedItems.length >= Math.max(1, promptCoverage.returned - (composerBusy ? 1 : 0))
    );
  const headerQueueSection = useMemo<ComposerHeaderSection | undefined>(() => {
    // A queued switch is a queue item too: the strip stays visible so its
    // control row can be changed or cancelled before it runs. A scheduled
    // prompt held ahead of the send order counts too — otherwise a session
    // waiting only on one would show nothing at all.
    if (queueRowCount === 0) return undefined;
    const idleCount = heldCronItems.filter((item) => !item.steerAccepted && item.cronDeliveryMode === 'idle').length;
    const total = queueRowCount - Math.max(0, idleCount - 1);
    const nextItem =
      heldCronItems.find((item) => item.steerAccepted || item.cronDeliveryMode === 'steer') ??
      heldCronItems[0] ??
      ordinaryQueuedItems[0];
    return {
      summary: (
        <QueueHeaderSummary
          count={queuedItemCount}
          heldCount={heldCronItems.length}
          first={nextItem === undefined ? undefined : {
            text: nextItem.text,
            presentation: nextItem.presentation,
            media: nextItem.media,
            timing: nextItem.appendTiming ?? 'agent_idle',
            cronDeliveryMode: nextItem.originKind === 'cron_job'
              ? (nextItem.steerAccepted ? 'steer' : nextItem.cronDeliveryMode)
              : undefined,
          }}
        />
      ),
      ariaLabel: t('composer.queueStack.openAria'),
      count: total,
      // The round-trip edit keeps its row (and the hold notice) in sight.
      forceOpen: queueEdit !== null,
      panel: (
        <TranscriptDetailProvider controller={controller ?? undefined} loads={state.detailLoads} contentRefs={state.contentRefs}
          sessionId={sessionId} agentId={MAIN_AGENT_ID}
          load={(agentId, kind, id) => controller?.loadTranscriptDetail(agentId, kind, id) ?? Promise.resolve(false)}
          loadContent={(ref) => controller?.loadContentSegment(MAIN_AGENT_ID, ref) ?? Promise.resolve(false)}>
        <QueueStrip
          items={queuedItems} onSendNow={handleSendNowQueued} onRemove={mainTimelineActions.cancelQueued}
          onRemoveAttachment={handleRemoveQueuedAttachment} onEdit={handleStartQueueEdit}
          onMove={handleMoveQueued} onChangeTiming={handleQueuedTiming}
          modelSwitches={modelSwitches.switches}
          queuedPromptMeta={state.queuedPromptMeta}
          resolveModelId={value => resolveCatalogModel(modelsQuery.data?.items ?? [], value)?.id ?? value}
          onEditModelSwitch={modelSwitchActions.edit} onCancelModelSwitch={modelSwitchActions.cancel}
          editingPromptId={queueEdit?.promptId} onClearAll={handleClearQueue}
          sendNowDisabled={state.resyncing || state.resyncFailed}
          sendNowUnavailable={nativeSteeringUnavailable ? t('harness.steerUnsupported') : undefined}
          timingReady={queueTimingReady}
          promptContinuation={showQueuePromptContinuation && promptCoverage !== undefined
            ? { coverage: promptCoverage, status: promptEntityLoad, onRequest: handleLoadPromptEntities }
            : undefined}
          agentRefTasks={state.tasks} onOpenAgent={openAgent}
        />
        </TranscriptDetailProvider>
      ),
    };
  }, [
    queuedItems, ordinaryQueuedItems, queuedItemCount, queueRowCount, heldCronItems, queueEdit, headerGoal, t, handleSendNowQueued, mainTimelineActions.cancelQueued,
    handleRemoveQueuedAttachment, handleStartQueueEdit, handleMoveQueued, handleQueuedTiming,
    handleClearQueue, state.resyncing, state.resyncFailed, queueTimingReady, nativeSteeringUnavailable,
    modelSwitches.switches, state.queuedPromptMeta, modelSwitchActions.edit, modelSwitchActions.cancel, modelsQuery.data,
    showQueuePromptContinuation, promptCoverage, promptEntityLoad, handleLoadPromptEntities,
    controller, sessionId, state.detailLoads, state.contentRefs, state.tasks, openAgent,
  ]);
  const composerHeader = useMemo(() => headerGoalSection === undefined && headerQueueSection === undefined ? undefined : (
    <ComposerHeader goal={headerGoalSection} queue={headerQueueSection} settled={state.loaded} />
  ), [headerGoalSection, headerQueueSection, state.loaded]);

  // Keep recovery controls mounted until the engine releases the queue hold.
  const [recoveryPending, setRecoveryPending] = useState(false);
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

  // Main-transcript projection, memoized so unrelated publishes don't rescan
  // the full block list; per-delta publishes reuse it when blocks/forest are
  // untouched.
  const mainTranscriptBlocks = useMemo(
    () => withAdmissionUserBlocks(
      withOptimisticUserBlock(filterBlocksToDirectChildren(state.blocks, forest, MAIN_AGENT_ID), pendingSubmission, MAIN_AGENT_ID),
      mainDurableIngress,
      MAIN_AGENT_ID,
    ),
    [state.blocks, forest, pendingSubmission, mainDurableIngress],
  );
  mainTranscriptBlocksRef.current = mainTranscriptBlocks;
  // One object per (state, blocks) pair, so the memoized timeline skips the
  // renders this component does for its own reasons (draft edits, clocks).
  const timelineState = useMemo(
    () => ({ ...state, blocks: mainTranscriptBlocks, durableIngress: mainDurableIngress }),
    [state, mainTranscriptBlocks, mainDurableIngress],
  );
  const retryOwnPending = useCallback((promptId: string) => {
    const pending = pendingRetryRef.current;
    if (pending?.id !== promptId || pendingSubmissionRef.current?.id !== promptId) return false;
    pending.run();
    return true;
  }, []);
  const admissionScope = useAdmissionScope({
    ingress: mainDurableIngress, agentId: MAIN_AGENT_ID, blocks: mainTranscriptBlocks, controller, retryPending: retryOwnPending,
  });
  // "Needs you": every pending approval/question in the session (main and
  // subagents) is answered in the composer card itself (it takes the input
  // over, see Composer `needsYou`); the timeline keeps one-line records
  // (InteractionPlacementContext) whose Review action focuses the item.
  const trayRef = useRef<NeedsYouTrayHandle>(null);
  const trayItems = useMemo(
    () => state.blocks.filter(
      (block): block is ApprovalBlock | QuestionBlock =>
        (block.kind === 'approval' && block.resolution === undefined) ||
        (block.kind === 'question' && block.outcome === undefined),
    ),
    [state.blocks],
  );
  const waitingBranchAgentIds = useMemo(() => collectWaitingAgentIds(trayItems), [trayItems]);
  const sessionForks = useMemo(
    () =>
      buildSessionForkItems({
        currentSessionId: sessionId,
        currentSession: state.session,
        sessions,
        untitledLabel: t('sidebar.untitled'),
      }),
    [sessionId, state.session, sessions, t],
  );
  const hasTimelineBranches = useMemo(
    () => hasActiveOrMergedBranches(forest, waitingBranchAgentIds),
    [forest, waitingBranchAgentIds],
  );
  const emptyForkLineage = useMemo<SessionForkLineage>(
    () => ({
      origin: sessionForks.origin,
      allOffshoots: [],
      byBlockId: new Map(),
    }),
    [sessionForks.origin],
  );
  const hasAnyOffshoots = sessionForks.forkItems.length > 0 || hasTimelineBranches;
  const offshootBlocks = hasAnyOffshoots ? timelineState.blocks : undefined;
  const forkLineage = useMemo(
    () =>
      offshootBlocks === undefined
        ? emptyForkLineage
        : buildSessionForkLineage({
            currentSessionId: sessionId,
            currentSession: state.session,
            sessions: [],
            sessionForks,
            forest,
            waitingAgentIds: waitingBranchAgentIds,
            blocks: offshootBlocks,
            hasOlder: timelineState.hasMoreHistory,
            untitledLabel: t('sidebar.untitled'),
          }),
    [
      offshootBlocks,
      emptyForkLineage,
      sessionId,
      state.session,
      sessionForks,
      forest,
      waitingBranchAgentIds,
      timelineState.hasMoreHistory,
      t,
    ],
  );
  const handleBranchHead = useCallback(
    (seed?: SessionSeedMode) => {
      startBranch('', seed ?? 'verbatim', 'route');
    },
    [startBranch],
  );
  const transcriptRowActionsWithBranch = useMemo<TranscriptRowActions>(
    () => ({
      ...transcriptRowActions,
      onBranchHead: composerEngine?.fork === false ? undefined : handleBranchHead,
    }),
    [transcriptRowActions, composerEngine?.fork, handleBranchHead],
  );
  const trayAgentNames = useMemo(() => {
    if (trayItems.length === 0 || forest === undefined) return EMPTY_TRAY_AGENT_NAMES;
    const names = new Map<string, string>();
    for (const item of trayItems) {
      const origin = item.originAgentId;
      if (origin === undefined || names.has(origin)) continue;
      const node = forest.byId[origin];
      if (node !== undefined) names.set(origin, node.label);
    }
    return names;
  }, [forest, trayItems]);
  const searchSubagents = useMemo(() => resolveControllerSubagentSearch(controller), [controller]);
  // A Review action (rail, timeline record) takes the card over even with a
  // draft in it, then focuses the item once the tray has mounted.
  const [reviewRequest, setReviewRequest] = useState<{ readonly kind: 'approval' | 'question'; readonly id: string; readonly seq: number } | null>(null);
  const reviewPending = useCallback((kind: 'approval' | 'question', id: string) => {
    setReviewRequest((current) => ({ kind, id, seq: (current?.seq ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (reviewRequest === null) return;
    const frame = requestAnimationFrame(() => { trayRef.current?.focusItem(reviewRequest.kind, reviewRequest.id); });
    return () => { cancelAnimationFrame(frame); };
  }, [reviewRequest]);
  const composerNeedsYou = useMemo(() => (
    trayItems.length === 0 ? undefined : {
      count: trayItems.length,
      takeOverSeq: reviewRequest?.seq,
      // The composer sits outside the timeline's detail provider; an approval
      // card needs one to know its display arrived whole and to read the rest.
      render: (footer: ReactNode) => (
        <TranscriptDetailProvider controller={controller ?? undefined} loads={state.detailLoads} contentRefs={state.contentRefs}
          sessionId={sessionId} agentId={MAIN_AGENT_ID}
          load={(agentId, kind, id) => controller?.loadTranscriptDetail(agentId, kind, id) ?? Promise.resolve(false)}
          loadContent={(ref) => controller?.loadContentSegment(MAIN_AGENT_ID, ref) ?? Promise.resolve(false)}>
        <NeedsYouTray
          ref={trayRef}
          placement="card"
          footer={footer}
          items={trayItems}
          agentNames={trayAgentNames}
          onResolveApproval={mainTimelineActions.resolveApproval}
          onAnswerQuestion={mainTimelineActions.answerQuestion}
          onDismissQuestion={mainTimelineActions.dismissQuestion}
          onRequestBatchResolve={handleBatchResolve}
          permissionMode={permissionMode}
          onChangePermissionMode={handlePermissionChange}
        />
        </TranscriptDetailProvider>
      ),
    }
  ), [trayItems, trayAgentNames, reviewRequest?.seq, mainTimelineActions.resolveApproval, mainTimelineActions.answerQuestion, mainTimelineActions.dismissQuestion, handleBatchResolve,
    controller, state.detailLoads, state.contentRefs, sessionId, permissionMode, handlePermissionChange]);
  const composerStatusNotice = useMemo(() => {
    if (!hasPromptContinuation || promptCoverage === undefined) return undefined;
    if (queueRowCount > 0) return undefined;
    if (!recoveryHold && !hasActionableDurableIngress && promptEntityLoad?.status !== 'error') return undefined;
    return <PromptRecordsRemainder continuation={{ coverage: promptCoverage, status: promptEntityLoad, onRequest: handleLoadPromptEntities }} />;
  }, [hasPromptContinuation, promptCoverage, queueRowCount, recoveryHold, hasActionableDurableIngress, promptEntityLoad, handleLoadPromptEntities]);

  // The working line under the composer: only while the agent itself is
  // busy (an approval or question hands the floor to the tray instead).
  const composerWorking = composerBusy && state.pendingInteraction === 'none';
  const lastResponseAt = useLastResponseAt(composerWorking, state.blocks, state.turnStartedAt);
  // Stopping this turn never touches background work; the working line says
  // how much of it keeps running.
  const continuingCount = useMemo(
    () => state.tasks.filter((task) => task.status === 'running').length,
    [state.tasks],
  );
  // The session's own remainder, offered from the composer's footer rather than
  // only from the reading column: the reader is most often at the input, and a
  // footer that does not say what is missing makes the input look like the whole
  // conversation.
  //
  // This reads the same controller state the workspace's own outlet reads — the
  // one published `contentRefs` and `detailLoads`, and the same
  // `loadContentSegment` that fills them — so the two outlets are two views of
  // one source, not two copies. A session whose structure the window carried in
  // full reports nothing here and the entry disappears, rather than claiming to
  // have read everything.
  const retrySessionRead = useAutomaticSessionRead(controller ?? undefined, state.loaded && !state.resyncing);
  const sessionRemainder = useMemo(() => {
    if (controller === null) return undefined;
    const refs = (state.contentRefs ?? []).filter(isSessionRemainderRef);
    if (refs.length === 0) return undefined;
    const loads = state.detailLoads;
    return {
      automatic: true,
      pending: refs,
      statusOf: (ref: ContentRef) => loads[contentSegmentKey(ref)],
      request: (ref: ContentRef) => { if (ref.source.kind === 'snapshot' && ref.path[0] === 'session') retrySessionRead(); else void controller.loadContentSegment(MAIN_AGENT_ID, ref); },
    } satisfies ContentContinuationHandle;
  }, [controller, state.contentRefs, state.detailLoads, retrySessionRead]);
  // A model request parked on a governance permit shows a quiet "Queued" status
  // with an inline detail popover — the rules themselves stay in /usage.
  // The poll mounts only while the line can be visible.
  const { snapshot: governanceSnapshot } = useRequestGovernance({ enabled: composerWorking });
  const queued = useMemo(() => {
    const waiting = governanceSnapshot?.waiting.filter((row) => row.sessionId === sessionId);
    if (waiting === undefined || waiting.length === 0) return undefined;
    const longest = waiting.reduce((max, cur) => (cur.waitedMs > max.waitedMs ? cur : max), waiting[0]!);
    return {
      waitedMs: longest.waitedMs,
      modelId: longest.modelId,
      blockingRules: longest.blockingRules,
    };
  }, [governanceSnapshot, sessionId]);
  const composerWorkingInfo = useMemo(
    () => (composerWorking
      ? {
        lastResponseAt,
        continuingCount,
        queued,
      }
      : undefined),
    [composerWorking, lastResponseAt, continuingCount, queued],
  );
  // Child routes dock their mailbox composer locally in AgentWorkspace;
  // only main publishes the resident prompt composer to ConversationShell.
  // Phase is monotonic per SessionView mount: once active (from /new hand-off
  // or first load), consuming initialPromptRef or a transient resync must
  // never regress back to 'settling' (which hides .conversation-seat).
  if (state.loaded) seatReachedActiveRef.current = true;
  const seatPhase =
    selectedAgentId !== undefined
      ? 'active'
      : seatReachedActiveRef.current
        ? 'active'
        : resolveSessionSeatPhase({
            loaded: state.loaded,
            hasInitialPrompt: hadInitialHandoffRef.current,
          });
  const composerExecutionGrants = useMemo(
    () => ({
      kikiContext: executionBinding?.effective.kiki_context,
      allowKikiSubagents: executionBinding?.effective.allow_kiki_subagents,
    }),
    [executionBinding?.effective.kiki_context, executionBinding?.effective.allow_kiki_subagents],
  );
  const hasBlocks = state.blocks.length > 0;
  const composerContextUsage = useMemo(() => {
    const meterLimit = effectiveContextLimit ?? contextAutoCompact?.status.effectiveMaxContextTokens;
    if (meterLimit === undefined) return undefined;
    const hasSessionContext =
      contextUsed !== undefined ||
      (usage?.turn_count ?? 0) > 0 ||
      hasBlocks ||
      contextAutoCompact !== undefined ||
      usage !== undefined;
    return hasSessionContext ? { used: contextUsed, limit: meterLimit } : undefined;
  }, [effectiveContextLimit, contextAutoCompact, contextUsed, usage, hasBlocks]);
  const handleComposerOpenBranch = useCallback(
    (task?: string) => { startBranch(task); },
    [startBranch],
  );
  const seat = useMemo<ConversationSeat>(() => ({
    phase: seatPhase,
    composer:
      selectedAgentId !== undefined ? null : externalClient !== undefined ? (
        // An externally driven session has no Kiki model behind it, so it gets
        // the note composer and the one action that moves the work into Kiki.
        // The ordinary prompt composer would offer a model that cannot answer
        // and would send whatever was typed to a session that cannot run it.
        <ExternalSessionComposer
          sessionId={sessionId}
          mark={externalClient}
          materialsPreview={externalMaterials.data}
          busy={composerBusy}
          disabled={composerDisabled}
        />
      ) : (
        <ContextBreakdownProvider value={state.contextBreakdown} compaction={compactionProgress} onCompactionReceipt={seedCompactionProgress}>
          <Composer
            {...mainCore.composerProps}
            busy={composerBusy}
            disabled={composerDisabled}
            sendDisabled={!sessionSendReady || queueEdit?.loading === true || queueEdit?.loadError === true}
            sendDisabledTitle={queueEdit?.loading ? t('preview.loading') : queueEdit?.loadError ? t('preview.failed') : state.resyncing || state.resyncFailed ? t('sv.sendPaused') : undefined}
            disabledPlaceholder={queueEdit?.loading ? t('preview.loading') : undefined}
            busyPlaceholder={state.resyncing || state.resyncFailed ? t('sv.sendPaused') : undefined}
            model={composerSelection.modelOverride}
            defaultModel={sessionModel}
            serverDefaultModel={inheritedDefault}
            modelSource={modelSource}
            pendingRuntimeControls={pendingRuntimeControls}
            onCancelRuntimeControls={cancelPendingRuntimeControls}
            agentProfile={pendingProfile ?? boundProfile}
            agentProfilePending={profilePending}
            execution={shownExecution}
            boundExecution={boundExecution}
            executionPending={executionPending}
            onCancelExecution={cancelPendingExecution}
            executionGrants={composerExecutionGrants}
            permissionMode={permissionMode}
            planMode={planMode}
            planGate={planGate}
            goalMode={goalMode}
            efforts={supportedEfforts}
            effort={effectiveEffort}
            contextUsage={composerContextUsage}
            sessionUsage={usage}
            sessionUsageError={usageError}
            workspaceId={profileWorkspaceId}
            agentProfileCatalogMode={agentProfileCatalogMode}
            attachments={queueEdit?.attachments ?? attachments}
            attachmentScopeKey={queueEdit?.owner}
            onChangeAttachments={queueEdit === null ? updateAttachments : updateQueueEditAttachments}
            onActivateSkill={handleActivateSkill}
            onSessionAction={runSessionAction}
            onSideQuestion={composerEngine?.fork === false ? undefined : startSideQuestion}
            onOpenBranch={composerEngine?.fork === false ? undefined : handleComposerOpenBranch}
            onCompactContext={handleCompactContext}
            onChangeModel={handleModelChange}
            onChangeAgentProfile={handleAgentProfileChange}
            onChangeExecution={handleExecutionChange}
            onRebuildContext={handleContextRebuild}
            onChangePermissionMode={handlePermissionChange}
            onChangePlanMode={handlePlanChange}
            onChangePlanGate={handlePlanGateChange}
            onChangeGoalMode={setGoalMode}
            onChangeEffort={handleEffortChange}
            onSend={handleComposerSend}
            onSendNow={nativeSteeringUnavailable ? undefined : handleComposerSendNow}
            working={composerWorkingInfo}
            sessionRemainder={sessionRemainder}
            onAbort={handleComposerAbort}
            abortPending={abortPending}
            queueEditing={queueEdit !== null}
            onQueueEditConfirm={handleQueueEditConfirm}
            onQueueEditCancel={handleQueueEditCancel}
            onQueueEditRemove={handleQueueEditRemove}
            header={composerHeader}
            onOpenImage={openImageInPreview}
            needsYou={composerNeedsYou}
            statusNotice={composerStatusNotice}
            engine={composerEngine}
          />
        </ContextBreakdownProvider>
      ),
  }), [
    mainCore.composerProps,
    composerNeedsYou,
    composerStatusNotice,
    selectedAgentId,
    seatPhase,
    state.loaded,
    state.resyncing,
    state.resyncFailed,
    state.contextBreakdown,
    composerBusy,
    composerWorkingInfo,
    composerDisabled,
    composerSelection.modelOverride,
    sessionModel,
    inheritedDefault,
    modelSource,
    pendingRuntimeControls,
    cancelPendingRuntimeControls,
    pendingProfile,
    boundProfile,
    profilePending,
    shownExecution,
    boundExecution,
    executionPending,
    composerExecutionGrants,
    handleExecutionChange,
    cancelPendingExecution,
    permissionMode,
    planMode,
    planGate,
    goalMode,
    supportedEfforts,
    effectiveEffort,
    composerContextUsage,
    usage,
    usageError,
    compactionProgress,
    seedCompactionProgress,
    profileWorkspaceId,
    agentProfileCatalogMode,
    attachments,
    updateAttachments,
    handleActivateSkill,
    runSessionAction,
    startSideQuestion,
    handleComposerOpenBranch,
    handleCompactContext,
    handleComposerSend,
    handleComposerSendNow,
    nativeSteeringUnavailable,
    handleComposerAbort,
    abortPending,
    queueEdit,
    updateQueueEditAttachments,
    handleQueueEditConfirm,
    handleQueueEditCancel,
    handleQueueEditRemove,
    composerHeader,
    openImageInPreview,
    handleModelChange,
    handleEffortChange,
    handleAgentProfileChange,
    handleContextRebuild,
    composerEngine,
    sessionSendReady,
    sessionRemainder,
    externalClient,
    externalMaterials.data,
    sessionId,
    t,
  ]);
  useRegisterSeat(seat);

  const pendingInteractionRefs = useMemo(
    () => [
      ...trayItems
        .filter((item): item is ApprovalBlock => item.kind === 'approval')
        .map((item) => ({ kind: 'approval' as const, id: item.request.approval_id })),
      ...trayItems
        .filter((item): item is QuestionBlock => item.kind === 'question')
        .map((item) => ({ kind: 'question' as const, id: item.request.question_id })),
    ],
    [trayItems],
  );
  const interactionPlacement = useMemo<InteractionPlacement>(
    () => ({ inTray: true, onReview: reviewPending, pendingItems: pendingInteractionRefs }),
    [reviewPending, pendingInteractionRefs],
  );
  const routedSubagent = selectedAgentId !== undefined;

  const handleHeaderSideQuestion = useCallback(() => { startSideQuestion(); }, [startSideQuestion]);
  const handleHeaderOpenBranch = useCallback(() => { startBranch(); }, [startBranch]);
  const handleResyncRetry = useMemo(
    () => (controller === null ? undefined : () => { void controller.resync(); }),
    [controller],
  );
  const handleCloseBtw = useCallback(() => { setActiveBtw(null); }, []);
  const handleExpandBtw = useCallback((btwAgentId: string) => {
    setActiveBtw(null);
    openAgentRoute(btwAgentId);
  }, [openAgentRoute]);
  const handleRestoreArchivedSession = useCallback(() => {
    void client.restoreSession(sessionId).then(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions'] }).catch(() => undefined),
        queryClient.invalidateQueries({ queryKey: ['archived-sessions'] }).catch(() => undefined),
        controller?.refreshSession(),
      ]);
    }).catch((error: unknown) => {
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  }, [client, sessionId, queryClient, controller]);
  const handleRefreshSessionSaved = useCallback(() => { void controller?.refreshSession(); }, [controller]);
  const isPrivateBusy = pendingPrivacy.has(sessionId);
  const forkLaunchBusy = forkingSession || branchPending || sideQuestionPending;
  const deliveryPending = deliveryChangedInTurn && state.busy;
  const mainHeaderNode = useMemo(() => (
    <Header
      controller={controller} railOpen={railOpen} railAvailable={railAvailable}
      terminalAvailable={terminalAvailable} terminalOpen={terminalOpen}
      onToggleRail={toggleRail} onToggleTerminal={toggleTerminalPanel}
      onToggleSidebar={onToggleSidebar} sidebarBadge={sidebarBadge} onRenameSession={renameSession}
      onTogglePrivate={toggleSessionPrivate}
      privateBusy={isPrivateBusy}
      onSessionAction={runSessionAction}
      freshContextAvailable={conversationStarted}
      onSideQuestion={handleHeaderSideQuestion}
      onOpenBranch={handleHeaderOpenBranch}
      forkLineage={forkLineage}
      forkPopoverOpenRequest={forkPopoverOpenRequest}
      forkLaunchBusy={forkLaunchBusy}
      onOpenForkSession={openForkSession}
      onOpenBranchAgent={openAgentRoute}
      onForkSessionWithSeed={handleForkSessionWithSeed}
      onStartBranchWithSeed={startBranch}
      view={timelineView} onView={setTimelineView}
      onDelivery={changeDelivery} deliveryPending={deliveryPending}
      harness={harness}
    />
  ), [
    controller, railOpen, railAvailable, terminalAvailable, terminalOpen,
    toggleRail, toggleTerminalPanel, onToggleSidebar, sidebarBadge, renameSession,
    toggleSessionPrivate, isPrivateBusy, runSessionAction, conversationStarted,
    handleHeaderSideQuestion, handleHeaderOpenBranch, forkLineage, forkPopoverOpenRequest,
    forkLaunchBusy, openForkSession, openAgentRoute, handleForkSessionWithSeed, startBranch,
    timelineView, changeDelivery, deliveryPending, harness,
  ]);
  const mainTimelineProp = useMemo(() => ({
    view: timelineView,
    state: timelineState,
    connected: wsStatus === 'open',
    onLoadOlder: mainTimelineActions.loadOlder,
    onResolveApproval: mainTimelineActions.resolveApproval,
    onAnswerQuestion: mainTimelineActions.answerQuestion,
    onDismissQuestion: mainTimelineActions.dismissQuestion,
    onCancelQueued: handleCancelQueuedChips,
    onRetryLoad: mainTimelineActions.retryLoad,
    onRetryPending: retryPendingSubmission,
    forest,
    onOpenAgent: openAgent,
    rowActions: transcriptRowActionsWithBranch,
    offshootsByBlockId: forkLineage.byBlockId,
    onOpenForkSession: openForkSession,
    onOpenBranchAgent: openAgentRoute,
    onContinueFailedTurn: handleContinueFailedTurn,
    onRetryFailedTurn: handleRetryFailedTurn,
    onRetryCompaction: handleRetryCompaction,
    interruptedWork: state.session?.interrupted_work,
    onRecoverInterruption: handleRecoverInterruption,
    recoveringInterruption,
    modelCatalog: modelsQuery.data?.items,
    modelCatalogScope: connectionId ?? 'local',
    onOpenModelPicker: handleOpenModelPicker,
    onOpenProviderSettings: handleOpenProviderSettings,
    onCompactContext: handleCompactFromError,
  }), [
    timelineView, timelineState, wsStatus,
    mainTimelineActions.loadOlder, mainTimelineActions.resolveApproval,
    mainTimelineActions.answerQuestion, mainTimelineActions.dismissQuestion,
    handleCancelQueuedChips, mainTimelineActions.retryLoad, retryPendingSubmission,
    forest, openAgent, transcriptRowActionsWithBranch, forkLineage.byBlockId,
    openForkSession, openAgentRoute, handleContinueFailedTurn, handleRetryFailedTurn,
    handleRetryCompaction, state.session?.interrupted_work, handleRecoverInterruption,
    recoveringInterruption, modelsQuery.data?.items, connectionId,
    handleOpenModelPicker, handleOpenProviderSettings, handleCompactFromError,
  ]);
  const mainDockNode = useMemo(() => (
    <>
      {shownBtw !== null ? (
        <BtwFloatingCard
          sessionId={sessionId}
          agentId={shownBtw.agentId}
          controller={controller}
          sendingInitial={shownBtw.sendingInitial}
          onSendQuestion={handleSendBtwQuestion}
          onExpandFullView={handleExpandBtw}
          onClose={handleCloseBtw}
        />
      ) : null}
      <SubmissionRecovery sessionId={sessionId} agentId={MAIN_AGENT_ID} draftKey={sessionId} state={timelineState} />
      <ResyncStatusBanner
        resyncing={state.resyncing} resyncFailed={state.resyncFailed}
        error={state.resyncError}
        sendPaused={!sessionSendReady}
        onRetry={handleResyncRetry}
      />
      {recoveryHold ? (
        <RecoveryHoldBar count={recoveryHoldCount} pending={recoveryPending}
          onConfirm={handleRecoveryConfirm} />
      ) : null}
      {state.session?.archived === true ? (
        <div
          data-archived-session-banner
          className="mx-auto flex w-full max-w-[var(--kiki-chat-content-width,760px)] flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] text-ink-soft"
        >
          <span>{locale === 'zh' ? '此对话已归档' : 'This conversation is archived'}</span>
          <button
            type="button"
            data-archived-session-restore
            onClick={handleRestoreArchivedSession}
            className="h-7 cursor-pointer rounded-md bg-ink/[0.06] px-2.5 text-[12px] font-normal text-ink transition-colors hover:bg-ink/[0.10]"
          >
            {t('archive.restore')}
          </button>
        </div>
      ) : null}
      {state.session?.ephemeral === true ? (
        <EphemeralBar
          session={state.session}
          busy={state.busy}
          onSaved={handleRefreshSessionSaved}
        />
      ) : null}
    </>
  ), [
    shownBtw, sessionId, controller, handleSendBtwQuestion, handleExpandBtw, handleCloseBtw,
    state, timelineState, sessionSendReady, handleResyncRetry, recoveryHold, recoveryHoldCount, recoveryPending,
    handleRecoveryConfirm, locale, handleRestoreArchivedSession, t, handleRefreshSessionSaved,
  ]);
  const mainRailNode = useMemo(() => (
    controller !== null && railOpen ? (
      <RightRail
        className={`app-rail ${railOpen ? 'open' : ''}`}
        state={focusState} forest={forest} selectedAgentId={panelFocusAgent}
        subagent={focusSubagent} taskOwnerAgentId={focusTaskOwner}
        onCancelTask={handleCancelTask} onStopAgentTask={stopAgentTask}
        onOpenSubagent={openAgent} onClose={closeRail}
        onInspectMain={inspectMain} onOpenFile={openFileInPreview}
        onReviewPending={reviewPending}
        onSearchSubagents={searchSubagents}
        sessionPending={trayItems} onResolveApproval={mainTimelineActions.resolveApproval}
      />
    ) : null
  ), [
    controller, railOpen, focusState, forest, panelFocusAgent, focusSubagent, focusTaskOwner,
    handleCancelTask, stopAgentTask, openAgent, closeRail, inspectMain, openFileInPreview,
    reviewPending, searchSubagents, trayItems, mainTimelineActions.resolveApproval,
  ]);
  const mainWorkspaceAdapter = useMemo(() => ({
    header: mainHeaderNode,
    timeline: mainTimelineProp,
    annotations: annotationSurface,
    dock: mainDockNode,
    rail: mainRailNode,
  }), [mainHeaderNode, mainTimelineProp, annotationSurface, mainDockNode, mainRailNode]);

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
      {routedSubagent ? (
        <AgentWorkspace
          target={{ sessionId, agentId: selectedAgentId }}
          controller={controller}
          sessionState={state}
          forest={forest}
          navigation={agentWorkspaceNavigation}
          railOpen={railOpen}
          railIsOverlay={railIsOverlay}
          onToggleRail={toggleRail}
          railAvailable={railAvailable}
          onCloseRail={closeRail}
          onCancelTask={handleCancelTask}
          onStopAgentTask={stopAgentTask}
          previewApiRef={previewRef}
          inheritMediaPreview
          historyBack
          locateSpawnInMenu
        />
      ) : (
        <>
          <PreviewFocusBridge onFocusedAgent={setPanelFocusAgent} />
          <ModelSwitchActionsContext.Provider value={modelSwitchActions}>
          <MessageViewContext.Provider value={messageViewContext}>
          <InteractionPlacementContext.Provider value={interactionPlacement}>
          <AdmissionScope value={admissionScope}>
          <AgentWorkspace
            target={mainTarget}
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
            main={mainWorkspaceAdapter}
          />
          </AdmissionScope>
          </InteractionPlacementContext.Provider>
          </MessageViewContext.Provider>
          <ModelSwitchDialog {...mainCore.modelSwitchDialogProps} />
          </ModelSwitchActionsContext.Provider>
        </>
      )}
      {slots.footer !== null && terminalOpen && currentTerminalManager !== null
        ? createPortal(
            // The fallback takes the panel's own box, so the column does not
            // jump when the terminal code arrives.
            <Suspense fallback={
              <section
                data-terminal-panel-loading
                aria-busy="true"
                className="flex shrink-0 flex-col bg-shell text-shell-ink"
                style={{ height: terminalHeight }}
              />
            }>
              <TerminalPanel
                manager={currentTerminalManager}
                height={terminalHeight}
                wsStatus={wsStatus}
                onHeightChange={handleTerminalHeightChange}
                onClose={toggleTerminalPanel}
              />
            </Suspense>,
            slots.footer,
          )
        : null}

      <SessionAnnouncer
        pendingInteraction={state.pendingInteraction}
        busy={state.busy}
        queuedItemCount={queuedItemCount}
      />

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
        title={t('sv.queueClearTitle', { count: queueRowCount })}
        body={t('sv.queueClearBody')}
        confirmLabel={t('sv.queueClearAll')}
        onConfirm={confirmClearQueueRun}
        onCancel={() => { setConfirmClearQueue(false); }}
      />
      <ConfirmDialog
        open={executionSwitchConfirm !== undefined}
        overlayId="confirm-execution-switch"
        title={t('execution.switchTitle', { engine: executionSwitchName(executionSwitchConfirm, executorLabels) })}
        body={isNativeExecutor(executionSwitchConfirm?.executor)
          ? t('profile.switchBody')
          : executionSwitchConfirm?.profile === undefined
            ? t('execution.switchBareBody')
            : t('execution.switchBody')}
        consequences={[
          ...(isNativeExecutor(executionSwitchConfirm?.executor)
            ? [t('execution.switchNativeContext'), t('execution.switchProfileEffects', { profile: executionSwitchConfirm?.profile ?? DEFAULT_AGENT_PROFILE }), t('profile.switchModelReset')]
            : [t('execution.switchFreshContextPlain'), t('execution.switchHistoryKept'),
                executionSwitchConfirm?.profile === undefined
                  ? t('execution.switchBareEffects')
                  : t('execution.switchProfileEffects', { profile: executionSwitchConfirm.profile })]),
          ...(composerBusy ? [t('execution.switchRunningTurn')] : []),
        ]}
        confirmLabel={t('execution.switchConfirm')}
        tone="default"
        onConfirm={confirmExecutionSwitchRun}
        onCancel={() => { setExecutionSwitchConfirm(undefined); }}
      />
    </MediaPreviewProvider>
  );
}
