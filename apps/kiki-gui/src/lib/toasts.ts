/**
 * Toast store — framework-free so any layer (SessionView catch sites, route
 * fallbacks) can raise a toast without prop drilling. `Toasts.tsx` subscribes
 * and renders the stack; auto-dismiss timers live in the component, keeping
 * this module a pure synchronous queue (unit-test friendly).
 *
 * Queue rules: newest last, capped at MAX_TOASTS — the oldest entry is dropped
 * when a push would overflow, so a burst of failures never floods the screen.
 */

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastRetry {
  /** Re-runs the failed action; failures are expected to raise a fresh toast. */
  readonly run: () => void;
}

export interface ToastInput {
  readonly tone: ToastTone;
  readonly text: string;
  /** Errors only: an optional retry action rendered beside the close button. */
  readonly retry?: ToastRetry;
}

export interface ToastItem extends ToastInput {
  readonly id: number;
}

/** Success/info toasts self-dismiss after this long; errors stay sticky. */
export const TOAST_AUTO_DISMISS_MS = 3600;
export const MAX_TOASTS = 5;

type Listener = () => void;

let toasts: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
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

export function pushToast(input: ToastInput): number {
  const id = nextId;
  nextId += 1;
  toasts = [...toasts, { ...input, id }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

/** Test hook: reset the queue and id counter between cases. */
export function clearToasts(): void {
  toasts = [];
  nextId = 1;
  emit();
}
