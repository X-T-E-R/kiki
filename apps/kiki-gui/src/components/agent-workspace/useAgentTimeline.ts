import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';

import {
  agentContinuationAvailable,
} from './AgentWorkspace';
import {
  createViewState,
  MAIN_AGENT_ID,
  sessionAgentForest,
  type AgentForest,
  type Block,
  type SessionController,
  type SessionViewState,
  type SubagentBlock,
} from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import type { PlanReviewResponse } from '../Interactions';
import { locateInTimeline, locateSpawnTarget } from '../../lib/timelineLocate';
import { pushToast } from '../../lib/toasts';
import { useTimelineNavigation } from '../../lib/useTimelineNavigation';

const emptyView = createViewState('');
const noopSubscribe = () => () => {};

/** Pending approvals plus unanswered questions among an agent's blocks. */
export function countPendingInteractions(blocks: readonly Block[]): number {
  let count = 0;
  for (const block of blocks) {
    if (
      (block.kind === 'approval' && block.resolution === undefined) ||
      (block.kind === 'question' && block.outcome === undefined)
    ) {
      count += 1;
    }
  }
  return count;
}

export interface AgentTimelineActions {
  readonly loadOlder: (signal?: AbortSignal) => Promise<boolean>;
  readonly retryLoad: (() => void) | undefined;
  readonly resolveApproval: (
    approvalId: string,
    decision: 'approved' | 'rejected' | 'cancelled',
    scope?: 'session',
    selectedOptionId?: string,
    review?: PlanReviewResponse,
  ) => Promise<void>;
  readonly answerQuestion: (
    questionId: string,
    answers: Parameters<SessionController['answerQuestion']>[1],
  ) => Promise<void>;
  readonly dismissQuestion: (questionId: string) => Promise<void>;
  readonly cancelQueued: (promptId: string) => Promise<void>;
  readonly revealLatest: () => void;
  readonly jumpToSpawn: (() => void) | undefined;
}

export interface UseAgentTimelineOptions {
  readonly visible: boolean;
  readonly sessionId?: string;
  readonly sessionState?: SessionViewState;
  readonly forest?: AgentForest;
}

export interface AgentTimelineResult {
  readonly state: SessionViewState;
  readonly actions: AgentTimelineActions;
  readonly pendingInteractionCount: number;
}

/**
 * Shared timeline state, demand lease, pending-interaction count, and row
 * actions for any agent — `main` included.
 */
