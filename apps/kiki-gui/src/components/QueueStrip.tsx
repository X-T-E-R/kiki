/**
 * QueueStrip — the parked-prompt queue's detail, grown inside the composer card
 * (see ComposerHeader; the row summary itself is QueueHeaderSummary):
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
 *                    ORIGINAL position (wire `:replace`, no requeue). While the
 *                    edit is open the engine holds that prompt AND every prompt
 *                    behind it (wire `:hold`); prompts ahead of it still run.
 *                    The detail says so: a notice line, the edited row's own
 *                    readiness ("ready — sends when you finish"), and a
 *                    "waits for your edit" hint on each row behind it;
 *       Remove   — two-step: the first click arms the button ("Remove?"), the
 *                    second actually aborts the queued prompt. The engine
 *                    drops the before-start transcript block, so nothing stays
 *                    behind on the timeline.
 *   - with more than one parked prompt a drag handle (⠿) leads each row: drag
 *     onto another row to land before/after it, or focus the handle and move
 *     with ↑/↓ — both go through `:move` (prompt.moved) and the strip
 *     repaints from the server's authoritative order;
 *   - a header with the count plus Clear all.
 *
 * The parent renders nothing for an empty queue; rows leave by reconcile
 * (promotion, steer, abort) — never by local removal.
 */

import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { DeferredAppendTiming } from '@kiki/protocol';
import type { QueuedPromptPreview } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { Icon } from './icons';

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

/**
 * The queue sheet's label behind the composer card: "下一条 <first prompt>"
 * on the left, "N 条待发送" on the right, and "已暂停" in place of the
 * preview while an edit holds the queue.
 */
export function QueueHeaderSummary({
  count,
  preview,
  editing = false,
}: {
  readonly count: number;
  readonly preview?: string;
  /** A queued prompt is parked in the composer: the queue waits on the user. */
  readonly editing?: boolean;
}) {
  const { t, tp } = useI18n();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 font-medium text-section-ink">
        {editing ? t('composer.queueStack.editing') : t('composer.queueStack.next')}
      </span>
      {editing ? (
        <span data-queue-paused className="min-w-0 flex-1 truncate">{t('queue.headerPaused')}</span>
      ) : (
        <span data-queue-row-preview className="min-w-0 flex-1 truncate text-ink-soft">{preview ?? ''}</span>
      )}
      <span data-queue-count className="flex shrink-0 items-center gap-1 text-[12px] text-ink-faint tabular-nums">
        {tp('composer.queueStack.count', count)}
        <Icon name="chevron" size={12} className="-rotate-90" />
      </span>
    </span>
  );
}

const HEAD_ACTION =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-10';

