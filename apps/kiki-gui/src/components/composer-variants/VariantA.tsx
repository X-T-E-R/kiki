/**
 * A · 时间线尾部 — a queued prompt is a message that has not gone out yet, so
 * it lives where it will land: at the end of the timeline, as a faint,
 * dashed user bubble with its own actions. The run line sits right above
 * those bubbles (what the agent is doing now, then what comes next).
 *
 *   timeline tail   working line → steering bubble → queued bubbles (≤3, then
 *                   "还有 N 条")
 *   dock            needs-you only (it blocks the turn), one card
 *   in the card     ride-along chips, draft
 *   below the card  connection notice (left), shortcuts (right), and a
 *                   "N 条待发送 ↓" jump when the tail may be off-screen
 */

import { Icon } from '../icons';
import { AttachmentTag, ConnectionNotice, FirstNeedsYou, QueueActions, RunWords, TimingTag, hasConnectionNotice, needsYouRows } from './atoms';
import { COPY } from './copy';
import { ComposerCard, ComposerToolbar, ConversationSheet, DraftInput, ReplyingTo, RideAlongChips, WIDTH_CLASS } from './Shell';
import type { ComposerMockState, MockQueued } from './states';

const VISIBLE = 3;

function QueuedBubble({ item, index, editing }: { readonly item: MockQueued; readonly index: number; readonly editing: boolean }) {
  return (
    <li data-queued-bubble={item.id} className="group/q flex flex-col items-end gap-1">
      <div
        className={`max-w-[80%] rounded-[14px] rounded-br-[6px] border border-dashed px-4 py-2 text-[14px] leading-[1.6] ${
          editing
            ? 'border-selected-ink/50 bg-selected text-selected-ink'
            : 'border-hairline-strong bg-bubble-user/45 text-ink-soft'
        }`}
      >
        <p className="line-clamp-2">{item.text}</p>
      </div>
      <div className="flex min-h-7 flex-wrap items-center justify-end gap-x-2 text-[11.5px] text-ink-faint">
        <span className="font-medium text-section-ink">{editing ? COPY.editingHere : `${COPY.queued} · ${COPY.queueNth(index + 1)}`}</span>
        <TimingTag item={item} />
        <AttachmentTag item={item} />
        <span className={`${index === 0 ? '' : 'opacity-0 group-hover/q:opacity-100 group-focus-within/q:opacity-100 [@media(hover:none)]:opacity-100'} transition-opacity`}>
          <QueueActions compact />
        </span>
      </div>
    </li>
  );
}

function TimelineTail({ state }: { readonly state: ComposerMockState }) {
  const visible = state.queue.slice(0, VISIBLE);
  const hidden = state.queue.length - visible.length;
  const hasRun = state.run !== 'idle' || state.queue.length > 0;
  if (!hasRun && state.steering === undefined) return null;
  return (
    <div data-timeline-tail className="flex flex-col gap-3">
      {hasRun ? (
        <p className="flex min-h-7 items-center text-[12.5px]"><RunWords state={state} /></p>
      ) : null}
      {state.steering !== undefined ? (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[80%] rounded-[14px] rounded-br-[6px] border border-selected-ink/35 bg-selected px-4 py-2 text-[14px] leading-[1.6] text-selected-ink">
            {state.steering}
          </div>
          <p className="flex items-center gap-1.5 text-[11.5px] text-selected-ink">
            <span className="spinner inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-selected-ink/30 border-t-selected-ink" aria-hidden />
            {COPY.steering} · {COPY.steeringHint}
          </p>
        </div>
      ) : null}
      {visible.length > 0 ? (
        <ol aria-label={COPY.queuedCount(state.queue.length)} className="flex flex-col gap-2.5">
          {visible.map((item, index) => (
            <QueuedBubble key={item.id} item={item} index={index} editing={state.editingIndex === index} />
          ))}
        </ol>
      ) : null}
      {hidden > 0 ? (
        <button type="button" className="self-end rounded-md px-2 py-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
          {COPY.moreQueued(hidden)}
        </button>
      ) : null}
    </div>
  );
}

function NeedsYouDock({ state }: { readonly state: ComposerMockState }) {
  const rows = needsYouRows(state);
  if (rows.length === 0) return null;
  return (
    <div className="shrink-0 px-6 pb-2 max-sm:px-3">
      <section aria-label={COPY.needsYou} className={`${WIDTH_CLASS} rounded-[14px] bg-panel shadow-[var(--kiki-sheet-shadow)]`}>
        <header className="flex items-center gap-2 px-3.5 pt-2.5 text-[13px]">
          <span aria-hidden className="status-dot-busy h-1.5 w-1.5 rounded-full bg-attention" />
          <span className="font-medium text-ink">{COPY.needsYou}</span>
          <span className="text-ink-faint">
            {[state.approvals.length > 0 ? COPY.approvalsN(state.approvals.length) : null, state.questions.length > 0 ? COPY.questionsN(state.questions.length) : null].filter(Boolean).join(' · ')}
          </span>
        </header>
        <div className="max-h-[38vh] overflow-y-auto px-3.5 pt-1.5 pb-2.5"><FirstNeedsYou state={state} /></div>
        {rows.length > 1 ? (
          <ul className="border-t border-hairline px-1.5 py-1">
            {rows.slice(1).map((row) => (
              <li key={row.id}>
                <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                  <span className="shrink-0 text-[12px] font-medium text-ink-soft">{row.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-faint">{row.origin === undefined ? '' : `${COPY.fromAgent(row.origin)} · `}{row.text}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

export function VariantA({ state }: { readonly state: ComposerMockState }) {
  const hint = state.draft.trim() !== '' && state.run !== 'idle' ? `${COPY.shortcutQueue} · ${COPY.shortcutSteer}` : state.queue.length > 0 ? COPY.shortcutEdit : '';
  return (
    <ConversationSheet
      state={state}
      tail={<TimelineTail state={state} />}
      dock={<NeedsYouDock state={state} />}
      composer={
        <>
          <ReplyingTo state={state} />
          <ComposerCard>
            <RideAlongChips state={state} />
            <DraftInput state={state} />
            <ComposerToolbar state={state} />
          </ComposerCard>
          <div className={`${WIDTH_CLASS} mt-1.5 flex min-h-5 items-center gap-3 px-1 text-[12px] text-ink-faint`}>
            {hasConnectionNotice(state) ? <ConnectionNotice state={state} inline /> : null}
            {state.sentAnnotations > 0 ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                <Icon name="edit" size={12} /> {COPY.notes} {state.sentAnnotations + state.annotations.length}
              </button>
            ) : null}
            <span className="ml-auto truncate max-sm:hidden">{hint}</span>
            {state.queue.length > 0 ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-section-ink hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                {COPY.jumpToQueue(state.queue.length)} <Icon name="arrowDown" size={12} />
              </button>
            ) : null}
          </div>
        </>
      }
    />
  );
}
