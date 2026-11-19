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

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ExecutorLabelProvider } from '../timeline/ExecutorNotes';
import { useExecutorCatalog } from '../settings/profileEditor/engines';

import type { PermissionMode, PromptSkillActivation } from '@kiki/protocol';
import {
  beginPendingSubmissionFlight,
  buildPromptContent,
  buildSkillActivation,
  clearPendingSubmissionsForConnection,
  finishPendingSubmissionFlight,
  isNativeExecutor,
  isPendingSubmissionInFlight,
  readPendingSubmission,
  recoverSubmittedDraft,
  settlePendingSubmission,
  type ComposerAttachment,
  type ExecutionChoice,
} from '@kiki/session-core/composer';
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
  normalizeSelectableModelAlias,
  resolveCatalogModel,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { projectPresentedText, type ContentRef } from '@kiki/transcript';
import { ExternalAgentAttachmentUnsupportedError, NativeChildPromptSendError, isDefinitivePromptRejection } from '../../lib/client';
import { ModelSwitchDialog } from '../model-switch/ModelSwitchDialog';
import { ModelSwitchActionsContext } from '../model-switch/ModelSwitchNotice';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { usePromoteAgent, type PromoteAgentAction } from '../../lib/usePromoteAgent';
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
import { InteractionPlacementContext } from '../Interactions';
import { MessageViewContext } from '../message/messageViewContext';
import { Icon } from '../icons';
import type { ComponentType } from 'react';
import type { MediaPreviewProvider as OwnedMediaPreviewProvider } from '../mediaPreview';
import { PreviewToggleButton } from '../PreviewToggleButton';
import { useMediaPreview, type MediaPreviewApi } from '../mediaPreviewContext';
import { ConversationDockColumn } from '../ConversationDockColumn';
import { RightRail } from '../RightRail';
import { SelectionQuoteButton } from '../SelectionQuoteButton';
import { Transcript } from '../Transcript';
import {
  AdmissionScope,
  filterIngressForAgent,
  useAdmissionScope,
  withAdmissionUserBlocks,
  withOptimisticUserBlock,
  type OptimisticSubmission,
} from '../timeline/AdmissionLine';
import { TranscriptDetailProvider, type TranscriptEntityKind } from '../transcriptDetail';
import { ResyncStatusBanner } from './ResyncStatusBanner';
import { agentContinuationAvailable } from './useAgentTimeline';
export { agentContinuationAvailable };
import {
  restoreSentAnnotations,
  serializeSelectionCarryover,
  updateStoredAnnotations,
  type ConversationAnnotationSurface,
} from './useConversationAnnotations';
import {
  nowReceiptDecision,
  sendNowNotice,
  sendNowQueuedNotice,
  trackOpenNowReceipt,
  useAgentWorkspaceCore,
  type AgentWorkspaceTarget,
} from './useAgentWorkspaceCore';
export {
  nowReceiptDecision,
  sendNowNotice,
  sendNowQueuedNotice,
  trackOpenNowReceipt,
  type AgentWorkspaceTarget,
};
import { registerOverlay } from '../../lib/uiBusy';

/** Inspector toggle mark, drawn from the shared icon family at header size. */
export function PanelIcon({ className = '' }: { className?: string }) {
  return <Icon name="panel" size={16} className={className} />;
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
    readonly close?: () => void;
    readonly available?: boolean;
    readonly yielded?: boolean;
    readonly ensureDockedOpen?: () => void;
  };
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
    readonly annotations?: ConversationAnnotationSurface;
    readonly timelineRef?: RefObject<HTMLDivElement | null>;
    readonly timelineOverlay?: ReactNode;
  };
}

/** All targets share these actual chrome slots and timeline geometry. The main
 * input seat stays owned by ConversationShell, not by this portal. */
