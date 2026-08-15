/**
 * QueueStrip — the parked-prompt queue as an amber card strip directly above
 * the composer (between the transcript and the input card):
 *
 *   - one row per queued prompt, in drain order (#1 runs first), each with a
 *     truncated preview and a hover/focus-revealed action set:
 *       Send now — steer: the server injects the prompt into the RUNNING turn
 *                    immediately (wire `:steer`), it does not wait for the turn
 *                    to end;
 *       Edit     — inline editor (Enter saves, Esc cancels) when the parent
 *                    wires `onEdit`; the wire has no positional edit verb, so a
 *                    save is abort + resubmit and the prompt re-queues at the
 *                    tail;
 *       Remove   — abort the queued prompt; its transcript block stays.
 *   - with more than one parked prompt the list defaults to a collapsed count
 *     header (deepseek-harness's QueueDock, Apache-2.0); the header toggles
 *     the list, an in-flight edit force-expands it, and a single prompt always
 *     shows without a toggle;
 *   - a strip header carrying the drain explanation ("…starts when the current
 *     turn finishes") plus Clear all;
 *   - every row mounts with anim-enter, so pressing Enter while busy produces
 *     a visible "it landed in the queue" placement — no more guessing whether
 *     the prompt was queued.
 *
 * The parent renders nothing for an empty queue; rows leave by reconcile
 * (promotion, steer, abort) — never by local removal.
 */

import { useEffect, useId, useState } from 'react';

import { useI18n } from '../i18n';
import type { QueuedPromptPreview } from '../state/transcript';

