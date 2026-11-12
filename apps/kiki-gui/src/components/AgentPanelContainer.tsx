/**
 * Agent panel container — the body of a `panel:<agentId>` preview tab and of
 * the right rail's selected-agent panel.
 *
 * Every agent-scoped field it renders is read from THIS tab's agent. The routed
 * `state` prop describes whichever agent the session page currently shows, so
 * reading todos / plan mode / busy from it would relabel that agent's data as
 * this tab's — a panel tab for a subagent must never present the routed
 * agent's (or the main agent's) todos as that subagent's. The session's live
 * controller registry — the same channel SessionView publishes into — is the
 * per-agent source of truth; when no controller owns the session there is
 * nothing agent-scoped to read, and the panel reports "not reported" instead of
 * borrowing the routed agent's data.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { AgentForest, ApprovalBlock, QuestionBlock, SessionController, SessionViewState } from '@kiki/session-core/session';
import { MAIN_AGENT_ID, snapshotSubagentAgentId } from '@kiki/session-core/session';
import { sumAgentTreeMetrics, UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import type { AgentPanelMetrics } from '@kiki/protocol';
import type { TranscriptTodoNotes, TranscriptTodoNotesMeta } from '@kiki/transcript';
import { useConnection, useOptionalControllerRegistry } from '../state/connection';
import { useI18n } from '../i18n';
import { useAutoCompact } from './useAutoCompact';
import { InspectorOverview, type OverviewFigures } from './agent-panel/InspectorOverview';
import { CockpitOverview } from './rail-variants/CockpitOverview';
import type { RailMode } from './rail-variants/shell';
import { agentUsageCacheHitRate } from './agent-panel/cacheRate';
import type { AgentTokenUsage } from './agent-panel/types';
import { AgentIdentitySection } from './agent-panel/AgentIdentitySection';
import { AgentTodoSection } from './agent-panel/AgentTodoSection';
import { AgentNotesSection } from './agent-panel/AgentNotesSection';
import { AgentHooksSection } from './agent-panel/AgentHooksSection';
import { AgentPlanSection } from './agent-panel/AgentPlanSection';
import { AgentCapabilitiesSection, capabilityCounts } from './agent-panel/AgentCapabilitiesSection';
import { usageSessionDeepLink } from '../lib/usageV2';
import type { Klient } from '@kiki/klient';
import { observePanelUsage, panelUsageRevision } from '../lib/usageFreshness';
import { aggregateTreeCacheHitRate, aggregateTreeCacheReadTokens, aggregateTreeCacheWriteTokens } from './agent-panel/cacheRate';
import {
  agentCapabilitiesErrorText,
  capabilityFieldGaps,
  capabilityReasonText,
  isCapabilityUnsupportedError,
  mapPanelSkills,
  mapPanelSubagentTargets,
  mapPanelTools,
} from './agent-panel/mapCapabilities';
import { isCompletePanelMetrics, isUnsettledPanelMetrics, panelMetricsCapabilitiesKey, panelMetricsContinuationDelay, panelMetricsSettleKey, panelMetricsSourceRevision } from './agent-panel/panelMetricsQuery';
import { useAgentPanelCatalog } from './agent-panel/useAgentPanelCatalog';

const EMPTY_PANEL_METRICS: Readonly<Record<string, AgentPanelMetrics>> = {};

function isCancelledMetricsRead(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError');
}

const SETTLED_METRICS_KEY = 'agentPanel.metrics.settleFailed' as I18nKey;

type KeptPanelMetric = {
  readonly revision: string;
  readonly metrics: AgentPanelMetrics;
  readonly stamp: number;
};

function preferMetric(previous: KeptPanelMetric | undefined, next: KeptPanelMetric): KeptPanelMetric {
  if (previous === undefined || previous.revision !== next.revision) return next;
  const complete = isCompletePanelMetrics(previous.metrics);
  if (complete !== isCompletePanelMetrics(next.metrics)) return complete ? previous : next;
  const measured = (row: AgentPanelMetrics) => [row.totalTokens, row.totalCostUsd, row.inputTokens, row.outputTokens].some((value) => value !== null);
  if (!complete && measured(previous.metrics) !== measured(next.metrics)) return measured(previous.metrics) ? previous : next;
  return previous.stamp > next.stamp ? previous : next;
}

function countingMetric(metrics: AgentPanelMetrics): AgentPanelMetrics {
  return { ...metrics, usageComplete: false, usagePartial: true, costPartial: true };
}

function sourceRevisionFor(controller: SessionController | undefined, forest: AgentForest, id: string, usageRevision?: number): string {
  const main = controller?.getState();
  const state = controller?.getAgentState(id);
  return panelMetricsSourceRevision({
    cursorSeq: state?.cursor.seq,
    cursorEpoch: state?.cursor.epoch ?? main?.cursor.epoch,
    transcriptResetVersion: state?.transcriptResetVersion ?? main?.transcriptResetVersion,
    usageSourceRevision: usageRevision === undefined ? undefined : String(usageRevision),
    usage: state?.usage,
    rosterUsage: forest.byId[id]?.usage,
  });
}

function revisionToken(ids: readonly string[], revisions: ReadonlyMap<string, string>): string {
  return JSON.stringify(ids.map((id) => [id, revisions.get(id) ?? '']));
}

function usePanelSourceRevisions(
  controller: SessionController | undefined,
  forest: AgentForest,
  ids: readonly string[],
  klient: Pick<Klient, 'events'>,
  sessionId: string,
): ReadonlyMap<string, string> {
  const forestRef = useRef(forest);
  const idsRef = useRef(ids);
  forestRef.current = forest;
  idsRef.current = ids;
  const subscribe = useCallback((listener: () => void) => {
    // Keep metrics observation independent of child transcript demand.
    const offController = controller?.subscribe(listener);
    const offUsage = observePanelUsage(klient, sessionId, listener);
    return () => { offController?.(); offUsage(); };
  }, [controller, klient, sessionId]);
  const read = useCallback(
    () => idsRef.current.map((id) => sourceRevisionFor(controller, forestRef.current, id, panelUsageRevision(klient, sessionId, id))).join('\n'),
    [controller, klient, sessionId],
  );
  const packed = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    const revisions = new Map<string, string>();
    const parts = packed.split('\n');
    ids.forEach((id, index) => { revisions.set(id, parts[index] ?? ''); });
    return revisions;
  }, [packed, ids]);
}

const noopSubscribe = (): (() => void) => () => {};
const NO_BRANCHES: ReadonlySet<string> = new Set();
const NO_PENDING_BLOCKS: readonly (ApprovalBlock | QuestionBlock)[] = [];
const noopToggleBranch = () => {};

/**
 * Live view state of the agent this panel belongs to, or `undefined` when no
 * controller owns the session (no live connection) — i.e. no per-agent data
 * exists at all. A subagent without its own state reads as an unloaded empty
 * state, never as the session's main agent. While the panel is shown it
 * holds a `turn` lease on the agent: todos, notes, plan mode, run state,
 * model and context all arrive at `turn`, and listening alone asks for none
 * of them.
 */
