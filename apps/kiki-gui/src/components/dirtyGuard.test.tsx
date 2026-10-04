// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import { useDirtyGuardState } from './dirtyGuard';

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let root: Root;
let guard: ReturnType<typeof useDirtyGuardState>;
const rawNavigate = vi.fn();
function Harness() {
  guard = useDirtyGuardState({ pathname: '/settings/providers', search: '', hash: '' }, rawNavigate);
  return <input defaultValue="unsaved provider draft" />;
}
beforeAll(() => { env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; });
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; rawNavigate.mockReset(); });
async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => guard.value.reportDirty('provider-editor', true));
}

describe('connection/window dirty action guard', () => {
  it('keeps connection, URL and draft until confirm, cancels without side effects and executes once', async () => {
    await mount();
    const activate = vi.fn();
    await act(async () => guard.value.runAction!(activate, '/settings/spaces'));
    expect(guard.pending).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(rawNavigate).not.toHaveBeenCalled();
    await act(async () => guard.cancel());
    expect(guard.value.dirty).toBe(true);
    expect(document.querySelector('input')?.value).toBe('unsaved provider draft');
    await act(async () => guard.confirm());
    expect(activate).not.toHaveBeenCalled();
    await act(async () => guard.value.runAction!(activate, '/settings/spaces'));
    await act(async () => { guard.confirm(); guard.confirm(); });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(rawNavigate).toHaveBeenCalledExactlyOnceWith('/settings/spaces');
    expect(activate.mock.invocationCallOrder[0]).toBeLessThan(rawNavigate.mock.invocationCallOrder[0]!);
    expect(guard.pending).toBe(false);
  });

  it('replaces a pending connection action with navigation, without executing the old action', async () => {
    await mount();
    const obsolete = vi.fn();
    await act(async () => guard.value.runAction!(obsolete));
    await act(async () => guard.navigate('/new'));
    await act(async () => guard.confirm());
    expect(obsolete).not.toHaveBeenCalled();
    expect(rawNavigate).toHaveBeenCalledExactlyOnceWith('/new', undefined);
  });

  it('clears a throwing action before execution and does not navigate or replay it', async () => {
    await mount();
    const failed = vi.fn(() => { throw new Error('switch failed'); });
    await act(async () => guard.value.runAction!(failed, '/settings/spaces'));
    await act(async () => { expect(() => guard.confirm()).toThrow('switch failed'); guard.confirm(); });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(rawNavigate).not.toHaveBeenCalled();
    expect(guard.pending).toBe(false);
    expect(guard.value.dirty).toBe(true);
    const retry = vi.fn();
    await act(async () => guard.value.runAction!(retry));
    expect(retry).not.toHaveBeenCalled();
    await act(async () => guard.confirm());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('waits for an async connection action and never navigates after rejection or supersession', async () => {
    await mount();
    let reject!: (error: Error) => void;
    const failed = new Promise<void>((_resolve, no) => { reject = no; });
    await act(async () => guard.value.runAction!(() => failed, '/settings/spaces'));
    let result: void | Promise<void>;
    await act(async () => { result = guard.confirm(); guard.confirm(); });
    expect(rawNavigate).not.toHaveBeenCalled();
    await act(async () => {
      reject(new Error('connection failed'));
      await expect(result).rejects.toThrow('connection failed');
    });
    await act(async () => guard.confirm());
    expect(rawNavigate).not.toHaveBeenCalled();
    let resolve!: () => void;
    const late = new Promise<void>((yes) => { resolve = yes; });
    expect(guard.value.dirty).toBe(true);
    await act(async () => { guard.value.runAction!(() => late, '/settings/spaces'); result = guard.confirm(); });
    await act(async () => guard.navigate('/new'));
    await act(async () => { resolve(); await result; });
    expect(rawNavigate).not.toHaveBeenCalled();
    await act(async () => guard.confirm());
    expect(rawNavigate).toHaveBeenCalledExactlyOnceWith('/new', undefined);
  });

  it('preserves editor-specific discard and clean/no-op navigation behavior', async () => {
    await mount();
    const other = vi.fn();
    await act(async () => guard.value.confirmDiscard!('other-editor', other));
    expect(other).toHaveBeenCalledTimes(1);
    await act(async () => guard.navigate('/settings/providers'));
    expect(guard.pending).toBe(false);
    expect(guard.value.dirty).toBe(true);
    const discard = vi.fn();
    await act(async () => guard.value.confirmDiscard!('provider-editor', discard));
    expect(discard).not.toHaveBeenCalled();
    await act(async () => guard.confirm());
    expect(discard).toHaveBeenCalledTimes(1);
    expect(guard.value.dirty).toBe(false);
  });
});
