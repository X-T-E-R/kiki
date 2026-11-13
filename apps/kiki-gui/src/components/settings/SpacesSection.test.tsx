// @vitest-environment jsdom

/**
 * Settings › Spaces: the main-space list and its dialogs (typed-name delete,
 * credential switch with SSH hosts), the subspace view (read-only list,
 * overrides with Restore inheritance), and the Defaults origin marks.
 */

import { act, useState } from 'react';
import { getToasts } from '../../lib/toasts';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { DirtyGuardContext, useDirtyGuardState, useDirtyReporter } from '../dirtyGuard';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';
import { writeDesktopPrefs } from '@kiki/session-core/settings';
import { registerScopeNavigation } from '../../lib/navScope';
import { currentSpaceId, resetLaunchWindowMode } from '../../lib/spaces';
import { DEFAULT_SPACE_PREFERENCES, type SpaceDetail } from '@kiki/protocol';
import { clearSpaceAuthority, configureSpaceAuthority, spaceAuthoritySnapshot } from '../../lib/spaceAuthority';

import { I18nProvider } from '../../i18n';
import { OriginBadge } from './spaces/OriginBadge';
import { CreateSpaceDialog } from './spaces/CreateSpaceDialog';
import { SpacesSection } from './SpacesSection';
import { ConnectionServicesSection } from './ConnectionServicesSection';

const homes = {
  list: vi.fn(), create: vi.fn(), attach: vi.fn(), remove: vi.fn(), erase: vi.fn(),
  update: vi.fn(), sshCopyCandidates: vi.fn(), inspect: vi.fn(),
  detail: vi.fn(), preview: vi.fn(), apply: vi.fn(), undo: vi.fn(), importPreferences: vi.fn(),
};
const connections = {
  list: vi.fn(),
  inbound: vi.fn(),
  setInbound: vi.fn(),
  handshake: vi.fn(),
  createPairCode: vi.fn(),
  pair: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  setEnabled: vi.fn(),
};
const threadBridges = {
  status: vi.fn(),
  setEnabled: vi.fn(),
  revoke: vi.fn(),
  receipts: vi.fn(),
  retry: vi.fn(),
};
const listWorkspaceCatalog = vi.fn();
const config = { removeOverride: vi.fn() };
const ssh = { list: vi.fn(), copySharedCredentialsToIsolated: vi.fn() };
const getConfig = vi.fn();
const hostConnection = {
  listSshProfiles: vi.fn<() => Promise<unknown[]>>(),
  saveSshProfile: vi.fn(),
  removeSshProfile: vi.fn(),
};
const host = {
  kind: 'tauri' as 'tauri' | 'browser',
  pickDirectory: vi.fn(),
  spaceStatuses: vi.fn(),
  openSpace: vi.fn(),
  switchSpace: vi.fn(),
  restartSpace: vi.fn(async () => undefined),
  createSpaceShortcut: vi.fn(async () => ({ homeId: 'main', path: 'C:\\Users\\me\\Desktop\\Kiki - Main space.lnk' })),
  readDesktopPrefs: vi.fn(async () => null),
  writeDesktopPrefs: vi.fn(async () => undefined),
  revealPath: vi.fn(async () => undefined),
  restartServer: vi.fn(async () => undefined),
  connection: hostConnection,
};

const localMeta = vi.fn();
const client = {
  baseUrl: 'http://127.0.0.1:58627',
  klient: { rest: { homes, connections, threadBridges, config, ssh } },
  getConfig,
  listWorkspaceCatalog,
  meta: localMeta,
};
const connection = vi.hoisted(() => ({
  remoteClient: null as unknown,
  connectionId: null as string | null,
  sshLabel: null as string | null,
  localPending: false,
  activateSshProfile: vi.fn<(id: string, token: string) => Promise<void>>(),
  verifyLocal: vi.fn<(...args: [AbortSignal?]) => Promise<void>>(),
  order: [] as string[],
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: connection.remoteClient ?? client, localClient: connection.localPending ? null : client,
    connectionId: connection.connectionId, sshLabel: connection.sshLabel,
    activateSshProfile: connection.activateSshProfile,
    meta: { server_id: connection.remoteClient === null ? 'server-test' : 'remote-server', current_space_id: connection.remoteClient === null ? currentSpaceId() : 'h-acme' },
    scopeAdapter: { prepare: async (scope: { homeId: string; scopeId: string }, signal: AbortSignal) => {
      await connection.verifyLocal(signal);
      return { scope, validate: async (_route: string, validationSignal: AbortSignal) => { validationSignal.throwIfAborted(); },
        commit: async () => { signal.throwIfAborted(); connection.order.push('local'); }, dispose: async () => {} };
    } },
  }),
  useOptionalConnection: () => ({ client: connection.remoteClient ?? client, localClient: connection.localPending ? null : client,
    connectionId: connection.connectionId, sshLabel: connection.sshLabel }),
}));
vi.mock('../../host', () => ({ useHost: () => host }));

const LIST = {
  items: [
    { id: 'main', name: 'Main space', path: 'C:\\Users\\me\\.kiki', primary: true, credentials_shared: true },
    { id: 'h-acme', name: 'ACME', color: '#295c58', path: 'D:\\acme', primary: false, credentials_shared: true },
    { id: 'h-paper', name: 'Paper', path: 'D:\\paper', primary: false, credentials_shared: false },
  ],
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', platform: 'Win32', userAgent: 'Windows' });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });

beforeEach(() => {
  host.kind = 'tauri';
  for (const fn of [
    ...Object.values(homes),
    ...Object.values(connections),
    ...Object.values(threadBridges),
    ...Object.values(config),
    ...Object.values(ssh),
    ...Object.values(hostConnection),
    getConfig,
    listWorkspaceCatalog,
    host.spaceStatuses,
    connection.activateSshProfile,
  ]) fn.mockReset();
  homes.list.mockResolvedValue(LIST);
  homes.inspect.mockResolvedValue({ state: 'missing' });
  connections.list.mockResolvedValue([]);
  threadBridges.status.mockResolvedValue({
    identity: { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 },
    inboundEnabled: false,
    inbound: [],
    outbound: [],
  });
  listWorkspaceCatalog.mockResolvedValue({ items: [] });
  connections.inbound.mockResolvedValue({
    enabled: false,
    configuredEnabled: false,
    identity: { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 },
    grants: [],
  });
  connections.handshake.mockResolvedValue({
    identity: { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 },
    serverId: 'server-test',
    inboundEnabled: false,
  });
  hostConnection.listSshProfiles.mockResolvedValue([]);
  host.pickDirectory.mockReset().mockResolvedValue(null);
  localMeta.mockReset().mockResolvedValue({ server_id: 'server-test', current_space_id: 'main' });
  clearSpaceAuthority();
  connection.remoteClient = null;
  connection.connectionId = null;
  connection.sshLabel = null;
  connection.localPending = false;
  connection.order.length = 0;
  connection.verifyLocal.mockReset().mockResolvedValue(undefined);
  host.openSpace.mockReset();
  host.restartSpace.mockClear();
  host.spaceStatuses.mockResolvedValue([
    { homeId: 'main', active: true, hot: true, pendingCount: 0, busyCount: 0 },
    { homeId: 'h-acme', active: false, hot: true, pendingCount: 2, busyCount: 1 },
  ]);
  localStorage.clear();
  writeDesktopPrefs({ windowMode: 'windows' });
  resetLaunchWindowMode();
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
  configureSpaceStorage(null);
});

async function flush() {
  await act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(node: React.ReactNode, entries: string[] = ['/settings/spaces']) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={entries}><QueryClientProvider client={client}><I18nProvider>{node}</I18nProvider></QueryClientProvider></MemoryRouter>);
  });
  await flush();
  return container;
}

