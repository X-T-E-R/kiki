// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { BoardStorageSettings } from './BoardStorageSettings';
import { ResourceLimitsCard } from './EngineLimitSettings';
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
  client.listWorkspaces.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture/project' }, { id: 'ws-two', root: '/fixture/other' }] });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); element.remove(); });
async function settle() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render(node: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={cache}><I18nProvider>{node}</I18nProvider></QueryClientProvider>)); await settle(); }
async function select(id: string, label: string) {
  await act(async () => { element.querySelector<HTMLButtonElement>(`#${id}`)!.click(); });
  await settle();
  await act(async () => { [...element.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes(label))!.click(); });
  await settle();
}
async function click(text: string) { await act(async () => { [...element.querySelectorAll('button')].find((button) => button.textContent === text)!.click(); }); await settle(); }
async function setInputValue(input: HTMLInputElement, value: string) { await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(); }
function preview(value: Record<string, unknown>) { return { ok: true, value: { mode: 'fixed', workspaceId: 'ws-one', root: '/fixture/project/cards', tasksDirectory: '/fixture/project/cards/tasks', existing: false, kind: 'embedded', selectionOnly: true, ...value } }; }
async function leave(input: HTMLInputElement) { await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }); await settle(); }
it('resolves the saved fixed target as soon as a workspace is picked, and saves auto without moving cards', async () => {
  client.patchConfig.mockResolvedValue({ task_board: { storage: { mode: 'auto' } } });
  board.read.mockResolvedValue(preview({}));
  await render(<BoardStorageSettings board={board} />);
  expect(element.querySelector('input')?.value).toBe('cards');
  expect(element.textContent).toContain('relative paths remain unresolved');
  // Nothing to resolve yet: the location belongs to a workspace.
  expect(board.read).not.toHaveBeenCalled();
  await select('board-storage-workspace', '/fixture/project');
  expect(board.read).toHaveBeenCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards' } });
  expect(element.textContent).toContain('/fixture/project/cards/tasks');
  await select('board-storage-mode', 'Auto (default)'); await click('Save defaults');
  expect(client.patchConfig).toHaveBeenCalledWith({ task_board: { storage: { mode: 'auto' } } });
  expect(board.write).not.toHaveBeenCalled();
});
it('re-resolves when the mode changes, and folds the auto result into the details', async () => {
  board.read.mockImplementation((input: { configuration: { mode: string } }) => Promise.resolve(preview({ mode: input.configuration.mode })));
  await render(<BoardStorageSettings board={board} />);
  await select('board-storage-workspace', '/fixture/project');
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards' } });
  expect(element.querySelector('[data-board-storage-settings] > [data-board-storage-preview]')).not.toBeNull();
  await select('board-storage-mode', 'Auto (default)');
  // Auto lets the system choose, so the resolved directory is reference detail.
  await act(async () => { (element.querySelector('[data-board-storage-details]') as HTMLDetailsElement).open = true; });
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'auto' } });
  expect(element.querySelector('[data-board-storage-details] [data-board-storage-preview]')?.textContent).toContain('/fixture/project/cards/tasks');
});
it('computes a typed path once the field is left, not on every keystroke', async () => {
  board.read.mockImplementation((input: { configuration: { path: string } }) => Promise.resolve(preview({ tasksDirectory: `/fixture/project/${input.configuration.path}/tasks` })));
  await render(<BoardStorageSettings board={board} />);
  await select('board-storage-workspace', '/fixture/project');
  const path = element.querySelector<HTMLInputElement>('input')!;
  await setInputValue(path, 'cards-v2');
  // Typing alone must not spawn a request per keystroke.
  expect(board.read).toHaveBeenCalledTimes(1);
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards' } });
  await leave(path);
  expect(board.read).toHaveBeenCalledTimes(2);
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards-v2' } });
  expect(element.textContent).toContain('/fixture/project/cards-v2/tasks');
});
it('drops the preview target together with the path a mode switch discards', async () => {
  board.read.mockImplementation((input: { configuration: { mode: string } }) => Promise.resolve(preview({ mode: input.configuration.mode })));
  await render(<BoardStorageSettings board={board} />);
  await select('board-storage-workspace', '/fixture/project');
  expect(board.read).toHaveBeenCalledTimes(1);
  expect(element.querySelector('[data-board-storage-preview]')?.textContent).toContain('/fixture/project/cards/tasks');
  await select('board-storage-mode', 'Auto (default)');
  expect(board.read).toHaveBeenCalledTimes(2);
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'auto' } });
  // Leaving fixed mode discards the draft path, so coming back shows an empty field:
  // an empty path field must not resolve (or re-resolve) the path it used to hold.
  await select('board-storage-mode', 'Fixed path');
  expect(element.querySelector<HTMLInputElement>('input')!.value).toBe('');
  expect(board.read).toHaveBeenCalledTimes(2);
  expect(element.querySelector('[data-board-storage-preview]')).toBeNull();
});

