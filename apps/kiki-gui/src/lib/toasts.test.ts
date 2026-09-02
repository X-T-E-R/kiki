import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearToasts,
  dismissToast,
  getToasts,
  MAX_TOASTS,
  pushToast,
  runToastAction,
  subscribeToasts,
} from './toasts';

describe('toast queue', () => {
  beforeEach(() => {
    clearToasts();
  });

  it('appends newest last and assigns increasing ids', () => {
    const first = pushToast({ tone: 'info', text: 'one' });
    const second = pushToast({ tone: 'error', text: 'two' });
    const toasts = getToasts();
    expect(toasts.map((toast) => toast.text)).toEqual(['one', 'two']);
    expect(second).toBeGreaterThan(first);
    expect(toasts[1]?.tone).toBe('error');
  });

  it('dismisses by id and ignores unknown ids', () => {
    const first = pushToast({ tone: 'info', text: 'one' });
    const second = pushToast({ tone: 'info', text: 'two' });
    dismissToast(first);
    expect(getToasts().map((toast) => toast.id)).toEqual([second]);
    dismissToast(9999);
    expect(getToasts()).toHaveLength(1);
  });

  it('caps the stack at MAX_TOASTS, dropping the oldest entry', () => {
    for (let index = 0; index < MAX_TOASTS + 3; index += 1) {
      pushToast({ tone: 'info', text: `toast-${index}` });
    }
    const toasts = getToasts();
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts[0]?.text).toBe('toast-3');
    expect(toasts.at(-1)?.text).toBe(`toast-${MAX_TOASTS + 2}`);
  });

  it('notifies subscribers on push, dismiss, and clear', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeToasts(() => { seen.push(getToasts().length); });
    const id = pushToast({ tone: 'success', text: 'kept' });
    dismissToast(id);
    pushToast({ tone: 'info', text: 'again' });
    clearToasts();
    unsubscribe();
    pushToast({ tone: 'info', text: 'after unsubscribe' });
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('keeps the retry action on the queued item', () => {
    let ran = 0;
    pushToast({ tone: 'error', text: 'failed', retry: { run: () => { ran += 1; } } });
    getToasts()[0]?.retry?.run();
    expect(ran).toBe(1);
  });

  it('reports rejected actions with a sticky error toast and retry', async () => {
    let attempts = 0;
    runToastAction('Copy', () => {
      attempts += 1;
      return Promise.reject(new Error('clipboard denied'));
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(getToasts()[0]).toMatchObject({
      tone: 'error',
      text: 'Copy: clipboard denied',
    });
    getToasts()[0]?.retry?.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
  });

  it('reports synchronous action failures', () => {
    runToastAction('Open', () => { throw new Error('opener failed'); });
    expect(getToasts()[0]).toMatchObject({
      tone: 'error',
      text: 'Open: opener failed',
    });
  });
});