async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => { element!.click(); });
  await flush();
}

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('CreateSpaceDialog existing locations', () => {
  async function inspect() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    await flush();
  }

  it('shows a non-blocking content notice after choosing a folder and still creates the space', async () => {
    const record = { id: 'h-project', name: 'Project', path: 'D:\\project' };
    homes.inspect.mockResolvedValue({ state: 'nonempty' });
    homes.create.mockResolvedValue(record);
    host.pickDirectory.mockResolvedValue(record.path);
    const onCreated = vi.fn();
    await render(<CreateSpaceDialog mainPath={LIST.items[0]!.path} canOpen={false} onClose={vi.fn()} onCreated={onCreated} />);
    await type('[data-space-name]', 'Project');
    expect(document.querySelector<HTMLButtonElement>('[data-space-browse]')?.disabled).toBe(false);
    await click('[data-space-browse]');
    expect(host.pickDirectory).toHaveBeenCalledOnce();
    await inspect();
    expect(homes.inspect).toHaveBeenCalledWith({ path: record.path });
    expect(document.querySelector('[data-space-location-note]')?.textContent).toBe('Existing files will be kept');
    expect(document.querySelector<HTMLButtonElement>('[data-space-create-submit]')?.disabled).toBe(false);
    await click('[data-space-create-submit]');
    expect(homes.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Project', path: record.path }));
    expect(onCreated).toHaveBeenCalledWith(record, false, false);
  });

  it('distinguishes an existing space, preserves its settings, and does not require a new name', async () => {
    homes.inspect.mockResolvedValue({ state: 'space' });
    homes.create.mockResolvedValue(LIST.items[1]);
    const onCreated = vi.fn();
    await render(<CreateSpaceDialog mainPath={LIST.items[0]!.path} canOpen={true} onClose={vi.fn()} onCreated={onCreated} />);
    await type('[data-space-path]', LIST.items[1]!.path);
    await inspect();
    expect(document.querySelector('[data-space-location-note]')?.textContent).toBe('Existing space');
    expect(document.querySelector<HTMLButtonElement>('[data-space-browse]')?.disabled).toBe(false);
    expect(document.querySelector('[data-space-create-submit]')?.textContent).toBe('Add and open');
    expect(document.querySelector<HTMLFieldSetElement>('[data-space-inherit]')?.disabled).toBe(true);
    await click('[data-space-create-submit]');
    expect(homes.create).toHaveBeenCalledWith(expect.objectContaining({ name: undefined, path: LIST.items[1]!.path }));
    expect(onCreated).toHaveBeenCalledWith(LIST.items[1], true, true);
  });

  it('keeps browsing available in an existing space and restores choices after selecting an ordinary folder', async () => {
    homes.inspect.mockImplementation(async ({ path }: { path: string }) => ({ state: path === 'D:\\existing' ? 'space' : 'nonempty' }));
    host.pickDirectory.mockResolvedValueOnce('D:\\existing').mockResolvedValueOnce(null).mockResolvedValueOnce('D:\\project');
    await render(<CreateSpaceDialog mainPath={LIST.items[0]!.path} canOpen={true} onClose={vi.fn()} onCreated={vi.fn()} />);
    await type('[data-space-name]', 'Project');
    await click('[data-space-inherit-credentials="isolated"]');
    await click('[data-space-browse]');
    await inspect();
    expect(document.querySelector<HTMLFieldSetElement>('[data-space-inherit]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-space-browse]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[data-space-path]')?.disabled).toBe(false);
    await click('[data-space-browse]');
    expect(document.querySelector<HTMLInputElement>('[data-space-path]')?.value).toBe('D:\\existing');
    await click('[data-space-browse]');
    await inspect();
    expect(host.pickDirectory).toHaveBeenCalledTimes(3);
    expect(document.querySelector<HTMLInputElement>('[data-space-path]')?.value).toBe('D:\\project');
    expect(document.querySelector<HTMLFieldSetElement>('[data-space-inherit]')?.disabled).toBe(false);
    expect(document.querySelector('[data-space-inherit-credentials="isolated"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-space-location-note]')?.textContent).toBe('Existing files will be kept');
    expect(document.querySelector('[data-space-create-submit]')?.textContent).toBe('Create and open');
    expect(document.querySelector('[data-space-create]')?.textContent).not.toContain('Suggested location:');
    expect(document.querySelector('[data-space-create]')?.textContent).not.toContain('Conversations, memory, search');
  });

  it('does not block creation when a location inspection fails', async () => {
    homes.inspect.mockRejectedValue(new Error('Read unavailable'));
    homes.create.mockResolvedValue(LIST.items[1]);
    const onCreated = vi.fn();
    await render(<CreateSpaceDialog mainPath={LIST.items[0]!.path} canOpen={false} onClose={vi.fn()} onCreated={onCreated} />);
    await type('[data-space-name]', 'Project');
    await type('[data-space-path]', 'D:\\project');
    await inspect();
    expect(document.querySelector('[data-space-location-note]')).toBeNull();
    await click('[data-space-create-submit]');
    expect(onCreated).toHaveBeenCalled();
  });

  it('ignores a stale existing-space inspection after changing the location', async () => {
    let finish: (value: { state: string }) => void = () => undefined;
    homes.inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(<CreateSpaceDialog mainPath={LIST.items[0]!.path} canOpen={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    await type('[data-space-path]', 'D:\\old-space');
    await inspect();
    await type('[data-space-path]', 'D:\\new-space');
    await act(async () => { finish({ state: 'space' }); });
    await inspect();
    expect(document.querySelector('[data-space-location-note]')).toBeNull();
    expect(document.querySelector<HTMLFieldSetElement>('[data-space-inherit]')?.disabled).toBe(false);
  });
});

describe('SpacesSection target domain', () => {
  it('uses local homes for a directly opened remote settings page, including colliding IDs and names', async () => {
    const remoteHomes = { items: [
      { id: 'main', name: 'Main space', path: '/srv/kiki', primary: true },
      { id: 'remote-only', name: 'ACME', path: '/srv/acme', primary: false },
      { id: 'h-paper', name: 'Paper', path: '/srv/paper', primary: false },
    ] };
    const remoteList = vi.fn().mockResolvedValue(remoteHomes);
    connection.remoteClient = { klient: { rest: { homes: { list: remoteList } } } };
    connection.sshLabel = 'example-remote';
    host.openSpace.mockImplementation(async () => { connection.order.push('open'); });
    await render(<SpacesSection />);
    const advertised = [...document.querySelectorAll('[data-space-row]')].slice(1).map((row) => row.querySelector('p[title]')?.getAttribute('title'));
    const targets = [...document.querySelectorAll<HTMLButtonElement>('[data-space-enter]:not([data-space-enter="main"])')].map((button) => button.getAttribute('data-space-enter'));
    for (const id of targets) await click(`[data-space-enter="${id}"]`);
    const nativeTargets = host.openSpace.mock.calls.map(([id]) => id);
    const localPaths = nativeTargets.map((id) => LIST.items.find((item) => item.id === id)?.path ?? null);
    expect({ targets: nativeTargets, advertised, localPaths, order: connection.order }).toEqual({
      targets: ['h-acme', 'h-paper'],
      advertised: ['D:\\acme', 'D:\\paper'],
      localPaths: ['D:\\acme', 'D:\\paper'],
      order: ['open', 'local', 'open', 'local'],
    });
    expect(remoteList).not.toHaveBeenCalled();
  });
});

describe('SpacesSection in the main space', () => {
  it('opens create when arriving from the sidebar with ?new=1', async () => {
    await render(<SpacesSection />, ['/settings/spaces?new=1']);
    expect(document.querySelector('[data-space-create]')).not.toBeNull();
  });

  it('lists spaces with current, running, not-started and pending marks', async () => {
    writeDesktopPrefs({ windowMode: 'switch' });
    resetLaunchWindowMode();
    const navigateScope = vi.fn(async () => {});
    const unregister = registerScopeNavigation(navigateScope);
    try {
      await render(<SpacesSection />);
      expect(document.querySelector('[data-space-row="main"]')?.getAttribute('data-space-state')).toBe('current');
      expect(document.querySelector('[data-space-row="h-acme"]')?.getAttribute('data-space-state')).toBe('hot');
      expect(document.querySelector('[data-space-row="h-paper"]')?.getAttribute('data-space-state')).toBe('cold');
      expect(document.querySelector('[data-space-row="h-acme"] [data-space-pending]')?.textContent).toBe('2 need you');
      expect(document.querySelector('[data-space-row="h-paper"] [data-space-cred]')?.getAttribute('data-space-cred')).toBe('isolated');
      expect(document.querySelector('[data-space-new]')).not.toBeNull();
      await click('[data-space-enter="h-paper"]');
      expect(navigateScope).toHaveBeenCalledExactlyOnceWith({ homeId: 'h-paper', scopeId: 'local' });
      expect(host.openSpace).not.toHaveBeenCalled();
      expect(connection.verifyLocal).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('disables delete with a reason while a space runs', async () => {
    await render(<SpacesSection />);
    await click('[data-space-menu="h-acme"]');
    const item = document.querySelector<HTMLButtonElement>('[data-space-menu-item="delete"]')!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain('Sessions are running');
  });

  it('restarts a subspace from its menu and shows the backend refusal', async () => {
    host.restartSpace.mockRejectedValueOnce('The space has 1 pending interaction');
    await render(<SpacesSection />);
    await click('[data-space-menu="h-acme"]');
    await click('[data-space-menu-item="restart"]');
    expect(host.restartSpace).toHaveBeenCalledWith('h-acme');
    expect(document.body.textContent).toContain('1 pending interaction');
  });

  it('deletes only after the exact name is typed', async () => {
    homes.erase.mockResolvedValue({ items: LIST.items.slice(0, 2) });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="delete"]');
    expect(document.querySelector('[data-space-delete-path]')?.textContent).toBe('D:\\paper');
    const confirm = () => document.querySelector<HTMLButtonElement>('[data-space-delete-confirm]')!;
    expect(confirm().disabled).toBe(true);
    await type('[data-space-delete-input]', 'paper');
    expect(confirm().disabled).toBe(true);
    await type('[data-space-delete-input]', 'Paper');
    expect(confirm().disabled).toBe(false);
    await click('[data-space-delete-confirm]');
    expect(homes.erase).toHaveBeenCalledWith('h-paper', { confirm_name: 'Paper' });
  });

  it('switches to separate accounts in one PATCH with the ticked SSH hosts', async () => {
    homes.sshCopyCandidates.mockResolvedValue({ hosts: [
      { hostId: 'prod', name: 'Prod', credential_kinds: ['password'] },
      { hostId: 'lab', workspaceId: 'wd_1', name: 'Lab', credential_kinds: ['passphrase'] },
    ] });
    homes.update.mockResolvedValue({ space: { ...LIST.items[1], credentials_shared: false }, restart_required: true, copied_ssh_entries: 1 });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-acme"]');
    await click('[data-space-menu-item="credentials"]');
    expect(document.querySelector('[data-space-credentials-target]')?.getAttribute('data-space-credentials-target')).toBe('isolated');
    await click('[data-space-copy-ssh-host="lab"]');
    await click('[data-space-credentials-confirm]');
    expect(homes.update).toHaveBeenCalledWith('h-acme', {
      inherit: { credentials: 'isolated' },
      copy_ssh_credentials: { hosts: [{ hostId: 'lab', workspaceId: 'wd_1' }] },
    });
    expect(document.querySelector('[data-space-restart-note]')?.textContent).toContain('Restart ACME');
    expect(document.body.textContent).toContain('Copied 1 SSH entry.');
  });

  it('switching back to shared sends no copy and reports kept entries', async () => {
    homes.update.mockResolvedValue({ space: { ...LIST.items[2], credentials_shared: true }, restart_required: false, copied_ssh_entries: 0, retained_isolated_ssh_entries: 3 });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="credentials"]');
    expect(homes.sshCopyCandidates).not.toHaveBeenCalled();
    expect(document.querySelector('[data-space-credentials-shared-note]')).not.toBeNull();
    await click('[data-space-credentials-confirm]');
    expect(homes.update).toHaveBeenCalledWith('h-paper', { inherit: { credentials: 'shared' } });
    expect(document.body.textContent).toContain('Kept 3 SSH entries in the space.');
  });

  it('records the window mode for the next launch', async () => {
    // The choice starts on switch mode so picking the other one is a change:
    // clicking the already-selected segment fires nothing.
    writeDesktopPrefs({ windowMode: 'switch' });
    resetLaunchWindowMode();
    await render(<SpacesSection />);
    await click('[data-space-window-choice="windows"]');
    expect(host.writeDesktopPrefs).toHaveBeenCalledWith({ windowMode: 'windows' });
    expect(document.querySelector('[data-space-window-note]')?.textContent).toBe('Restart Kiki to use this.');
  });

  it('creates a desktop shortcut on Windows and reports success', async () => {
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-shortcut]')).toBeNull();
    await click('[data-space-menu="main"]');
    const shortcutItem = document.querySelector<HTMLButtonElement>('[data-space-menu-item="shortcut"]')!;
    expect(shortcutItem).not.toBeNull();
    expect(shortcutItem.disabled).toBe(false);
    await click('[data-space-menu-item="shortcut"]');
    expect(host.createSpaceShortcut).toHaveBeenCalledWith('main');
    expect(document.body.textContent).toContain('C:\\Users\\me\\Desktop\\Kiki - Main space.lnk');
  });

  it('handles shortcut_exists by showing an informative note', async () => {
    host.createSpaceShortcut.mockRejectedValueOnce({ code: 'shortcut_exists', message: 'Already exists' });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-acme"]');
    await click('[data-space-menu-item="shortcut"]');
    expect(host.createSpaceShortcut).toHaveBeenCalledWith('h-acme');
    expect(document.body.textContent).toContain('A desktop shortcut already exists for this space.');
  });

  it('handles shortcut_failed with detail message', async () => {
    host.createSpaceShortcut.mockRejectedValueOnce({ code: 'shortcut_failed', message: 'Access denied' });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="shortcut"]');
    expect(host.createSpaceShortcut).toHaveBeenCalledWith('h-paper');
    expect(document.body.textContent).toContain('Access denied');
  });
});

describe('inside a space', () => {
  beforeEach(() => {
    configureSpaceStorage({ homeId: 'h-acme', name: 'ACME', color: '#295c58' });
    getConfig.mockResolvedValue({ default_model: 'a', origins: { default_model: { '': 'home' }, fast_model: { '': 'base' } } });
  });

  it('shows the list read-only, the accounts card, and its own settings', async () => {
    homes.detail.mockResolvedValue(spaceDetail());
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-new]')).toBeNull();
    expect(document.querySelector('[data-space-menu]')).toBeNull();
    expect(document.querySelector('[data-space-cred-current]')?.getAttribute('data-space-cred-current')).toBe('shared');
    // The space's own settings, flat: real summaries, the resource row, and
    // what it holds for itself.
    expect(document.querySelector('[data-space-settings]')?.getAttribute('data-space-settings')).toBe('h-acme');
    expect(document.querySelector('[data-space-group-summary="config"]')?.textContent).toBe('Follows the main space · 1 set here');
    expect(document.querySelector('[data-space-group-summary="credentials"]')?.textContent).toBe('Shared with the main space');
    expect(document.querySelector('[data-space-group-summary="generic_roots"]')?.textContent).toBe('Available');
    expect(document.querySelector('[data-space-own-item="pref:theme"]')?.textContent).toContain('Dark');
    expect(document.querySelector('[data-space-own-open="pref:theme"]')?.getAttribute('href')).toBe('/settings/appearance');
    expect(document.querySelector('[data-space-own-item="config:default_model"]')).toBeNull();
    expect(homes.detail).toHaveBeenCalledWith('h-acme');
  });

  /** The space detail the row menu, the subspace page and the origin marks read (schema 2). */
  function spaceDetail(fields: Record<string, unknown> = {}) {
    return {
      schema: 2, id: 'h-acme', name: 'ACME', primary: false, revision: 'r1', main_revision: 'r0',
      inherit: {
        config: true, agents: true, instructions: true, skills: true, mcp: true,
        appearance: true, plugins: false, credentials: 'shared', generic_roots: true,
      },
      groups: [
        { domain: 'config', mode: 'follow', fixed_count: 1, follow_count: 1 },
        { domain: 'appearance', mode: 'follow', fixed_count: 1, follow_count: 0 },
        { domain: 'credentials', mode: 'follow', fixed_count: 0, follow_count: 1 },
        { domain: 'generic_roots', mode: 'follow', fixed_count: 0, follow_count: 1 },
      ],
      items: [
        {
          id: 'pref:theme', name: 'Theme', domain: 'appearance', kind: 'preference', selection: { mode: 'fixed', reason: 'edited' },
          stored: 'dark', effective: 'dark', main: 'light', actual: 'dark', origin: 'home', available: true,
          pending: false, activation: 'immediate', revision: 'r', main_revision: 'm', dependencies: [], can_push: true,
        },
        {
          id: 'config:default_model', name: 'Default model', domain: 'config', kind: 'config', selection: { mode: 'follow' },
          stored: null, effective: 'kiki-pro', main: 'kiki-pro', actual: 'kiki-pro', origin: 'main', available: true,
          pending: false, activation: 'immediate', revision: 'r', main_revision: 'm', dependencies: [], can_push: true,
        },
      ],
      preferences: {
        theme: 'dark', skin: { source: 'builtin', id: 'inkstone' }, tweaks: {},
        background: { light: null, dark: null, linked: true, assist: true },
        proseFont: 'serif', defaultAppendTiming: 'agent_idle', foldSteps: true, worktreeSkipConfirm: false,
      },
      preference_authority: true, restart_required: false, undo_id: 'undo-1',
      ...fields,
    };
  }

  const followRow = {
    id: 'config:session_title.model', name: 'Session title model', domain: 'config', kind: 'config',
    selection: { mode: 'fixed', reason: 'edited' }, stored: 'kiki-lite', effective: 'kiki-lite', main: 'kiki-pro',
    actual: 'kiki-lite', origin: 'home', available: true, pending: false, activation: 'immediate',
    revision: 'r', main_revision: 'm', dependencies: [], can_push: true,
  };
  const followPlan = {
    schema: 2, token: 't9', action: 'follow', revision: 'r1', main_revision: 'r0', restart_required: false,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    rows: [
      { id: followRow.id, name: followRow.name, domain: 'config', before: 'kiki-lite', after: 'kiki-pro', selected: true, same_value: false, main_changed: false, conflict: false, dependencies: [] },
    ],
  };

  it('OriginBadge marks inherited and local values; restore plans the change instead of deleting the key', async () => {
    homes.detail.mockResolvedValue(spaceDetail({ items: [...spaceDetail().items, followRow] }));
    homes.preview.mockResolvedValue(followPlan);
    const cfg = { origins: { session_title: { model: 'home' }, fast_model: { '': 'base' } } } as never;
    await render(<>
      <OriginBadge config={cfg} domain="session_title" keyPath={['model']} label="Session titles" />
      <OriginBadge config={cfg} domain="fast_model" label="Fast model" />
    </>);
    expect(document.querySelector('[data-origin="home"]')?.textContent).toContain('This space');
    expect(document.querySelector('[data-origin="base"]')?.textContent).toBe('From main space');

    await click('[data-origin-restore="config:session_title.model"]');
    // The follow is planned for the server's own item id, and the panel that
    // lists it is the only thing that has happened.
    expect(homes.preview).toHaveBeenCalledWith('h-acme', { action: 'follow', items: ['config:session_title.model'] });
    expect(document.querySelector('[data-space-change-dialog="follow"]')).not.toBeNull();
    expect(config.removeOverride).not.toHaveBeenCalled();
    expect(homes.apply).not.toHaveBeenCalled();

    // Cancelling is a zero write.
    await click('[data-space-change-cancel]');
    expect(document.querySelector('[data-space-change-dialog]')).toBeNull();
    expect(homes.apply).not.toHaveBeenCalled();
    expect(config.removeOverride).not.toHaveBeenCalled();
  });

  it('OriginBadge restores with the plan’s token and only the row the person kept', async () => {
    homes.detail.mockResolvedValue(spaceDetail({ items: [...spaceDetail().items, followRow] }));
    homes.preview.mockResolvedValue(followPlan);
    homes.apply.mockResolvedValue({
      detail: spaceDetail({ items: [...spaceDetail().items, { ...followRow, selection: { mode: 'follow' }, stored: null, effective: 'kiki-pro', origin: 'main' }] }),
      applied: ['config:session_title.model'],
    });
    await render(<OriginBadge config={{ origins: { session_title: { model: 'home' } } } as never}
      domain="session_title" keyPath={['model']} label="Session titles" />);
    await click('[data-origin-restore="config:session_title.model"]');
    await click('[data-space-change-apply]');
    expect(homes.apply).toHaveBeenCalledWith('h-acme', { token: 't9', selected: ['config:session_title.model'] });
    expect(document.querySelector('[data-space-change-dialog]')).toBeNull();
    expect(config.removeOverride).not.toHaveBeenCalled();
  });

  it('OriginBadge offers nothing to delete when the plan is refused', async () => {
    homes.detail.mockResolvedValue(spaceDetail({ items: [...spaceDetail().items, followRow] }));
    homes.preview.mockRejectedValue(new Error('The main space has no value for this setting'));
    await render(<OriginBadge config={{ origins: { session_title: { model: 'home' } } } as never}
      domain="session_title" keyPath={['model']} label="Session titles" />);
    await click('[data-origin-restore="config:session_title.model"]');
    expect(document.body.textContent).toContain('The main space has no value for this setting');
    expect(config.removeOverride).not.toHaveBeenCalled();
    expect(homes.apply).not.toHaveBeenCalled();
  });
});

