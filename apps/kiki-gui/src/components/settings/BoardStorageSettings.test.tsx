// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { BoardStorageSettings } from './BoardStorageSettings';
import { SubagentLimitsSettings } from './SubagentLimitsSettings';
import { TasksSection } from './TasksSection';
const { client, board } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), patchConfig: vi.fn(), listWorkspaces: vi.fn(), meta: vi.fn() }, board: { read: vi.fn(), write: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, klient: { global: { board } } }) }));
let root: Root, element: HTMLDivElement, cache: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockResolvedValue({ task_board: { storage: { mode: 'fixed', path: 'cards' } }, subagent: { timeoutMs: 18000000, maxDirectChildren: 16, maxTotalSubagents: 0 } });
  client.meta.mockResolvedValue({ experimental_flags: { task_board: true } });
  client.listWorkspaces.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture/project' }] });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); element.remove(); });
async function settle() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render(node: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={cache}><I18nProvider>{node}</I18nProvider></QueryClientProvider>)); await settle(); }
async function select(index: number, value: string) { await act(async () => { const input = element.querySelectorAll('select')[index]!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }); await settle(); }
async function click(text: string) { await act(async () => { [...element.querySelectorAll('button')].find((button) => button.textContent === text)!.click(); }); await settle(); }
async function setInputValue(input: HTMLInputElement, value: string) { await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(); }
it('restores saved fixed mode, previews only on demand and saves auto without moving cards', async () => {
  client.patchConfig.mockResolvedValue({ task_board: { storage: { mode: 'auto' } } });
  board.read.mockResolvedValue({ ok: true, value: { mode: 'fixed', workspaceId: 'ws-one', root: '/fixture/project/cards', tasksDirectory: '/fixture/project/cards/tasks', existing: false, kind: 'embedded', selectionOnly: true } });
  await render(<BoardStorageSettings board={board} />);
  expect(element.querySelector('input')?.value).toBe('cards');
  expect(element.textContent).toContain('relative paths remain unresolved');
  expect(board.read).not.toHaveBeenCalled();
  await select(1, 'ws-one'); await click('Preview location');
  expect(board.read).toHaveBeenCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards' } });
  expect(element.textContent).toContain('/fixture/project/cards/tasks');
  await select(0, 'auto'); await click('Save defaults');
  expect(client.patchConfig).toHaveBeenCalledWith({ task_board: { storage: { mode: 'auto' } } });
  expect(board.write).not.toHaveBeenCalled();
});
it('keeps a storage draft when the shared config query refetches', async () => {
  await render(<BoardStorageSettings board={board} />);
  const path = element.querySelector<HTMLInputElement>('input')!;
  await setInputValue(path, 'draft-cards');
  await act(async () => { cache.setQueryData(['config'], { task_board: { storage: { mode: 'fixed', path: 'server-cards' } } }); });
  await settle();
  expect(path.value).toBe('draft-cards');
});
it('keeps save disabled until the draft is dirty and confirms with the saved tick', async () => {
  client.patchConfig.mockResolvedValue({ task_board: { storage: { mode: 'fixed', path: 'cards-v2' } } });
  await render(<BoardStorageSettings board={board} />);
  const saveButton = () => [...element.querySelectorAll('button')].find((button) => button.textContent === 'Save defaults')!;
  expect(saveButton().disabled).toBe(true);
  const path = element.querySelector<HTMLInputElement>('input')!;
  await setInputValue(path, 'cards-v2');
  expect(saveButton().disabled).toBe(false);
  expect(element.textContent).toContain('Unsaved changes');
  await click('Save defaults');
  expect(client.patchConfig).toHaveBeenCalledWith({ task_board: { storage: { mode: 'fixed', path: 'cards-v2' } } });
  expect(saveButton().disabled).toBe(true);
  expect(element.textContent).toContain('✓ Saved');
});
it('mounts Todo and board controls only on the dedicated tasks page', async () => {
  await render(<TasksSection />);
  expect(element.querySelector('#st-card-agent-todo')).not.toBeNull();
  expect(element.querySelector('#st-card-agent-board')).not.toBeNull();
  expect(element.querySelector('[data-board-storage-settings]')).not.toBeNull();
  expect(element.querySelector('#st-card-task-board')).not.toBeNull();
  expect(element.querySelector('#st-card-agent-todo input')).toBeNull();
});
it('surfaces preview failures without guessing a resolved path', async () => {
  board.read.mockResolvedValue({ ok: false, error: { code: 'BOARD_STORAGE_NOT_EMPTY', message: 'Unrecognized content' } });
  await render(<BoardStorageSettings board={board} />); await select(1, 'ws-one'); await click('Preview location');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('BOARD_STORAGE_NOT_EMPTY');
  expect(element.querySelector('[data-board-storage-preview]')).toBeNull();
});
it('reads the actual five-hour config and saves timeout plus both limits in the existing subagent domain', async () => {
  client.patchConfig.mockResolvedValue({ subagent: { timeoutMs: 18000000, maxDirectChildren: 16, maxTotalSubagents: 0 } });
  await render(<SubagentLimitsSettings />);
  expect([...element.querySelectorAll('input')].map((input) => input.value)).toEqual(['5', '16', '0']);
  const save = [...element.querySelectorAll('button')].find((button) => button.textContent === 'Save defaults')!;
  expect(save.hasAttribute('disabled')).toBe(true);
  await setInputValue(element.querySelectorAll<HTMLInputElement>('input')[0]!, '6');
  expect(save.hasAttribute('disabled')).toBe(false);
  await click('Save defaults');
  expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { timeout_ms: 21600000, max_direct_children: 16, max_total_subagents: 0 } });
});
it('keeps a subagent-limits draft when another card writes the shared config query', async () => {
  await render(<SubagentLimitsSettings />);
  const hours = element.querySelectorAll<HTMLInputElement>('input')[0]!;
  expect(hours.value).toBe('5');
  await setInputValue(hours, '9');
  // 同页另一张卡保存后回写 ['config'] 缓存，不应重置本卡未保存的输入。
  await act(async () => { cache.setQueryData(['config'], { task_board: { storage: { mode: 'auto' } }, subagent: { timeoutMs: 3600000, maxDirectChildren: 8, maxTotalSubagents: 4 } }); });
  await settle();
  expect(hours.value).toBe('9');
  const save = [...element.querySelectorAll('button')].find((button) => button.textContent === 'Save defaults')!;
  expect(save.hasAttribute('disabled')).toBe(false);
});
