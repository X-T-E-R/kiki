// @vitest-environment jsdom

/**
 * The ＋ menu's MCP row, the other consumer of a slow on.
 *
 * The switch and Use config stay usable while a write is in flight. A connected
 * server whose tool catalog failed to refresh stays on and shows that sentence;
 * a different error stays a failure.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { McpServerLocator, McpSessionCapability } from '@kiki/klient';

import { I18nProvider } from '../i18n';
import { useMcpPicker } from './capabilities/useMcpPicker';
import { mcpSessionRows, type McpSessionRow } from './capabilities/sessionMcp';
import { AddMenu, type AddMenuMcp, type AddMenuView } from './ComposerControls';

const surface = vi.hoisted(() => {
  const state = {
    list: vi.fn(),
    write: vi.fn(),
  };
  const client = {
    klient: {
      session: (id: string) => ({
        agent: () => ({
          listMcpSessionCapabilities: () => state.list(id),
          setMcpSessionOverride: (input: { locator: McpServerLocator; override: string }) => state.write(id, input),
          getMcpServers: async () => [],
        }),
      }),
      global: { mcp: { list: async () => [] } },
    },
  };
  return { ...state, client };
});

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    scopeId: 'scope-a',
    spaceKey: 'space-a',
    connectionId: null,
    client: surface.client,
  }),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  surface.list.mockReset();
  surface.write.mockReset();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  localStorage.removeItem('kiki.locale');
});

function capability(name: string, overrides: Partial<McpSessionCapability> = {}): McpSessionCapability {
  return {
    locator: { source: 'global', name },
    runtimeName: name,
    origin: 'global',
    config: { transport: 'stdio', command: 'npx', enabled: true },
    authStatus: 'not-applicable',
    connection: 'connected',
    override: 'inherit',
    ...overrides,
  };
}

function rows(capabilities: readonly McpSessionCapability[]): readonly McpSessionRow[] {
  return mcpSessionRows({ capabilities, writable: true });
}

async function mount(mcp: AddMenuMcp): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <AddMenu view="mcp" onViewChange={() => {}} attachDisabled={false} onAttach={() => {}} mcp={mcp} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

function menuRow(name: string): HTMLElement {
  const found = container?.querySelector<HTMLElement>(`[data-add-mcp="${name}"]`);
  if (found === undefined || found === null) throw new Error(`missing MCP menu row ${name}`);
  return found;
}

function checkbox(name: string): HTMLInputElement {
  const input = menuRow(name).querySelector<HTMLInputElement>('input[type=checkbox]');
  if (input === null) throw new Error(`missing MCP menu switch ${name}`);
  return input;
}

function restoreButton(name: string): HTMLButtonElement {
  const button = menuRow(name).querySelector<HTMLButtonElement>(`[data-add-mcp-restore="${name}"]`);
  if (button === null) throw new Error(`missing MCP menu restore ${name}`);
  return button;
}

describe('Add menu MCP row', () => {
  it('keeps the switch and Use config usable while a slow on is saving', async () => {
    const onOverride = vi.fn();
    const locator: McpServerLocator = { source: 'global', name: 'notes' };
    await mount({
      items: rows([capability('notes', { override: 'off', connection: 'disabled' })]),
      loading: false,
      failed: false,
      writable: true,
      busyName: 'notes',
      busyAction: 'switch',
      busyOn: true,
      onDismissFailure: () => {},
      onOverride,
      onReconnect: () => {},
    });

    expect(menuRow('notes').dataset['addMcpState']).toBe('off-here');
    expect(checkbox('notes').checked).toBe(true);
    expect(checkbox('notes').disabled).toBe(false);
    expect(restoreButton('notes').disabled).toBe(false);
    expect(restoreButton('notes').textContent).toBe('Use config');

    await act(async () => { checkbox('notes').click(); });
    expect(onOverride).toHaveBeenNthCalledWith(1, locator, 'off', 'notes');

    await act(async () => { restoreButton('notes').click(); });
    expect(onOverride).toHaveBeenNthCalledWith(2, locator, 'inherit', 'notes');
  });

  it('keeps a connected catalog refresh on and readable, and does not treat another error as unavailable', async () => {
    const onOverride = vi.fn();
    const locator: McpServerLocator = { source: 'global', name: 'files' };
    await mount({
      items: rows([
        capability('files', {
          override: 'on',
          connection: 'connected',
          error: 'MCP tool catalog refresh failed (Error)',
          errorCode: 'tool_catalog_refresh_failed',
        }),
        capability('plain', {
          override: 'on',
          connection: 'connected',
          error: 'MCP tool catalog refresh failed (Error)',
        }),
        capability('broken', {
          override: 'on',
          connection: 'failed',
          error: 'schema load failed',
          errorCode: 'tool_catalog_refresh_failed',
        }),
      ]),
      loading: false,
      failed: false,
      writable: true,
      onDismissFailure: () => {},
      onOverride,
      onReconnect: () => {},
    });

    const files = menuRow('files');
    expect(files.dataset['addMcpState']).toBe('on-here');
    expect(files.dataset['addMcpOverride']).toBe('on');
    expect(checkbox('files').checked).toBe(true);
    expect(checkbox('files').disabled).toBe(false);
    expect(files.textContent).toContain('On for this conversation');
    expect(files.textContent).not.toContain('Off for this conversation');
    expect(files.textContent).not.toContain('Disconnected');
    expect(files.querySelector('.bg-success')).not.toBeNull();
    const engine = 'MCP tool catalog refresh failed (Error)';
    const warning = files.querySelector('[data-add-mcp-warning="files"]');
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.textContent).toContain('Tool list refresh failed. Using the last available tools.');
    expect(files.querySelector('[data-add-mcp-warning-detail="files"]')?.textContent).toBe(engine);
    expect(warning?.className).not.toContain('text-danger');

    const plain = menuRow('plain');
    expect(plain.dataset['addMcpState']).toBe('on-here');
    expect(plain.dataset['addMcpOverride']).toBe('on');
    expect(plain.querySelector('[data-add-mcp-warning="plain"]')?.textContent).toBe(engine);
    expect(plain.querySelector('[data-add-mcp-warning-detail="plain"]')).toBeNull();
    expect(plain.textContent).not.toContain('Tool list refresh failed. Using the last available tools.');

    const broken = menuRow('broken');
    expect(broken.dataset['addMcpState']).toBe('failed');
    expect(broken.dataset['addMcpState']).not.toBe('unavailable');
    expect(broken.dataset['addMcpOverride']).toBe('on');
    expect(broken.querySelector('[data-add-mcp-warning="broken"]')).toBeNull();
    expect(broken.textContent).toContain('schema load failed');
    expect(broken.textContent).toContain('On for this conversation');
    expect(broken.textContent).not.toContain('Tool list refresh failed. Using the last available tools.');
    expect(checkbox('broken').disabled).toBe(false);

    await act(async () => { checkbox('files').click(); });
    expect(onOverride).toHaveBeenCalledWith(locator, 'off', 'files');
  });
});

/**
 * The composer's own wiring: AddMenu reads `useMcpPicker` and writes through
 * `setOverride`. Busy is only the switch's paint; the picker's generation is
 * what drops the late reply.
 */