it('OriginBadge renders nothing in the main space', async () => {
  const container = await render(<OriginBadge config={{ origins: { default_model: { '': 'home' } } } as never} domain="default_model" label="x" />);
  expect(container.textContent).toBe('');
});

describe('non-Windows platform', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { language: 'en-US', platform: 'MacIntel', userAgent: 'Macintosh' });
  });

  it('disables create shortcut menu item and shows explanation', async () => {
    await render(<SpacesSection />);
    await click('[data-space-menu="main"]');
    const shortcutItem = document.querySelector<HTMLButtonElement>('[data-space-menu-item="shortcut"]')!;
    expect(shortcutItem).not.toBeNull();
    expect(shortcutItem.disabled).toBe(true);
    expect(shortcutItem.textContent).toContain('Desktop shortcuts are currently supported only on Windows.');
  });
});

function remoteControlFixture() {
  const remote = {
    homes: Object.fromEntries(Object.keys(homes).map((key) => [key, vi.fn().mockRejectedValue(new Error(`Unexpected remote ${key}`))])),
    config: { removeOverride: vi.fn() },
    ssh: { list: vi.fn(), copySharedCredentialsToIsolated: vi.fn() },
    getConfig: vi.fn(),
  };
  connection.remoteClient = { klient: { rest: remote }, getConfig: remote.getConfig };
  connection.sshLabel = 'example-remote';
  return remote;
}

