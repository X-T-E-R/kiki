/**
 * 概览 in the cockpit mode: the same facts as the standard overview, read as
 * instruments. Three gauges (context, cache hits, share of the agents under
 * this one that are running), a strip of cost / compactions / turns, then the
 * whole fleet under the viewed agent as lanes on one shared time axis.
 *
 * The lanes are a timeline, not a task board: every bar sits on the same
 * window (earliest known start → now), tree order with depth indent, state by
 * colour and shape, and an honest blank where the session recorded no timing.
 * Agents parked on a user decision carry the attention colour; a suspended
 * agent whose wait is not the user's stays hollow — it is never dressed up as
 * a needs-you row.
 *
 * It replaces only the overview's body; the rail around it keeps its sections.
 */

import { memo } from 'react';

import type { AgentForest, Block } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { age, compactionTimes, fleetUnder, laneWindow, useNow, type FleetAgent, type FleetState } from './model';
import { FOCUS_RING, StateMark } from './shell';
import type { OverviewFigures } from '../agent-panel/InspectorOverview';

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
function Gauge({ ratio, label, value, sub, warn }: { ratio: number | undefined; label: string; value: string; sub?: string; warn?: boolean }) {
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
      {sub !== undefined ? <span className="font-mono text-[10.5px] text-ink-faint tabular-nums">{sub}</span> : null}
    </div>
  );
}

const LABEL_W = 168;
const DUR_W = 68;
/** Depth step in the lane label; the cockpit is wider than the standard rail. */
const INDENT = 10;

/** Lane bar fill per state. The needs-you accent belongs to user decisions only. */
function barClass(state: FleetState, needsUser: boolean): string {
  if (state === 'waiting') return needsUser ? 'bg-attention' : 'border border-dashed border-ink-faint/70';
  switch (state) {
    case 'running': return 'bg-success/80';
    case 'failed': return 'bg-danger/70';
    case 'stopped': return 'bg-ink/10';
    default: return 'bg-ink/15';
  }
}

function labelClass(state: FleetState, needsUser: boolean): string {
  if (state === 'waiting') return needsUser ? 'font-medium text-accent-ink' : 'text-ink-soft';
  if (state === 'done' || state === 'stopped') return 'text-ink-soft';
  return 'text-ink';
}

type Translate = ReturnType<typeof useI18n>['t'];

function stateWord(state: FleetState, needsUser: boolean, t: Translate): string {
  if (state === 'waiting') return t(needsUser ? 'rail.cockpit.state.needsYou' : 'rail.cockpit.state.suspended');
  switch (state) {
    case 'running': return t('rail.cockpit.state.running');
    case 'failed': return t('rail.cockpit.state.failed');
    case 'stopped': return t('rail.cockpit.state.stopped');
    default: return t('rail.cockpit.state.done');
  }
}

