/**
 * AgentWorkspace — the unified agent workspace: header (identity, status,
 * actions), timeline, resync banner, and detail rail for one agent target.
 *
 * The target arrives as a prop from the route shell; this component never
 * reads the URL to decide who it shows, and it never creates or closes the
 * session controller — the shell owns the shared runtime and passes it in
 * together with the session-level view state. Main supplies its existing
 * prompt/goal/queue adapter to the same chrome and timeline; children bind
 * their own transcript and mailbox composer. Parent task lists and resync
 * status cross the child seam without leaking main configuration or usage.
 *
 * Container concerns (close/back, fullscreen, sizing, tab arrangement) stay
 * with the shell, expressed here through `navigation` and the rail props.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { DeferredAppendTiming, PermissionMode, PromptDeliveryReason, PromptItem } from '@kiki/protocol';
import { buildPromptContent, buildSkillActivation, flushDrafts, isNativeExecutor, readComposerState, readDraft, recoverSubmittedDraft, subscribeDraftAppends, writeComposerState, writeDraft, type ComposerAttachment, type ExecutionChoice } from '@kiki/session-core/composer';
import {
  agentPath,
  createViewState,
  filterBlocksToDirectChildren,
  MAIN_AGENT_ID,
  SendNowError,
  sessionAgentForest,
  type AgentForest,
  type AgentTreeNode,
  type SessionController,
  type SessionViewState,
  type SubagentBlock,
  type TranscriptDetailKind,
} from '@kiki/session-core/session';
import {
  modelSwitchPreferencesToWire,
  readModelSwitchPreferences,
  rememberModelSwitchChoice,
  resolveCatalogModel,
  resolveModelSwitchPreferences,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { ContentRef } from '@kiki/transcript';
import { ExternalAgentAttachmentUnsupportedError, NativeChildPromptSendError, isDefinitivePromptRejection, type ModelSwitchMode } from '../../lib/client';
import { ModelSwitchDialog } from '../model-switch/ModelSwitchDialog';
import { ModelSwitchActionsContext, type ModelSwitchNoticeActions } from '../model-switch/ModelSwitchNotice';
import { useModelSwitches } from '../model-switch/useModelSwitches';
import { pushToast } from '../../lib/toasts';
import type { PlanReviewResponse } from '../Interactions';
import { useConnection } from '../../state/connection';
import { locateSpawnTarget } from '../../lib/timelineLocate';
import { useTimelineNavigation } from '../../lib/useTimelineNavigation';
import { NavBackButton } from '../NavBackButton';
import { useMediaQuery } from '../../lib/layoutHooks';
import { AgentBreadcrumb, AgentRelations } from '../AgentBreadcrumb';
import {
  EMPTY_SLOTS,
  useOptionalConversationShell,
  type ConversationShellSlots,
} from '../ConversationShell';
import { Composer } from '../Composer';
import { useLastResponseAt } from '../composerWorking';
import type { ContextMeterUsage } from '../ContextMeter';
import { useContextMeterAutoCompact } from '../useContextMeterAutoCompact';
import { Icon } from '../icons';
import type { ComponentType } from 'react';
import type { MediaPreviewProvider as OwnedMediaPreviewProvider } from '../mediaPreview';
import { PreviewToggleButton } from '../PreviewToggleButton';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { RightRail } from '../RightRail';
import { Transcript } from '../Transcript';
import { TranscriptDetailProvider, type TranscriptEntityKind } from '../transcriptDetail';
import { ResyncStatusBanner } from './ResyncStatusBanner';
import { registerOverlay } from '../../lib/uiBusy';

/** Inspector toggle mark, drawn from the shared icon family at header size. */
export function PanelIcon({ className = '' }: { className?: string }) {
  return <Icon name="panel" size={16} className={className} />;
}

/** The agent identity a workspace renders; always resolved by the shell. */
export interface AgentWorkspaceTarget {
  readonly sessionId: string;
  readonly agentId: string;
}

/**
 * Navigation intents the workspace can raise; the shell decides where each
 * lands (preview tab vs route) and how back-to-session resolves.
 */
export interface AgentWorkspaceNavigation {
  readonly openAgent: (agentId: string) => void;
  /** Route-level open, bypassing any preview interception (spawn jump-back). */
  readonly openAgentRoute: (agentId: string) => void;
  readonly openSession: () => void;
  /** The preview tab can reopen the session's one shared rail even when it is
   * covered by the focused surface. `available` is false where no rail can
   * open at all (the shell hides it below lg), so no entry point renders. */
  readonly sharedRail?: {
    readonly open: boolean;
    readonly toggle: () => void;
    readonly available?: boolean;
  };
}

/**
 * "Send now" delivery feedback, shared by the session composer and this
 * workspace's child composer: the receipt names why a message did not join
 * the running turn, and a late durable read can still supply the reason when
 * the first acknowledgement has none. The copy follows that reason — it is
 * never inferred from a streaming or tool phase, which do not reject a steer.
 */
type SendNowOutcome = Awaited<ReturnType<SessionController['sendPromptNow']>>['outcome'];

const SEND_NOW_QUEUED_KEYS: Readonly<Record<PromptDeliveryReason, I18nKey>> = {
  no_active_turn: 'sv.steerQueuedNoActiveTurn',
  target_changed: 'sv.steerQueuedTargetChanged',
  prompt_no_longer_pending: 'sv.steerQueuedNotPending',
  steer_rejected: 'sv.steerQueuedRejected',
  external_retry: 'sv.steerQueuedExternalUnknown',
  executor_deferred: 'sv.steerQueuedExternal',
  model_switch_boundary: 'sv.steerQueuedModelBoundary',
};

export function sendNowQueuedNotice(reason: PromptDeliveryReason | undefined): I18nKey {
  return reason === undefined ? 'sv.steerQueued' : SEND_NOW_QUEUED_KEYS[reason];
}

export function sendNowNotice(
  outcome: SendNowOutcome,
  reason: PromptDeliveryReason | undefined,
): { readonly tone: 'info'; readonly key: I18nKey } | undefined {
  if (outcome === 'held') return { tone: 'info', key: reason === 'external_retry' ? 'sv.steerQueuedExternalUnknown' : 'sv.submissionRecovery.server' };
  if (outcome === 'not_pending') return { tone: 'info', key: 'sv.steerQueuedNotPending' };
  if (outcome === 'queued') return { tone: 'info', key: sendNowQueuedNotice(reason) };
  return undefined;
}

/** Receipts a late durable read can still explain; bounded per mounted view. */
const MAX_OPEN_NOW_RECEIPTS = 20;

/** What a still-open "Send now" receipt should do on this snapshot. */
type NowReceiptDecision =
  | { readonly kind: 'drop' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'report'; readonly reason: PromptDeliveryReason };

/**
 * One rule for both composers: a canonical row owns the message first, then
 * the durable record decides while the prompt is still queued. Only an
 * admitted, queued record with a reason is final — a restoring/held record
 * that still carries an older delivery field is not. A missing record is not
 * proof of delivery either: the durable read may still be in flight.
 */
export function nowReceiptDecision(input: {
  readonly promptId: string;
  readonly reported: string | null;
  readonly ingress: readonly PromptItem[];
  readonly settled: boolean;
}): NowReceiptDecision {
  if (input.settled) return { kind: 'drop' };
  const record = input.ingress.find((item) => item.prompt_id === input.promptId);
  if (record === undefined) return { kind: 'wait' };
  if (record.admission === 'failed' || record.admission === 'cancelled'
    || record.status === 'running' || record.delivery_state === 'steered') return { kind: 'drop' };
  if (record.admission !== 'admitted' || record.delivery_state !== 'queued' || record.delivery_reason === undefined) {
    return { kind: 'wait' };
  }
  if (input.reported !== null) return { kind: 'drop' };
  return { kind: 'report', reason: record.delivery_reason };
}

/** A queued Send now that still carries an open receipt for a later reason. */
export function trackOpenNowReceipt(receipts: Map<string, string | null>, promptId: string, reason: string | null): void {
  receipts.set(promptId, reason);
  while (receipts.size > MAX_OPEN_NOW_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (oldest === undefined) break;
    receipts.delete(oldest);
  }
}