function LiveMenu() {
  const mcp = useMcpPicker('session-a');
  const [view, setView] = useState<AddMenuView>('mcp');
  return (
    <AddMenu
      view={view}
      onViewChange={setView}
      attachDisabled={false}
      onAttach={() => {}}
      mcp={mcp.available ? {
        items: mcp.items,
        loading: mcp.loading,
        failed: mcp.failed,
        writable: mcp.writable,
        busyName: mcp.busyName,
        busyAction: mcp.busyAction,
        busyOn: mcp.busyOn,
        failure: mcp.failure,
        onDismissFailure: mcp.dismissFailure,
        onShow: mcp.onShow,
        onOverride: mcp.setOverride,
        onReconnect: mcp.reconnect,
      } : undefined}
    />
  );
}

function deferred() {
  let resolve!: (value: McpSessionCapability) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<McpSessionCapability>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountLive(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <LiveMenu />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  await settle();
}

describe('the add menu wired to the picker', () => {
  const locator: McpServerLocator = { source: 'global', name: 'files' };

  it('turns a slow on off, and the late on does not turn it back on', async () => {
    const on = deferred();
    const off = deferred();
    surface.list.mockResolvedValue([capability('files', {
      connection: 'disabled',
      config: { transport: 'stdio', command: 'npx', enabled: false },
    })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'on' ? on.promise : off.promise);
    await mountLive();
    surface.list.mockImplementation(() => new Promise(() => {}));

    expect(checkbox('files').checked).toBe(false);
    expect(checkbox('files').disabled).toBe(false);
    await act(async () => { checkbox('files').click(); });
    await settle();
    expect(checkbox('files').checked).toBe(true);
    expect(checkbox('files').disabled).toBe(false);

    await act(async () => { checkbox('files').click(); });
    await settle();
    expect(checkbox('files').checked).toBe(false);
    expect(checkbox('files').disabled).toBe(false);
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator, override: 'on' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator, override: 'off' });

    await act(async () => { on.resolve(capability('files', { override: 'on', connection: 'connected' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('inherit');
    expect(checkbox('files').checked).toBe(false);

    await act(async () => { off.resolve(capability('files', { override: 'off', connection: 'disabled' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('off');
    expect(menuRow('files').dataset['addMcpState']).toBe('off-here');
    expect(checkbox('files').checked).toBe(false);
  });

  it('withdraws a slow on with Use config, and the late on does not put the session back on', async () => {
    const on = deferred();
    const back = deferred();
    surface.list.mockResolvedValue([capability('files', { override: 'off', connection: 'disabled' })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'on' ? on.promise : back.promise);
    await mountLive();
    surface.list.mockImplementation(() => new Promise(() => {}));

    await act(async () => { checkbox('files').click(); });
    await settle();
    expect(checkbox('files').checked).toBe(true);
    expect(restoreButton('files').disabled).toBe(false);

    await act(async () => { restoreButton('files').click(); });
    await settle();
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator, override: 'on' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator, override: 'inherit' });

    await act(async () => { on.resolve(capability('files', { override: 'on', connection: 'connected' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('off');

    await act(async () => { back.resolve(capability('files', { override: 'inherit', connection: 'disabled' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('inherit');
    expect(menuRow('files').dataset['addMcpState']).toBe('off-config');
    expect(checkbox('files').checked).toBe(false);
  });

  it('lets a newer off withdraw a slow Use config', async () => {
    const back = deferred();
    const off = deferred();
    surface.list.mockResolvedValue([capability('files', { override: 'on', connection: 'connected' })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'inherit' ? back.promise : off.promise);
    await mountLive();
    surface.list.mockImplementation(() => new Promise(() => {}));

    expect(checkbox('files').checked).toBe(true);
    expect(restoreButton('files').disabled).toBe(false);
    await act(async () => { restoreButton('files').click(); });
    await settle();
    expect(checkbox('files').disabled).toBe(false);
    expect(checkbox('files').checked).toBe(true);

    await act(async () => { checkbox('files').click(); });
    await settle();
    expect(checkbox('files').checked).toBe(false);
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator, override: 'inherit' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator, override: 'off' });

    await act(async () => { back.resolve(capability('files', { override: 'inherit', connection: 'disabled' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('on');
    expect(checkbox('files').checked).toBe(false);

    await act(async () => { off.resolve(capability('files', { override: 'off', connection: 'disabled' })); });
    await settle();
    expect(menuRow('files').dataset['addMcpOverride']).toBe('off');
    expect(menuRow('files').dataset['addMcpState']).toBe('off-here');
    expect(checkbox('files').checked).toBe(false);
  });
});
