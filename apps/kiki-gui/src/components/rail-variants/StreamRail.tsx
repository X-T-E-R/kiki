/**
 * Variant D · Companion stream. The rail reads the conversation back as
 * chapters: each of your messages is a heading, and under it what the
 * session did in response (who was dispatched, who reported back, where the
 * context was compacted). Newest chapter on top, with the live edge (what
 * main is saying, what waits on you) pinned above it.
 */

import { useMemo } from 'react';

import { useI18n } from '../../i18n';
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
  type RailPrompt,
} from './model';
import type { VariantProps } from './RailSwitch';
import { CloseButton, FOCUS_RING, StateMark, VariantPicker, VariantShell, useDecide } from './shell';

interface Chapter {
  readonly prompt: RailPrompt;
  readonly dispatched: FleetAgent[];
  readonly returned: FleetAgent[];
  readonly compactions: number[];
}

/** Index of the last prompt at or before `t`; -1 when earlier than all. */
function chapterOf(prompts: readonly RailPrompt[], t: number): number {
  let found = -1;
  for (let i = 0; i < prompts.length; i += 1) if (prompts[i]!.at <= t) found = i;
  return found;
}

function AgentPill({ agent, onOpen }: { agent: FleetAgent; onOpen: (id: string) => void }) {
  const tone = FAMILY_TONE[agent.family];
  return (
    <button
      type="button"
      data-rail-open-agent={agent.id}
      title={agent.description ?? agent.label}
      onClick={() => { onOpen(agent.id); }}
      className={`inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2 font-mono text-[11.5px] transition-colors ${agent.state === 'waiting' ? 'border-attention bg-attention-soft text-attention' : `border-hairline ${tone.soft} text-ink hover:border-hairline-strong`} ${FOCUS_RING}`}
    >
      <StateMark state={agent.state} className="h-1.5 w-1.5" />
      <span className="truncate">{agent.label}</span>
    </button>
  );
}

