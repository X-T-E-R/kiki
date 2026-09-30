/**
 * 概览 in the cockpit mode: the same facts as the standard overview, read as
 * instruments. Three gauges (context, cache hits, share of the agents under
 * this one that are running), a strip of cost / compactions / turns, then the
 * running agents under the viewed agent as lanes on a six-hour axis.
 *
 * It replaces only the overview's body; the rail around it does not change.
 */

import { memo } from 'react';

import type { AgentForest, Block } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { compactionTimes, fleetUnder, useNow, type FleetAgent } from './model';
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

const WINDOW_HOURS = 6;
const WINDOW_MS = WINDOW_HOURS * 3_600_000;
const LABEL_W = 112;

/** Running and waiting agents under the viewed one, as lanes on one six-hour axis. */
function RunningLanes({ agents, compactions, now, onOpen }: {
  agents: readonly FleetAgent[];
  compactions: readonly number[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const start = now - WINDOW_MS;
  const x = (at: number) => `${Math.min(100, Math.max(0, ((at - start) / WINDOW_MS) * 100))}%`;
  const ticks = Array.from({ length: WINDOW_HOURS / 2 + 1 }, (_, i) => now - (WINDOW_HOURS - i * 2) * 3_600_000);
  return (
    <div data-cockpit-lanes className="relative">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
        {ticks.map((tick) => <span key={tick} className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: x(tick) }} />)}
        {compactions.filter((at) => at >= start).map((at) => <span key={at} className="absolute inset-y-0 border-l border-dashed border-section-ink/50" style={{ left: x(at) }} />)}
      </span>
      <ul className="relative">
        {agents.map((agent) => {
          const begin = agent.startedAt ?? start;
          const waiting = agent.state === 'waiting';
          return (
            <li key={agent.id}>
              <button type="button" data-rail-open-agent={agent.id} onClick={() => { onOpen(agent.id); }} title={agent.description ?? agent.label} className={`flex h-7 w-full items-center rounded text-left hover:bg-ink/[0.04] pointer-coarse:h-9 ${FOCUS_RING}`}>
                <span className="flex shrink-0 items-center gap-1.5 pr-2" style={{ width: LABEL_W, paddingLeft: agent.depth * 8 }}>
                  <StateMark state={agent.state} className="h-1.5 w-1.5" />
                  <span className={`truncate text-[12px] ${waiting ? 'font-medium text-accent-ink' : 'text-ink'}`}>{agent.label}</span>
                </span>
                <span className="relative h-full flex-1">
                  <span className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full ${waiting ? 'bg-attention' : 'bg-success/80'}`} style={{ left: x(begin), width: `max(4px, calc(100% - ${x(begin)}))` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="relative flex h-4 items-end" aria-hidden>
        <span className="shrink-0" style={{ width: LABEL_W }} />
        <span className="relative h-full flex-1">
          {ticks.map((tick, i) => (
            <span key={tick} className={`absolute bottom-0 font-mono text-[10px] whitespace-nowrap tabular-nums ${i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full text-ink-soft' : '-translate-x-1/2'} text-ink-faint`} style={{ left: x(tick) }}>
              {i === ticks.length - 1 ? t('rail.cockpit.now') : `-${WINDOW_HOURS - i * 2}h`}
            </span>
          ))}
        </span>
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
  const live = fleet
    .filter((agent) => agent.state === 'running' || agent.state === 'waiting')
    .toSorted((l, r) => (l.state === 'waiting' ? 0 : 1) - (r.state === 'waiting' ? 0 : 1) || (l.startedAt ?? 0) - (r.startedAt ?? 0));
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
      {live.length > 0 && onOpenAgent !== undefined ? (
        <RunningLanes agents={live} compactions={compactions} now={now} onOpen={onOpenAgent} />
      ) : null}
    </div>
  );
});
