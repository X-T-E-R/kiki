/**
 * Variant A · Battle map. The rail is a clock: one shared time axis, every
 * agent a lane, grouped by model family. Running bars reach the "now" line,
 * waiting lanes open in place with their decision, compactions and your own
 * messages are drawn across all lanes so cause and effect line up.
 */

import { useMemo } from 'react';

import { useI18n } from '../../i18n';
import { railCopy } from './copy';
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
  type FleetAgent,
  type PendingItem,
} from './model';
import type { VariantProps } from './RailSwitch';
import { CloseButton, FOCUS_RING, StateMark, VariantPicker, VariantShell, useDecide } from './shell';

const WINDOW_HOURS = 6;
const WINDOW_MS = WINDOW_HOURS * 3_600_000;
const LABEL_W = 'w-[124px]';

const BAR: Record<FleetAgent['state'], string> = {
  running: 'bg-success',
  waiting: 'bg-attention',
  done: '',
  failed: 'bg-danger/70',
  stopped: 'bg-ink-faint/40',
};

export function SwimlaneRail(props: VariantProps) {
  const { locale } = useI18n();
  const copy = railCopy(locale);
  const data = useRailData(props.state, props.forest, props.sessionPending ?? []);
  const { sending, decide, canDecide } = useDecide(props.onResolveApproval);
  const start = data.now - WINDOW_MS;
  const x = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / WINDOW_MS) * 100))}%`;

  const { bands, earlier } = useMemo(() => {
    const live = (a: FleetAgent) => a.state === 'running' || a.state === 'waiting';
    const inWindow = data.agents.filter((a) => live(a) || (a.endedAt ?? data.now) >= start);
    const rank = (a: FleetAgent) => (a.state === 'waiting' ? 0 : a.state === 'running' ? 1 : 2);
    const grouped = FAMILIES.map((family) => ({
      family,
      rows: inWindow
        .filter((a) => a.family === family)
        .toSorted((l, r) => rank(l) - rank(r) || (r.endedAt ?? data.now) - (l.endedAt ?? data.now)),
    })).filter((band) => band.rows.length > 0);
    return { bands: grouped, earlier: data.agents.length - inWindow.length };
  }, [data.agents, data.now, start]);

  const pendingByAgent = useMemo(() => {
    const map = new Map<string, PendingItem[]>();
    for (const item of data.pending) {
      const origin = item.originAgentId ?? 'main';
      map.set(origin, [...(map.get(origin) ?? []), item]);
    }
    return map;
  }, [data.pending]);
  const mainPending = pendingByAgent.get('main') ?? [];

  const ticks = Array.from({ length: WINDOW_HOURS + 1 }, (_, i) => data.now - (WINDOW_HOURS - i) * 3_600_000);
  const compactions = data.compactions.filter((t) => t >= start);
  const prompts = data.prompts.filter((p) => p.at >= start);
  const ctxRatio = data.contextTokens !== undefined && data.contextLimit !== undefined ? data.contextTokens / data.contextLimit : undefined;

  const decisionLine = (item: PendingItem) => {
    const id = pendingId(item);
    const busy = sending.has(id);
    return (
      <div key={id} data-needs-you-item={id} className="mt-1 mb-1.5 ml-[132px] rounded-md border-l-2 border-attention bg-attention-soft px-2 py-1.5">
        <p className="truncate font-mono text-[11.5px] text-ink" title={pendingSubject(item)}>
          <span className="mr-1.5 font-sans font-semibold text-attention">{item.kind === 'approval' ? item.request.tool_name : '?'}</span>
          {pendingSubject(item)}
        </p>
        <div className="mt-1 flex items-center gap-1">
          {decidable(item) && canDecide ? (
            <>
              <button type="button" disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`h-6 rounded bg-attention px-2 text-[12px] font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50 ${FOCUS_RING}`}>{copy.approve}</button>
              <button type="button" disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`h-6 rounded px-2 text-[12px] text-ink-soft hover:bg-danger/10 hover:text-danger disabled:opacity-50 ${FOCUS_RING}`}>{copy.reject}</button>
            </>
          ) : (
            <button type="button" onClick={() => { props.onReviewPending?.(item.kind, id); }} className={`h-6 rounded bg-attention px-2 text-[12px] font-semibold text-on-accent hover:bg-accent-deep ${FOCUS_RING}`}>{item.kind === 'question' ? copy.answer : copy.review}</button>
          )}
          <span className="ml-auto text-[11px] text-attention tabular-nums">{age(data.now - Date.parse(item.kind === 'approval' ? item.request.created_at : item.request.created_at), locale)}</span>
        </div>
      </div>
    );
  };
  // Vertical rules shared by every lane: hour ticks, compactions, your messages, now.
  const overlay = (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-[132px]">
      {ticks.map((t) => <span key={t} className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: x(t) }} />)}
      {compactions.map((t) => <span key={t} className="absolute inset-y-0 w-0 border-l border-dashed border-section-ink/60" style={{ left: x(t) }} />)}
      {prompts.map((p) => <span key={p.id} className="absolute inset-y-0 w-px bg-accent/15" style={{ left: x(p.at) }} />)}
      <span className="absolute inset-y-0 w-[2px] -translate-x-px bg-ink" style={{ left: '100%' }} />
    </div>
  );

  return (
    <VariantShell className={props.className} variant={props.variant} minWidth={380}>
      <header className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex h-7 items-center gap-2">
          <h2 className="font-display text-[19px] leading-none tracking-tight text-ink">{copy.aTitle}</h2>
          <span className="text-[12px] text-ink-faint">{copy.aWindow(WINDOW_HOURS)}</span>
          <span className="ml-auto" />
          <VariantPicker variant={props.variant} onChoose={props.onChooseVariant} />
          <CloseButton onClose={props.onClose} />
        </div>
        {/* The fleet in one sentence of numbers. */}
        <dl className="mt-2 grid grid-cols-4 gap-2">
          {(['waiting', 'running', 'done', 'failed'] as const).map((key) => (
            <div key={key} className={`rounded-lg px-2 py-1.5 ${key === 'waiting' && data.byState.waiting > 0 ? 'bg-attention-soft' : 'bg-ink/[0.035]'}`}>
              <dt className="flex items-center gap-1.5 text-[11px] text-ink-faint"><StateMark state={key} className="h-1.5 w-1.5" />{copy.state[key]}</dt>
              <dd className={`font-display text-[22px] leading-7 tabular-nums ${key === 'waiting' && data.byState.waiting > 0 ? 'text-attention' : 'text-ink'}`}>{data.byState[key]}</dd>
            </div>
          ))}
        </dl>
      </header>

      {/* Axis: hours, then the main agent's own lane with its context meter. */}
      <div className="relative shrink-0 border-y border-hairline bg-paper/60 px-4 py-1.5">
        {overlay}
        <div className="relative flex h-4 items-center">
          <span className={`${LABEL_W} shrink-0 text-[11px] text-ink-faint`}>{copy.aLanes}</span>
          <div className="relative h-full flex-1">
            {ticks.map((t, i) => (
              <span key={t} className={`absolute font-mono text-[10px] whitespace-nowrap tabular-nums ${i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full font-semibold text-ink" : "-translate-x-1/2 text-ink-faint"} ${i === 0 ? "text-ink-faint" : ""}`} style={{ left: x(t) }}>
                {i === ticks.length - 1 ? copy.now : `-${WINDOW_HOURS - i}h`}
              </span>
            ))}
          </div>
        </div>
        <button type="button" onClick={props.onInspectMain} className={`relative mt-1 flex w-full items-center rounded text-left ${FOCUS_RING}`}>
          <span className={`${LABEL_W} flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink`}>
            <StateMark state={data.mainBusy ? 'running' : 'done'} />{copy.main}
          </span>
          <span className="relative h-3 flex-1">
            <span className="absolute inset-y-0 left-0 right-0 rounded-sm bg-ink/80" />
            {compactions.map((t) => <span key={t} className="absolute inset-y-[-3px] w-[3px] rounded-sm bg-section-ink" style={{ left: x(t) }} title={copy.aCompaction} />)}
            {prompts.map((p) => <span key={p.id} className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-paper" style={{ left: x(p.at) }} title={p.text} />)}
          </span>
        </button>
        <div className="relative mt-1.5 flex items-center text-[11px] text-ink-faint">
          <span className={`${LABEL_W} shrink-0`}>{copy.context}</span>
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-hairline">
            <span className={`absolute inset-y-0 left-0 rounded-full ${ctxRatio !== undefined && ctxRatio > 0.8 ? 'bg-attention' : 'bg-section-ink'}`} style={{ width: `${Math.round((ctxRatio ?? 0) * 100)}%` }} />
          </span>
          <span className="ml-2 shrink-0 font-mono tabular-nums text-ink-soft">{tokens(data.contextTokens)}/{tokens(data.contextLimit)}</span>
        </div>
        {mainPending.map(decisionLine)}
      </div>

      <div data-agent-panel-scroll className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {bands.map((band) => (
          <section key={band.family} className="relative pt-2.5">
            {overlay}
            <h3 className="relative mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-section-ink uppercase">
              <span className={`h-2 w-2 rounded-sm ${FAMILY_TONE[band.family].fill}`} />
              {copy.family[band.family]}
              <span className="font-normal text-ink-faint tabular-nums">{band.rows.length}</span>
            </h3>
            <ul className="relative">
              {band.rows.map((agent) => {
                const begin = agent.startedAt ?? start;
                const end = agent.state === 'running' || agent.state === 'waiting' ? data.now : (agent.endedAt ?? data.now);
                const done = agent.state === 'done';
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      data-rail-open-agent={agent.id}
                      onClick={() => { props.onOpenSubagent(agent.id); }}
                      title={`${agent.label} · ${agent.description ?? ''}`}
                      className={`group flex h-[22px] w-full items-center rounded text-left hover:bg-ink/[0.04] ${FOCUS_RING}`}
                    >
                      <span className={`${LABEL_W} flex shrink-0 items-center gap-1.5 pr-1`} style={{ paddingLeft: agent.depth * 8 }}>
                        <StateMark state={agent.state} className="h-1.5 w-1.5" />
                        <span className={`truncate font-mono text-[11.5px] ${agent.state === 'waiting' ? 'font-semibold text-attention' : done ? 'text-ink-soft' : 'text-ink'} group-hover:text-ink`}>{agent.label}</span>
                      </span>
                      <span className="relative h-full flex-1">
                        <span
                          className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full ${done ? `${FAMILY_TONE[agent.family].fill} opacity-45` : BAR[agent.state]}`}
                          style={{ left: x(begin), width: `max(3px, calc(${x(end)} - ${x(begin)}))` }}
                        />
                        {agent.state === 'running' ? <span className="absolute top-1/2 right-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-success ring-2 ring-panel" /> : null}
                      </span>
                    </button>
                    {(pendingByAgent.get(agent.id) ?? []).map(decisionLine)}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {earlier > 0 ? <p className="mt-3 text-[12px] text-ink-faint">{copy.aEarlier(earlier)}</p> : null}
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-hairline px-4 py-2 text-[11.5px] text-ink-faint">
        <span className="flex items-center gap-1"><span className="h-3 w-0 border-l border-dashed border-section-ink" />{copy.aCompaction} {data.compactions.length}</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{copy.aYou}</span>
        <span className="ml-auto font-mono tabular-nums text-ink-soft">{money(data.costUsd)}</span>
      </footer>
    </VariantShell>
  );
}
