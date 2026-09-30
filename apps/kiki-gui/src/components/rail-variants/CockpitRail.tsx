/**
 * The cockpit rail mode (optional). An instrument panel for a coordinator,
 * drawn in the theme's own colours: a caution bar for what needs you, three
 * gauges (context, cache, running share), the cost / compaction / turn
 * strip, the agent array (one cell per agent, by model family), then 运行中
 * as a list of timers or as swimlanes on a shared six-hour axis.
 */

import { useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { RAIL_MAX_WIDTH } from '@kiki/session-core/settings';
import { Icon } from '../icons';
import {
  FAMILIES,
  FAMILY_TONE,
  age,
  decidable,
  money,
  pendingId,
  pendingSubject,
  tokens,
  useRailData,
  type Family,
  type FleetAgent,
} from './model';
import { FOCUS_RING, ModeSwitch, StateMark, useDecide, type ModeProps } from './shell';

const FAMILY_NAME: Record<Exclude<Family, 'other'>, string> = { opus: 'Opus', sol: 'Sol', luna: 'Luna', ds: 'DeepSeek' };
const STATE_KEY: Record<FleetAgent['state'], I18nKey> = {
  waiting: 'rail.cockpit.state.waiting',
  running: 'rail.cockpit.state.running',
  done: 'rail.cockpit.state.done',
  failed: 'rail.cockpit.state.failed',
  stopped: 'rail.cockpit.state.stopped',
};

function useNames() {
  const { t } = useI18n();
  return {
    family: (family: Family) => (family === 'other' ? t('rail.cockpit.familyOther') : FAMILY_NAME[family]),
    state: (state: FleetAgent['state']) => t(STATE_KEY[state]),
  };
}

const CELL: Record<FleetAgent['state'], string> = {
  waiting: 'bg-attention ring-2 ring-attention/30',
  running: 'bg-success',
  done: 'bg-ink/[0.14]',
  failed: 'bg-danger/80',
  stopped: 'ring-1 ring-ink-faint/60 ring-inset',
};

/** A 240° arc gauge in theme colours. */
function Gauge({ ratio, label, value, sub, warn }: { ratio: number; label: string; value: string; sub?: string; warn?: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const arc = c * (240 / 360);
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="flex min-w-0 flex-col items-center">
      <svg viewBox="0 0 80 70" className="h-[66px] w-[76px]" role="img" aria-label={`${label} ${value}`}>
        <g transform="rotate(150 40 40)">
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${arc} ${c}`} className="stroke-ink/[0.08]" />
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${arc * clamped} ${c}`} className={warn ? 'stroke-attention' : 'stroke-selected-ink'} />
        </g>
        <text x="40" y="44" textAnchor="middle" className="fill-ink font-mono text-[15px] font-semibold">{value}</text>
        {sub !== undefined ? <text x="40" y="59" textAnchor="middle" className="fill-ink-faint font-mono text-[8.5px]">{sub}</text> : null}
      </svg>
      <span className="-mt-0.5 text-[11px] text-ink-faint">{label}</span>
    </div>
  );
}

const WINDOW_HOURS = 6;
const WINDOW_MS = WINDOW_HOURS * 3_600_000;

/**
 * 运行中 as swimlanes: a lane per running or waiting agent on one six-hour
 * axis, grouped by family; compactions are dashed rules across every lane.
 */