export function StreamRail(props: VariantProps) {
  const { locale } = useI18n();
  const copy = railCopy(locale);
  const data = useRailData(props.state, props.forest, props.sessionPending ?? []);
  const { sending, decide, canDecide } = useDecide(props.onResolveApproval);

  const { chapters, earlierAgents, earlierCompactions } = useMemo(() => {
    const list: Chapter[] = data.prompts.map((prompt) => ({ prompt, dispatched: [], returned: [], compactions: [] }));
    let agentsBefore = 0;
    for (const agent of data.agents) {
      const s = agent.startedAt === undefined ? -1 : chapterOf(data.prompts, agent.startedAt);
      if (s >= 0) list[s]!.dispatched.push(agent);
      else agentsBefore += 1;
      if (agent.endedAt !== undefined && agent.state !== 'running' && agent.state !== 'waiting') {
        const e = chapterOf(data.prompts, agent.endedAt);
        if (e >= 0 && e !== s) list[e]!.returned.push(agent);
      }
    }
    let compactionsBefore = 0;
    for (const t of data.compactions) {
      const c = chapterOf(data.prompts, t);
      if (c >= 0) list[c]!.compactions.push(t);
      else compactionsBefore += 1;
    }
    return { chapters: list.toReversed(), earlierAgents: agentsBefore, earlierCompactions: compactionsBefore };
  }, [data.agents, data.prompts, data.compactions]);
  const ctx = data.contextTokens !== undefined && data.contextLimit !== undefined ? data.contextTokens / data.contextLimit : undefined;
  return (
    <VariantShell className={props.className} variant={props.variant} minWidth={360}>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="font-display text-[18px] text-ink italic">{copy.dTitle}</h2>
        <span className="ml-auto" />
        <VariantPicker variant={props.variant} onChoose={props.onChooseVariant} />
        <CloseButton onClose={props.onClose} />
      </header>

      {/* Live edge: context as a thin ribbon with its compaction history, main's words, what waits. */}
      <div className="shrink-0 px-4 pb-3">
        <div className="flex items-baseline gap-2 font-mono text-[11px] text-ink-faint tabular-nums">
          <span>{copy.context}</span>
          <span className="text-ink-soft">{tokens(data.contextTokens)} / {tokens(data.contextLimit)}</span>
          <span className="ml-auto">{data.compactions.length} {copy.compactions} · {money(data.costUsd)}</span>
        </div>
        <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-hairline">
          <span className="absolute inset-y-0 left-0 rounded-full bg-section-ink" style={{ width: `${Math.round((ctx ?? 0) * 100)}%` }} />
        </div>
        {data.mainSaying !== undefined ? (
          <button type="button" onClick={props.onInspectMain} className={`mt-3 block w-full rounded-lg border-l-[3px] border-success bg-paper px-3 py-2 text-left ${FOCUS_RING}`}>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-faint"><StateMark state={data.mainBusy ? 'running' : 'done'} className="h-1.5 w-1.5" />{copy.dMainSays}</span>
            <span className="mt-0.5 line-clamp-2 block font-display text-[14.5px] leading-6 text-ink">{data.mainSaying}</span>
          </button>
        ) : null}
        {data.pending.map((item) => {
          const id = pendingId(item);
          const origin = item.originAgentId;
          const who = origin !== undefined ? (props.forest.byId[origin]?.label ?? origin) : copy.main;
          const busy = sending.has(id);
          return (
            <div key={id} data-needs-you-item={id} className="mt-2 flex items-center gap-2 rounded-lg bg-attention-soft px-3 py-2">
              <span className="min-w-0 flex-1">
                <button type="button" onClick={() => { if (origin !== undefined) props.onOpenSubagent(origin); }} className={`block max-w-full truncate rounded font-mono text-[11.5px] font-semibold text-attention hover:underline ${FOCUS_RING}`}>{who}</button>
                <span className="block truncate font-mono text-[11.5px] text-ink-soft" title={pendingSubject(item)}>{pendingSubject(item)}</span>
              </span>
              {decidable(item) && canDecide ? (
                <>
                  <button type="button" disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`h-7 shrink-0 rounded-md bg-attention px-2.5 text-[12px] font-semibold text-on-accent hover:bg-accent-deep disabled:opacity-50 ${FOCUS_RING}`}>{copy.approve}</button>
                  <button type="button" disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`h-7 shrink-0 rounded-md px-1.5 text-[12px] text-ink-soft hover:text-danger disabled:opacity-50 ${FOCUS_RING}`}>{copy.reject}</button>
                </>
              ) : (
                <button type="button" onClick={() => { props.onReviewPending?.(item.kind, id); }} className={`h-7 shrink-0 rounded-md bg-attention px-2.5 text-[12px] font-semibold text-on-accent hover:bg-accent-deep ${FOCUS_RING}`}>{item.kind === 'question' ? copy.answer : copy.review}</button>
              )}
            </div>
          );
        })}
      </div>

      <div data-agent-panel-scroll className="min-h-0 flex-1 overflow-y-auto border-t border-hairline px-4 pb-5">
        <ol className="relative">
          <span aria-hidden className="absolute top-0 bottom-0 left-[5px] w-px bg-hairline-strong" />
          {chapters.map((chapter, index) => {
            const quiet = chapter.dispatched.length === 0 && chapter.returned.length === 0 && chapter.compactions.length === 0;
            return (
              <li key={chapter.prompt.id} className="relative pt-4 pl-6">
                <span aria-hidden className={`absolute top-[22px] left-0 h-[11px] w-[11px] rounded-full ring-4 ring-panel ${index === 0 ? 'bg-accent' : 'bg-hairline-strong'}`} />
                <p className="flex items-baseline gap-2 text-[11px] text-ink-faint">
                  <span className="font-semibold text-section-ink">{copy.dYou}</span>
                  <span className="tabular-nums">{age(data.now - chapter.prompt.at, locale)}</span>
                </p>
                <p className={`mt-0.5 font-display leading-6 text-ink ${index === 0 ? 'text-[16px]' : 'line-clamp-2 text-[14px]'}`}>{chapter.prompt.text}</p>
                {chapter.compactions.map((t) => (
                  <p key={t} className="mt-2 flex items-center gap-2 text-[11.5px] text-section-ink">
                    <span className="h-px flex-1 border-t border-dashed border-section-ink/50" />{copy.dCompacted}<span className="h-px flex-1 border-t border-dashed border-section-ink/50" />
                  </p>
                ))}
                {chapter.dispatched.length > 0 ? (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] text-ink-faint">{copy.dDispatched(chapter.dispatched.length)}</p>
                    <div className="flex flex-wrap gap-1">{chapter.dispatched.map((agent) => <AgentPill key={agent.id} agent={agent} onOpen={props.onOpenSubagent} />)}</div>
                  </div>
                ) : null}
                {chapter.returned.length > 0 ? (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] text-ink-faint">{copy.dReturned(chapter.returned.length)}</p>
                    <ul className="space-y-1">
                      {chapter.returned.slice(0, index === 0 ? 6 : 3).map((agent) => (
                        <li key={agent.id}>
                          <button type="button" data-rail-open-agent={agent.id} onClick={() => { props.onOpenSubagent(agent.id); }} className={`flex w-full items-baseline gap-2 rounded text-left hover:bg-ink/[0.03] ${FOCUS_RING}`}>
                            <StateMark state={agent.state} className="h-1.5 w-1.5 translate-y-[-1px]" />
                            <span className={`shrink-0 font-mono text-[11.5px] ${FAMILY_TONE[agent.family].text}`}>{agent.label}</span>
                            <span className="min-w-0 truncate text-[12px] text-ink-soft">{agent.summary ?? agent.error ?? ''}</span>
                          </button>
                        </li>
                      ))}
                      {chapter.returned.length > (index === 0 ? 6 : 3) ? <li className="text-[11.5px] text-ink-faint">+{chapter.returned.length - (index === 0 ? 6 : 3)}</li> : null}
                    </ul>
                  </div>
                ) : null}
                {quiet ? <p className="mt-1 text-[11.5px] text-ink-faint">{copy.dQuiet}</p> : null}
              </li>
            );
          })}
          {earlierAgents + earlierCompactions > 0 ? (
            <li className="relative pt-4 pl-6 text-[12px] text-ink-faint">
              <span aria-hidden className="absolute top-[22px] left-[1px] h-[9px] w-[9px] rounded-full border border-hairline-strong bg-panel" />
              {copy.dEarlier(earlierAgents, earlierCompactions)}
            </li>
          ) : null}
        </ol>
      </div>
    </VariantShell>
  );
}
