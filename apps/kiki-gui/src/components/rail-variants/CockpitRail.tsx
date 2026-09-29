/**
 * Variant B · Cockpit. The rail is an instrument panel on the always-dark
 * shell ground in both themes: one master-caution annunciator for whatever
 * needs you, gauges for context / cost / cache, an array of cells (one per
 * agent) you read like warning lights, and the in-flight list as timers.
 *
 * Signal colours are the dark-theme values of the existing tokens, pinned
 * here so they hold on the shell ground in light theme as well.
 */

import type { CSSProperties } from 'react';

import { useI18n } from '../../i18n';
import { railCopy } from './copy';
import {
  FAMILIES,
  age,
  decidable,
  money,
  pendingId,
  pendingSubject,
  tokens,
  useRailData,
  type FleetAgent,
} from './model';
import type { VariantProps } from './RailSwitch';
import { CloseButton, VariantPicker, VariantShell, useDecide } from './shell';

const SIGNAL = {
  '--ck-warn': '#ff9a5c',
  '--ck-go': '#7fb88a',
  '--ck-teal': '#7fd3c4',
  '--ck-amber': '#e0a63c',
  '--ck-fail': '#f2877c',
} as CSSProperties;

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ck-teal)]';

const CELL: Record<FleetAgent['state'], string> = {
  waiting: 'bg-[var(--ck-warn)] shadow-[0_0_8px_var(--ck-warn)]',
  running: 'bg-[var(--ck-go)]',
  done: 'bg-shell-ink-soft/35',
  failed: 'bg-[var(--ck-fail)]',
  stopped: 'border border-shell-ink-soft/50',
};

/** A 240° arc gauge. */
function Gauge({ ratio, label, value, sub, warn }: { ratio: number; label: string; value: string; sub?: string; warn?: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const arc = c * (240 / 360);
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 80 72" className="h-[72px] w-[80px]" aria-hidden>
        <g transform="rotate(150 40 40)">
          <circle cx="40" cy="40" r={r} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${arc} ${c}`} className="text-shell-hairline" />
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${arc * clamped} ${c}`} stroke={warn ? 'var(--ck-warn)' : 'var(--ck-teal)'} />
        </g>
        <text x="40" y="44" textAnchor="middle" className="fill-shell-ink-strong font-mono text-[15px] font-semibold">{value}</text>
        {sub !== undefined ? <text x="40" y="60" textAnchor="middle" className="fill-shell-ink-soft font-mono text-[8.5px]">{sub}</text> : null}
      </svg>
      <span className="-mt-1 text-[10.5px] tracking-[0.12em] text-shell-ink-soft uppercase">{label}</span>
    </div>
  );
}