function Draft() {
  const [text, setText] = useState('unsaved settings draft');
  useDirtyReporter('settings-fixture', text !== '');
  return <input data-settings-draft value={text} onChange={(event) => setText(event.target.value)} />;
}
function GuardedSettings() {
  const location = useLocation();
  const rawNavigate = useNavigate();
  const guard = useDirtyGuardState(location, (target, options) => {
    if (typeof target === 'number') void rawNavigate(target);
    else void rawNavigate(target, options);
  });
  const [error, setError] = useState('');
  return <DirtyGuardContext.Provider value={guard.value}>
    <Draft /><SpacesSection /><output data-settings-route>{location.pathname}{location.search}</output>
    <output data-settings-error>{error}</output><output data-settings-dirty>{String(guard.value.dirty)}</output>
    {guard.pending ? <><button data-settings-cancel onClick={guard.cancel}>Cancel</button>
      <button data-settings-confirm onClick={() => { void Promise.resolve().then(guard.confirm).catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) setError(String(error));
      }); }}>Confirm</button></> : null}
  </DirtyGuardContext.Provider>;
}

describe('direct remote settings control operations', () => {
  it('keeps create/attach drafts on local failures and refreshes the same local directory on success', async () => {
    const remote = remoteControlFixture();
    homes.create.mockRejectedValueOnce(new Error('Local folder access denied'));
    homes.attach.mockResolvedValue(LIST.items[2]);
    await render(<SpacesSection />);
    await click('[data-space-new]');
    await type('[data-space-name]', 'Local Draft');
    const path = document.querySelector<HTMLInputElement>('[data-space-path]')!.value;
    expect(path).toContain('C:\\Users\\me\\');
    await click('[data-space-create-submit]');
    expect(homes.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Local Draft', path }));
    expect(document.querySelector<HTMLInputElement>('[data-space-name]')!.value).toBe('Local Draft');
    expect(document.body.textContent).toContain('Local folder access denied');
    expect(host.openSpace).not.toHaveBeenCalled();
    // Closing the panel is the header's ×; the attach entry lives on the list.
    await click('button[aria-label="Close"]');
    await click('[data-space-attach-open]');
    await type('[data-space-attach-path]', 'D:\\existing');
    await click('[data-space-attach-submit]');
    expect(homes.attach).toHaveBeenCalledWith({ path: 'D:\\existing' });
    expect(homes.list.mock.calls.length).toBeGreaterThan(1);
    for (const spy of Object.values(remote.homes)) expect(spy).not.toHaveBeenCalled();
  });

  it('deletes the colliding local object and reads/writes credential candidates locally', async () => {
    const remote = remoteControlFixture();
    homes.erase.mockResolvedValue(LIST);
    homes.sshCopyCandidates.mockResolvedValue({ hosts: [{ hostId: 'local-prod', name: 'Local Prod', credential_kinds: ['password'] }] });
    homes.update.mockResolvedValue({ space: { ...LIST.items[1], credentials_shared: false }, restart_required: false, copied_ssh_entries: 1 });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="delete"]');
    expect(document.querySelector('[data-space-delete-path]')?.textContent).toBe('D:\\paper');
    await type('[data-space-delete-input]', 'Paper');
    await click('[data-space-delete-confirm]');
    expect(homes.erase).toHaveBeenCalledWith('h-paper', { confirm_name: 'Paper' });
    await click('[data-space-menu="h-acme"]');
    await click('[data-space-menu-item="credentials"]');
    expect(homes.sshCopyCandidates).toHaveBeenCalledWith('h-acme');
    await click('[data-space-copy-ssh-host="local-prod"]');
    await click('[data-space-credentials-confirm]');
    expect(homes.update).toHaveBeenCalledWith('h-acme', { inherit: { credentials: 'isolated' }, copy_ssh_credentials: { hosts: [{ hostId: 'local-prod' }] } });
    homes.remove.mockResolvedValue(LIST);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="remove"]');
    // Removing from the list keeps the folder, so it runs at once with an undo.
    expect(document.querySelector('[data-confirm-action="confirm"]')).toBeNull();
    expect(homes.remove).toHaveBeenCalledWith('h-paper');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const undo = getToasts().at(-1)!;
    expect(undo.undo).toBeDefined();
    homes.attach.mockResolvedValue({ id: 'h-paper', name: 'Paper', path: 'D:\\paper' });
    await act(async () => { await undo.undo!.run(); });
    expect(homes.attach).toHaveBeenCalledWith({ path: 'D:\\paper' });
    homes.create.mockResolvedValue({ id: 'local-created', name: 'Local New', path: 'D:\\local-new' });
    await click('[data-space-new]');
    await type('[data-space-name]', 'Local New');
    await click('[data-space-create-submit]');
    expect(host.openSpace).toHaveBeenCalledExactlyOnceWith('local-created');
    expect(connection.order).toEqual(['local']);
    for (const spy of Object.values(remote.homes)) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps unconfirmed local metadata unreadable without borrowing remote identity, then retries that local endpoint', async () => {
    const remote = remoteControlFixture();
    localMeta.mockResolvedValueOnce({ server_id: 'server-test' });
    homes.detail.mockResolvedValue({
      schema: 2, id: 'h-paper', name: 'Local Paper', primary: false, revision: 'local-r1',
      inherit: { config: true, agents: true, instructions: true, skills: true, mcp: true, appearance: true, plugins: false, credentials: 'isolated', generic_roots: true },
      groups: [], items: [], preferences: DEFAULT_SPACE_PREFERENCES, preference_authority: true, restart_required: false,
    });
    await render(<SpacesSection />);
    await click('[data-space-menu="h-paper"]');
    await click('[data-space-menu-item="settings"]');
    expect(document.querySelector('[data-space-settings-failed]')).not.toBeNull();
    expect(homes.detail).not.toHaveBeenCalled();
    await click('[data-space-settings-failed] button');
    expect(localMeta).toHaveBeenCalledTimes(2);
    expect(homes.detail).toHaveBeenCalledWith('h-paper');
    expect(document.querySelector('[data-detail-heading]')?.textContent).toContain('Paper');
    for (const spy of Object.values(remote.homes)) expect(spy).not.toHaveBeenCalled();
  });

  it('uses local detail/preview/apply/undo and SSH copy while the active remote has the same home id', async () => {
    const remote = remoteControlFixture();
    configureSpaceStorage({ homeId: 'h-acme', name: 'ACME' });
    const local: SpaceDetail = {
      schema: 2, id: 'h-acme', name: 'Local ACME', primary: false, revision: 'local-r1',
      inherit: { config: true, agents: true, instructions: true, skills: true, mcp: true, appearance: true, plugins: false, credentials: 'shared', generic_roots: true },
      groups: [{ domain: 'appearance', mode: 'follow', fixed_count: 0, follow_count: 1 }], items: [],
      preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' }, preference_authority: true, restart_required: false, undo_id: 'local-undo',
    };
    configureSpaceAuthority({ serverId: 'remote-server', homeId: 'h-acme' }, { ...local, revision: 'remote-r1', preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'dark' } });
    const held = spaceAuthoritySnapshot();
    homes.detail.mockResolvedValue(local);
    homes.preview.mockResolvedValue({ schema: 2, token: 'local-plan', action: 'follow', revision: 'local-r1', restart_required: false, rows: [
      { id: 'group:appearance', name: 'Appearance', domain: 'appearance', selected: true, same_value: false, conflict: false, before: 'fixed', after: 'follow', activation: 'immediate' },
    ] });
    homes.apply.mockResolvedValue({ detail: local, applied: ['group:appearance'] });
    homes.undo.mockResolvedValue({ detail: local, applied: [] });
    ssh.list.mockResolvedValue({ hosts: [{ id: 'local-prod', source: 'kiki' }] });
    ssh.copySharedCredentialsToIsolated.mockResolvedValue({ hosts: [{ copied: 1 }] });
    await render(<SpacesSection />);
    expect(localMeta).toHaveBeenCalledOnce();
    expect(homes.detail).toHaveBeenCalledWith('h-acme');
    expect(document.querySelector('[data-space-device-conflict]')).toBeNull();
    await click('[data-space-change="appearance"]');
    await click('[data-space-change-apply]');
    expect(homes.preview).toHaveBeenCalledWith('h-acme', { action: 'follow', groups: ['appearance'], items: undefined, changes: undefined });
    expect(homes.apply).toHaveBeenCalledWith('h-acme', { token: 'local-plan', selected: ['group:appearance'] });
    await click('[data-space-undo]');
    expect(homes.undo).toHaveBeenCalledWith('h-acme', 'local-undo');
    expect(spaceAuthoritySnapshot()).toBe(held);
    await click('[data-space-copy-here]');
    await click('[data-space-copy-here-host="local-prod"]');
    await click('[data-space-copy-here-confirm]');
    expect(ssh.copySharedCredentialsToIsolated).toHaveBeenCalledWith({ hosts: [{ hostId: 'local-prod' }] });
    for (const spy of Object.values(remote.homes)) expect(spy).not.toHaveBeenCalled();
    expect(remote.getConfig).not.toHaveBeenCalled();
    expect(remote.config.removeOverride).not.toHaveBeenCalled();
    expect(remote.ssh.list).not.toHaveBeenCalled();
    expect(remote.ssh.copySharedCredentialsToIsolated).not.toHaveBeenCalled();
  });

  it('does not change connection/history/draft on cancel or local restore failure; retry confirms only once', async () => {
    const remote = remoteControlFixture();
    await render(<GuardedSettings />);
    await click('[data-space-enter="main"]');
    expect(connection.verifyLocal).not.toHaveBeenCalled();
    expect(host.openSpace).not.toHaveBeenCalled();
    await click('[data-settings-cancel]');
    expect(connection.remoteClient).toHaveProperty('getConfig', remote.getConfig);
    expect(document.querySelector('[data-settings-route]')?.textContent).toBe('/settings/spaces');
    expect(document.querySelector<HTMLInputElement>('[data-settings-draft]')!.value).toBe('unsaved settings draft');
    connection.verifyLocal.mockRejectedValueOnce(new Error('Local meta unavailable'));
    await click('[data-space-enter="main"]');
    await click('[data-settings-confirm]');
    expect(host.openSpace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-settings-error]')?.textContent).toContain('Local meta unavailable');
    expect(document.querySelector('[data-settings-dirty]')?.textContent).toBe('true');
    await click('[data-space-enter="main"]');
    const confirm = document.querySelector<HTMLButtonElement>('[data-settings-confirm]')!;
    await act(async () => { confirm.click(); confirm.click(); });
    await flush();
    expect(host.openSpace).toHaveBeenCalledExactlyOnceWith('main');
    expect(connection.verifyLocal).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-settings-dirty]')?.textContent).toBe('false');
  });

  it('does not replay a replaced async restore result', async () => {
    remoteControlFixture();
    let resolve!: () => void;
    connection.verifyLocal.mockImplementationOnce((signal) => new Promise<void>((done) => { resolve = done; }).then(() => {
      // Match restoreLocal's commit boundary: cancelled verification rejects before activation.
      signal?.throwIfAborted();
    }));
    await render(<GuardedSettings />);
    await click('[data-space-enter="h-paper"]');
    await click('[data-settings-confirm]');
    const signal = connection.verifyLocal.mock.calls[0]![0]!;
    await click('[data-space-enter="main"]');
    expect(signal.aborted).toBe(true);
    await click('[data-settings-cancel]');
    await act(async () => { resolve(); });
    await flush();
    expect(host.openSpace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-settings-dirty]')?.textContent).toBe('true');
    expect(document.querySelector<HTMLInputElement>('[data-settings-draft]')!.value).toBe('unsaved settings draft');
  });
});

