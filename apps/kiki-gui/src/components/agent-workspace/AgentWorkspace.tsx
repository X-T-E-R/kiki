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

import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PermissionMode } from '@kiki/protocol';
import { buildPromptContent, type ComposerAttachment } from '@kiki/session-core/composer';
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
import { resolveCatalogModel } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { ExternalAgentAttachmentUnsupportedError, NativeChildPromptSendError } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import type { PlanReviewResponse } from '../Interactions';
import { useConnection } from '../../state/connection';
import { locateInTimeline } from '../../lib/timelineLocate';
import { AgentBreadcrumb, AgentRelations } from '../AgentBreadcrumb';
import { AnnotationTray } from '../AnnotationTray';
import {
  EMPTY_SLOTS,
  useOptionalConversationShell,
  type ConversationShellSlots,
} from '../ConversationShell';
import { Composer } from '../Composer';
import type { ContextMeterUsage } from '../ContextMeter';
import { useContextMeterAutoCompact } from '../useContextMeterAutoCompact';
import { Icon } from '../icons';
import { MediaPreviewProvider, PreviewToggleButton } from '../mediaPreview';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { RightRail } from '../RightRail';
import { Transcript } from '../Transcript';
import { TranscriptDetailProvider } from '../transcriptDetail';
import { ResyncStatusBanner } from './ResyncStatusBanner';

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
  /** The preview tab can reopen the session's one shared rail even when its
   * full-width narrow overlay obscures the main header. */
  readonly sharedRail?: { readonly open: boolean; readonly toggle: () => void };
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
  /** Below lg the rail is a fixed overlay drawer; the shell measures the viewport. */
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
  /** Header breadcrumb; suppressed in narrow containers (the relations row stays). */
  readonly showBreadcrumb?: boolean;
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
  const loadDetail = useCallback(
    (agentId: string, kind: TranscriptDetailKind, id: string) =>
      controller?.loadTranscriptDetail(agentId, kind, id) ?? Promise.resolve(false),
    [controller],
  );
  return (
    <TranscriptDetailProvider load={loadDetail} loads={timeline.state.detailLoads}>
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
      {railIsOverlay && railOpen ? (
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
  showBreadcrumb,
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
  /** Off in narrow containers (tabs): the relations row below keeps the navigation. */
  showBreadcrumb: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <WorkspaceHeader>
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
        {/* Pure open-rail entry: renders only while the shared rail is
            collapsed. Once expanded, the rail's own collapse affordances take
            over — no "hide panel" button in this header. */}
        {showRailToggle && !railOpen ? (
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
      <div className="shrink-0 bg-paper px-4 pb-2 text-[12px] lg:px-5">
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

export function AgentWorkspace(props: AgentWorkspaceProps) {
  const ambientSlots = useOptionalConversationShell()?.slots;
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
  return <ChildAgentWorkspace {...props} />;
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
  showBreadcrumb = true,
  transcriptVisible = true,
}: AgentWorkspaceProps) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const contextSlots = useOptionalConversationShell()?.slots;
  const slots = slotsOverride ?? contextSlots ?? EMPTY_SLOTS;
  const { sessionId, agentId } = target;
  // A key belongs to one unacknowledged submission, not to the draft text
  // forever. Switching the connection or endpoint invalidates it even if a
  // later render switches back to the same target and unchanged draft.
  const sendScope = JSON.stringify([scopeId, sessionId, agentId]);
  const [sendNotice, setSendNotice] = useState<{ scope: string; text: string } | null>(null);
  const pendingSendRef = useRef<{ scope: string; payload: string; key: string } | null>(null);
  const previousSendScopeRef = useRef(sendScope);
  if (previousSendScopeRef.current !== sendScope) {
    previousSendScopeRef.current = sendScope;
    pendingSendRef.current = null;
  }
  const draftRef = useRef(draft);
  draftRef.current = draft;
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

  // Same query key as the session view: one catalog fetch, shared cache.
  const handleLoadOlder = useCallback(async (): Promise<boolean> => {
    if (controller === null) return false;
    return controller.loadOlderMessages(agentId);
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

  // Parent jump-back: navigate to the spawning agent's timeline, then locate
  // this agent's card there (the locate entry waits for the target view to
  // mount, pages older history in, and reports when the card is gone).
  const handleJumpToSpawn = (): void => {
    const spawnParentId = selectedNode?.parentAgentId ?? selectedSubagent?.parentAgentId;
    if (spawnParentId === undefined || spawnParentId === MAIN_AGENT_ID) {
      navigation.openSession();
    } else {
      navigation.openAgentRoute(spawnParentId);
    }
    void locateInTimeline(
      { kind: 'subagent', agentId },
      { sessionId: target.sessionId, agentId: spawnParentId ?? MAIN_AGENT_ID },
    );
  };
  const headerBusy = selectedNode?.busy === true || agentLiveState.busy;
  const displayName = selectedNode?.label ?? selectedSubagent?.name ?? agentId;
  const displayModel = agentLiveState.model ?? selectedNode?.model ?? selectedSubagent?.model;
  // The child run is a task on the PARENT agent's task service; nested agents
  // therefore need the parent's per-agent snapshot rather than the main one.
  const { ownerAgentId, task: runningAgentTask } = resolveRunningSubagentTask({
    agentId,
    parentAgentId: selectedNode?.parentAgentId ?? parentAgentId,
    mainTasks: sessionState.tasks,
    parentTasks: parentAgentState.tasks,
  });
  // Sendable whenever the forest can still resolve this agent: a closed child
  // (completed / cancelled / failed) is a wakeable target the engine resumes on
  // a new prompt, so terminal status is not an input gate. Only a node the
  // forest does not know at all is genuinely unreachable.
  const agentKnown = selectedNode !== undefined;
  const composerDisabled = !agentKnown;
  const handleComposerSend = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
  ) => {
    if (!agentKnown) return;
    const content = buildPromptContent(text, composerAttachments);
    if (content === null) return;
    const payload = JSON.stringify([text, content]);
    const previous = pendingSendRef.current;
    const submission = previous?.scope === sendScope && previous.payload === payload
      ? previous
      : { scope: sendScope, payload, key: crypto.randomUUID() };
    pendingSendRef.current = submission;
    const hasNonTextAttachment = content.some((part) => part.type !== 'text');
    let receipt: Awaited<ReturnType<typeof client.sendAgentMessage>>;
    try {
      receipt = await client.sendAgentMessage(sessionId, agentId, text, content, submission.key);
    } catch (error) {
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
  // "Send now" into this child's running turn — the controller's steer path,
  // shared with the main session, so the echo, the insertion point (next
  // step boundary) and the failure fallback are identical. Only a native
  // child can be steered; an external executor keeps its mailbox path.
  const handleComposerSendNow = async (
    text: string,
    composerAttachments: readonly ComposerAttachment[],
  ) => {
    if (!agentKnown) return;
    const content = buildPromptContent(text, composerAttachments);
    if (content === null) return;
    if (controller === null || !(await client.isNativeAgent(sessionId, agentId))) {
      await handleComposerSend(text, composerAttachments);
      return;
    }
    draftRef.current = '';
    setSendNotice(null);
    setDraft('');
    setAttachments([]);
    try {
      const result = await controller.sendPromptNow({ agentId, text, content });
      if (result.outcome === 'queued') pushToast({ tone: 'info', text: t('sv.steerTurnEnded') });
    } catch (error) {
      const reason = error instanceof SendNowError ? error.reason : 'submit';
      if (reason !== 'unknown' && draftRef.current === '') {
        // Nothing reached the turn: hand the text back to its author.
        draftRef.current = text;
        setDraft(text);
        setAttachments(composerAttachments);
      }
      const cause = error instanceof SendNowError ? error.cause : error;
      pushToast({
        tone: 'error',
        text: t(reason === 'refused' ? 'sv.steerRefused' : reason === 'unknown' ? 'sv.steerUnknown' : 'sv.steerFailed', {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      });
    }
  };
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
  const handleChangeAgentModel = async (model: string | undefined) => {
    if (!agentKnown || model === undefined || model === displayModel) return;
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
  const selectedStatus = selectedNode?.status ?? selectedSubagent?.status;
  const agentTerminal =
    selectedStatus === 'completed' || selectedStatus === 'cancelled' || selectedStatus === 'failed';
  const supportedEfforts =
    agentKnown && !agentTerminal ? resolvedDisplayModel?.support_efforts : undefined;
  const handleChangeAgentEffort = async (effort: string | undefined) => {
    if (!agentKnown || agentTerminal || effort === undefined || effort === displayEffort) return;
    try {
      await client.setAgentEffort(sessionId, agentId, effort);
      // The rail's per-agent capability read is what echoes this agent's
      // effective effort; refetch it so the pick reads as applied rather than
      // as a stale default.
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
      (!agentLiveState.transcriptReady && sessionState.resyncFailed ? sessionState.resyncError?.message : undefined),
    busy: headerBusy,
    model: displayModel,
    thinkingEffort: displayEffort,
    contextTokens: displayContextTokens,
    maxContextTokens: displayMaxContextTokens,
    contextBreakdown: undefined,
    usage: displayUsage,
    pendingInteraction: 'none',
  };

  const chrome = (
    <WorkspaceSurface
      target={target}
      controller={controller}
      slots={slots}
      header={<AgentWorkspaceHeader
        target={target} name={displayName} model={displayModel} effort={displayEffort}
        crumbs={crumbs} forest={forest} railOpen={railOpen} onToggleRail={onToggleRail}
        navigation={navigation} showPreviewToggle={showPreviewToggle}
        showRailToggle={showRailToggle} showBreadcrumb={showBreadcrumb}
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
        {/* Notes already sent in this agent's own conversation, located in
            this tab's timeline (the main session mounts the same tray). */}
        <AnnotationTray sessionId={sessionId} agentId={agentId} blocks={agentState.blocks} />
        <Composer
          variant="subagent" replyingTo={displayName} busy={headerBusy} disabled={composerDisabled}
          disabledPlaceholder={t('subagent.composerUnavailable')}
          value={draft} onChange={handleDraftChange}
          model={displayModel} defaultModel={displayModel} serverDefaultModel={displayModel}
          modelSource="session" permissionMode={agentLiveState.permissionMode ?? ('manual' as PermissionMode)}
          planMode={false} efforts={supportedEfforts} effort={displayEffort}
          contextUsage={displayContextTokens !== undefined && displayMaxContextTokens !== undefined
            ? { used: displayContextTokens, limit: displayMaxContextTokens } : undefined}
          contextAutoCompact={contextAutoCompact}
          sessionUsage={composerUsage} sessionId={sessionId} agentProfileCatalogMode={{ mode: 'disabled' }}
          attachments={attachments} onChangeAttachments={handleAttachmentsChange}
          onChangeModel={handleChangeAgentModel} onChangePermissionMode={() => {}}
          onChangePlanMode={() => {}}
          onChangeEffort={(effort) => { void handleChangeAgentEffort(effort); }}
          onSend={headerBusy ? handleComposerSendNow : handleComposerSend}
          onSendNow={handleComposerSendNow}
          busySendsNow
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
  );

  // Embedded mode (preview tab): the ambient session-level provider already
  // owns media overlays and the one preview workspace; mounting another
  // provider here would fork that seat.
  if (inheritMediaPreview) return chrome;

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
      onStopAgentTask={onStopAgentTask}
    >
      {chrome}
    </MediaPreviewProvider>
  );
}
