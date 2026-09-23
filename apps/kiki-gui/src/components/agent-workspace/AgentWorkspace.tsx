/**
 * AgentWorkspace — the unified agent workspace: header (identity, status,
 * actions), timeline, resync banner, and detail rail for one agent target.
 *
 * The target arrives as a prop from the route shell; this component never
 * reads the URL to decide who it shows, and it never creates or closes the
 * session controller — the shell owns the shared runtime and passes it in
 * together with the session-level (main) view state. That main state is an
 * explicit seam: the child timeline cards, owner task lists, resync status
 * and session record live on it, while configuration and usage never leak
 * from main into the child projection assembled below.
 *
 * Container concerns (close/back, fullscreen, sizing, tab arrangement) stay
 * with the shell, expressed here through `navigation` and the rail props.
 */

import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PermissionMode } from '@kiki/protocol';
import { buildPromptContent, type ComposerAttachment } from '@kiki/session-core/composer';
import {
  agentPath,
  createViewState,
  filterBlocksToDirectChildren,
  MAIN_AGENT_ID,
  sessionAgentForest,
  type AgentForest,
  type AgentTreeNode,
  type SessionController,
  type SessionViewState,
  type SubagentBlock,
} from '@kiki/session-core/session';
import { resolveCatalogModel } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { revealSubagentCard } from '../ActivityHistory';
import { AgentBreadcrumb, AgentRelations } from '../AgentBreadcrumb';
import {
  EMPTY_SLOTS,
  useOptionalConversationShell,
  type ConversationShellSlots,
} from '../ConversationShell';
import { Composer } from '../Composer';
import type { ContextMeterUsage } from '../ContextMeter';
import { MediaPreviewProvider, PreviewToggleButton } from '../mediaPreview';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { RightRail } from '../RightRail';
import { Transcript } from '../Transcript';
import { ResyncStatusBanner } from './ResyncStatusBanner';

