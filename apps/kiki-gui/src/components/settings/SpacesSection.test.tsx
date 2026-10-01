// @vitest-environment jsdom

/**
 * Settings › Spaces: the main-space list and its dialogs (typed-name delete,
 * credential switch with SSH hosts), the subspace view (read-only list,
 * overrides with Restore inheritance), and the Defaults origin marks.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSpaceStorage } from '@kiki/session-core/storage';

import { I18nProvider } from '../../i18n';
import { OriginBadge } from './spaces/OriginBadge';
import { SpacesSection } from './SpacesSection';

const homes = {
  list: vi.fn(), create: vi.fn(), attach: vi.fn(), remove: vi.fn(), erase: vi.fn(),
  update: vi.fn(), sshCopyCandidates: vi.fn(),
};
const config = { removeOverride: vi.fn() };
const ssh = { list: vi.fn(), copySharedCredentialsToIsolated: vi.fn() };
const getConfig = vi.fn();
const host = {
  kind: 'tauri' as const,
  spaceStatuses: vi.fn(),
  openSpace: vi.fn(),
  switchSpace: vi.fn(),
  restartSpace: vi.fn(async () => undefined),
  createSpaceShortcut: vi.fn(async () => ({ homeId: 'main', path: 'C:\\Users\\me\\Desktop\\Kiki - Main space.lnk' })),
  readDesktopPrefs: vi.fn(async () => null),
  writeDesktopPrefs: vi.fn(async () => undefined),
  revealPath: vi.fn(async () => undefined),
  restartServer: vi.fn(async () => undefined),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { klient: { rest: { homes, config, ssh } }, getConfig } }),
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
  for (const fn of [...Object.values(homes), ...Object.values(config), ...Object.values(ssh), getConfig, host.spaceStatuses]) fn.mockReset();
  homes.list.mockResolvedValue(LIST);
  host.restartSpace.mockClear();
  host.spaceStatuses.mockResolvedValue([
    { homeId: 'main', active: true, hot: true, pendingCount: 0, busyCount: 0 },
    { homeId: 'h-acme', active: false, hot: true, pendingCount: 2, busyCount: 1 },
  ]);
  localStorage.clear();
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
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

describe('SpacesSection in the main space', () => {
  it('opens create when arriving from the sidebar with ?new=1', async () => {
    await render(<SpacesSection />, ['/settings/spaces?new=1']);
    expect(document.querySelector('[data-space-create]')).not.toBeNull();
  });

  it('lists spaces with current, running, not-started and pending marks', async () => {
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-row="main"]')?.getAttribute('data-space-state')).toBe('current');
    expect(document.querySelector('[data-space-row="h-acme"]')?.getAttribute('data-space-state')).toBe('hot');
    expect(document.querySelector('[data-space-row="h-paper"]')?.getAttribute('data-space-state')).toBe('cold');
    expect(document.querySelector('[data-space-row="h-acme"] [data-space-pending]')?.textContent).toBe('2 need you');
    expect(document.querySelector('[data-space-row="h-paper"] [data-space-cred]')?.getAttribute('data-space-cred')).toBe('isolated');
    expect(document.querySelector('[data-space-new]')).not.toBeNull();
    await click('[data-space-enter="h-paper"]');
    expect(host.openSpace).toHaveBeenCalledWith('h-paper');
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
    await render(<SpacesSection />);
    await click('[data-space-window-choice="windows"] input');
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

  it('shows the list read-only, the accounts card, and restores an override', async () => {
    config.removeOverride.mockResolvedValue({ default_model: 'b', origins: { default_model: { '': 'base' } } });
    await render(<SpacesSection />);
    expect(document.querySelector('[data-space-new]')).toBeNull();
    expect(document.querySelector('[data-space-menu]')).toBeNull();
    expect(document.querySelector('[data-space-cred-current]')?.getAttribute('data-space-cred-current')).toBe('shared');
    expect(document.querySelector('[data-space-override="default_model"]')).not.toBeNull();
    await click('[data-origin-restore="default_model"]');
    expect(config.removeOverride).toHaveBeenCalledWith({ domain: 'default_model', key_path: [] });
    expect(document.querySelector('[data-space-overrides-empty]')).not.toBeNull();
  });

  it('OriginBadge marks inherited and local values; restore calls removeOverride', async () => {
    config.removeOverride.mockResolvedValue({ origins: { session_title: { model: 'base' } } });
    const cfg = { origins: { session_title: { model: 'home' }, fast_model: { '': 'base' } } } as never;
    await render(<>
      <OriginBadge config={cfg} domain="session_title" keyPath={['model']} label="Session titles" />
      <OriginBadge config={cfg} domain="fast_model" label="Fast model" />
    </>);
    expect(document.querySelector('[data-origin="home"]')?.textContent).toContain('This space');
    expect(document.querySelector('[data-origin="base"]')?.textContent).toBe('From main space');
    await click('[data-origin-restore="session_title.model"]');
    expect(config.removeOverride).toHaveBeenCalledWith({ domain: 'session_title', key_path: ['model'] });
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
