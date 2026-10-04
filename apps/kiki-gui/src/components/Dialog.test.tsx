// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { SidePanel } from './SidePanel';
import { SearchableSelect } from './SearchableSelect';
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

/**
 * A picker inside a stacked dialog portals its panel to <body>, so it is no
 * longer a DOM descendant of the dialog panel. The trap must still treat it as
 * the dialog's own: otherwise the first keystroke in the filter is yanked back
 * out to the dialog's first control and the field is unusable.
 */
function DialogWithPortaledField() {
  const [sheet, setSheet] = useState(true);
  return <I18nProvider>
    {sheet ? <Dialog stacked ariaLabel="Picker sheet" overlayId="picker-sheet-test" onClose={() => setSheet(false)}>
      <SearchableSelect id="sheet-model" value="a" options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
        ariaLabel="Pick a model" onChange={() => {}} />
    </Dialog> : null}
  </I18nProvider>;
}

it('leaves focus in a portaled picker panel instead of pulling it back into the dialog', async () => {
  await act(async () => root.render(<DialogWithPortaledField />));
  const trigger = document.querySelector<HTMLButtonElement>('#sheet-model')!;
  await act(async () => { trigger.click(); });
  const filter = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  // The panel is in <body>, outside the dialog panel, and focus is on it.
  expect(document.querySelector('[role="dialog"]')!.contains(filter)).toBe(false);
  expect(document.activeElement).toBe(filter);
  // Moving focus within the portaled panel must not be undone by the trap.
  const rows = document.querySelectorAll<HTMLElement>('[data-select-panel] [role="option"]');
  await act(async () => { (rows[1] as HTMLElement).focus(); });
  expect(document.activeElement).toBe(rows[1]);
});

/**
 * The exemption is per owning dialog, not a bare marker: a portaled panel is
 * only exempt from the dialog it belongs to, and only while that dialog is
 * still on top. Without the id, a picker under a lower dialog — or one opened
 * on the page behind a dialog — would keep focus while an unrelated dialog
 * sits on top of it, and Tab there would be swallowed by the wrong trap.
 */
function Picker({ id }: { id: string }) {
  return <SearchableSelect id={id} value="a" ariaLabel={`pick ${id}`}
    options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} onChange={() => {}} />;
}

function TwoDialogs() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return <I18nProvider>
    {outer ? <Dialog stacked ariaLabel="Outer" overlayId="outer-dialog" onClose={() => setOuter(false)}>
      <Picker id="outer-picker" />
      <button type="button" onClick={() => setInner(true)}>Open inner</button>
      <button type="button">Outer last</button>
    </Dialog> : null}
    {inner ? <Dialog stacked ariaLabel="Inner" overlayId="inner-dialog" onClose={() => setInner(false)}>
      <button type="button">Inner only</button>
    </Dialog> : null}
  </I18nProvider>;
}

const openPanelFilter = () => document.querySelector<HTMLInputElement>('[data-select-panel] input[role="combobox"]')!;
const clickByText = (text: string) =>
  act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === text)!.click(); });

it('does not let a lower dialog picker hold focus once another dialog is on top', async () => {
  await act(async () => root.render(<TwoDialogs />));
  await act(async () => { document.querySelector<HTMLButtonElement>('#outer-picker')!.click(); });
  const outerFilter = openPanelFilter();
  // The panel names the dialog it belongs to, so the trap can tell.
  expect(outerFilter.closest('[data-modal-escape]')?.getAttribute('data-modal-escape')).toBe('outer-dialog');
  await clickByText('Open inner');
  const inner = document.querySelector<HTMLElement>('[aria-label="Inner"]')!;
  // Focus lands on the foreign panel: the top dialog takes it back.
  await act(async () => { outerFilter.focus(); });
  expect(document.activeElement).not.toBe(outerFilter);
  expect(inner.contains(document.activeElement)).toBe(true);
});

it('does not let a page picker hold focus through a dialog opened above it', async () => {
  function OverPage() {
    const [open, setOpen] = useState(true);
    return <I18nProvider>
      <Picker id="page-picker" />
      {open ? <Dialog stacked ariaLabel="On top" overlayId="on-top-dialog" onClose={() => setOpen(false)}>
        <button type="button">Top only</button>
      </Dialog> : null}
    </I18nProvider>;
  }
  await act(async () => root.render(<OverPage />));
  await act(async () => { document.querySelector<HTMLButtonElement>('#page-picker')!.click(); });
  const pageFilter = openPanelFilter();
  // No dialog owns it, so it claims no exemption at all.
  expect(pageFilter.closest('[data-modal-escape]')).toBeNull();
  const top = document.querySelector<HTMLElement>('[aria-label="On top"]')!;
  await act(async () => { pageFilter.focus(); });
  expect(document.activeElement).not.toBe(pageFilter);
  expect(top.contains(document.activeElement)).toBe(true);
});

it('gives the exemption back to the dialog that owns the picker when it is on top again', async () => {
  function Switcher() {
    const [inner, setInner] = useState(false);
    return <I18nProvider>
      <Dialog stacked ariaLabel="Outer" overlayId="switch-outer" onClose={() => {}}>
        <Picker id="switch-picker" />
        <button type="button" onClick={() => setInner((value) => !value)}>Toggle</button>
      </Dialog>
      {inner ? <Dialog stacked ariaLabel="Inner" overlayId="switch-inner" onClose={() => setInner(false)}>
        <button type="button">Inner only</button>
      </Dialog> : null}
    </I18nProvider>;
  }
  await act(async () => root.render(<Switcher />));
  await act(async () => { document.querySelector<HTMLButtonElement>('#switch-picker')!.click(); });
  const filter = openPanelFilter();
  // Owned and on top: the trap leaves it alone.
  await act(async () => { filter.focus(); });
  expect(document.activeElement).toBe(filter);
  // Another dialog opens: the same panel is no longer exempt.
  await clickByText('Toggle');
  await act(async () => { filter.focus(); });
  expect(document.activeElement).not.toBe(filter);
  // Close it: ownership returns to the dialog that owns the picker.
  await clickByText('Toggle');
  await act(async () => { filter.focus(); });
  expect(document.activeElement).toBe(filter);
});