export function PanelIcon({ className = '' }: { className?: string }) {
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
   * Header rail open/close toggle (the shared rail's own affordance, the same
   * control the main session header renders). Off where the toggle's railOpen
   * state is a local no-op — the embedded panel tab, whose rail lives in the
   * main session header.
   */
  readonly showRailToggle?: boolean;
  /** Header breadcrumb; suppressed in narrow containers (the relations row stays). */
  readonly showBreadcrumb?: boolean;
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
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-hairline bg-panel px-4 py-2">
        <div className="min-w-24 flex-1">
          {showBreadcrumb ? (
            <AgentBreadcrumb
              crumbs={crumbs}
              onOpenSession={navigation.openSession}
              onOpenAgent={navigation.openAgent}
            />
          ) : null}
          <h1 className="truncate font-display text-[15px] font-semibold text-ink">
            {name}
          </h1>
          <p className="truncate text-[10.5px] text-ink-faint">
            {t('sv.subagentNote')}
            {' · '}
            {t('sv.agentActionsNote')}
          </p>
        </div>
        {model !== undefined ? (
          <span className="rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
            {model}
          </span>
        ) : null}
        {effort !== undefined ? (
          <span
            data-agent-effort
            className="rounded-full border border-hairline bg-paper px-2 py-0.5 text-[10.5px] text-ink-soft"
          >
            {t('subagent.effort', { effort })}
          </span>
        ) : null}

        {showPreviewToggle ? <PreviewToggleButton /> : null}
        {/* The shared rail's own open/close affordance — the same toggle the
            main session header renders (data-agent-rail-toggle). This is the
            rail's collapsible control, not a view-level hide button. */}
        {showRailToggle ? (
          <button
            type="button"
            onClick={onToggleRail}
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
        ) : null}
      </header>
      <div className="shrink-0 border-b border-hairline px-4 py-2 text-[11px]">
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

export function AgentWorkspace({
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
}: AgentWorkspaceProps) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const contextSlots = useOptionalConversationShell()?.slots;
  const slots = slotsOverride ?? contextSlots ?? EMPTY_SLOTS;
  const { sessionId, agentId } = target;

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
      controller === null ? () => {} : controller.subscribeAgent(agentId, listener),
    [controller, agentId],
  );
  const agentLiveState = useSyncExternalStore(subscribeAgent, () =>
    controller !== null ? controller.getAgentState(agentId) : emptyAgentView,
  );
  const parentAgentId =
    (controller?.getForest() ?? sessionAgentForest(sessionState)).byId[agentId]?.parentAgentId;
  const subscribeParentAgent = useCallback(
    (listener: () => void) =>
      controller === null || parentAgentId === undefined || parentAgentId === MAIN_AGENT_ID
        ? () => {}
        : controller.subscribeAgent(parentAgentId, listener),
    [controller, parentAgentId],
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

  // Parent jump-back: navigate to the spawning agent's timeline, then
  // smooth-scroll to this agent's card there (retried briefly while the
  // target view mounts and publishes its first blocks). The card may sit
  // inside a collapsed history run; revealSubagentCard expands that run on
  // the way, so the retry loop converges once the run is mounted.
  const handleJumpToSpawn = (): void => {
    const spawnParentId = selectedNode?.parentAgentId ?? selectedSubagent?.parentAgentId;
    if (spawnParentId === undefined || spawnParentId === MAIN_AGENT_ID) {
      navigation.openSession();
    } else {
      navigation.openAgentRoute(spawnParentId);
    }
    const scrollToCard = (attemptsLeft: number): void => {
      if (revealSubagentCard(agentId)) return;
      if (attemptsLeft > 0) window.setTimeout(() => { scrollToCard(attemptsLeft - 1); }, 150);
    };
    window.setTimeout(() => { scrollToCard(12); }, 150);
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
    await client.sendAgentMessage(sessionId, agentId, text, content);
    setDraft('');
    setAttachments([]);
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
  const agentState: SessionViewState = {
    ...agentLiveState,
    session: sessionState.session,
    blocks: filterBlocksToDirectChildren(capturedBlocks, forest, agentId),
    loaded: agentLiveState.loaded || sessionState.loaded,
    loadError: agentLiveState.loadError ?? sessionState.loadError,
    busy: headerBusy,
    model: displayModel,
    thinkingEffort: displayEffort,
    contextTokens: displayContextTokens,
    maxContextTokens: displayMaxContextTokens,
    contextBreakdown: undefined,
    usage: displayUsage,
    pendingInteraction: 'none',
  };

  // The backdrop exists only while a drawer actually overlays the transcript:
  // below lg the rail becomes a fixed overlay (see .app-rail in index.css).
  const showBackdrop = railIsOverlay && railOpen;

  const chrome = (
    <>
      {slots.header !== null
        ? createPortal(
            <AgentWorkspaceHeader
              target={target}
              name={displayName}
              model={displayModel}
              effort={displayEffort}
              crumbs={crumbs}
              forest={forest}
              railOpen={railOpen}
              onToggleRail={onToggleRail}
              navigation={navigation}
              showPreviewToggle={showPreviewToggle}
              showRailToggle={showRailToggle}
              showBreadcrumb={showBreadcrumb}
            />,
            slots.header,
          )
        : null}
      <Transcript
        state={agentState}
        onLoadOlder={handleLoadOlder}
        onResolveApproval={handleResolveApproval}
        onAnswerQuestion={handleAnswerQuestion}
        onDismissQuestion={handleDismissQuestion}
        forest={forest}
        onOpenAgent={navigation.openAgent}
      />
      {slots.dock !== null
        ? createPortal(
            <div className="space-y-2 pt-2">
              <Composer
                variant="subagent"
                busy={headerBusy}
                disabled={composerDisabled}
                disabledPlaceholder={t('subagent.composerUnavailable')}
                value={draft}
                onChange={setDraft}
                model={displayModel}
                defaultModel={displayModel}
                serverDefaultModel={displayModel}
                modelSource="session"
                permissionMode={agentLiveState.permissionMode ?? ('manual' as PermissionMode)}
                planMode={false}
                swarmMode={false}
                efforts={supportedEfforts}
                effort={displayEffort}
                contextUsage={
                  displayContextTokens !== undefined && displayMaxContextTokens !== undefined
                    ? { used: displayContextTokens, limit: displayMaxContextTokens }
                    : undefined
                }
                sessionUsage={composerUsage}
                sessionId={sessionId}
                agentProfileCatalogMode={{ mode: 'disabled' }}
                attachments={attachments}
                onChangeAttachments={setAttachments}
                onChangeModel={handleChangeAgentModel}
                onChangePermissionMode={() => {}}
                onChangePlanMode={() => {}}
                onChangeSwarmMode={() => {}}
                onChangeEffort={handleChangeAgentEffort}
                onSend={handleComposerSend}
                onAbort={runningAgentTask !== undefined ? handleTerminateAgent : undefined}
                abortPending={stoppingTaskId !== null}
              />
              <ResyncStatusBanner
                resyncing={sessionState.resyncing}
                resyncFailed={sessionState.resyncFailed}
                error={sessionState.resyncError}
                onRetry={controller === null ? undefined : () => { void controller.resync(); }}
              />
            </div>,
            slots.dock,
          )
        : null}
      {slots.rail !== null && railOpen
        ? createPortal(
            <RightRail
              className={`app-rail ${railOpen ? 'open' : ''}`}
              state={agentState}
              forest={forest}
              selectedAgentId={agentId}
              subagent={{
                agentId,
                block: selectedSubagent,
                pendingInteractionCount: agentPendingInteractionCount,
                onJumpToSpawn: handleJumpToSpawn,
              }}
              taskOwnerAgentId={agentId}
              onCancelTask={onCancelTask}
              onStopAgentTask={onStopAgentTask}
              onOpenSubagent={navigation.openAgent}
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
          onClick={onCloseRail}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onCloseRail();
            }
          }}
        />
      ) : null}
    </>
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
