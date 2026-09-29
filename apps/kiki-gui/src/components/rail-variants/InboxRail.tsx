/**
 * Variant C · Inbox first. The rail is a to-do list for the coordinator:
 * a big headline that counts what needs you, one card per decision with the
 * agent's brief and the exact command, then new reports as unread mail, then
 * what did not finish. Everything still running folds into one line at the
 * bottom; context and cost shrink to a footer.
 */

import { useMemo, useState } from 'react';

import { useI18n } from '../../i18n';
import { plainFailure } from '../agent-panel/failureText';
import { railCopy } from './copy';
import {
  FAMILY_TONE,
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
import { CloseButton, FOCUS_RING, StateMark, VariantPicker, VariantShell, useDecide } from './shell';

const REPORT_WINDOW_MS = 60 * 60_000;

function FamilyChip({ agent, label }: { agent: FleetAgent; label: string }) {
  const tone = FAMILY_TONE[agent.family];
  return <span className={`shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold ${tone.soft} ${tone.text}`}>{label}</span>;
}

export function InboxRail(props: VariantProps) {
  const { locale } = useI18n();
  const copy = railCopy(locale);
  const data = useRailData(props.state, props.forest, props.sessionPending ?? []);
  const { sending, decide, canDecide } = useDecide(props.onResolveApproval);
  const [readBefore, setReadBefore] = useState(0);

  const reports = useMemo(
    () => data.agents
      .filter((a) => a.state === 'done' && a.endedAt !== undefined && data.now - a.endedAt < REPORT_WINDOW_MS && a.endedAt > readBefore)
      .toSorted((l, r) => (r.endedAt ?? 0) - (l.endedAt ?? 0)),
    [data.agents, data.now, readBefore],
  );
  const failed = useMemo(
    () => data.agents.filter((a) => a.state === 'failed' || a.state === 'stopped').toSorted((l, r) => (r.endedAt ?? 0) - (l.endedAt ?? 0)).slice(0, 4),
    [data.agents],
  );
  const running = data.agents.filter((a) => a.state === 'running');
  const ctx = data.contextTokens !== undefined && data.contextLimit !== undefined ? data.contextTokens / data.contextLimit : undefined;
  return (
    <VariantShell className={props.className} variant={props.variant} minWidth={360}>
      <header className="shrink-0 px-5 pt-3">
        <div className="flex h-7 items-center">
          <span className="ml-auto" />
          <VariantPicker variant={props.variant} onChoose={props.onChooseVariant} />
          <CloseButton onClose={props.onClose} />
        </div>
        <h2 className={`mt-1 font-display text-[30px] leading-[1.1] tracking-tight ${data.pending.length > 0 ? 'text-attention' : 'text-ink'}`}>
          {copy.cHeadline(data.pending.length)}
        </h2>
        {data.pending.length > 0 && canDecide ? <p className="mt-1 text-[12px] text-ink-faint">{copy.cKeys}</p> : null}
      </header>

      <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">
        {data.pending.length === 0 ? <p className="max-w-[30ch] text-[13.5px] leading-6 text-ink-soft">{copy.cZero}</p> : null}

        <ol className="space-y-2.5">
          {data.pending.map((item, index) => {
            const id = pendingId(item);
            const origin = item.originAgentId;
            const agent = origin !== undefined ? data.agents.find((a) => a.id === origin) : undefined;
            const busy = sending.has(id);
            return (
              <li
                key={id}
                data-needs-you-item={id}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (!decidable(item) || !canDecide || busy) return;
                  if (event.key === 'a') decide(item, 'approved');
                  if (event.key === 'r') decide(item, 'rejected');
                }}
                className={`rounded-xl bg-paper p-3 shadow-[0_0_0_1px_var(--color-hairline)] ${index === 0 ? 'shadow-[0_0_0_1.5px_var(--color-attention)]' : ''} ${FOCUS_RING}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-display text-[15px] text-attention tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                  {agent !== undefined ? (
                    <button type="button" data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`min-w-0 truncate rounded font-mono text-[12.5px] font-semibold text-ink hover:underline ${FOCUS_RING}`}>{agent.label}</button>
                  ) : <span className="text-[12.5px] font-semibold text-ink">{copy.main}</span>}
                  {agent !== undefined ? <FamilyChip agent={agent} label={copy.family[agent.family]} /> : null}
                  <span className="ml-auto shrink-0 text-[11.5px] text-ink-faint tabular-nums">{age(data.now - Date.parse(item.request.created_at), locale)}</span>
                </div>
                {agent?.description !== undefined ? <p className="mt-1 text-[12.5px] leading-5 text-ink-soft">{agent.description}</p> : null}
                <p className="mt-2 rounded-md bg-shell px-2.5 py-2 font-mono text-[12px] leading-5 break-all text-shell-ink-strong">
                  <span className="mr-2 text-shell-ink-soft">{item.kind === 'approval' ? item.request.tool_name : '?'}</span>
                  {pendingSubject(item)}
                </p>
                <div className="mt-2.5 flex gap-2">
                  {decidable(item) && canDecide ? (
                    <>
                      <button type="button" data-needs-you-approve={id} disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`h-9 flex-1 rounded-lg bg-attention text-[13px] font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50 ${FOCUS_RING}`}>{copy.approve}</button>
                      <button type="button" data-needs-you-reject={id} disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`h-9 flex-1 rounded-lg border border-hairline-strong text-[13px] text-ink-soft hover:border-danger/50 hover:text-danger disabled:opacity-50 ${FOCUS_RING}`}>{copy.reject}</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => { props.onReviewPending?.(item.kind, id); }} className={`h-9 flex-1 rounded-lg bg-attention text-[13px] font-semibold text-on-accent hover:bg-accent-deep ${FOCUS_RING}`}>{item.kind === 'question' ? copy.answer : copy.review}</button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {reports.length > 0 ? (
          <section className="mt-6">
            <h3 className="flex items-baseline gap-2 border-b border-hairline pb-1.5">
              <span className="text-[13px] font-semibold text-section-ink">{copy.cReports}</span>
              <span className="rounded-full bg-selected px-1.5 text-[11px] font-semibold text-selected-ink tabular-nums">{reports.length}</span>
              <span className="text-[11.5px] text-ink-faint">{copy.cReportsHint}</span>
              <button type="button" onClick={() => { setReadBefore(data.now); }} className={`ml-auto rounded text-[12px] text-ink-faint hover:text-ink ${FOCUS_RING}`}>{copy.cMarkRead}</button>
            </h3>
            <ul>
              {reports.map((agent) => (
                <li key={agent.id} className="border-b border-hairline/70 last:border-0">
                  <button type="button" data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`flex w-full items-start gap-2.5 rounded py-2 text-left hover:bg-ink/[0.03] ${FOCUS_RING}`}>
                    <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-selected-ink" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-mono text-[12.5px] font-semibold text-ink">{agent.label}</span>
                        <FamilyChip agent={agent} label={copy.family[agent.family]} />
                        <span className="ml-auto shrink-0 text-[11.5px] text-ink-faint tabular-nums">{agent.endedAt !== undefined ? age(data.now - agent.endedAt, locale) : ''}</span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-5 text-ink-soft">{agent.summary ?? agent.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {failed.length > 0 ? (
          <section className="mt-5">
            <h3 className="border-b border-hairline pb-1.5 text-[13px] font-semibold text-section-ink">{copy.cFailed}</h3>
            <ul>
              {failed.map((agent) => (
                <li key={agent.id}>
                  <button type="button" data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`flex w-full items-baseline gap-2 rounded py-1.5 text-left hover:bg-ink/[0.03] ${FOCUS_RING}`}>
                    <StateMark state={agent.state} className="h-2 w-2 translate-y-[-1px]" />
                    <span className="shrink-0 font-mono text-[12px] text-ink">{agent.label}</span>
                    <span className="min-w-0 truncate text-[12px] text-ink-faint">{plainFailure(agent.error) ?? copy.state[agent.state]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-hairline px-5 py-2.5">
        <div className="flex items-center gap-2 text-[12px] text-ink-soft">
          <StateMark state="running" />
          <span>{copy.cInFlight(running.length)}</span>
          <span className="flex -space-x-1">
            {running.slice(0, 8).map((agent) => (
              <button key={agent.id} type="button" title={agent.label} aria-label={agent.label} data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`h-5 w-5 rounded-full text-[9px] font-bold ring-2 ring-panel ${FAMILY_TONE[agent.family].fill} text-panel ${FOCUS_RING}`}>
                {agent.label.slice(0, 1).toUpperCase()}
              </button>
            ))}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] text-ink-faint tabular-nums">
          <span>{copy.context} {ctx !== undefined ? `${Math.round(ctx * 100)}%` : '—'} · {tokens(data.contextTokens)}</span>
          <span>{data.compactions.length} {copy.compactions}</span>
          <span className="ml-auto text-ink-soft">{money(data.costUsd)}</span>
        </div>
      </footer>
    </VariantShell>
  );
}