export interface AgentWorkspaceProps {
  readonly target: AgentWorkspaceTarget;
  /** Shared session runtime owned by the shell; subscribed to, never opened or closed here. */
  readonly controller: SessionController | null;
  /** Session-level (main) view state: session record, resync status, owner task lists. */
  readonly sessionState: SessionViewState;
  /** Content-stabilized agent forest shared with the main view. */
  readonly forest: AgentForest;
  readonly navigation: AgentWorkspaceNavigation;
  readonly railOpen: boolean;
  /** True where the rail floats over the conversation. Below lg the rail is
   * that overlay layer itself (full-screen on a phone); the shell still passes
   * false — the drawer's own styles carry it. */
  readonly railIsOverlay: boolean;
  readonly onToggleRail: () => void;
  readonly onCloseRail: () => void;
  readonly onCancelTask: (taskId: string, ownerAgentId?: string) => void;
  readonly onStopAgentTask: (ownerAgentId: string, taskId: string) => Promise<void>;
  /** Shell-shared preview seat; the provider below mounts it, ownership stays outside. */
  readonly previewApiRef?: RefObject<MediaPreviewApi | null>;
  /**
   * Portal targets for the workspace chrome (header, dock, rail). Defaults to
   * the ambient ConversationShell slots; an embedding shell (preview tab)
   * passes local slot elements so the chrome stays inside its own container.
   */
  readonly slots?: ConversationShellSlots;
  /**
   * Inherit the ambient session-level preview provider instead of mounting an
   * owned one. Set when the workspace renders inside the preview workspace:
   * the shell owns the one preview panel, and file/image opens from this
   * timeline must land there rather than in a nested second workspace.
   */
  readonly inheritMediaPreview?: boolean;
  /** Header preview-panel toggle; suppressed where the workspace IS the panel. */
  readonly showPreviewToggle?: boolean;
  /**
   * Header open-rail entry (the shared rail's own affordance, the same
   * control shape the main session header renders). It renders only while the
   * rail is collapsed; the expanded state keeps no hide button here. The
   * preview tab opens the same session rail, not a local second rail.
   */
  readonly showRailToggle?: boolean;
  /**
   * Whether a rail can open at the current width. The shell hides the rail
   * outright below lg, so below that breakpoint the header entry would be a
   * control that does nothing.
   */
  readonly railAvailable?: boolean;
  /** Header breadcrumb; suppressed in narrow containers (the relations row stays). */
  readonly showBreadcrumb?: boolean;
  /**
   * Routed-page marker: this workspace owns the page chrome, so its header
   * carries the one history-return entry. Off in the preview panel tab, which
   * is not a visit of its own.
   */
  readonly historyBack?: boolean;
  /**
   * Offer 派发处 in this page's ⋯ menu. The rail carries that entry where a rail
   * exists; below lg there is no rail, so the page keeps it in the menu instead
   * of leaving a control that cannot open anything.
   */
  readonly locateSpawnInMenu?: boolean;
  readonly transcriptVisible?: boolean;
  /** Main's prompt/queue/goal orchestration remains in the session owner; only its
   * presentation crosses this boundary. Child commands never use this adapter. */
  readonly main?: {
    readonly header: ReactNode;
    readonly timeline: ComponentProps<typeof Transcript>;
    readonly dock: ReactNode;
    readonly rail: ReactNode;
    readonly timelineRef?: RefObject<HTMLDivElement | null>;
    readonly timelineOverlay?: ReactNode;
  };
}

/** All targets share these actual chrome slots and timeline geometry. The main
 * input seat stays owned by ConversationShell, not by this portal. */
function WorkspaceSurface({
  target, controller, slots, header, timeline, dock, rail, railIsOverlay, railOpen, onCloseRail,
  timelineRef, timelineOverlay,
}: {
  target: AgentWorkspaceTarget;
  controller: SessionController | null;
  slots: ConversationShellSlots;
  header: ReactNode;
  timeline: ComponentProps<typeof Transcript>;
  dock: ReactNode;
  rail: ReactNode;
  railIsOverlay: boolean;
  railOpen: boolean;
  onCloseRail: () => void;
  timelineRef?: RefObject<HTMLDivElement | null>;
  timelineOverlay?: ReactNode;
}) {
  const { t } = useI18n();
  // Below lg the rail is an overlay layer for every shell (the session's too),
  // so the open rail gets the same tap-outside backdrop an overlay shell has.
  const narrowOverlay = useMediaQuery('(max-width: 1023px)');
  const loadDetail = useCallback(
    (agentId: string, kind: TranscriptDetailKind, id: string) =>
      controller?.loadTranscriptDetail(agentId, kind, id) ?? Promise.resolve(false),
    [controller],
  );
  // Bounded-content reads stay bound to the agent this workspace renders: the
  // refs below are that agent's, and a late segment lands in that agent's own
  // canonical body rather than in whatever the reader switched to.
  const loadContent = useCallback(
    (ref: ContentRef) => controller?.loadContentSegment(target.agentId, ref) ?? Promise.resolve(false),
    [controller, target.agentId],
  );
  // A windowed entity collection (the rail's task list, say) reads one page at
  // a time into the same canonical store; a page never overwrites an entity the
  // session already holds.
  const loadEntities = useCallback(
    (kind: TranscriptEntityKind) => controller?.loadTranscriptEntities(target.agentId, kind) ?? Promise.resolve(false),
    [controller, target.agentId],
  );
  return (
    <TranscriptDetailProvider
      controller={controller ?? undefined}
      load={loadDetail}
      loads={timeline.state.detailLoads}
      contentRefs={timeline.state.contentRefs}
      sessionId={target.sessionId}
      agentId={target.agentId}
      loadContent={loadContent}
      loadEntities={loadEntities}
    >
      {slots.header !== null ? createPortal(header, slots.header) : null}
      <div ref={timelineRef} className="contents" data-agent-workspace-target={target.agentId}>
        {/* One list instance per agent. Child row ids are turn-scoped
            (`agent-turn-t1-prompt`), so two agents share row keys; a reused
            virtualizer would carry one agent's measured sizes, scroll anchor
            and initial-scroll state into the other. */}
        <Transcript key={`${target.sessionId}:${target.agentId}`} {...timeline} />
      </div>
      {timelineOverlay}
      {slots.dock !== null ? createPortal(dock, slots.dock) : null}
      {slots.rail !== null && railOpen ? createPortal(rail, slots.rail) : null}
      {(railIsOverlay || narrowOverlay) && railOpen ? (
        <div role="button" tabIndex={-1} aria-label={t('sv.closePanel')}
          className="app-overlay-backdrop lg:hidden" onClick={onCloseRail}
          onKeyDown={(event) => { if (event.key === 'Escape') onCloseRail(); }} />
      ) : null}
    </TranscriptDetailProvider>
  );
}

export function resolveRunningSubagentTask(input: {
  agentId: string;
  parentAgentId?: string;
  mainTasks: SessionViewState['tasks'];
  parentTasks: SessionViewState['tasks'];
}): {
  ownerAgentId: string;
  task: SessionViewState['tasks'][number] | undefined;
} {
  const ownerAgentId = input.parentAgentId ?? MAIN_AGENT_ID;
  const tasks = ownerAgentId === MAIN_AGENT_ID ? input.mainTasks : input.parentTasks;
  return {
    ownerAgentId,
    task: tasks.find(
      (task) =>
        task.kind === 'subagent' &&
        task.status === 'running' &&
        task.agent_id === input.agentId,
    ),
  };
}

const emptyAgentView = createViewState('');

/**
 * A routed agent may be absent from the session's recent roster while its
 * persisted transcript is still readable. Continuation needs stronger
 * evidence than the route itself: an opened body, an effective identity, a
 * terminal status, or an authoritative full read. A partial empty read is
 * kept read-only and settles as an unavailable target instead of becoming a
 * send gate by accident.
 */
