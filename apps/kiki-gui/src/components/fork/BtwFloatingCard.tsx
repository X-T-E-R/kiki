/**
 * Dock-anchored ephemeral `/btw` side-question card.
 *
 * Streams a read-only `/btw` agent's turns right above the main Composer so the
 * reader gets quick answers mid-run without splitting the right preview workspace
 * or losing scroll position. Supports follow-up questions, `Escape` dismissal,
 * and 1-click promotion to the full agent route.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createViewState, type Block, type SessionController } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { isImeKeyEvent } from '../../lib/shortcuts';
import { registerOverlay } from '../../lib/uiBusy';
import { Icon, Spinner } from '../icons';
import { Markdown } from '../Markdown';

const emptyView = createViewState('');

function extractBtwTurns(blocks: readonly Block[]): readonly {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly streaming?: boolean;
}[] {
  const rows: { id: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }[] = [];
  for (const block of blocks) {
    if (block.kind === 'user' && block.branchFold === undefined && block.agentMessage === undefined) {
      const trimmed = block.text.trim();
      if (trimmed !== '') rows.push({ id: block.id, role: 'user', text: trimmed });
    } else if (block.kind === 'assistant') {
      const trimmed = block.text.trim();
      if (trimmed !== '' || block.streaming) {
        rows.push({ id: block.id, role: 'assistant', text: block.text, streaming: block.streaming });
      }
    }
  }
  return rows;
}

export const BtwFloatingCard = memo(function BtwFloatingCard({
  sessionId,
  agentId,
  controller,
  sendingInitial,
  onSendQuestion,
  onExpandFullView,
  onClose,
}: {
  sessionId: string;
  agentId: string;
  controller: SessionController | null;
  sendingInitial?: boolean;
  onSendQuestion: (agentId: string, text: string) => Promise<void>;
  onExpandFullView: (agentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const leaseUid = useId();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (controller === null || typeof controller.retainAgentView !== 'function') return;
    const viewId = `btw-dock:${sessionId}:${agentId}:${leaseUid}`;
    controller.retainAgentView(viewId, agentId, 'delta');
    return () => {
      controller.releaseAgentView?.(viewId);
    };
  }, [controller, sessionId, agentId, leaseUid]);

  const subscribe = useCallback(
    (listener: () => void) =>
      controller === null ? () => {} : controller.subscribeAgent(agentId, listener),
    [controller, agentId],
  );
  const agentState = useSyncExternalStore(
    subscribe,
    () => (controller === null ? emptyView : controller.getAgentState(agentId)),
    () => emptyView,
  );

  useEffect(() => {
    const unregister = registerOverlay('btw-floating-card');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const rows = useMemo(() => extractBtwTurns(agentState.blocks), [agentState.blocks]);
  const isBusy = sendingInitial === true || sending || agentState.busy;

  useEffect(() => {
    if (rows.length === 0 && !isBusy) {
      inputRef.current?.focus();
    }
  }, [rows.length, isBusy]);

  const stickToBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && (stickToBottomRef.current || forceScrollRef.current)) {
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
    }
  }, [rows]);

  const submit = () => {
    const clean = draft.trim();
    if (clean === '' || sending) return;
    setSending(true);
    setDraft('');
    forceScrollRef.current = true;
    stickToBottomRef.current = true;
    void onSendQuestion(agentId, clean)
      .catch(() => {
        setDraft((current) => (current.trim() === '' ? clean : `${clean}\n${current}`));
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <section
      data-btw-floating-card={agentId}
      aria-label={t('btw.tabTitle')}
      className="anim-enter mx-auto mb-2 w-full max-w-[46rem] rounded-xl border border-hairline-strong bg-paper shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_12px_32px_-12px_rgb(var(--kiki-shadow-ink)/0.28)]"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
        <Icon name="ask" size={14} className="shrink-0 text-ink-faint" />
        <span className="text-[12px] font-medium text-ink">{t('btw.tabTitle')}</span>
        {isBusy ? <Spinner label={t('btw.tabTitle')} size={12} /> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-btw-expand
            onClick={() => {
              onExpandFullView(agentId);
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink-soft"
          >
            <Icon name="expand" size={12} />
            <span>{t('btw.dock.expand')}</span>
          </button>
          <button
            type="button"
            data-btw-close
            aria-label={t('btw.dock.closeAria')}
            title={t('btw.dock.closeAria')}
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>

      {rows.length > 0 ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
          }}
          className="flex max-h-[260px] flex-col gap-2.5 overflow-y-auto px-3.5 py-2.5 text-[13px] leading-relaxed"
        >
          {rows.map((row) =>
            row.role === 'user' ? (
              <div key={row.id} className="flex justify-end">
                <span className="max-w-[85%] rounded-2xl bg-panel px-3 py-1 text-[12.5px] text-ink">
                  {row.text}
                </span>
              </div>
            ) : (
              <div key={row.id} className="min-w-0 text-ink">
                <Markdown text={row.text} mode={row.streaming ? 'streaming' : 'static'} />
              </div>
            ),
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 border-t border-hairline px-2.5 py-1.5">
        <input
          ref={inputRef}
          type="text"
          data-btw-input
          value={draft}
          placeholder={t('btw.dock.placeholder')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composingRef.current && !isImeKeyEvent(event)) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <button
          type="button"
          data-btw-send
          disabled={draft.trim() === '' || sending}
          aria-label={t('btw.dock.sendAria')}
          onClick={submit}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink text-paper transition-opacity disabled:opacity-30"
        >
          <Icon name="arrowUp" size={12} />
        </button>
      </div>
    </section>
  );
});
