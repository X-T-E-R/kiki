// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { SidePanel } from './SidePanel';
import { useDirtyGuardState } from './dirtyGuard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let mount: HTMLDivElement;
beforeEach(() => { mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount); });
afterEach(async () => { await act(async () => root.unmount()); mount.remove(); });

// The confirmation keeps its own state (as the shipped-agent restore control
// does), so opening it does not re-render the sheet or re-register its keys.
function RestoreControl() {
  const [confirming, setConfirming] = useState(false);
  return <>
    <button onClick={() => setConfirming(true)}>Restore</button>
    <ConfirmDialog open={confirming} title="Restore?" confirmLabel="Restore original"
      onConfirm={() => setConfirming(false)} onCancel={() => setConfirming(false)} />
  </>;
}
function Sheet() {
  const [sheet, setSheet] = useState(true);
  return <I18nProvider>
    {sheet ? <Dialog ariaLabel="Sheet" overlayId="sheet-test" onClose={() => setSheet(false)}>
      <RestoreControl />
    </Dialog> : null}
  </I18nProvider>;
}
const escape = () => act(async () => {
  (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

it('lets a confirmation inside a sheet take Escape before the sheet does', async () => {
  await act(async () => root.render(<Sheet />));
  await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!.click(); });
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await escape();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector('[aria-label="Sheet"]')).not.toBeNull();
  await escape();
  expect(document.querySelector('[aria-label="Sheet"]')).toBeNull();
});

const discard = vi.fn();
let dirtyGuard: ReturnType<typeof useDirtyGuardState>;
function GlobalDirtySheet({ nested = false }: { nested?: boolean }) {
  const [sheet, setSheet] = useState(true);
  dirtyGuard = useDirtyGuardState({ pathname: '/capabilities', search: '?tab=mcp', hash: '' }, vi.fn());
  const close = () => dirtyGuard.value.confirmDiscard!('editor', () => { discard(); setSheet(false); });
  const editor = <SidePanel title="Editor" overlayId="global-dirty-editor" onClose={close}>
    <input defaultValue="example draft" />
  </SidePanel>;
  return <I18nProvider>
    {sheet ? nested ? <Dialog stacked ariaLabel="Parent" overlayId="global-dirty-parent" onClose={close}>{editor}</Dialog> : editor : null}
    <ConfirmDialog stacked open={dirtyGuard.pending} title="Discard draft?" confirmLabel="Discard" cancelLabel="Keep editing"
      onCancel={dirtyGuard.cancel} onConfirm={() => { void dirtyGuard.confirm(); }} />
  </I18nProvider>;
}
async function openGlobalDirtySheet(nested = false) {
  discard.mockClear();
  await act(async () => root.render(<GlobalDirtySheet nested={nested} />));
  await act(async () => dirtyGuard.value.reportDirty('editor', true));
  const input = document.querySelector('input')!;
  input.focus();
  await escape();
  return input;
}

it('gives the global sibling confirmation Escape ownership and restores the editor draft and focus', async () => {
  const input = await openGlobalDirtySheet();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await escape();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('example draft');
  expect(dirtyGuard.value.dirty).toBe(true);
  expect(discard).not.toHaveBeenCalled();
});

it('portals the global confirmation above nested modal depth and traps Tab in its safe actions', async () => {
  // jsdom has no layout; model visible controls for the shared focus trap.
  const visible = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  try {
    const input = await openGlobalDirtySheet(true);
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(alert.parentElement?.parentElement).toBe(document.body);
    const layers = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map((el) => Number(el.parentElement?.style.zIndex || 50));
    expect(Number(alert.parentElement?.style.zIndex)).toBeGreaterThan(Math.max(...layers));
    const [keep, leave] = [...alert.querySelectorAll('button')];
    expect(document.activeElement).toBe(keep);
    await act(async () => { keep!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(leave);
    await act(async () => { leave!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(keep);
    await act(async () => { keep!.click(); });
    expect(document.activeElement).toBe(input);
    expect(discard).not.toHaveBeenCalled();
    await escape();
    const confirm = document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!;
    await act(async () => { confirm.click(); confirm.click(); });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[aria-label="Editor"]')).toBeNull();
  } finally { visible.mockRestore(); }
});

it('closes a clean editor directly without a confirmation', async () => {
  discard.mockClear();
  await act(async () => root.render(<GlobalDirtySheet />));
  await escape();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector('[aria-label="Editor"]')).toBeNull();
  expect(discard).toHaveBeenCalledTimes(1);
});