export function agentContinuationAvailable(input: {
  readonly controller: SessionController | null;
  readonly node: AgentTreeNode | undefined;
  readonly subagent: SubagentBlock | undefined;
  readonly state: Pick<SessionViewState, 'blocks' | 'model' | 'historyCoverageKind' | 'transcriptReady'>;
}): boolean {
  if (input.controller === null) return input.node !== undefined || input.subagent !== undefined;
  // Test/legacy embeddings may not expose view retention and already provide
  // an authoritative forest; the real SessionController always has it.
  if (typeof input.controller.retainAgentView === 'function' && !input.state.transcriptReady) return false;
  if (input.state.blocks.length > 0 || input.state.model !== undefined) return true;
  const status = input.node?.status ?? input.subagent?.status;
  if (status !== undefined && status !== 'unknown') return true;
  return input.state.historyCoverageKind === 'full';
}

export function WorkspaceHeader({ children, main = false }: { children: ReactNode; main?: boolean }) {
  // A quiet bar on the sheet's own ground: no rule under it — the sheet edge
  // and the transcript's top padding carry the separation.
  return (
    <header className={main
      ? 'flex h-12 shrink-0 items-center gap-1 bg-paper pr-2 pl-4 lg:pl-5'
      : 'flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-paper py-2 pr-2 pl-4 lg:pl-5'}>
      {children}
    </header>
  );
}

/** One control shape for every header icon action: 32px ghost square
 * (44px touch target below lg), ink-faint at rest, a paper-deep wash on
 * hover, and the pressed state reads as a filled wash rather than accent. */
export const HEADER_ICON_BUTTON =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-canvas hover:text-ink aria-expanded:bg-canvas aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink lg:h-8 lg:w-8';