it('keeps the newer target when an older preview answers late', async () => {
  const pending: { resolve: (value: unknown) => void; workspaceId: string }[] = [];
  board.read.mockImplementation((input: { workspaceId: string }) => new Promise((resolve) => { pending.push({ resolve, workspaceId: input.workspaceId }); }));
  await render(<BoardStorageSettings board={board} />);
  await select('board-storage-workspace', '/fixture/project');
  await select('board-storage-workspace', '/fixture/other');
  expect(pending.map((call) => call.workspaceId)).toEqual(['ws-one', 'ws-two']);
  await act(async () => { pending[1]!.resolve(preview({ workspaceId: 'ws-two', tasksDirectory: '/fixture/other/cards/tasks' })); await Promise.resolve(); });
  await settle();
  expect(element.textContent).toContain('/fixture/other/cards/tasks');
  // The abandoned workspace answers afterwards; it must not replace the current one.
  await act(async () => { pending[0]!.resolve(preview({ workspaceId: 'ws-one' })); await Promise.resolve(); });
  await settle();
  expect(element.textContent).toContain('/fixture/other/cards/tasks');
  expect(element.textContent).not.toContain('/fixture/project/cards/tasks');
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
  board.read.mockResolvedValue(preview({}));
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
  expect(element.textContent).toContain('Saved');
});
it('mounts board controls without the duplicate Todo explanation', async () => {
  await render(<TasksSection />);
  expect(element.querySelector('#st-card-agent-todo')).toBeNull();
  expect(element.querySelector('#st-card-agent-board')).not.toBeNull();
  expect(element.querySelector('[data-board-storage-settings]')).not.toBeNull();
  // The task-board feature flag lives on Labs with every other flag.
  expect(element.querySelector('#st-card-task-board')).toBeNull();
  expect(element.querySelector('#st-card-defaults')).toBeNull();
});
it('surfaces preview failures without guessing a resolved path, and retries the same target', async () => {
  board.read.mockResolvedValueOnce({ ok: false, error: { code: 'BOARD_STORAGE_NOT_EMPTY', message: 'Unrecognized content' } });
  await render(<BoardStorageSettings board={board} />); await select('board-storage-workspace', '/fixture/project');
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('BOARD_STORAGE_NOT_EMPTY');
  expect(element.querySelector('[data-board-storage-preview]')).toBeNull();
  board.read.mockResolvedValueOnce(preview({}));
  await click('Retry');
  expect(board.read).toHaveBeenCalledTimes(2);
  expect(board.read).toHaveBeenLastCalledWith({ action: 'preview', workspaceId: 'ws-one', configuration: { mode: 'fixed', path: 'cards' } });
  expect(element.querySelector('[data-board-storage-preview]')?.textContent).toContain('/fixture/project/cards/tasks');
  expect(element.querySelector('[role="alert"]')).toBeNull();
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

const resourceConfig = { workspace_instance: { idleTtlMs: 300000 }, image: { maxEdgePx: 2000, readByteBudget: 262144 } };
it('calls a resource-limit draft clean once the stored value is put back', async () => {
  client.getConfig.mockResolvedValue(resourceConfig);
  await render(<ResourceLimitsCard />);
  const imageEdge = element.querySelectorAll<HTMLInputElement>('input')[1]!;
  expect(imageEdge.value).toBe('2000');
  const dirtyBar = () => element.querySelector('[data-settings-draft="resource-limits"]');
  expect(dirtyBar()?.getAttribute('data-dirty')).toBeNull();

  await setInputValue(imageEdge, '4096');
  expect(dirtyBar()?.getAttribute('data-dirty')).toBe('true');
  // Back to exactly what the server said. Nothing was changed, so nothing is
  // pending: an unsaved-draft prompt here would be asking about a non-event.
  await setInputValue(imageEdge, '2000');
  expect(dirtyBar()?.getAttribute('data-dirty')).toBeNull();
  expect(dirtyBar()?.hasAttribute('hidden')).toBe(true);
  expect(client.patchConfig).not.toHaveBeenCalled();
});

it('keeps a resource-limit draft on a failed save and re-reads nothing over it', async () => {
  client.getConfig.mockResolvedValue(resourceConfig);
  client.patchConfig.mockRejectedValue(new Error('config write refused'));
  await render(<ResourceLimitsCard />);
  const ttl = element.querySelectorAll<HTMLInputElement>('input')[0]!;
  expect(ttl.value).toBe('300');
  await setInputValue(ttl, '120');
  await click('Save');
  // The typed value stays, and it stays pending: the server has not taken it.
  expect(element.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe('120');
  expect(element.querySelector('[data-settings-draft="resource-limits"]')?.getAttribute('data-dirty')).toBe('true');
  expect(element.textContent).toContain('config write refused');
});

it('clears an optional resource-limit value back to the engine default on save', async () => {
  client.getConfig.mockResolvedValue({ image: { maxEdgePx: 2000, readByteBudget: 262144 }, workspace_instance: { idleTtlMs: 300000 } });
  client.patchConfig.mockResolvedValue({ workspace_instance: { idleTtlMs: 600000 }, image: {} });
  await render(<ResourceLimitsCard />);
  const ttl = element.querySelectorAll<HTMLInputElement>('input')[0]!;
  await setInputValue(ttl, '600');
  await setInputValue(element.querySelectorAll<HTMLInputElement>('input')[1]!, '');
  await click('Save');
  // An empty optional number deletes the stored value; the echo reads empty,
  // and the form is clean because the server agrees with what is shown.
  expect(client.patchConfig).toHaveBeenCalledWith(expect.objectContaining({ image: { max_edge_px: undefined, read_byte_budget: 262144 } }));
  expect(element.querySelectorAll<HTMLInputElement>('input')[1]!.value).toBe('');
  expect(element.querySelector('[data-settings-draft="resource-limits"]')?.getAttribute('data-dirty')).toBeNull();
});
