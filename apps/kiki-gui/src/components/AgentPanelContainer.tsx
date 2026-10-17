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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { AgentForest, ApprovalBlock, QuestionBlock, SessionController, SessionViewState } from '@kiki/session-core/session';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
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
import { aggregateTreeCacheHitRate, aggregateTreeCacheReadTokens, aggregateTreeCacheWriteTokens } from './agent-panel/cacheRate';
import {
  agentCapabilitiesErrorText,
  capabilityReasonText,
  isCapabilityUnsupportedError,
  mapPanelSkills,
  mapPanelSubagentTargets,
  mapPanelTools,
} from './agent-panel/mapCapabilities';
import { isCompletePanelMetrics, isUnsettledPanelMetrics, mergePanelMetrics, panelMetricsCapabilitiesKey, panelMetricsSettleKey, panelMetricsSourceRevision } from './agent-panel/panelMetricsQuery';

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

type KeptPanelMetrics = {
  identity: string;
  once: boolean;
  readonly byId: Map<string, KeptPanelMetric>;
  readonly accepted: Map<string, string>;
};

function sourceRevisionFor(controller: SessionController | undefined, forest: AgentForest, id: string): string {
  const state = controller === undefined
    ? undefined
    : id === MAIN_AGENT_ID ? controller.getState() : controller.getAgentState(id);
  return panelMetricsSourceRevision({
    cursorSeq: state?.cursor.seq,
    cursorEpoch: state?.cursor.epoch,
    transcriptResetVersion: state?.transcriptResetVersion,
    usage: state?.usage,
    rosterUsage: forest.byId[id]?.usage,
  });
}

function revisionToken(ids: readonly string[], revisions: ReadonlyMap<string, string>): string {
  return ids.map((id) => `${id}\u0001${revisions.get(id) ?? ''}`).join('\u0002');
}

