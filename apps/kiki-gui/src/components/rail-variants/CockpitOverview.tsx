/**
 * 概览 in the cockpit mode: the execution of this whole session, read as one
 * collapsible time graph.
 *
 * The subject is the current session, not whichever agent happens to be
 * selected. Standard mode answers "what is this agent doing"; this answers
 * "how is the whole thing going, and where do I have to step in". So the top
 * of the panel is a graph of the main agent and its whole tree, folded at
 * first-level branches, all on one real time axis:
 *
 *   - A folded branch is one row: a neutral bracket for the period that branch
 *     has records for, and a segmented band whose segments are counts of
 *     agents in each state. The band is a composition, not progress — its
 *     denominator is the branch's own agent count.
 *   - Expanding a branch reveals that branch's agents as their own lanes,
 *     still on the same axis, still in the same place in the order.
 *   - An agent's bar encodes only when it existed. The mark at its end
 *     carries the state. Nothing here claims to be a history of what the agent
 *     was doing, because that history is not recorded.
 *
 * The two arcs below it keep the instrument value without inventing a capacity
 * that does not exist: context is one agent's real window, cache is the
 * session's aggregate, and both say which scope they cover. The third old arc
 * ("running / all agents") folded into the graph, where the denominator is
 * visible and the states are already separated.
 *
 * The lane chart used to be the only cockpit body; it now follows the graph as
 * the expanded form of the same reading.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { MAIN_AGENT_ID, type AgentForest, type ApprovalBlock, type Block, type QuestionBlock } from '@kiki/session-core/session';
import type { ListAgentTasksResponse, SessionAgentCounts, Task } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { useConnection, useOptionalControllerRegistry } from '../../state/connection';
import {
  age,
  axisTicks,
  compactionTimes,
  firstLevelBranchIds,
  sessionGraph,
  sessionWindow,
  useNow,
  type FleetState,
  type GraphRow,
  type GraphBranch,
  type GraphAgent,
  type StatusComposition,
} from './model';
import { backgroundRowsOf, projectSessionTasks, taskRowState, type SessionTaskCoverage, type SessionTaskProjection, type SessionTaskRead, type SessionTaskRow, type SessionTaskSummary } from './sessionTasks';
import { FOCUS_RING, StateMark, stateFillClass } from './shell';
import { Icon } from '../icons';
import type { OverviewFigures } from '../agent-panel/InspectorOverview';

/** The `useSyncExternalStore` subscribe contract: a function that unsubscribes. */
const noop = (): (() => void) => () => {};

/**
 * One page of the whole-tree read. The server pages on the task collection,
 * not on agents, so a page boundary says nothing about coverage: the coverage
 * block is cumulative and is taken from whichever page last spoke.
 */
const AGENT_TASK_PAGE_SIZE = 100;

/**
 * How many times a stale page token may send the read back to the first page.
 *
 * A live session can change its owner roster faster than a paged read walks
 * it, and every one of those changes invalidates the cursor. The cap is what
 * turns that from a request loop into a read that gives up and says so: past
 * it, the rows on screen are kept and the graph reports a partial read rather
 * than continuing to re-ask.
 */
const AGENT_TASK_MAX_RESTARTS = 2;

/**
 * A cursor the server no longer accepts. It answers this as a validation
 * failure with a message about restarting, so the code is matched rather than
 * assumed: a transport failure must not silently discard pages that are
 * still good.
 */
function isStalePageToken(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === 40001) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /restart pagination|page_token/i.test(message);
}

/**
 * One server page as the graph reads it.
 *
 * `owner_agent_id` is the agent whose scope holds the task, and `source` says
 * whether that scope is live or reconstructed from the session's own record:
 * a cold owner's row is real recorded work, and the graph shows it as such
 * rather than pretending nothing of it is running.
 *
 * Coverage is taken from the server's own accounting rather than derived from
 * the rows, because rows and owners are different things: an owner with no
 * background work is still an owner that was read.
 */
function agentTaskPageToSummary(page: ListAgentTasksResponse): SessionTaskSummary {
  const owners = page.owners;
  return {
    rows: page.items.map((item) => ({
      task: item,
      ownerAgentId: item.owner_agent_id,
      ownerUnknown: false,
      source: item.source,
    })),
    agentsReported: page.coverage.completed_owners + page.coverage.failed_owners,
    agentsTotal: page.coverage.total_owners,
    // The server's two reasons, kept apart because they are different problems:
    // an incomplete inventory means its own owner list is a subset, while
    // `partial` means owners it did list could not be read.
    inventoryIncomplete: page.coverage.inventory_complete === false,
    readFailed: page.partial === true || page.coverage.failed_owners > 0,
    hasMore: page.has_more,
    pendingOwners: page.coverage.pending_owners,
    failedOwners: page.coverage.failed_owners,
    ownersSettled: owners.filter((owner) => owner.state === 'complete').map((owner) => owner.owner_agent_id),
    ownersPersisted: owners.filter((owner) => owner.source === 'persisted').map((owner) => owner.owner_agent_id),
  };
}

/**
 * Fold a continuation page into what has arrived.
 *
 * The server samples each owner as pagination reaches it, so coverage only
 * ever grows here: a later page reporting fewer settled owners than an earlier
 * one does not un-read the ones already accounted for. A summary claims
 * completeness only when the server said the inventory is complete and there
 * is nothing left to fetch.
 */
function mergeAgentTaskSummaries(base: SessionTaskSummary, page: SessionTaskSummary): SessionTaskSummary {
  const seen = new Set(base.rows.map((row) => row.task.id));
  const ownersSettled = new Set([...(base.ownersSettled ?? []), ...(page.ownersSettled ?? [])]);
  const ownersPersisted = new Set([...(base.ownersPersisted ?? []), ...(page.ownersPersisted ?? [])]);
  return {
    rows: [...base.rows, ...page.rows.filter((row) => !seen.has(row.task.id))],
    agentsReported: Math.max(base.agentsReported, page.agentsReported),
    agentsTotal: Math.max(base.agentsTotal, page.agentsTotal),
    inventoryIncomplete: base.inventoryIncomplete || page.inventoryIncomplete,
    readFailed: base.readFailed || page.readFailed,
    hasMore: page.hasMore,
    pendingOwners: page.pendingOwners ?? 0,
    failedOwners: Math.max(base.failedOwners ?? 0, page.failedOwners ?? 0),
    ownersSettled: [...ownersSettled],
    ownersPersisted: [...ownersPersisted],
    lastError: undefined,
  };
}

