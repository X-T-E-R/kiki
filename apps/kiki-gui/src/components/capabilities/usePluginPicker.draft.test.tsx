// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
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