function RunningLanes({ agents, compactions, now, onOpen }: {
  agents: readonly FleetAgent[];
  compactions: readonly number[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const names = useNames();
  const start = now - WINDOW_MS;
  const x = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / WINDOW_MS) * 100))}%`;
  const ticks = Array.from({ length: WINDOW_HOURS + 1 }, (_, i) => now - (WINDOW_HOURS - i) * 3_600_000);
  const inWindow = compactions.filter((t) => t >= start);
  const bands = FAMILIES.map((family) => ({ family, rows: agents.filter((a) => a.family === family) })).filter((band) => band.rows.length > 0);
  const rules = (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-[136px]">
      {ticks.map((t) => <span key={t} className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: x(t) }} />)}
      {inWindow.map((t) => <span key={t} className="absolute inset-y-0 border-l border-dashed border-section-ink/60" style={{ left: x(t) }} />)}
      <span className="absolute inset-y-0 w-[2px] -translate-x-full bg-ink" style={{ left: '100%' }} />
    </span>
  );
  return (
    <div data-cockpit-lanes>
      <div className="relative flex h-5 items-end pb-0.5">
        <span className="w-[136px] shrink-0" />
        <span className="relative h-full flex-1">
          {ticks.map((tick, i) => (
            <span key={tick} className={`absolute bottom-0 font-mono text-[10px] whitespace-nowrap tabular-nums ${i === 0 ? 'text-ink-faint' : i === ticks.length - 1 ? '-translate-x-full font-semibold text-ink' : '-translate-x-1/2 text-ink-faint'}`} style={{ left: x(tick) }}>
              {i === ticks.length - 1 ? t('rail.cockpit.now') : `-${WINDOW_HOURS - i}h`}
            </span>
          ))}
        </span>
      </div>
      {bands.map((band) => (
        <section key={band.family} className="relative pt-1.5">
          {rules}
          <h4 className="relative flex h-5 items-center gap-1.5 text-[11px] font-semibold text-section-ink">
            <span className={`h-2 w-2 rounded-sm ${FAMILY_TONE[band.family].fill}`} />{names.family(band.family)}<span className="font-normal text-ink-faint tabular-nums">{band.rows.length}</span>
          </h4>
          <ul className="relative">
            {band.rows.map((agent) => {
              const begin = agent.startedAt ?? start;
              return (
                <li key={agent.id}>
                  <button type="button" data-rail-open-agent={agent.id} onClick={() => { onOpen(agent.id); }} title={`${agent.label}\n${agent.description ?? ''}`} className={`group flex h-6 w-full items-center rounded text-left hover:bg-ink/[0.04] ${FOCUS_RING}`}>
                    <span className="flex w-[136px] shrink-0 items-center gap-1.5 pr-2" style={{ paddingLeft: agent.depth * 8 }}>
                      <StateMark state={agent.state} className="h-1.5 w-1.5" />
                      <span className={`truncate font-mono text-[11.5px] ${agent.state === 'waiting' ? 'font-semibold text-attention' : 'text-ink'}`}>{agent.label}</span>
                    </span>
                    <span className="relative h-full flex-1">
                      <span className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full ${agent.state === 'waiting' ? 'bg-attention' : 'bg-success'}`} style={{ left: x(begin), width: `max(4px, calc(100% - ${x(begin)}))` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 运行中 as a list: waiting first, then longest-running; elapsed on the right. */
function RunningList({ agents, now, onOpen }: { agents: readonly FleetAgent[]; now: number; onOpen: (id: string) => void }) {
  const { locale } = useI18n();
  const names = useNames();
  return (
    <ul data-cockpit-list className="divide-y divide-hairline">
      {agents.map((agent) => (
        <li key={agent.id}>
          <button type="button" data-rail-open-agent={agent.id} onClick={() => { onOpen(agent.id); }} title={`${agent.label}\n${agent.description ?? ''}`} className={`flex min-h-10 w-full items-center gap-2.5 rounded py-1 text-left hover:bg-ink/[0.03] ${FOCUS_RING}`} style={{ paddingLeft: agent.depth * 10 }}>
            <StateMark state={agent.state} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-mono text-[12.5px] ${agent.state === 'waiting' ? 'font-semibold text-attention' : 'text-ink'}`}>{agent.label}</span>
              <span className="block truncate text-[11.5px] text-ink-faint">{agent.description}</span>
            </span>
            <span className={`shrink-0 rounded px-1 text-[10.5px] font-semibold ${FAMILY_TONE[agent.family].soft} ${FAMILY_TONE[agent.family].text}`}>{names.family(agent.family)}</span>
            <span className={`w-11 shrink-0 text-right font-mono text-[12px] tabular-nums ${agent.state === 'waiting' ? 'text-attention' : 'text-ink-soft'}`}>{agent.startedAt !== undefined ? age(now - agent.startedAt, locale) : '—'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CockpitRail(props: ModeProps) {
  const { t, locale } = useI18n();
  const names = useNames();
  const layout = useLayoutPreferences();
  const width = Math.min(RAIL_MAX_WIDTH, Math.max(layout.railWidth, 340));
  const data = useRailData(props.state, props.forest, props.sessionPending ?? []);
  const { sending, decide, canDecide } = useDecide(props.onResolveApproval);
  const [view, setView] = useState<'list' | 'lanes'>('list');
  const ctx = data.contextTokens !== undefined && data.contextLimit !== undefined && data.contextLimit > 0 ? data.contextTokens / data.contextLimit : 0;
  const running = useMemo(
    () => data.agents
      .filter((a) => a.state === 'running' || a.state === 'waiting')
      .toSorted((l, r) => (l.state === 'waiting' ? 0 : 1) - (r.state === 'waiting' ? 0 : 1) || (l.startedAt ?? 0) - (r.startedAt ?? 0)),
    [data.agents],
  );
  const lastCompaction = data.compactions.at(-1);
  const caution = data.pending.length > 0;
  const who = (origin: string | undefined) => (origin !== undefined ? (props.forest.byId[origin]?.label ?? origin) : t('rail.ownerMain'));

  return (
    <div className="app-rail-shell">
      <aside
        className={props.className ?? 'app-rail'}
        style={{ '--kiki-rail-width': `${width}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' } as React.CSSProperties}
        data-session-rail
        data-rail-mode-current="cockpit"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <h2 className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-ink">{t('rail.mode.cockpit')}</h2>
          <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{t('rail.cockpit.agentCount', { count: data.agents.length })}</span>
          <span className="flex-1" />
          <ModeSwitch mode={props.mode} onChoose={props.onChooseMode} />
          {props.onClose !== undefined ? (
            <button type="button" onClick={props.onClose} data-rail-close title={t('sv.hidePanel')} aria-label={t('sv.hidePanel')} className={`-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-faint hover:bg-ink/[0.05] hover:text-ink lg:h-7 lg:w-7 ${FOCUS_RING}`}>
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </header>

        <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {/* Caution: lit only when something waits on you. */}
          <section aria-label={t('inspector.needsYou')} className={`rounded-xl p-2.5 ${caution ? 'bg-attention-soft ring-1 ring-attention/40 ring-inset' : 'bg-ink/[0.035]'}`}>
            <div className="flex items-center gap-2">
              <span className={`text-[12px] font-semibold ${caution ? 'text-attention' : 'text-ink-faint'}`}>{caution ? t('inspector.needsYou') : t('rail.cockpit.nothingWaiting')}</span>
              <span className={`ml-auto font-mono text-[24px] leading-none font-semibold tabular-nums ${caution ? 'text-attention' : 'text-ink-faint'}`}>{String(data.pending.length).padStart(2, '0')}</span>
            </div>
            {caution ? (
              <ul className="mt-2 space-y-1">
                {data.pending.map((item) => {
                  const id = pendingId(item);
                  const busy = sending.has(id);
                  return (
                    <li key={id} data-needs-you-item={id} className="flex min-w-0 items-center gap-2 rounded-lg bg-panel/80 py-1.5 pr-1.5 pl-2">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="shrink-0 font-mono text-[11px] font-semibold text-attention">{item.kind === 'approval' ? item.request.tool_name : t('rail.questionTag')}</span>
                          <button type="button" onClick={() => { if (item.originAgentId !== undefined) props.onOpenSubagent(item.originAgentId); }} className={`min-w-0 truncate rounded font-mono text-[11.5px] text-ink-soft hover:text-ink ${FOCUS_RING}`}>{who(item.originAgentId)}</button>
                          <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{age(data.now - Date.parse(item.request.created_at), locale)}</span>
                        </span>
                        <span className="block truncate font-mono text-[11.5px] text-ink" title={pendingSubject(item)}>{pendingSubject(item)}</span>
                      </span>
                      {decidable(item) && canDecide ? (
                        <>
                          <button type="button" disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-danger/[0.08] hover:text-danger disabled:opacity-50 ${FOCUS_RING}`}>{t('inspector.rejectInline')}</button>
                          <button type="button" disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`h-7 shrink-0 rounded-md bg-attention px-2.5 text-[12px] font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50 ${FOCUS_RING}`}>{t('inspector.approveInline')}</button>
                        </>
                      ) : (
                        <button type="button" onClick={() => { props.onReviewPending?.(item.kind, id); }} className={`h-7 shrink-0 rounded-md bg-attention px-2.5 text-[12px] font-semibold text-on-accent hover:bg-accent-deep ${FOCUS_RING}`}>{item.kind === 'question' ? t('inspector.answer') : t('inspector.review')}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
          {/* Gauges and the strip under them. */}
          <div className="mt-4 grid grid-cols-3">
            <Gauge ratio={ctx} warn={ctx > 0.8} label={t('rail.context')} value={`${Math.round(ctx * 100)}%`} sub={`${tokens(data.contextTokens)}/${tokens(data.contextLimit)}`} />
            <Gauge ratio={data.cacheRate ?? 0} label={t('rail.cockpit.cacheHit')} value={`${Math.round((data.cacheRate ?? 0) * 100)}%`} />
            <Gauge ratio={running.length / Math.max(1, data.agents.length)} label={t('rail.cockpit.state.running')} value={String(running.length)} sub={`/ ${data.agents.length}`} />
          </div>
          <dl className="mt-2 grid grid-cols-3 divide-x divide-hairline rounded-lg bg-ink/[0.03] py-2 text-center">
            <div><dt className="text-[11px] text-ink-faint">{t('rail.cost')}</dt><dd className="font-mono text-[15px] font-semibold text-ink tabular-nums">{money(data.costUsd) ?? '—'}</dd></div>
            <div><dt className="text-[11px] text-ink-faint">{t('rail.cockpit.compactions')}</dt><dd className="font-mono text-[15px] font-semibold text-ink tabular-nums">{data.compactions.length}<span className="ml-1 text-[10.5px] font-normal text-ink-faint">{lastCompaction !== undefined ? t('rail.cockpit.ago', { age: age(data.now - lastCompaction, locale) }) : ''}</span></dd></div>
            <div><dt className="text-[11px] text-ink-faint">{t('rail.turns')}</dt><dd className="font-mono text-[15px] font-semibold text-ink tabular-nums">{data.turns ?? '—'}</dd></div>
          </dl>

          {/* The array: one cell per agent, by family. */}
          <h3 className="mt-5 mb-1.5 flex items-center text-[12px] font-medium text-ink-soft">
            {t('rail.cockpit.array')}
            <span className="ml-auto flex items-center gap-2.5 text-[11px] font-normal text-ink-faint">
              {(['waiting', 'running', 'done', 'failed'] as const).map((state) => (
                <span key={state} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-[2px] ${CELL[state]}`} />{names.state(state)} {data.byState[state]}</span>
              ))}
            </span>
          </h3>
          <div className="space-y-1.5">
            {FAMILIES.filter((f) => data.byFamily[f] > 0).map((family) => (
              <div key={family} className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-[11px] leading-[14px] text-ink-faint">{names.family(family)}</span>
                <div className="flex flex-1 flex-wrap gap-[3px]">
                  {data.agents.filter((a) => a.family === family).map((agent) => (
                    <button key={agent.id} type="button" data-rail-open-agent={agent.id} aria-label={`${agent.label} · ${names.state(agent.state)}`} title={`${agent.label} · ${names.state(agent.state)}`} onClick={() => { props.onOpenSubagent(agent.id); }} className={`h-3.5 w-3.5 rounded-[3px] transition-transform hover:scale-125 ${CELL[agent.state]} ${FOCUS_RING}`} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* 运行中: list or lanes. */}
          <div className="mt-5 mb-1 flex items-center gap-2">
            <h3 className="text-[12px] font-medium text-ink-soft">{t('rail.cockpit.state.running')}</h3>
            <span className="text-[12px] text-ink-faint tabular-nums">{running.length}</span>
            <div role="radiogroup" aria-label={t('rail.cockpit.viewAria')} className="ml-auto flex items-center rounded-lg bg-ink/[0.05] p-0.5">
              {([['list', t('rail.cockpit.viewList')], ['lanes', t('rail.cockpit.viewLanes')]] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={view === value} data-cockpit-view={value} onClick={() => { setView(value); }} className={`h-6 rounded-md px-2 text-[12px] ${view === value ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-faint hover:text-ink'} ${FOCUS_RING}`}>{label}</button>
              ))}
            </div>
          </div>
          {running.length === 0 ? <p className="py-2 text-[12.5px] text-ink-faint">{t('rail.cockpit.noneRunning')}</p> : view === 'list'
            ? <RunningList agents={running} now={data.now} onOpen={props.onOpenSubagent} />
            : <RunningLanes agents={running} compactions={data.compactions} now={data.now} onOpen={props.onOpenSubagent} />}
        </div>
      </aside>
    </div>
  );
}