export function QueueStrip({
  items,
  onSendNow,
  onRemove,
  onClearAll,
  onEdit,
  sendNowDisabled = false,
}: {
  readonly items: readonly QueuedPromptPreview[];
  readonly onSendNow: (promptId: string) => Promise<void> | void;
  readonly onRemove: (promptId: string) => Promise<void> | void;
  readonly onClearAll: () => void;
  /**
   * Inline edit save. Optional: the row edit affordance only appears when the
   * parent wires a handler (the wire has no edit verb — a save is abort +
   * resubmit, landing at the queue tail).
   */
  readonly onEdit?: (promptId: string, text: string) => Promise<void> | void;
  /** Steer is a send-equivalent; disable it while the session is resyncing. */
  readonly sendNowDisabled?: boolean;
}) {
  const { t, tp } = useI18n();
  const listId = useId();
  // A row with an in-flight action stays disabled until the action settles
  // (success removes the row via reconcile; failure keeps it, re-enabled,
  // with the view-level error line explaining why).
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(null);
  useEffect(() => {
    setPendingIds((current) => current.filter((id) => items.some((item) => item.promptId === id)));
  }, [items]);
  // Auto-collapse as the queue drains to a single row; cancel an edit whose
  // row left the queue underneath it.
  useEffect(() => {
    if (items.length <= 1 && !collapsed) setCollapsed(true);
    if (editing !== null && !items.some((item) => item.promptId === editing.id)) setEditing(null);
  }, [items, collapsed, editing]);

  if (items.length === 0) return null;

  const expanded = !collapsed || editing !== null;
  const listVisible = items.length === 1 || expanded;

  const run = (promptId: string, action: (promptId: string) => Promise<void> | void) => {
    if (pendingIds.includes(promptId)) return;
    setPendingIds([...pendingIds, promptId]);
    void Promise.resolve(action(promptId)).finally(() => {
      setPendingIds((current) => current.filter((id) => id !== promptId));
    });
  };

  const saveEdit = () => {
    if (editing === null || onEdit === undefined) return;
    const text = editing.text.trim();
    const current = items.find((item) => item.promptId === editing.id);
    // Blank or unchanged text cancels instead of burning an abort+resubmit.
    if (text === '' || current === undefined || text === current.text) {
      setEditing(null);
      return;
    }
    const id = editing.id;
    setPendingIds((pending) => [...pending, id]);
    void Promise.resolve(onEdit(id, text))
      .then(() => { setEditing(null); })
      .catch(() => undefined)
      .finally(() => {
        setPendingIds((pending) => pending.filter((pendingId) => pendingId !== id));
      });
  };

  const countLabel = tp('sv.queueBar', items.length);

  return (
    <div className="px-6 pb-1.5">
      <section
        data-queue-strip
        aria-label={t('sv.queueAria')}
        className="anim-enter mx-auto max-w-[760px] rounded-xl border border-amber-rule/40 bg-amber-card px-3 py-2"
      >
        <header className="flex items-center gap-2">
          {items.length > 1 ? (
            <button
              type="button"
              onClick={() => { setCollapsed((value) => !value); }}
              aria-expanded={expanded}
              aria-controls={listId}
              aria-label={t('sv.queueExpandAria')}
              disabled={editing !== null}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:opacity-70"
            >
              <span className="min-w-0 truncate text-[11px] font-medium text-amber-ink">
                {countLabel}
              </span>
              <span
                aria-hidden
                className={`shrink-0 text-[9px] text-amber-ink/70 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
              >
                ▶
              </span>
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-amber-ink">
              {countLabel}
            </span>
          )}
          <button
            type="button"
            onClick={onClearAll}
            title={t('sv.queueClearAllTitle')}
            className="shrink-0 rounded-full border border-amber-rule/50 px-2 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
          >
            {t('sv.queueClearAll')}
          </button>
        </header>
        <ol id={listId} hidden={!listVisible} className="mt-1.5 flex-col gap-1" style={{ display: listVisible ? 'flex' : undefined }}>
          {items.map((item, index) => {
            const pending = pendingIds.includes(item.promptId);
            const isEditing = editing?.id === item.promptId;
            return (
              <li
                key={item.promptId}
                className="anim-enter group flex items-center gap-2 rounded-lg border border-amber-rule/30 bg-panel px-2.5 py-1.5"
              >
                <span aria-hidden className="shrink-0 font-mono text-[10px] font-semibold text-amber-ink/70">
                  #{index + 1}
                </span>
                {isEditing && editing !== null ? (
                  <input
                    autoFocus
                    value={editing.text}
                    aria-label={t('sv.queueEditAria')}
                    title={t('sv.queueEditHint')}
                    onChange={(event) => {
                      setEditing({ id: item.promptId, text: event.currentTarget.value });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setEditing(null);
                        return;
                      }
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        saveEdit();
                      }
                    }}
                    className="min-w-0 flex-1 rounded-md border border-amber-rule/60 bg-paper px-1.5 py-0.5 text-[12px] text-ink focus:border-amber-rule focus:outline-none"
                  />
                ) : (
                  <span
                    title={item.text === '' ? undefined : item.text}
                    className="min-w-0 flex-1 truncate text-[12px] text-ink"
                  >
                    {item.text === '' ? t('sv.queueNoText') : item.text}
                  </span>
                )}
                <span className={`flex shrink-0 items-center gap-1 transition-opacity ${isEditing ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                  {!isEditing && onEdit !== undefined && item.text !== '' ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => { setEditing({ id: item.promptId, text: item.text }); }}
                      title={t('sv.queueEditTitle')}
                      aria-label={t('sv.queueEditAria')}
                      className="rounded-full border border-amber-rule/50 px-2 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
                    >
                      {t('sv.queueEdit')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending || sendNowDisabled || isEditing}
                    onClick={() => { run(item.promptId, onSendNow); }}
                    title={sendNowDisabled ? t('sv.sendPaused') : t('sv.queueSendNowTitle')}
                    aria-label={t('sv.queueSendNow')}
                    className="rounded-full bg-amber-ink px-2 py-0.5 text-[10.5px] font-medium text-white transition-colors hover:bg-amber-ink/85 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
                  >
                    {t('sv.queueSendNow')}
                  </button>
                  <button
                    type="button"
                    disabled={pending || isEditing}
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
