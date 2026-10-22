// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUsageItem, PluginUsageResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { AddMenu, type AddMenuView } from '../ComposerControls';
import { bindPendingNewSessionDraft, clearPendingNewSessionCapabilities, pendingNewSessionCapabilities } from './newSessionCapabilities';
import { usePluginPicker } from './usePluginPicker';

const listPlugins = vi.fn();
const getPluginUsage = vi.fn();
const setPluginUsage = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: { listPlugins, getPluginUsage, setPluginUsage },
    scopeId: 'local',
    spaceKey: 'main',
    connectionId: null,
  }),
}));

const plugin = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  enabled: true,
  globalEnabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  ...extra,
});

let picker: ReturnType<typeof usePluginPicker> | undefined;
const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  clearPendingNewSessionCapabilities();
  vi.clearAllMocks();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(workspaceId?: string): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    picker = usePluginPicker(undefined, workspaceId);
    return null;
  }
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><Host /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('usePluginPicker before a conversation exists', () => {
  it('keeps an explicit choice locally and refuses a master-off plugin', async () => {
    listPlugins.mockResolvedValue({ plugins: [
      plugin('notes'),
      plugin('later', { globalEnabled: false }),
      plugin('blocked', { enabled: false, globalEnabled: false }),
    ] });
    await render();
    expect(picker?.available).toBe(true);
    expect(picker?.items.find((item) => item.id === 'notes')?.enabled).toBe(true);
    expect(picker?.items.find((item) => item.id === 'later')?.enabled).toBe(false);
    expect(picker?.items.find((item) => item.id === 'blocked')?.available).toBe(false);

    await act(async () => { picker?.toggle('notes', false); });
    await act(async () => { picker?.toggle('later', true); });
    await act(async () => { picker?.toggle('blocked', true); });
    expect(setPluginUsage).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities().plugins).toEqual([
      { pluginId: 'notes', override: 'off' },
      { pluginId: 'later', override: 'on' },
    ]);
    expect(picker?.items.find((item) => item.id === 'blocked')?.enabled).toBe(false);
  });

  it('inherits a workspace off without writing that workspace', async () => {
    listPlugins.mockResolvedValue({ plugins: [plugin('notes')] });
    getPluginUsage.mockResolvedValue({
      plugins: [{ id: 'notes', effective: false, override: 'off', global_enabled: true, home_enabled: true, state: 'ok' }],
    });
    await render('ws-a');
    expect(getPluginUsage).toHaveBeenCalledWith({ workspace_id: 'ws-a' });
    expect(picker?.items[0]?.enabled).toBe(false);
    expect(picker?.items[0]?.source).toBe('workspace');
    await act(async () => { picker?.toggle('notes', true); });
    expect(setPluginUsage).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities().plugins).toEqual([{ pluginId: 'notes', override: 'on' }]);
  });

  it('writes the bound draft for this connection and leaves the default bucket empty', async () => {
    const scope = { scopeId: 'local', spaceKey: 'main', connectionId: null, draftKey: 'draft-a' };
    bindPendingNewSessionDraft(scope);
    listPlugins.mockResolvedValue({ plugins: [plugin('notes')] });
    await render();
    await act(async () => { picker?.toggle('notes', false); });
    expect(setPluginUsage).not.toHaveBeenCalled();
    expect(pendingNewSessionCapabilities()).toEqual({ plugins: [], mcp: [] });
    expect(pendingNewSessionCapabilities(scope).plugins).toEqual([{ pluginId: 'notes', override: 'off' }]);
  });
});

function usageRow(overrides: Partial<PluginUsageItem> = {}): PluginUsageItem {
  return {
    id: 'notes',
    displayName: 'Notes',
    version: '1.0.0',
    home_enabled: true,
    global_enabled: true,
    state: 'ok',
    override: 'inherit',
    session_override: 'inherit',
    effective: false,
    app_service: false,
    skillCount: 0,
    mcpServerCount: 0,
    ...overrides,
  } as PluginUsageItem;
}

