// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { Dialog } from '../Dialog';
import { ConfirmDialog } from '../ConfirmDialog';
import { anyOverlayOpen } from '../../lib/uiBusy';
import { NewTaskModal } from './NewTaskModal';
import { TaskDetailModal } from './TaskDetailModal';
import type { BoardTask } from './types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let mount: HTMLDivElement;
const card: BoardTask = { id: 'task-example', title: 'Example', description: 'Detail', status: 'active', priority: 'medium', createdAt: 0, updatedAt: 0, executions: [] };
beforeEach(() => {
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function(this: HTMLElement) { return this.parentElement; });
});
afterEach(async () => { await act(async () => root.unmount()); mount.remove(); vi.restoreAllMocks(); });
const button = (text: string) => [...document.body.querySelectorAll('button')].find((element) => element.textContent === text)!;
const key = (value: string, shiftKey = false) => (document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
function Harness({ create = async () => {}, save = async () => {}, remove = async () => {} }: { create?: () => Promise<void>; save?: () => Promise<void>; remove?: () => Promise<void> }) {
  const [board, setBoard] = useState(false);
  const [child, setChild] = useState<'new' | 'detail' | null>(null);
  return <I18nProvider>
    <button onClick={() => setBoard(true)}>Open board</button>
    {board ? <Dialog stacked ariaLabel="Board" overlayId="board-test" onClose={() => setBoard(false)}>
      <button onClick={() => setChild('new')}>New card</button>
      <button onClick={() => setChild('detail')}>Detail</button>
      {child === 'new' ? <NewTaskModal onClose={() => setChild(null)} onCreate={create} /> : null}
      {child === 'detail' ? <TaskDetailModal task={card} onClose={() => setChild(null)} onSave={save} onDelete={remove} /> : null}
    </Dialog> : null}
  </I18nProvider>;
}
async function click(text: string) { await act(async () => { const target = button(text); expect(target).toBeDefined(); target.focus(); target.click(); }); }
async function press(value: string, shiftKey = false) { await act(async () => { key(value, shiftKey); }); }

it('portals new-card forms and grants only the top modal Escape/Tab/focus restoration', async () => {
  await act(async () => root.render(<Harness />));
  await click('Open board');
  await click('New card');
  const overlay = document.querySelector('[data-new-task-modal]')!;
  expect(overlay.parentElement).toBe(document.body);
  expect(overlay.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  const title = overlay.querySelector('input')!;
  expect(document.activeElement).toBe(title);
  const controls = [...overlay.querySelectorAll<HTMLElement>('button,input,select,textarea')];
  controls.at(-1)!.focus();
  await press('Tab');
  expect(document.activeElement).toBe(controls[0]);
  await press('Tab', true);
  expect(document.activeElement).toBe(controls.at(-1));
  button('New card').focus();
  expect(overlay.contains(document.activeElement)).toBe(true);
  await press('Escape');
  expect(document.querySelector('[data-new-task-modal]')).toBeNull();
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  expect(document.activeElement).toBe(button('New card'));
  await press('Escape');
  expect(document.querySelector('[aria-label="Board"]')).toBeNull();
  expect(document.activeElement).toBe(button('Open board'));
  expect(anyOverlayOpen()).toBe(false);
});

it('new-card pending writes consume Escape and trap Tab even with inert/disabled controls', async () => {
  let reject!: (error: Error) => void;
  const create = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await act(async () => root.render(<Harness create={create} />));
  await click('Open board'); await click('New card');
  const title = document.querySelector<HTMLInputElement>('[data-new-task-modal] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Draft');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create Task Card');
  await press('Escape'); await press('Tab');
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[data-new-task-modal] [role="dialog"]'));
  expect(title.value).toBe('Draft');
  await act(async () => reject(new Error('Try again')));
  expect(title.value).toBe('Draft');
  await press('Escape');
  expect(document.querySelector('[data-new-task-modal]')).toBeNull();
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
});

it('board/detail/confirmation Escape cancels only the top layer, including after parent rerenders', async () => {
  await act(async () => root.render(<Harness />));
  await click('Open board'); await click('Detail'); await click('Delete Card');
  const confirm = document.querySelector('[role="alertdialog"]')!;
  expect(confirm.parentElement!.parentElement).toBe(document.body);
  const controls = [...confirm.querySelectorAll<HTMLButtonElement>('button')];
  expect(document.activeElement).toBe(controls[0]);
  await press('Tab', true);
  expect(document.activeElement).toBe(controls[1]);
  await press('Tab');
  expect(document.activeElement).toBe(controls[0]);
  await act(async () => root.render(<Harness />));
  await press('Escape');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector('[data-task-detail-modal]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  expect(document.activeElement).toBe(button('Delete Card'));
  await press('Escape');
  expect(document.querySelector('[data-task-detail-modal]')).toBeNull();
  expect(document.activeElement).toBe(button('Detail'));
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
});

it('pending saves and confirmed deletes cannot be dismissed through underlying layers', async () => {
  let save!: () => void;
  let remove!: () => void;
  await act(async () => root.render(<Harness save={() => new Promise((resolve) => { save = resolve; })} remove={() => new Promise((resolve) => { remove = resolve; })} />));
  await click('Open board'); await click('Detail'); await click('Edit Task'); await click('Save Changes');
  await press('Escape'); await press('Tab');
  expect(document.querySelector('[data-task-detail-modal]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  await act(async () => save());
  await click('Delete Card');
  const confirm = document.querySelector('[role="alertdialog"]')!;
  await act(async () => {
    (confirm.querySelectorAll('button')[1] as HTMLButtonElement).click();
    key('Escape');
  });
  await press('Escape'); await press('Tab');
  expect(document.querySelector('[role="alertdialog"]')).toBe(confirm);
  expect(document.activeElement).toBe(confirm);
  expect(document.querySelector('[data-task-detail-modal]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Board"]')).not.toBeNull();
  await act(async () => remove());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it('leaves unopted confirmation placement and ordinary Dialog close callbacks unchanged', async () => {
  const cancel = vi.fn();
  await act(async () => root.render(<I18nProvider><ConfirmDialog open title="Legacy confirm" confirmLabel="Continue" onConfirm={() => {}} onCancel={cancel} /></I18nProvider>));
  expect(mount.querySelector('[role="alertdialog"]')).not.toBeNull();
  await press('Escape');
  expect(cancel).toHaveBeenCalledTimes(1);
  const firstClose = vi.fn();
  const nextClose = vi.fn();
  await act(async () => root.render(<Dialog ariaLabel="Legacy dialog" overlayId="legacy-dialog" onClose={firstClose}><button>Control</button></Dialog>));
  const panel = document.querySelector<HTMLElement>('[aria-label="Legacy dialog"]')!;
  expect(panel.parentElement!.style.zIndex).toBe('');
  await act(async () => root.render(<Dialog ariaLabel="Legacy dialog" overlayId="legacy-dialog" onClose={nextClose}><button>Control</button></Dialog>));
  await press('Escape');
  expect(firstClose).not.toHaveBeenCalled();
  expect(nextClose).toHaveBeenCalledTimes(1);
});