export function useAgentTimeline(
  controller: SessionController | null,
  agentId: string,
  options: UseAgentTimelineOptions,
): AgentTimelineResult {
  const { visible, sessionId: explicitSessionId, sessionState: explicitSessionState, forest: explicitForest } = options;
  const { t } = useI18n();
  const navigateTimeline = useTimelineNavigation();

  const subscribeAgent = useCallback(
    (listener: () => void) => {
      if (controller === null || !visible) return noopSubscribe();
      if (typeof controller.subscribeAgent === 'function') {
        return controller.subscribeAgent(agentId, listener);
      }
      if (agentId === MAIN_AGENT_ID && typeof controller.subscribe === 'function') {
        return controller.subscribe(listener);
      }
      return noopSubscribe();
    },
    [controller, agentId, visible],
  );
  const getAgentSnapshot = useCallback((): SessionViewState => {
    if (controller === null) return emptyView;
    if (typeof controller.getAgentState === 'function') {
      return controller.getAgentState(agentId);
    }
    if (agentId === MAIN_AGENT_ID && typeof controller.getState === 'function') {
      return controller.getState();
    }
    return emptyView;
  }, [controller, agentId]);
  const agentLiveState = useSyncExternalStore(subscribeAgent, getAgentSnapshot);

  const subscribeShell = useCallback(
    (listener: () => void) => {
      if (
        controller === null ||
        agentId === MAIN_AGENT_ID ||
        explicitSessionState !== undefined ||
        !visible ||
        typeof controller.subscribe !== 'function'
      ) {
        return noopSubscribe();
      }
      return controller.subscribe(listener);
    },
    [controller, agentId, explicitSessionState, visible],
  );
  const getShellSnapshot = useCallback((): SessionViewState => {
    if (explicitSessionState !== undefined) return explicitSessionState;
    if (controller !== null && typeof controller.getState === 'function') {
      return controller.getState();
    }
    return emptyView;
  }, [controller, explicitSessionState]);
  const subscribedShellState = useSyncExternalStore(subscribeShell, getShellSnapshot);
  const shellState = explicitSessionState ?? (agentId === MAIN_AGENT_ID ? agentLiveState : subscribedShellState);

  const sessionId = explicitSessionId ?? controller?.sessionId ?? shellState.session?.id ?? shellState.sessionId;

  // Demand lease for non-main agents: held per hook instance so the routed
  // page and a preview tab showing the same agent never release each other's
  // demand, lowered to `off` when hidden in one step. Main's lease comes from
  // focus (`controller.setFocusedAgent`) so no second main lease is added.
  const leaseId = useId();
  const viewId = `workspace:${sessionId}:${agentId}:${leaseId}`;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (agentId === MAIN_AGENT_ID || controller === null || typeof controller.retainAgentView !== 'function') return;
    controller.retainAgentView(viewId, agentId, visibleRef.current ? 'delta' : 'off');
    return () => { controller.releaseAgentView?.(viewId); };
  }, [controller, viewId, agentId]);
  useEffect(() => {
    if (agentId === MAIN_AGENT_ID || controller === null || typeof controller.updateAgentView !== 'function') return;
    controller.updateAgentView(viewId, visible ? 'delta' : 'off');
  }, [controller, viewId, agentId, visible]);

  const resolvedForest = useMemo(
    () => explicitForest ?? controller?.getForest() ?? sessionAgentForest(shellState),
    [explicitForest, controller, shellState],
  );
  const selectedNode = resolvedForest.byId[agentId];
  const selectedSubagent = useMemo(
    () =>
      agentId === MAIN_AGENT_ID
        ? undefined
        : shellState.blocks.find(
            (block): block is SubagentBlock =>
              block.kind === 'subagent' && block.subagentId === agentId,
          ),
    [agentId, shellState.blocks],
  );
  const agentReadUnavailable = useMemo(() => {
    if (agentId === MAIN_AGENT_ID || controller === null || !agentLiveState.transcriptReady) return false;
    return !agentContinuationAvailable({
      controller,
      node: selectedNode,
      subagent: selectedSubagent,
      state: agentLiveState,
    });
  }, [
    agentId,
    controller,
    selectedNode,
    selectedSubagent,
    agentLiveState.blocks,
    agentLiveState.model,
    agentLiveState.historyCoverageKind,
    agentLiveState.transcriptReady,
  ]);

  const loadError =
    agentId === MAIN_AGENT_ID
      ? agentLiveState.loadError
      : shellState.loadError ??
        (agentReadUnavailable
          ? t('subagent.name.unreported', { id: agentId })
          : !agentLiveState.transcriptReady && shellState.resyncFailed
            ? shellState.resyncError?.message
            : undefined);

  const shellSession = shellState.session;
  const shellResyncing = shellState.resyncing;
  const shellResyncFailed = shellState.resyncFailed;
  const shellResyncError = shellState.resyncError;

  const state = useMemo<SessionViewState>(() => {
    if (agentId === MAIN_AGENT_ID) return agentLiveState;
    return {
      ...agentLiveState,
      session: shellSession,
      loadError,
      resyncing: shellResyncing,
      resyncFailed: shellResyncFailed,
      resyncError: shellResyncError,
    };
  }, [
    agentId,
    agentLiveState,
    shellSession,
    loadError,
    shellResyncing,
    shellResyncFailed,
    shellResyncError,
  ]);

  const pendingInteractionCount = useMemo(
    () => countPendingInteractions(agentLiveState.blocks),
    [agentLiveState.blocks],
  );

  const loadOlder = useCallback(
    (signal?: AbortSignal): Promise<boolean> =>
      controller?.loadOlderMessages(agentId, signal) ?? Promise.resolve(false),
    [controller, agentId],
  );
  const retryLoad = useMemo(
    () => (controller === null ? undefined : () => { void controller.retryOpen(); }),
    [controller],
  );
  const resolveApproval = useCallback(
    (
      approvalId: string,
      decision: 'approved' | 'rejected' | 'cancelled',
      scope?: 'session',
      selectedOptionId?: string,
      review?: PlanReviewResponse,
    ): Promise<void> =>
      controller?.resolveApproval(approvalId, decision, scope, selectedOptionId, review) ??
      Promise.resolve(),
    [controller],
  );
  const answerQuestion = useCallback(
    (
      questionId: string,
      answers: Parameters<SessionController['answerQuestion']>[1],
    ): Promise<void> =>
      controller?.answerQuestion(questionId, answers) ?? Promise.resolve(),
    [controller],
  );
  const dismissQuestion = useCallback(
    (questionId: string): Promise<void> =>
      controller?.dismissQuestion(questionId) ?? Promise.resolve(),
    [controller],
  );
  const cancelQueued = useCallback(
    async (promptId: string): Promise<void> => {
      if (controller === null) return;
      const abort =
        agentId === MAIN_AGENT_ID
          ? controller.abortPrompt(promptId)
          : controller.abortPrompt(promptId, agentId);
      try {
        await abort;
      } catch (error: unknown) {
        pushToast({
          tone: 'error',
          text: t('sv.cancelQueuedFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    },
    [controller, agentId, t],
  );
  const revealLatest = useCallback(() => {
    if (!sessionId) return;
    void locateInTimeline({ kind: 'latest' }, { sessionId, agentId, notify: false });
  }, [sessionId, agentId]);

  const parentAgentId = selectedNode?.parentAgentId ?? selectedSubagent?.parentAgentId ?? MAIN_AGENT_ID;
  const jumpToSpawnCallback = useCallback(() => {
    if (!sessionId) return;
    const spawn = locateSpawnTarget(sessionId, agentId, parentAgentId);
    navigateTimeline(spawn.target, { ...spawn.options, route: spawn.route });
  }, [sessionId, agentId, parentAgentId, navigateTimeline]);
  const jumpToSpawn = agentId === MAIN_AGENT_ID ? undefined : jumpToSpawnCallback;

  const actions = useMemo<AgentTimelineActions>(
    () => ({
      loadOlder,
      retryLoad,
      resolveApproval,
      answerQuestion,
      dismissQuestion,
      cancelQueued,
      revealLatest,
      jumpToSpawn,
    }),
    [
      loadOlder,
      retryLoad,
      resolveApproval,
      answerQuestion,
      dismissQuestion,
      cancelQueued,
      revealLatest,
      jumpToSpawn,
    ],
  );

  return { state, actions, pendingInteractionCount };
}