function usage(plugins: readonly PluginUsageItem[]): PluginUsageResponse {
  return {
    home_id: 'home-1',
    target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha', session_id: 'session-a' },
    revision: 1,
    apply_state: 'applied',
    errors: [],
    plugins: [...plugins],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function LivePluginMenu() {
  picker = usePluginPicker('session-a');
  const [view, setView] = useState<AddMenuView>('plugins');
  return (
    <AddMenu
      view={view}
      onViewChange={setView}
      attachDisabled={false}
      onAttach={() => {}}
      plugins={picker.available ? {
        items: picker.items,
        loading: picker.loading,
        failed: picker.failed,
        ...(picker.busyId !== undefined ? { busyId: picker.busyId } : {}),
        onToggle: picker.toggle,
      } : undefined}
    />
  );
}

async function mountMenu(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <LivePluginMenu />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function checkbox(container: HTMLElement, id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[data-add-plugin="${id}"] input[type=checkbox]`);
  if (input === null) throw new Error(`missing plugin switch ${id}`);
  return input;
}

describe('a slow plugin on in this conversation’s add menu', () => {
  const target = { session_id: 'session-a' };

  beforeEach(() => {
    localStorage.setItem('kiki.locale', 'en');
  });
  afterEach(() => {
    localStorage.removeItem('kiki.locale');
  });

  it('lets the menu turn a slow on off, and the late on does not turn it back on', async () => {
    const on = deferred<PluginUsageResponse>();
    const off = deferred<PluginUsageResponse>();
    const blocked = usageRow({ id: 'blocked', displayName: 'Blocked', home_enabled: false });
    listPlugins.mockResolvedValue({ plugins: [] });
    getPluginUsage.mockResolvedValue(usage([usageRow(), blocked]));
    setPluginUsage.mockImplementation((input: { override: string }) => input.override === 'on' ? on.promise : off.promise);
    const container = await mountMenu();

    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(checkbox(container, 'notes').disabled).toBe(false);
    expect(checkbox(container, 'blocked').disabled).toBe(true);
    expect(container.querySelector('[data-add-plugin="blocked"]')?.textContent).toContain('The master switch is off');

    await act(async () => { checkbox(container, 'notes').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(true);
    expect(checkbox(container, 'notes').disabled).toBe(false);
    expect(checkbox(container, 'blocked').disabled).toBe(true);

    await act(async () => { checkbox(container, 'notes').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(setPluginUsage).toHaveBeenNthCalledWith(1, { target, plugin_id: 'notes', override: 'on' });
    expect(setPluginUsage).toHaveBeenNthCalledWith(2, { target, plugin_id: 'notes', override: 'off' });

    await act(async () => {
      on.resolve(usage([usageRow({ effective: true, session_override: 'on' }), blocked]));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(picker?.failure).toBeUndefined();

    await act(async () => {
      off.resolve(usage([usageRow({ effective: false, session_override: 'off' }), blocked]));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(container.querySelector('[data-add-plugin="notes"]')?.textContent).toContain('Off for this conversation');
    expect(picker?.failure).toBeUndefined();
  });

  it('does not let the failed slow on replace the newer off', async () => {
    const on = deferred<PluginUsageResponse>();
    const off = deferred<PluginUsageResponse>();
    listPlugins.mockResolvedValue({ plugins: [] });
    getPluginUsage.mockResolvedValue(usage([usageRow()]));
    setPluginUsage.mockImplementation((input: { override: string }) => input.override === 'on' ? on.promise : off.promise);
    const container = await mountMenu();

    await act(async () => { checkbox(container, 'notes').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { checkbox(container, 'notes').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);

    await act(async () => { on.reject(new Error('the slow on failed')); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(checkbox(container, 'notes').disabled).toBe(false);
    expect(picker?.failure).toBeUndefined();

    await act(async () => {
      off.resolve(usage([usageRow({ effective: false, session_override: 'off' })]));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(checkbox(container, 'notes').checked).toBe(false);
    expect(container.querySelector('[data-add-plugin="notes"]')?.textContent).toContain('Off for this conversation');
    expect(picker?.failure).toBeUndefined();
  });
});