/** Send-now and edit for the next queued prompt, beside the queue sheet's label. */
export function QueueHeadActions({
  onSendNow,
  onEdit,
  sendNowDisabled = false,
}: {
  readonly onSendNow: () => void;
  readonly onEdit: () => void;
  readonly sendNowDisabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" data-queue-head-send-now disabled={sendNowDisabled} onClick={onSendNow}
        aria-label={t('sv.queueSendNow')} title={sendNowDisabled ? t('sv.sendPaused') : t('sv.queueSendNowTitle')} className={HEAD_ACTION}>
        <Icon name="arrowUpRight" size={12} />
      </button>
      <button type="button" data-queue-head-edit onClick={onEdit}
        aria-label={t('sv.queueEditAria')} title={t('queue.editTitle')} className={HEAD_ACTION}>
        <Icon name="edit" size={12} />
      </button>
    </>
  );
}

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
  timingReady,
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
  /**
   * Whether a timing condition is met right now (agent idle and the awaited
   * work done). Only used to tell the user an edited prompt would already be
   * sending; absent means "unknown" and the row just shows its timing.
   */
  readonly timingReady?: (timing: DeferredAppendTiming) => boolean;
}) {
  const { t } = useI18n();
  const noticeId = useId();
  // A row with an in-flight action stays disabled until the action settles
  // (success removes the row via reconcile; failure keeps it, re-enabled,
  // with the view-level error line explaining why).
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  // Two-step remove: the first click arms the row's button, the second runs.
  const [armedRemoveId, setArmedRemoveId] = useState<string | null>(null);
  // Touch has no hover: a row's ⋯ toggle opens its actions instead.
  const [touchOpenId, setTouchOpenId] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drag reorder: the dragged row's id plus the insertion slot (in pre-removal
  // terms, 0..items.length) the pointer currently hovers.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  useEffect(() => {
    setPendingIds((current) => current.filter((id) => items.some((item) => item.promptId === id)));
  }, [items]);
  // Disarm a remove whose row left the queue underneath it.
  useEffect(() => {
    if (armedRemoveId !== null && !items.some((item) => item.promptId === armedRemoveId)) {
      setArmedRemoveId(null);
    }
  }, [items, armedRemoveId]);
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
  // Edit hold: the edited row and every row behind it wait for the edit.
  const editIndex = editingPromptId === undefined ? -1 : items.findIndex((item) => item.promptId === editingPromptId);

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

  const rows: ReactNode[] = [];
  items.forEach((item, index) => {
    const pending = pendingIds.includes(item.promptId);
    const isEditing = editingPromptId === item.promptId;
    const editLocked = editingPromptId !== undefined && !isEditing;
    const armed = armedRemoveId === item.promptId;
    // Queued behind the prompt being edited: holds its place until the edit ends.
    const waitsForEdit = editIndex >= 0 && index > editIndex;
    const timing = item.appendTiming ?? 'agent_idle';
    if (dropSlot === index) {
      rows.push(<li key={`drop-${index}`} aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
    }
    rows.push(
      <li
        key={item.promptId}
        onDragOver={(event) => { rowDragOver(event, index); }}
        onDrop={rowDrop}
        data-queue-item={item.promptId}
        data-queue-waits-edit={waitsForEdit ? '' : undefined}
        className={`anim-enter group flex min-h-8 flex-wrap items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] ${
          isEditing ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.04] focus-within:bg-ink/[0.04]'
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
            className="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-[11px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none active:cursor-grabbing"
          >
            <Icon name="grip" size={12} />
          </button>
        ) : null}
        <span aria-hidden className="w-4 shrink-0 text-right text-[12px] text-ink-faint tabular-nums">
          {index + 1}
        </span>
        <span
          title={item.text === '' ? undefined : item.text}
          className="min-w-0 flex-1 basis-36 truncate text-[13px] text-ink"
        >
          {item.text === '' ? t('sv.queueNoText') : item.text}
        </span>
        {item.media?.map((media, mediaIndex) => {
          const label = media.name ?? media.mime ?? t('media.attachment');
          return (
            <span key={`${item.promptId}-media-${mediaIndex}`} className="inline-flex max-w-28 shrink-0 items-center gap-1 rounded-[4px] bg-paper px-1.5 py-0.5 text-[12px] text-ink-soft" title={label}>
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
                  className="flex h-4 w-4 items-center justify-center rounded hover:bg-hairline disabled:opacity-40"
                ><Icon name="close" size={12} /></button>
              ) : null}
            </span>
          );
        })}
        {isEditing ? (
          <span data-queue-edit-status className="shrink-0 text-[12px] text-ink-soft">
            {/* The edited prompt's own start condition, so a met condition
                ("after subagents" and they are done) reads as ready, not stuck. */}
            {timingReady?.(timing) === true
              ? t('queue.editReady')
              : t('queue.editWaiting', { timing: t(TIMING_SHORT_KEY[timing]) })}
          </span>
        ) : (
          <>
          <button
            type="button"
            aria-label={t('queue.rowActionsAria')}
            aria-expanded={touchOpenId === item.promptId}
            onClick={() => { setTouchOpenId((current) => (current === item.promptId ? null : item.promptId)); }}
            className="dock-more ml-auto h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
          >
            <Icon name="more" size={14} />
          </button>
          {waitsForEdit ? (
            <span data-queue-waits-hint className="shrink-0 text-[12px] text-ink-faint">
              {t('queue.waitsForEdit')}
            </span>
          ) : null}
          <span
            data-queue-row-actions
            data-shown={armed || touchOpenId === item.promptId ? '' : undefined}
            className="dock-reveal ml-auto flex shrink-0 items-center gap-0.5"
          >
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
                className="h-7 rounded-md border border-transparent bg-transparent px-1 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
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
                className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
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
              className="h-7 rounded-md px-2 text-[12px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
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
              className={`h-7 rounded-md px-2 text-[12px] font-medium transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:outline-none ${
                armed
                  ? 'bg-danger/10 text-danger hover:bg-danger/15 focus-visible:ring-danger/50'
                  : 'text-ink-soft hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-accent/40'
              }`}
            >
              {armed ? t('queue.removeConfirm') : t('sv.queueRemove')}
            </button>
          </span>
          </>
        )}
      </li>,
    );
  });
  if (dropSlot === items.length) {
    rows.push(<li key="drop-end" aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
  }

  return (
    <section
      data-queue-strip
      data-queue-edit-hold={editIndex >= 0 ? '' : undefined}
      aria-label={t('sv.queueAria')}
      aria-describedby={editIndex >= 0 ? noticeId : undefined}
    >
      <header className="flex min-h-7 items-center gap-2 pl-1.5">
        {/* The row already names the count; the header reads as drain order. */}
        <span className="min-w-0 flex-1 text-[12px] text-ink-faint">{t('queue.drainOrder')}</span>
        <button
          type="button"
          onClick={onClearAll}
          title={t('sv.queueClearAllTitle')}
          className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          {t('sv.queueClearAll')}
        </button>
      </header>
      {editIndex >= 0 ? (
        <p id={noticeId} role="status" data-queue-hold-notice className="flex items-center gap-1.5 px-1.5 pb-1 text-[12px] text-ink-soft">
          <Icon name="hold" size={12} className="shrink-0 text-ink-faint" />
          <span className="min-w-0">
            {editIndex > 0 ? t('queue.holdNoticeAhead', { count: editIndex }) : t('queue.holdNotice')}
          </span>
        </p>
      ) : null}
      <ol className="flex flex-col gap-0.5 pb-1">
        {rows}
      </ol>
    </section>
  );
}
