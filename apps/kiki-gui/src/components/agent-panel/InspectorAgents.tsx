/**
 * Who the inspector describes, and how to reach the others.
 *
 * RailCrumbs is the head: "Main agent" on main, "Main agent / Reviewer" on a
 * subagent (each step up is a button). AgentRoster lists the team as two
 * lines of content (name and state, then what it is doing or what it found);
 * clicking a row opens that agent's preview, exactly as clicking its card in
 * the timeline does. Metadata (model, effort, tool count) stays in the tooltip.
 *
 * Both share the rail's one left edge: a fixed mark column (RAIL_MARK) then
 * text, so status marks and labels line up down the whole panel.
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { I18nKey } from '@kiki/session-core/i18n';
import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import type { LifeState } from '../../lib/motion';
import { DisclosureChevron, Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { buildRoster, ROSTER_BUCKETS, type RosterAgentRow, type RosterBucket, type RosterRow } from './agentRoster';
import { plainFailure } from './failureText';

/** Fixed status-mark column: every marked row puts its text at the same x. */
export const RAIL_MARK = 'flex h-5 w-3.5 shrink-0 items-center justify-start';

/** LifeMark state for an agent status (shared by team rows and Now). */
export function agentLife(status: string): LifeState {
  switch (status) {
    case 'running':
    case 'background':
      return 'working';
    case 'suspended':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/** Status as a plain word, the way the timeline's subagent rows say it.
 * Only waiting on the user is coloured; a failure reads like any other end. */
export function agentStatusTone(status: string): string {
  switch (status) {
    case 'suspended':
      return 'text-amber-ink';
    case 'failed':
      return 'text-ink-soft';
    case 'running':
    case 'background':
    case 'completed':
      return 'text-ink-faint';
    default:
      return 'text-ink-faint';
  }
}

/** Every agent except main, depth-first in dispatch order. */
export function teamRows(forest: AgentForest): { node: AgentTreeNode; depth: number }[] {
  const rows: { node: AgentTreeNode; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (node: AgentTreeNode, depth: number) => {
    if (seen.has(node.agentId)) return;
    seen.add(node.agentId);
    if (node.agentId !== MAIN_AGENT_ID) rows.push({ node, depth });
    const nextDepth = node.agentId === MAIN_AGENT_ID ? depth : depth + 1;
    for (const id of node.childIds) {
      const child = forest.byId[id];
      if (child !== undefined) visit(child, nextDepth);
    }
  };
  for (const root of forest.roots) visit(root, 0);
  return rows;
}

/** The chain from main down to `agentId` (main first, the agent last). */
function ancestry(forest: AgentForest, agentId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = agentId;
  while (current !== undefined && current !== MAIN_AGENT_ID && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = forest.byId[current]?.parentAgentId;
  }
  return [MAIN_AGENT_ID, ...chain];
}

const CRUMB = 'flex h-7 min-w-0 items-center rounded-md px-1.5 -mx-1.5 text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent';

/**
 * Inspector head: the page owner as a breadcrumb (serif for the current
 * name, like every sheet title), steps up as quiet buttons, close at the end.
 */
export const RailCrumbs = memo(function RailCrumbs({
  forest,
  focusedAgentId,
  onSelect,
  close,
}: {
  forest: AgentForest;
  focusedAgentId: string;
  onSelect: (agentId: string) => void;
  close: ReactNode;
}) {
  const { t } = useI18n();
  const chain = ancestry(forest, focusedAgentId);
  const label = (id: string) => (id === MAIN_AGENT_ID ? t('rail.ownerMain') : (forest.byId[id]?.label ?? id));
  // A deep chain keeps main and the direct parent; the middle folds to "…".
  const steps = chain.slice(0, -1);
  const shown = steps.length > 2 ? [steps[0]!, undefined, steps[steps.length - 1]!] : steps;
  const current = chain[chain.length - 1]!;
  return (
    <div
      data-rail-owner
      data-rail-owner-name={current === MAIN_AGENT_ID ? undefined : label(current)}
      className="sticky top-0 z-10 -mx-4 flex h-12 items-center gap-2 bg-panel px-4"
    >
      <nav aria-label={t('inspector.tabsAria')} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
        {shown.map((id, index) => (
          <span key={id ?? `gap-${index}`} className="flex min-w-0 shrink items-center gap-1.5">
            {id === undefined ? (
              <span aria-hidden className="text-ink-faint">…</span>
            ) : (
              <button
                type="button"
                data-agent-id={id}
                data-inspect-main={id === MAIN_AGENT_ID ? '' : undefined}
                data-inspect-parent={id !== MAIN_AGENT_ID ? '' : undefined}
                title={id === MAIN_AGENT_ID ? t('inspector.backToMainAria') : t('subagent.openAgent', { name: label(id) })}
                onClick={() => { onSelect(id); }}
                className={`${CRUMB} ${id === MAIN_AGENT_ID ? 'shrink-0' : 'max-w-[7.5rem]'}`}
              >
                <span className="truncate">{label(id)}</span>
              </button>
            )}
            <span aria-hidden className="shrink-0 text-hairline-strong">/</span>
          </span>
        ))}
        <h2 aria-current="page" className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-ink" title={label(current)}>
          <span className="sr-only">{t('inspector.viewing')}: </span>
          {label(current)}
        </h2>
      </nav>
      {close}
    </div>
  );
});

const STATUS_KEY = (status: string): I18nKey => `subagent.status.${status}` as I18nKey;

const BUCKET_LIFE: Record<RosterBucket, LifeState> = { waiting: 'waiting', running: 'working', ended: 'done' };
/** Running is the one live colour in the list; waiting keeps the accent. */
const BUCKET_TONE: Partial<Record<RosterBucket, string>> = { running: 'bg-success', waiting: 'bg-attention' };
/** A failed agent is marked by its shape, never by red. */
const FAILED_TONE = 'bg-ink-faint';

/** Past this many agents the roster offers a search field. */
const SEARCH_AT = 12;
/** Past this many visible rows the list windows inside its own scroller. */
const WINDOW_AT = 40;
const ROW_HEIGHT = 46;
const GROUP_HEIGHT = 32;
/** Indent per tree level; guides sit on the parent's mark column. */
const INDENT = 12;

function shortModel(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined;
  return model.split('/').pop();
}

/** "3m", "1h 4m": elapsed for a running row, coarse on purpose. */
function coarseElapsed(since: string | undefined, now: number): string | undefined {
  if (since === undefined) return undefined;
  const start = Date.parse(since);
  if (!Number.isFinite(start) || now - start < 60_000) return undefined;
  const minutes = Math.floor((now - start) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The summary line: one toggle per non-empty status bucket. Pressing one
 * filters the list to it; pressing it again (or Show all) clears.
 */
function RosterSummary({
  counts,
  filter,
  onFilter,
}: {
  counts: Readonly<Record<RosterBucket, number>>;
  filter: RosterBucket | 'all';
  onFilter: (next: RosterBucket | 'all') => void;
}) {
  const { t } = useI18n();
  const shown = ROSTER_BUCKETS.filter((bucket) => counts[bucket] > 0);
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={t('inspector.filterAria')} data-roster-summary className="flex flex-wrap items-center gap-1">
      {shown.map((bucket) => {
        const pressed = filter === bucket;
        return (
          <button
            key={bucket}
            type="button"
            aria-pressed={pressed}
            data-roster-filter={bucket}
            data-roster-count={counts[bucket]}
            title={pressed ? t('inspector.filterClear') : undefined}
            onClick={() => { onFilter(pressed ? 'all' : bucket); }}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] whitespace-nowrap tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent pointer-coarse:h-9 ${
              pressed
                ? 'bg-ink text-panel'
                : bucket === 'waiting'
                  ? 'bg-attention-soft font-medium text-attention hover:bg-attention-soft/70'
                  : 'bg-ink/[0.05] text-ink-soft hover:bg-ink/[0.08] hover:text-ink'
            }`}
          >
            <LifeMark markId={`roster-filter:${bucket}`} life={BUCKET_LIFE[bucket]} tone={pressed ? (bucket === 'ended' ? 'border-panel' : 'bg-panel') : BUCKET_TONE[bucket]} still className="h-[6px] w-[6px]" />
            {t(`inspector.filter.${bucket}`, { count: counts[bucket] })}
            {/* The pressed chip clears itself; the mark says so. */}
            {pressed ? <Icon name="close" size={12} className="-mr-1 opacity-70" /> : null}
          </button>
        );
      })}
    </div>
  );
}

const ROW_BUTTON =
  'agent-tree-row row-interactive -ml-1 flex min-w-0 flex-1 items-start py-1.5 pr-2 pl-1 text-left';

/**
 * One agent: a fold toggle (only when it has agents under it), the status
 * mark, then two lines — name and state, then what it is doing, found or hit.
 * Depth is a 12px step with a hairline guide per level, so four levels still
 * leave most of a 320px rail to the text.
 */
const RosterAgent = memo(function RosterAgent({
  row,
  now,
  onSelect,
  onToggle,
}: {
  row: RosterAgentRow;
  now: number;
  onSelect: (agentId: string) => void;
  onToggle: (agentId: string) => void;
}) {
  const { t, tp } = useI18n();
  const { node, bucket, depth } = row;
  const waiting = bucket === 'waiting';
  const failed = node.status === 'failed';
  const settled = bucket === 'ended';
  // A failure reads as one plain line (never a payload), in the same ink as
  // any other ending; the full error stays in the agent's own timeline.
  const failure = failed ? (plainFailure(node.error) ?? t('inspector.failedNoDetail')) : undefined;
  const body = failure ?? (settled ? (node.summary ?? node.description) : node.description);
  const elapsed = bucket === 'running' ? coarseElapsed(node.startedAt, now) : undefined;
  const model = shortModel(node.model);
  const meta = [
    node.model,
    node.thinkingEffort !== undefined ? t('subagent.effort', { effort: node.thinkingEffort }) : undefined,
    node.toolCallCountKnown === true ? t('subagent.tools', { count: node.toolCallCount }) : undefined,
  ].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  const state = bucket === 'waiting'
    ? t('rail.needsInput')
    : bucket === 'running'
      // A busy row reads as working from its first moment, never as a bare
      // "background" status until the first minute has passed.
      ? (elapsed ?? (node.busy === false ? t(STATUS_KEY(node.status)) : t('inspector.nowWorking')))
      : t(STATUS_KEY(node.status));
  const trail = row.path.length > 0 ? row.path.join(' › ') : undefined;
  return (
    <div
      data-roster-waiting={waiting ? '' : undefined}
      className={`relative flex min-w-0 items-start rounded-lg ${waiting ? 'bg-attention-soft/60' : ''}`}
      style={{ paddingLeft: depth * INDENT }}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-hairline"
          style={{ left: level * INDENT + 13 }}
        />
      ))}
      {row.childCount > 0 ? (
        <button
          type="button"
          data-roster-toggle={node.agentId}
          aria-expanded={row.expanded}
          aria-label={t(row.expanded ? 'inspector.collapseAgent' : 'inspector.expandAgent', { name: node.label })}
          onClick={() => { onToggle(node.agentId); }}
          className="mt-1 flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent pointer-coarse:h-9"
        >
          <DisclosureChevron open={row.expanded} />
        </button>
      ) : <span aria-hidden className="w-6 shrink-0" />}
      <button
        type="button"
        data-agent-id={node.agentId}
        data-agent-depth={depth}
        data-roster-bucket={bucket}
        aria-label={t('subagent.openAgent', { name: node.label })}
        title={meta === '' ? undefined : meta}
        onClick={() => { onSelect(node.agentId); }}
        className={ROW_BUTTON}
      >
        <span className={RAIL_MARK}>
          <LifeMark
            markId={`team:${node.agentId}`}
            life={failed ? 'failed' : BUCKET_LIFE[bucket]}
            tone={failed ? FAILED_TONE : BUCKET_TONE[bucket]}
            still
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2 leading-5">
            <span className={`max-w-[70%] shrink-0 truncate text-[13px] font-medium ${settled ? 'text-ink-soft' : 'text-ink'}`}>{node.label}</span>
            {model !== undefined ? <span className="min-w-0 truncate text-[11.5px] text-ink-faint">{model}</span> : null}
            <span
              data-agent-status={node.status}
              className={`ml-auto shrink-0 text-[12px] tabular-nums ${
                waiting ? 'font-medium text-attention' : bucket === 'running' ? 'text-success' : 'text-ink-faint'
              }`}
            >
              {state}
            </span>
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-[18px]">
            {trail !== undefined ? <span className="max-w-[45%] shrink-0 truncate text-ink-faint" title={trail}>{trail} ›</span> : null}
            {!row.expanded && row.childCount > 0 ? (
              <span className={`shrink-0 ${row.waitingBelow > 0 ? 'font-medium text-attention' : 'text-ink-faint'}`}>
                {row.waitingBelow > 0 ? tp('inspector.waitingBelow', row.waitingBelow) : tp('inspector.childCount', row.childCount)}
                {body !== undefined && body !== '' ? <span aria-hidden className="ml-1.5 text-ink-faint">·</span> : null}
              </span>
            ) : null}
            {body !== undefined && body !== '' ? (
              <span className={`min-w-0 truncate ${settled ? 'text-ink-faint' : 'text-ink-soft'}`} title={body}>{body}</span>
            ) : null}
          </span>
        </span>
      </button>
    </div>
  );
});

function RosterGroup({ row, onToggle }: { row: Extract<RosterRow, { kind: 'group' }>; onToggle: () => void }) {
  const { tp } = useI18n();
  return (
    <button
      type="button"
      data-roster-done-group
      aria-expanded={row.open}
      onClick={onToggle}
      className="row-interactive flex h-8 w-full items-center pr-2 text-left text-[12.5px] text-ink-soft hover:text-ink"
    >
      <span className="flex w-6 shrink-0 justify-center"><DisclosureChevron open={row.open} /></span>
      <span className={RAIL_MARK}><LifeMark markId="roster-done-group" life="done" still /></span>
      {tp('inspector.endedGroup', row.count)}
    </button>
  );
}

/**
 * The agent roster: a status summary that doubles as the filter, a search
 * field once the team is large, then the tree. Agents that need the user
 * and running agents lead; settled ones fold into "N completed". Every branch
 * below the first level starts folded. A long list windows inside its own
 * scroller, so a session with hundreds of agents mounts a screenful of rows.
 */
export const AgentRoster = memo(function AgentRoster({
  forest,
  rootId = MAIN_AGENT_ID,
  peekAgentId,
  waitingAgentIds,
  onSelect,
  actions,
}: {
  forest: AgentForest;
  /** Whose team: main, or the focused agent when it has its own children. */
  rootId?: string;
  /** Hover preview from the timeline: marks that agent's row, never switches. */
  peekAgentId?: string;
  waitingAgentIds: ReadonlySet<string>;
  onSelect: (agentId: string) => void;
  /** Controls beside the summary (e.g. Stop all). */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<RosterBucket | 'all'>('all');
  const [query, setQuery] = useState('');
  const [doneOpen, setDoneOpen] = useState(false);
  const model = useMemo(
    () => buildRoster({ forest, rootId, waiting: waitingAgentIds, expanded, filter, query, doneOpen }),
    [forest, rootId, waitingAgentIds, expanded, filter, query, doneOpen],
  );
  // A filter whose bucket emptied out falls back to everything.
  const activeFilter = filter !== 'all' && model.counts[filter] === 0 ? 'all' : filter;
  useEffect(() => {
    if (activeFilter !== filter) setFilter('all');
  }, [activeFilter, filter]);
  const now = useMinuteClock();
  const toggle = (agentId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const windowed = model.rows.length > WINDOW_AT;
  const virtualizer = useVirtualizer({
    count: windowed ? model.rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (model.rows[index]?.kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => {
      const row = model.rows[index];
      return row === undefined ? index : row.kind === 'group' ? '__done' : row.node.agentId;
    },
    overscan: 8,
    initialRect: { width: 300, height: 480 },
    useFlushSync: false,
  });
  const listRef = useRef<HTMLDivElement>(null);
  // Peek is a presentation-only mark on the matching row (index.css styles
  // `[data-agent-peek]`), applied outside React so hover churn never
  // re-renders the roster.
  useEffect(() => {
    const list = listRef.current;
    if (list === null || peekAgentId === undefined) return;
    const row = list.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(peekAgentId)}"]`);
    if (row === null) return;
    row.dataset['agentPeek'] = '';
    return () => { delete row.dataset['agentPeek']; };
  }, [peekAgentId, model]);

  if (model.total === 0) return null;
  const renderRow = (row: RosterRow) =>
    row.kind === 'group'
      ? <RosterGroup row={row} onToggle={() => { setDoneOpen((open) => !open); }} />
      : <RosterAgent row={row} now={now} onSelect={onSelect} onToggle={toggle} />;
  return (
    <div data-agent-roster className="space-y-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <RosterSummary counts={model.counts} filter={activeFilter} onFilter={setFilter} />
        </div>
        {actions}
      </div>
      {model.total >= SEARCH_AT ? (
        <label className="relative block">
          <span className="sr-only">{t('inspector.searchAgentsAria')}</span>
          <Icon name="search" size={12} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            data-roster-search
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery(''); } }}
            placeholder={t('inspector.searchAgents')}
            className="h-8 w-full rounded-md border border-hairline bg-transparent pr-2 pl-7 text-[12.5px] text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong focus:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-accent"
          />
        </label>
      ) : null}
      {model.rows.length === 0 ? (
        <p data-roster-empty className="py-1 pl-6 text-[12.5px] text-ink-faint">{t('inspector.noAgentMatch')}</p>
      ) : (
        <div
          ref={(node) => { scrollRef.current = node; listRef.current = node; }}
          data-agent-tree
          data-subagent-scroll
          aria-label={t('inspector.agentsAria')}
          role="list"
          className={`-mx-2 ${windowed ? 'max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain pr-1' : ''}`}
        >
          {windowed ? (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  role="listitem"
                  data-rail-item
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {renderRow(model.rows[item.index]!)}
                </div>
              ))}
            </div>
          ) : model.rows.map((row) => (
            <div key={row.kind === 'group' ? '__done' : row.node.agentId} role="listitem" data-rail-item>
              {renderRow(row)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Wall clock at minute granularity: elapsed labels on rows are coarse. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(timer); };
  }, []);
  return now;
}
