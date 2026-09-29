/**
 * D · 输入框接管 — the composer card holds one thing at a time. When something
 * needs you, the card itself turns into that decision (the draft is kept and
 * shown as one line); otherwise it is the input. The queue is a short stack
 * of sheets tucked behind the card's top edge — the next prompt readable on
 * the front sheet, further ones as slivers behind it. Run state moves to the
 * line under the card, where the key hints used to be.
 *
 *   card            decision (needs-you) > input; "N / M" steps through items
 *   behind the card queue stack: front sheet = next prompt + actions, ≤2
 *                   slivers for the rest, count on the right
 *   under the card  run line (left) · connection · notes (right)
 *   in the toolbar  unchanged; stop stays next to send
 */

import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { ConnectionNotice, FirstNeedsYou, QueueActions, RunWords, TimingTag, hasConnectionNotice, needsYouRows } from './atoms';
import { COPY } from './copy';
import { ComposerCard, ComposerToolbar, ConversationSheet, DraftInput, ReplyingTo, RideAlongChips, WIDTH_CLASS } from './Shell';
import { needsYouCount, type ComposerMockState } from './states';

function QueueStack({ state }: { readonly state: ComposerMockState }) {
  const first = state.queue[0];
  if (first === undefined && state.steering === undefined) return null;
  const slivers = Math.min(2, Math.max(0, state.queue.length - 1));
  return (
    <div data-queue-stack className={`${WIDTH_CLASS} relative px-4`}>
      {Array.from({ length: slivers }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="h-[5px] rounded-t-[10px] border border-b-0 border-hairline bg-panel/70"
          style={{ marginInline: `${(slivers - index) * 10}px` }}
        />
      ))}
      <div className="flex min-h-10 items-center gap-2 rounded-t-[12px] border border-b-0 border-hairline bg-panel/90 pt-1 pr-1.5 pb-3 pl-3 text-[12.5px]">
        {state.steering !== undefined ? (
          <>
            <span className="shrink-0 font-medium text-selected-ink">{COPY.steering}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{state.steering}</span>
            {state.queue.length > 0 ? <span className="shrink-0 text-ink-faint">{COPY.queuedCount(state.queue.length)}</span> : null}
          </>
        ) : first !== undefined ? (
          <>
            <span className="shrink-0 font-medium text-section-ink">{state.editingIndex === 0 ? COPY.editingHere : '下一条'}</span>
            <span className="min-w-0 flex-1 truncate text-ink-soft">{first.text}</span>
            <TimingTag item={first} />
            <span className="max-sm:hidden"><QueueActions compact /></span>
            {state.queue.length > 1 ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-soft tabular-nums hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                {COPY.queuedCount(state.queue.length)}
                <Icon name="chevron" size={12} className="-rotate-90 text-ink-faint" />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function DecisionCard({ state }: { readonly state: ComposerMockState }) {
  const rows = needsYouRows(state);
  const firstLine = state.draft.split('\n')[0] ?? '';
  return (
    <div data-card-decision>
      <header className="flex min-h-10 items-center gap-2 px-3.5 pt-2 text-[12.5px]">
        <LifeMark markId="preview-needs-d" life="waiting" tone="bg-attention" />
        <span className="font-medium text-attention">{COPY.needsYou}</span>
        {rows.length > 1 ? (
          <span className="flex items-center gap-0.5 text-ink-faint tabular-nums">
            {COPY.nOfM(1, rows.length)}
            <button type="button" aria-label="下一项" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
              <Icon name="chevron" size={12} />
            </button>
          </span>
        ) : null}
        <span className="flex-1" />
        {state.approvals.length > 1 ? (
          <button type="button" className="rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">{COPY.approveAll}</button>
        ) : null}
      </header>
      <div className="max-h-[40vh] overflow-y-auto px-3.5 pb-2"><FirstNeedsYou state={state} /></div>
      <button
        type="button"
        className="flex min-h-10 w-full items-center gap-2 border-t border-hairline px-3.5 text-left text-[12.5px] text-ink-faint hover:bg-ink/[0.025] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded-b-[18px]"
      >
        <Icon name="edit" size={12} />
        <span className="shrink-0">{firstLine === '' ? COPY.backToInput : COPY.draftKept}</span>
        {firstLine === '' ? null : <span className="min-w-0 flex-1 truncate text-ink-soft">{firstLine}</span>}
        {state.attachments.length + state.annotations.length > 0 ? (
          <span className="shrink-0">+{state.attachments.length + state.annotations.length}</span>
        ) : null}
        {firstLine === '' ? null : <span className="ml-auto shrink-0 font-medium text-ink-soft">{COPY.backToInput}</span>}
      </button>
    </div>
  );
}

export function VariantD({ state }: { readonly state: ComposerMockState }) {
  const deciding = needsYouCount(state) > 0;
  const notes = state.annotations.length + state.sentAnnotations;
  return (
    <ConversationSheet
      state={state}
      composer={
        <>
          <ReplyingTo state={state} />
          <QueueStack state={state} />
          <ComposerCard tone={deciding ? 'attention' : 'plain'} attrs={{ 'data-card-mode': deciding ? 'decision' : 'input' }}>
            {deciding ? (
              <DecisionCard state={state} />
            ) : (
              <>
                <RideAlongChips state={state} />
                <DraftInput state={state} />
                <ComposerToolbar state={state} />
              </>
            )}
          </ComposerCard>
          <div className={`${WIDTH_CLASS} mt-1.5 flex min-h-5 items-center gap-3 px-2 text-[12px]`}>
            <RunWords state={state} />
            {state.run === 'idle' && state.queue.length === 0 && !hasConnectionNotice(state) ? (
              <span className="truncate text-ink-faint">{state.draft === '' ? COPY.footerHint : ''}</span>
            ) : null}
            <span className="flex-1" />
            <span className="min-w-0 shrink"><ConnectionNotice state={state} inline iconOnlyNarrow /></span>
            {deciding && state.run !== 'idle' ? (
              <button type="button" aria-label={COPY.stop} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-danger hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none">
                <Icon name="stop" size={12} /> {COPY.stop}
              </button>
            ) : null}
            {notes > 0 ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                <Icon name="edit" size={12} /> {COPY.notes} {notes}
              </button>
            ) : null}
          </div>
        </>
      }
    />
  );
}
