/**
 * QueueStrip — the parked-prompt queue as an amber card strip directly above
 * the composer (between the transcript and the input card):
 *
 *   - one row per queued prompt, in drain order (#1 runs first), each with a
 *     truncated preview and a hover/focus-revealed action set:
 *       Timing   — dropdown picking when the prompt starts (when idle / after
 *                  subagents / after all tasks; wire `:timing`);
 *       Send now — steer: the server injects the prompt into the RUNNING turn
 *                    immediately (wire `:steer`), it does not wait for the turn
 *                    to end;
 *       Edit     — hands the prompt's text to the composer for a round-trip
 *                    edit; confirming there replaces the queued prompt AT ITS
 *                    ORIGINAL position (wire `:replace`, no requeue);
 *       Remove   — two-step: the first click arms the button ("Remove?"), the
 *                    second actually aborts the queued prompt. The engine
 *                    drops the before-start transcript block, so nothing stays
 *                    behind on the timeline.
 *   - with more than one parked prompt a drag handle (⠿) leads each row: drag
 *     onto another row to land before/after it, or focus the handle and move
 *     with ↑/↓ — both go through `:move` (prompt.moved) and the strip
 *     repaints from the server's authoritative order;
 *   - with more than one parked prompt the list defaults to expanded; the
 *     count header toggles collapse, an in-flight composer edit force-expands
 *     it, and a single prompt always shows without a toggle;
 *   - a strip header carrying the drain explanation ("…starts when the current
 *     turn finishes") plus Clear all;
 *   - every row mounts with anim-enter, so pressing Enter while busy produces
 *     a visible "it landed in the queue" placement — no more guessing whether
 *     the prompt was queued.
 *
 * The parent renders nothing for an empty queue; rows leave by reconcile
 * (promotion, steer, abort) — never by local removal.
 */

import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { DeferredAppendTiming } from '@kiki/protocol';
import type { QueuedPromptPreview } from '@kiki/session-core/session';
import { useI18n } from '../i18n';

/** The armed remove falls back to idle after this long without the second click. */
const REMOVE_ARM_TIMEOUT_MS = 5_000;
const QUEUE_DRAG_MIME = 'application/x-kiki-queue-prompt';

const QUEUE_TIMINGS: readonly DeferredAppendTiming[] = ['agent_idle', 'subagents_done', 'tasks_done'];

const TIMING_SHORT_KEY = {
  agent_idle: 'timing.short.agentIdle',
  subagents_done: 'timing.short.subagentsDone',
  tasks_done: 'timing.short.tasksDone',
} as const;

const TIMING_HINT_KEY = {
  agent_idle: 'timing.hint.agentIdle',
  subagents_done: 'timing.hint.subagentsDone',
  tasks_done: 'timing.hint.tasksDone',
} as const;