function useAgentViewState(sessionId: string, agentId: string, visible: boolean): { controller: SessionController | undefined; agentState: SessionViewState | undefined } {
  const registry = useOptionalControllerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noopSubscribe() : registry.subscribe(listener)),
    [registry],
  );
  const registryGeneration = useSyncExternalStore(
    subscribeRegistry,
    () => registry?.snapshot() ?? 0,
    () => 0,
  );
  const controller = useMemo(() => {
    if (registry === null) return undefined;
    let found: SessionController | undefined;
    for (const candidate of registry) {
      if (candidate.sessionId === sessionId) {
        found = candidate;
        break;
      }
    }
    return found;
  }, [registry, registryGeneration, sessionId]);
  const subscribeAgent = useCallback(
    (listener: () => void) => controller === undefined ? noopSubscribe() : controller.subscribeAgent(agentId, listener),
    [controller, agentId],
  );
  const readAgentState = useCallback(
    (): SessionViewState | undefined => controller?.getAgentState(agentId),
    [controller, agentId],
  );
  const agentState = useSyncExternalStore(subscribeAgent, readAgentState);
  const leaseId = useId();
  useEffect(() => {
    if (controller === undefined || !visible || typeof controller.retainAgentView !== 'function') return;
    const viewId = `agent-panel:${agentId}:${leaseId}`;
    controller.retainAgentView(viewId, agentId, 'turn');
    return () => { controller.releaseAgentView(viewId); };
  }, [controller, agentId, visible, leaseId]);
  return { controller, agentState };
}

/**
 * Slices of the panel the inspector places at different depths: `profile`
 * (the top card: who this agent is, folded to one line, opening onto its
 * tools, skills, subagents and extensions), `work` (todo + plan), `overview`
 * (the resident context / usage summary) and `usage` (the older two-line
 * usage slice). `all` keeps the historical single column for the preview
 * tab body.
 */
export type AgentPanelPart = 'all' | 'work' | 'usage' | 'overview' | 'profile';

