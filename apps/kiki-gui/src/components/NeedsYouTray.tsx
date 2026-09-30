/**
 * NeedsYouTray — the one stacked place above the composer for everything the
 * session is waiting on: pending approvals (which block the turn) and pending
 * questions (which may not). The first item is expanded and answered inline
 * with the existing ApprovalCard / QuestionCard; the rest stay collapsed as
 * one-line rows ("2 more"). A non-blocking question can be put off with
 * "Later"; every item links "Show in timeline" to its one-line record.
 *
 * The tray is placement only: decisions go through the same handlers the
 * transcript cards used, and the transcript keeps an InteractionRecord per
 * item while the tray is mounted (InteractionPlacementContext).
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';

import type { QuestionAnswer } from '@kiki/protocol';
import type { ApprovalBlock, QuestionBlock } from '@kiki/session-core/session';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { anyOverlayOpen } from '../lib/uiBusy';
import { Icon } from './icons';
import { ApprovalCard, QuestionCard } from './Interactions';
import { LifeMark } from './LifeMark';

type PendingItem = ApprovalBlock | QuestionBlock;

export interface NeedsYouTrayHandle {
  /** Expand and focus one item (a transcript record's Review action). */
  focusItem: (kind: 'approval' | 'question', id: string) => void;
}

function itemId(item: PendingItem): string {
  return item.kind === 'approval' ? item.request.approval_id : item.request.question_id;
}

function itemSubject(item: PendingItem, fallback: string): string {
  return item.kind === 'approval'
    ? `${item.request.tool_name} · ${item.request.action}`
    : (item.request.questions[0]?.question ?? fallback);
}

/** Scrolls the transcript to an item's one-line record and flashes it. */
export function showInTimeline(id: string): void {
  const record = document.querySelector<HTMLElement>(`[data-interaction-record="${CSS.escape(id)}"]`);
  if (record === null) return;
  record.scrollIntoView({ behavior: 'smooth', block: 'center' });
  record.dataset['flash'] = '';
  window.setTimeout(() => { delete record.dataset['flash']; }, 1200);
}