export function CockpitRail(props: VariantProps) {
  const { locale } = useI18n();
  const copy = railCopy(locale);
  const data = useRailData(props.state, props.forest, props.sessionPending ?? []);
  const { sending, decide, canDecide } = useDecide(props.onResolveApproval);
  const ctx = data.contextTokens !== undefined && data.contextLimit !== undefined ? data.contextTokens / data.contextLimit : 0;
  const inFlight = data.agents.filter((a) => a.state === 'running' || a.state === 'waiting')
    .toSorted((l, r) => (l.state === 'waiting' ? -1 : 0) - (r.state === 'waiting' ? -1 : 0) || (l.startedAt ?? 0) - (r.startedAt ?? 0));
  const lastCompaction = data.compactions.at(-1);
  const caution = data.pending.length > 0;
  return (
    <VariantShell className={props.className} variant={props.variant} surface="!bg-shell text-shell-ink" minWidth={360}>
      <div style={SIGNAL} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-shell-hairline px-4">
          <span className="h-2 w-2 rounded-full bg-[var(--ck-go)]" aria-hidden />
          <h2 className="font-mono text-[12px] font-semibold tracking-[0.18em] text-shell-ink-strong uppercase">{copy.bTitle}</h2>
          <span className="ml-auto" />
          <VariantPicker variant={props.variant} onChoose={props.onChooseVariant} dark />
          <CloseButton onClose={props.onClose} dark />
        </header>

        <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5">
          {/* Master caution: the one thing that is lit when you are needed. */}
          <section
            aria-label={copy.bCaution}
            className={`rounded-lg border-2 px-3 py-2.5 ${caution ? 'border-[var(--ck-warn)] bg-[var(--ck-warn)]/10' : 'border-shell-hairline'}`}
          >
            <div className="flex items-center gap-2">
              <span className={`font-mono text-[11px] font-bold tracking-[0.2em] uppercase ${caution ? 'text-[var(--ck-warn)]' : 'text-shell-ink-soft'}`}>{copy.bCaution}</span>
              <span className={`ml-auto font-mono text-[26px] leading-none font-semibold tabular-nums ${caution ? 'text-[var(--ck-warn)]' : 'text-shell-ink-soft'}`}>{String(data.pending.length).padStart(2, '0')}</span>
            </div>
            {caution ? (
              <ul className="mt-2 space-y-1.5">
                {data.pending.map((item) => {
                  const id = pendingId(item);
                  const origin = item.originAgentId;
                  const who = origin !== undefined ? (props.forest.byId[origin]?.label ?? origin) : copy.main;
                  const busy = sending.has(id);
                  return (
                    <li key={id} data-needs-you-item={id} className="rounded-md bg-black/25 px-2 py-1.5">
                      <div className="flex items-baseline gap-2 font-mono text-[11.5px]">
                        <span className="shrink-0 font-semibold text-[var(--ck-warn)]">{item.kind === 'approval' ? item.request.tool_name.toUpperCase() : 'ASK'}</span>
                        <span className="min-w-0 truncate text-shell-ink-strong" title={pendingSubject(item)}>{pendingSubject(item)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <button type="button" onClick={() => { if (origin !== undefined) props.onOpenSubagent(origin); }} className={`min-w-0 truncate rounded font-mono text-[11px] text-shell-ink-soft hover:text-shell-ink-strong ${FOCUS}`}>{who} · {age(data.now - Date.parse(item.request.created_at), locale)}</button>
                        <span className="ml-auto" />
                        {decidable(item) && canDecide ? (
                          <>
                            <button type="button" disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`h-7 rounded border border-shell-hairline px-2.5 font-mono text-[11px] tracking-wider text-shell-ink uppercase hover:bg-shell-hover disabled:opacity-50 ${FOCUS}`}>{copy.reject}</button>
                            <button type="button" disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`h-7 rounded bg-[var(--ck-warn)] px-2.5 font-mono text-[11px] font-bold tracking-wider text-[#2a1408] uppercase hover:brightness-110 disabled:opacity-50 ${FOCUS}`}>{copy.approve}</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => { props.onReviewPending?.(item.kind, id); }} className={`h-7 rounded bg-[var(--ck-warn)] px-2.5 font-mono text-[11px] font-bold tracking-wider text-[#2a1408] uppercase hover:brightness-110 ${FOCUS}`}>{item.kind === 'question' ? copy.answer : copy.review}</button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="mt-1 font-mono text-[11.5px] text-shell-ink-soft">{copy.bClear}</p>}
          </section>

          {/* Gauges. */}
          <div className="mt-4 grid grid-cols-3">
            <Gauge ratio={ctx} warn={ctx > 0.8} label={copy.context} value={`${Math.round(ctx * 100)}%`} sub={`${tokens(data.contextTokens)}/${tokens(data.contextLimit)}`} />
            <Gauge ratio={data.cacheRate ?? 0} label={copy.cache} value={`${Math.round((data.cacheRate ?? 0) * 100)}%`} />
            <Gauge ratio={(data.byState.running + data.byState.waiting) / Math.max(1, data.agents.length)} label={copy.bInFlight} value={String(data.byState.running + data.byState.waiting)} sub={`/ ${data.agents.length}`} />
          </div>
          <dl className="mt-2 grid grid-cols-3 border-y border-shell-hairline py-2 font-mono text-[11px]">
            <div className="text-center"><dt className="text-shell-ink-soft">{copy.cost}</dt><dd className="text-[15px] text-shell-ink-strong tabular-nums">{money(data.costUsd)}</dd></div>
            <div className="border-x border-shell-hairline text-center"><dt className="text-shell-ink-soft">{copy.compactions}</dt><dd className="text-[15px] text-shell-ink-strong tabular-nums">{data.compactions.length}{lastCompaction !== undefined ? <span className="ml-1 text-[10px] text-shell-ink-soft">{copy.ago(age(data.now - lastCompaction, locale))}</span> : null}</dd></div>
            <div className="text-center"><dt className="text-shell-ink-soft">{copy.turns}</dt><dd className="text-[15px] text-shell-ink-strong tabular-nums">{data.turns ?? '—'}</dd></div>
          </dl>

          {/* The array: every agent a cell, grouped by family. */}
          <h3 className="mt-4 mb-1.5 flex items-center font-mono text-[10.5px] tracking-[0.18em] text-shell-ink-soft uppercase">
            {copy.bArray}<span className="ml-auto tracking-normal normal-case tabular-nums">{data.agents.length}</span>
          </h3>
          <div className="space-y-1.5">
            {FAMILIES.filter((f) => data.byFamily[f] > 0).map((family) => (
              <div key={family} className="flex items-start gap-2">
                <span className="w-14 shrink-0 pt-px font-mono text-[10.5px] text-shell-ink-soft">{copy.family[family]}</span>
                <div className="flex flex-1 flex-wrap gap-[3px]">
                  {data.agents.filter((a) => a.family === family).map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      data-rail-open-agent={agent.id}
                      aria-label={`${agent.label} · ${copy.state[agent.state]}`}
                      title={`${agent.label} · ${copy.state[agent.state]}`}
                      onClick={() => { props.onOpenSubagent(agent.id); }}
                      className={`h-3.5 w-3.5 rounded-[3px] transition-transform hover:scale-125 ${CELL[agent.state]} ${FOCUS}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* In flight, as timers. */}
          <h3 className="mt-5 mb-1 font-mono text-[10.5px] tracking-[0.18em] text-shell-ink-soft uppercase">{copy.bInFlight}</h3>
          <ul className="divide-y divide-shell-hairline">
            {inFlight.map((agent) => (
              <li key={agent.id}>
                <button type="button" data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`flex h-8 w-full items-center gap-2 rounded text-left hover:bg-shell-hover ${FOCUS}`}>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${agent.state === 'waiting' ? 'bg-[var(--ck-warn)]' : 'bg-[var(--ck-go)]'}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-shell-ink-strong">{agent.label}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-shell-ink-soft">{copy.family[agent.family]}</span>
                  <span className={`w-12 shrink-0 text-right font-mono text-[12px] tabular-nums ${agent.state === 'waiting' ? 'text-[var(--ck-warn)]' : 'text-[var(--ck-go)]'}`}>{agent.startedAt !== undefined ? age(data.now - agent.startedAt, locale) : '—'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </VariantShell>
  );
}
