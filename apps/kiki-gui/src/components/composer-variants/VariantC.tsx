/**
 * C · Dock 清单 — one dock above the composer holds everything that is not
 * the draft, as labelled sections of a single surface (no card per state).
 * The queue is a real list: numbered, drag handle, edit / remove / steer on
 * every row. The run line is the dock's own header, so "working" and "what
 * comes next" read as one block.
 *
 *   dock header     run line · connection (right)
 *   sections        需要你 (expanded, first) → 待发送 (list, ≤3 rows then
 *                   "还有 N 条") → 批注 (one line)
 *   folding         with needs-you present the queue folds to its header row
 *                   (count + first prompt); the dock caps at 45vh and scrolls
 *   in the card     ride-along chips, draft, toolbar
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { AttachmentTag, ConnectionNotice, FirstNeedsYou, QueueActions, RunWords, TimingTag, hasConnectionNotice, needsYouRows } from './atoms';
import { COPY } from './copy';
import { ComposerCard, ComposerToolbar, ConversationSheet, DraftInput, ReplyingTo, RideAlongChips, WIDTH_CLASS } from './Shell';
import { needsYouCount, type ComposerMockState } from './states';

const VISIBLE = 3;

function Section({ title, meta, children, action, first = false }: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly first?: boolean;
}) {
  return (
    <section className={`${first ? '' : 'border-t border-hairline'} px-3 py-2`}>
      <header className="flex min-h-7 items-center gap-2 px-0.5">
        <h3 className="shrink-0 text-[12px] font-medium text-section-ink">{title}</h3>
        {meta === undefined ? null : <span className="min-w-0 truncate text-[12px] text-ink-faint">{meta}</span>}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  );
}

function QueueList({ state }: { readonly state: ComposerMockState }) {
  const visible = state.queue.slice(0, VISIBLE);
  const hidden = state.queue.length - visible.length;
  return (
    <>
      <ol aria-label={COPY.queuedCount(state.queue.length)} className="mt-0.5 flex flex-col">
        {visible.map((item, index) => (
          <li
            key={item.id}
            className={`group/q flex min-h-9 items-center gap-1.5 rounded-lg pr-1 pl-0.5 ${
              state.editingIndex === index ? 'bg-selected' : 'hover:bg-ink/[0.03]'
            }`}
          >
            {state.queue.length > 1 ? (
              <button type="button" aria-label={`${COPY.queueNth(index + 1)} · 调整顺序`} className="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-ink-faint opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                <Icon name="grip" size={12} />
              </button>
            ) : null}
            <span className="w-3.5 shrink-0 text-[11.5px] text-ink-faint tabular-nums">{index + 1}</span>
            <span className={`min-w-0 flex-1 truncate text-[13px] ${state.editingIndex === index ? 'text-selected-ink' : 'text-ink'}`}>
              {item.text}
            </span>
            {state.editingIndex === index ? <span className="shrink-0 text-[11.5px] font-medium text-selected-ink">{COPY.editingHere}</span> : null}
            <TimingTag item={item} />
            <AttachmentTag item={item} />
            <span className={`${index === 0 ? '' : 'opacity-0 group-hover/q:opacity-100 group-focus-within/q:opacity-100 [@media(hover:none)]:opacity-100'} transition-opacity`}>
              <QueueActions compact={index !== 0} />
            </span>
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <button type="button" className="mt-0.5 ml-6 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
          {COPY.moreQueued(hidden)}
        </button>
      ) : null}
    </>
  );
}

export function VariantC({ state }: { readonly state: ComposerMockState }) {
  const pending = needsYouCount(state);
  const running = state.run !== 'idle' || state.queue.length > 0;
  const notes = state.annotations.length + state.sentAnnotations;
  const rows = needsYouRows(state);
  const show = running || pending > 0 || hasConnectionNotice(state) || state.steering !== undefined || notes > 0;
  const queueFolded = pending > 0 && state.editingIndex === undefined;

  const dock = show ? (
    <div className="shrink-0 px-6 pb-2 max-sm:px-3">
      <div
        data-state-dock
        className={`${WIDTH_CLASS} max-h-[45vh] overflow-y-auto rounded-[16px] bg-panel/80 shadow-[var(--kiki-sheet-shadow)]`}
      >
        {running || hasConnectionNotice(state) ? (
          <div className="flex min-h-9 items-center gap-2 px-3.5 pt-1 text-[12.5px]">
            <RunWords state={state} />
            <span className="flex-1" />
            <ConnectionNotice state={state} inline />
          </div>
        ) : null}
        {pending > 0 ? (
          <Section
            first={!running && !hasConnectionNotice(state)}
            title={<span className="flex items-center gap-1.5 text-attention"><LifeMark markId="preview-needs-c" life="waiting" tone="bg-attention" />{COPY.needsYou}</span>}
            meta={[state.approvals.length > 0 ? COPY.approvalsN(state.approvals.length) : null, state.questions.length > 0 ? COPY.questionsN(state.questions.length) : null].filter(Boolean).join(' · ')}
            action={state.approvals.length > 1 ? <button type="button" className="rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">{COPY.approveAll}</button> : null}
          >
            <div className="pt-0.5"><FirstNeedsYou state={state} /></div>
            {rows.length > 1 ? (
              <ul className="mt-1">
                {rows.slice(1).map((row) => (
                  <li key={row.id}>
                    <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
                      <span className="shrink-0 font-medium text-ink-soft">{row.kind}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-faint">{row.origin === undefined ? '' : `${COPY.fromAgent(row.origin)} · `}{row.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        ) : null}
        {state.steering !== undefined ? (
          <div className="flex min-h-9 items-center gap-2 border-t border-hairline px-3.5 text-[12.5px]">
            <span className="shrink-0 font-medium text-selected-ink">{COPY.steering}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{state.steering}</span>
            <span className="shrink-0 text-ink-faint max-sm:hidden">{COPY.steeringHint}</span>
          </div>
        ) : null}
        {state.queue.length > 0 ? (
          <Section
            first={!running && pending === 0}
            title={COPY.queued}
            meta={queueFolded ? `${state.queue.length} · ${state.queue[0]!.text}` : `${state.queue.length}`}
            action={queueFolded
              ? <Icon name="chevron" size={12} className="rotate-90 text-ink-faint" />
              : <button type="button" className="rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-soft hover:bg-danger/[0.08] hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">{COPY.clearAll}</button>}
          >
            {queueFolded ? null : (
              <>
                {state.editingIndex !== undefined ? <p className="px-0.5 pb-1 text-[12px] text-amber-ink">{COPY.holdNotice}</p> : null}
                <QueueList state={state} />
              </>
            )}
          </Section>
        ) : null}
        {notes > 0 ? (
          <Section
            first={!running && pending === 0 && state.queue.length === 0}
            title={COPY.notes}
            meta={[state.annotations.length > 0 ? COPY.notesUnsent(state.annotations.length) : null, state.sentAnnotations > 0 ? COPY.notesSent(state.sentAnnotations) : null].filter(Boolean).join(' · ')}
            action={<Icon name="chevron" size={12} className="rotate-90 text-ink-faint" />}
          />
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <ConversationSheet
      state={state}
      dock={dock}
      composer={
        <>
          <ReplyingTo state={state} />
          <ComposerCard>
            <RideAlongChips state={state} />
            <DraftInput state={state} />
            <ComposerToolbar state={state} />
          </ComposerCard>
          <p className="mx-auto mt-1.5 h-4 max-w-[760px] truncate text-center text-[12px] text-ink-faint">
            {state.run !== 'idle' && state.draft.trim() !== '' ? `${COPY.shortcutQueue} · ${COPY.shortcutSteer}` : ''}
          </p>
        </>
      }
    />
  );
}