function usePanelSourceRevisions(
  controller: SessionController | undefined,
  forest: AgentForest,
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const idsKey = ids.join('\0');
  const forestRef = useRef(forest);
  const idsRef = useRef(ids);
  forestRef.current = forest;
  idsRef.current = ids;
  const subscribe = useCallback((listener: () => void) => {
    if (controller === undefined) return () => {};
    // The forest and each agent's panel revision are already read from the
    // controller snapshot below. Subscribing every historical agent here would
    // turn metrics observation into transcript turn demand, causing one full
    // ordered-view reattach per roster row. The main publication is the stable
    // invalidation point; it also keeps this observer read-only for child rows.
    return controller.subscribe(listener);
  }, [controller, idsKey]);
  const read = useCallback(
    () => idsRef.current.map((id) => sourceRevisionFor(controller, forestRef.current, id)).join('\n'),
    [controller],
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
 * state, never as the session's main agent.
 */
function useAgentViewState(sessionId: string, agentId: string): { controller: SessionController | undefined; agentState: SessionViewState | undefined } {
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
    (listener: () => void) => {
      if (controller === undefined) return noopSubscribe();
      return agentId === MAIN_AGENT_ID
        ? controller.subscribe(listener)
        : controller.subscribeAgent(agentId, listener);
    },
    [controller, agentId],
  );
  const readAgentState = useCallback(
    (): SessionViewState | undefined =>
      controller === undefined
        ? undefined
        : agentId === MAIN_AGENT_ID
          ? controller.getState()
          : controller.getAgentState(agentId),
    [controller, agentId],
  );
  const agentState = useSyncExternalStore(subscribeAgent, readAgentState);
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
  const query = { session_id: state.sessionId, agent_id: agentId, metrics_only: part === 'overview' || part === 'usage' ? true : undefined };
  const node = forest.byId[agentId];
  const { controller, agentState } = useAgentViewState(state.sessionId, agentId);

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
  const capabilities = useQuery({
    queryKey: panelMetricsCapabilitiesKey(query, connection.spaceKey, connection.scopeId, connection.meta?.server_id ?? ''),
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    // The `work` slice (todo + plan) reads only the live agent state; it never
    // needs the capability/metrics read, so it does not start one.
    enabled: part !== 'work' && visible && state.loaded && !state.resyncing,
    // Overview and setup render side by side and read the same answer.
    // This refresh stays a header read: it must not send metrics_settle, or an
    // active agent would restart a full wire scan under the 30s mutable TTL.
    staleTime: 5_000,
    refetchInterval: (current) => visible && active && current.state.data?.metrics?.[agentId] !== undefined ? 15_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: visible && active,
    retry: false,
  });
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
    if (part === 'work' || !visible || previousSignature.current === refreshSignature || !state.loaded || state.resyncing || capabilities.isFetching) return;
    previousSignature.current = refreshSignature;
    void capabilities.refetch({ cancelRefetch: false });
  }, [part, visible, refreshSignature, state.loaded, state.resyncing, capabilities.isFetching, capabilities.refetch]);
  const data = capabilities.data;
  const profile = data?.profile;
  const metricsIdentity = `${connection.spaceKey}:${connection.scopeId}:${serverId}:${state.sessionId}:${agentId}`;
  const headerHold = useRef<{ space: string; updatedAt: number } | undefined>(undefined);
  const spaceIdentity = `${connection.spaceKey}:${connection.scopeId}:${serverId}`;
  if (headerHold.current === undefined) headerHold.current = { space: spaceIdentity, updatedAt: -1 };
  else if (headerHold.current.space !== spaceIdentity) headerHold.current = { space: spaceIdentity, updatedAt: capabilities.dataUpdatedAt };
  const headerHeld = headerHold.current.updatedAt !== -1 && capabilities.dataUpdatedAt === headerHold.current.updatedAt;
  const rawHeader = data?.metrics ?? EMPTY_PANEL_METRICS;
  const headerMetrics = headerHeld ? EMPTY_PANEL_METRICS : rawHeader;
  // The open agent, plus the whole tree when this surface actually shows it.
  // Scope switches stay local: they read this set and do not start a read.
  const showsTree = part !== 'work' && (agentId === MAIN_AGENT_ID || (part === 'overview' && overviewMode === 'cockpit'));
  const settleKeyIds = useMemo(() => {
    const treeIds = new Set<string>([MAIN_AGENT_ID, agentId]);
    for (const id of Object.keys(forest.byId)) treeIds.add(id);
    for (const id of Object.keys(rawHeader)) treeIds.add(id);
    return [...(showsTree ? treeIds : [agentId])].sort();
  }, [agentId, forest, rawHeader, showsTree]);
  const revisions = usePanelSourceRevisions(controller, forest, settleKeyIds);
  const kept = useRef<KeptPanelMetrics>({ identity: '', once: false, byId: new Map(), accepted: new Map() });
  const initialFlight = useRef<{ identity: string; ids: readonly string[] } | undefined>(undefined);
  const stampClock = useRef(0);
  const headerStamp = useRef(0);
  const seenHeader = useRef(data);
  const startedToken = useRef<string | undefined>(undefined);
  if (kept.current.identity !== metricsIdentity) {
    kept.current = { identity: metricsIdentity, once: false, byId: new Map(), accepted: new Map() };
    initialFlight.current = undefined;
    stampClock.current = 0;
    headerStamp.current = 0;
    seenHeader.current = undefined;
    startedToken.current = undefined;
  }
  if (seenHeader.current !== data) {
    seenHeader.current = data;
    stampClock.current += 1;
    headerStamp.current = stampClock.current;
  }
  const [keptEpoch, setKeptEpoch] = useState(0);
  const [settleBlock, setSettleBlock] = useState<{ identity: string; token: string } | undefined>(undefined);
  const reopenRefetch = useRef<string | undefined>(undefined);
  const revisionOf = (id: string) => revisions.get(id) ?? '';
  const dirtyIds = kept.current.once
    ? settleKeyIds.filter((id) => {
        const accepted = kept.current.accepted.get(id);
        return accepted !== undefined && accepted !== revisionOf(id);
      })
    : [];
  const missingIds = settleKeyIds.filter((id) => {
    if (dirtyIds.includes(id)) return false;
    const keptRow = kept.current.byId.get(id);
    if (keptRow !== undefined && !isUnsettledPanelMetrics(keptRow.metrics) && keptRow.revision === revisionOf(id)) return false;
    if (isCompletePanelMetrics(headerMetrics[id])) return false;
    return isUnsettledPanelMetrics(headerMetrics[id]);
  });
  const canSettle = part !== 'work' && visible && state.loaded && !state.resyncing && capabilities.isSuccess && !headerHeld;
  let requestIds: readonly string[] = [];
  if (!headerHeld && dirtyIds.length > 0) requestIds = dirtyIds;
  else if (!headerHeld && kept.current.once) requestIds = missingIds;
  else if (!headerHeld && missingIds.length > 0) {
    if (canSettle && initialFlight.current?.identity !== metricsIdentity) {
      initialFlight.current = { identity: metricsIdentity, ids: settleKeyIds };
    }
    requestIds = initialFlight.current?.identity === metricsIdentity ? initialFlight.current.ids : settleKeyIds;
  }
  if (requestIds.length === 0 && !headerHeld) {
    if (!kept.current.once && missingIds.length === 0) kept.current.once = true;
    if (kept.current.once) {
      for (const id of settleKeyIds) {
        if (!kept.current.accepted.has(id)) kept.current.accepted.set(id, revisionOf(id));
      }
    }
  }
  const requestToken = requestIds.length === 0
    ? `idle:${metricsIdentity}`
    : `${spaceIdentity}\0${revisionToken(requestIds, revisions)}`;
  const settleBlocked = settleBlock?.identity === metricsIdentity && settleBlock.token === requestToken;
  const requestTokenRef = useRef(requestToken);
  requestTokenRef.current = requestToken;
  const settleReadAbort = useRef<AbortController | undefined>(undefined);
  const settleContext = useRef({ headerMetrics, settleKeyIds, revisions });
  settleContext.current = { headerMetrics, settleKeyIds, revisions };
  const metricsSettle = useQuery({
    queryKey: panelMetricsSettleKey(
      state.sessionId,
      agentId,
      requestIds.length > 0 ? requestIds : settleKeyIds,
      requestToken,
      serverId,
    ),
    queryFn: ({ signal, queryKey }) => {
      const ids = [...(queryKey[3] as readonly string[])];
      const token = String(queryKey[4] ?? '');
      startedToken.current = token;
      const abortController = new AbortController();
      settleReadAbort.current = abortController;
      const abort = () => { abortController.abort(signal.reason); };
      signal.addEventListener('abort', abort);
      if (signal.aborted) abort();
      const request = klient.global.agentPanel.read({
        session_id: state.sessionId,
        agent_id: agentId,
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
      return Promise.race([request, aborted]).finally(() => {
        signal.removeEventListener('abort', abort);
        if (settleReadAbort.current === abortController) settleReadAbort.current = undefined;
      });
    },
    // The first read counts the ids on screen. After that, only an agent whose
    // controller, transcript or roster revision moved is read again. Hiding
    // drops the waiter; it does not start another read when the panel returns.
    enabled: canSettle && requestIds.length > 0 && !settleBlocked,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (kept.current.identity !== metricsIdentity) return;
    const settled = metricsSettle.data?.metrics;
    if (settled === undefined) return;
    const token = requestTokenRef.current;
    const prefix = `${spaceIdentity}\0`;
    if (!token.startsWith(prefix) || token.startsWith('idle:')) return;
    const requested = new Map<string, string>();
    for (const part of token.slice(prefix.length).split('\u0002')) {
      const cut = part.indexOf('\u0001');
      if (cut <= 0) continue;
      requested.set(part.slice(0, cut), part.slice(cut + 1));
    }
    let changed = false;
    for (const [id, revision] of requested) {
      const row = settled[id];
      if (row === undefined || isUnsettledPanelMetrics(row)) {
        if (kept.current.accepted.get(id) !== revision) {
          kept.current.accepted.set(id, revision);
          changed = true;
        }
        continue;
      }
      const previous = kept.current.byId.get(id);
      if (previous?.revision === revision && previous.metrics === row) continue;
      stampClock.current += 1;
      kept.current.byId.set(id, { revision, metrics: row, stamp: stampClock.current });
      kept.current.accepted.set(id, revision);
      changed = true;
    }
    const covered = settleContext.current.settleKeyIds.every((id) => {
      const row = kept.current.byId.get(id);
      return (row !== undefined && !isUnsettledPanelMetrics(row.metrics)) || isCompletePanelMetrics(settleContext.current.headerMetrics[id]);
    });
    if (covered && !kept.current.once) {
      kept.current.once = true;
      for (const id of settleContext.current.settleKeyIds) {
        if (!kept.current.accepted.has(id)) {
          const revision = requested.get(id) ?? settleContext.current.revisions.get(id) ?? '';
          kept.current.accepted.set(id, revision);
        }
      }
      changed = true;
    }
    if (changed) setKeptEpoch((epoch) => epoch + 1);
  }, [metricsSettle.data, metricsSettle.dataUpdatedAt, metricsIdentity, spaceIdentity]);
  // Hiding drops the waiter. The query stays disabled for that same source,
  // so showing the panel again does not start a second scan.
  useEffect(() => {
    if (visible || requestIds.length === 0 || startedToken.current !== requestToken) return;
    settleReadAbort.current?.abort();
    setSettleBlock({ identity: metricsIdentity, token: requestToken });
  }, [visible, requestToken, requestIds.length, metricsIdentity]);

  // A hidden panel releases its scan. Reopening first checks shared completed
  // facts, then resumes the incremental read only if those facts are still missing.
  useEffect(() => {
    if (!visible || !settleBlocked || part === 'work' || !state.loaded || state.resyncing || capabilities.isFetching) return;
    if (reopenRefetch.current === requestToken) return;
    reopenRefetch.current = requestToken;
    let current = true;
    void capabilities.refetch({ cancelRefetch: false }).then(() => {
      if (current) setSettleBlock(undefined);
    });
    return () => { current = false; };
  }, [visible, settleBlocked, part, state.loaded, state.resyncing, capabilities.refetch, requestToken]);

  useEffect(() => () => { settleReadAbort.current?.abort(); }, []);
  const settledView = useMemo(() => {
    const rows: Record<string, AgentPanelMetrics> = {};
    const stamps: Record<string, number> = {};
    if (kept.current.identity !== metricsIdentity) return { rows, stamps };
    for (const [id, row] of kept.current.byId) {
      rows[id] = row.metrics;
      stamps[id] = row.stamp;
    }
    return { rows, stamps };
  }, [keptEpoch, metricsIdentity]);
  const metrics = mergePanelMetrics(headerMetrics, settledView.rows, {
    headerStamp: headerStamp.current,
    settledStamp: settledView.stamps,
  });
  const usage = metrics[agentId] ?? UNKNOWN_AGENT_PANEL_METRICS;
  const ids = [...new Set([MAIN_AGENT_ID, ...Object.keys(forest.byId), ...Object.keys(metrics)])];
  const treeComplete = ids.every((id) => !isUnsettledPanelMetrics(metrics[id]) && metrics[id]?.usagePartial !== true && metrics[id]?.costPartial !== true);
  // Sums the agents the server has actually reported, and `null` only when
  // none are known. Callers label an incomplete sum as such rather than
  // passing it off as the whole tree.
  const tree = sumAgentTreeMetrics(ids, metrics);
  const { id: routeSessionId } = useParams<{ id?: string }>();
  const isMain = agentId === MAIN_AGENT_ID;
  const routeMatchesSession = routeSessionId === undefined || routeSessionId === state.sessionId;
  const sessionMatchesState = state.session === undefined || state.session.id === state.sessionId;
  const canFallbackToState = controller === undefined && isMain && routeMatchesSession && sessionMatchesState;
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
    refreshKey: `${agentState?.model ?? ''}:${agentState?.maxContextTokens ?? ''}`,
  });
  const [scope, setScope] = useState<'agent' | 'tree'>('agent');

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
    ? <AgentHooksSection key={`hooks:${state.sessionId}:${agentId}`} sessionId={state.sessionId} agentId={agentId} />
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
    t, agentId, state, agentState, forest, usage, metrics, ids, treeComplete, tree,
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
    const counts = data?.tools !== undefined && data.skills !== undefined
      ? capabilityCounts(mappedTools, mappedSkills, subagentTargets)
      : undefined;
    // Hover detail on the folded line; the tabs carry the counts when open.
    // Tools count every source — MCP and plugin tools included.
    const summary = counts === undefined ? undefined : [
      `${t('inspector.cap.tools')} ${counts.toolsOn}`,
      `${t('inspector.cap.skills')} ${counts.skills}`,
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
      <AgentIdentitySection {...identityProps} part="profile" capabilities={capabilityBody} capabilitySummary={summary} />
      {settleError}
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
  tree: { totalTokens: number | null; totalCostUsd: number | null };
  compactPoint: number | undefined;
}) {
  const { t, agentId, state, agentState, forest, usage, metrics, ids, treeComplete, tree } = input;
  const isMain = agentId === MAIN_AGENT_ID;
  const node = forest.byId[agentId];
  const contextUsed = agentState?.contextTokens ?? (isMain ? state.contextTokens ?? state.session?.usage?.context_tokens : node?.contextTokens)
    ?? (known(usage.contextTokens) ? usage.contextTokens : undefined);
  const contextLimit = agentState?.maxContextTokens ?? (isMain ? state.maxContextTokens ?? (state.session?.usage?.context_limit || undefined) : node?.maxContextTokens)
    ?? (known(usage.contextLimit) && usage.contextLimit > 0 ? usage.contextLimit : undefined);
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
  };
  const startedAt = isMain ? state.session?.created_at : node?.startedAt;
  const turns = isMain ? state.session?.usage?.turn_count : undefined;
  const toolCalls = !isMain && node?.toolCallCountKnown === true ? node.toolCallCount : undefined;
  return {
    contextUsed,
    contextLimit,
    compactPoint: input.compactPoint,
    figures,
    treeFigures,
    cockpitTreeFigures,
    startedAt,
    turns,
    toolCalls,
  };
}
