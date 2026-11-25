import { useEffect, useState } from 'react';
import {
  UNCONFIRMED_SUBMISSIONS_STORAGE_KEY,
  forgetUnconfirmedSubmission,
  isSubmissionInFlight,
  readUnconfirmedSubmissions,
  restorePromptToDraft,
  subscribeUnconfirmedSubmissions,
  type UnconfirmedSubmission,
} from '@kiki/session-core/composer';
import { MAIN_AGENT_ID, type SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { ConversationDockColumn } from './ConversationDockColumn';
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
export function SubmissionRecovery({
  sessionId,
  agentId = MAIN_AGENT_ID,
  draftKey,
  state,
}: {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly draftKey?: string;
  readonly state: SessionViewState;
}) {
  const { t, tp } = useI18n();
  const [items, setItems] = useState(() => readUnconfirmedSubmissions(sessionId, agentId));
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => {
      setItems(readUnconfirmedSubmissions(sessionId, agentId));
    };
    sync();
    setExpanded(null);
    const unsubscribe = subscribeUnconfirmedSubmissions(sync);
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === UNCONFIRMED_SUBMISSIONS_STORAGE_KEY ||
        event.key.endsWith(`:${UNCONFIRMED_SUBMISSIONS_STORAGE_KEY}`)
      ) {
        sync();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, [sessionId, agentId]);
  useEffect(() => {
    const known = new Set<string>(state.queuedPromptIds);
    if (state.activePromptId !== undefined) known.add(state.activePromptId);
    for (const ingress of state.durableIngress ?? []) {
      if ((ingress.agent_id ?? MAIN_AGENT_ID) === agentId) {
        known.add(ingress.prompt_id);
        if (ingress.user_message_id !== undefined) known.add(ingress.user_message_id);
      }
    }
    for (const block of state.blocks) {
      if (block.kind !== 'user') continue;
      if (block.optimisticStatus !== undefined) continue;
      if (block.steerStatus !== undefined && block.steerStatus !== 'waiting') continue;
      if (block.promptId !== undefined) known.add(block.promptId);
      if (block.userMessageId !== undefined) known.add(block.userMessageId);
    }
    const next = items.filter(item => !known.has(item.promptId));
    if (next.length === items.length) return;
    for (const item of items) if (known.has(item.promptId)) forgetUnconfirmedSubmission(sessionId, item.promptId, agentId);
    setItems(next);
  }, [sessionId, agentId, state, items]);
  const inFlightPromptIds = new Set(
    state.blocks.flatMap(block =>
      block.kind === 'user' &&
      block.promptId !== undefined &&
      (block.steerStatus === 'sending' ||
        block.steerStatus === 'preparing' ||
        block.steerStatus === 'waiting' ||
        block.optimisticStatus === 'sending' ||
        block.optimisticStatus === 'server')
        ? [block.promptId]
        : [],
    ),
  );
  const visibleItems = state.resyncing
    ? []
    : items.filter(item => !inFlightPromptIds.has(item.promptId) && !isSubmissionInFlight(sessionId, item.promptId, agentId));
  if (visibleItems.length === 0) return null;
  const settle = (item: UnconfirmedSubmission, restore: boolean) => {
    if (restore) restorePromptToDraft(draftKey ?? sessionId, item.content);
    forgetUnconfirmedSubmission(sessionId, item.promptId, agentId);
    setItems(current => current.filter(entry => entry.promptId !== item.promptId));
  };
  const single = visibleItems.length === 1;
  return (
    <ConversationDockColumn className="pb-2" data-submission-recovery-wrapper>
      <section
        role="status"
        aria-label={tp('sv.submissionRecovery.title', visibleItems.length)}
        data-submission-recovery
        className="anim-enter rounded-[10px] border border-hairline bg-canvas py-1 pr-1 pl-3"
      >
        {single ? null : (
          <p className="flex min-h-7 items-center gap-2 text-[13px] text-ink-soft" title={t('sv.submissionRecovery.body')}>
            <Icon name="hold" size={14} className="text-ink-faint" />
            {tp('sv.submissionRecovery.title', visibleItems.length)}
          </p>
        )}
        <ul>
          {visibleItems.map(item => {
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
    </ConversationDockColumn>
  );
}
