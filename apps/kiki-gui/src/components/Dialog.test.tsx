// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';

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