describe('Spaces & Access IA (#16)', () => {
  it('lists local spaces, paired spaces on other computers, Owner (SSH) profiles, and bottom window mode on Spaces', async () => {
    connections.list.mockResolvedValue([
      {
        id: 'pair-b',
        label: 'Workstation B',
        endpoint: 'https://b.example.test',
        target: { homeId: '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301', hostId: 'gpu-box', protocol: 1 },
        credentialRef: 'pair-b',
        purposes: ['gui'],
        enabled: true,
        backgroundSummary: true,
        state: 'online',
        activeLeases: 1,
        pinnedFingerprint: 'fedcba9876543210'.repeat(4),
        fingerprintToVerify: '0123456789abcdef'.repeat(4),
      },
    ]);
    hostConnection.listSshProfiles.mockResolvedValue([
      {
        id: 'ssh-build',
        label: 'Build box',
        target: { kind: 'alias', alias: 'build-box' },
        releaseChannel: 'stable',
        remotePort: 58627,
        serverHomeId: '46aca369-50e8-4fd3-9c45-606d084450ed',
      },
    ]);
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-row="main"]')).not.toBeNull();
    const remoteRow = document.querySelector('[data-remote-connection="pair-b"]')!;
    expect(remoteRow.textContent).toContain('Workstation B');
    expect(remoteRow.querySelector('[data-remote-fingerprint-to-verify]')?.textContent).toContain('0123456789abcdef…89abcdef');
    expect(remoteRow.querySelector('[data-remote-fingerprint-to-verify]')?.getAttribute('title')).toBe('0123456789abcdef'.repeat(4));
    expect(remoteRow.querySelector('[data-remote-pinned-fingerprint]')?.textContent).toContain('fedcba9876543210…76543210');
    expect(document.querySelector('#st-card-remote-connections')?.textContent).toContain('Spaces on other computers · openable from “Main space”');
    const sshRow = document.querySelector('[data-ssh-profile-row="ssh-build"]')!;
    expect(sshRow).not.toBeNull();
    expect(sshRow.textContent).toContain('Build box');
    expect(sshRow.textContent).toContain('Owner (SSH)');

    // Window mode card sits at the bottom after local and remote lists.
    const cardIds = [...document.querySelectorAll('section[id^="st-card-"]')].map((el) => el.id);
    expect(cardIds).toEqual(['st-card-spaces', 'st-card-remote-connections', 'st-card-space-window']);

    // Connect… on Owner (SSH) opens the token dialog and connects with the typed bearer token.
    await click('[data-ssh-profile-connect="ssh-build"]');
    expect(document.querySelector('[data-owner-ssh-dialog]')).not.toBeNull();
    const token = 'a'.repeat(43);
    await type('[data-owner-ssh-dialog] input[type="password"]', token);
    const connectButton = [...document.querySelectorAll<HTMLButtonElement>('[data-owner-ssh-dialog] button')]
      .find((btn) => btn.textContent === 'Connect to running server')!;
    await act(async () => { connectButton.click(); });
    await flush();
    expect(connection.activateSshProfile).toHaveBeenCalledWith('ssh-build', token);
  });

  it('lists local spaces read-only in a browser host without New space or Add existing space buttons', async () => {
    host.kind = 'browser';
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-row="main"]')).not.toBeNull();
    expect(document.querySelector('[data-space-row="h-acme"]')).not.toBeNull();
    expect(document.querySelector('[data-space-new]')).toBeNull();
    expect(document.querySelector('[data-space-attach-open]')).toBeNull();
    expect(document.querySelector('[data-space-enter]')).toBeNull();
    expect(document.querySelector('[data-space-menu]')).toBeNull();
    expect(document.querySelector('#st-card-space-window')).toBeNull();
  });

  it('shows the local-space banner and sends zero remote: home requests when opened from a paired remote space', async () => {
    const remote = remoteControlFixture();
    connection.sshLabel = null;
    connection.connectionId = '9d5b4bd0-8f2b-4a1f-9f37-52c1b48a1a01';
    configureSpaceStorage({ homeId: 'remote:9d5b4bd0-8f2b-4a1f-9f37-52c1b48a1a01' });
    await render(<SpacesSection />);
    expect(document.querySelector('[data-spaces-remote-scope-banner]')?.textContent)
      .toBe('These are the spaces and pairings of Main space.');
    expect(homes.detail).not.toHaveBeenCalled();
    for (const call of homes.detail.mock.calls) {
      expect(String(call[0])).not.toContain('remote:');
    }
    for (const spy of Object.values(remote.homes)) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps outbound list out of Access → Other spaces and places manual identity exchange under Advanced as one row', async () => {
    await render(<ConnectionServicesSection />, ['/settings/connection-services?tab=kiki']);
    expect(document.querySelector('[data-inbound-connections]')).not.toBeNull();
    expect(document.querySelector('[data-remote-connections]')).toBeNull();
    expect(document.querySelector('[data-inbound-outbound-note]')?.textContent)
      .toContain('Spaces you open are managed on the Spaces page.');
    // Identity is inside closed Advanced disclosure, with no raw JSON code block.
    const fold = document.querySelector<HTMLDetailsElement>('[data-inbound-advanced-fold]')!;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(fold.querySelector('code')).toBeNull();
    expect(fold.querySelector('[data-remote-self-identity] [data-copy-field="self"]')).not.toBeNull();
    expect(fold.textContent).not.toContain('homeId');
  });
});

