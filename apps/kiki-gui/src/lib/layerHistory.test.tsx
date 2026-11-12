// @vitest-environment jsdom

/**
 * The layer-history stacking contract against jsdom's real session history,
 * whose `history.back()`/`go()` traverse asynchronously like a browser's. The
 * owner's reaction to a back press (flipping `open` off) is applied by hand so
 * each step is explicit.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { useLayerHistory } from './layerHistory';

function Layer({ id, open, onClose }: { id: string; open: boolean; onClose: (id: string) => void }) {
  useLayerHistory(id, open, () => { onClose(id); });
  return null;
}

let setOpen: (next: Record<string, boolean>) => void = () => {};
function Harness({ order, onClose }: { order: readonly string[]; onClose: (id: string) => void }) {
  const [open, set] = useState<Record<string, boolean>>({});
  setOpen = (next) => { set((previous) => ({ ...previous, ...next })); };
  return <>{order.map((id) => <Layer key={id} id={id} open={open[id] === true} onClose={onClose} />)}</>;
}

interface HistoryState { usr: Record<string, unknown>; key: string; idx: number }

let root: Root;
let container: HTMLDivElement;
let base: HistoryState;
let visit = 0;
const onClose = vi.fn<(id: string) => void>();

const state = () => window.history.state as HistoryState;
const popped = () => new Promise<void>((resolve) => { window.addEventListener('popstate', () => { resolve(); }, { once: true }); });
// Long enough for any stray traversal (two queued tasks in jsdom) to land.
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 30); });
const render = (order: readonly string[]) => act(async () => { root.render(<Harness order={order} onClose={onClose} />); });
const update = (next: Record<string, boolean>) => act(async () => { setOpen(next); });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  visit += 1;
  // A fresh route entry per test: a stray extra traversal would land on the
  // previous test's entry, which never equals this one.
  base = { usr: { kikiNav: { visitId: `visit-${visit}` } }, key: `route-${visit}`, idx: visit };
  window.history.pushState(base, '');
  onClose.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await settle();
  container.remove();
});

it('pushes one entry carrying the route state and consumes it on an in-app close', async () => {
  await render(['a']);
  await update({ a: true });
  expect(state().key).toBe(base.key);
  expect(state().usr).toEqual({ ...base.usr, kikiLayer: 'a', kikiLayerToken: expect.any(String) });
  const pop = popped();
  await update({ a: false });
  await pop;
  await settle();
  expect(state()).toEqual(base);
  expect(onClose).not.toHaveBeenCalled();
});

it('closes the layer on back without traversing again when the owner reacts', async () => {
  await render(['a']);
  await update({ a: true });
  const pop = popped();
  window.history.back();
  await pop;
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith('a');
  await update({ a: false });
  await settle();
  expect(state()).toEqual(base);
});

it.each([
  ['top-first', ['b', 'a']],
  ['bottom-first', ['a', 'b']],
] as const)('consumes both entries when two stacked layers close in one commit (%s cleanup)', async (_, order) => {
  await render(order);
  await update({ a: true });
  await update({ b: true });
  expect(state().usr['kikiLayer']).toBe('b');
  const pop = popped();
  await update({ a: false, b: false });
  await pop;
  await settle();
  expect(state()).toEqual(base);
  expect(onClose).not.toHaveBeenCalled();
});

it('consumes a layer that closed under another one together with it', async () => {
  await render(['a', 'b']);
  await update({ a: true });
  // One commit: the menu closes as the dialog it opened mounts over it.
  await update({ a: false, b: true });
  await settle();
  expect(state().usr['kikiLayer']).toBe('b');
  const pop = popped();
  await update({ b: false });
  await pop;
  await settle();
  expect(state()).toEqual(base);
});

it('peels stacked layers one back press at a time', async () => {
  await render(['a', 'b']);
  await update({ a: true });
  await update({ b: true });
  let pop = popped();
  window.history.back();
  await pop;
  expect(onClose.mock.calls).toEqual([['b']]);
  await update({ b: false });
  await settle();
  expect(state().usr['kikiLayer']).toBe('a');
  pop = popped();
  window.history.back();
  await pop;
  expect(onClose.mock.calls).toEqual([['b'], ['a']]);
  await update({ a: false });
  await settle();
  expect(state()).toEqual(base);
});

it('leaves an entry buried under a route push alone', async () => {
  await render(['a']);
  await update({ a: true });
  const route: HistoryState = { usr: { kikiNav: { visitId: `visit-${visit}-next` } }, key: `route-${visit}-next`, idx: visit + 1 };
  window.history.pushState(route, '');
  await update({ a: false });
  await settle();
  expect(state()).toEqual(route);
  // Back returns to the route the layer sat on, and closes nothing.
  const pop = popped();
  window.history.back();
  await pop;
  expect(state().key).toBe(base.key);
  expect(state().usr['kikiLayer']).toBe('a');
  expect(onClose).not.toHaveBeenCalled();
});
