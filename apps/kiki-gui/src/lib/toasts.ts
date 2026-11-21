/**
 * Toast store — backed by `@base-ui/react/toast`'s `createToastManager()` while
 * keeping the framework-free synchronous facade (`pushToast`, `pushUndoToast`,
 * `runToastAction`, `dismissToast`, `clearToasts`, `getToasts`, `subscribeToasts`)
 * so every caller and unit test keeps the exact same contract.
 *
 * Queue rules: newest last, capped at MAX_TOASTS — the oldest entry is dropped
 * when a push would overflow, so a burst of failures never floods the screen.
 */

import { Toast } from '@base-ui/react/toast';
import { errorToText } from '@kiki/session-core/util';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastRetry {
  /** Re-runs the failed action; failures are expected to raise a fresh toast. */
  readonly run: () => void;
  /**
   * Overrides the default "Retry" label. A toast that offers to reverse what
   * just happened (an undo) must not be labelled as repeating it.
   */
  readonly label?: string;
}

export interface ToastAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface ToastInput {
  readonly tone: ToastTone;
  readonly text: string;
  /** Optional error details (code, requestId, full trace). */
  readonly detail?: string;
  readonly code?: number | string;
  readonly requestId?: string;
  /** Errors only: an optional retry action rendered beside the close button. */
  readonly retry?: ToastRetry;
  /** Optional follow-up action on a success/info toast (e.g. "Switch" after pairing). */
  readonly action?: ToastAction;
  /**
   * The one action of an undo toast (see `pushUndoToast`). It runs the inverse
   * of a change that already happened; it never commits a deferred one.
   */
  readonly undo?: ToastUndo;
  /** Overrides the auto-dismiss delay; undo toasts default to UNDO_TOAST_MS. */
  readonly durationMs?: number;
}

export interface ToastUndo {
  /** Performs the inverse operation. A rejection raises an error toast. */
  readonly run: () => void | Promise<void>;
  /** Overrides the default "Undo" label. */
  readonly label?: string;
}

export interface ToastItem extends ToastInput {
  readonly id: number;
}

/** Success/info toasts self-dismiss after this long; errors stay sticky. */
export const TOAST_AUTO_DISMISS_MS = 3600;
export const MAX_TOASTS = 5;
/** How long an undo stays offered. Hovering or focusing the toast pauses it. */
export const UNDO_TOAST_MS = 8000;

export const toastManager = Toast.createToastManager<ToastItem>();

type Listener = () => void;

let toasts: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function removeLocalToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function toastTimeoutFor(item: ToastItem): number {
  return item.tone === 'error' ? 0 : (item.durationMs ?? TOAST_AUTO_DISMISS_MS);
}

export function addItemToManager(item: ToastItem): void {
  toastManager.add({
    id: String(item.id),
    title: item.text,
    type: item.undo !== undefined ? 'undo' : item.tone,
    timeout: toastTimeoutFor(item),
    priority: item.tone === 'error' ? 'high' : 'low',
    data: item,
    onClose: () => {
      removeLocalToast(item.id);
    },
  });
}

export function getToasts(): readonly ToastItem[] {
  return toasts;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function toastDedupKey(input: ToastInput): string | null {
  // Undo toasts carry distinct inverse callbacks and must remain separate.
  if (input.undo !== undefined) return null;
  return JSON.stringify([
    input.tone,
    input.text,
    input.detail ?? '',
    input.code ?? '',
    input.requestId ?? '',
  ]);
}

export function pushToast(input: ToastInput): number {
  const dedupKey = toastDedupKey(input);
  if (dedupKey !== null) {
    const existingIndex = toasts.findIndex((candidate) => toastDedupKey(candidate) === dedupKey);
    if (existingIndex !== -1) {
      const existing = toasts[existingIndex]!;
      const updated: ToastItem = { ...input, id: existing.id };
      toasts = [...toasts.slice(0, existingIndex), ...toasts.slice(existingIndex + 1), updated];
      toastManager.update(String(existing.id), {
        title: updated.text,
        type: updated.tone,
        timeout: toastTimeoutFor(updated),
        priority: updated.tone === 'error' ? 'high' : 'low',
        data: updated,
      });
      emit();
      return existing.id;
    }
  }
  const id = nextId;
  nextId += 1;
  const item: ToastItem = { ...input, id };
  const combined = [...toasts, item];
  const overflowCount = Math.max(0, combined.length - MAX_TOASTS);
  const dropped = combined.slice(0, overflowCount);
  toasts = combined.slice(overflowCount);
  for (const old of dropped) {
    toastManager.close(String(old.id));
  }
  addItemToManager(item);
  emit();
  return id;
}

/**
 * The reversible-action tier of the surface ladder (components/overlays/README.md):
 * the change has already been written; this toast offers its inverse.
 *
 *   await client.removeThing(id);
 *   pushUndoToast({ text: t('x.removed', { name }), undo: () => client.addThing(saved) });
 *
 * `undo` must restore the same data the action removed (keep what you need
 * before the action runs). Failures inside `undo` raise an error toast with
 * the message, so callers do not wrap it themselves.
 */
export function pushUndoToast(input: { readonly text: string; readonly undo: () => void | Promise<void>; readonly label?: string; readonly durationMs?: number; readonly undoFailedText?: string }): number {
  const id = pushToast({
    tone: 'success',
    text: input.text,
    durationMs: input.durationMs ?? UNDO_TOAST_MS,
    undo: {
      label: input.label,
      run: async () => {
        try {
          await input.undo();
        } catch (error) {
          pushToast({ tone: 'error', text: input.undoFailedText === undefined ? actionErrorMessage(error) : `${input.undoFailedText}: ${actionErrorMessage(error)}` });
        }
      },
    },
  });
  return id;
}

function actionErrorMessage(error: unknown): string {
  return errorToText(error);
}

export function runToastAction(label: string, action: () => void | Promise<void>): void {
  const reportFailure = (error: unknown): void => {
    pushToast({
      tone: 'error',
      text: `${label}: ${actionErrorMessage(error)}`,
      retry: { run: () => { runToastAction(label, action); } },
    });
  };
  try {
    void Promise.resolve(action()).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  toastManager.close(String(id));
  emit();
}

/** Dismiss sticky error toasts on route navigation while preserving success/undo feedback. */
export function clearErrorToasts(): void {
  const errorToasts = toasts.filter((item) => item.tone === 'error');
  if (errorToasts.length === 0) return;
  toasts = toasts.filter((item) => item.tone !== 'error');
  for (const item of errorToasts) {
    toastManager.close(String(item.id));
  }
  emit();
}

/** Test hook: reset the queue and id counter between cases. */
export function clearToasts(): void {
  const previous = toasts;
  toasts = [];
  nextId = 1;
  for (const item of previous) {
    toastManager.close(String(item.id));
  }
  toastManager.close();
  emit();
}