/**
 * The whole-tree background read, paged.
 *
 * One request covers the first page; a session with more background work than
 * that reports `has_more` and a `next_page_token`, and the graph keeps asking
 * for the next page until the server says there is none. That continuation is
 * what makes a hundred-agent session readable on open: the first screen is
 * never the whole answer, and it never pretends to be.
 *
 * A failed page keeps whatever already arrived and says so, rather than
 * collapsing the list to nothing: the rows on screen are still true.
 *
 * A failure is recoverable by asking again. `retry` re-runs the whole walk
 * from the first page — the pages a previous attempt collected are dropped
 * rather than resumed, because a cursor from a failed walk describes a read
 * that never finished and resuming it would splice two different reads into
 * one summary. Everything else about the walk is unchanged, so an ordinary
 * multi-page session keeps paging itself without the reader touching anything.
 */
function useSessionTaskRead(sessionId: string, enabled: boolean): { readonly read: SessionTaskRead; readonly retry: () => void } {
  // `client` carries the whole-tree read; the raw `klient` is the transport
  // and has no session-scoped methods of its own.
  const { client } = useConnection();
  const [read, setRead] = useState<SessionTaskRead>({ status: 'pending' });
  // The cursor and the restart count live in refs, not state: pagination is
  // one sequential read, and driving it from state would re-enter the effect
  // on every page it fetches.
  const cursor = useRef<{ token: string | undefined; restarts: number }>({ token: undefined, restarts: 0 });
  // Which attempt this walk is. It is state because it is what re-runs the
  // effect, and it doubles as the guard that stops a superseded walk from
  // writing over the one that replaced it: an in-flight request resolves
  // against the attempt that asked for it, and a walk whose attempt is no
  // longer current returns without touching state.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const mine = attempt;
    cursor.current = { token: undefined, restarts: 0 };
    setRead({ status: 'pending' });
    // One walk of the pages, then stop. Each step awaits the previous, so a
    // hundred-page session is one request at a time rather than a burst.
    void (async () => {
      let summary: SessionTaskSummary | undefined;
      while (!cancelled && attempt === mine) {
        // A client without this read (an older server, or a surface mounted
        // without one) is a missing capability, not a crash: the graph falls
        // back to what the session already holds and says so.
        if (typeof client?.listAgentTasks !== 'function') {
          setRead({ status: 'failed' });
          return;
        }
        let page: ListAgentTasksResponse | { readonly error: unknown };
        try {
          page = await client.listAgentTasks(sessionId, {
            page_size: AGENT_TASK_PAGE_SIZE,
            ...(cursor.current.token === undefined ? {} : { page_token: cursor.current.token }),
          });
        } catch (error) {
          page = { error };
        }
        if (cancelled || attempt !== mine) return;
        if ('error' in page) {
          // A stale cursor is not a failed read: the server is saying the
          // tree moved under the token, so the pages collected so far describe
          // a moment that no longer exists. Restart from the first page, and
          // only as many times as the cap allows, so a session that churns
          // faster than it can be read settles instead of spinning.
          if (summary !== undefined && isStalePageToken(page.error) && cursor.current.restarts < AGENT_TASK_MAX_RESTARTS) {
            cursor.current = { token: undefined, restarts: cursor.current.restarts + 1 };
            summary = undefined;
            continue;
          }
          if (summary === undefined) {
            setRead({ status: 'failed', detail: page.error instanceof Error ? page.error.message : String(page.error) });
            return;
          }
          // Otherwise the rows already on screen stay and the reader is told.
          setRead({ status: 'ready', value: { ...summary, lastError: page.error instanceof Error ? page.error.message : String(page.error) } });
          return;
        }
        summary = summary === undefined ? agentTaskPageToSummary(page) : mergeAgentTaskSummaries(summary, agentTaskPageToSummary(page));
        cursor.current.token = page.next_page_token;
        setRead({ status: 'ready', value: summary });
        if (page.next_page_token === undefined) return;
      }
    })();
    return () => { cancelled = true; };
  }, [client, sessionId, enabled, attempt]);

  // Stable across renders: the graph passes it down, and a new identity each
  // render would re-render every background row on every tick.
  const retry = useCallback(() => { setAttempt((value) => value + 1); }, []);
  return { read, retry };
}

/**
 * The session's background work.
 *
 * The authority is the server's whole-tree summary: it knows about agents the
 * reader has never opened, which is the whole point of a session overview. The
 * controller's resident collections are a fallback for the window before that
 * summary arrives (or when the read fails), and the projection reports which
 * of the two it is showing — a resident-only view is never presented as the
 * tree, and a summary that arrives partial is never presented as complete.
 *
 * Deliberately not a subscription: `subscribeAgent` raises an agent's
 * transcript grade, so listening to all sixty-five agents would fetch the
 * whole session's message bodies to draw a few rows of task metadata.
 */
function useSessionTaskProjection(input: {
  readonly sessionId: string;
  readonly forest: AgentForest;
  readonly fallbackTasks: readonly Task[];
  /** The server's whole-tree summary, plus how that read went. */
  readonly summary: SessionTaskRead | undefined;
}): SessionTaskProjection {
  const { sessionId, forest, fallbackTasks, summary } = input;
  const registry = useOptionalControllerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noop() : registry.subscribe(listener)),
    [registry],
  );
  const generation = useSyncExternalStore(subscribeRegistry, () => registry?.snapshot() ?? 0, () => 0);
  const controller = useMemo(() => {
    if (registry === null) return undefined;
    for (const candidate of registry) if (candidate.sessionId === sessionId) return candidate;
    return undefined;
  }, [registry, generation, sessionId]);
  // Session-level only: the main agent's own publication already covers the
  // whole session and is what the rail is subscribed to anyway.
  const subscribe = useCallback(
    (listener: () => void) => controller === undefined ? noop() : controller.subscribe(listener),
    [controller],
  );
  const version = useSyncExternalStore(subscribe, () => controller?.getState().version ?? 0, () => 0);
  return useMemo(() => {
    const ownerStates: Record<string, readonly Task[] | undefined> = {};
    const coverage: Record<string, { returned: number; total: number; hasMore: boolean } | undefined> = {};
    for (const id of Object.keys(forest.byId)) {
      const state = controller === undefined
        ? undefined
        : id === MAIN_AGENT_ID ? controller.getState() : controller.getAgentState(id);
      if (state === undefined) continue;
      ownerStates[id] = state.tasks;
      const entity = state.globalCoverage?.tasks;
      if (entity !== undefined) coverage[id] = entity;
    }
    // The routed state is the one collection guaranteed to be in hand, so it
    // stands in for the root rather than leaving the session looking empty.
    if (ownerStates[MAIN_AGENT_ID] === undefined) ownerStates[MAIN_AGENT_ID] = fallbackTasks;
    // The session's own agent inventory, when the server has sent one. It is
    // counted over every agent the session dispatched, not over the roster
    // this client has loaded, so it is the denominator a cold or
    // partially-loaded session needs. Read off the routed state because that
    // is the one state guaranteed to be in hand.
    const agentTotal = controller?.getState().agentCounts?.total;
    return projectSessionTasks({ forest, summary: summary?.status === 'ready' ? summary.value : undefined, ownerStates, coverage, agentTotal });
    // `version` is the republish signal; the forest carries structure changes.
  }, [controller, forest, fallbackTasks, version, summary]);
}