export function QueueStrip({
  items,
  onSendNow,
  onRemove,
  onRemoveAttachment,
  onClearAll,
  onEdit,
  editingPromptId,
  onMove,
  onChangeTiming,
  sendNowDisabled = false,
}: {
  readonly items: readonly QueuedPromptPreview[];
  readonly onSendNow: (promptId: string) => Promise<void> | void;
  readonly onRemove: (promptId: string) => Promise<void> | void;
  readonly onRemoveAttachment?: (promptId: string, index: number) => Promise<void> | void;
  readonly onClearAll: () => void;
  /**
   * Start the composer round-trip edit for this row. Optional: the row edit
   * affordance only appears when wired.
   */
  readonly onEdit?: (promptId: string) => void;
  /** Row whose text is currently parked in the composer for editing. */
  readonly editingPromptId?: string;
  /**
   * Reorder (wire `:move`; `targetIndex` is the post-removal slot, matching
   * the engine's splice-out-then-insert semantics). Optional: drag handles
   * only appear when wired.
   */
  readonly onMove?: (promptId: string, targetIndex: number) => Promise<void> | void;
  /**
   * Re-time a parked prompt (wire `:timing`). Optional: the per-row timing
   * dropdown only appears when wired.
   */
  readonly onChangeTiming?: (promptId: string, timing: DeferredAppendTiming) => Promise<void> | void;
  /** Steer is a send-equivalent; disable it while the session is resyncing. */
  readonly sendNowDisabled?: boolean;
}) {
  const { t, tp } = useI18n();
  const listId = useId();
  // A row with an in-flight action stays disabled until the action settles
  // (success removes the row via reconcile; failure keeps it, re-enabled,
  // with the view-level error line explaining why).
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // Two-step remove: the first click arms the row's button, the second runs.
  const [armedRemoveId, setArmedRemoveId] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drag reorder: the dragged row's id plus the insertion slot (in pre-removal
  // terms, 0..items.length) the pointer currently hovers.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  useEffect(() => {
    setPendingIds((current) => current.filter((id) => items.some((item) => item.promptId === id)));
  }, [items]);
  // Reset to the expanded default as the queue drains to a single row; disarm
  // a remove whose row left the queue underneath it.
  useEffect(() => {
    if (items.length <= 1 && collapsed) setCollapsed(false);
    if (armedRemoveId !== null && !items.some((item) => item.promptId === armedRemoveId)) {
      setArmedRemoveId(null);
    }
  }, [items, collapsed, armedRemoveId]);
  useEffect(
    () => () => {
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    },
    [],
  );

  if (items.length === 0) return null;

  // An in-flight action locks drag reordering: a second move computed against
  // the pre-move order would land on a stale slot.
  const interactionLocked = pendingIds.length > 0;
  const draggable = onMove !== undefined && items.length > 1;
  // The composer round-trip edit keeps its row visible and identifiable.
  const expanded = !collapsed || editingPromptId !== undefined;
  const listVisible = items.length === 1 || expanded;

  const run = (promptId: string, action: (promptId: string) => Promise<void> | void) => {
    if (pendingIds.includes(promptId)) return;
    setPendingIds([...pendingIds, promptId]);
    void Promise.resolve(action(promptId)).finally(() => {
      setPendingIds((current) => current.filter((id) => id !== promptId));
    });
  };

  const armRemove = (promptId: string) => {
    setArmedRemoveId(promptId);
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => { setArmedRemoveId(null); }, REMOVE_ARM_TIMEOUT_MS);
  };

  const clickRemove = (promptId: string) => {
    if (armedRemoveId !== promptId) {
      armRemove(promptId);
      return;
    }
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    setArmedRemoveId(null);
    run(promptId, onRemove);
  };

  const moveBy = (promptId: string, index: number, delta: -1 | 1) => {
    if (onMove === undefined || interactionLocked) return;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    run(promptId, (id) => onMove(id, targetIndex));
  };

  const clearDrag = () => {
    setDragId(null);
    setDropSlot(null);
  };

  const rowDragOver = (event: DragEvent, index: number) => {
    if (dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const before = rect.height === 0 ? true : (event.clientY - rect.top) / rect.height < 0.5;
    setDropSlot(before ? index : index + 1);
  };

  const rowDrop = (event: DragEvent) => {
    if (dragId === null) return;
    event.preventDefault();
    const from = items.findIndex((item) => item.promptId === dragId);
    const slot = dropSlot;
    clearDrag();
    if (onMove === undefined || interactionLocked || from < 0 || slot === null) return;
    // The engine's target index counts the list AFTER the row is lifted out.
    const targetIndex = slot > from ? slot - 1 : slot;
    if (targetIndex === from) return;
    run(dragId, (id) => onMove(id, targetIndex));
  };

  const handleDragStart = (event: DragEvent, promptId: string) => {
    if (onMove === undefined || interactionLocked) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(QUEUE_DRAG_MIME, promptId);
    // Firefox only starts a drag when text data rides along.
    event.dataTransfer.setData('text/plain', promptId);
    event.dataTransfer.effectAllowed = 'move';
    const row = event.currentTarget.closest('li');
    if (row !== null) event.dataTransfer.setDragImage(row, 12, 12);
    setDragId(promptId);
  };

  const handleKeyDown = (event: KeyboardEvent, promptId: string, index: number) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveBy(promptId, index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveBy(promptId, index, 1);
    }
  };

  const countLabel = tp('sv.queueBar', items.length);
  const rows: ReactNode[] = [];
  items.forEach((item, index) => {
    const pending = pendingIds.includes(item.promptId);
    const isEditing = editingPromptId === item.promptId;
    const editLocked = editingPromptId !== undefined && !isEditing;
    const armed = armedRemoveId === item.promptId;
    if (dropSlot === index) {
      rows.push(<li key={`drop-${index}`} aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
    }
    rows.push(
      <li
        key={item.promptId}
        onDragOver={(event) => { rowDragOver(event, index); }}
        onDrop={rowDrop}
        className={`anim-enter group flex flex-wrap items-center gap-2 rounded-lg border bg-panel px-2.5 py-1.5 ${
          isEditing ? 'border-amber-ink/60 ring-1 ring-amber-rule/60' : 'border-amber-rule/30'
        } ${dragId === item.promptId ? 'opacity-50' : ''}`}
      >
        {draggable ? (
          <button
            type="button"
            draggable={!pending && !interactionLocked && !isEditing}
            onDragStart={(event) => { handleDragStart(event, item.promptId); }}
            onDragEnd={clearDrag}
            onKeyDown={(event) => { handleKeyDown(event, item.promptId, index); }}
            disabled={pending || interactionLocked || isEditing}
            title={t('queue.dragHandleTitle')}
            aria-label={t('queue.dragHandleAria')}
            className="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-[11px] leading-none text-amber-ink/60 transition-colors hover:bg-amber-rule/20 hover:text-amber-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none active:cursor-grabbing"
          >
            <span aria-hidden>⠿</span>
          </button>
        ) : null}
        <span aria-hidden className="shrink-0 font-mono text-[10px] font-semibold text-amber-ink/70">
          #{index + 1}
        </span>
        <span
          title={item.text === '' ? undefined : item.text}
          className="min-w-0 flex-1 basis-36 truncate text-[12px] text-ink"
        >
          {item.text === '' ? t('sv.queueNoText') : item.text}
        </span>
        {item.media?.map((media, mediaIndex) => {
          const label = media.name ?? media.mime ?? t('media.attachment');
          return (
            <span key={`${item.promptId}-media-${mediaIndex}`} className="inline-flex max-w-28 shrink-0 items-center gap-1 rounded border border-amber-rule/50 bg-panel px-1.5 py-0.5 text-[10px] text-amber-ink" title={label}>
              {media.kind === 'image' && media.url !== undefined ? (
                <img src={media.url} alt="" className="h-4 w-4 rounded object-cover" />
              ) : null}
              <span className="truncate">{label}</span>
              {onRemoveAttachment !== undefined && item.content !== undefined && !isEditing ? (
                <button
                  type="button"
                  aria-label={`${t('sv.queueRemove')} ${label}`}
                  disabled={pending || editLocked || (item.text.trim() === '' && item.media?.length === 1)}
                  onClick={() => { run(item.promptId, (id) => onRemoveAttachment(id, mediaIndex)); }}
                  className="rounded px-0.5 hover:bg-amber-rule/20 disabled:opacity-40"
                >×</button>
              ) : null}
            </span>
          );
        })}
        {isEditing ? (
          <span className="shrink-0 rounded-full border border-amber-rule/60 bg-amber-card px-2 py-0.5 text-[10.5px] font-medium text-amber-ink">
            {t('queue.editingBadge')}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {onChangeTiming !== undefined ? (
              <select
                aria-label={t('queue.timingAria')}
                data-timing-picker={item.promptId}
                disabled={pending}
                title={t(TIMING_HINT_KEY[item.appendTiming ?? 'agent_idle'])}
                value={item.appendTiming ?? 'agent_idle'}
                onChange={(event) => {
                  const timing = event.target.value as DeferredAppendTiming;
                  if (timing === (item.appendTiming ?? 'agent_idle')) return;
                  run(item.promptId, (id) => onChangeTiming(id, timing));
                }}
                className="rounded-full border border-amber-rule/50 bg-panel px-1.5 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
              >
                {QUEUE_TIMINGS.map((timing) => (
                  <option key={timing} value={timing} data-timing={timing}>
                    {t(TIMING_SHORT_KEY[timing])}
                  </option>
                ))}
              </select>
            ) : null}
            {onEdit !== undefined && (item.text !== '' || (item.media?.length ?? 0) > 0) ? (
              <button
                type="button"
                disabled={pending || editLocked}
                onClick={() => { onEdit(item.promptId); }}
                title={t('queue.editTitle')}
                aria-label={t('sv.queueEditAria')}
                className="rounded-full border border-amber-rule/50 px-2 py-0.5 text-[10.5px] font-medium text-amber-ink transition-colors hover:bg-amber-rule/20 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-amber-rule/60 focus-visible:outline-none"
              >
                {t('sv.queueEdit')}
              </button>
            ) : null}
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
              onClick={() => { clickRemove(item.promptId); }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && armed) {
                  event.preventDefault();
                  event.stopPropagation();
                  setArmedRemoveId(null);
                }
              }}
              title={armed ? t('queue.removeConfirmTitle') : t('sv.queueRemoveTitle')}
              aria-label={armed ? t('queue.removeConfirm') : t('sv.queueRemove')}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:outline-none ${
                armed
                  ? 'border-danger/60 bg-danger/10 text-danger hover:bg-danger/20 focus-visible:ring-danger/50'
                  : 'border-amber-rule/50 text-amber-ink hover:bg-amber-rule/20 focus-visible:ring-amber-rule/60'
              }`}
            >
              {armed ? t('queue.removeConfirm') : t('sv.queueRemove')}
            </button>
          </span>
        )}
      </li>,
    );
  });
  if (dropSlot === items.length) {
    rows.push(<li key="drop-end" aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
  }

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
              disabled={editingPromptId !== undefined}
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
        <ol
          id={listId}
          hidden={!listVisible}
          className="mt-1.5 flex-col gap-1"
          style={{ display: listVisible ? 'flex' : undefined }}
        >
          {rows}
        </ol>
      </section>
    </div>
  );
}
