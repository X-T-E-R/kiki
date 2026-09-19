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

import { useCallback, useMemo, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

import type { ModelCatalogItem } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';
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

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { revealSubagentCard } from '../ActivityHistory';
import { AgentBreadcrumb, AgentRelations } from '../AgentBreadcrumb';
import { useConversationShell } from '../ConversationShell';
import { ContextMeter } from '../ContextMeter';
import { MediaPreviewProvider, PreviewToggleButton } from '../mediaPreview';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { RightRail } from '../RightRail';
import { Transcript } from '../Transcript';
import { ResyncStatusBanner } from './ResyncStatusBanner';
import { SubagentDetailActions } from './SubagentDetailActions';

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
  readonly previewApiRef: RefObject<MediaPreviewApi | null>;
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
  statusLabel,
  busy,
  live,
  canTerminate,
  model,
  effort,
  contextTokens,
  maxContextTokens,
  cumulativeTokens,
  crumbs,
  forest,
  models,
  railOpen,
  onToggleRail,
  navigation,
  onSendMessage,
  onTerminate,
  onChangeModel,
}: {
  target: AgentWorkspaceTarget;
  name: string;
  statusLabel: string;
  busy: boolean;
  live: boolean;
  canTerminate: boolean;
  model: string | undefined;
  effort: string | undefined;
  contextTokens: number | undefined;
  maxContextTokens: number | undefined;
  cumulativeTokens: number | undefined;
  crumbs: readonly AgentTreeNode[];
  forest: AgentForest;
  models: readonly ModelCatalogItem[];
  railOpen: boolean;
  onToggleRail: () => void;
  navigation: AgentWorkspaceNavigation;
  onSendMessage: (text: string) => Promise<void>;
  onTerminate: () => Promise<void>;
  onChangeModel: (model: string) => Promise<void>;
}) {
  const { t, time } = useI18n();
  return (
    <>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-hairline bg-panel px-4 py-2">
        <button
          type="button"
          onClick={() => { navigation.openSession(); }}
          className="rounded-lg border border-hairline px-2 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          {t('sv.backToSession')}
        </button>
        <div className="min-w-0 flex-1">
          <AgentBreadcrumb
            crumbs={crumbs}
            onOpenSession={navigation.openSession}
            onOpenAgent={navigation.openAgent}
          />
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
        {contextTokens !== undefined &&
        maxContextTokens !== undefined &&
        maxContextTokens > 0 ? (
          <ContextMeter
            used={contextTokens}
            limit={maxContextTokens}
            placement="below"
          />
        ) : contextTokens !== undefined ? (
          <span
            data-agent-context
            className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10.5px] text-ink-soft"
          >
            {t('sv.agentContext', { tokens: time.formatTokens(contextTokens) })}
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
            busy ? 'border-accent/50 text-accent' : 'border-hairline text-ink-soft'
          }`}
        >
          {busy ? t('sv.working') : statusLabel}
        </span>
        <SubagentDetailActions
          agentId={target.agentId}
          name={name}
          live={live}
          canTerminate={canTerminate}
          currentModel={model}
          models={models}
          onSendMessage={onSendMessage}
          onTerminate={onTerminate}
          onChangeModel={onChangeModel}
        />
        <PreviewToggleButton />
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
}: AgentWorkspaceProps) {
  const { t } = useI18n();
  const { client } = useConnection();
  const { slots } = useConversationShell();
  const { sessionId, agentId } = target;

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
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });

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
  const statusLabel =
    selectedNode !== undefined
      ? t(`subagent.status.${selectedNode.status}` as I18nKey)
      : selectedSubagent !== undefined
        ? t(`subagent.status.${selectedSubagent.status}` as I18nKey)
        : t('sv.historyUnavailable');
  const displayName = selectedNode?.label ?? selectedSubagent?.name ?? agentId;
  const displayModel = agentLiveState.model ?? selectedNode?.model ?? selectedSubagent?.model;
  // Action affordances: the tree node can lag at 'unknown' on cold open, so
  // a known timeline-card status wins (same rule as the rail's task section).
  const actionStatus =
    selectedSubagent !== undefined && selectedSubagent.status !== 'unknown'
      ? selectedSubagent.status
      : (selectedNode?.status ?? selectedSubagent?.status ?? 'unknown');
  const agentLive =
    actionStatus === 'running' || actionStatus === 'background' || actionStatus === 'suspended';
  // The child run is a task on the PARENT agent's task service; nested agents
  // therefore need the parent's per-agent snapshot rather than the main one.
  const { ownerAgentId, task: runningAgentTask } = resolveRunningSubagentTask({
    agentId,
    parentAgentId: selectedNode?.parentAgentId ?? parentAgentId,
    mainTasks: sessionState.tasks,
    parentTasks: parentAgentState.tasks,
  });
  const handleMessageAgent = async (text: string) => {
    await client.sendAgentMessage(sessionId, agentId, text);
  };
  const handleTerminateAgent = async () => {
    if (runningAgentTask === undefined) {
      pushToast({ tone: 'info', text: t('subagent.terminateUnavailable') });
      return;
    }
    await client.stopAgentTask(sessionId, ownerAgentId, runningAgentTask.id);
  };
  const handleChangeAgentModel = async (model: string) => {
    await client.setAgentModel(sessionId, agentId, model);
  };
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

  return (
    <MediaPreviewProvider
      sessionId={sessionId}
      cwd={sessionState.session?.metadata?.cwd}
      sessionViewState={agentState}
      agentForest={forest}
      onOpenSubagent={navigation.openAgent}
      apiRef={previewApiRef}
    >
      {slots.header !== null
        ? createPortal(
            <AgentWorkspaceHeader
              target={target}
              name={displayName}
              statusLabel={statusLabel}
              busy={headerBusy}
              live={agentLive}
              canTerminate={runningAgentTask !== undefined}
              model={displayModel}
              effort={displayEffort}
              contextTokens={displayContextTokens}
              maxContextTokens={displayMaxContextTokens}
              cumulativeTokens={cumulativeTokens}
              crumbs={crumbs}
              forest={forest}
              models={modelsQuery.data?.items ?? []}
              railOpen={railOpen}
              onToggleRail={onToggleRail}
              navigation={navigation}
              onSendMessage={handleMessageAgent}
              onTerminate={handleTerminateAgent}
              onChangeModel={handleChangeAgentModel}
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
            <ResyncStatusBanner
              resyncing={sessionState.resyncing}
              resyncFailed={sessionState.resyncFailed}
              error={sessionState.resyncError}
              onRetry={controller === null ? undefined : () => { void controller.resync(); }}
            />,
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
    </MediaPreviewProvider>
  );
}