function tokens(count: number | undefined): string {
  if (count === undefined) return '—';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
}

function money(usd: number | undefined): string {
  if (usd === undefined) return '—';
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** A 240° arc gauge. Past the warning point the arc turns amber, never the "needs you" accent. */
function Gauge({ ratio, label, value, sub, warn, scope }: { ratio: number | undefined; label: string; value: string; sub?: string; warn?: boolean; scope?: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const arc = c * (240 / 360);
  const clamped = Math.max(0, Math.min(1, ratio ?? 0));
  return (
    <div className="flex min-w-0 flex-col items-center" data-cockpit-gauge={label}>
      <svg viewBox="0 0 80 70" className="h-[62px] w-[72px]" role="img" aria-label={`${label} ${value}`}>
        <g transform="rotate(150 40 40)">
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${arc} ${c}`} className="stroke-ink/[0.08]" />
          {ratio !== undefined ? (
            <circle cx="40" cy="40" r={r} fill="none" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${arc * clamped} ${c}`} className={warn ? 'stroke-amber-rule' : 'stroke-selected-ink'} />
          ) : null}
        </g>
        <text x="40" y="47" textAnchor="middle" className="fill-ink font-mono text-[14px] font-medium">{value}</text>
      </svg>
      <span className="-mt-1 text-[11.5px] text-ink-faint">{label}</span>
      <span className="font-mono text-[10.5px] text-ink-faint tabular-nums">
        {scope !== undefined ? scope : sub}
      </span>
    </div>
  );
}

/**
 * Column widths. The graph is the first screen in a 480-760px rail, so the
 * axis gets the room: the label column is the smallest that still reads a
 * dispatched label, and the band column is the smallest that still shows a
 * proportion rather than a sliver.
 */
const LABEL_W = 132;
/**
 * The width one axis label needs before its neighbour would overlap it. A tick
 * label is about 44px at this size ("-15 分" in either locale), and each is
 * centered on its tick, so a gap under this reads as one run-together string.
 */
const TICK_LABEL_PX = 52;
/** A branch's status band and its period: the band is a count, not a position. */
const BAND_W = 88;
/**
 * The trailing column every row reserves to the right of the axis.
 *
 * Only a branch row draws its owner-arrow target there, and that arrow must
 * not steal width from the axis, so the arrow is taken out of flow and every
 * row — main, agent, task, branch — reserves the same TRAILING_W. The grid
 * overlay and the tick row reserve it too, which is what makes one timestamp
 * land on one vertical line across the whole graph.
 *
 * It is sized to the arrow's own box (icon plus its two paddings), so the value
 * has one source: the button below. The previous layout instead summed three
 * unrelated constants in the overlay only, which left the grid 86px narrower
 * than the bars it was supposed to align with.
 */
const TRAILING_W = 27;

/** Depth step; the cockpit rail is wider than the standard one. */
const INDENT = 9;

type Translate = ReturnType<typeof useI18n>['t'];

function stateWord(state: FleetState, needsUser: boolean, t: Translate): string {
  if (state === 'waiting') return t(needsUser ? 'rail.cockpit.state.needsYou' : 'rail.cockpit.state.suspended');
  switch (state) {
    case 'running': return t('rail.cockpit.state.running');
    case 'failed': return t('rail.cockpit.state.failed');
    case 'stopped': return t('rail.cockpit.state.stopped');
    case 'unknown': return t('rail.cockpit.state.unknown');
    default: return t('rail.cockpit.state.done');
  }
}