describe('Thread-message permissions on pairing rows (#20)', () => {
  const localIdentity = { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 };
  const targetB = { homeId: '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301', hostId: 'gpu-box', protocol: 1 };
  const targetWriter = { homeId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', hostId: 'writer-box', protocol: 1 };
  const futureExpiry = Date.now() + 365 * 24 * 3600 * 1000;

  it('shows openable + direction facts, renders "Can’t be opened" without Switch for bridge-only rows, and revokes one permission alone', async () => {
    listWorkspaceCatalog.mockResolvedValue({
      items: [
        { id: 'wd_localapp_abcdef012345', name: 'Kiki Monorepo', root: 'D:\\kiki', created_at: '2026-01-01T00:00:00Z', last_opened_at: '2026-01-02T00:00:00Z', pinned: false },
      ],
    });
    connections.list.mockResolvedValue([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'Workstation B',
        endpoint: 'https://b.example.test',
        target: targetB,
        credentialRef: 'pair-b',
        purposes: ['gui', 'bridge'],
        enabled: true,
        backgroundSummary: true,
        state: 'online',
        activeLeases: 1,
        summary: {
          value: { busy_sessions: 3, needs_you_sessions: 2 },
          lastSeen: Date.now(),
          stale: false,
        },
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        label: 'Writer space link',
        endpoint: 'https://writer.example.test',
        target: targetWriter,
        credentialRef: 'pair-writer',
        purposes: ['bridge'],
        enabled: true,
        backgroundSummary: false,
        state: 'offline',
        activeLeases: 0,
      },
    ]);

    const outboundB = {
      connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      enabled: true,
      grant: {
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        enabled: true,
        revoked: false,
        createdAt: Date.now() - 60_000,
        source: localIdentity,
        target: targetB,
        sourceScope: { workspaceId: 'wd_localapp_abcdef012345' },
        targetScope: { workspaceId: 'wd_remote-research_0123456789ab' },
        operations: ['read', 'send', 'wait'] as const,
        expiresAt: futureExpiry,
        pendingLimit: 20,
        messagesPerMinute: 60,
        location: 'network' as const,
        label: 'Workstation B',
      },
    };
    const inboundB = {
      id: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      enabled: true,
      revoked: false,
      createdAt: Date.now() - 60_000,
      source: targetB,
      target: localIdentity,
      sourceScope: { workspaceId: 'wd_remote-research_0123456789ab' },
      targetScope: { workspaceId: 'wd_localapp_abcdef012345' },
      operations: ['read', 'send', 'wait', 'wake'] as const,
      expiresAt: futureExpiry,
      pendingLimit: 20,
      messagesPerMinute: 60,
      location: 'network' as const,
      label: 'Workstation B',
    };
    const outboundWriter = {
      connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      enabled: true,
      grant: {
        ...outboundB.grant,
        id: '33333333-3333-4333-8333-333333333333',
        target: targetWriter,
        label: 'Writer space link',
      },
    };

    threadBridges.status.mockResolvedValue({
      identity: localIdentity,
      inboundEnabled: true,
      inbound: [inboundB],
      outbound: [outboundB, outboundWriter],
    });

    await render(<SpacesSection />);

    const rowB = document.querySelector('[data-remote-connection="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')!;
    expect(rowB.textContent).toContain('Can be opened');
    expect(rowB.textContent).toContain('Thread messages: both ways');
    expect(rowB.textContent).toContain('3 working');
    expect(rowB.textContent).toContain('2 waiting on you');
    expect(rowB.querySelector('[data-remote-enter="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')).not.toBeNull();

    const rowWriter = document.querySelector('[data-remote-connection="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]')!;
    expect(rowWriter.textContent).toContain('Can’t be opened');
    expect(rowWriter.textContent).toContain('Thread messages: outgoing only');
    expect(rowWriter.querySelector('[data-remote-enter="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]')).toBeNull();

    // Open Thread messages… from Workstation B's row menu.
    await click('[data-remote-menu="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]');
    await click('[data-space-menu-item="thread-messages"]');

    const panel = document.querySelector('[data-thread-messages-panel="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('This space → Workstation B');
    expect(panel.textContent).toContain('Workstation B → this space');
    // Local workspace resolved by name; remote workspace sanitized without raw wd_ hash.
    expect(panel.textContent).toContain('Kiki Monorepo');
    expect(panel.textContent).toContain('remote-research');
    expect(panel.textContent).not.toContain('wd_localapp_abcdef012345');
    expect(panel.textContent).not.toContain('0123456789ab');
    // Outbound entry lacks wake -> shows pending note.
    expect(panel.querySelector('[data-thread-message-entry="11111111-1111-4111-8111-111111111111"] [data-thread-message-no-wake]')).not.toBeNull();
    // Inbound entry has wake -> no pending note on that card.
    expect(panel.querySelector('[data-thread-message-entry="22222222-2222-4222-8222-222222222222"] [data-thread-message-no-wake]')).toBeNull();

    // Revoke outbound permission alone -> calls revoke('outbound', id), updates row to incoming only, keeps pairing openable.
    const nextStatus = {
      identity: localIdentity,
      inboundEnabled: true,
      inbound: [inboundB],
      outbound: [{ ...outboundB, enabled: false, grant: { ...outboundB.grant, revoked: true, enabled: false } }, outboundWriter],
    };
    threadBridges.revoke.mockResolvedValueOnce(nextStatus);
    threadBridges.status.mockResolvedValue(nextStatus);

    await click('[data-thread-message-revoke="11111111-1111-4111-8111-111111111111"]');
    await click('[data-confirm-action="confirm"]');

    expect(threadBridges.revoke).toHaveBeenCalledExactlyOnceWith('outbound', '11111111-1111-4111-8111-111111111111');
    expect(connections.remove).not.toHaveBeenCalled();
    expect(rowB.textContent).toContain('Can be opened');
    expect(rowB.textContent).toContain('Thread messages: incoming only');
    expect(rowB.querySelector('[data-remote-enter="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')).not.toBeNull();
  });

  it('shows "Thread messages: can’t read" and never "none" when the status call fails', async () => {
    connections.list.mockResolvedValue([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'Workstation B',
        endpoint: 'https://b.example.test',
        target: targetB,
        credentialRef: 'pair-b',
        purposes: ['gui'],
        enabled: true,
        backgroundSummary: false,
        state: 'online',
        activeLeases: 0,
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        label: 'Writer space link',
        endpoint: 'https://writer.example.test',
        target: targetWriter,
        credentialRef: 'pair-writer',
        purposes: ['bridge'],
        enabled: true,
        backgroundSummary: false,
        state: 'offline',
        activeLeases: 0,
      },
    ]);
    threadBridges.status.mockRejectedValue(new Error('500 thread bridge store offline'));

    await render(<SpacesSection />);

    const rowB = document.querySelector('[data-remote-connection="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]')!;
    const rowWriter = document.querySelector('[data-remote-connection="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]')!;
    expect(rowB.textContent).toContain('Thread messages: can’t read');
    expect(rowWriter.textContent).toContain('Thread messages: can’t read');
    expect(rowB.textContent).not.toContain('Thread messages: none');
    expect(rowWriter.textContent).not.toContain('Thread messages: none');
  });
});

