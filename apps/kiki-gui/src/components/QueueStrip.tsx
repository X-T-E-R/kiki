/**
 * QueueStrip — the parked-prompt queue as an amber card strip directly above
 * the composer (between the transcript and the input card):
 *
 *   - one row per queued prompt, in drain order (#1 runs first), each with a
 *     truncated preview and a hover/focus-revealed pair of actions:
 *       Send now — steer: the server injects the prompt into the RUNNING turn
 *                    immediately (wire `:steer`), it does not wait for the turn
 *                    to end;
 *       Remove   — abort the queued prompt; its transcript block stays.
 *   - a strip header carrying the drain explanation ("…starts when the current
 *     turn finishes") plus Clear all;
 *   - every row mounts with anim-enter, so pressing Enter while busy produces
 *     a visible "it landed in the queue" placement — no more guessing whether
 *     the prompt was queued.
 *
 * The parent renders nothing for an empty queue; rows leave by reconcile
 * (promotion, steer, abort) — never by local removal.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import type { QueuedPromptPreview } from '../state/transcript';

export function QueueStrip({
  items,
  onSendNow,
  onRemove,
  onClearAll,
  sendNowDisabled = false,
}: {
  readonly items: readonly QueuedPromptPreview[];
  readonly onSendNow: (promptId: string) => Promise<void> | void;
  readonly onRemove: (promptId: string) => Promise<void> | void;
  readonly onClearAll: () => void;
  /** Steer is a send-equivalent; disable it while the session is resyncing. */
  readonly sendNowDisabled?: boolean;
}) {
  const { t, tp } = useI18n();
  // A row with an in-flight action stays disabled until the action settles
  // (success removes the row via reconcile; failure keeps it, re-enabled,
  // with the view-level error line explaining why).
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  useEffect(() => {
    setPendingIds((current) => current.filter((id) => items.some((item) => item.promptId === id)));
  }, [items]);

  if (items.length === 0) return null;

  const run = (promptId: string, action: (promptId: string) => Promise<void> | void) => {
    if (pendingIds.includes(promptId)) return;
    setPendingIds([...pendingIds, promptId]);
    void Promise.resolve(action(promptId)).finally(() => {
      setPendingIds((current) => current.filter((id) => id !== promptId));
    });
  };

  return (
    <div className="px-6 pb-1.5">
      <section
        data-queue-strip
        aria-label={t('sv.queueAria')}
        className="anim-enter mx-auto max-w-[760px] rounded-xl border border-amber-rule/40 bg-amber-card px-3 py-2"
      >
        <header className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-amber-ink">
            {tp('sv.queueBar', items.length)}
          </span>
          <button
            type="button"
            onClick={onClearAll}
            title={t('sv.queueClearAllTitle')}
            className="shrink-0 rounded-full border border-amber-rule/50 px-2 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
          >
            {t('sv.queueClearAll')}
          </button>
        </header>
        <ol className="mt-1.5 flex flex-col gap-1">
          {items.map((item, index) => {
            const pending = pendingIds.includes(item.promptId);
            return (
              <li
                key={item.promptId}
                className="anim-enter group flex items-center gap-2 rounded-lg border border-amber-rule/30 bg-panel px-2.5 py-1.5"
              >
                <span aria-hidden className="shrink-0 font-mono text-[10px] font-semibold text-amber-ink/70">
                  #{index + 1}
                </span>
                <span
                  title={item.text === '' ? undefined : item.text}
                  className="min-w-0 flex-1 truncate text-[12px] text-ink"
                >
                  {item.text === '' ? t('sv.queueNoText') : item.text}
                </span>
                <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    type="button"
                    disabled={pending || sendNowDisabled}
                    onClick={() => { run(item.promptId, onSendNow); }}
                    title={sendNowDisabled ? t('sv.sendPaused') : t('sv.queueSendNowTitle')}
                    aria-label={t('sv.queueSendNow')}
                    className="rounded-full bg-amber-ink px-2 py-0.5 text-[10.5px] font-medium text-white transition-colors hover:bg-amber-ink/85 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
                  >
                    {t('sv.queueSendNow')}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => { run(item.promptId, onRemove); }}
                    title={t('sv.queueRemoveTitle')}
                    aria-label={t('sv.queueRemove')}
                    className="rounded-full border border-amber-rule/50 px-2 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
                  >
                    {t('sv.queueRemove')}
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
