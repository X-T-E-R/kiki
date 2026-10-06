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
 * A scheduled prompt appears in this list too, but only as something to read.
 * A `queue` cron record really is in the person's send order, so it keeps the
 * same drag handle, timing picker and Send now a typed message has. An `idle`
 * or `steer` record is held by the engine outside that order: its row names the
 * timing that holds it, and the re-order / rush-it-now controls are simply
 * absent — not present and greyed out, which reads as a broken row. A message
 * the user never queued cannot be re-timed like one they did, and Remove stays
 * on every row because the record is real work that can be withdrawn.
 *
 * The parent renders nothing for an empty queue; rows leave by reconcile
 * (promotion, steer, abort) — never by local removal.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

import type { DeferredAppendTiming } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { stripThreadRefContext } from '@kiki/session-core/composer';
import type { QueuedPromptPreview } from '@kiki/session-core/session';
import { isOrdinaryQueueItem } from '@kiki/session-core/session';
import { mergeSessionQueueRows, pendingModelSwitchChange, type SessionQueueRow } from '@kiki/session-core/session/modelSwitchQueue';
import { useI18n } from '../i18n';
import type { QueuedModelSwitch } from '../lib/client';
import { Icon } from './icons';

/** The armed remove falls back to idle after this long without the second click. */
const REMOVE_ARM_TIMEOUT_MS = 5_000;

const QUEUE_TIMINGS: readonly DeferredAppendTiming[] = ['agent_idle', 'subagents_done', 'tasks_done'];

export const TIMING_SHORT_KEY = {
  agent_idle: 'timing.short.agentIdle',
  subagents_done: 'timing.short.subagentsDone',
  tasks_done: 'timing.short.tasksDone',
} as const;

export const TIMING_HINT_KEY = {
  agent_idle: 'timing.hint.agentIdle',
  subagents_done: 'timing.hint.subagentsDone',
  tasks_done: 'timing.hint.tasksDone',
} as const;

/**
 * The queue sheet's label behind the composer card: "N 条待发送" on the left,
 * the disclosure chevron on the right. The first prompt's preview and quick
 * actions live in the detail, not on the strip.
 *
 * `count` is the ordinary send-order count. A scheduled record the engine
 * holds outside that order still gets a row in the opened detail, so it is
 * named here rather than inflating a count of messages waiting to go — and
 * when it is the only thing waiting, it stands alone rather than sitting
 * behind a "0 queued" that reads as nothing to send.
 */
export function QueueHeaderSummary({ count, heldCount = 0 }: { readonly count: number; readonly heldCount?: number }) {
  const { t, tp } = useI18n();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {count > 0 ? (
        <span data-queue-count className="shrink-0 font-medium text-section-ink tabular-nums">
          {tp('composer.queueStack.count', count)}
        </span>
      ) : null}
      {heldCount > 0 ? (
        <span
          data-queue-held-count
          className={count > 0 ? 'min-w-0 truncate text-[12px] text-ink-faint' : 'shrink-0 font-medium text-section-ink'}
        >
          {count > 0
            ? t('queue.heldSummary', { count: heldCount })
            : t('queue.heldOnlySummary', { count: heldCount })}
        </span>
      ) : null}
      <Icon name="chevron" size={12} className="ml-auto -rotate-90 text-ink-faint" />
    </span>
  );
}