export const NeedsYouTray = forwardRef<NeedsYouTrayHandle, {
  readonly items: readonly PendingItem[];
  readonly agentNames?: ReadonlyMap<string, string>;
  readonly onResolveApproval: (
    approvalId: string,
    decision: 'approved' | 'rejected' | 'cancelled',
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  readonly onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  readonly onDismissQuestion: (questionId: string) => Promise<void>;
  /**
   * Batch decisions for ≥2 pending approvals. They live in the tray head —
   * the one place that already lists what they act on — and go through the
   * caller's confirmation.
   */
  readonly onRequestBatchResolve?: (decision: 'approved' | 'rejected', ids: readonly string[]) => void;
  /**
   * `card`: rendered as the composer card's own body while it takes the
   * input over — no outer sheet, a "1 / N ›" stepper instead of the collapsed
   * rows, and `footer` (the kept draft) along the bottom edge.
   */
  readonly placement?: 'dock' | 'card';
  readonly footer?: ReactNode;
}>(function NeedsYouTray({ items, agentNames, onResolveApproval, onAnswerQuestion, onDismissQuestion, onRequestBatchResolve, placement = 'dock', footer }, ref) {
  const { t, tp } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  // Questions the user put off: they drop to the collapsed rows until
  // picked again. Approvals always stay first — they block the turn.
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [pinned, setPinned] = useState<string | null>(null);

  // Handling order without the pin: approvals first, put-off questions last.
  const natural = useMemo(() => {
    const rank = (item: PendingItem) =>
      item.kind === 'approval' ? 1 : later.has(itemId(item)) ? 3 : 2;
    return items.toSorted((a, b) => rank(a) - rank(b));
  }, [items, later]);
  // The dock lifts the pinned item to the front; the card keeps the handling
  // order and starts from the pin, so its "1 / N" position stays truthful.
  const cursor = Math.max(0, natural.findIndex((item) => itemId(item) === pinned));
  const ordered = useMemo(() => {
    if (placement === 'card') return [...natural.slice(cursor), ...natural.slice(0, cursor)];
    const lifted = natural.findIndex((item) => itemId(item) === pinned);
    return lifted <= 0 ? natural : [natural[lifted]!, ...natural.slice(0, lifted), ...natural.slice(lifted + 1)];
  }, [natural, cursor, pinned, placement]);

  // A resolved/pinned item leaving the list must not keep the pin alive.
  useEffect(() => {
    if (pinned !== null && !items.some((item) => itemId(item) === pinned)) setPinned(null);
  }, [items, pinned]);

  useImperativeHandle(ref, () => ({
    focusItem: (_kind, id) => {
      setPinned(id);
      setLater((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      window.requestAnimationFrame(() => {
        const first = rootRef.current?.querySelector<HTMLElement>('[data-tray-current]');
        first?.scrollIntoView({ block: 'nearest' });
        first?.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus();
      });
    },
  }), []);

  // y/n decide the expanded approval from anywhere outside a text field (the
  // session's own y/n resolver only sees cards inside the timeline, which now
  // holds one-line records instead).
  // SSH cards answer through their own form (and route); no global y/n.
  const currentApprovalId = ordered[0]?.kind === 'approval' && ordered[0].request.ssh === undefined
    ? ordered[0].request.approval_id
    : undefined;
  useEffect(() => {
    if (currentApprovalId === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'y' && event.key !== 'n') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT' || target.isContentEditable || target.closest('.xterm') !== null)) return;
      if (anyOverlayOpen()) return;
      event.preventDefault();
      void onResolveApproval(currentApprovalId, event.key === 'y' ? 'approved' : 'rejected').catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('sv.approvalShortcutFailed', { detail: error instanceof Error ? error.message : String(error) }),
        });
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [currentApprovalId, onResolveApproval, t]);

  const current = ordered[0];
  if (current === undefined) return null;
  const rest = ordered.slice(1);
  const originName = (item: PendingItem) =>
    item.originAgentId !== undefined && item.originAgentId !== 'main' && item.originUnknown !== true
      ? (agentNames?.get(item.originAgentId) ?? item.originAgentId)
      : undefined;
  const approvalIds = items
    .filter((item): item is ApprovalBlock => item.kind === 'approval')
    .map((item) => item.request.approval_id);
  const approvals = approvalIds.length;
  const questions = items.length - approvals;
  const currentId = itemId(current);
  const headAction =
    'inline-flex min-h-6 shrink-0 items-center rounded-md px-1.5 py-0.5 text-[12px] pointer-coarse:min-h-9 font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none';
  const currentCard = current.kind === 'approval' ? (
    <ApprovalCard
      key={currentId}
      block={current}
      originAgentName={originName(current)}
      showShortcutHints
      onResolve={(decision, scope, selectedOptionId) =>
        onResolveApproval(currentId, decision, scope, selectedOptionId)
      }
    />
  ) : (
    <QuestionCard
      key={currentId}
      block={current}
      originAgentName={originName(current)}
      onAnswer={(answers) => onAnswerQuestion(currentId, answers)}
      onDismiss={() => onDismissQuestion(currentId)}
    />
  );
  const batch = approvals >= 2 && onRequestBatchResolve !== undefined ? (
    <span data-approval-batch className="flex shrink-0 items-center gap-0.5">
      <button type="button" data-approval-approve-all onClick={() => { onRequestBatchResolve('approved', approvalIds); }} className={headAction}>
        {t('sv.approveAll')}
      </button>
      <button type="button" data-approval-reject-all onClick={() => { onRequestBatchResolve('rejected', approvalIds); }}
        className={`${headAction} hover:bg-danger/[0.08] hover:text-danger`}>
        {t('sv.rejectAll')}
      </button>
    </span>
  ) : null;

  if (placement === 'card') {
    // Step through the items in their handling order; the pin is the cursor.
    const index = cursor;
    const step = (delta: 1 | -1) => {
      const next = natural[(index + delta + natural.length) % natural.length];
      if (next !== undefined) setPinned(itemId(next));
    };
    const stepButton = 'flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-10';
    return (
      <section ref={rootRef} data-needs-you-tray data-needs-you-card aria-label={t('tray.aria')} className="anim-enter">
        <header className="flex min-h-10 items-center gap-2 px-3.5 pt-1.5">
          <LifeMark markId="composer-needs-you" life="waiting" tone="bg-attention" />
          <h2 className="shrink-0 text-[13px] font-medium text-attention">{t('composer.needsYou.title')}</h2>
          {ordered.length > 1 ? (
            <span data-tray-stepper className="flex items-center text-[12px] text-ink-faint tabular-nums">
              <button type="button" aria-label={t('composer.needsYou.previous')} title={t('composer.needsYou.previous')} onClick={() => { step(-1); }} className={stepButton}>
                <Icon name="chevron" size={12} className="rotate-180" />
              </button>
              <span>{t('composer.needsYou.step', { index: index + 1, total: ordered.length })}</span>
              <button type="button" aria-label={t('composer.needsYou.next')} title={t('composer.needsYou.next')} onClick={() => { step(1); }} className={stepButton}>
                <Icon name="chevron" size={12} />
              </button>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint max-sm:hidden">
            {originName(current) === undefined ? '' : t('tray.from', { name: originName(current)! })}
          </span>
          {batch}
          {current.kind === 'question' && rest.length > 0 ? (
            <button type="button" data-tray-later title={t('tray.laterTitle')} className={headAction}
              onClick={() => { setPinned(null); setLater((set) => new Set(set).add(currentId)); }}>
              {t('tray.later')}
            </button>
          ) : null}
        </header>
        <div data-tray-current={currentId} className="max-h-[min(44vh,400px)] overflow-y-auto px-3.5 pt-1 pb-2.5">
          {currentCard}
        </div>
        {footer}
      </section>
    );
  }

  return (
    <div className="px-6 pb-2">
      <section
        ref={rootRef}
        data-needs-you-tray
        aria-label={t('tray.aria')}
        className={`anim-enter mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-[14px] border border-hairline bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]`}
      >
        <header className="flex items-center gap-2 px-3.5 pt-2.5">
          {/* The one moving accent mark on the screen: the tray is where the
              session waits, so it alone beckons. */}
          <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            <span className="whitespace-nowrap">{t('tray.title')}</span>
            <span className="ml-1.5 hidden font-normal text-ink-faint sm:inline">
              {[
                approvals > 0 ? tp('tray.approvals', approvals) : null,
                questions > 0 ? tp('tray.questions', questions) : null,
              ].filter((part) => part !== null).join(' · ')}
            </span>
          </h2>
          {approvals >= 2 && onRequestBatchResolve !== undefined ? (
            <span data-approval-batch className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                data-approval-approve-all
                onClick={() => { onRequestBatchResolve('approved', approvalIds); }}
                className={headAction}
              >
                {t('sv.approveAll')}
              </button>
              <button
                type="button"
                data-approval-reject-all
                onClick={() => { onRequestBatchResolve('rejected', approvalIds); }}
                className={`${headAction} hover:bg-danger/[0.08] hover:text-danger`}
              >
                {t('sv.rejectAll')}
              </button>
              <span aria-hidden className="mx-1 hidden h-3.5 w-px bg-hairline sm:block" />
            </span>
          ) : null}
          <button
            type="button"
            data-tray-show-in-timeline
            onClick={() => { showInTimeline(currentId); }}
            // Narrow widths keep the decisions; the timeline records carry
            // their own Review action back to the tray.
            className={`${headAction} hidden sm:inline-flex`}
          >
            {t('tray.showInTimeline')}
          </button>
          {current.kind === 'question' ? (
            <button
              type="button"
              data-tray-later
              disabled={rest.length === 0}
              onClick={() => {
                setPinned(null);
                setLater((set) => new Set(set).add(currentId));
              }}
              title={rest.length === 0 ? undefined : t('tray.laterTitle')}
              className={`${headAction} disabled:hidden`}
            >
              {t('tray.later')}
            </button>
          ) : null}
        </header>
        {/* The current item: the real card, bounded so a long question never
            pushes the composer off screen. */}
        <div data-tray-current={currentId} className="max-h-[min(46vh,420px)] overflow-y-auto px-3.5 pt-2 pb-3">
          {current.kind === 'approval' ? (
            <ApprovalCard
              key={currentId}
              block={current}
              originAgentName={originName(current)}
              showShortcutHints
              onResolve={(decision, scope, selectedOptionId) =>
                onResolveApproval(currentId, decision, scope, selectedOptionId)
              }
            />
          ) : (
            <QuestionCard
              key={currentId}
              block={current}
              originAgentName={originName(current)}
              onAnswer={(answers) => onAnswerQuestion(currentId, answers)}
              onDismiss={() => onDismissQuestion(currentId)}
            />
          )}
        </div>
        {rest.length > 0 ? (
          <ul data-tray-rest aria-label={tp('tray.more', rest.length)} className="border-t border-hairline px-1.5 py-1">
            {rest.map((item) => {
              const id = itemId(item);
              const origin = originName(item);
              return (
                <li key={id}>
                  <button
                    type="button"
                    data-tray-item={id}
                    onClick={() => { setPinned(id); }}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                  >
                    <span className="shrink-0 text-[12px] font-medium text-ink-soft">
                      {item.kind === 'approval' ? t('pending.kind.approval') : t('pending.kind.question')}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink-faint">
                      {origin !== undefined ? `${t('tray.from', { name: origin })} · ` : ''}
                      {itemSubject(item, t('ia.kikiAsks'))}
                    </span>
                    {later.has(id) ? <span className="shrink-0 text-[12px] text-ink-faint">{t('tray.later')}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
});
