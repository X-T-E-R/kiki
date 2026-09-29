/**
 * B · 一条状态带 — every "what is going on" fact shares one band fused to the
 * top of the composer card: run state, queue, needs-you, connection. At rest
 * it is a single line of segments; each segment discloses its own detail
 * inside the card, above the band. Needs-you forces its detail open (it
 * blocks the turn) and tints the band with the attention wash.
 *
 *   band segments   [run] [queue] [needs-you] [notes] … [connection]
 *                   left to right by permanence; the band never wraps — on
 *                   narrow widths queue and notes fold to counts
 *   priority        needs-you open > queue open (editing) > closed
 *   in the card     ride-along chips, draft, toolbar
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { AttachmentTag, ConnectionNotice, FirstNeedsYou, QueueActions, RunWords, TimingTag, hasConnectionNotice, needsYouRows } from './atoms';
import { COPY } from './copy';
import { ComposerCard, ComposerToolbar, ConversationSheet, DraftInput, ReplyingTo, RideAlongChips } from './Shell';
import { needsYouCount, type ComposerMockState } from './states';

function Segment({ children, open = false, tone = 'plain', label }: {
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly tone?: 'plain' | 'attention';
  readonly label: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:h-9 ${
        tone === 'attention'
          ? 'font-medium text-attention hover:bg-attention/10'
          : 'text-ink-soft hover:bg-ink/[0.05] hover:text-ink'
      } ${open ? (tone === 'attention' ? 'bg-attention/10' : 'bg-ink/[0.05] text-ink') : ''}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-hairline-strong/70" />;
}

function QueueDetail({ state }: { readonly state: ComposerMockState }) {
  return (
    <ol aria-label={COPY.queuedCount(state.queue.length)} className="flex flex-col">
      {state.queue.map((item, index) => (
        <li key={item.id} className="group/q flex min-h-9 items-center gap-2 rounded-md px-1.5 hover:bg-ink/[0.03]">
          <span className="w-4 shrink-0 text-right text-[11.5px] text-ink-faint tabular-nums">{index + 1}</span>
          <span className={`min-w-0 flex-1 truncate text-[13px] ${state.editingIndex === index ? 'text-selected-ink' : 'text-ink'}`}>{item.text}</span>
          <TimingTag item={item} />
          <AttachmentTag item={item} />
          <span className="opacity-0 transition-opacity group-hover/q:opacity-100 group-focus-within/q:opacity-100 [@media(hover:none)]:opacity-100">
            <QueueActions compact />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function VariantB({ state }: { readonly state: ComposerMockState }) {
  const pending = needsYouCount(state);
  const openDetail: 'needs' | 'queue' | null = pending > 0 ? 'needs' : state.editingIndex !== undefined ? 'queue' : null;
  const running = state.run !== 'idle';
  const firstQueued = state.queue[0];
  const notes = state.annotations.length + state.sentAnnotations;
  const hasBand = running || state.queue.length > 0 || pending > 0 || hasConnectionNotice(state) || notes > 0 || state.steering !== undefined;
  const rows = needsYouRows(state);

  const band = hasBand ? (
    <div
      data-status-band
      className={`flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-t-[18px] px-2 py-1 ${
        pending > 0 ? 'bg-attention-soft/70' : 'bg-ink/[0.025]'
      }`}
    >
      {running || state.queue.length > 0 ? (
        <span className="flex h-7 min-w-[3.5rem] shrink items-center overflow-hidden px-2 text-[12.5px]"><RunWords state={state} /></span>
      ) : null}
      {state.steering !== undefined ? (
        <>
          <span className="max-sm:hidden"><Divider /></span>
          <span className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-[12.5px] text-selected-ink max-sm:hidden">
            <span className="spinner inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-selected-ink/30 border-t-selected-ink" aria-hidden />
            {COPY.steering}
          </span>
        </>
      ) : null}
      {state.queue.length > 0 ? (
        <>
          <Divider />
          <Segment label={COPY.queuedCount(state.queue.length)} open={openDetail === 'queue'}>
            <span className="shrink-0 font-medium text-section-ink tabular-nums">
              <span className="max-sm:hidden">{COPY.queuedCount(state.queue.length)}</span>
              <span className="sm:hidden">{COPY.queued} {state.queue.length}</span>
            </span>
            {firstQueued !== undefined && pending === 0 ? (
              <span className="min-w-0 truncate text-ink-faint max-sm:hidden">· {firstQueued.text}</span>
            ) : null}
            <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint ${openDetail === 'queue' ? '-rotate-90' : 'rotate-90'}`} />
          </Segment>
        </>
      ) : null}
      {pending > 0 ? (
        <>
          <Divider />
          <Segment label={COPY.needsYou} open tone="attention">
            <LifeMark markId="preview-needs" life="waiting" tone="bg-attention" />
            <span className="shrink-0">{COPY.needsYouN(pending)}</span>
          </Segment>
        </>
      ) : null}
      <span className="flex-1" />
      {notes > 0 && !(pending > 0 && hasConnectionNotice(state)) ? (
        <Segment label={COPY.notes}>
          <Icon name="edit" size={12} className="text-ink-faint" />
          <span className="tabular-nums">{notes}</span>
        </Segment>
      ) : null}
      {hasConnectionNotice(state) ? <span className="min-w-0 max-w-[45%] shrink px-1"><ConnectionNotice state={state} inline iconOnlyNarrow /></span> : null}
    </div>
  ) : null;

  let detail: ReactNode = null;
  if (openDetail === 'needs') {
    detail = (
      <div className="border-b border-hairline px-3.5 pt-2 pb-2.5">
        <div className="max-h-[36vh] overflow-y-auto"><FirstNeedsYou state={state} /></div>
        {rows.length > 1 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px] text-ink-faint">
            <span>{COPY.nOfM(1, rows.length)}</span>
            {rows.slice(1).map((row) => (
              <button key={row.id} type="button" className="max-w-[16rem] truncate rounded-md px-1.5 py-0.5 text-ink-soft hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                {row.kind} · {row.origin === undefined ? '' : `${row.origin} · `}{row.text}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  } else if (openDetail === 'queue') {
    detail = (
      <div className="border-b border-hairline px-2 pt-1.5 pb-1.5">
        <p className="px-1.5 pb-1 text-[12px] text-amber-ink">{COPY.holdNotice}</p>
        <QueueDetail state={state} />
      </div>
    );
  }

  return (
    <ConversationSheet
      state={state}
      composer={
        <>
          <ReplyingTo state={state} />
          <ComposerCard tone={pending > 0 ? 'attention' : 'plain'}>
            {band}
            {detail}
            <RideAlongChips state={state} />
            <DraftInput state={state} />
            <ComposerToolbar state={state} />
          </ComposerCard>
          <p className="mx-auto mt-1.5 h-4 max-w-[760px] truncate text-center text-[12px] text-ink-faint">
            {running && state.draft.trim() !== '' ? `${COPY.shortcutQueue} · ${COPY.shortcutSteer}` : ''}
          </p>
        </>
      }
    />
  );
}