export function QueueStrip({
  items,
  modelSwitches,
  resolveModelId,
  onSendNow,
  onRemove,
  onRemoveAttachment,
  onClearAll,
  onEdit,
  editingPromptId,
  onMove,
  onChangeTiming,
  onEditModelSwitch,
  onCancelModelSwitch,
  sendNowDisabled = false,
  timingReady,
}: {
  readonly items: readonly QueuedPromptPreview[];
  /**
   * Queued model-switch control items. They share this list's drain order and
   * never render as messages: each keeps its own row with edit/cancel while
   * pending. A preparing item shows its state without a cancel button — by
   * contract only a pending operation can be cancelled.
   */
  readonly modelSwitches?: readonly QueuedModelSwitch[];
  readonly resolveModelId?: (value: string) => string;
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
  /** Reopen the switch panel for a pending control item. */
  readonly onEditModelSwitch?: (operationId: string) => void;
  /** Cancel a pending control item (clears the queued switch). */
  readonly onCancelModelSwitch?: (operationId: string) => Promise<void> | void;
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
  // terms, 0..rows.length) the pointer currently hovers.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pointerDragRef = useRef<{
    promptId: string; pointerId: number; x: number; y: number; active: boolean;
  } | null>(null);
  // One drain order over both kinds: messages keep their state order, a
  // switch claims its engine-assigned shared slot. A message move's target
  // index is then the very index the engine splices by.
  const rows = useMemo<readonly SessionQueueRow[]>(
    () => mergeSessionQueueRows(
      items.map((item) => ({ promptId: item.promptId, queuePosition: item.queuePosition })),
      (modelSwitches ?? [])
        .filter((entry) => entry.queueIndex >= 0)
        .map((entry) => ({ operationId: entry.input.operationId, queueIndex: entry.queueIndex })),
    ),
    [items, modelSwitches],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.promptId, item])), [items]);
  const switchById = useMemo(
    () => new Map((modelSwitches ?? []).map((entry) => [entry.input.operationId, entry])),
    [modelSwitches],
  );
  const rowKeys = useMemo(
    () => new Set(rows.map((row) => (row.kind === 'message' ? row.promptId : row.operationId))),
    [rows],
  );
  useEffect(() => {
    setPendingIds((current) => {
      const next = current.filter((id) => rowKeys.has(id));
      return next.length === current.length ? current : next;
    });
  }, [rowKeys]);
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

  if (rows.length === 0) return null;

  // An in-flight action locks drag reordering: a second move computed against
  // the pre-move order would land on a stale slot.
  const interactionLocked = pendingIds.length > 0;
  const draggable = onMove !== undefined && rows.length > 1;
  // Edit hold: the edited row and every row behind it wait for the edit.
  const editIndex = editingPromptId === undefined
    ? -1
    : rows.findIndex((row) => row.kind === 'message' && row.promptId === editingPromptId);

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
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    run(promptId, (id) => onMove(id, targetIndex));
  };

  const clearDrag = () => {
    pointerDragRef.current = null;
    setDragId(null);
    setDropSlot(null);
  };

  // Keep internal sorting out of native HTML5/OLE drag-and-drop: on Windows
  // Tauri owns that drop target for OS files, so HTML5 drops never reach rows.
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>, promptId: string) => {
    if (event.button !== 0 || !event.isPrimary || onMove === undefined || interactionLocked || editingPromptId === promptId) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = { promptId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
  };

  const pointerSlot = (event: PointerEvent<HTMLButtonElement>): number | null => {
    const list = listRef.current;
    if (list === null) return null;
    const rect = list.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    const viewport = list.closest<HTMLElement>('.composer-header-scroll')?.getBoundingClientRect();
    if (viewport !== undefined && (event.clientY < viewport.top || event.clientY > viewport.bottom)) return null;
    const rowElements = Array.from(list.querySelectorAll<HTMLElement>('[data-queue-item], [data-queue-model-switch]'));
    const index = rowElements.findIndex((element) => {
      const box = element.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    return index < 0 ? rowElements.length : index;
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.active = true;
    setDragId(drag.promptId);
    const scroll = listRef.current?.closest<HTMLElement>('.composer-header-scroll');
    if (scroll !== null && scroll !== undefined) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 24) scroll.scrollTop -= 12;
      else if (event.clientY > rect.bottom - 24) scroll.scrollTop += 12;
    }
    setDropSlot(pointerSlot(event));
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const from = rows.findIndex((row) => row.kind === 'message' && row.promptId === drag.promptId);
    const slot = drag.active ? pointerSlot(event) : null;
    clearDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (onMove === undefined || interactionLocked || editingPromptId === drag.promptId || from < 0 || slot === null) return;
    // The engine's target index counts the list AFTER the row is lifted out.
    const targetIndex = slot > from ? slot - 1 : slot;
    if (targetIndex === from) return;
    run(drag.promptId, (id) => onMove(id, targetIndex));
  };

  const handleKeyDown = (event: KeyboardEvent, promptId: string, index: number) => {
    if (event.key === 'Escape' && pointerDragRef.current !== null) {
      event.preventDefault();
      event.stopPropagation();
      clearDrag();
    } else if (pointerDragRef.current !== null) {
      return;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveBy(promptId, index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveBy(promptId, index, 1);
    }
  };

  const rowNodes: ReactNode[] = [];
  rows.forEach((row, index) => {
    if (dropSlot === index) {
      rowNodes.push(<li key={`drop-${index}`} aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
    }
    if (row.kind === 'modelSwitch') {
      const entry = switchById.get(row.operationId);
      if (entry === undefined) return;
      const pending = pendingIds.includes(row.operationId);
      const waitsForEdit = editIndex >= 0 && index > editIndex;
      const change = pendingModelSwitchChange({
        from: resolveModelId?.(entry.receipt.fromModel) ?? entry.receipt.fromModel,
        to: resolveModelId?.(entry.input.model) ?? entry.input.model,
        mode: entry.input.mode,
        originalThinking: entry.originalBinding.thinking,
        targetThinking: entry.input.thinking,
      });
      const pendingLabel = t(change === 'model' ? 'modelSwitch.pendingLine' : `modelSwitch.pendingLine.${change}` as I18nKey,
        { model: entry.receipt.toModel, effort: entry.input.thinking ?? '', mode: t(`modelSwitch.modeName.${entry.input.mode}` as I18nKey) });
      rowNodes.push(
        <li
          key={`switch-${row.operationId}`}
          data-queue-model-switch={row.operationId}
          data-model-switch-state={entry.receipt.state}
          data-queue-waits-edit={waitsForEdit ? '' : undefined}
          className="anim-enter group flex min-h-8 items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-within:bg-ink/[0.04]"
        >
          {/* Same widths as a message row's grip + index so the drain-order
              numbers line up; a control item does not reorder. */}
          {draggable ? <span aria-hidden className="h-5 w-4 shrink-0" /> : null}
          <span aria-hidden className="w-4 shrink-0 text-right text-[12px] text-ink-faint tabular-nums">
            {index + 1}
          </span>
          <Icon name="arrowRight" size={12} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft" title={entry.input.model}>
            {entry.receipt.state === 'preparing'
              ? change === 'effort' ? t('modelSwitch.preparingEffort', { effort: entry.input.thinking ?? '' }) : t(
                change === 'binding' ? 'transcript.modelSwitch.preparing.binding' : entry.input.mode === 'compact' ? 'transcript.modelSwitch.preparing.compact' : entry.input.mode === 'fresh'
                  ? 'transcript.modelSwitch.preparing.fresh'
                  : 'transcript.modelSwitch.preparing.direct',
                { from: entry.receipt.fromModel, to: entry.receipt.toModel },
              )
              : pendingLabel}
          </span>
          {waitsForEdit ? (
            <span data-queue-waits-hint className="shrink-0 text-[12px] text-ink-faint">
              {t('queue.waitsForEdit')}
            </span>
          ) : null}
          {entry.receipt.state === 'pending' ? (
            <span data-queue-model-switch-actions className="ml-auto flex shrink-0 items-center gap-0.5">
              {onEditModelSwitch !== undefined ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { onEditModelSwitch(row.operationId); }}
                  className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                >
                  {t('modelSwitch.action.edit')}
                </button>
              ) : null}
              {onCancelModelSwitch !== undefined ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { run(row.operationId, (id) => onCancelModelSwitch(id)); }}
                  className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
                >
                  {t('modelSwitch.action.cancel')}
                </button>
              ) : null}
            </span>
          ) : null}
        </li>,
      );
      return;
    }
    const item = itemById.get(row.promptId);
    if (item === undefined) return;
    const pending = pendingIds.includes(item.promptId);
    const isEditing = editingPromptId === item.promptId;
    const editLocked = editingPromptId !== undefined && !isEditing;
    const armed = armedRemoveId === item.promptId;
    // Queued behind the prompt being edited: holds its place until the edit ends.
    const waitsForEdit = editIndex >= 0 && index > editIndex;
    const timing = item.appendTiming ?? 'agent_idle';
    // A scheduled prompt the engine holds outside the ordinary send order:
    // `idle` and `steer`. Its row is here so its text is readable, not because
    // it is one of the messages the user is waiting to send — so it carries
    // the timing that holds it instead of the per-message timing picker, and
    // none of the controls that would re-order or rush it. The same predicate
    // the composer header counts with, so a row and the count cannot disagree.
    const held = !isOrdinaryQueueItem(item);
    // A held record always carries the mode that holds it; `undefined` here
    // means the row is in the ordinary order and needs no timing chip.
    const heldMode = held ? item.cronDeliveryMode : undefined;
    // A `queue` cron record really is in the user's send order, so it keeps
    // the same drag handle, timing picker and Send now as a typed message.
    const reordering = draggable && !held;
    rowNodes.push(
      <li
        key={item.promptId}
        data-queue-item={item.promptId}
        data-queue-held={held ? item.cronDeliveryMode : undefined}
        data-queue-waits-edit={waitsForEdit ? '' : undefined}
        className={`anim-enter group flex min-h-8 flex-wrap items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] ${
          isEditing ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.04] focus-within:bg-ink/[0.04]'
        } ${dragId === item.promptId ? 'opacity-50' : ''}`}
      >
        {reordering ? (
          <button
            type="button"
            onPointerDown={(event) => { handlePointerDown(event, item.promptId); }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={clearDrag}
            onLostPointerCapture={clearDrag}
            style={{ touchAction: 'none' }}
            onKeyDown={(event) => { handleKeyDown(event, item.promptId, index); }}
            disabled={pending || interactionLocked || isEditing}
            title={t('queue.dragHandleTitle')}
            aria-label={t('queue.dragHandleAria')}
            className="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-[11px] leading-none text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none active:cursor-grabbing"
          >
            <Icon name="grip" size={12} />
          </button>
        ) : null}
        <span aria-hidden className="w-4 shrink-0 text-right text-[12px] text-ink-faint tabular-nums">
          {index + 1}
        </span>
        {item.originKind === 'cron_job' ? (
          <details className="group/cron min-w-0 flex-1 basis-36 text-[13px] text-ink">
            <summary className="flex cursor-pointer items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
              <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft">{t('transcript.marker.cron')}</span>
              {/* Only a held row is marked, and held means the record carries a
                  mode; a legacy or `queue` record is in the ordinary FIFO and is
                  shown as one, because that is still where it is. */}
              {heldMode === undefined
                ? null
                : <span data-queue-held-mode className="shrink-0 text-[11px] text-ink-faint">
                  {t('queue.scheduledMode', { mode: t(`cron.delivery.${heldMode}`) })}
                </span>}
              <span className="min-w-0 truncate">{item.text}</span>
              <Icon name="chevron" size={12} className="shrink-0 transition-transform group-open/cron:rotate-90" />
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words pl-1 text-ink-soft">{item.text}</p>
          </details>
        ) : (
          <span
            title={item.text === '' ? undefined : stripThreadRefContext(item.text)}
            className="min-w-0 flex-1 basis-36 truncate text-[13px] text-ink"
          >
            {item.text === '' ? t('sv.queueNoText') : stripThreadRefContext(item.text)}
          </span>
        )}
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
            {onChangeTiming !== undefined && !held ? (
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
                className="h-7 rounded-md border border-transparent bg-transparent px-1 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              >
                {QUEUE_TIMINGS.map((timing) => (
                  <option key={timing} value={timing} data-timing={timing}>
                    {t(TIMING_SHORT_KEY[timing])}
                  </option>
                ))}
              </select>
            ) : null}
            {onEdit !== undefined && !held && item.originKind !== 'cron_job' && (item.text !== '' || (item.media?.length ?? 0) > 0) ? (
              <button
                type="button"
                disabled={pending || editLocked}
                onClick={() => { onEdit(item.promptId); }}
                title={t('queue.editTitle')}
                aria-label={t('sv.queueEditAria')}
                className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              >
                {t('sv.queueEdit')}
              </button>
            ) : null}
            {/* A held job gets no send now and no note saying why. Its badge
                and its timing chip already say what it is, and a greyed-out
                control beside a real one reads as a broken row rather than as
                a deliberate one. Remove stays: the record is real work that
                can be withdrawn. */}
            {held ? null : (
              <button
                type="button"
                disabled={pending || sendNowDisabled}
                onClick={() => { run(item.promptId, onSendNow); }}
                title={sendNowDisabled ? t('sv.sendPaused') : t('sv.queueSendNowTitle')}
                aria-label={t('sv.queueSendNow')}
                className="h-7 rounded-md px-2 text-[12px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              >
                {t('sv.queueSendNow')}
              </button>
            )}
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
                  : 'text-ink-soft hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-selected-ink/40'
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
  if (dropSlot === rows.length) {
    rowNodes.push(<li key="drop-end" aria-hidden className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />);
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
          className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
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
      <ol ref={listRef} className="flex flex-col gap-0.5 pb-1">
        {rowNodes}
      </ol>
    </section>
  );
}