function clock(at: number, locale: 'en' | 'zh'): string {
  return new Date(at).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The fleet under the viewed agent as lanes on one shared axis. The window is
 * derived from the data (earliest known start or compaction → now), so lanes
 * are always comparable; nothing stretches its own scale.
 */
function FleetLanes({ agents, compactions, now, onOpen }: {
  agents: readonly FleetAgent[];
  compactions: readonly number[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const win = laneWindow({ starts: agents.map((agent) => agent.startedAt), markers: compactions, now });
  const span = Math.max(1, win.end - win.start);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - win.start) / span) * 100));
  const counts = { needsYou: 0, running: 0, suspended: 0, failed: 0, ended: 0 };
  for (const agent of agents) {
    if (agent.state === 'waiting') counts[agent.needsUser ? 'needsYou' : 'suspended'] += 1;
    else if (agent.state === 'running') counts.running += 1;
    else if (agent.state === 'failed') counts.failed += 1;
    else counts.ended += 1;
  }
  const summary: { key: string; mark: FleetState; text: string }[] = [];
  if (counts.needsYou > 0) summary.push({ key: 'waiting', mark: 'waiting', text: t('inspector.filter.waiting', { count: counts.needsYou }) });
  if (counts.running > 0) summary.push({ key: 'running', mark: 'running', text: t('inspector.filter.running', { count: counts.running }) });
  if (counts.suspended > 0) summary.push({ key: 'suspended', mark: 'stopped', text: t('rail.cockpit.summary.suspended', { count: counts.suspended }) });
  if (counts.failed > 0) summary.push({ key: 'failed', mark: 'failed', text: t('inspector.filter.failed', { count: counts.failed }) });
  if (counts.ended > 0) summary.push({ key: 'ended', mark: 'done', text: t('inspector.filter.ended', { count: counts.ended }) });
  return (
    <div data-cockpit-lanes role="group" aria-label={t('rail.cockpit.lanes.aria')}>
      {summary.length > 0 ? (
        <div data-cockpit-lanes-summary className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1.5">
          {summary.map((item) => (
            <span key={item.key} data-lane-summary={item.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint tabular-nums">
              {item.key === 'suspended' ? (
                <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-[1px] border border-dashed border-ink-faint/70" />
              ) : (
                <StateMark state={item.mark} className="h-1.5 w-1.5" />
              )}
              {item.text}
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, right: DUR_W }}>
          {win.ticks.map((tick) => <span key={tick} className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: `${pct(tick)}%` }} />)}
          {compactions.filter((at) => at >= win.start && at <= win.end).map((at) => <span key={at} data-cockpit-compaction className="absolute inset-y-0 border-l border-dashed border-section-ink/50" style={{ left: `${pct(at)}%` }} />)}
        </span>
        <ul className="relative">
          {agents.map((agent) => {
            const begin = agent.startedAt;
            const end = agent.endedAt;
            const title = begin === undefined
              ? `${agent.label} · ${t('rail.cockpit.lane.untimed')} · ${stateWord(agent.state, agent.needsUser, t)}`
              : `${agent.label}\n${clock(begin, locale)} → ${end === undefined ? t('rail.cockpit.now') : clock(end, locale)} · ${stateWord(agent.state, agent.needsUser, t)}`;
            const elapsed = begin === undefined ? undefined : Math.max(0, (end ?? now) - begin);
            const duration = elapsed === undefined ? '—' : elapsed < 60_000 ? t('rail.cockpit.duration.underMinute') : age(elapsed, locale);
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  data-cockpit-lane={agent.id}
                  data-lane-state={agent.state}
                  data-lane-needs-user={agent.needsUser || undefined}
                  data-rail-open-agent={agent.id}
                  onClick={() => { onOpen(agent.id); }}
                  title={title}
                  className={`flex h-6 w-full items-center rounded text-left hover:bg-ink/[0.04] pointer-coarse:h-8 ${FOCUS_RING}`}
                >
                  <span className="flex shrink-0 items-center gap-1.5 pr-2" style={{ width: LABEL_W, paddingLeft: agent.depth * INDENT }}>
                    <StateMark state={agent.state} className="h-1.5 w-1.5" />
                    <span className={`truncate text-[12px] ${labelClass(agent.state, agent.needsUser)}`}>{agent.label}</span>
                  </span>
                  <span className="relative h-full flex-1">
                    {begin !== undefined ? (
                      <span
                        className={`absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full ${barClass(agent.state, agent.needsUser)}`}
                        style={{ left: `${pct(begin)}%`, width: `${Math.max(0.6, pct(end ?? now) - pct(begin))}%` }}
                      />
                    ) : end !== undefined ? (
                      <span className={`absolute top-1/2 h-[7px] w-px -translate-y-1/2 ${agent.state === 'failed' ? 'bg-danger/70' : 'bg-ink-faint'}`} style={{ left: `${pct(end)}%` }} />
                    ) : null}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[10.5px] leading-6 whitespace-nowrap text-ink-faint tabular-nums" style={{ width: DUR_W }}>{duration}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="relative flex h-4 items-end" aria-hidden>
        <span className="shrink-0" style={{ width: LABEL_W }} />
        <span className="relative h-full flex-1">
          {win.ticks.map((tick, i) => (
            <span
              key={tick}
              data-cockpit-tick
              className={`absolute bottom-0 font-mono text-[10px] whitespace-nowrap tabular-nums ${i === 0 ? '' : i === win.ticks.length - 1 ? '-translate-x-full text-ink-soft' : '-translate-x-1/2'} text-ink-faint`}
              style={{ left: `${pct(tick)}%` }}
            >
              {i === win.ticks.length - 1 ? t('rail.cockpit.now') : `-${age(now - tick, locale)}`}
            </span>
          ))}
        </span>
        <span className="shrink-0" style={{ width: DUR_W }} />
      </div>
    </div>
  );
}

export const CockpitOverview = memo(function CockpitOverview({ agentId, forest, blocks, waitingIds, contextUsed, contextLimit, compactPoint, figures, turns, toolCalls, onOpenAgent }: {
  agentId: string;
  forest: AgentForest;
  blocks: readonly Block[];
  waitingIds: ReadonlySet<string>;
  contextUsed?: number;
  contextLimit?: number;
  compactPoint?: number;
  figures: OverviewFigures;
  turns?: number;
  toolCalls?: number;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const fleet = fleetUnder(forest, agentId, waitingIds);
  const live = fleet.filter((agent) => agent.state === 'running' || agent.state === 'waiting');
  const compactions = compactionTimes(blocks);
  const ctx = contextUsed !== undefined && contextLimit !== undefined && contextLimit > 0 ? contextUsed / contextLimit : undefined;
  const warnAt = compactPoint !== undefined && contextLimit !== undefined && contextLimit > 0 ? (compactPoint / contextLimit) * 0.8 : 0.8;
  const cache = figures.cacheRate === undefined ? undefined : figures.cacheRate / 100;
  const compactionCount = figures.compactions ?? (compactions.length > 0 ? compactions.length : undefined);
  const strip: { key: string; label: string; value: string }[] = [
    { key: 'cost', label: t('inspector.cost'), value: money(figures.costUsd) },
    { key: 'compactions', label: t('rail.cockpit.compactions'), value: compactionCount === undefined ? '—' : String(compactionCount) },
    turns !== undefined
      ? { key: 'turns', label: t('rail.turns'), value: String(turns) }
      : { key: 'tools', label: t('rail.cockpit.toolCalls'), value: toolCalls === undefined ? '—' : String(toolCalls) },
  ];
  return (
    <div data-cockpit-overview className="space-y-3">
      <div className="grid grid-cols-3">
        <Gauge ratio={ctx} warn={ctx !== undefined && ctx >= warnAt} label={t('inspector.context')} value={ctx === undefined ? '—' : `${Math.round(ctx * 100)}%`} sub={`${tokens(contextUsed)}/${tokens(contextLimit)}`} />
        <Gauge ratio={cache} label={t('rail.cockpit.cacheHit')} value={cache === undefined ? '—' : `${Math.round(cache * 100)}%`} />
        <Gauge ratio={fleet.length === 0 ? undefined : live.length / fleet.length} label={t('rail.cockpit.state.running')} value={String(live.length)} sub={`/ ${fleet.length}`} />
      </div>
      <dl className="grid grid-cols-3 divide-x divide-hairline text-center">
        {strip.map((cell) => (
          <div key={cell.key} data-cockpit-fact={cell.key}>
            <dt className="text-[11.5px] text-ink-faint">{cell.label}</dt>
            <dd className="font-mono text-[14px] text-ink tabular-nums">{cell.value}</dd>
          </div>
        ))}
      </dl>
      {fleet.length > 0 && onOpenAgent !== undefined ? (
        <FleetLanes agents={fleet} compactions={compactions} now={now} onOpen={onOpenAgent} />
      ) : null}
    </div>
  );
});
