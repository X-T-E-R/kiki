// @vitest-environment jsdom

/**
 * The MCP rail's own switch, not a projector of the row rules.
 *
 * An explicit session on stays checked while the runtime line says the server
 * is not actually connected. A slow on can be withdrawn; the late on reply,
 * success or failure, must not turn the switch back on.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { McpServerLocator, McpSessionCapability } from '@kiki/klient';

import { I18nProvider } from '../../i18n';
import { clearPendingNewSessionCapabilities, pendingNewSessionCapabilities, setPendingMcpChoice } from './newSessionCapabilities';
import { SessionMcpRail } from './optionalCapabilityUi';

const surface = vi.hoisted(() => {
  const state = {
    sessionId: 'session-a' as string | undefined,
    listCapabilities: vi.fn(),
    listCatalog: vi.fn(async () => [] as unknown[]),
    write: vi.fn(),
  };
  const client = {
    klient: {
      session: (id: string) => ({
        agent: () => ({
          listMcpSessionCapabilities: () => state.listCapabilities(id),
          setMcpSessionOverride: (input: { locator: McpServerLocator; override: string }) => state.write(id, input),
          getMcpServers: async () => [],
        }),
      }),
      global: { mcp: { list: () => state.listCatalog() } },
    },
  };
  return { ...state, client };
});

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    scopeId: 'scope-a',
    spaceKey: 'space-a',
    connectionId: null,
    client: surface.client,
  }),
}));

const LOCATOR: McpServerLocator = { source: 'global', name: 'files' };
const MAIL: McpServerLocator = { source: 'plugin', pluginId: 'kiki-mail', serverName: 'mail' };

const capability = (overrides: Partial<McpSessionCapability> = {}): McpSessionCapability => ({
  locator: LOCATOR,
  runtimeName: 'files',
  origin: 'global',
  config: { transport: 'stdio', command: 'npx', enabled: true },
  authStatus: 'not-applicable',
  connection: 'connected',
  override: 'inherit',
  ...overrides,
});

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
  clearPendingNewSessionCapabilities();
  surface.sessionId = 'session-a';
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  localStorage.removeItem('kiki.locale');
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred() {
  let resolve!: (value: McpSessionCapability) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<McpSessionCapability>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function mount(): Promise<HTMLDivElement> {
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
          <SessionMcpRail sessionId={surface.sessionId === '' ? undefined : surface.sessionId} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  await settle();
  return container;
}

function row(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-rail-mcp-server="${name}"]`);
  if (found === null) throw new Error(`missing MCP row ${name}`);
  return found;
}

function toggle(container: HTMLElement, name: string): HTMLInputElement {
  const input = row(container, name).querySelector<HTMLInputElement>('input[type=checkbox]');
  if (input === null) throw new Error(`missing MCP switch ${name}`);
  return input;
}

function restore(container: HTMLElement, name: string): HTMLButtonElement {
  const button = row(container, name).querySelector<HTMLButtonElement>(`[data-rail-mcp-restore="${name}"]`);
  if (button === null) throw new Error(`missing MCP restore ${name}`);
  return button;
}

describe('an explicit MCP on whose runtime is not connected', () => {
  it('holds the switch and names the source or the disconnection', async () => {
    surface.listCapabilities.mockResolvedValue([
      capability({
        runtimeName: 'muted',
        locator: { source: 'global', name: 'muted' },
        override: 'on',
        connection: 'disabled',
        config: { transport: 'stdio', command: 'npx', enabled: false },
      }),
      capability({ override: 'on', connection: 'disabled' }),
    ]);
    const container = await mount();

    const muted = row(container, 'muted');
    expect(muted.dataset['railMcpEffective']).toBe('true');
    expect(muted.dataset['railMcpOverride']).toBe('on');
    expect(muted.dataset['railMcpConnection']).toBe('disabled');
    expect(muted.dataset['railMcpSource']).toBe('session');
    expect(toggle(container, 'muted').checked).toBe(true);
    expect(toggle(container, 'muted').disabled).toBe(false);
    expect(muted.querySelector('[data-rail-mcp-fact="muted"]')!.textContent).toBe('On in session');
    expect(muted.querySelector('[data-rail-mcp-runtime="muted"]')!.textContent).toBe('Turned off in the MCP configuration');
    expect(muted.textContent).not.toContain('On in the MCP configuration');

    const files = row(container, 'files');
    expect(files.dataset['railMcpConnection']).toBe('disabled');
    expect(toggle(container, 'files').checked).toBe(true);
    expect(files.querySelector('[data-rail-mcp-fact="files"]')!.textContent).toBe('On in session');
    expect(files.querySelector('[data-rail-mcp-runtime="files"]')!.textContent).toBe('Disconnected');
  });
});

describe('a connected server whose tool catalog refresh failed', () => {
  it('keeps the session on and shows the refresh warning, and another error stays a failure', async () => {
    const engine = 'MCP tool catalog refresh failed (Error)';
    surface.listCapabilities.mockResolvedValue([
      capability({
        override: 'on',
        connection: 'connected',
        error: engine,
        errorCode: 'tool_catalog_refresh_failed',
      }),
      capability({
        runtimeName: 'plain',
        locator: { source: 'global', name: 'plain' },
        override: 'on',
        connection: 'connected',
        error: engine,
      }),
      capability({
        runtimeName: 'broken',
        locator: { source: 'global', name: 'broken' },
        override: 'on',
        connection: 'failed',
        error: 'schema load failed',
        errorCode: 'tool_catalog_refresh_failed',
      }),
    ]);
    surface.write.mockResolvedValue(capability({
      override: 'off',
      connection: 'disabled',
    }));
    const container = await mount();
    surface.listCapabilities.mockImplementation(() => new Promise(() => {}));

    const files = row(container, 'files');
    expect(files.dataset['railMcpEffective']).toBe('true');
    expect(files.dataset['railMcpOverride']).toBe('on');
    expect(files.dataset['railMcpConnection']).toBe('connected');
    expect(toggle(container, 'files').checked).toBe(true);
    expect(toggle(container, 'files').disabled).toBe(false);
    expect(files.querySelector('[data-rail-mcp-fact="files"]')!.textContent).toBe('On in session');
    expect(files.querySelector('[data-rail-mcp-runtime="files"]')).toBeNull();
    const warning = files.querySelector('[data-rail-mcp-warning="files"]');
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.textContent).toContain('Tool list refresh failed. Using the last available tools.');
    expect(files.querySelector('[data-rail-mcp-warning-detail="files"]')?.textContent).toBe(engine);
    expect(files.textContent).not.toContain('Disconnected');
    expect(files.textContent).not.toContain('State not reported');

    const plain = row(container, 'plain');
    expect(plain.dataset['railMcpConnection']).toBe('connected');
    expect(plain.dataset['railMcpOverride']).toBe('on');
    expect(plain.querySelector('[data-rail-mcp-warning="plain"]')?.textContent).toBe(engine);
    expect(plain.querySelector('[data-rail-mcp-warning-detail="plain"]')).toBeNull();
    expect(plain.textContent).not.toContain('Tool list refresh failed. Using the last available tools.');

    const broken = row(container, 'broken');
    expect(broken.dataset['railMcpConnection']).toBe('failed');
    expect(broken.dataset['railMcpEffective']).toBe('true');
    expect(broken.querySelector('[data-rail-mcp-warning="broken"]')).toBeNull();
    expect(toggle(container, 'broken')).toBeTruthy();
    expect(broken.textContent).not.toContain('Tool list refresh failed. Using the last available tools.');

    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(surface.write).toHaveBeenCalledWith('session-a', { locator: LOCATOR, override: 'off' });
    expect(toggle(container, 'files').checked).toBe(false);
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('off');
    expect(row(container, 'files').dataset['railMcpConnection']).toBe('disabled');
    expect(row(container, 'files').querySelector('[data-rail-mcp-warning="files"]')).toBeNull();
  });
});

describe('a /new plugin server the draft already turned on', () => {
  const catalog = [{
    name: 'mail',
    source: 'plugin',
    origin: 'kiki-mail',
    config: { transport: 'stdio', enabled: false },
    plugin: { id: 'kiki-mail', name: 'mail' },
  }];

  it('shows the switch so the pending on can be revoked, and does not grant the plugin source', async () => {
    surface.sessionId = '';
    surface.listCatalog.mockResolvedValue(catalog);
    const container = await mount();
    expect(row(container, 'mail').querySelector('input[type=checkbox]')).toBeNull();

    await act(async () => { setPendingMcpChoice({ locator: MAIL, override: 'on', name: 'mail' }); });
    await settle();
    const mail = row(container, 'mail');
    expect(mail.dataset['railMcpEffective']).toBe('true');
    expect(mail.dataset['railMcpConnection']).toBe('disabled');
    expect(toggle(container, 'mail').checked).toBe(true);
    expect(toggle(container, 'mail').disabled).toBe(false);
    expect(mail.querySelector('[data-rail-mcp-fact="mail"]')!.textContent).toBe('On in session');
    expect(mail.querySelector('[data-rail-mcp-runtime="mail"]')!.textContent).toBe('Turned off inside plugin kiki-mail');

    await act(async () => { toggle(container, 'mail').click(); });
    await settle();
    expect(surface.write).not.toHaveBeenCalled();
    expect(toggle(container, 'mail').checked).toBe(false);
    expect(row(container, 'mail').dataset['railMcpOverride']).toBe('off');
    expect(row(container, 'mail').dataset['railMcpEffective']).toBe('false');
    expect(pendingNewSessionCapabilities().mcp).toEqual([{ locator: MAIL, override: 'off', name: 'mail' }]);
  });
});

describe('a slow MCP on on the rail', () => {
  it('lets the reader turn it off, and a late on does not turn it back on', async () => {
    const on = deferred();
    const off = deferred();
    surface.listCapabilities.mockResolvedValue([capability({
      connection: 'disabled',
      config: { transport: 'stdio', command: 'npx', enabled: false },
    })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'on' ? on.promise : off.promise);
    const container = await mount();
    surface.listCapabilities.mockImplementation(() => new Promise(() => {}));

    const input = toggle(container, 'files');
    expect(input.checked).toBe(false);
    await act(async () => { input.click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(true);
    expect(toggle(container, 'files').disabled).toBe(false);

    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(false);
    expect(toggle(container, 'files').disabled).toBe(false);
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator: LOCATOR, override: 'on' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator: LOCATOR, override: 'off' });

    await act(async () => { on.resolve(capability({ override: 'on', connection: 'connected' })); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(false);
    expect(row(container, 'files').dataset['railMcpEffective']).toBe('false');
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('inherit');
    expect(container.querySelector('[role=alert]')).toBeNull();

    await act(async () => { off.resolve(capability({ override: 'off', connection: 'disabled' })); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(false);
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('off');
    expect(row(container, 'files').dataset['railMcpEffective']).toBe('false');
  });

  it('does not let the failed on replace an off that already landed', async () => {
    const on = deferred();
    const off = deferred();
    surface.listCapabilities.mockResolvedValue([capability({ connection: 'connected' })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'on' ? on.promise : off.promise);
    const container = await mount();
    surface.listCapabilities.mockImplementation(() => new Promise(() => {}));

    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(surface.write).toHaveBeenLastCalledWith('session-a', { locator: LOCATOR, override: 'off' });
    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(true);
    expect(surface.write).toHaveBeenLastCalledWith('session-a', { locator: LOCATOR, override: 'on' });

    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(false);

    await act(async () => { off.resolve(capability({ override: 'off', connection: 'disabled' })); });
    await settle();
    await act(async () => { on.reject(new Error('the slow on failed')); });
    await settle();

    expect(toggle(container, 'files').checked).toBe(false);
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('off');
    expect(row(container, 'files').dataset['railMcpEffective']).toBe('false');
    expect(container.querySelector('[role=alert]')).toBeNull();
  });

  it('lets restore withdraw a slow on, and the late on does not put it back', async () => {
    const on = deferred();
    const back = deferred();
    surface.listCapabilities.mockResolvedValue([capability({ override: 'off', connection: 'disabled' })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'on' ? on.promise : back.promise);
    const container = await mount();
    surface.listCapabilities.mockImplementation(() => new Promise(() => {}));

    expect(restore(container, 'files').disabled).toBe(false);
    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(true);
    expect(toggle(container, 'files').disabled).toBe(false);
    expect(restore(container, 'files').disabled).toBe(false);

    await act(async () => { restore(container, 'files').click(); });
    await settle();
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator: LOCATOR, override: 'on' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator: LOCATOR, override: 'inherit' });

    await act(async () => { on.resolve(capability({ override: 'on', connection: 'connected' })); });
    await settle();
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('off');
    expect(toggle(container, 'files').checked).toBe(true);

    await act(async () => { back.resolve(capability({ override: 'inherit', connection: 'disabled' })); });
    await settle();
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('inherit');
    expect(row(container, 'files').dataset['railMcpConnection']).toBe('disabled');
    expect(row(container, 'files').dataset['railMcpEffective']).toBe('false');
    expect(toggle(container, 'files').checked).toBe(false);
    expect(row(container, 'files').querySelector('[data-rail-mcp-restore="files"]')).toBeNull();
  });

  it('lets a newer off withdraw a slow restore', async () => {
    const back = deferred();
    const off = deferred();
    surface.listCapabilities.mockResolvedValue([capability({ override: 'on', connection: 'connected' })]);
    surface.write.mockImplementation((_id: string, input: { override: string }) => input.override === 'inherit' ? back.promise : off.promise);
    const container = await mount();
    surface.listCapabilities.mockImplementation(() => new Promise(() => {}));

    expect(toggle(container, 'files').checked).toBe(true);
    expect(restore(container, 'files').disabled).toBe(false);
    await act(async () => { restore(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').disabled).toBe(false);
    expect(toggle(container, 'files').checked).toBe(true);

    await act(async () => { toggle(container, 'files').click(); });
    await settle();
    expect(toggle(container, 'files').checked).toBe(false);
    expect(surface.write).toHaveBeenNthCalledWith(1, 'session-a', { locator: LOCATOR, override: 'inherit' });
    expect(surface.write).toHaveBeenNthCalledWith(2, 'session-a', { locator: LOCATOR, override: 'off' });

    await act(async () => { back.resolve(capability({ override: 'inherit', connection: 'disabled' })); });
    await settle();
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('on');
    expect(toggle(container, 'files').checked).toBe(false);

    await act(async () => { off.resolve(capability({ override: 'off', connection: 'disabled' })); });
    await settle();
    expect(row(container, 'files').dataset['railMcpOverride']).toBe('off');
    expect(row(container, 'files').dataset['railMcpEffective']).toBe('false');
    expect(toggle(container, 'files').checked).toBe(false);
  });
});