describe('PairSheet pre-consent, toast Switch offer, and Access incoming rows (#21)', () => {
  const localIdentity = { homeId: '11bb22cc-33dd-4ee5-8ff6-0011223344aa', hostId: 'this-machine', protocol: 1 };
  const peerSource = { homeId: '22222222-2222-4222-8222-222222222222', hostId: 'laptop-b', protocol: 1 };

  it('sends no createPairCode request until "Turn on and generate code" is pressed, and sends allowBridge: false by default', async () => {
    connections.inbound.mockResolvedValue({
      enabled: false,
      configuredEnabled: false,
      identity: localIdentity,
      grants: [],
    });
    connections.createPairCode.mockResolvedValue({
      code: 'K9F2-7X4M',
      expiresAt: Date.now() + 600_000,
      target: localIdentity,
      suggestedEndpoints: ['http://192.168.1.20:58627'],
    });

    await render(<ConnectionServicesSection />, ['/settings/connection-services?tab=kiki']);
    await click('[data-inbound-invite]');

    // Pre-consent screen is open; no request sent on mount!
    expect(document.querySelector('[data-pair-sheet="inbound"]')).not.toBeNull();
    expect(document.querySelector('[data-inbound-consent]')).not.toBeNull();
    expect(connections.createPairCode).not.toHaveBeenCalled();

    const openCheck = document.querySelector<HTMLInputElement>('[data-inbound-consent-open]')!;
    const bridgeCheck = document.querySelector<HTMLInputElement>('[data-inbound-consent-bridge]')!;
    expect(openCheck.checked).toBe(true);
    expect(openCheck.disabled).toBe(true);
    expect(bridgeCheck.checked).toBe(false);
    expect(document.querySelector('[data-inbound-gate-consequence]')?.textContent)
      .toContain('Allow other spaces to connect');

    const generateBtn = document.querySelector<HTMLButtonElement>('[data-inbound-generate-code]')!;
    expect(generateBtn.textContent).toBe('Turn on and generate code');

    await click('[data-inbound-generate-code]');
    expect(connections.createPairCode).toHaveBeenCalledExactlyOnceWith({ allowBridge: false });
    expect(document.querySelector('[data-inbound-code]')?.textContent).toBe('K9F2-7X4M');
  });

  it('shows and embeds the issued TLS fingerprint in the inbound pairing URI', async () => {
    const tlsFingerprint = '0123456789abcdef'.repeat(4);
    connections.createPairCode.mockResolvedValue({
      code: 'K9F2-7X4M',
      expiresAt: Date.now() + 600_000,
      target: localIdentity,
      suggestedEndpoints: ['http://192.168.1.20:58627'],
      tlsFingerprint,
    });

    await render(<ConnectionServicesSection />, ['/settings/connection-services?tab=kiki']);
    await click('[data-inbound-invite]');
    await click('[data-inbound-generate-code]');

    const fingerprint = document.querySelector<HTMLElement>('[data-inbound-tls-fingerprint]')!;
    expect(fingerprint.textContent).toContain('TLS fingerprint: 0123456789abcdef…89abcdef');
    expect(fingerprint.querySelector('[title]')?.getAttribute('title')).toBe(tlsFingerprint);
    const qr = document.querySelector<HTMLImageElement>('[data-inbound-qr]')!;
    expect(new URL(qr.dataset['inboundQrUri']!).searchParams.get('fp')).toBe(tlsFingerprint);
  });

  it('shows "Generate code" without gate warning when gate is already on, and sends wake when thread messages is checked', async () => {
    connections.inbound.mockResolvedValue({
      enabled: true,
      configuredEnabled: true,
      identity: localIdentity,
      grants: [
        {
          id: 'grant-1',
          source: peerSource,
          target: localIdentity,
          purpose: 'gui',
          revision: 1,
          status: 'approved',
          label: 'Laptop B',
          createdAt: Date.now() - 60_000,
          activeLeases: 1,
        },
      ],
    });
    threadBridges.status.mockResolvedValue({
      identity: localIdentity,
      inboundEnabled: true,
      inbound: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          revision: 1,
          enabled: true,
          revoked: false,
          createdAt: Date.now() - 30_000,
          source: peerSource,
          target: localIdentity,
          sourceScope: { workspaceId: 'wd_laptop_0123456789ab' },
          targetScope: { workspaceId: 'wd_local_abcdef012345' },
          operations: ['read', 'send', 'wait', 'wake'],
          expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
          pendingLimit: 20,
          messagesPerMinute: 60,
          location: 'network',
          label: 'Laptop B',
        },
      ],
      outbound: [],
    });
    connections.createPairCode.mockResolvedValue({
      code: 'ABCD-2345',
      expiresAt: Date.now() + 600_000,
      target: localIdentity,
      suggestedEndpoints: ['http://192.168.1.20:58627'],
    });

    await render(<ConnectionServicesSection />, ['/settings/connection-services?tab=kiki']);
    const grantRow = document.querySelector('[data-inbound-grant="grant-1"]')!;
    expect(grantRow.textContent).toContain('Can open this space');
    expect(grantRow.textContent).toContain('Thread messages: incoming only');

    await click('[data-inbound-invite]');
    expect(document.querySelector('[data-inbound-gate-consequence]')).toBeNull();
    expect(document.querySelector('[data-inbound-generate-code]')?.textContent).toBe('Generate code');

    await click('[data-inbound-consent-bridge]');
    await click('[data-inbound-generate-code]');
    expect(connections.createPairCode).toHaveBeenCalledExactlyOnceWith({
      allowBridge: true,
      bridgeOperations: ['read', 'send', 'wait', 'wake'],
    });
  });

  it('keeps the window in its current space after pairing from Spaces and pushes a toast offering "Switch"', async () => {
    const scopeSpy = vi.fn();
    const unregister = registerScopeNavigation(scopeSpy);
    try {
      const pairedRecord = {
        id: '99999999-9999-4999-8999-999999999999',
        label: 'Studio Mac',
        endpoint: 'http://192.168.1.40:58627',
        target: peerSource,
        credentialRef: 'pair-studio',
        purposes: ['gui'] as ('gui' | 'bridge')[],
        enabled: true,
        backgroundSummary: true,
        state: 'online' as const,
        activeLeases: 0,
      };
      connections.pair.mockResolvedValue(pairedRecord);

      await render(<SpacesSection />);
      await click('[data-remote-add]');
      expect(document.querySelector('[data-pair-sheet="outbound"]')).not.toBeNull();

      await type('[data-remote-endpoint]', 'http://192.168.1.40:58627');
      await type('[data-remote-code]', 'K9F27X4M');
      await click('[data-remote-add-submit]');

      expect(connections.pair).toHaveBeenCalledWith({
        endpoint: 'http://192.168.1.40:58627',
        code: 'K9F2-7X4M',
        backgroundSummary: true,
        requestBridge: false,
        fingerprint: undefined,
      });
      // Sheet closed, window did NOT auto-switch, and toast offers Switch!
      expect(document.querySelector('[data-pair-sheet="outbound"]')).toBeNull();
      expect(scopeSpy).not.toHaveBeenCalled();
      const toast = getToasts().at(-1)!;
      expect(toast.text).toBe('Paired Studio Mac.');
      expect(toast.action?.label).toBe('Switch');
    } finally {
      unregister();
    }
  });

  it('passes a pairing URI fingerprint through to the pairing request and success toast', async () => {
    const tlsFingerprint = '0123456789abcdef'.repeat(4);
    connections.pair.mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      label: 'Studio Mac',
      endpoint: 'http://192.168.1.40:58627',
      target: peerSource,
      credentialRef: 'pair-studio',
      purposes: ['gui'],
      enabled: true,
      backgroundSummary: true,
      state: 'online',
      activeLeases: 0,
      fingerprintToVerify: tlsFingerprint,
    });

    await render(<SpacesSection />);
    await click('[data-remote-add]');
    const pairingUri = `kiki://pair?endpoint=${encodeURIComponent('http://192.168.1.40:58627')}&code=K9F2-7X4M&fp=${tlsFingerprint}`;
    await type('[data-remote-endpoint]', pairingUri);
    expect(document.querySelector<HTMLInputElement>('[data-remote-code]')?.value).toBe('K9F2-7X4M');
    await click('[data-remote-add-submit]');

    expect(connections.pair).toHaveBeenCalledWith({
      endpoint: 'http://192.168.1.40:58627',
      code: 'K9F2-7X4M',
      backgroundSummary: true,
      requestBridge: false,
      fingerprint: tlsFingerprint,
    });
    expect(getToasts().at(-1)?.text).toBe('Paired Studio Mac. Verify its TLS fingerprint: 0123456789abcdef…89abcdef.');
  });
});