export function AgentPanelContainer({ state, forest, agentId, visible = true, part = 'all', overviewMode = 'default', renderOverview, onOpenAgent, expandedBranches, onToggleBranch, sessionPending, mainLabel }: {
  state: SessionViewState;
  forest: AgentForest;
  agentId: string;
  visible?: boolean;
  part?: AgentPanelPart;
  /** The overview part's body: the standard figures or the cockpit instruments. */
  overviewMode?: RailMode;
  renderOverview?: (body: React.ReactNode, scopeSwitch: React.ReactNode) => React.ReactNode;
  /** Agents waiting on the user (cockpit lanes set them apart). */
  waitingIds?: ReadonlySet<string>;
  /** Cockpit lane rows open that agent. */
  onOpenAgent?: (agentId: string) => void;
  /** Cockpit graph: branches the reader opened, owned by the rail. */
  expandedBranches?: ReadonlySet<string>;
  onToggleBranch?: (branchId: string) => void;
  /** Cockpit graph: every pending item in the session, any depth. */
  sessionPending?: readonly (ApprovalBlock | QuestionBlock)[];
  /** Cockpit graph: how the main agent's own lane reads. */
  mainLabel?: string;
}) {
  const connection = useConnection();
  const { klient } = connection;
  const identityKey = `${connection.spaceKey}:${connection.scopeId}:${state.sessionId}:${agentId}`;
  const retainedNotesRef = useRef<Map<string, { notes?: TranscriptTodoNotes; meta?: TranscriptTodoNotesMeta }>>(new Map());
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = { session_id: state.sessionId, agent_id: agentId, metrics_only: true };
  const node = forest.byId[agentId];
  const { controller, agentState } = useAgentViewState(state.sessionId, agentId, visible);

  if (agentState !== undefined && (agentState.loaded || agentState.todoNotes !== undefined || agentState.todoNotesMeta !== undefined)) {
    if (retainedNotesRef.current.size > 50) {
      const oldestKey = retainedNotesRef.current.keys().next().value;
      if (oldestKey !== undefined) retainedNotesRef.current.delete(oldestKey);
    }
    retainedNotesRef.current.set(identityKey, {
      notes: agentState.todoNotes,
      meta: agentState.todoNotesMeta,
    });
  }

  const retainedNotes = retainedNotesRef.current.get(identityKey);
  const effectiveNotes = agentState?.todoNotes ?? (controller === undefined ? retainedNotes?.notes : undefined);
  const effectiveMeta = agentState?.todoNotesMeta ?? (controller === undefined ? retainedNotes?.meta : undefined);
  const readsTodos = visible && (part === 'all' || part === 'work');
  const todoRead = useRef<ReturnType<SessionController['beginContentRead']> | undefined>(undefined);
  useEffect(() => {
    if (!readsTodos || controller === undefined) return;
    const lease = controller.beginContentRead(agentId, { kind: 'todo', id: 'todo' }, ['items']);
    todoRead.current = lease;
    return () => { lease.release(); todoRead.current = undefined; };
  }, [controller, agentId, readsTodos]);
  const todoCoverage = agentState?.globalCoverage?.todos;
  const todoEntitiesFailed = agentState?.detailLoads['entities:todo']?.status === 'error';
  useEffect(() => {
    // A failed entity page stays on its retry button. Selecting the agent
    // must not start that read, or the next agent's retry is blamed for it.
    if (readsTodos && agentState?.loaded && todoCoverage?.hasMore && !todoEntitiesFailed) {
      void controller?.loadTranscriptEntities(agentId, 'todo');
    }
  }, [controller, agentId, readsTodos, agentState?.loaded, todoCoverage?.hasMore, todoCoverage?.returned, todoEntitiesFailed]);
  const todoRefs = agentState?.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' && ref.path[0] === 'items') ?? [];
  const todoReadFailed = todoRefs.some((ref) => agentState?.detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') ||
    todoCoverage?.hasMore === true && agentState?.detailLoads['entities:todo']?.status === 'error';
  const todoRefSignature = JSON.stringify(todoRefs);
  useEffect(() => {
    if (readsTodos && !todoReadFailed && todoRefSignature !== '[]') todoRead.current?.retry();
  }, [controller, agentId, readsTodos, todoReadFailed, todoRefSignature]);
  const retryTodos = () => {
    todoRead.current?.retry();
    if (todoCoverage?.hasMore) void controller?.loadTranscriptEntities(agentId, 'todo');
  };
  const notesRefs = agentState?.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' &&
    (ref.path[0] === 'notes' || ref.path[0] === 'notesMeta')) ?? [];
  const notesReadFailed = notesRefs.some((ref) => agentState?.detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') ||
    todoCoverage?.hasMore === true && agentState?.detailLoads['entities:todo']?.status === 'error';
  const notesContentStatus = controller === undefined
    ? undefined
    : notesReadFailed ? 'error' : notesRefs.length > 0 || todoCoverage?.hasMore === true ? 'loading' : undefined;
  const notesRead = useRef<{ release(): void; retry(): void } | undefined>(undefined);
  useEffect(() => {
    return () => {
      notesRead.current?.release();
      notesRead.current = undefined;
    };
  }, [controller, agentId]);
  const beginNotesRead = useCallback(() => {
    if (controller === undefined) return undefined;
    const lease = controller.beginContentRead(agentId, { kind: 'todo', id: 'todo' }, ['notes', 'notesMeta']);
    let released = false;
    const handle = {
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        if (notesRead.current === handle) notesRead.current = undefined;
      },
      retry: () => {
        lease.retry();
      },
    };
    notesRead.current = handle;
    return handle;
  }, [controller, agentId]);
  // Poll cadence follows THIS agent's activity — its own view state or its
  // forest node. The routed agent being busy must neither start nor stop it.
  const active = agentState?.busy === true || node?.busy === true ||
    (agentId === MAIN_AGENT_ID && Object.values(forest.byId).some((entry) => entry.busy));
  const metricsWanted = part === 'all' || part === 'overview' || part === 'usage';
  const [expandedIdentity, setExpandedIdentity] = useState<string | undefined>();
  const profileExpanded = expandedIdentity === identityKey;
  const catalog = useAgentPanelCatalog(part === 'all' || part === 'profile'
    ? { session_id: state.sessionId, agent_id: agentId } : undefined,
  visible && state.loaded && !state.resyncing && (part === 'all' || profileExpanded),
  JSON.stringify([agentState?.profile, agentState?.model, agentState?.permissionMode, agentState?.planMode]));
  const header = useQuery({
    queryKey: panelMetricsCapabilitiesKey(query, connection.spaceKey, connection.scopeId, connection.meta?.server_id ?? ''),
    queryFn: async ({ signal }) => {
      const sourceRevisions = new Map([agentId, MAIN_AGENT_ID, ...Object.keys(forest.byId)].map((id) =>
        [id, sourceRevisionFor(controller, forest, id, panelUsageRevision(klient, state.sessionId, id))]));
      return { ...await klient.global.agentPanel.read(query, { signal }), sourceRevisions };
    },
    enabled: metricsWanted && visible && state.loaded && !state.resyncing,
    staleTime: 5_000,
    refetchInterval: (current) => metricsWanted && visible && active && current.state.data?.metrics?.[agentId] !== undefined ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: metricsWanted && visible && active,
    retry: false,
  });
  const capabilities = part === 'profile' ? catalog : header;
  const serverId = connection.meta?.server_id ?? '';
  const refreshSignature = JSON.stringify([
    connection.spaceKey,
    connection.scopeId,
    serverId,
    state.sessionId,
    agentId,
    active,
    agentState?.profile,
    agentState?.model,
    agentState?.permissionMode,
    agentState?.planMode,
  ]);
  const previousSignature = useRef(refreshSignature);
  useEffect(() => {
    if (!metricsWanted || !visible || previousSignature.current === refreshSignature || !state.loaded || state.resyncing || header.isFetching) return;
    previousSignature.current = refreshSignature;
    void header.refetch({ cancelRefetch: false });
  }, [metricsWanted, visible, refreshSignature, state.loaded, state.resyncing, header.isFetching, header.refetch]);
  const data = part === 'all' ? catalog.data : capabilities.data;
  const profile = data?.profile;
  const [scope, setScope] = useState<'agent' | 'tree'>('agent');
  const cockpit = part === 'overview' && overviewMode === 'cockpit';
  const showsTree = cockpit || (agentId === MAIN_AGENT_ID && (part === 'all' || part === 'usage' || (part === 'overview' && scope === 'tree')));
  const settleOwner = cockpit ? MAIN_AGENT_ID : agentId;
  const spaceIdentity = `${connection.spaceKey}:${connection.scopeId}:${serverId}`;
  const metricsIdentity = `${spaceIdentity}:${state.sessionId}:${settleOwner}`;
  const headerMetrics = header.data?.metrics ?? EMPTY_PANEL_METRICS;
  const sessionState = controller?.getState() ?? state;
  const roster = sessionState.snapshotSubagents;
  const ids = useMemo(() => showsTree
    ? [...new Set([MAIN_AGENT_ID, agentId, ...Object.keys(forest.byId), ...roster.map(snapshotSubagentAgentId), ...Object.keys(headerMetrics)])].sort()
    : [agentId], [showsTree, agentId, forest.byId, roster, headerMetrics]);
  const rosterRef = showsTree ? sessionState.contentRefs?.find((ref) => ref.source.kind === 'snapshot' && ref.kind === 'array' && ref.path.length === 1 && ref.path[0] === 'subagents') : undefined;
  const rosterPending = rosterRef !== undefined && sessionState.detailLoads[`content:${JSON.stringify(rosterRef)}`]?.status !== 'error';
  const rosterIncomplete = showsTree && (rosterRef !== undefined || (sessionState.agentCounts?.total ?? 0) > ids.length);
  const revisions = usePanelSourceRevisions(controller, forest, ids, klient, state.sessionId);
  const kept = useRef({ identity: metricsIdentity, byId: new Map<string, KeptPanelMetric>() });
  if (kept.current.identity !== metricsIdentity) kept.current = { identity: metricsIdentity, byId: new Map() };
  const [settleBlock, setSettleBlock] = useState<{ identity: string; token: string } | undefined>(undefined);
  const reopenRefetch = useRef<string | undefined>(undefined);
  const startedToken = useRef<string | undefined>(undefined);
  const settleReadAbort = useRef<AbortController | undefined>(undefined);
  const headerRow = (id: string, metrics: AgentPanelMetrics): KeptPanelMetric => ({
    revision: header.data?.sourceRevisions.get(id) ?? '', metrics, stamp: header.dataUpdatedAt,
  });
  const metrics: Record<string, AgentPanelMetrics> = {};
  const requestIds: string[] = [];
  for (const id of ids) {
    const revision = revisions.get(id) ?? '';
    const previous = kept.current.byId.get(id);
    const raw = headerMetrics[id];
    const headerValue = raw === undefined ? undefined : headerRow(id, raw);
    const accepted = previous?.revision === revision ? previous : undefined;
    const row = headerValue?.revision === revision ? preferMetric(accepted, headerValue) : accepted;
    const subtotal = row?.metrics ?? previous?.metrics ?? raw;
    if (subtotal !== undefined) metrics[id] = row === undefined ? countingMetric(subtotal) : subtotal;
    if ((!rosterPending || id === agentId) && isUnsettledPanelMetrics(row?.metrics)) requestIds.push(id);
  }
  const canSettle = metricsWanted && visible && state.loaded && !state.resyncing && (header.isSuccess || showsTree && kept.current.byId.size > 0);
  const requestToken = `${spaceIdentity}\0${revisionToken(requestIds, revisions)}`;
  const settleBlocked = settleBlock?.identity === metricsIdentity && settleBlock.token === requestToken;
  const currentRevisions = useRef(revisions);
  currentRevisions.current = revisions;
  const [, updateMetrics] = useState(0);
  const metricsSettle = useQuery({
    queryKey: panelMetricsSettleKey(
      state.sessionId,
      settleOwner,
      requestIds,
      requestToken,
      serverId,
    ),
    queryFn: ({ signal, queryKey }) => {
      const ids = [...queryKey[3]];
      const requested = new Map(ids.map((id) => [id, revisions.get(id) ?? '']));
      startedToken.current = queryKey[4];
      const abortController = new AbortController();
      settleReadAbort.current = abortController;
      const abort = () => { abortController.abort(signal.reason); };
      signal.addEventListener('abort', abort);
      if (signal.aborted) abort();
      const request = klient.global.agentPanel.read({
        session_id: state.sessionId,
        agent_id: settleOwner,
        metrics_settle: true,
        metrics_only: true,
        metrics_agent_ids: ids,
      }, { signal: abortController.signal });
      void request.catch(() => {});
      const aborted = new Promise<never>((_resolve, reject) => {
        if (abortController.signal.aborted) {
          reject(abortController.signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
          return;
        }
        abortController.signal.addEventListener('abort', () => {
          reject(abortController.signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
        }, { once: true });
      });
      return Promise.race([request, aborted]).then((data) => ({ ...data, requested, identity: metricsIdentity })).finally(() => {
        signal.removeEventListener('abort', abort);
        if (settleReadAbort.current === abortController) settleReadAbort.current = undefined;
      });
    },
    // A successful budget-limited read resumes the same projection. Completed
    // sources stay cached until their revision changes; hidden panels stop.
    enabled: canSettle && requestIds.length > 0 && !settleBlocked,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (current) => canSettle && !settleBlocked && current.state.status === 'success'
      ? panelMetricsContinuationDelay(current.state.data?.metrics, requestIds, current.state.dataUpdateCount)
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (kept.current.identity !== metricsIdentity) return;
    let changed = false;
    const retain = (id: string, revision: string, metrics: AgentPanelMetrics, stamp: number) => {
      if (currentRevisions.current.get(id) !== revision) return;
      const previous = kept.current.byId.get(id);
      if (previous?.metrics === metrics && previous.revision === revision) return;
      const next = preferMetric(previous, { revision, metrics, stamp });
      if (next === previous) return;
      kept.current.byId.set(id, next);
      changed = true;
    };
    const settled = metricsSettle.data;
    if (settled?.identity === metricsIdentity) {
      for (const [id, revision] of settled.requested) {
        const row = settled.metrics?.[id];
        if (row !== undefined) retain(id, revision, row, metricsSettle.dataUpdatedAt);
      }
    }
    for (const [id, row] of Object.entries(headerMetrics)) {
      if (!isUnsettledPanelMetrics(row)) retain(id, header.data?.sourceRevisions.get(id) ?? '', row, header.dataUpdatedAt);
    }
    if (changed) updateMetrics((epoch) => epoch + 1);
  }, [header.data, header.dataUpdatedAt, headerMetrics, metricsSettle.data, metricsSettle.dataUpdatedAt, metricsIdentity]);
  // Hiding cancels the read and its continuation timer. Reopening checks the
  // shared facts before resuming any remaining projection.
  useEffect(() => {
    if (visible || requestIds.length === 0 || startedToken.current !== requestToken) return;
    settleReadAbort.current?.abort();
    reopenRefetch.current = undefined;
    setSettleBlock({ identity: metricsIdentity, token: requestToken });
  }, [visible, requestToken, requestIds.length, metricsIdentity]);

  // A hidden panel releases its scan. Reopening first checks shared completed
  // facts, then resumes the incremental read only if those facts are still missing.
  useEffect(() => {
    if (!visible || !settleBlocked || !metricsWanted || !state.loaded || state.resyncing) return;
    if (reopenRefetch.current === requestToken) return;
    reopenRefetch.current = requestToken;
    let current = true;
    void header.refetch({ cancelRefetch: false }).then(() => {
      if (current) setSettleBlock(undefined);
    });
    return () => { current = false; };
  }, [visible, settleBlocked, metricsWanted, state.loaded, state.resyncing, header.refetch, requestToken]);

  useEffect(() => () => { settleReadAbort.current?.abort(); }, []);
  const usage = metrics[agentId] ?? UNKNOWN_AGENT_PANEL_METRICS;
  const treeComplete = showsTree && !rosterIncomplete && ids.every((id) => !isUnsettledPanelMetrics(metrics[id]) && metrics[id]?.usagePartial !== true && metrics[id]?.costPartial !== true);
  const treeCounting = showsTree && (rosterPending || requestIds.length > 0 && !metricsSettle.isError);
  const tree = sumAgentTreeMetrics(ids, metrics);
  const { id: routeSessionId } = useParams<{ id?: string }>();
  const isMain = agentId === MAIN_AGENT_ID;
  const routeMatchesSession = routeSessionId === undefined || routeSessionId === state.sessionId;
  const sessionMatchesState = state.session === undefined || state.session.id === state.sessionId;
  const canFallbackToState = controller === undefined && isMain && routeMatchesSession && sessionMatchesState;
  const currentAgentState = agentState ?? (canFallbackToState ? state : undefined);
  const fallbackTodos = canFallbackToState ? state.todos : undefined;
  const rawTodos = (agentState?.todos ?? fallbackTodos ?? []).filter((todo): todo is typeof todo & { status: 'pending' | 'in_progress' | 'done' } =>
    todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done');
  const loaded = (agentState?.loaded ?? (canFallbackToState ? state.loaded : false)) === true;
  const baselineConfirmed = (agentState !== undefined && agentState.loaded === true && agentState.transcriptReady === true) ||
    (canFallbackToState && state.loaded === true && state.transcriptReady === true);
  const fallbackCoverage = canFallbackToState ? state.globalCoverage?.todos : undefined;
  const effectiveCoverage = todoCoverage ?? fallbackCoverage;
  const fallbackRefs = canFallbackToState ? state.contentRefs?.filter((ref) => ref.source.kind === 'todo' && ref.source.id === 'todo' && ref.path[0] === 'items') ?? [] : [];
  const effectiveRefs = todoRefs.length > 0 ? todoRefs : fallbackRefs;
  const fallbackLoadError = canFallbackToState ? (!state.loaded && state.loadError !== undefined) : false;
  const hasMoreOrRefs = effectiveCoverage?.hasMore === true || effectiveRefs.length > 0;
  const retainedTodosRef = useRef<Map<string, typeof rawTodos>>(new Map());
  const isConfirmedEmpty = baselineConfirmed && !agentState?.resyncing && !state.resyncing &&
    !hasMoreOrRefs && rawTodos.length === 0 && !todoReadFailed && !fallbackLoadError;

  if (isConfirmedEmpty) {
    retainedTodosRef.current.delete(identityKey);
  } else if (rawTodos.length > 0) {
    if (retainedTodosRef.current.size > 50) {
      const oldestKey = retainedTodosRef.current.keys().next().value;
      if (oldestKey !== undefined) retainedTodosRef.current.delete(oldestKey);
    }
    retainedTodosRef.current.set(identityKey, rawTodos);
  }
  const retainedTodos = retainedTodosRef.current.get(identityKey);
  const todos = isConfirmedEmpty ? [] : rawTodos.length > 0 ? rawTodos : (!baselineConfirmed || hasMoreOrRefs ? (retainedTodos ?? []) : []);
  const planMode = agentState?.planMode;
  const profileName = profile?.name === 'unknown' ? '' : (profile?.name ?? agentState?.profile ?? '');
  const unavailableReason = data === undefined
    ? undefined
    : capabilityReasonText(t, data.unavailable_reason_code, data.unavailable_reason);

  const subagentTargets = useMemo(() => mapPanelSubagentTargets(data?.targets), [data?.targets]);
  const mappedSkills = useMemo(() => mapPanelSkills(data?.skills), [data?.skills]);
  const mappedTools = useMemo(() => mapPanelTools(data?.tools), [data?.tools]);
  const draftScope = useMemo(() => ({
    workspace_id: state.session?.workspace_id,
    cwd: state.session?.metadata?.cwd,
  }), [state.session?.workspace_id, state.session?.metadata?.cwd]);
  // The resident overview needs the server's automatic compaction point;
  // only that slice starts the read.
  const autoCompact = useAutoCompact({
    sessionId: part === 'overview' && visible ? state.sessionId : undefined,
    agentId,
    refreshKey: `${currentAgentState?.model ?? ''}:${currentAgentState?.maxContextTokens ?? ''}`,
  });

  const todoStatus = agentState === undefined
    ? canFallbackToState
      ? (!state.loaded || !state.transcriptReady || hasMoreOrRefs) ? 'loading' : undefined
      : 'unknown'
    : todoReadFailed || (!loaded && agentState.loadError !== undefined)
      ? 'error'
      : !loaded || effectiveRefs.length > 0 || effectiveCoverage?.hasMore === true
        ? 'loading'
        : undefined;
  const notesReadProvenance = agentState?.todoRead ?? agentState?.historyRead;
  const notesPartial = agentState?.todoRead !== undefined
    ? agentState.todoRead.readiness !== 'ready'
    : (notesReadProvenance !== undefined && notesReadProvenance.readiness !== 'ready') ||
      agentState?.historyCoverageKind === 'unknown';
  const notesStatus = agentState === undefined || controller === undefined
    ? 'unknown'
    : notesReadFailed || (!loaded && agentState.loadError !== undefined)
      ? 'error'
      : !loaded
        ? 'loading'
        : notesPartial
          ? 'partial'
          : undefined;
  const retryNotes = useCallback(() => {
    if (controller === undefined) return;
    if (!loaded) {
      if (!state.loaded && controller.retryOpen !== undefined) {
        void controller.retryOpen();
      } else {
        void controller.resync();
      }
      return;
    }
    if (notesStatus === 'partial' && todoCoverage?.hasMore !== true) {
      void controller.resync();
      return;
    }
    notesRead.current?.retry();
    if (todoCoverage?.hasMore) void controller.loadTranscriptEntities(agentId, 'todo');
  }, [controller, agentId, loaded, state.loaded, notesStatus, todoCoverage?.hasMore]);
  const todoSection = <>
    {todos.length > 0 ? <AgentTodoSection
      key={`${state.sessionId}:${agentId}`}
      todos={todos.map((todo, index) => ({ ...todo, id: `${agentId}:${index}` }))}
      incomplete={todoStatus !== undefined}
    /> : null}
    {todoStatus !== undefined ? <p role="status" data-agent-todos-status={todoStatus} className="text-[12px] leading-relaxed text-ink-faint">
      {t(todoStatus === 'error' ? 'agentPanel.todos.loadFailed' : todoStatus === 'loading' ? 'agentPanel.todos.loading' : 'agentPanel.todos.unknown')}
      {todoStatus === 'error' && loaded ? <button type="button" className="ml-1.5 font-medium text-ink-soft transition-colors hover:text-ink" onClick={retryTodos}>{t('common.retry')}</button> : null}
    </p> : null}
  </>;
  const planSection = agentState !== undefined ? <AgentPlanSection
    key={`${state.sessionId}:${agentId}`}
    sessionId={state.sessionId}
    agentId={agentId}
    loaded={loaded}
    resyncing={agentState.resyncing}
    planMode={planMode}
  /> : null;
  // The agent's own working notes sit under its checklist: the same writer
  // (TodoList), read-only here, from this agent's state only. The section
  // itself tells a still-loading agent from one that has no notes yet.
  const notesSection = (
    <AgentNotesSection
      key={`notes:${identityKey}`}
      notes={effectiveNotes} meta={effectiveMeta} status={agentState?.todoNotesStatus} loaded={loaded}
      viewStatus={notesStatus} loadError={agentState?.loadError}
      onRetry={controller !== undefined ? retryNotes : undefined}
      beginRead={controller !== undefined && readsTodos ? beginNotesRead : undefined}
      contentStatus={notesContentStatus} contentSignature={JSON.stringify(notesRefs)}
    />
  );
  // Which hook rules this agent runs with, and from which file: an on-demand
  // detail under its notes, asked only when this agent has live state.
  const hooksSection = agentState !== undefined
    ? <AgentHooksSection key={`hooks:${state.sessionId}:${agentId}`} sessionId={state.sessionId} agentId={agentId}
      refreshKey={JSON.stringify([visible, state.loaded, state.resyncing, agentState.loaded, agentState.resyncing, active, agentState.profile, agentState.model])} />
    : null;
  if (part === 'work') {
    return <div data-agent-panel-container data-agent-panel-part="work" className="space-y-4 empty:hidden">
      {todoSection}
      {notesSection}
      {hooksSection}
      {planSection}
    </div>;
  }
  const identityProps = {
    identity: {
      id: agentId, sessionId: state.sessionId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? agentState?.model,
      thinkingEffort: profile?.thinking_effort,
      thinkingEffortExplicit: node?.thinkingEffortExplicit ?? profile?.thinking_effort_explicit,
      executorId: node?.executorId ?? state.session?.agent_config.execution?.selection.executor,
      executorProtocol: node?.executorProtocol,
      thinkingEffortSource: profile?.thinking_effort_source,
      routeDetached: profile?.route_detached,
      profileSource: profile?.profile_source,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID,
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    },
    profilePolicy: profile?.can_spawn_subagents === false ? 'fixed' as const : undefined, dispatchTargets: data?.targets,
    subagentTargets, skills: mappedSkills, toolCapabilities: mappedTools, draftScope, usage,
    // The profile card has no way to mark a count as partial, so it keeps the
    // stricter rule: a tree that is not fully reported shows no total at all.
    // The overview labels its own partial sum instead.
    treeMetrics: agentId === MAIN_AGENT_ID ? {
      ...(treeComplete ? tree : { totalTokens: null, totalCostUsd: null }),
      cacheHitRate: treeComplete ? aggregateTreeCacheHitRate(ids, metrics) : null,
      cacheReadTokens: treeComplete ? aggregateTreeCacheReadTokens(ids, metrics) : null,
      cacheWriteTokens: treeComplete ? aggregateTreeCacheWriteTokens(ids, metrics) : null,
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined,
    onOpenUsageDetail: () => { void navigate(usageSessionDeepLink(state.sessionId)); },
  };
  const settleFailed = metricsSettle.isError && !isCancelledMetricsRead(metricsSettle.error);
  const settleError = settleFailed ? (
    <p role="status" data-metrics-settle-error className="text-[12px] leading-relaxed text-ink-faint">
      {t(SETTLED_METRICS_KEY)}
      <button type="button" className="ml-1.5 font-medium text-ink-soft transition-colors hover:text-ink" onClick={() => { setSettleBlock(undefined); void metricsSettle.refetch(); }}>{t('common.retry')}</button>
    </p>
  ) : null;
  if (part === 'usage') {
    return <>
      <AgentIdentitySection {...identityProps} part="usage" />
      {settleError}
    </>;
  }
  const facts = overviewFacts({
    t, agentId, state, agentState: currentAgentState, forest, usage, metrics, ids, treeComplete, treeCounting, tree,
    compactPoint: autoCompact?.status?.tokens,
  });
  if (part === 'overview') {
    const cockpit = (
      <CockpitOverview
        sessionId={state.sessionId}
        agentId={agentId}
        forest={forest}
        blocks={state.blocks}
        contextUsed={facts.contextUsed}
        contextLimit={facts.contextLimit}
        compactPoint={facts.compactPoint}
        figures={facts.figures}
        treeFigures={facts.cockpitTreeFigures}
        turns={facts.turns}
        toolCalls={facts.toolCalls}
        onOpenAgent={onOpenAgent}
        expandedBranches={expandedBranches ?? NO_BRANCHES}
        onToggleBranch={onToggleBranch ?? noopToggleBranch}
        sessionPending={sessionPending ?? NO_PENDING_BLOCKS}
        mainBusy={state.busy}
        turnStartedAt={state.turnStartedAt}
        mainLabel={mainLabel ?? t('rail.ownerMain')}
        sessionTasks={state.tasks}
        agentCounts={state.agentCounts}
      />
    );
    return <div data-agent-panel-container data-agent-panel-part="overview" data-overview-mode={overviewMode}>
      {overviewMode === 'cockpit' ? (renderOverview === undefined ? cockpit : renderOverview(cockpit, null)) : (
        <InspectorOverview
          contextUsed={facts.contextUsed}
          contextLimit={facts.contextLimit}
          compactPoint={facts.compactPoint}
          figures={facts.figures}
          treeFigures={facts.treeFigures}
          scope={scope}
          onScope={setScope}
          renderLayout={renderOverview}
          startedAt={facts.startedAt}
          turns={facts.turns}
          toolCalls={facts.toolCalls}
        />
      )}
      {settleError}
    </div>;
  }
  if (part === 'profile') {
    // A partial answer still shows what it knows: the section mounts once any
    // optional capability field arrived, and the missing kinds get their own
    // quiet line inside their tabs. An answer with neither optional field
    // falls through to the server's own unavailable reason, as before.
    const counts = data !== undefined && (data.tools !== undefined || data.skills !== undefined)
      ? capabilityCounts(mappedTools, mappedSkills, subagentTargets)
      : undefined;
    // Hover detail on the folded line; the tabs carry the counts when open.
    // Tools count every source — MCP and plugin tools included.
    const summary = data === undefined || counts === undefined ? undefined : [
      ...(data.tools === undefined ? [] : [`${t('inspector.cap.tools')} ${counts.toolsOn}`]),
      ...(data.skills === undefined ? [] : [`${t('inspector.cap.skills')} ${counts.skills}`]),
      `${t('inspector.cap.subagents')} ${counts.subagents}`,
    ].join(' · ');
    // A failed read is one quiet line inside the card, never a banner.
    const capabilityBody = counts !== undefined ? (
      <AgentCapabilitiesSection
        tools={mappedTools}
        skills={mappedSkills}
        subagentTargets={subagentTargets}
        draftScope={draftScope}
        callerProfile={profileName === '' ? undefined : profileName}
        capabilityGaps={data === undefined ? undefined : capabilityFieldGaps(data)}
        onRetryCapabilities={() => { void capabilities.refetch(); }}
      />
    ) : capabilities.isPending ? (
      <p role="status" className="text-[12px] text-ink-faint">{t('inspector.cap.loading')}</p>
    ) : capabilities.isError && isCapabilityUnsupportedError(capabilities.error) ? (
      <p role="status" data-capabilities-unsupported className="sr-only">{t('diagnostics.unknown')}</p>
    ) : capabilities.isError ? (
      <p role="status" data-capabilities-error className="text-[12px] leading-relaxed text-ink-faint">
        {t('inspector.cap.loadFailed')}
        <button type="button" className="ml-1.5 font-medium text-ink-soft transition-colors hover:text-ink" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
      </p>
    ) : unavailableReason !== undefined ? (
      <p role="status" className="text-[12px] leading-relaxed text-ink-faint">{unavailableReason}</p>
    ) : null;
    return <div data-agent-panel-container data-agent-panel-part="profile">
      <AgentIdentitySection key={identityKey} {...identityProps} part="profile" capabilities={capabilityBody} capabilitySummary={summary}
        onExpandedChange={(expanded) => { setExpandedIdentity(expanded ? identityKey : undefined); }} />
    </div>;
  }
  return <div data-agent-panel-container className="space-y-5">
    <AgentIdentitySection identity={{
      id: agentId, sessionId: state.sessionId, profile: profileName,
      label: node?.label ?? agentId, model: profile?.model ?? agentState?.model,
      thinkingEffort: profile?.thinking_effort,
      thinkingEffortExplicit: node?.thinkingEffortExplicit ?? profile?.thinking_effort_explicit,
      executorId: node?.executorId ?? state.session?.agent_config.execution?.selection.executor,
      executorProtocol: node?.executorProtocol,
      thinkingEffortSource: profile?.thinking_effort_source,
      routeDetached: profile?.route_detached,
      profileSource: profile?.profile_source,
      status: node?.status ?? 'unknown', summary: profile?.description,
      description: profile?.description, source: profile?.source, sourceFile: profile?.source_file,
      context: data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID,
      configContentPreview: profile === undefined ? undefined : JSON.stringify(profile, null, 2),
      rawProfile: profile,
    }} profilePolicy={profile?.can_spawn_subagents === false ? 'fixed' : undefined} dispatchTargets={data?.targets}
      subagentTargets={subagentTargets}
      skills={mappedSkills}
      toolCapabilities={mappedTools}
      draftScope={draftScope}
      usage={usage} treeMetrics={agentId === MAIN_AGENT_ID ? {
      ...(treeComplete ? tree : { totalTokens: null, totalCostUsd: null }),
      cacheHitRate: treeComplete ? aggregateTreeCacheHitRate(ids, metrics) : null,
      cacheReadTokens: treeComplete ? aggregateTreeCacheReadTokens(ids, metrics) : null,
      cacheWriteTokens: treeComplete ? aggregateTreeCacheWriteTokens(ids, metrics) : null,
      activeSubagentsCount: Object.values(forest.byId).filter((entry) => entry.agentId !== MAIN_AGENT_ID && entry.busy).length,
      totalSubagentsCount: ids.filter((id) => id !== MAIN_AGENT_ID).length,
    } : undefined} onOpenUsageDetail={() => { void navigate(usageSessionDeepLink(state.sessionId)); }} />
    {capabilities.isPending ? <p role="status" className="text-[12.5px] text-ink-faint">{t('diagnostics.loading')}</p> : null}
    {/* An unsupported capability scope is a gap, not a failure: render nothing
        visible (the marker stays for assistive tech and tests). */}
    {capabilities.isError && isCapabilityUnsupportedError(capabilities.error) ? (
      <p role="status" data-capabilities-unsupported className="sr-only">{t('diagnostics.unknown')}</p>
    ) : null}
    {capabilities.isError && !isCapabilityUnsupportedError(capabilities.error) ? <div role="alert" className="border-l-2 border-danger pl-3 text-[12.5px] text-danger">
      {t('diagnostics.error')} · {agentCapabilitiesErrorText(capabilities.error, t)}
      <button type="button" className="ml-2 font-medium text-ink underline underline-offset-2" onClick={() => { void capabilities.refetch(); }}>{t('common.retry')}</button>
    </div> : settleError}
    {todoSection}
    {notesSection}
    {agentState !== undefined ? <AgentPlanSection
      key={`${state.sessionId}:${agentId}`}
      sessionId={state.sessionId}
      agentId={agentId}
      loaded={loaded}
      resyncing={agentState.resyncing}
      planMode={planMode}
    /> : null}
    {data !== undefined && (data.tools === undefined || data.skills === undefined) ?
      <p role="status" className="text-[12.5px] leading-relaxed text-ink-faint">{unavailableReason ?? t('diagnostics.unknown')}</p> : null}
    {data?.tools !== undefined && data.skills !== undefined ? <AgentCapabilitiesSection
      tools={mappedTools}
      skills={mappedSkills}
      subagentTargets={subagentTargets}
      draftScope={draftScope}
    /> : null}
  </div>;
}

type Translate = ReturnType<typeof useI18n>['t'];

const known = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function figuresFrom(usage: AgentTokenUsage, t: Translate): OverviewFigures {
  const cacheRate = agentUsageCacheHitRate(usage);
  return {
    costUsd: known(usage.totalCostUsd) ? usage.totalCostUsd : undefined,
    totalTokens: known(usage.totalTokens) ? usage.totalTokens : undefined,
    inputTokens: known(usage.inputTokens) ? usage.inputTokens : undefined,
    outputTokens: known(usage.outputTokens) ? usage.outputTokens : undefined,
    cacheRate: cacheRate ?? undefined,
    cacheTitle: known(usage.cacheReadTokens) || known(usage.cacheWriteTokens)
      ? t('agentPanel.cacheRawTooltip', {
          read: known(usage.cacheReadTokens) ? usage.cacheReadTokens.toLocaleString() : '—',
          write: known(usage.cacheWriteTokens) ? usage.cacheWriteTokens.toLocaleString() : '—',
        })
      : undefined,
    compactions: known(usage.compactionCount) ? usage.compactionCount : undefined,
    partial: usage.usagePartial === true || usage.costPartial === true,
    counting: usage.usageComplete === false,
  };
}

/**
 * Everything the overview shows, derived once. Only known values are returned;
 * each consumer drops what is missing.
 */
function overviewFacts(input: {
  t: Translate;
  agentId: string;
  state: SessionViewState;
  agentState: SessionViewState | undefined;
  forest: AgentForest;
  usage: AgentTokenUsage;
  metrics: Readonly<Record<string, AgentTokenUsage>>;
  ids: readonly string[];
  treeComplete: boolean;
  treeCounting: boolean;
  tree: { totalTokens: number | null; totalCostUsd: number | null };
  compactPoint: number | undefined;
}) {
  const { t, agentId, state, agentState, forest, usage, metrics, ids, treeComplete, treeCounting, tree } = input;
  const isMain = agentId === MAIN_AGENT_ID;
  const node = forest.byId[agentId];
  const contextUsed = agentState?.contextTokens ?? node?.contextTokens
    ?? (known(usage.contextTokens) ? usage.contextTokens : undefined);
  const reportedLimit = agentState === undefined ? node?.maxContextTokens : agentState.maxContextTokens;
  const contextLimit = reportedLimit !== undefined && reportedLimit > 0 ? reportedLimit : undefined;
  const figures = figuresFrom(usage, t);
  // The standard inspector's own tree scope. It stays main-only on purpose:
  // the inspector offers a reader a switch between "this agent" and "the
  // tree", and widening that switch to every child page is a product change
  // this slice does not own. The cockpit is the other surface (see
  // `cockpitTreeFigures`), and there the tree is the fixed subject.
  const treeFigures: OverviewFigures | undefined = isMain ? {
    costUsd: tree.totalCostUsd ?? undefined,
    totalTokens: tree.totalTokens ?? undefined,
    cacheRate: aggregateTreeCacheHitRate(ids, metrics) ?? undefined,
    incomplete: !treeComplete,
    counting: treeCounting,
  } : undefined;
  // The cockpit's figures, for every agent's page.
  //
  // The cockpit's context and cache arcs answer "what has this session cost",
  // which is a question about the tree and not about whichever agent happens
  // to be open — its graph is the whole tree on every page. So it is fed the
  // tree figures on any agent's page, not just main's. Gating these on main
  // meant a child page's cockpit fell back to that one agent's own numbers
  // while still labelling them "whole session", so the same rail reported two
  // different totals depending on which agent was selected. The inputs
  // (`tree`, `metrics`, `ids`, `treeComplete`) are already derived for every
  // agent, so this widens what is *offered*, not what is read: no per-agent
  // transcript or body is subscribed here.
  //
  // A tree that is not fully counted sums only the agents the server has
  // reported and marks itself incomplete, which the arcs already render as a
  // partial scope instead of a total.
  const cockpitTreeFigures: OverviewFigures = {
    costUsd: tree.totalCostUsd ?? undefined,
    totalTokens: tree.totalTokens ?? undefined,
    cacheRate: aggregateTreeCacheHitRate(ids, metrics) ?? undefined,
    incomplete: !treeComplete,
    counting: treeCounting,
  };
  const startedAt = isMain ? state.session?.created_at : node?.startedAt;
  const turns = isMain ? state.session?.usage?.turn_count : undefined;
  const toolCalls = !isMain && node?.toolCallCountKnown === true ? node.toolCallCount : undefined;
  return {
    contextUsed,
    contextLimit,
    compactPoint: contextLimit !== undefined && input.compactPoint !== undefined && input.compactPoint > 0
      ? input.compactPoint : undefined,
    figures,
    treeFigures,
    cockpitTreeFigures,
    startedAt,
    turns,
    toolCalls,
  };
}
