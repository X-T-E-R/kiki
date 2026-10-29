import { useEffect, useState } from 'react';
import { forgetUnconfirmedSubmission, readUnconfirmedSubmissions, restorePromptToDraft, type UnconfirmedSubmission } from '@kiki/session-core/composer';
import type { SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { Icon } from './icons';

const ACTION = 'h-7 shrink-0 rounded-md text-[12px] font-medium transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none';
const PRIMARY = `${ACTION} bg-accent px-3 text-on-accent hover:bg-accent-deep`;
const QUIET = `${ACTION} px-2 text-ink-soft hover:bg-ink/[0.05] hover:text-ink`;

function itemText(item: UnconfirmedSubmission): string {
  return item.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n');
}

/**
 * Messages whose send was never confirmed. Each one gets a single decision:
 * put it back into the composer (the backup becomes the draft) or confirm it
 * already arrived (the backup is dropped). Nothing is ever resent.
 */
export function SubmissionRecovery({ sessionId, state }: { readonly sessionId: string; readonly state: SessionViewState }) {
  const { t, tp } = useI18n();
  const [items, setItems] = useState(() => readUnconfirmedSubmissions(sessionId));
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const known = new Set([...state.queuedPromptIds, ...state.blocks.flatMap(block => block.kind === 'user' && block.steerStatus === undefined && block.promptId !== undefined ? [block.promptId] : [])]);
    if (state.activePromptId !== undefined) known.add(state.activePromptId);
    const next = items.filter(item => !known.has(item.promptId));
    if (next.length === items.length) return;
    for (const item of items) if (known.has(item.promptId)) forgetUnconfirmedSubmission(sessionId, item.promptId);
    setItems(next);
  }, [sessionId, state, items]);
  if (items.length === 0) return null;
  const settle = (item: UnconfirmedSubmission, restore: boolean) => {
    if (restore) restorePromptToDraft(sessionId, item.content);
    forgetUnconfirmedSubmission(sessionId, item.promptId);
    setItems(current => current.filter(entry => entry.promptId !== item.promptId));
  };
  const single = items.length === 1;
  return (
    <div className="px-6 pb-2" data-submission-recovery-wrapper>
      <section
        role="status"
        aria-label={tp('sv.submissionRecovery.title', items.length)}
        data-submission-recovery
        className="anim-enter mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-[10px] border border-hairline bg-canvas py-1 pr-1 pl-3"
      >
        {single ? null : (
          <p className="flex min-h-7 items-center gap-2 text-[13px] text-ink-soft" title={t('sv.submissionRecovery.body')}>
            <Icon name="hold" size={14} className="text-ink-faint" />
            {tp('sv.submissionRecovery.title', items.length)}
          </p>
        )}
        <ul>
          {items.map(item => {
            const text = itemText(item);
            const preview = text === '' ? t('sv.fileEcho') : text.replace(/\s+/g, ' ');
            const long = text.includes('\n') || text.length > 48;
            const open = expanded === item.promptId;
            return (
              <li key={item.promptId} data-submission-recovery-item>
                <div className="flex min-h-7 items-center gap-2">
                  {single ? <Icon name="hold" size={14} className="shrink-0 text-ink-faint" /> : <span aria-hidden className="w-3.5 shrink-0" />}
                  {single ? (
                    <span className="shrink-0 text-[13px] text-ink-soft" title={t('sv.submissionRecovery.body')}>
                      {tp('sv.submissionRecovery.title', 1)}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    disabled={!long}
                    aria-expanded={long ? open : undefined}
                    title={long ? undefined : text}
                    onClick={() => setExpanded(open ? null : item.promptId)}
                    className="min-w-0 flex-1 truncate rounded px-1 text-left text-[13px] text-ink-faint enabled:hover:text-ink-soft disabled:cursor-default focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
                  >
                    {preview}
                  </button>
                  <button type="button" className={PRIMARY} onClick={() => settle(item, true)}>
                    {t('sv.submissionRecovery.restore')}
                  </button>
                  <button type="button" className={QUIET} title={t('sv.submissionRecovery.dismissHint')} onClick={() => settle(item, false)}>
                    {t('sv.submissionRecovery.dismiss')}
                  </button>
                </div>
                {open ? (
                  <p className="mb-1.5 ml-[22px] max-h-40 overflow-auto whitespace-pre-wrap pr-2 text-[13px] text-ink-soft">{text}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