function clock(at: number, locale: 'en' | 'zh'): string {
  return new Date(at).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

function durationText(elapsed: number | undefined, locale: 'en' | 'zh', t: Translate): string {
  if (elapsed === undefined) return '—';
  return elapsed < 60_000 ? t('rail.cockpit.duration.underMinute') : age(elapsed, locale);
}

/**
 * A group's status composition as a proportional band. Segment width is the
 * share of agents in that state, and the row states the denominator, so it
 * cannot be read as a completion percentage.
 */
function StatusBand({ composition, total, label }: {
  composition: readonly StatusComposition[];
  total: number;
  label: string;
}) {
  return (
    <span
      data-cockpit-status-band
      className="flex h-[7px] w-full overflow-hidden rounded-[2px] bg-ink/[0.06]"
      role="img"
      aria-label={label}
    >
      {composition.map((entry, index) => (
        <span
          key={`${entry.state}:${entry.needsUser ? 'you' : 'other'}:${index}`}
          data-band-state={entry.state}
          data-band-needs-user={String(entry.needsUser)}
          className={`h-full ${stateFillClass(entry.state, entry.needsUser)}`}
          style={{ width: `${(entry.count / Math.max(1, total)) * 100}%` }}
        />
      ))}
    </span>
  );
}

/**
 * The status mix of the session, over every agent, main included.
 *
 * When the server has counted the session's agents, that count is what this
 * line describes: an old subagent that finished while this client was not
 * looking is still in the numbers, so the mix does not shrink as the reader
 * drills in. The graph's own lanes stay drawn from the records that are
 * loaded — this is the count behind them, not a claim that every agent is on
 * screen.
 *
 * The five buckets count subagents only and add up to `subagents`, while
 * `total` counts main as well. Main is in no bucket, so its own state is added
 * to the matching one here: the header would otherwise read "299 subagents /
 * 300" with a main agent that is visibly working in the lane right above it.
 * Main's state is the live one — this graph is looking at it — so it is
 * `running` while a turn is in flight and `done` when it is not.
 *
 * The two states the count cannot resolve are kept apart on purpose. `active`
 * is a live, non-terminal subagent from this generation, and a cold
 * non-terminal registration is `unknown` rather than running: the session
 * recorded it and went cold, which is not the same as work in flight. A
 * subagent waiting on the reader is live and non-terminal, so it is counted
 * `active` here; the finer "waiting on you" split stays in the loaded lanes,
 * where the actual waiting agent is drawn.
 */
function CompositionLegend({ composition, agentCount, sessionCounts, mainState }: {
  composition: readonly StatusComposition[];
  agentCount: number;
  sessionCounts?: SessionAgentCounts | undefined;
  /** The root lane's own state, which the five buckets do not cover. */
  mainState: FleetState;
}) {
  const { t } = useI18n();
  const total = sessionCounts?.total ?? agentCount;
  const parts = sessionCounts === undefined ? undefined : (() => {
    const counts = new Map<FleetState, number>([
      ['running', sessionCounts.active],
      ['done', sessionCounts.completed],
      ['failed', sessionCounts.failed],
      ['stopped', sessionCounts.cancelled],
      ['unknown', sessionCounts.unknown],
    ]);
    counts.set(mainState, (counts.get(mainState) ?? 0) + 1);
    return [...counts].filter(([, count]) => count > 0).map(([state, count]) => ({ state, count, needsUser: false }));
  })();
  if (agentCount === 0 && sessionCounts === undefined) return null;
  return (
    <div data-cockpit-composition className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint tabular-nums">
      {(parts ?? composition.map((entry) => ({ state: entry.state, count: entry.count, needsUser: entry.needsUser }))).map((entry, index) => (
        // Both attributes are always written, `false` included: whether a wait
        // is the reader's is the distinction the whole composition turns on,
        // so it must stay inspectable rather than vanishing when it is false.
        <span
          key={`${entry.state}:${entry.needsUser ? 'you' : 'other'}:${index}`}
          data-composition-state={entry.state}
          data-composition-needs-user={String(entry.needsUser)}
          // A wait on the reader and a failure carry ink; the rest is
          // inventory and stays quiet, so attention lands where it is owed.
          className={`inline-flex items-center gap-1.5 ${entry.needsUser || entry.state === 'failed' ? 'text-ink-soft' : ''}`}
        >
          <StateMark state={entry.state} className="h-2 w-2" />
          <span className="tabular-nums">{entry.count}</span>
          <span>{stateWord(entry.state, entry.needsUser, t)}</span>
        </span>
      ))}
      {(sessionCounts?.idle ?? 0) > 0 ? <span data-composition-state="idle" className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-ink-faint" />
        <span className="tabular-nums">{sessionCounts?.idle}</span>
        <span>{t('subagent.status.idle')}</span>
      </span> : null}
      <span data-composition-total className="font-mono text-ink-faint/80">/ {total}</span>
    </div>
  );
}

function AgentLane({ agent, pct, now, locale, t, selectedId, onSelect }: {
  agent: GraphAgent;
  pct: (at: number) => number;
  now: number;
  locale: 'en' | 'zh';
  t: Translate;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const begin = agent.startedAt;
  const end = agent.endedAt;
  const elapsed = begin === undefined ? undefined : Math.max(0, (end ?? now) - begin);
  // The reader's wait, when a request of theirs is what holds this agent.
  // It is never the agent's own age: a 29-minute run with a 3-minute wait
  // says 3 minutes.
  const waitAge = agent.waitingSince === undefined ? undefined : Math.max(0, now - agent.waitingSince);
  const title = begin === undefined
    ? `${agent.label} · ${t('rail.cockpit.lane.untimed')} · ${stateWord(agent.state, agent.needsUser, t)}`
    : `${agent.label}\n${clock(begin, locale)} → ${end === undefined ? t('rail.cockpit.now') : clock(end, locale)} · ${stateWord(agent.state, agent.needsUser, t)}`;
  const selected = selectedId === agent.id;
  return (
    <button
      type="button"
      data-cockpit-lane={agent.id}
      data-lane-state={agent.state}
      data-lane-needs-user={agent.needsUser || undefined}
      data-lane-selected={selected || undefined}
      data-rail-open-agent={agent.id}
      onClick={() => { onSelect(agent.id); }}
      title={title}
      className={`flex h-6 w-full items-center rounded text-left transition-colors hover:bg-ink/[0.04] pointer-coarse:h-8 ${FOCUS_RING} ${selected ? 'bg-selected-ink/[0.08]' : ''}`}
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-2" style={{ width: LABEL_W, paddingLeft: agent.depth * INDENT }}>
        <StateMark state={agent.state} className="h-1.5 w-1.5" />
        <span className={`truncate text-[12px] ${agent.needsUser ? 'font-medium text-accent-ink' : 'text-ink-soft'}`}>{agent.label}</span>
      </span>
      <span data-cockpit-axis="agent" className="relative h-full min-w-0 flex-1">
        {begin !== undefined ? (
          <span
            data-cockpit-span
            className={`absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full ${stateFillClass(agent.state, agent.needsUser)}`}
            style={{ left: `${pct(begin)}%`, width: `${Math.max(0.6, pct(end ?? now) - pct(begin))}%` }}
          />
        ) : end !== undefined ? (
          <span className={`absolute top-1/2 h-[7px] w-px -translate-y-1/2 ${agent.state === 'failed' ? 'bg-danger/70' : 'bg-ink-faint'}`} style={{ left: `${pct(end)}%` }} />
        ) : null}
      </span>
      <span className="shrink-0 pl-2 text-right font-mono text-[10.5px] leading-6 whitespace-nowrap text-ink-faint tabular-nums" style={{ width: BAND_W }}>
        {agent.needsUser && waitAge !== undefined ? durationText(waitAge, locale, t) : durationText(elapsed, locale, t)}
      </span>
      {/* The trailing reserve every row shares, so this row's axis ends on the
          same line as the grid above it and the ticks below it. */}
      <span aria-hidden style={{ width: TRAILING_W }} className="shrink-0" />
    </button>
  );
}

/**
 * One folded branch: a neutral coverage bracket for the period the branch has
 * records for, and its status composition. The bracket is not continuous work
 * and the band is not progress; both are labelled as what they are.
 */
function BranchRow({ branch, pct, now, locale, t, onExpand, onSelect }: {
  branch: GraphBranch;
  pct: (at: number) => number;
  now: number;
  locale: 'en' | 'zh';
  t: Translate;
  onExpand: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const { from, to } = branch;
  const left = from === undefined ? undefined : pct(from);
  const right = to === undefined ? undefined : pct(to);
  const width = left === undefined || right === undefined ? undefined : Math.max(1.5, right - left);
  const hasAttention = branch.composition.some((entry) => entry.needsUser || entry.state === 'failed');
  const label = branch.composition
    .map((entry) => `${stateWord(entry.state, entry.needsUser, t)} ${entry.count}`)
    .join(' · ');
  return (
    <div className="relative flex h-7 w-full items-center rounded transition-colors hover:bg-ink/[0.04]" data-cockpit-branch={branch.id} data-branch-size={branch.size}>
      <button
        type="button"
        data-cockpit-expand={branch.id}
        aria-expanded={false}
        aria-label={t('rail.cockpit.expandBranch', { label: branch.label, count: branch.size })}
        onClick={() => { onExpand(branch.id); }}
        title={t('rail.cockpit.expandBranch', { label: branch.label, count: branch.size })}
        className={`flex min-w-0 flex-1 items-center rounded text-left ${FOCUS_RING}`}
        style={{ paddingRight: TRAILING_W }}
      >
        {/* The gaps between the chevron, the label and the count live inside
            this fixed column. As a flex gap on the row they would push the
            axis right by 6px and leave the branch bracket 12px narrower than
            every other row's scale — the same defect CF-01 is about, in a
            smaller number. */}
        <span className="flex shrink-0 items-center gap-1.5 pr-2" style={{ width: LABEL_W }}>
          <span aria-hidden className="flex h-4 w-3.5 shrink-0 items-center justify-center text-ink-faint">
            <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className={`truncate text-[12px] ${hasAttention ? 'font-medium text-ink' : 'text-ink'}`}>{branch.label}</span>
          <span data-branch-size className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">{branch.size}</span>
        </span>
        {/* The bracket sits in the same axis column as the lanes below, so a
            branch's period reads against the same scale as the agents it
            contains. The band is its own column to the right: it is a count,
            not a position on the axis, and squeezing it onto the axis made it
            unreadable. */}
        <span data-cockpit-axis="branch" className="relative flex h-full min-w-0 flex-1 items-center">
          {left !== undefined ? (
            <span
              aria-hidden
              data-cockpit-branch-span
              className="absolute top-1/2 h-px -translate-y-1/2 bg-ink/30"
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span className="absolute -top-[2.5px] left-0 h-[6px] w-px bg-ink/35" />
              <span className="absolute -top-[2.5px] right-0 h-[6px] w-px bg-ink/35" />
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pl-2" style={{ width: BAND_W }}>
          <span data-cockpit-status-band className="min-w-0 flex-1">
            <StatusBand composition={branch.composition} total={branch.size} label={label} />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">
            {durationText(from === undefined ? undefined : (to ?? now) - from, locale, t)}
          </span>
        </span>
      </button>
      {/* Opening the owner agent is a separate, explicit target rather than the
          row itself: one click must not mean select, expand and leave at once.
          Its label rides the band, which already states the same mix. It sits
          out of flow over the trailing column every row reserves, so taking it
          from the row never narrows the axis underneath it. */}
      <button
        type="button"
        data-cockpit-open-branch={branch.id}
        data-rail-open-agent={branch.id}
        onClick={() => { onSelect(branch.id); }}
        title={t('rail.cockpit.openBranch', { label: branch.label })}
        aria-label={t('rail.cockpit.openBranch', { label: branch.label })}
        className={`absolute right-0 top-0 flex h-7 items-center rounded-md px-1.5 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink ${FOCUS_RING}`}
      >
        <Icon name="arrowRight" size={12} />
      </button>
    </div>
  );
}

/**
 * One background task as a lane under the tree, with the agent that owns it.
 * The owner is on the row because "which agent's background work is this" is
 * the question the lane cannot answer by itself.
 *
 * A persisted owner is not running now: the session recorded a run in progress
 * and then went cold. Its bar is drawn hollow rather than filled, and the row
 * says which kind of owner it is — the distinction is the mark itself, not a
 * footnote under the graph.
 */
function TaskLane({ row, pct, now, locale, t, ownerName }: {
  row: SessionTaskRow;
  pct: (at: number) => number;
  now: number;
  locale: 'en' | 'zh';
  t: Translate;
  /** The owning agent's dispatched label, when the tree knows one. */
  ownerName?: string | undefined;
}) {
  const state = taskRowState(row);
  const begin = row.startedAt;
  const end = row.endedAt;
  const elapsed = begin === undefined ? undefined : Math.max(0, (end ?? now) - begin);
  const cold = row.source === 'persisted';
  // The dispatched label is what the reader recognizes the agent by; the raw id
  // is a fallback for an owner the tree has no node for (and is the whole
  // answer for an unattributed row, where naming a label would invent one).
  const ownerId = row.ownerAgentId;
  const ownerLabel = row.ownerUnknown === true || ownerName === undefined || ownerName === ''
    ? ownerId
    : ownerId === MAIN_AGENT_ID ? t('rail.ownerMain') : ownerName;
  const title = [
    row.task.description,
    `${ownerLabel} · ${cold ? t('rail.cockpit.taskColdOwner') : t('rail.cockpit.taskLiveOwner')}`,
    `${stateWord(state, false, t)} · ${durationText(elapsed, locale, t)}`,
  ].join('\n');
  return (
    <div
      data-cockpit-task={row.task.id}
      data-task-state={state}
      data-task-owner={row.ownerAgentId}
      data-task-source={row.source ?? 'unknown'}
      title={title}
      className="flex h-6 w-full items-center rounded text-left"
    >
      {/* The owner is on the row because the lane cannot answer "whose work
          is this" on its own, but it yields width to the description: a task
          called "v…" and an owner id is not a thing anyone can act on. The
          description takes what it needs, and the owner keeps only what is
          left, so a long owner id shortens before the work does. */}
      {/* A task row carries a description where an agent lane carries only a
          name, so the description gets the whole label column rather than
          sharing it with an id that would squeeze both into "v…". */}
      <span className="flex shrink-0 items-center gap-1.5 overflow-hidden pr-2" style={{ width: LABEL_W, paddingLeft: INDENT }}>
        {/* A cold owner is never running now: the session recorded a run and
            then went cold, so a filled "running" dot would claim live work this
            session is not doing. It borrows the existing recorded-state ring
            rather than a new shape, and the row's tooltip names the state in
            words — the mark says "on record", not "not done". */}
        <StateMark state={cold && state === 'running' ? 'unknown' : state} className="h-1.5 w-1.5" />
        <span className="min-w-0 truncate text-[12px] text-ink-soft">{row.task.description}</span>
      </span>
      <span data-cockpit-axis="task" className="relative h-full min-w-0 flex-1">
        {begin !== undefined ? (
          <span
            aria-hidden
            data-cockpit-task-span
            className={`absolute top-1/2 h-[4px] -translate-y-1/2 rounded-full ${cold ? 'border border-dashed border-ink-faint/70' : stateFillClass(state, false)}`}
            style={{ left: `${pct(begin)}%`, width: `${Math.max(0.6, pct(end ?? now) - pct(begin))}%` }}
          />
        ) : null}
      </span>
      <span className="flex shrink-0 items-baseline justify-end gap-1.5 pl-2" style={{ width: BAND_W }}>
        {/* The owner rides the duration, not the label: the label column is
            too narrow to hold a description and an agent id, and a row that
            reads "v… agent-tests-w1" identifies neither. Here both stay whole,
            and a cold owner is named rather than left to a tooltip. */}
        <span data-task-owner-label className="min-w-0 truncate text-[10.5px] text-ink-faint/80">{ownerLabel}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">{durationText(elapsed, locale, t)}</span>
      </span>
      <span aria-hidden style={{ width: TRAILING_W }} className="shrink-0" />
    </div>
  );
}

/**
 * What the background rows are, and what they are not.
 *
 * The ways this can be incomplete are different problems, so they read
 * differently: a read still running is not a failure, a failed read is not an
 * empty session, an owner list the server could not finish enumerating is not
 * a short session, and a page left unread is not work that does not exist.
 * Collapsing them into "some agents" would let a reader conclude a session is
 * idle when the truth is that nobody has looked yet.
 *
 * A failure offers one way out — the same read again. It is the only recovery
 * the read has, it keeps the pages already collected, and it is a button
 * rather than a paragraph asking the reader to reopen the rail.
 */
function BackgroundCoverageNote({ state, coverage, summary, onRetry, t }: {
  state: SessionTaskRead['status'];
  coverage: SessionTaskCoverage;
  summary: SessionTaskSummary | undefined;
  onRetry: (() => void) | undefined;
  t: Translate;
}) {
  const retry = (label: string) => onRetry === undefined ? null : (
    <button
      type="button"
      data-cockpit-task-retry
      onClick={onRetry}
      className={`shrink-0 rounded text-ink-soft underline decoration-ink-faint underline-offset-2 transition-colors hover:text-ink ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
  if (state === 'pending') {
    return (
      <p data-cockpit-task-read="pending" role="status" className="text-[11px] leading-4 text-ink-faint">
        {t('rail.cockpit.taskReading')}
      </p>
    );
  }
  if (state === 'failed') {
    return (
      <p data-cockpit-task-read="failed" role="status" className="flex items-baseline gap-1.5 text-[11px] leading-4 text-amber-ink">
        <span className="min-w-0">{t('rail.cockpit.taskReadFailed')}</span>
        {retry(t('rail.cockpit.taskRetry'))}
      </p>
    );
  }
  if (summary?.lastError !== undefined) {
    return (
      <p data-cockpit-task-read="partial" role="status" className="flex items-baseline gap-1.5 text-[11px] leading-4 text-amber-ink">
        <span className="min-w-0">{t('rail.cockpit.taskReadPartial')}</span>
        {retry(t('rail.cockpit.taskRetry'))}
      </p>
    );
  }
  if (summary?.readFailed === true) {
    // The server read some owners and failed others. That is missing work, and
    // it says so in its own terms: the count is of agents whose background
    // work could not be read, not of agents with no background work.
    return (
      <p data-cockpit-task-read="read-failed" role="status" className="flex items-baseline gap-1.5 text-[11px] leading-4 text-amber-ink">
        <span className="min-w-0">{t('rail.cockpit.taskOwnersFailed', { count: summary.failedOwners ?? 0 })}</span>
        {retry(t('rail.cockpit.taskRetry'))}
      </p>
    );
  }
  if (summary?.inventoryIncomplete === true) {
    // The server could not enumerate every owner it knows about, so the
    // denominator below is only the ones it managed to list. It is not a cap on
    // how much one read covers — the read has no such limit — and saying so
    // would invent one.
    return (
      <p data-cockpit-task-read="inventory" role="status" className="flex items-baseline gap-1.5 text-[11px] leading-4 text-ink-faint">
        <span className="min-w-0">{t('rail.cockpit.taskInventoryIncomplete')}</span>
        {retry(t('rail.cockpit.taskRetry'))}
      </p>
    );
  }
  if (!coverage.totalKnown) {
    // The server has not said how many owners the session has, and the agents
    // this client has loaded are not that number — a session that has not
    // loaded its older agents has a shorter tree than it had. So the graph says
    // the owner list is not established instead of printing a fraction of a
    // count it cannot stand behind.
    return (
      <p data-cockpit-task-read="owners-unknown" role="status" className="text-[11px] leading-4 text-ink-faint">
        {t('rail.cockpit.taskOwnersUnknown')}
      </p>
    );
  }
  if (coverage.partial || coverage.windowed || (summary?.pendingOwners ?? 0) > 0) {
    // The server's own owner count is the denominator, and it is the only
    // honest one: the local tree is what this client can see, not what the
    // session has.
    return (
      <p data-cockpit-task-coverage className="text-[11px] leading-4 text-ink-faint">
        {t('rail.cockpit.taskCoverage', { covered: coverage.covered, total: coverage.total ?? 0 })}
      </p>
    );
  }
  if ((summary?.failedOwners ?? 0) > 0) {
    return (
      <p data-cockpit-task-coverage className="text-[11px] leading-4 text-ink-faint">
        {t('rail.cockpit.taskOwnersFailed', { count: summary?.failedOwners ?? 0 })}
      </p>
    );
  }
  return null;
}

/**
 * The session execution graph: the main agent's current turn, then the tree
 * folded at its first-level branches, on one axis. Expanding a branch reveals
 * that branch's agents in place; it never replaces the graph with another
 * page, and it never rescopes it to what one branch contains.
 */
function ExecutionGraph({ rows, agentCount, sessionCounts, branchTotal, composition, from, now, compactions, selectedId, locale, t, onSelect, onExpand, onCollapseAll, collapseAllLabel, backgroundRows, backgroundCoverage, backgroundRead, backgroundReadState, ownerNameOf, onRetryTaskRead }: {
  rows: readonly GraphRow[];
  agentCount: number;
  /**
   * The session's agent inventory as the server counts it, over every agent it
   * dispatched. Undefined against an older server, where the legend falls back
   * to the loaded roster and says nothing it cannot support.
   */
  sessionCounts?: SessionAgentCounts | undefined;
  /**
   * How many first-level branches the graph is drawn from, counted from the
   * forest rather than from the rows on screen: deriving it from the rows made
   * the header count *drop* when a branch was expanded, because expanding
   * replaces one branch row with that branch's agents.
   *
   * It describes this graph, not the session's whole tree — a session whose
   * older agents are not loaded has fewer branches here than it had branches,
   * and loading them is not this surface's job. So the label says "in this
   * graph" and the session-wide numbers are the ones carried by
   * `sessionCounts` above.
   */
  branchTotal: number;
  composition: readonly StatusComposition[];
  from: number | undefined;
  now: number;
  compactions: readonly number[];
  selectedId: string | undefined;
  locale: 'en' | 'zh';
  t: Translate;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  onCollapseAll?: (() => void) | undefined;
  collapseAllLabel?: string | undefined;
  backgroundRows: readonly SessionTaskRow[];
  backgroundCoverage: SessionTaskCoverage;
  backgroundRead: SessionTaskSummary | undefined;
  backgroundReadState: SessionTaskRead['status'];
  /** The tree's own label for an agent, so a task row can name its owner. */
  ownerNameOf: (agentId: string) => string | undefined;
  /** Ask for the background read again, after it failed. */
  onRetryTaskRead: () => void;
}) {
  const win = useMemo(() => sessionWindow(from, now), [from, now]);
  const span = Math.max(1, win.end - win.start);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - win.start) / span) * 100));
  // The axis column narrows with the rail, so tick spacing is measured in
  // real pixels rather than percentages: a 13% gap is roomy at 1440 and an
  // overlap at 480.
  const axisRef = useRef<HTMLSpanElement>(null);
  const [axisWidth, setAxisWidth] = useState(0);
  useEffect(() => {
    const node = axisRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') {
      setAxisWidth(node?.clientWidth ?? 0);
      return;
    }
    const measure = () => setAxisWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const main = rows.find((row): row is Extract<GraphRow, { kind: 'main' }> => row.kind === 'main');
  const hiddenAgents = agentCount - 1 - rows.filter((row) => row.kind === 'agent').length;
  return (
    <section data-cockpit-graph role="group" aria-label={t('rail.cockpit.graph.aria')} className="space-y-1.5">
      <header className="flex items-baseline gap-2">
        <h4 className="text-[11.5px] font-medium tracking-[0.02em] text-ink-soft">{t('rail.cockpit.graph.title')}</h4>
        <span className="ml-auto font-mono text-[10.5px] text-ink-faint tabular-nums">
          {t('rail.cockpit.graph.range', { count: branchTotal })}
        </span>
        {onCollapseAll !== undefined ? (
          <button
            type="button"
            data-cockpit-collapse-all
            onClick={onCollapseAll}
            title={collapseAllLabel}
            className={`shrink-0 rounded-md px-1 text-[11.5px] text-ink-faint transition-colors hover:text-ink ${FOCUS_RING}`}
          >
            {collapseAllLabel}
          </button>
        ) : null}
      </header>
      <CompositionLegend composition={composition} agentCount={agentCount} sessionCounts={sessionCounts} mainState={main?.state ?? 'done'} />
      <div className="relative">
        {/* The grid's own axis column, expressed with the same two constants
            every row uses, so a tick line falls on the same x as the bars it
            measures. `right` is the band plus the shared trailing reserve. */}
        <span data-cockpit-axis="grid" aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, right: BAND_W + TRAILING_W }}>
          {win.ticks.map((tick) => <span key={tick} className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: `${pct(tick)}%` }} />)}
          {compactions.filter((at) => at >= win.start && at <= win.end).map((at) => (
            <span key={at} data-cockpit-compaction className="absolute inset-y-0 border-l border-dashed border-section-ink/50" style={{ left: `${pct(at)}%` }} />
          ))}
        </span>
        <div className="relative">
          {main !== undefined ? (
            <button
              type="button"
              data-cockpit-main={main.id}
              data-lane-state={main.state}
              data-lane-selected={selectedId === main.id || undefined}
              data-rail-open-agent={main.id}
              onClick={() => { onSelect(main.id); }}
              title={main.startedAt === undefined ? main.label : `${main.label}\n${clock(main.startedAt, locale)} → ${t('rail.cockpit.now')}`}
              className={`flex h-7 w-full items-center rounded text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING} ${selectedId === main.id ? 'bg-selected-ink/[0.08]' : ''}`}
            >
              <span className="flex shrink-0 items-center gap-1.5 pr-2" style={{ width: LABEL_W }}>
                <StateMark state={main.state} className="h-1.5 w-1.5" />
                <span className="truncate text-[12px] font-medium text-ink">{main.label}</span>
              </span>
              <span data-cockpit-axis="main" className="relative h-full min-w-0 flex-1">
                {main.startedAt !== undefined ? (
                  <span className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-selected-ink/50" style={{ left: `${pct(main.startedAt)}%`, width: `${Math.max(0.6, 100 - pct(main.startedAt))}%` }} />
                ) : null}
              </span>
              <span className="shrink-0 pl-2 text-right font-mono text-[10.5px] leading-6 text-ink-faint tabular-nums" style={{ width: BAND_W }}>
                {durationText(main.startedAt === undefined ? undefined : now - main.startedAt, locale, t)}
              </span>
              <span aria-hidden style={{ width: TRAILING_W }} className="shrink-0" />
            </button>
          ) : null}
          {rows.filter((row) => row.kind !== 'main').map((row) => row.kind === 'branch'
            ? <BranchRow key={row.id} branch={row} pct={pct} now={now} locale={locale} t={t} onExpand={onExpand} onSelect={onSelect} />
            : <AgentLane key={row.id} agent={row} pct={pct} now={now} locale={locale} t={t} selectedId={selectedId} onSelect={onSelect} />)}
          {backgroundRows.map((row) => (
            <TaskLane key={`task:${row.task.id}`} row={row} pct={pct} now={now} locale={locale} t={t} ownerName={ownerNameOf(row.ownerAgentId)} />
          ))}
        </div>
      </div>
      {hiddenAgents > 0 ? (
        <p data-cockpit-folded-note className="text-[11px] leading-4 text-ink-faint">
          {t('rail.cockpit.graph.folded', { count: hiddenAgents })}
        </p>
      ) : null}
      <BackgroundCoverageNote
        state={backgroundReadState}
        coverage={backgroundCoverage}
        summary={backgroundRead}
        onRetry={onRetryTaskRead}
        t={t}
      />
      <div className="relative flex h-4 items-end pt-1" aria-hidden>
        <span className="shrink-0" style={{ width: LABEL_W }} />
        <span data-cockpit-axis="tick" ref={axisRef} className="relative h-full flex-1">
          {axisTicks(win.ticks, pct, axisWidth, TICK_LABEL_PX).map(({ tick, last }) => (
            <span
              key={tick}
              data-cockpit-tick
              className={`absolute bottom-0 font-mono text-[10px] whitespace-nowrap tabular-nums ${last ? '-translate-x-full text-ink-soft' : tick === win.ticks[0] ? '' : '-translate-x-1/2'} text-ink-faint`}
              style={{ left: `${pct(tick)}%` }}
            >
              {last ? t('rail.cockpit.now') : `-${age(now - tick, locale)}`}
            </span>
          ))}
        </span>
        <span aria-hidden className="shrink-0" style={{ width: BAND_W + TRAILING_W }} />
      </div>
    </section>
  );
}

export const CockpitOverview = memo(function CockpitOverview({ sessionId, agentId, forest, blocks, contextUsed, contextLimit, compactPoint, figures, treeFigures, turns, toolCalls, onOpenAgent, onToggleBranch, expandedBranches, sessionPending, mainBusy, turnStartedAt, mainLabel, sessionTasks, agentCounts }: {
  sessionId: string;
  agentId: string;
  forest: AgentForest;
  blocks: readonly Block[];
  contextUsed?: number;
  contextLimit?: number;
  compactPoint?: number;
  figures: OverviewFigures;
  treeFigures?: OverviewFigures;
  turns?: number;
  toolCalls?: number;
  onOpenAgent?: (agentId: string) => void;
  /** Branches the reader opened. Owned by the rail, so it survives a mode switch. */
  expandedBranches: ReadonlySet<string>;
  onToggleBranch: (branchId: string) => void;
  /** Every pending approval / question in the session, any depth. */
  sessionPending: readonly (ApprovalBlock | QuestionBlock)[];
  /** The main agent's own turn state, for the root lane. */
  mainBusy: boolean;
  turnStartedAt: number | undefined;
  mainLabel: string;
  /** The routed state's own task collection; the root's fallback. */
  sessionTasks: readonly Task[];
  /**
   * The session's agent inventory, counted by the server over every agent it
   * dispatched rather than over the roster this client has loaded. Without it
   * the status mix can only describe the loaded agents, so an old subagent that
   * finished while nobody was looking drops out of the numbers.
   */
  agentCounts?: SessionAgentCounts | undefined;
}) {
  const { t, locale } = useI18n();
  const now = useNow();
  const compactions = useMemo(() => compactionTimes(blocks), [blocks]);
  const graph = useMemo(
    () => sessionGraph({ forest, pending: sessionPending, mainState: { busy: mainBusy, turnStartedAt }, expanded: expandedBranches, mainLabel }),
    [forest, sessionPending, mainBusy, turnStartedAt, expandedBranches, mainLabel],
  );
  // The context arc is one agent's real window; the default subject is main.
  const ctx = contextUsed !== undefined && contextLimit !== undefined && contextLimit > 0 ? contextUsed / contextLimit : undefined;
  const warnAt = compactPoint !== undefined && contextLimit !== undefined && contextLimit > 0 ? (compactPoint / contextLimit) * 0.8 : 0.8;
  const cache = treeFigures?.cacheRate ?? figures.cacheRate;
  const cost = treeFigures?.costUsd ?? figures.costUsd;
  const select = (id: string) => { onOpenAgent?.(id); };
  const toggle = (id: string) => { onToggleBranch(id); };
  const expandedList = [...expandedBranches];
  const { read: taskRead, retry: retryTaskRead } = useSessionTaskRead(sessionId, true);
  const tasks = useSessionTaskProjection({ sessionId, forest, fallbackTasks: sessionTasks, summary: taskRead });
  const backgroundRows = useMemo(() => backgroundRowsOf(tasks.rows), [tasks.rows]);
  // Counted from the forest, so opening a branch cannot change it.
  const branchTotal = useMemo(() => firstLevelBranchIds(forest).length, [forest]);
  // A task row names its owner with the tree's own label. The lookup is
  // memoized on the forest so the rows are not re-rendered on every tick.
  const ownerNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const node of Object.values(forest.byId)) byId.set(node.agentId, node.label);
    return (agentId: string) => byId.get(agentId);
  }, [forest]);
  return (
    <div data-cockpit-overview data-cockpit-subject="session" data-cockpit-agent={agentId} className="space-y-3">
      <ExecutionGraph
        rows={graph.rows}
        agentCount={graph.agentCount}
        sessionCounts={agentCounts}
        branchTotal={branchTotal}
        composition={graph.composition}
        from={graph.from}
        now={now}
        compactions={compactions}
        selectedId={agentId}
        locale={locale}
        t={t}
        onSelect={select}
        onExpand={toggle}
        onCollapseAll={expandedList.length === 0 ? undefined : () => { for (const id of expandedList) toggle(id); }}
        collapseAllLabel={t('rail.cockpit.collapseAll', { count: expandedList.length })}
        backgroundRows={backgroundRows}
        backgroundCoverage={tasks.coverage}
        backgroundRead={taskRead.status === 'ready' ? taskRead.value : undefined}
        backgroundReadState={taskRead.status}
        ownerNameOf={ownerNames}
        onRetryTaskRead={retryTaskRead}
      />
      <div className="grid grid-cols-2 gap-2">
        <Gauge
          ratio={ctx}
          warn={ctx !== undefined && ctx >= warnAt}
          label={t('inspector.context')}
          value={ctx === undefined ? '—' : `${Math.round(ctx * 100)}%`}
          sub={`${tokens(contextUsed)}/${tokens(contextLimit)}`}
          scope={t('rail.cockpit.scope.agent')}
        />
        <Gauge
          ratio={cache === undefined ? undefined : cache / 100}
          label={t('rail.cockpit.cacheHit')}
          value={cache === undefined ? '—' : `${Math.round(cache)}%`}
          scope={t(treeFigures?.incomplete === true ? 'rail.cockpit.scope.treePartial' : 'rail.cockpit.scope.tree')}
        />
      </div>
      <dl className="grid grid-cols-2 divide-x divide-hairline text-center">
        <div data-cockpit-fact="cost">
          <dt className="text-[11.5px] text-ink-faint">{t('rail.cockpit.scope.tree')} · {t('inspector.cost')}</dt>
          <dd className="font-mono text-[14px] text-ink tabular-nums">{money(cost)}</dd>
        </div>
        <div data-cockpit-fact="turns">
          <dt className="text-[11.5px] text-ink-faint">
            {turns !== undefined ? t('rail.turns') : t('rail.cockpit.toolCalls')}
          </dt>
          <dd className="font-mono text-[14px] text-ink tabular-nums">
            {turns !== undefined ? String(turns) : toolCalls === undefined ? '—' : String(toolCalls)}
          </dd>
        </div>
      </dl>
      {treeFigures?.incomplete === true ? (
        <p data-cockpit-tree-partial className="-mt-1 text-[11.5px] leading-4 text-amber-ink">{t('rail.cockpit.treePartial')}</p>
      ) : null}
    </div>
  );
});