function AgentWorkspaceHeader({
  target,
  name,
  model,
  effort,
  crumbs,
  forest,
  railOpen,
  onToggleRail,
  navigation,
  showPreviewToggle,
  showRailToggle,
  railAvailable = true,
  showBreadcrumb,
  freshContextAvailable,
  onFreshContext,
  onLocateSpawn,
  showHistoryBack,
}: {
  target: AgentWorkspaceTarget;
  name: string;
  model: string | undefined;
  effort: string | undefined;
  crumbs: readonly AgentTreeNode[];
  forest: AgentForest;
  railOpen: boolean;
  onToggleRail: () => void;
  navigation: AgentWorkspaceNavigation;
  showPreviewToggle: boolean;
  /** Off in the embedded panel tab: the toggle's railOpen state is a local no-op. */
  showRailToggle: boolean;
  /** Off where no rail can open; the rail is an overlay layer below lg, so this stays on there too. */
  railAvailable?: boolean;
  /** Off in narrow containers (tabs): the relations row below keeps the navigation. */
  showBreadcrumb: boolean;
  /** The child has a conversation to renew: the menu offers a fresh context. */
  freshContextAvailable: boolean;
  onFreshContext: () => void;
  /** 派发处 in the menu where no rail carries it; undefined keeps the menu as-is. */
  onLocateSpawn?: () => void;
  showHistoryBack: boolean;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const unregister = registerOverlay('agent-actions-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-agent-actions]') === null) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [menuOpen]);
  return (
    <>
      <WorkspaceHeader>
        {showHistoryBack ? <NavBackButton /> : null}
        <div className="min-w-24 flex-1" title={`${t('sv.subagentNote')} · ${t('sv.agentActionsNote')}`}>
          {showBreadcrumb ? (
            <AgentBreadcrumb
              crumbs={crumbs}
              onOpenSession={navigation.openSession}
              onOpenAgent={navigation.openAgent}
            />
          ) : null}
          {/* Name in the display serif; model · effort as one quiet line
              beneath it. The scope notes ride the tooltip — they explain,
              they do not change what to do next. */}
          <h1 className="truncate font-display text-[15px] leading-tight font-semibold tracking-tight text-ink">
            {name}
          </h1>
          {model !== undefined || effort !== undefined ? (
            <p className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-ink-faint">
              {model !== undefined ? <span className="truncate">{model}</span> : null}
              {model !== undefined && effort !== undefined ? <span aria-hidden>·</span> : null}
              {effort !== undefined ? (
                <span data-agent-effort className="shrink-0">{t('subagent.effort', { effort })}</span>
              ) : null}
            </p>
          ) : null}
        </div>

        {showPreviewToggle ? <PreviewToggleButton /> : null}
        {/* Same intent as the session's ⋯ menu: renew this child's context
            without having to make a switch fail first, and — where no rail
            exists to carry 派发处 — locate the card that spawned this child.
            A child with neither keeps no menu at all. */}
        {freshContextAvailable || onLocateSpawn !== undefined ? (
          <div className="relative shrink-0" data-agent-actions>
            <button
              type="button"
              onClick={() => { setMenuOpen((value) => !value); }}
              title={t('sv.actionsAria')}
              aria-label={t('sv.actionsAria')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={HEADER_ICON_BUTTON}
            >
              <Icon name="more" size={16} />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="anim-enter absolute right-0 top-full z-40 mt-1 w-56 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
              >
                {onLocateSpawn !== undefined ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-agent-locate-spawn
                    className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper"
                    onClick={() => { setMenuOpen(false); onLocateSpawn(); }}
                  >
                    {t('inspector.locate')}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  data-agent-fresh-context
                  className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper"
                  onClick={() => { setMenuOpen(false); onFreshContext(); }}
                >
                  {t('modelSwitch.menuFreshContext')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {/* Pure open-rail entry: renders only while the shared rail is
            collapsed. Once expanded, the rail's own collapse affordances take
            over — no "hide panel" button in this header. */}
        {showRailToggle && railAvailable && !railOpen ? (
          <button
            type="button"
            onClick={onToggleRail}
            title={t('sv.showPanel')}
            aria-label={t('sv.togglePanelAria')}
            aria-expanded={false}
            data-agent-rail-toggle
            className={HEADER_ICON_BUTTON}
          >
            <PanelIcon />
          </button>
        ) : null}
      </WorkspaceHeader>
      <div data-agent-relations-surface className="shrink-0 bg-paper px-4 pb-2 text-[12px] lg:px-5">
        <AgentRelations
          key={target.agentId}
          forest={forest}
          currentAgentId={target.agentId}
          onOpen={navigation.openAgent}
        />
      </div>
    </>
  );
}

interface WorkspaceCompositionProps extends AgentWorkspaceProps {
  readonly mediaPreviewProvider?: ComponentType<ComponentProps<typeof OwnedMediaPreviewProvider>>;
}

export function AgentWorkspace(props: WorkspaceCompositionProps) {
  const ambientSlots = useOptionalConversationShell()?.slots;
  const { scopeId } = useConnection();
  if (props.target.agentId === MAIN_AGENT_ID) {
    if (props.main === undefined) throw new Error('Main workspace requires the session prompt adapter');
    const main = props.main;
    return (
      <WorkspaceSurface
        target={props.target}
        controller={props.controller}
        slots={props.slots ?? ambientSlots ?? EMPTY_SLOTS}
        header={main.header}
        timeline={main.timeline}
        timelineRef={main.timelineRef}
        timelineOverlay={main.timelineOverlay}
        dock={main.dock}
        rail={main.rail}
        railOpen={props.railOpen}
        railIsOverlay={props.railIsOverlay}
        onCloseRail={props.onCloseRail}
      />
    );
  }
  return <ChildAgentWorkspace key={JSON.stringify([scopeId, props.target.sessionId, props.target.agentId])} {...props} />;
}

function ChildAgentWorkspace({
  target,
  controller,
  sessionState,
  forest,
  navigation,
  railOpen,
  railIsOverlay,
  onToggleRail,
  onCloseRail,
  onCancelTask,
  onStopAgentTask,
  previewApiRef,
  slots: slotsOverride,
  inheritMediaPreview = false,
  showPreviewToggle = true,
  showRailToggle = true,
  railAvailable = true,
  showBreadcrumb = true,
  historyBack = false,
  locateSpawnInMenu = false,
  transcriptVisible = true,
  mediaPreviewProvider: MediaPreviewProvider,
}: WorkspaceCompositionProps) {
  const { t } = useI18n();
  const { client, klient, scopeId } = useConnection();
  const liveSettings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const queryClient = useQueryClient();
  // 派发处 is an explicit visit, not a plain scroll: the arrow returns to what
  // the reader was looking at before the jump.
  const navigateTimeline = useTimelineNavigation();
  const { sessionId, agentId } = target;
  // Target identity owns both the composition and Composer's transient state.
  // A remount reads the old target back rather than discarding its unsent work.
  const draftKey = JSON.stringify([scopeId, sessionId, agentId]);
  const [draft, setDraftState] = useState(() => readDraft(draftKey));
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    () => readComposerState(draftKey).attachments ?? [],
  );
  const setDraft = (text: string) => {
    writeDraft(draftKey, text);
    setDraftState(text);
  };
  useEffect(() => {
    const chrome = readComposerState(draftKey);
    writeComposerState(draftKey, {
      attachments,
      annotations: chrome.annotations ?? [],
      permissionMode: chrome.permissionMode,
      planMode: chrome.planMode,
      planGate: chrome.planGate,
      goalObjective: chrome.goalObjective,
      modelOverride: chrome.modelOverride,
      effortOverride: chrome.effortOverride,
    });
  }, [draftKey, attachments]);
  useEffect(() => () => { flushDrafts(); }, []);
  const contextSlots = useOptionalConversationShell()?.slots;
  const slots = slotsOverride ?? contextSlots ?? EMPTY_SLOTS;
  // A key belongs to one unacknowledged submission, not to the draft text
  // forever. Switching the connection or endpoint invalidates it even if a
  // later render switches back to the same target and unchanged draft.
  const sendScope = JSON.stringify([scopeId, sessionId, agentId]);
  const [sendNotice, setSendNotice] = useState<{ scope: string; text: string } | null>(null);
  const pendingSendRef = useRef<{
    scope: string; payload: string; key: string; afterModelSwitch: string | undefined;
    appendTiming?: DeferredAppendTiming;
  } | null>(null);
  // "Send now" receipts still open to a late durable read: prompt id → the
  // reason already reported (null = only the generic queued notice went out).
  const nowReceiptsRef = useRef(new Map<string, string | null>());
  // Re-read the ingress snapshot after a receipt registers, even when the
  // controller had already published it before this promise settled.
  const [nowReceiptTick, setNowReceiptTick] = useState(0);
  const composerOwnerActive = useRef(true);
  useEffect(() => {
    composerOwnerActive.current = true;
    return () => {
      composerOwnerActive.current = false;
      pendingSendRef.current = null;
    };
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => subscribeDraftAppends((key) => {
    if (key !== draftKey) return;
    const restored = readDraft(draftKey);
    draftRef.current = restored;
    setDraftState(restored);
    setAttachments(readComposerState(draftKey).attachments ?? []);
  }), [draftKey]);
  const handleDraftChange = (next: string) => {
    if (next !== draftRef.current) {
      pendingSendRef.current = null;
      setSendNotice(null);
    }
    draftRef.current = next;
    setDraft(next);
  };
  const handleAttachmentsChange: typeof setAttachments = (next) => {
    setAttachments((previous) => {
      const updated = typeof next === 'function' ? next(previous) : next;
      if (updated !== previous) pendingSendRef.current = null;
      return updated;
    });
    setSendNotice(null);
  };

  // The model catalog backing the composer's effort ladder. Same query key as
  // the main session and the composer itself, so one `/models` fetch feeds
  // every surface instead of one per workspace.
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });

  // Live per-agent channel: child-agent frames land in their own sub-store, so
  // this workspace re-renders from here without the main transcript
  // republishing for every hidden child delta.
  const subscribeAgent = useCallback(
    (listener: () => void) =>
      controller === null || !transcriptVisible ? () => {} : controller.subscribeAgent(agentId, listener),
    [controller, agentId, transcriptVisible],
  );
  const agentLiveState = useSyncExternalStore(subscribeAgent, () =>
    controller !== null ? controller.getAgentState(agentId) : emptyAgentView,
  );
  const parentAgentId =
    (controller?.getForest() ?? sessionAgentForest(sessionState)).byId[agentId]?.parentAgentId;
  const subscribeParentAgent = useCallback(
    (listener: () => void) =>
      controller === null || !transcriptVisible || parentAgentId === undefined || parentAgentId === MAIN_AGENT_ID
        ? () => {}
        : controller.subscribeAgent(parentAgentId, listener),
    [controller, parentAgentId, transcriptVisible],
  );
  const parentAgentState = useSyncExternalStore(subscribeParentAgent, () =>
    controller !== null && parentAgentId !== undefined && parentAgentId !== MAIN_AGENT_ID
      ? controller.getAgentState(parentAgentId)
      : emptyAgentView,
  );

  const workspaceViewId = useMemo(() => `workspace:${sessionId}:${agentId}`, [sessionId, agentId]);
  useEffect(() => {
    if (controller === null || typeof controller.retainAgentView !== 'function') return;
    controller.retainAgentView(workspaceViewId, agentId, transcriptVisible ? 'delta' : 'off');
    return () => { controller.releaseAgentView?.(workspaceViewId); };
  }, [controller, workspaceViewId, agentId, transcriptVisible]);
  useEffect(() => {
    if (controller === null || typeof controller.updateAgentView !== 'function') return;
    controller.updateAgentView(workspaceViewId, transcriptVisible ? 'delta' : 'off');
  }, [controller, workspaceViewId, transcriptVisible]);

  // Same query key as the session view: one catalog fetch, shared cache.
  const handleLoadOlder = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    if (controller === null) return false;
    return controller.loadOlderMessages(agentId, signal);
  }, [controller, agentId]);
  const handleResolveApproval = useCallback(
    (
      approvalId: string,
      decision: 'approved' | 'rejected' | 'cancelled',
      scope?: 'session',
      selectedOptionId?: string,
      review?: PlanReviewResponse,
    ) =>
      controller?.resolveApproval(approvalId, decision, scope, selectedOptionId, review) ??
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

  const capturedBlocks = agentLiveState.blocks;
  // Pending approvals/questions waiting on THIS agent — feeds the rail's
  // Needs-input badge. (agentState.pendingInteraction below stays 'none':
  // that flag gates the main session's composer chrome, not this count.)
  const agentPendingInteractionCount = capturedBlocks.filter(
    (block) =>
      (block.kind === 'approval' && block.resolution === undefined) ||
      (block.kind === 'question' && block.outcome === undefined),
  ).length;
  const selectedNode = forest.byId[agentId];
  const selectedSubagent = sessionState.blocks.find(
    (block): block is SubagentBlock =>
      block.kind === 'subagent' && block.subagentId === agentId,
  );
  const crumbs = useMemo(() => agentPath(forest, agentId), [forest, agentId]);
  const selectedStatus = selectedNode?.status ?? selectedSubagent?.status;
  const headerBusy = selectedNode?.busy === true || agentLiveState.busy;
  const displayName = selectedNode?.label ?? selectedSubagent?.name ?? agentId;
  const displayModel = agentLiveState.model ?? selectedNode?.model ?? selectedSubagent?.model;
  const resolvedCrumbs = useMemo(() => {
    if (crumbs.length > 0) return crumbs;
    const sessionLabel = sessionState.session?.title || t('sv.sessionCrumb');
    const mainNode: AgentTreeNode = {
      agentId: MAIN_AGENT_ID,
      name: 'main',
      label: sessionLabel,
      status: 'completed',
      busy: false,
      toolCallCount: 0,
      childIds: [agentId],
    };
    const childNode: AgentTreeNode = {
      agentId,
      parentAgentId: MAIN_AGENT_ID,
      name: displayName,
      label: displayName,
      status: selectedStatus ?? 'completed',
      busy: headerBusy,
      toolCallCount: 0,
      childIds: [],
    };
    return [mainNode, childNode];
  }, [crumbs, agentId, sessionState.session?.title, t, displayName, selectedStatus, headerBusy]);

  // Parent jump-back: navigate to the spawning agent's timeline, then locate
  // this agent's card there (the locate entry waits for the target view to
  // mount, pages older history in, and reports when the card is gone). Both
  // branches name the same target — parent timeline AND this child's card —
  // so the return arrow can undo the jump.
  const handleJumpToSpawn = (): void => {
    const spawnParentId = selectedNode?.parentAgentId ?? selectedSubagent?.parentAgentId ?? MAIN_AGENT_ID;
    const spawn = locateSpawnTarget(sessionId, agentId, spawnParentId);
    navigateTimeline(spawn.target, { ...spawn.options, route: spawn.route });
  };
  // The child run is a task on the PARENT agent's task service; nested agents
  // therefore need the parent's per-agent snapshot rather than the main one.
  const { ownerAgentId, task: runningAgentTask } = resolveRunningSubagentTask({
    agentId,
    parentAgentId: selectedNode?.parentAgentId ?? parentAgentId,
    mainTasks: sessionState.tasks,
    parentTasks: parentAgentState.tasks,
  });
  // A terminal child remains wakeable, but a route alone is not permission to
  // continue it. Old persisted bodies can establish identity after the recent
  // roster has already dropped the row; a partial empty read cannot.
  const agentKnown = agentContinuationAvailable({
    controller,
    node: selectedNode,
    subagent: selectedSubagent,
    state: agentLiveState,
  });
  const reportedExecutorId = selectedNode?.executorId ?? selectedSubagent?.executorId;
  const executorBindingQuery = useQuery({
    queryKey: ['agentExecutor', scopeId, sessionId, agentId],
    queryFn: async () => await klient.session(sessionId).getAgentExecutor(agentId) ?? null,
    enabled: agentKnown && reportedExecutorId === undefined,
    staleTime: 30_000,
    retry: false,
  });
  const executorId = reportedExecutorId ?? (executorBindingQuery.isSuccess ? executorBindingQuery.data ?? 'native' : undefined);
  const externalExecutor = executorId !== undefined && !isNativeExecutor(executorId);
  const childExecution: ExecutionChoice | undefined = executorId === undefined ? undefined : {
    executor: executorId, profile: undefined, overrides: displayModel === undefined ? undefined : { model: displayModel },
  };
  const agentReadUnavailable = controller !== null && agentLiveState.transcriptReady && !agentKnown;
  const composerDisabled = !agentKnown || executorId === undefined;
  const handleComposerSend = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    options?: Parameters<ComponentProps<typeof Composer>['onSend']>[2],
    useSwitchDependency = true,
  ) => {
    if (!agentKnown) return;
    const content = buildPromptContent(text, composerAttachments, options?.presentation);
    if (content === null) return;
    const appendTiming = externalExecutor ? undefined : (options?.appendTiming ?? liveSettings.defaultAppendTiming);
    // Timing stays on the stored submission, outside this identity: a plain
    // retry after an unknown result must replay the original one-shot choice.
    const payload = JSON.stringify([text, content, useSwitchDependency]);
    const previous = pendingSendRef.current;
    // A lost acceptance retries the original execution payload, even if the queue advances.
    const submission = previous?.scope === sendScope && previous.payload === payload
      ? previous
      : { scope: sendScope, payload, key: crypto.randomUUID(), appendTiming,
        afterModelSwitch: useSwitchDependency ? modelSwitches.dependency?.input.operationId : undefined };
    pendingSendRef.current = submission;
    const hasNonTextAttachment = content.some((part) => part.type !== 'text');
    let receipt: Awaited<ReturnType<typeof client.sendAgentMessage>>;
    try {
      // The server already defaults to agent_idle; keep the ordinary six-arg
      // child send shape and add the seventh arg only for a real timing choice.
      receipt = submission.appendTiming === undefined || submission.appendTiming === 'agent_idle'
        ? await client.sendAgentMessage(sessionId, agentId, text, content, submission.key, submission.afterModelSwitch)
        : await client.sendAgentMessage(sessionId, agentId, text, content, submission.key, submission.afterModelSwitch, submission.appendTiming);
    } catch (error) {
      if (isDefinitivePromptRejection(error)) {
        if (pendingSendRef.current === submission) setSendNotice(null);
        throw error instanceof NativeChildPromptSendError ? error.cause : error;
      }
      // Native attachments have no replay receipt; a failed request may have
      // been accepted already. The external path rejects attachments before send.
      if (error instanceof NativeChildPromptSendError) {
        if (pendingSendRef.current === submission) {
          setSendNotice({ scope: sendScope, text: t(hasNonTextAttachment
            ? 'agentMessage.attachmentOutcomeUnknown' : 'agentMessage.promptOutcomeUnknown') });
        }
        return;
      }
      if (hasNonTextAttachment && !(error instanceof ExternalAgentAttachmentUnsupportedError)) {
        if (pendingSendRef.current === submission) {
          setSendNotice({ scope: sendScope, text: t('agentMessage.attachmentOutcomeUnknown') });
        }
        return;
      }
      if (pendingSendRef.current === submission) setSendNotice(null);
      throw error;
    }
    if (receipt !== null && receipt.payloadConflict) {
      // The earlier message under this key was accepted with different content,
      // so this draft was NOT accepted. Fail closed before clearing: keep the
      // draft for a retry and let the composer report the failure in place
      // instead of reading as a delivered message.
      if (pendingSendRef.current === submission) setSendNotice(null);
      throw new Error(t('agentMessage.payloadConflict'));
    }
    if (pendingSendRef.current !== submission) return;
    // A settled acceptance releases the key. Rejected attempts keep it so the
    // composer retry button can recover a response lost after durable accept.
    pendingSendRef.current = null;
    draftRef.current = '';
    setSendNotice(null);
    setDraft('');
    setAttachments([]);
    if (receipt === null) return;
    // A persisted external agent returns a durable-mailbox acceptance. Native
    // children return null and take the ordinary prompt path, whose delivery
    // timing stays unknown here rather than being guessed.
    const deduplicated = receipt.deduplicated;
    let summary: string;
    if (deduplicated) summary = t('agentMessage.deduplicated');
    else if (receipt.delivery === 'queued') summary = t('agentMessage.pending');
    else summary = t('agentMessage.delivered');
    if (receipt.resumed === true) summary = `${summary} · ${t('subagent.event.resumed')}`;
    // A deduplicated or queued receipt never claims a fresh delivery.
    pushToast({
      tone: deduplicated || receipt.delivery === 'queued' ? 'info' : 'success',
      text: summary,
    });
  };
  const handleActivateSkill: NonNullable<ComponentProps<typeof Composer>['onActivateSkill']> = async (name, args, skillAttachments, userInput) => {
    if (!agentKnown) return;
    const activation = buildSkillActivation(args, skillAttachments);
    const payload = JSON.stringify(['skill', name, activation, userInput]);
    const previous = pendingSendRef.current;
    const submission = previous?.scope === sendScope && previous.payload === payload
      ? previous
      : { scope: sendScope, payload, key: crypto.randomUUID(), afterModelSwitch: modelSwitches.dependency?.input.operationId };
    pendingSendRef.current = submission;
    await client.activateSkill(sessionId, name, {
      ...activation, agent_id: agentId, user_input: userInput, prompt_id: submission.key,
      after_model_switch: submission.afterModelSwitch,
    });
    if (pendingSendRef.current !== submission) return;
    pendingSendRef.current = null;
    if (!composerOwnerActive.current || draftRef.current !== userInput) return;
    draftRef.current = '';
    setDraft('');
    setAttachments([]);
    setSendNotice(null);
  };
  // The core chooses native safe-boundary steering or the external executor's
  // steer capability and reports an explicit queued reason when it defers.
  const handleComposerSendNow = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    presentation?: import('@kiki/transcript').TextPresentation,
  ) => {
    if (!agentKnown) return;
    const content = buildPromptContent(text, composerAttachments, presentation);
    if (content === null) return;
    if (controller === null) throw new Error(t('subagent.composerUnavailable'));
    draftRef.current = '';
    setSendNotice(null);
    setDraft('');
    setAttachments([]);
    try {
      const result = await controller.sendPromptNow({ agentId, text, content });
      const notice = sendNowNotice(result.outcome, result.reason);
      if (notice !== undefined) pushToast({ tone: notice.tone, text: t(notice.key) });
      // A queued acknowledgement already carries its final reason; only
      // restoring/held receipts are open to a later durable read.
      if (result.outcome === 'restoring' || result.outcome === 'held') {
        // Neither carries a reason yet: leave the receipt open for the final one.
        trackOpenNowReceipt(nowReceiptsRef.current, result.promptId, null);
        setNowReceiptTick((tick) => tick + 1);
      }
    } catch (error) {
      const reason = error instanceof SendNowError ? error.reason : 'submit';
      if (reason !== 'unknown') recoverSubmittedDraft(draftKey, text, composerAttachments);
      const cause = error instanceof SendNowError ? error.cause : error;
      pushToast({
        tone: 'error',
        text: t(reason === 'refused' ? 'sv.steerRefused' : reason === 'unknown' ? 'sv.steerUnknown' : 'sv.steerFailed', {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      });
    }
  };
  // The first acknowledgement of a durable steer is not the last word: keep
  // reading the receipt and explain the final reason when it lands. A prompt
  // that started, steered or reached this agent's transcript is owned by it,
  // so the pending explanation goes away instead of re-attaching.
  useEffect(() => {
    const tracked = nowReceiptsRef.current;
    if (tracked.size === 0) return;
    const ingress = sessionState.durableIngress ?? [];
    for (const [promptId, reported] of tracked) {
      const decision = nowReceiptDecision({
        promptId, reported, ingress,
        settled: agentLiveState.blocks.some((block) => block.kind === 'user' && block.promptId === promptId && block.promptStatus !== 'queued'),
      });
      if (decision.kind === 'wait') continue;
      if (decision.kind === 'drop') {
        tracked.delete(promptId);
        continue;
      }
      tracked.set(promptId, decision.reason);
      pushToast({ tone: 'info', text: t(sendNowQueuedNotice(decision.reason)) });
    }
  }, [agentLiveState.blocks, sessionState.durableIngress, nowReceiptTick, t]);
  // Stop is a server-side cancel that can fail; duplicate requests during the
  // round trip are guarded by a synchronous ref (a state-only guard can be
  // crossed by two events in the same batch), mirrored to state for the
  // disabled UI. Both clear in finally, so a rejected stop stays retryable.
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const handleTerminateAgent = async () => {
    if (runningAgentTask === undefined || stoppingRef.current !== null) return;
    stoppingRef.current = runningAgentTask.id;
    setStoppingTaskId(runningAgentTask.id);
    try {
      await client.stopAgentTask(sessionId, ownerAgentId, runningAgentTask.id);
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t('sv.stopTaskFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      stoppingRef.current = null;
      setStoppingTaskId(null);
    }
  };
  // ---- model switching (child): the same panel and queue as main ----
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
    retry: false,
  });
  const modelSwitchPrefs = useMemo(
    () => readModelSwitchPreferences(configQuery.data?.model_switch),
    [configQuery.data],
  );
  const modelSwitches = useModelSwitches(sessionId, agentId);
  const [modelSwitchDialog, setModelSwitchDialog] = useState<{
    readonly fromModel: string;
    readonly toModel: string;
    readonly initialMode: ModelSwitchMode;
    readonly matchedRuleId?: string;
    readonly editingOperationId?: string;
    readonly editingRevision?: number;
  } | undefined>(undefined);
  const [modelSwitchSubmitting, setModelSwitchSubmitting] = useState(false);
  const [modelSwitchActionPending, setModelSwitchActionPending] = useState<string | undefined>(undefined);
  const submitModelSwitch = useCallback(async (choice: {
    readonly fromModel: string;
    readonly toModel: string;
    readonly mode: ModelSwitchMode;
    readonly remember: boolean;
    readonly editingOperationId?: string;
    readonly editingRevision?: number;
  }) => {
    setModelSwitchSubmitting(true);
    try {
      if (choice.editingOperationId !== undefined) {
        await client.updateAgentModelSwitch(sessionId, agentId, {
          operationId: choice.editingOperationId,
          model: choice.toModel,
          mode: choice.mode,
          selectedFromModel: choice.fromModel,
        }, choice.editingRevision);
      } else {
        await client.switchAgentModel(sessionId, agentId, {
          operationId: crypto.randomUUID(),
          model: choice.toModel,
          mode: choice.mode,
          selectedFromModel: choice.fromModel,
        });
      }
      setModelSwitchDialog(undefined);
      modelSwitches.refresh();
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t(choice.editingOperationId !== undefined ? 'modelSwitch.updateFailed' : 'modelSwitch.submitFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
      return;
    } finally {
      setModelSwitchSubmitting(false);
    }
    if (!choice.remember) return;
    // Accepted already: an unsaved preference is reported, never treated as a
    // rollback of the switch. Only the rule table goes out, so the default mode
    // and ask flag some other surface owns are never rewritten from here.
    try {
      const remembered = modelSwitchPreferencesToWire(
        rememberModelSwitchChoice(modelSwitchPrefs, choice.fromModel, choice.toModel, choice.mode),
      );
      const echoed = await client.patchConfig({ model_switch: { rules: remembered.rules } });
      queryClient.setQueryData(['config'], echoed);
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t('modelSwitch.prefsSaveFailed', { detail: error instanceof Error ? error.message : String(error) }),
      });
    }
  }, [agentId, client, modelSwitchPrefs, modelSwitches, queryClient, sessionId, t]);
  const runModelSwitchAction = useCallback((
    operationId: string,
    run: () => Promise<unknown>,
    failureKey: 'modelSwitch.cancelFailed' | 'modelSwitch.recoverFailed',
  ) => {
    setModelSwitchActionPending(operationId);
    void run()
      .then(() => { modelSwitches.refresh(); })
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t(failureKey, { detail: error instanceof Error ? error.message : String(error) }),
        });
      })
      .finally(() => { setModelSwitchActionPending((current) => (current === operationId ? undefined : current)); });
  }, [modelSwitches, t]);
  const modelSwitchActions = useMemo<ModelSwitchNoticeActions>(() => ({
    pendingOperationId: modelSwitchActionPending,
    edit: (operationId) => {
      const entry = modelSwitches.switches.find((candidate) => candidate.input.operationId === operationId);
      if (entry === undefined || entry.receipt.state !== 'pending') return;
      setModelSwitchDialog({
        fromModel: entry.receipt.fromModel,
        toModel: resolveCatalogModel(modelsQuery.data?.items ?? [], entry.input.model)?.id ?? entry.receipt.toModel,
        initialMode: entry.input.mode,
        editingOperationId: operationId,
        editingRevision: entry.revision,
      });
    },
    cancel: (operationId) => {
      runModelSwitchAction(
        operationId,
        () => client.cancelAgentModelSwitch(sessionId, agentId, operationId),
        'modelSwitch.cancelFailed',
      );
    },
    retry: (operationId) => {
      runModelSwitchAction(
        operationId,
        () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'retry'),
        'modelSwitch.recoverFailed',
      );
    },
    retryAsFresh: (operationId) => {
      runModelSwitchAction(
        operationId,
        () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'retry', 'fresh'),
        'modelSwitch.recoverFailed',
      );
    },
    keepOriginal: (operationId) => {
      runModelSwitchAction(
        operationId,
        () => client.recoverAgentModelSwitch(sessionId, agentId, operationId, 'keep_original'),
        'modelSwitch.recoverFailed',
      );
    },
  }), [agentId, client, modelSwitchActionPending, modelSwitches.switches, modelsQuery.data, runModelSwitchAction, sessionId]);
  const handleChangeAgentModel = async (model: string | undefined) => {
    if (!agentKnown || model === undefined) return;
    const target = externalExecutor ? model : resolveCatalogModel(modelsQuery.data?.items ?? [], model)?.id ?? model;
    const current = displayModel === undefined
      ? undefined
      : externalExecutor ? displayModel : resolveCatalogModel(modelsQuery.data?.items ?? [], displayModel)?.id ?? displayModel;
    if (current !== undefined && target === current) return;
    // A child with no conversation yet has nothing to hand over: the pick is a
    // plain rebind, exactly the pre-switch behaviour.
    if (agentLiveState.blocks.length === 0) {
      try {
        await client.setAgentModel(sessionId, agentId, model);
      } catch (error) {
        // The pick is a server-side rebind that can fail (a closed child whose
        // persisted binding cannot be restored). Swallow it here — the select is
        // controlled by the live agent, so a failure leaves the old model on
        // screen — but never silently: report it and keep the failing state out
        // of the trigger.
        pushToast({
          tone: 'error',
          text: t('subagent.modelChangeFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      return;
    }
    // A child with history switches through the shared three-mode panel.
    const fromModel = current ?? displayModel ?? '';
    const resolved = resolveModelSwitchPreferences(modelSwitchPrefs, fromModel, target);
    if (resolved.confirm) {
      setModelSwitchDialog({ fromModel, toModel: target, initialMode: resolved.mode, matchedRuleId: resolved.matchedRuleId });
      return;
    }
    await submitModelSwitch({ fromModel, toModel: target, mode: resolved.mode, remember: false });
  };
  // The explicit "new context" entry: same model, so the panel offers only the
  // two context-renewing modes. No rule is consulted — asking for it is the
  // choice, exactly as the session menu treats it.
  const openFreshContextPanel = () => {
    const current = displayModel === undefined
      ? undefined
      : resolveCatalogModel(modelsQuery.data?.items ?? [], displayModel)?.id ?? displayModel;
    if (current === undefined) return;
    setModelSwitchDialog({ fromModel: current, toModel: current, initialMode: 'fresh' });
  };
  const displayEffort =
    agentLiveState.thinkingEffort ?? selectedNode?.thinkingEffort ?? selectedSubagent?.thinkingEffort;
  // The effort ladder comes from the DISPLAY model's catalog row: a bare alias
  // on the node (`k3-256k`) resolves to the provider row that owns
  // `support_efforts`. A terminal subagent keeps the pick disabled.
  const resolvedDisplayModel =
    displayModel !== undefined
      ? resolveCatalogModel(modelsQuery.data?.items ?? [], displayModel)
      : undefined;
  const agentTerminal =
    selectedStatus === 'completed' || selectedStatus === 'cancelled' || selectedStatus === 'failed';
  const supportedEfforts =
    agentKnown && !agentTerminal ? resolvedDisplayModel?.support_efforts : undefined;
  const handleChangeAgentEffort = async (effort: string | undefined) => {
    if (!agentKnown || agentTerminal || effort === undefined || effort === displayEffort) return;
    try {
      if (externalExecutor) await client.setAgentEffort(sessionId, agentId, effort);
      else {
        const model = modelSwitches.dependency?.input.model ?? displayModel;
        if (model === undefined) return;
        const receipt = await client.switchAgentModel(sessionId, agentId, {
          operationId: crypto.randomUUID(), model, thinking: effort === '' ? null : effort, mode: 'direct',
        });
        if (receipt.state === 'failed') throw new Error(receipt.error?.message ?? t('modelSwitch.listFailed'));
        modelSwitches.refresh();
      }
      await queryClient.invalidateQueries({
        queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
      });
    } catch (error) {
      // Same shape as the model rebind: the switch is a server-side write that
      // can fail, so report it instead of leaving the live value silently
      // disagreeing with the pick.
      pushToast({
        tone: 'error',
        text: t('subagent.effortChangeFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };
  const displayContextTokens = agentLiveState.contextTokens ?? selectedNode?.contextTokens;
  const displayMaxContextTokens = agentLiveState.maxContextTokens ?? selectedNode?.maxContextTokens;
  const displayUsage = agentLiveState.usage ?? selectedNode?.usage;
  // This agent's own compaction point: a child never inherits its parent's
  // session override, so the read and write address this agent id.
  const contextAutoCompact = useContextMeterAutoCompact({
    sessionId: agentKnown && !agentTerminal ? sessionId : undefined,
    agentId,
    modelId: displayModel,
    modelLabel: resolvedDisplayModel?.display_name ?? displayModel,
    maxContextTokens: displayMaxContextTokens,
    running: headerBusy,
  });
  // The composer footer's context meter is the same one the main session
  // renders; its cumulative card reads THIS agent's projected lifetime totals.
  // Per-agent projections price nothing, so the cost stays unknown (null)
  // rather than reading as $0.00.
  const composerUsage: ContextMeterUsage | undefined = useMemo(() => {
    const total = displayUsage?.total;
    if (total === undefined) return undefined;
    return {
      input_tokens: total.inputOther,
      output_tokens: total.output,
      cache_read_tokens: total.inputCacheRead,
      cache_creation_tokens: total.inputCacheCreation,
      total_cost_usd: null,
    };
  }, [displayUsage]);
  const [permissionOverride, setPermissionOverride] = useState<PermissionMode>();
  const [planOverride, setPlanOverride] = useState<boolean>();
  const [permissionWriting, setPermissionWriting] = useState(false);
  const [planWriting, setPlanWriting] = useState(false);
  const runtimeWriteQueue = useRef(Promise.resolve());
  const runtimeRevision = useRef({ permission: 0, plan: 0 });
  const confirmedRuntime = useRef<{ permission?: PermissionMode; plan?: boolean }>({});
  const permissionMode = permissionOverride ?? agentLiveState.permissionMode ?? 'manual';
  const planMode = planOverride ?? agentLiveState.planMode ?? false;
  const persistRuntimeControl = (run: () => Promise<void>, rollback: () => void, settled: () => void) => {
    runtimeWriteQueue.current = runtimeWriteQueue.current.then(run).catch((error: unknown) => {
      rollback();
      pushToast({ tone: 'error', text: t('sv.modeUpdateFailed', {
        detail: error instanceof Error ? error.message : String(error),
      }) });
    }).finally(settled);
  };
  const handlePermissionChange = (mode: PermissionMode | undefined) => {
    if (mode === undefined || composerDisabled) return;
    const revision = ++runtimeRevision.current.permission;
    setPermissionWriting(true);
    setPermissionOverride(mode);
    persistRuntimeControl(async () => {
      const agent = klient.session(sessionId).agent(agentId);
      await agent.setPermission(mode, { broadcast: false });
      const effective = await agent.getPermission();
      confirmedRuntime.current.permission = effective;
      if (runtimeRevision.current.permission === revision) setPermissionOverride(effective);
    }, () => {
      if (runtimeRevision.current.permission === revision) setPermissionOverride(confirmedRuntime.current.permission);
    }, () => {
      if (runtimeRevision.current.permission === revision) setPermissionWriting(false);
    });
  };
  const handlePlanChange = (enabled: boolean) => {
    if (composerDisabled) return;
    const revision = ++runtimeRevision.current.plan;
    setPlanWriting(true);
    setPlanOverride(enabled);
    persistRuntimeControl(async () => {
      const agent = klient.session(sessionId).agent(agentId);
      if (enabled) await agent.enterPlan();
      else await agent.exitPlan();
      confirmedRuntime.current.plan = enabled;
    }, () => {
      if (runtimeRevision.current.plan === revision) setPlanOverride(confirmedRuntime.current.plan);
    }, () => {
      if (runtimeRevision.current.plan === revision) setPlanWriting(false);
    });
  };
  useEffect(() => {
    if (!permissionWriting && permissionOverride === agentLiveState.permissionMode) setPermissionOverride(undefined);
  }, [permissionOverride, permissionWriting, agentLiveState.permissionMode]);
  useEffect(() => {
    if (!planWriting && planOverride === agentLiveState.planMode) setPlanOverride(undefined);
  }, [planOverride, planWriting, agentLiveState.planMode]);

  // One filtered list per publish, so the annotation tray's derivation keys
  // on a stable array instead of re-collecting on every render.
  const agentBlocks = useMemo(
    () => filterBlocksToDirectChildren(capturedBlocks, forest, agentId),
    [capturedBlocks, forest, agentId],
  );
  const agentState: SessionViewState = {
    ...agentLiveState,
    session: sessionState.session,
    blocks: agentBlocks,
    // The child's own transcript decides: the session being loaded says
    // nothing about this agent's rows, and landing before they arrive
    // would spend the one-time initial scroll on an empty list.
    loaded: agentLiveState.loaded,
    loadError: agentLiveState.loadError ?? sessionState.loadError ??
      (agentReadUnavailable ? t('subagent.name.unreported', { id: agentId }) :
        !agentLiveState.transcriptReady && sessionState.resyncFailed ? sessionState.resyncError?.message : undefined),
    busy: headerBusy,
    model: displayModel,
    thinkingEffort: displayEffort,
    contextTokens: displayContextTokens,
    maxContextTokens: displayMaxContextTokens,
    contextBreakdown: undefined,
    usage: displayUsage,
    pendingInteraction: 'none',
  };

  const composerWorking = headerBusy && agentState.pendingInteraction === 'none';
  const lastResponseAt = useLastResponseAt(composerWorking, agentBlocks, agentState.turnStartedAt);
  const composerWorkingInfo = useMemo(
    () => (composerWorking ? { lastResponseAt } : undefined),
    [composerWorking, lastResponseAt],
  );

  const chrome = (
    <ModelSwitchActionsContext.Provider value={modelSwitchActions}>
    <WorkspaceSurface
      target={target}
      controller={controller}
      slots={slots}
      header={<AgentWorkspaceHeader
        target={target} name={displayName} model={displayModel} effort={displayEffort}
        crumbs={resolvedCrumbs} forest={forest} railOpen={railOpen} onToggleRail={onToggleRail}
        navigation={navigation} showPreviewToggle={showPreviewToggle}
        showRailToggle={showRailToggle} railAvailable={railAvailable}
        showBreadcrumb={showBreadcrumb}
        showHistoryBack={historyBack}
        freshContextAvailable={agentBlocks.length > 0 && displayModel !== undefined}
        onFreshContext={openFreshContextPanel}
        onLocateSpawn={locateSpawnInMenu ? handleJumpToSpawn : undefined}
      />}
      timeline={{
        state: agentState, agentId, onLoadOlder: handleLoadOlder,
        onResolveApproval: handleResolveApproval, onAnswerQuestion: handleAnswerQuestion,
        onDismissQuestion: handleDismissQuestion, forest, onOpenAgent: navigation.openAgent,
        onRetryLoad: controller === null ? undefined : () => { void controller.retryOpen(); },
        visible: transcriptVisible,
      }}
      dock={<div className="space-y-2 pt-2">
        <ResyncStatusBanner
          resyncing={sessionState.resyncing} resyncFailed={sessionState.resyncFailed}
          error={sessionState.resyncError}
          onRetry={controller === null ? undefined : () => { void controller.resync(); }}
        />
        {sendNotice?.scope === sendScope ? (
          <p role="alert" className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[11px] text-danger">
            {sendNotice.text}
          </p>
        ) : null}
        {executorBindingQuery.isError && reportedExecutorId === undefined ? <p role="status" className="text-[12px] text-ink-faint">
          {t('diagnostics.error')} · {executorBindingQuery.error.message}
          <button type="button" className="ml-2 underline" onClick={() => { void executorBindingQuery.refetch(); }}>{t('common.retry')}</button>
        </p> : null}
        {externalExecutor ? <p data-runtime-modes-external className="px-6 text-[12px] text-ink-faint">{t('subagent.runtimeModesExternal')}</p> : null}
        <Composer
          variant="subagent" replyingTo={displayName} busy={headerBusy} disabled={composerDisabled}
          boundExecution={childExecution}
          engine={executorId === undefined ? { label: t('composer.unknown'), fork: false, images: false } : undefined}
          disabledPlaceholder={t('subagent.composerUnavailable')}
          value={draft} onChange={handleDraftChange}
          model={displayModel} defaultModel={displayModel} serverDefaultModel={displayModel}
          modelSource="session" permissionMode={permissionMode}
          pendingModelSwitch={modelSwitches.active === undefined ? undefined : {
            from: modelSwitches.active.receipt.fromModel,
            to: modelSwitches.active.receipt.toModel,
            mode: modelSwitches.active.input.mode,
            originalThinking: modelSwitches.active.originalBinding.thinking,
            targetThinking: modelSwitches.active.input.thinking,
          }}
          modelSwitchError={modelSwitches.error === undefined ? undefined : {
            detail: modelSwitches.error.message,
            onRetry: modelSwitches.refresh,
          }}
          planMode={planMode} efforts={supportedEfforts} effort={displayEffort}
          contextUsage={displayContextTokens !== undefined && displayMaxContextTokens !== undefined
            ? { used: displayContextTokens, limit: displayMaxContextTokens } : undefined}
          contextAutoCompact={contextAutoCompact}
          sessionUsage={composerUsage} sessionId={sessionId} agentId={agentId} agentProfileCatalogMode={{ mode: 'disabled' }}
          attachments={attachments} onChangeAttachments={handleAttachmentsChange}
          onChangeModel={handleChangeAgentModel} onChangePermissionMode={handlePermissionChange}
          onChangePlanMode={handlePlanChange}
          onChangeEffort={(effort) => { void handleChangeAgentEffort(effort); }}
          onSend={handleComposerSend}
          onActivateSkill={handleActivateSkill}
          onSendNow={controller === null ? undefined : handleComposerSendNow}
          sendTimingDefault={externalExecutor ? undefined : liveSettings.defaultAppendTiming}
          working={composerWorkingInfo}
          onAbort={runningAgentTask !== undefined ? () => { void handleTerminateAgent(); } : undefined}
          abortPending={stoppingTaskId !== null}
        />
      </div>}
      rail={<RightRail
        className={`app-rail ${railOpen ? 'open' : ''}`} state={agentState} forest={forest}
        selectedAgentId={agentId}
        subagent={{ agentId, block: selectedSubagent,
          pendingInteractionCount: agentPendingInteractionCount, onJumpToSpawn: handleJumpToSpawn }}
        taskOwnerAgentId={agentId} onCancelTask={onCancelTask}
        onStopAgentTask={onStopAgentTask} onOpenSubagent={navigation.openAgent}
        onClose={onCloseRail}
      />}
      railOpen={railOpen} railIsOverlay={railIsOverlay} onCloseRail={onCloseRail}
    />
    <ModelSwitchDialog
      open={modelSwitchDialog !== undefined}
      fromModel={modelSwitchDialog?.fromModel ?? ''}
      toModel={modelSwitchDialog?.toModel ?? ''}
      initialMode={modelSwitchDialog?.initialMode ?? 'direct'}
      editing={modelSwitchDialog?.editingOperationId !== undefined}
      busy={headerBusy}
      submitting={modelSwitchSubmitting}
      matchedRuleId={modelSwitchDialog?.matchedRuleId}
      onConfirm={(choice) => {
        const dialog = modelSwitchDialog;
        if (dialog === undefined) return;
        void submitModelSwitch({
          fromModel: dialog.fromModel,
          toModel: dialog.toModel,
          mode: choice.mode,
          remember: choice.remember,
          editingOperationId: dialog.editingOperationId,
          editingRevision: dialog.editingRevision,
        });
      }}
      onCancel={() => { setModelSwitchDialog(undefined); }}
    />
    </ModelSwitchActionsContext.Provider>
  );

  // Embedded mode (preview tab): the ambient session-level provider already
  // owns media overlays and the one preview workspace; mounting another
  // provider here would fork that seat.
  if (inheritMediaPreview) return chrome;
  if (MediaPreviewProvider === undefined) throw new Error('Owned workspace requires a media preview provider');

  return (
    <MediaPreviewProvider
      sessionId={sessionId}
      cwd={sessionState.session?.metadata?.cwd}
      sessionViewState={agentState}
      agentForest={forest}
      onOpenSubagent={navigation.openAgent}
      apiRef={previewApiRef}
      controller={controller}
      workspaceSessionState={sessionState}
      workspaceNavigation={navigation}
      onCancelTask={onCancelTask}
      snapshotAgentId={agentId}
      onStopAgentTask={onStopAgentTask}
    >
      {chrome}
    </MediaPreviewProvider>
  );
}
