// @vitest-environment jsdom

/**
 * Settings › SSH hosts at the two places a guess used to stand in for an
 * answer: the config-sync switch reads the stored value from the server, and
 * host keys are read on demand — a collapsed or expanded row touches no file
 * until the row asks, and each state the route can report has words of its own.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SshConfigSyncSettings, SshHost, SshHostKeys } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { SshSection } from './SshSection';

const KIKI_HOST: SshHost = {
  id: 'gpu-box', name: 'GPU box', source: 'kiki',
  hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222,
};
/** Same id as a `~/.ssh/config` alias, so the alias is shadowed by this row. */
const SHADOWING_HOST: SshHost = { id: 'dev', name: 'Dev', source: 'kiki', roots: ['/home/dev/project'] };
const CONFIG_ALIAS: SshHost = { id: 'dev', name: 'dev', source: 'ssh-config' };

const FINGERPRINT = 'SHA256:qX7Lb3mV0pR2sT8uW4yZ1aC5dE9fG2hJ6kM3nP8qR1s';

const HOST_KEYS: Record<string, SshHostKeys> = {
  'gpu-box': {
    hostId: 'gpu-box', hostname: 'gpu.lab.example.com', port: 2222, label: '[gpu.lab.example.com]:2222',
    state: 'recorded',
    records: [
      { file: '/home/ubuntu/.ssh/known_hosts', line: 12, hostPattern: '[gpu.lab.example.com]:2222',
        algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT, status: 'recorded' },
      { file: '/home/ubuntu/.ssh/known_hosts', line: 41, hostPattern: 'gpu.lab.example.com',
        algorithm: 'ssh-rsa', fingerprint: 'SHA256:tY4nB7vC1xZ9mL2kQ5wE8rT3yU6iO0pA4sD7fG1hJ3k', status: 'recorded' },
    ],
    files: [{ path: '/home/ubuntu/.ssh/known_hosts', state: 'read' }],
  },
  staging: {
    hostId: 'staging', hostname: 'staging.example.com', port: 22, label: 'staging.example.com',
    state: 'recorded',
    records: [
      { file: '/home/deploy/.ssh/known_hosts', line: 4, hostPattern: 'staging.example.com', algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:W9kL2mN4pQ6rS8tU0vW2xY4zA6bC8dE0fG2hI4jK6lM', marker: '@revoked', status: 'revoked' },
    ],
    files: [{ path: '/home/deploy/.ssh/known_hosts', state: 'read' }],
  },
  dev: {
    hostId: 'dev', hostname: 'dev', port: 22, label: 'dev', state: 'unrecorded', records: [],
    files: [{ path: '/home/dev/.ssh/known_hosts', state: 'read' }, { path: '/etc/ssh/ssh_known_hosts', state: 'missing' }],
  },
  'prod-db': {
    hostId: 'prod-db', hostname: 'db-01.internal.example.com', port: 22, label: 'db-01.internal.example.com',
    state: 'unavailable', records: [],
    files: [{ path: '/srv/keys/ssh hosts', state: 'unavailable', reason: 'ambiguous-known-hosts-paths' },
      { path: '~/.ssh/known_hosts', state: 'unavailable', reason: 'ambiguous-known-hosts-paths' }],
  },
  'build-runner': {
    hostId: 'build-runner', hostname: 'build-runner', port: 22, label: 'build-runner', state: 'unavailable',
    records: [{ file: '/home/ci/.ssh/known_hosts', line: 3, hostPattern: 'build-runner', algorithm: 'ssh-rsa',
      marker: '@cert-authority', status: 'unsupported', reason: 'unsupported-marker:@cert-authority' }],
    files: [{ path: '/home/ci/.ssh/known_hosts', state: 'read' }],
  },
  'pi-lab': {
    hostId: 'pi-lab', hostname: 'pi-lab.local', port: 22, label: 'pi-lab.local', state: 'unavailable',
    records: [{ file: '/home/pi/.ssh/known_hosts', line: 8, hostPattern: 'pi-lab.local', algorithm: 'ssh-ed25519',
      status: 'invalid', reason: 'invalid-public-key' }],
    files: [{ path: '/home/pi/.ssh/known_hosts', state: 'read' }],
  },
};

const writeText = vi.fn(async () => undefined);

const ssh = {
  list: vi.fn(async () => ({ hosts: [] as SshHost[] })),
  discover: vi.fn(async () => ({ hosts: [] as SshHost[] })),
  status: vi.fn(async (id: string) => ({ hostId: id, state: 'idle', generation: 1 })),
  configSync: vi.fn(async (): Promise<SshConfigSyncSettings> => ({ enabled: false, source: 'home' })),
  setConfigSync: vi.fn(async (enabled: boolean): Promise<SshConfigSyncSettings> => ({ enabled, source: 'home' })),
  connectionApproval: vi.fn(async () => ({ enabled: true })),
  setConnectionApproval: vi.fn(async (enabled: boolean) => ({ enabled })),
  hostKeys: vi.fn(async (id: string): Promise<SshHostKeys> => {
    const found = HOST_KEYS[id];
    if (found === undefined) throw new Error('Unknown SSH host');
    return found;
  }),
};

const connection = {
  client: {
    meta: vi.fn(async () => ({ experimental_flags: { native_ssh: true } })),
    klient: { rest: { ssh } },
  },
};

vi.mock('../../state/connection', () => ({
  useConnection: () => connection,
  useOptionalConnection: () => connection,
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', clipboard: { writeText } });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const fn of Object.values(ssh)) fn.mockClear();
  connection.client.meta.mockClear();
  writeText.mockClear();
  ssh.list.mockResolvedValue({ hosts: [] });
  ssh.discover.mockResolvedValue({ hosts: [] });
  ssh.configSync.mockResolvedValue({ enabled: false, source: 'home' });
  ssh.setConfigSync.mockImplementation(async (enabled: boolean) => ({ enabled, source: 'home' }));
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderSection(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <SshSection />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (element === null) throw new Error('nothing to click');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

const syncInput = (container: HTMLElement) => container.querySelector('[data-ssh-sync] input[type="checkbox"]');
const syncSwitch = (container: HTMLElement) => container.querySelector('[data-ssh-sync] [role="switch"]');
const syncChecked = (container: HTMLElement) => (syncInput(container) as HTMLInputElement | null)?.checked;
const body = (container: HTMLElement) => container.textContent ?? '';

/** Expand a row's host-key panel: the toggle is the one action that reads files. */
async function openKeys(container: HTMLElement, hostId: string): Promise<void> {
  await click(container.querySelector(`[data-ssh-host-row="${hostId}"] [data-ssh-host-keys-toggle]`));
  await flush();
}

describe('config sync switch', () => {
  it('draws no switch while the stored value is still arriving', async () => {
    ssh.configSync.mockImplementation(() => new Promise(() => {}));
    const container = await renderSection();

    expect(syncInput(container)).toBeNull();
    expect(body(container)).toContain('Reading the saved setting…');
  });

  it('shows off for an install with no hosts at all', async () => {
    ssh.configSync.mockResolvedValue({ enabled: false, source: 'default' });
    const container = await renderSection();

    expect(syncSwitch(container)?.getAttribute('aria-checked')).toBe('false');
    expect(syncChecked(container)).toBe(false);
    expect(body(container)).toContain('Not set anywhere yet; on by default.');
  });

  it('keeps the stored off value when every config alias is shadowed', async () => {
    ssh.list.mockResolvedValue({ hosts: [SHADOWING_HOST] });
    ssh.discover.mockResolvedValue({ hosts: [CONFIG_ALIAS] });
    const container = await renderSection();

    expect(syncChecked(container)).toBe(false);
  });

  it('shows the value the server reports, not the one the lists suggest', async () => {
    ssh.list.mockResolvedValue({ hosts: [{ ...SHADOWING_HOST, source: 'ssh-config' }] });
    ssh.discover.mockResolvedValue({ hosts: [CONFIG_ALIAS] });
    ssh.configSync.mockResolvedValue({ enabled: false, source: 'home' });
    const container = await renderSection();

    expect(syncChecked(container)).toBe(false);
  });

  it('offers the retry instead of a switch when the read fails', async () => {
    ssh.configSync.mockRejectedValueOnce(new Error('boom'));
    const container = await renderSection();

    expect(syncInput(container)).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read whether config sync is on.');

    ssh.configSync.mockResolvedValue({ enabled: true, source: 'home' });
    await click(container.querySelector('[data-ssh-sync-retry]'));
    expect(syncChecked(container)).toBe(true);
  });

  it('writes through the server and shows the value it read back', async () => {
    const container = await renderSection();
    expect(syncChecked(container)).toBe(false);

    ssh.setConfigSync.mockResolvedValue({ enabled: true, source: 'home' });
    await click(syncInput(container));

    expect(ssh.setConfigSync).toHaveBeenCalledWith(true);
    expect(syncChecked(container)).toBe(true);
    expect(ssh.configSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the last stored value when the write fails', async () => {
    ssh.configSync.mockResolvedValue({ enabled: true, source: 'home' });
    const container = await renderSection();
    ssh.setConfigSync.mockRejectedValue(new Error('boom'));

    await click(syncInput(container));

    expect(syncChecked(container)).toBe(true);
    expect(container.querySelector('[data-ssh-sync] [role="alert"]')?.textContent).toContain('boom');
  });
});

describe('host key entries', () => {
  it('reads nothing until the row asks, then lists each entry with its source', async () => {
    ssh.list.mockResolvedValue({ hosts: [KIKI_HOST] });
    const container = await renderSection();

    // Expanding a row is a local view change: the panel is not open yet.
    expect(ssh.hostKeys).not.toHaveBeenCalled();
    expect(container.querySelector('[data-ssh-host-keys]')).toBeNull();

    await openKeys(container, 'gpu-box');

    expect(ssh.hostKeys).toHaveBeenCalledTimes(1);
    expect(ssh.hostKeys).toHaveBeenCalledWith('gpu-box');
    const panel = container.querySelector('[data-ssh-host-keys]');
    expect(panel?.getAttribute('data-state')).toBe('recorded');
    expect(panel?.querySelector('[data-ssh-host-key-label]')?.textContent).toBe('[gpu.lab.example.com]:2222');
    const rows = panel?.querySelectorAll('[data-ssh-host-key-record]') ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0]?.querySelector('[data-ssh-host-key-fingerprint]')?.textContent).toBe(FINGERPRINT);
    expect(rows[0]?.textContent).toContain('/home/ubuntu/.ssh/known_hosts:12');
    // A match in a local file is not a verified or unchanged key.
    expect(panel?.textContent).toContain('The host itself is not contacted.');
    expect(panel?.textContent).not.toContain('safe');
  });

  it('copies a public fingerprint and says so', async () => {
    ssh.list.mockResolvedValue({ hosts: [KIKI_HOST] });
    const container = await renderSection();
    await openKeys(container, 'gpu-box');

    await click(container.querySelector('[data-ssh-host-key-copy]'));

    expect(writeText).toHaveBeenCalledWith(FINGERPRINT);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Fingerprint copied.');
  });

  it('shows an empty answer as no local record, with the files it looked in', async () => {
    ssh.list.mockResolvedValue({ hosts: [{ ...KIKI_HOST, id: 'dev', name: 'Dev', hostname: undefined }] });
    const container = await renderSection();
    await openKeys(container, 'dev');

    const panel = container.querySelector('[data-ssh-host-keys]');
    expect(panel?.getAttribute('data-state')).toBe('unrecorded');
    expect(panel?.textContent).toContain('No entry for this host in the known_hosts files on this computer.');
    const files = panel?.querySelectorAll('[data-ssh-host-key-file]') ?? [];
    expect(files.length).toBe(2);
    expect(files[0]?.textContent).toContain('/home/dev/.ssh/known_hosts');
    expect(files[1]?.textContent).toContain('/etc/ssh/ssh_known_hosts');
  });

  it('separates revoked, unsupported and invalid entries from a clean one', async () => {
    ssh.list.mockResolvedValue({ hosts: [
      { ...KIKI_HOST, id: 'staging', name: 'Staging' },
      { ...KIKI_HOST, id: 'build-runner', name: 'Build runner' },
      { ...KIKI_HOST, id: 'pi-lab', name: 'Pi lab' },
    ] });
    const container = await renderSection();

    await openKeys(container, 'staging');
    expect(container.querySelector('[data-ssh-host-row="staging"] [data-ssh-host-key-record]')?.getAttribute('data-status')).toBe('revoked');
    expect(container.querySelector('[data-ssh-host-row="staging"] [data-ssh-host-keys]')?.textContent)
      .toContain('This entry is marked revoked (@revoked); a connection that matches it is refused.');

    await openKeys(container, 'build-runner');
    const unsupported = container.querySelector('[data-ssh-host-row="build-runner"] [data-ssh-host-keys]');
    expect(unsupported?.querySelector('[data-ssh-host-key-record]')?.getAttribute('data-status')).toBe('unsupported');
    expect(unsupported?.textContent).toContain('This entry trusts a certificate authority (@cert-authority)');

    await openKeys(container, 'pi-lab');
    const invalid = container.querySelector('[data-ssh-host-row="pi-lab"] [data-ssh-host-keys]');
    expect(invalid?.querySelector('[data-ssh-host-key-record]')?.getAttribute('data-status')).toBe('invalid');
    expect(invalid?.textContent).toContain('The public key in this entry cannot be parsed');
    expect(invalid?.textContent).toContain('Fingerprint unavailable');
  });

  it('explains an undecidable known_hosts location instead of denying a record', async () => {
    ssh.list.mockResolvedValue({ hosts: [{ ...KIKI_HOST, id: 'prod-db', name: 'Production database' }] });
    const container = await renderSection();
    await openKeys(container, 'prod-db');

    const panel = container.querySelector('[data-ssh-host-keys]');
    expect(panel?.getAttribute('data-state')).toBe('unavailable');
    expect(panel?.textContent).toContain('Which known_hosts file this host uses cannot be determined');
    expect(panel?.textContent).not.toContain('No entry for this host');
    const files = Array.from(panel?.querySelectorAll('[data-ssh-host-key-file]') ?? []);
    expect(files.map((file) => file.textContent).join(' ')).toContain('/srv/keys/ssh hosts');
  });

  it('keeps one host’s entries when another host is opened', async () => {
    ssh.list.mockResolvedValue({ hosts: [KIKI_HOST, { ...KIKI_HOST, id: 'dev', name: 'Dev' }] });
    const container = await renderSection();

    await openKeys(container, 'gpu-box');
    await openKeys(container, 'dev');

    const gpu = container.querySelector('[data-ssh-host-row="gpu-box"] [data-ssh-host-keys]');
    const dev = container.querySelector('[data-ssh-host-row="dev"] [data-ssh-host-keys]');
    expect(gpu?.getAttribute('data-state')).toBe('recorded');
    expect(dev?.getAttribute('data-state')).toBe('unrecorded');
    expect(gpu?.textContent).toContain(FINGERPRINT);
  });

  it('offers the retry in place when the read fails', async () => {
    ssh.list.mockResolvedValue({ hosts: [KIKI_HOST] });
    ssh.hostKeys.mockRejectedValue(new Error('Unknown SSH host'));
    const container = await renderSection();
    await openKeys(container, 'gpu-box');

    const panel = container.querySelector('[data-ssh-host-keys]');
    expect(panel?.getAttribute('data-state')).toBe('error');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('Could not read the host key entries');

    ssh.hostKeys.mockResolvedValue(HOST_KEYS['gpu-box']!);
    await click(container.querySelector('[data-ssh-host-keys-retry]'));
    expect(container.querySelector('[data-ssh-host-keys]')?.getAttribute('data-state')).toBe('recorded');
  });
});