function WorkspaceSurface({
  target, controller, slots, header, timeline, dock, rail, railIsOverlay, railOpen, onCloseRail,
  annotations, timelineRef, timelineOverlay,
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
  annotations?: ConversationAnnotationSurface;
  timelineRef?: RefObject<HTMLDivElement | null>;
  timelineOverlay?: ReactNode;
}) {
  const { t } = useI18n();
  // Below lg the rail is an overlay layer for every shell (the session's too),
  // so the open rail gets the same tap-outside backdrop an overlay shell has.
  const narrowOverlay = useMediaQuery('(max-width: 1023px)');
  // The routed agent page keeps its drawer rail at every width; only the
  // session shell's shared rail stays away below lg.
  const railAsDrawer = railIsOverlay || !narrowOverlay;
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
  const effectiveTimeline = useMemo(
    () =>
      annotations === undefined
        ? timeline
        : {
            ...timeline,
            draftAnnotations: annotations.items,
            onSaveDraftAnnotation: annotations.onUpdate,
            onRemoveDraftAnnotation: annotations.onRemove,
          },
    [annotations, timeline],
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
      <div ref={annotations?.containerRef ?? timelineRef} className="contents" data-agent-workspace-target={target.agentId}>
        {/* One list instance per agent. Child row ids are turn-scoped
            (`agent-turn-t1-prompt`), so two agents share row keys; a reused
            virtualizer would carry one agent's measured sizes, scroll anchor
            and initial-scroll state into the other. */}
        <Transcript key={`${target.sessionId}:${target.agentId}`} {...effectiveTimeline} />
      </div>
      {annotations !== undefined ? (
        <SelectionQuoteButton
          containerRef={annotations.containerRef}
          onAnnotate={annotations.onAnnotate}
          onUpdateAnnotation={annotations.onUpdate}
        />
      ) : null}
      {timelineOverlay}
      {slots.dock !== null ? createPortal(dock, slots.dock) : null}
      {/* Below lg the session shell's shared rail never mounts: the routed
          agent page carries it as its own drawer there, so a header toggle
          would open an inspector with no agent context behind it. When the
          docked rail yields to maximized or priority-band preview, both the
          scrim and the drawer portal into `slots.rail` so they sit outside
          an inert `.conversation-center` and add zero flex gap to the row. */}
      {slots.rail !== null && railOpen && railAsDrawer
        ? createPortal(
            <>
              {railIsOverlay || narrowOverlay ? (
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label={t('sv.closePanel')}
                  data-rail-backdrop=""
                  className={
                    narrowOverlay
                      ? 'app-overlay-backdrop'
                      : 'app-overlay-backdrop app-overlay-backdrop--row'
                  }
                  onClick={onCloseRail}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseRail();
                    }
                  }}
                />
              ) : null}
              {rail}
            </>,
            slots.rail,
          )
        : slots.rail === null && (railIsOverlay || narrowOverlay) && railOpen ? (
            <div
              role="button"
              tabIndex={-1}
              aria-label={t('sv.closePanel')}
              data-rail-backdrop=""
              className="app-overlay-backdrop lg:hidden"
              onClick={onCloseRail}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseRail();
                }
              }}
            />
          )
        : null}
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
  promote,
  showHistoryBack,
  branchSeamLabel,
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
  /** Opens this child as its own top-level thread; undefined where the transport cannot. */
  promote?: PromoteAgentAction;
  showHistoryBack: boolean;
  branchSeamLabel?: string;
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
          {branchSeamLabel !== undefined || model !== undefined || effort !== undefined ? (
            <p className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-ink-faint">
              {branchSeamLabel !== undefined ? (
                <span data-branch-seam-header className="shrink-0 text-ink-soft">{branchSeamLabel}</span>
              ) : null}
              {branchSeamLabel !== undefined && (model !== undefined || effort !== undefined) ? <span aria-hidden>·</span> : null}
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
            without having to make a switch fail first, open the child as a
            thread of its own, and — where no rail exists to carry 派发处 —
            locate the card that spawned this child. A child with none of
            these keeps no menu at all. */}
        {freshContextAvailable || onLocateSpawn !== undefined || promote !== undefined ? (
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
                {freshContextAvailable ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-agent-fresh-context
                    className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper"
                    onClick={() => { setMenuOpen(false); onFreshContext(); }}
                  >
                    {t('modelSwitch.menuFreshContext')}
                  </button>
                ) : null}
                {promote !== undefined ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-agent-promote
                    disabled={promote.pending}
                    className="flex h-8 w-full items-center rounded-md px-3 text-left text-[13px] text-ink transition-colors hover:bg-paper disabled:text-ink-faint disabled:hover:bg-transparent"
                    onClick={() => { setMenuOpen(false); promote.promote(); }}
                  >
                    {t(promote.pending ? 'agent.promotePending' : 'agent.promote')}
                  </button>
                ) : null}
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
  const previousScopeIdRef = useRef(scopeId);
  useEffect(() => {
    const previous = previousScopeIdRef.current;
    if (previous !== scopeId) {
      clearPendingSubmissionsForConnection(previous);
      previousScopeIdRef.current = scopeId;
    }
  }, [scopeId]);
  const catalog = useExecutorCatalog();
  const executorLabels = useMemo(() => Object.fromEntries(catalog.map((item) => [item.id, item.label])), [catalog]);
  if (props.target.agentId === MAIN_AGENT_ID) {
    if (props.main === undefined) throw new Error('Main workspace requires the session prompt adapter');
    const main = props.main;
    return (
      <ExecutorLabelProvider labels={executorLabels}>
      <WorkspaceSurface
        target={props.target}
        controller={props.controller}
        slots={props.slots ?? ambientSlots ?? EMPTY_SLOTS}
        header={main.header}
        timeline={main.timeline}
        annotations={main.annotations}
        timelineRef={main.timelineRef}
        timelineOverlay={main.timelineOverlay}
        dock={main.dock}
        rail={main.rail}
        railOpen={props.railOpen}
        railIsOverlay={props.railIsOverlay}
        onCloseRail={props.onCloseRail}
      />
      </ExecutorLabelProvider>
    );
  }
  return (
    <ExecutorLabelProvider labels={executorLabels}>
      <ChildAgentWorkspace key={JSON.stringify([scopeId, props.target.sessionId, props.target.agentId])} {...props} />
    </ExecutorLabelProvider>
  );
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
  const { t, locale } = useI18n();
  const { client, klient, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const { sessionId, agentId } = target;
  const ambientMediaPreview = useMediaPreview();
  const localPreviewRef = useRef<MediaPreviewApi>(null);
  const effectivePreviewRef = previewApiRef ?? localPreviewRef;
  const handleOpenImage = useCallback(
    (src: string, name?: string) => {
      if (ambientMediaPreview !== null) {
        ambientMediaPreview.openImage(src, name);
        return;
      }
      effectivePreviewRef.current?.openImage(src, name);
    },
    [ambientMediaPreview, effectivePreviewRef],
  );
  const promoteAction = usePromoteAgent(sessionId, agentId);
  const contextSlots = useOptionalConversationShell()?.slots;
  const slots = slotsOverride ?? contextSlots ?? EMPTY_SLOTS;

  // Target identity owns both the composition and Composer's transient state.
  // A remount reads the old target back rather than discarding its unsent work.
  const draftKey = JSON.stringify([scopeId, sessionId, agentId]);
  const sendScope = draftKey;
  const [sendNotice, setSendNotice] = useState<{ scope: string; text: string } | null>(null);
  // The sent message stays on this timeline from the keypress until the
  // projection owns a row under the same prompt id, or until the send settles
  // when the server does not use the key as the prompt id.
  const [sendEcho, setSendEcho] = useState<OptimisticSubmission & { readonly scope: string; readonly settledOnServer?: boolean }>();
  const clearSendEcho = (id: string) => { setSendEcho((current) => current?.id === id ? undefined : current); };
  const transcriptVisibleRef = useRef(transcriptVisible);
  transcriptVisibleRef.current = transcriptVisible;
  const draftRevisionRef = useRef(0);
  const [externalBindingSetting, setExternalBindingSetting] = useState<{ model: string; thinking?: string }>();

  const selectedNode = forest.byId[agentId];
  const selectedSubagent = sessionState.blocks.find(
    (block): block is SubagentBlock =>
      block.kind === 'subagent' && block.subagentId === agentId,
  );
  const branchFoldBlock = sessionState.blocks.find(
    (block) => block.kind === 'user' && block.branchFold?.branchId === agentId,
  );
  const crumbs = useMemo(() => agentPath(forest, agentId), [forest, agentId]);
  const selectedStatus = selectedNode?.status ?? selectedSubagent?.status;
  // Fallback when deep-linking before the session roster finishes loading or
  // when a branch falls outside a 400+ capped recent roster: never silently
  // degrade a branch to a restricted `'sub'` agent.
  const initialIsBranch = selectedNode?.isBranch === true
    || selectedNode?.branchSealed === true
    || selectedNode?.branchSeed !== undefined
    || selectedNode?.toolsLocked === true
    || branchFoldBlock !== undefined
    || (selectedNode === undefined && selectedSubagent === undefined && /^branch[-_]/i.test(agentId));
  const reportedExecutorId = selectedNode?.executorId ?? selectedSubagent?.executorId ?? (initialIsBranch ? 'native' : undefined);

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

  // A nested agent's parent is held at `turn` for the parent's task list (the
  // stop control); main's tasks need no lease because the session holds main at
  // `turn`, and this agent's own `delta`/`off` lease is owned by `useAgentTimeline`.
  const leaseId = useId();
  const workspaceViewId = `workspace:${sessionId}:${agentId}:${leaseId}`;
  const nestedParentId = parentAgentId !== undefined && parentAgentId !== MAIN_AGENT_ID ? parentAgentId : undefined;
  useEffect(() => {
    if (controller === null || nestedParentId === undefined || !transcriptVisible || typeof controller.retainAgentView !== 'function') return;
    const parentViewId = `${workspaceViewId}:parent`;
    controller.retainAgentView(parentViewId, nestedParentId, 'turn');
    return () => { controller.releaseAgentView?.(parentViewId); };
  }, [controller, workspaceViewId, nestedParentId, transcriptVisible]);

  const parentModel = nestedParentId !== undefined ? parentAgentState.model : sessionState.model;
  const parentThinkingEffort = nestedParentId !== undefined ? parentAgentState.thinkingEffort : sessionState.thinkingEffort;
  const parentPermissionMode = nestedParentId !== undefined ? parentAgentState.permissionMode : sessionState.permissionMode;
  const canSteerChildNow =
    controller !== null && typeof controller.sendPromptNow === 'function';

  const core = useAgentWorkspaceCore(target, controller, {
    mountHost: 'dock',
    busyPlainSendMode: 'steer',
    interactionPlacementMode: 'inline',
    storageKey: draftKey,
    sendScope,
    visible: transcriptVisible,
    sessionState,
    forest,
    deferModelsQuery: true,
    childBindings: {
      selectedNode,
      selectedSubagent,
      reportedExecutorId,
    },
    onDraftMutated: () => {
      draftRevisionRef.current += 1;
      setSendNotice(null);
    },
    onDraftAppended: () => {
      draftRevisionRef.current += 1;
      if (readPendingSubmission(draftKey) === undefined) setSendNotice(null);
    },
    resolveExecution: ({
      state: live,
      models,
      config,
      liveSettings,
      modelSwitches,
      capabilitiesQuery,
      executorBindingQuery,
      agentKnown,
    }) => {
      const capabilitiesProfile = capabilitiesQuery.data?.profile;
      const liveIsBranch = initialIsBranch
        || live.blocks.some((block) => block.kind === 'notice' && block.branchBase !== undefined);
      const busy = selectedNode?.busy === true || live.busy;
      const configuredDefault = normalizeSelectableModelAlias(
        config?.default_model ?? liveSettings.defaultModel,
      );
      const boundModel = normalizeSelectableModelAlias(
        live.model ?? selectedNode?.model ?? selectedSubagent?.model ?? capabilitiesProfile?.model,
      );
      const model =
        boundModel ??
        (liveIsBranch ? (normalizeSelectableModelAlias(parentModel) ?? configuredDefault) : undefined);
      const execId = reportedExecutorId ?? (liveIsBranch ? 'native' : undefined) ?? (executorBindingQuery.isSuccess ? executorBindingQuery.data ?? 'native' : undefined);
      const isExternal = execId !== undefined && !isNativeExecutor(execId);
      const resolvedModel = model !== undefined ? resolveCatalogModel(models ?? [], model) : undefined;
      const canonicalModel = model === undefined
        ? undefined
        : isExternal ? model : resolvedModel?.id ?? model;
      const effortSourceSwitch = modelSwitches.dependency ?? modelSwitches.switches.findLast((entry) =>
        entry.receipt.state === 'completed' &&
        (resolveCatalogModel(models ?? [], entry.receipt.toModel)?.id ?? entry.receipt.toModel) === canonicalModel);
      const carriedThinking = typeof effortSourceSwitch?.input.thinking === 'string' && effortSourceSwitch.input.thinking !== ''
        ? effortSourceSwitch.input.thinking
        : undefined;
      const resolvedMaxContextTokens = live.maxContextTokens === 0
        ? undefined
        : live.maxContextTokens
          ?? selectedNode?.maxContextTokens
          ?? (execId === 'native' ? resolvedModel?.max_context_size : undefined);
      return {
        currentModel: canonicalModel ?? model ?? '',
        carriedThinking,
        autoCompact: {
          enabled: agentKnown && execId !== undefined && (controller === null || live.transcriptReady),
          modelId: model,
          modelLabel: resolvedModel?.display_name ?? model,
          maxContextTokens: resolvedMaxContextTokens,
          running: busy,
        },
        busy,
        canSteerNow: canSteerChildNow,
        externalBindingSetting: isExternal ? externalBindingSetting : undefined,
        sendTimingDefault: isExternal ? undefined : liveSettings.defaultAppendTiming,
        sessionRecord: sessionState.session,
        durableIngress: sessionState.durableIngress,
        fsSearchEnabled: agentKnown,
      };
    },
  });

  const {
    liveSettings,
    timeline: { state: agentLiveState, actions: timelineActions, pendingInteractionCount: agentPendingInteractionCount },
    modelsQuery,
    configQuery,
    capabilitiesQuery,
    executorBindingQuery,
    agentKnown,
    draftRef,
    setDraft,
    setAttachments,
    composerOwnerActive,
    pendingSendRef,
    submissionInFlight,
    timelineBlocksRef,
    annotations: {
      annotations,
      setAnnotations,
      surface: annotationSurface,
    },
    trackNowReceipt,
    modelSwitches,
    modelSwitchFlow: {
      setDialog: setModelSwitchDialog,
      open: openChildModelSwitch,
      applyEffortSetting: applyChildEffortSetting,
      noticeActions: modelSwitchActions,
    },
    contextAutoCompact,
    revealOwnSend,
  } = core;

  const capabilitiesProfile = capabilitiesQuery.data?.profile;
  const capturedBlocks = agentLiveState.blocks;
  const branchBaseMarker = useMemo(() => {
    for (const block of capturedBlocks) {
      if (block.kind === 'notice' && block.branchBase !== undefined) return block.branchBase;
    }
    return undefined;
  }, [capturedBlocks]);
  const isBranch = initialIsBranch || branchBaseMarker !== undefined;
  const headerBusy = selectedNode?.busy === true || agentLiveState.busy;
  useEffect(() => {
    if (!headerBusy) setExternalBindingSetting(undefined);
  }, [headerBusy]);
  const configuredDefaultModel = normalizeSelectableModelAlias(
    configQuery.data?.default_model ?? liveSettings.defaultModel,
  );
  const boundChildModel = normalizeSelectableModelAlias(
    agentLiveState.model ?? selectedNode?.model ?? selectedSubagent?.model ?? capabilitiesProfile?.model,
  );
  const displayName = selectedNode?.label ?? selectedSubagent?.name ?? agentId;
  const displayModel =
    boundChildModel ??
    (isBranch ? (normalizeSelectableModelAlias(parentModel) ?? configuredDefaultModel) : undefined);
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

  // The child run is a task on the PARENT agent's task service; nested agents
  // therefore need the parent's per-agent snapshot rather than the main one.
  const { ownerAgentId, task: runningAgentTask } = resolveRunningSubagentTask({
    agentId,
    parentAgentId: selectedNode?.parentAgentId ?? parentAgentId,
    mainTasks: sessionState.tasks,
    parentTasks: parentAgentState.tasks,
  });
  const executorId = reportedExecutorId ?? (isBranch ? 'native' : undefined) ?? (executorBindingQuery.isSuccess ? executorBindingQuery.data ?? 'native' : undefined);
  const confirmedNativeExecutor =
    (selectedNode?.executorId ?? selectedSubagent?.executorId) === 'native' ||
    (executorBindingQuery.isSuccess && (executorBindingQuery.data ?? 'native') === 'native');
  useEffect(() => {
    if (confirmedNativeExecutor) {
      (client as { noteNativeAgent?: (sid: string, aid: string) => void }).noteNativeAgent?.(sessionId, agentId);
    }
  }, [agentId, client, confirmedNativeExecutor, sessionId]);
  const externalExecutor = executorId !== undefined && !isNativeExecutor(executorId);
  const childExecution: ExecutionChoice | undefined = executorId === undefined ? undefined : {
    executor: executorId, profile: undefined, overrides: displayModel === undefined ? undefined : { model: displayModel },
  };
  const branchSealed = selectedNode?.branchSealed === true
    || (selectedNode === undefined && branchFoldBlock !== undefined);
  const branchToolsLocked = selectedNode?.toolsLocked === true;
  const branchSeed = selectedNode?.branchSeed ?? branchBaseMarker?.seedMode;
  const [branchFolding, setBranchFolding] = useState(false);
  const [branchFoldPending, setBranchFoldPending] = useState(false);
  const branchFoldSawBusyRef = useRef(false);
  const [branchUnlocking, setBranchUnlocking] = useState(false);
  useEffect(() => {
    setBranchFoldPending(false);
    branchFoldSawBusyRef.current = false;
  }, [sessionId, agentId]);
  useEffect(() => {
    if (branchSealed) {
      setBranchFoldPending(false);
      branchFoldSawBusyRef.current = false;
      return;
    }
    if (!branchFoldPending) return;
    if (headerBusy) {
      branchFoldSawBusyRef.current = true;
    } else if (branchFoldSawBusyRef.current) {
      setBranchFoldPending(false);
      branchFoldSawBusyRef.current = false;
    }
  }, [branchSealed, branchFoldPending, headerBusy]);
  const branchSeamLabel = useMemo(() => {
    if (!isBranch) return undefined;
    const effectiveParentId = selectedNode?.parentAgentId ?? branchBaseMarker?.sourceAgentId;
    const parentLabel = effectiveParentId !== undefined && effectiveParentId !== MAIN_AGENT_ID
      ? (forest.byId[effectiveParentId]?.label ?? effectiveParentId)
      : MAIN_AGENT_ID;
    const parts = [t('transcript.branch.seamHeader', { parent: parentLabel })];
    if (branchSeed === 'fresh' || branchSeed === 'compact' || branchSeed === 'verbatim') {
      parts.push(t(`transcript.branch.seed.${branchSeed}` as I18nKey));
    }
    if (branchSealed) parts.push(t('transcript.branch.sealed'));
    else if (branchToolsLocked) parts.push(t('transcript.branch.toolsLocked'));
    return parts.join(' · ');
  }, [isBranch, selectedNode?.parentAgentId, branchBaseMarker?.sourceAgentId, forest.byId, t, branchSeed, branchSealed, branchToolsLocked]);

  const handleUnlockBranchTools = useCallback(() => {
    if (branchUnlocking || typeof client.setBranchToolsLock !== 'function') return;
    setBranchUnlocking(true);
    void client.setBranchToolsLock(sessionId, { branch_id: agentId, locked: false })
      .then(() => controller?.resync())
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { setBranchUnlocking(false); });
  }, [agentId, branchUnlocking, client, controller, sessionId]);

  const handleFoldBranch = useCallback(() => {
    if (branchFolding || branchFoldPending || typeof client.foldBranch !== 'function') return;
    setBranchFolding(true);
    void client.foldBranch(sessionId, {
      branch_id: agentId,
      summary: undefined,
      done: true,
    })
      .then(async (res) => {
        if (!res.sealed && composerOwnerActive.current) {
          setBranchFoldPending(true);
          branchFoldSawBusyRef.current = headerBusy;
          pushToast({
            tone: 'info',
            text: locale === 'zh'
              ? '已通知分支总结并合回主线'
              : 'Asked the branch to summarize and merge back to main.',
          });
        }
        await controller?.resync();
        if (res.sealed && composerOwnerActive.current && transcriptVisibleRef.current) {
          navigation.openSession();
        }
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (composerOwnerActive.current) setBranchFolding(false);
      });
  }, [agentId, branchFoldPending, branchFolding, client, composerOwnerActive, controller, headerBusy, locale, navigation, sessionId]);

  const composerDisabled = !agentKnown || executorId === undefined || branchSealed;
  const handleComposerSend = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    options?: Parameters<ComponentProps<typeof Composer>['onSend']>[2],
    useSwitchDependency = true,
  ) => {
    if (!agentKnown || isPendingSubmissionInFlight(draftKey, sendScope)) return;
    const rawDraftText = draftRef.current;
    const carry = serializeSelectionCarryover(annotations, text, options?.presentation);
    const submittedText = carry.quotedText;
    const content = buildPromptContent(submittedText, composerAttachments, carry.presentation);
    if (content === null) return;
    const appendTiming = externalExecutor ? undefined : (options?.appendTiming ?? liveSettings.defaultAppendTiming);
    const skills = externalExecutor ? undefined : options?.skills;
    // Timing stays on the stored submission, outside this identity: a plain
    // retry after an unknown result must replay the original one-shot choice.
    const payload = JSON.stringify([submittedText, content, useSwitchDependency, skills]);
    const previous = pendingSendRef.current ?? readPendingSubmission(draftKey);
    // A lost acceptance retries the original execution payload, even if the queue advances.
    const baseSubmission = previous !== undefined && previous.scope === sendScope && !previous.retryInvalidated && previous.payload === payload
      ? {
          scope: previous.scope,
          connectionScopeId: previous.connectionScopeId,
          payload: previous.payload,
          key: previous.key,
          draftText: rawDraftText,
          appendTiming: previous.appendTiming,
          skills: previous.skills,
          afterModelSwitch: previous.afterModelSwitch,
        }
      : {
          scope: sendScope,
          connectionScopeId: scopeId,
          payload,
          key: crypto.randomUUID(),
          draftText: rawDraftText,
          appendTiming,
          skills,
          afterModelSwitch: useSwitchDependency ? modelSwitches.dependency?.input.operationId : undefined,
        };
    let resolveFlight!: () => void;
    const flightPromise = new Promise<void>((resolve) => {
      resolveFlight = resolve;
    });
    const { submission, generation } = beginPendingSubmissionFlight(draftKey, baseSubmission, flightPromise);
    pendingSendRef.current = submission;
    try {
      const hasNonTextAttachment = content.some((part) => part.type !== 'text');
      // Native text-only sends use the key as their prompt id, so the echo can
      // hand over to the projected row; other sends drop it when they settle.
      const keyedEcho = !externalExecutor && !hasNonTextAttachment;
      setSendEcho({ scope: sendScope, agentId, id: submission.key, text: submittedText, content, createdAt: new Date().toISOString(),
        slow: false, preserved: false, retryable: false, status: 'sending' });
      revealOwnSend(false);
      let receipt: Awaited<ReturnType<typeof client.sendAgentMessage>>;
      try {
        // The server already defaults to agent_idle; keep the ordinary six-arg
        // child send shape and add the seventh/eighth args only when needed.
        const effectiveTiming = submission.appendTiming === 'agent_idle' ? undefined : submission.appendTiming;
        receipt = submission.skills !== undefined
          ? await client.sendAgentMessage(sessionId, agentId, submittedText, content, submission.key, submission.afterModelSwitch, effectiveTiming, submission.skills)
          : effectiveTiming === undefined
            ? await client.sendAgentMessage(sessionId, agentId, submittedText, content, submission.key, submission.afterModelSwitch)
            : await client.sendAgentMessage(sessionId, agentId, submittedText, content, submission.key, submission.afterModelSwitch, effectiveTiming);
      } catch (error) {
        if (isDefinitivePromptRejection(error)) {
          clearSendEcho(submission.key);
          if (pendingSendRef.current?.key === submission.key) {
            setSendNotice(null);
          }
          throw error instanceof NativeChildPromptSendError ? error.cause : error;
        }
        // An unknown outcome under a replayable key stays on the timeline as
        // unconfirmed; anything else leaves it to the composer's draft.
        if (keyedEcho && error instanceof NativeChildPromptSendError) {
          setSendEcho((current) => current?.id === submission.key ? { ...current, status: 'offline' } : current);
        } else clearSendEcho(submission.key);
        // Native attachments have no replay receipt; a failed request may have
        // been accepted already. The external path rejects attachments before send.
        if (error instanceof NativeChildPromptSendError) {
          if (pendingSendRef.current?.key === submission.key) {
            setSendNotice({ scope: sendScope, text: t(hasNonTextAttachment
              ? 'agentMessage.attachmentOutcomeUnknown' : 'agentMessage.promptOutcomeUnknown') });
          }
          return;
        }
        if (hasNonTextAttachment && !(error instanceof ExternalAgentAttachmentUnsupportedError)) {
          if (pendingSendRef.current?.key === submission.key) {
            setSendNotice({ scope: sendScope, text: t('agentMessage.attachmentOutcomeUnknown') });
          }
          return;
        }
        if (pendingSendRef.current?.key === submission.key) setSendNotice(null);
        throw error;
      }
      if (receipt !== null && receipt.payloadConflict) {
        // The earlier message under this key was accepted with different content,
        // so this draft was NOT accepted. Fail closed before clearing: keep the
        // draft for a retry and let the composer report the failure in place
        // instead of reading as a delivered message.
        clearSendEcho(submission.key);
        if (pendingSendRef.current?.key === submission.key) {
          setSendNotice(null);
        }
        throw new Error(t('agentMessage.payloadConflict'));
      }
      if (keyedEcho) {
        setSendEcho((current) => current?.id === submission.key ? { ...current, settledOnServer: true } : current);
      } else clearSendEcho(submission.key);
      if (
        controller !== null &&
        typeof controller.resync === 'function' &&
        sessionState.cursor?.epoch?.startsWith('cold:') === true
      ) {
        void controller.resync();
      }
      const settled = settlePendingSubmission(draftKey, submission.key, carry.sentIds);
      if (!settled) {
        if (pendingSendRef.current?.key === submission.key) {
          pendingSendRef.current = null;
        }
        return;
      }
      if (composerOwnerActive.current && pendingSendRef.current?.key === submission.key) {
        pendingSendRef.current = null;
        draftRef.current = '';
        setSendNotice(null);
        setDraft('');
        setAttachments([]);
        if (carry.sentIds.size > 0) {
          setAnnotations((current) => current.filter((annotation) => !carry.sentIds.has(annotation.id)));
        }
      }
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
    } finally {
      finishPendingSubmissionFlight(draftKey, generation);
      resolveFlight();
    }
  };
  const handleActivateSkill: NonNullable<ComponentProps<typeof Composer>['onActivateSkill']> = async (name, args, skillAttachments, userInput) => {
    if (!agentKnown || isPendingSubmissionInFlight(draftKey, sendScope)) return;
    const rawDraftText = draftRef.current;
    const activation = buildSkillActivation(args, skillAttachments);
    const payload = JSON.stringify(['skill', name, activation, userInput]);
    const previous = pendingSendRef.current ?? readPendingSubmission(draftKey);
    const baseSubmission = previous !== undefined && previous.scope === sendScope && !previous.retryInvalidated && previous.payload === payload
      ? {
          scope: previous.scope,
          connectionScopeId: previous.connectionScopeId,
          payload: previous.payload,
          key: previous.key,
          draftText: rawDraftText,
          afterModelSwitch: previous.afterModelSwitch,
        }
      : {
          scope: sendScope,
          connectionScopeId: scopeId,
          payload,
          key: crypto.randomUUID(),
          draftText: rawDraftText,
          afterModelSwitch: modelSwitches.dependency?.input.operationId,
        };
    let resolveFlight!: () => void;
    const flightPromise = new Promise<void>((resolve) => {
      resolveFlight = resolve;
    });
    const { submission, generation } = beginPendingSubmissionFlight(draftKey, baseSubmission, flightPromise);
    pendingSendRef.current = submission;
    try {
      revealOwnSend(false);
      await client.activateSkill(sessionId, name, {
        ...activation, agent_id: agentId, user_input: userInput, prompt_id: submission.key,
        after_model_switch: submission.afterModelSwitch,
      });
      const settled = settlePendingSubmission(draftKey, submission.key);
      if (!settled) {
        if (pendingSendRef.current?.key === submission.key) pendingSendRef.current = null;
        return;
      }
      if (composerOwnerActive.current && pendingSendRef.current?.key === submission.key) {
        pendingSendRef.current = null;
        draftRef.current = '';
        setDraft('');
        setAttachments([]);
        setSendNotice(null);
      }
    } finally {
      finishPendingSubmissionFlight(draftKey, generation);
      resolveFlight();
    }
  };
  // The core chooses native safe-boundary steering or the external executor's
  // steer capability and reports an explicit queued reason when it defers.
  const handleComposerSendNow = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    presentation?: import('@kiki/transcript').TextPresentation,
    skills?: readonly PromptSkillActivation[],
  ) => {
    if (!agentKnown || isPendingSubmissionInFlight(draftKey, sendScope)) return;
    const submittedDraft = projectPresentedText(text, presentation);
    const carry = serializeSelectionCarryover(annotations, text, presentation);
    const content = buildPromptContent(carry.quotedText, composerAttachments, carry.presentation);
    if (content === null) return;
    if (controller === null) throw new Error(t('subagent.composerUnavailable'));
    const echoId = crypto.randomUUID();
    const hasNonTextAttachment = content.some((part) => part.type !== 'text');
    const keyedEcho = !externalExecutor && !hasNonTextAttachment;
    let resolveFlight!: () => void;
    const flightPromise = new Promise<void>((resolve) => {
      resolveFlight = resolve;
    });
    const { generation } = beginPendingSubmissionFlight(
      draftKey,
      {
        scope: sendScope,
        connectionScopeId: scopeId,
        payload: JSON.stringify(['send-now', carry.quotedText, content, skills]),
        key: echoId,
        draftText: draftRef.current,
      },
      flightPromise,
    );
    draftRef.current = '';
    setSendNotice(null);
    setDraft('');
    setAttachments([]);
    if (carry.sentIds.size > 0) {
      setAnnotations((current) => current.filter((annotation) => !carry.sentIds.has(annotation.id)));
    }
    setSendEcho({
      scope: sendScope,
      agentId,
      id: echoId,
      text: carry.quotedText,
      content,
      createdAt: new Date().toISOString(),
      slow: false,
      preserved: false,
      retryable: false,
      status: 'sending',
    });
    revealOwnSend(true);
    try {
      const result = await controller.sendPromptNow({
        agentId,
        text: carry.quotedText,
        content,
        skills: externalExecutor ? undefined : skills,
      });
      if (keyedEcho && result.promptId !== undefined) {
        setSendEcho((current) =>
          current?.id === echoId ? { ...current, id: result.promptId!, settledOnServer: true } : current,
        );
      } else {
        clearSendEcho(echoId);
      }
      settlePendingSubmission(draftKey, echoId, carry.sentIds);
      const notice = sendNowNotice(result.outcome, result.reason);
      if (notice !== undefined) pushToast({ tone: notice.tone, text: t(notice.key) });
      // A queued acknowledgement already carries its final reason; only
      // restoring/held receipts are open to a later durable read.
      if (result.outcome === 'restoring' || result.outcome === 'held') {
        trackNowReceipt(result.promptId, null);
      }
    } catch (error) {
      clearSendEcho(echoId);
      settlePendingSubmission(draftKey, echoId);
      const reason = error instanceof SendNowError ? error.reason : 'submit';
      if (reason !== 'unknown') {
        recoverSubmittedDraft(draftKey, submittedDraft, composerAttachments);
        if (carry.sentAnnotations.length > 0) {
          if (composerOwnerActive.current) {
            setAnnotations((current) => restoreSentAnnotations(current, carry.sentAnnotations));
          } else {
            updateStoredAnnotations(draftKey, (current) => restoreSentAnnotations(current, carry.sentAnnotations));
          }
        }
      }
      const cause = error instanceof SendNowError ? error.cause : error;
      pushToast({
        tone: 'error',
        text: t(reason === 'refused' ? 'sv.steerRefused' : reason === 'unknown' ? 'sv.steerUnknown' : 'sv.steerFailed', {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      });
    } finally {
      finishPendingSubmissionFlight(draftKey, generation);
      resolveFlight();
    }
  };
  const childDurableIngress = useMemo(
    () => filterIngressForAgent(sessionState.durableIngress, agentId),
    [sessionState.durableIngress, agentId],
  );
  // Stop is a server-side cancel that can fail; duplicate requests during the
  // round trip are guarded by a synchronous ref (a state-only guard can be
  // crossed by two events in the same batch), mirrored to state for the
  // disabled UI. Both clear in finally, so a rejected stop stays retryable.
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const handleTerminateAgent = async () => {
    if ((!headerBusy && runningAgentTask === undefined) || stoppingRef.current !== null) return;
    const targetId = runningAgentTask?.id ?? agentId;
    stoppingRef.current = targetId;
    setStoppingTaskId(targetId);
    try {
      if (runningAgentTask !== undefined) await client.stopAgentTask(sessionId, ownerAgentId, runningAgentTask.id);
      else if (externalExecutor) await klient.session(sessionId).agent(agentId).cancelExecution();
      else await klient.session(sessionId).agent(agentId).cancel();
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
  const handleChangeAgentModel = async (model: string | undefined) => {
    if (!agentKnown || model === undefined) return;
    const target = externalExecutor ? model : resolveCatalogModel(modelsQuery.data?.items ?? [], model)?.id ?? model;
    const current = displayModel === undefined
      ? undefined
      : externalExecutor ? displayModel : resolveCatalogModel(modelsQuery.data?.items ?? [], displayModel)?.id ?? displayModel;
    if (current !== undefined && target === current) return;
    const hasConversationBlocks = agentLiveState.blocks.some(
      (block) => block.kind === 'user' || block.kind === 'assistant' || block.kind === 'tool' || block.kind === 'message',
    );
    // External executors own their context. Unbound agents or native children
    // without history also have nothing to hand over, so use a plain binding change.
    if (externalExecutor || boundChildModel === undefined || (!isBranch && !hasConversationBlocks)) {
      try {
        await client.setAgentModel(sessionId, agentId, model);
        if (externalExecutor && headerBusy) setExternalBindingSetting(previous => ({ model, thinking: previous?.thinking ?? displayEffort }));
        await queryClient.invalidateQueries({
          queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
        });
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
    await openChildModelSwitch(target);
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
    agentLiveState.thinkingEffort ??
    selectedNode?.thinkingEffort ??
    selectedSubagent?.thinkingEffort ??
    capabilitiesProfile?.thinking_effort ??
    (isBranch && boundChildModel === undefined ? parentThinkingEffort : undefined);
  // The effort ladder comes from the DISPLAY model's catalog row: a bare alias
  // on the node (`k3-256k`) resolves to the provider row that owns
  // `support_efforts`. Resumable agents retain their binding controls.
  const resolvedDisplayModel =
    displayModel !== undefined
      ? resolveCatalogModel(modelsQuery.data?.items ?? [], displayModel)
      : undefined;
  const supportedEfforts =
    !composerDisabled ? resolvedDisplayModel?.support_efforts : undefined;
  const handleChangeAgentEffort = async (effort: string | undefined) => {
    if (composerDisabled || effort === undefined || effort === displayEffort) return;
    if (externalExecutor) {
      try {
        await client.setAgentEffort(sessionId, agentId, effort);
        if (headerBusy && displayModel !== undefined) setExternalBindingSetting(previous => ({ model: previous?.model ?? displayModel, thinking: effort }));
      } catch (error) {
        pushToast({
          tone: 'error',
          text: t('subagent.effortChangeFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        return;
      }
    } else {
      const model = modelSwitches.dependency?.input.model ?? displayModel;
      if (model === undefined) return;
      const ok = await applyChildEffortSetting(model, effort);
      if (!ok) return;
    }
    try {
      await queryClient.invalidateQueries({
        queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        text: t('subagent.effortChangeFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };
  const displayContextTokens = agentLiveState.contextTokens ?? selectedNode?.contextTokens;
  const resolvedMaxContextTokens = agentLiveState.maxContextTokens === 0
    ? undefined
    : agentLiveState.maxContextTokens
      ?? selectedNode?.maxContextTokens
      ?? (executorId === 'native' ? resolvedDisplayModel?.max_context_size : undefined);
  const displayUsage = agentLiveState.usage ?? selectedNode?.usage;
  const displayMaxContextTokens = resolvedMaxContextTokens ?? contextAutoCompact?.status.effectiveMaxContextTokens;
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
  const inheritedPermissionMode = isBranch
    ? (parentPermissionMode ?? liveSettings.defaultPermissionMode)
    : undefined;
  const permissionMode = permissionOverride ?? agentLiveState.permissionMode ?? inheritedPermissionMode ?? 'manual';
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
  const scopedEcho = sendEcho?.scope === sendScope ? sendEcho : undefined;
  const echoOwned = scopedEcho !== undefined && (
    agentBlocks.some((block) => block.kind === 'user' && block.promptId === scopedEcho.id) ||
    agentLiveState.queuedPromptIds.includes(scopedEcho.id)
  );
  useEffect(() => {
    if (echoOwned) clearSendEcho(scopedEcho.id);
  }, [echoOwned, scopedEcho?.id]);
  const timelineBlocks = useMemo(() => {
    const optimistic = withOptimisticUserBlock(agentBlocks, echoOwned ? undefined : scopedEcho, agentId);
    const blocks = withAdmissionUserBlocks(optimistic, childDurableIngress, agentId);
    if (scopedEcho?.settledOnServer !== true || optimistic === agentBlocks) return blocks;
    let changed = false;
    const settled = blocks.map((block) => {
      if (block.kind !== 'user' || block.promptId !== scopedEcho.id || block.optimisticStatus === undefined) return block;
      changed = true;
      return { ...block, optimisticStatus: undefined };
    });
    return changed ? settled : blocks;
  }, [agentBlocks, agentId, childDurableIngress, echoOwned, scopedEcho]);
  timelineBlocksRef.current = timelineBlocks;
  const childAdmissionScope = useAdmissionScope({
    ingress: childDurableIngress,
    agentId,
    blocks: timelineBlocks,
    controller,
  });
  // Memoised like the main session's `timelineState`: `Transcript` and its
  // rows compare the state and the callbacks below by identity, so rebuilding
  // them on every render (each composer keystroke) re-rendered the timeline.
  const agentState = useMemo<SessionViewState>(() => ({
    ...agentLiveState,
    session: sessionState.session,
    blocks: agentBlocks,
    durableIngress: childDurableIngress,
    busy: headerBusy,
    model: displayModel,
    thinkingEffort: displayEffort,
    contextTokens: displayContextTokens,
    maxContextTokens: displayMaxContextTokens,
    contextBreakdown: undefined,
    usage: displayUsage,
    pendingInteraction: agentLiveState.pendingInteraction ?? 'none',
  }), [
    agentLiveState, sessionState.session, agentBlocks, childDurableIngress, headerBusy, displayModel,
    displayEffort, displayContextTokens, displayMaxContextTokens, displayUsage,
  ]);
  const timelineState = useMemo(
    () => timelineBlocks === agentBlocks ? agentState : { ...agentState, blocks: timelineBlocks },
    [agentState, agentBlocks, timelineBlocks],
  );
  const handleCancelQueued = useMemo(
    () => controller === null ? undefined : (promptId: string) => { void timelineActions.cancelQueued(promptId); },
    [controller, timelineActions.cancelQueued],
  );

  const composerWorking = headerBusy && agentState.pendingInteraction === 'none';
  const lastResponseAt = useLastResponseAt(composerWorking, agentBlocks, agentState.turnStartedAt);
  const composerWorkingInfo = useMemo(
    () => (composerWorking ? { lastResponseAt } : undefined),
    [composerWorking, lastResponseAt],
  );
  // Difference B (`busyPlainSendMode: 'steer'`): a busy child with a live
  // controller steers on plain send unless a pending submission retry or
  // queued model switch holds the prompt on the queue.
  const handleComposerSendBusy: ComponentProps<typeof Composer>['onSend'] = (
    text,
    composerAttachments,
    options,
  ) =>
    options?.appendTiming !== undefined || pendingSendRef.current !== null
      ? handleComposerSend(text, composerAttachments, options)
      : handleComposerSendNow(text, composerAttachments, options?.presentation, options?.skills);

  const handleComposerSendRef = useRef(handleComposerSend);
  handleComposerSendRef.current = handleComposerSend;
  const handleContinueFailedTurn = useCallback(() => {
    void handleComposerSendRef.current(locale === 'zh' ? '继续' : 'Continue', []);
  }, [locale]);
  const handleRetryFailedTurn = useCallback((failedUserBlock: { readonly text: string } | undefined) => {
    const text = failedUserBlock?.text.trim() || (locale === 'zh' ? '继续' : 'Continue');
    void handleComposerSendRef.current(text, []);
  }, [locale]);

  const chrome = (
    <MessageViewContext.Provider value={core.messageViewContext}>
    <InteractionPlacementContext.Provider value={core.interactionPlacement}>
    <ModelSwitchActionsContext.Provider value={modelSwitchActions}>
    <AdmissionScope value={childAdmissionScope}>
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
        onLocateSpawn={locateSpawnInMenu ? timelineActions.jumpToSpawn : undefined}
        promote={promoteAction}
        branchSeamLabel={branchSeamLabel}
      />}
      timeline={{
        state: timelineState,
        agentId, onLoadOlder: timelineActions.loadOlder, showQueuedPrompts: true,
        onResolveApproval: timelineActions.resolveApproval, onAnswerQuestion: timelineActions.answerQuestion,
        onDismissQuestion: timelineActions.dismissQuestion, forest, onOpenAgent: navigation.openAgent,
        onRetryLoad: timelineActions.retryLoad,
        onCancelQueued: handleCancelQueued,
        onContinueFailedTurn: composerDisabled ? undefined : handleContinueFailedTurn,
        onRetryFailedTurn: composerDisabled ? undefined : handleRetryFailedTurn,
        visible: transcriptVisible,
      }}
      annotations={branchSealed ? undefined : annotationSurface}
      dock={<div className="space-y-2 pt-2">
        <ResyncStatusBanner
          resyncing={sessionState.resyncing} resyncFailed={sessionState.resyncFailed}
          error={sessionState.resyncError}
          onRetry={controller === null ? undefined : () => { void controller.resync(); }}
        />
        {isBranch && branchSealed ? (
          <ConversationDockColumn
            data-branch-sealed-bar={agentId}
            innerClassName="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] text-ink-soft"
          >
            <span className="min-w-0 truncate font-medium text-ink">
              {t('transcript.branch.sealed')}
            </span>
            <button
              type="button"
              data-branch-sealed-back-to-main
              onClick={() => { navigation.openSession(); }}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-ink/[0.06] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.10]"
            >
              <Icon name="arrowLeft" size={12} />
              <span>{t('rail.branches.backToMain')}</span>
            </button>
          </ConversationDockColumn>
        ) : null}
        {isBranch && !branchSealed ? (
          <ConversationDockColumn
            data-branch-fold-bar={agentId}
            innerClassName="flex flex-wrap items-center justify-between gap-2 px-1 text-[12px] text-ink-soft"
          >
            <span className="min-w-0 truncate">
              {branchToolsLocked ? t('transcript.branch.toolsLocked') : branchSeamLabel}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {branchToolsLocked ? (
                <button
                  type="button"
                  data-branch-unlock-tools
                  disabled={branchUnlocking}
                  onClick={handleUnlockBranchTools}
                  className="h-7 cursor-pointer rounded-md border border-hairline bg-paper px-2.5 text-[12px] text-ink transition-colors hover:border-hairline-strong disabled:cursor-not-allowed disabled:text-ink-faint"
                >
                  {t('transcript.branch.unlockTools')}
                </button>
              ) : null}
              <button
                type="button"
                data-branch-fold-action
                disabled={branchFolding || branchFoldPending}
                onClick={handleFoldBranch}
                className="h-7 cursor-pointer rounded-md bg-ink/[0.06] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-ink/[0.10] disabled:cursor-not-allowed disabled:text-ink-faint"
              >
                {branchFoldPending
                  ? (locale === 'zh' ? '正在总结并合回…' : 'Summarizing & merging…')
                  : t(branchFolding ? 'transcript.branch.folding' : 'transcript.branch.foldAction')}
              </button>
            </div>
          </ConversationDockColumn>
        ) : null}
        {sendNotice?.scope === sendScope ? (
          <ConversationDockColumn>
            <p role="alert" className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[11px] text-danger">
              {sendNotice.text}
            </p>
          </ConversationDockColumn>
        ) : null}
        {executorBindingQuery.isError && reportedExecutorId === undefined ? (
          <ConversationDockColumn>
            <p role="status" className="px-1 text-[12px] text-ink-faint">
              {t('diagnostics.error')} · {executorBindingQuery.error.message}
              <button type="button" className="ml-2 underline" onClick={() => { void executorBindingQuery.refetch(); }}>{t('common.retry')}</button>
            </p>
          </ConversationDockColumn>
        ) : null}
        {externalExecutor ? (
          <ConversationDockColumn data-runtime-modes-external>
            <p className="px-1 text-[12px] text-ink-faint">{t('subagent.runtimeModesExternal')}</p>
          </ConversationDockColumn>
        ) : null}
        <Composer
          {...core.composerProps}
          variant="subagent" replyingTo={isBranch ? undefined : displayName} busy={headerBusy}
          disabled={composerDisabled} sendDisabled={submissionInFlight}
          delegationPosition={isBranch ? 'main' : 'sub'}
          boundExecution={childExecution}
          engine={executorId === undefined ? { label: t('composer.unknown'), fork: false, images: false } : undefined}
          disabledPlaceholder={t('subagent.composerUnavailable')}
          model={displayModel} defaultModel={displayModel} serverDefaultModel={configuredDefaultModel ?? displayModel}
          modelSource="session" permissionMode={permissionMode}
          planMode={planMode} efforts={supportedEfforts} effort={displayEffort}
          contextUsage={displayMaxContextTokens !== undefined && (
            displayContextTokens !== undefined ||
            agentLiveState.blocks.length > 0 ||
            contextAutoCompact !== undefined ||
            composerUsage !== undefined
          )
            ? { used: displayContextTokens, limit: displayMaxContextTokens } : undefined}
          sessionUsage={composerUsage} agentProfileCatalogMode={{ mode: 'disabled' }}
          mentionScopeKey={`${scopeId}:${sessionId}`}
          onOpenImage={handleOpenImage}
          onChangeModel={handleChangeAgentModel} onChangePermissionMode={handlePermissionChange}
          onChangePlanMode={handlePlanChange}
          onChangeEffort={(effort) => { void handleChangeAgentEffort(effort); }}
          onSend={core.busySendsNow ? handleComposerSendBusy : handleComposerSend}
          onActivateSkill={externalExecutor ? undefined : handleActivateSkill}
          onSendNow={canSteerChildNow ? handleComposerSendNow : undefined}
          working={composerWorkingInfo}
          onAbort={headerBusy || runningAgentTask !== undefined ? () => { void handleTerminateAgent(); } : undefined}
          abortPending={stoppingTaskId !== null}
        />
      </div>}
      rail={<RightRail
        className={`app-rail ${railOpen ? 'open' : ''}`} state={agentState} forest={forest}
        selectedAgentId={agentId}
        subagent={{ agentId, block: selectedSubagent,
          pendingInteractionCount: agentPendingInteractionCount, onJumpToSpawn: timelineActions.jumpToSpawn }}
        taskOwnerAgentId={agentId} onCancelTask={onCancelTask}
        onStopAgentTask={onStopAgentTask} onOpenSubagent={navigation.openAgent}
        onClose={onCloseRail}
      />}
      railOpen={railOpen} railIsOverlay={railIsOverlay} onCloseRail={onCloseRail}
    />
    </AdmissionScope>
    <ModelSwitchDialog {...core.modelSwitchDialogProps} />
    </ModelSwitchActionsContext.Provider>
    </InteractionPlacementContext.Provider>
    </MessageViewContext.Provider>
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
      apiRef={effectivePreviewRef}
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
