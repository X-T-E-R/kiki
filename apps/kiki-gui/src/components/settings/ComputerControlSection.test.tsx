// @vitest-environment jsdom

/**
 * The gaps this page got wrong before are the ones worth pinning: a failed
 * read must not fall back to a fixture machine or a fake install, a save must
 * write the real config and read it back (keeping the draft when the write
 * fails), one connection's data must never appear under another scope, and an
 * unconfirmed stop must stay unconfirmed — no timer turns it green.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpManagedServer } from '@kiki/session-core/transport';
import { I18nProvider } from '../../i18n';
import { DirtyGuardContext, type DirtyGuardValue } from '../dirtyGuard';
import type { CapabilityStatus } from '../../lib/client';
import { ComputerControlSection } from './ComputerControlSection';

const connection = { scopeId: 'local', sshLabel: null as string | null };

const env = vi.fn(async () => ({
  platform: 'win32', arch: 'x64', homeDir: 'C:\\Users\\fixture',
}));
const getCapability = vi.fn<() => Promise<CapabilityStatus>>();
const installCapability = vi.fn(async () => CAPABILITY);
const revealSecret = vi.fn(async () => ({ value: 'revealed' }));
const mcpList = vi.fn<() => Promise<readonly McpManagedServer[]>>();
const mcpAdd = vi.fn(async (_input: { server: Record<string, unknown> }) => [] as readonly McpManagedServer[]);
const mcpUpdate = vi.fn(async (_input: { server: Record<string, unknown> }) => [] as readonly McpManagedServer[]);
const mcpRemove = vi.fn(async (_input: { name: string }) => [] as readonly McpManagedServer[]);
const mcpTest = vi.fn(async (_target: unknown) => ({ success: true, output: '5 tools' }));
const mcpStop = vi.fn(async (_target: { name: string }) => ({ state: 'unconfirmed' as const, output: 'still running' }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: { getCapability, installCapability, revealSecret },
    klient: { global: { env, mcp: { list: mcpList, add: mcpAdd, update: mcpUpdate, remove: mcpRemove, test: mcpTest, stop: mcpStop } } },
    scopeId: connection.scopeId,
    sshLabel: connection.sshLabel,
  }),
}));

const CAPABILITY: CapabilityStatus = {
  id: 'kiki-computer',
  displayName: 'Kiki Computer Control',
  description: 'Desktop observation and input via cua-driver stdio MCP',
  supported: true,
  state: 'not_installed',
  steps: [
    { id: 'binary', state: 'missing', detail: 'cua-driver not found' },
    { id: 'desktop-access', state: 'missing', detail: 'not checked', optional: true },
  ],
  plan: {
    artifact: {
      version: '0.32.0',
      url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/cua-driver-windows-x86_64.zip',
      sha256: '6d70b45c8c901db773010dd720c8bb9d58c59bb301e9891c58ca1d3860e75652',
      metadataUrl: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/meta.json',
      maxBytes: 50 * 1024 * 1024,
    },
    destination: 'C:\\Users\\fixture\\.kimi\\capabilities\\kiki-computer\\windows-x86_64\\cua-driver.exe',
    note: 'Open-source desktop executor',
  },
  install: { running: false },
};

const CUA_CONFIG = {
  transport: 'stdio' as const,
  command: 'C:\\Users\\fixture\\.kimi\\capabilities\\kiki-computer\\cua-driver.exe',
  args: ['mcp'],
  executor: 'local' as const,
};

/** What `getCapability` reports once the pinned executor files verified. */
const READY: CapabilityStatus = {
  ...CAPABILITY,
  state: 'ready',
  version: '0.32.0',
  steps: [
    { id: 'binary', state: 'ok', detail: 'C:\\Users\\fixture\\.kimi\\capabilities\\kiki-computer\\cua-driver.exe' },
    { id: 'mcp', state: 'ok', detail: 'Global MCP entry kiki-computer' },
    { id: 'desktop-access', state: 'missing', detail: 'Not checked during install', optional: true },
  ],
};

function managedEntry(patch: Partial<McpManagedServer> & { name: string }): McpManagedServer {
  return {
    name: patch.name,
    config: patch.config ?? CUA_CONFIG,
    source: patch.source ?? 'global',
    origin: patch.origin ?? 'C:/Users/fixture/.kimi/mcp.json',
    mutable: patch.mutable ?? true,
    ...(patch.plugin === undefined ? {} : { plugin: patch.plugin }),
  } as McpManagedServer;
}

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
}

async function settleUntil(selector: string) {
  for (let i = 0; i < 60; i++) {
    if (container.querySelector(selector) !== null) return;
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function render(guard?: DirtyGuardValue) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <I18nProvider>
          <MemoryRouter>
            {guard === undefined
              ? <ComputerControlSection />
              : (
                <DirtyGuardContext.Provider value={guard}>
                  <ComputerControlSection />
                </DirtyGuardContext.Provider>
              )}
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function query<T extends Element = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

async function click(selector: string) {
  const button = query<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`No element for ${selector}`);
  await act(async () => { button.click(); });
  await settle();
}

function setInput(selector: string, value: string) {
  const input = query<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (input === null) throw new Error(`No element for ${selector}`);
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  connection.scopeId = 'local';
  connection.sshLabel = null;
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  env.mockResolvedValue({ platform: 'win32', arch: 'x64', homeDir: 'C:\\Users\\fixture' } as never);
  getCapability.mockResolvedValue(CAPABILITY);
  installCapability.mockResolvedValue(READY);
  mcpList.mockResolvedValue([]);
  mcpAdd.mockResolvedValue([]);
  mcpUpdate.mockResolvedValue([]);
  mcpRemove.mockResolvedValue([]);
  mcpTest.mockResolvedValue({ success: true, output: '5 tools' });
  mcpStop.mockResolvedValue({ state: 'unconfirmed', output: 'still running' });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ComputerControlSection', () => {
  it('reports a failed detection instead of inventing a machine or an install', async () => {
    getCapability.mockRejectedValue(new Error('capability service unavailable'));

    await render();
    await settleUntil('[data-computer-state="failed"]');

    expect(container.textContent).not.toContain('workstation-win11');
    expect(query('[data-computer-machine-name]')).toBeNull();
    expect(query('[data-computer-install-btn]')).toBeNull();
    expect(query('[data-computer-retry]')).not.toBeNull();
    // The machine line is the server's own answer, and it survives B failing.
    expect(query('[data-computer-platform]')?.textContent).toContain('Windows · x64');
  });

  it('installs only from the real plan, behind its digest', async () => {
    await render();
    await settleUntil('[data-computer-install-btn]');
    expect(query('[data-computer-install-btn]')?.textContent).toContain('Install executor');

    await click('[data-computer-install-btn]');
    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain(CAPABILITY.plan!.artifact.sha256);
    expect(dialog).toContain(CAPABILITY.plan!.destination);

    await click('[data-confirm-action="confirm"]');
    expect(installCapability).toHaveBeenCalledWith('kiki-computer', CAPABILITY.plan!.artifact.sha256);
  });

  it('tells a macOS user where the desktop permission has to be granted', async () => {
    env.mockResolvedValue({ platform: 'darwin', arch: 'arm64' } as never);
    getCapability.mockResolvedValue(READY);

    await render();
    await settleUntil('[data-computer-state="ready"]');
    expect(container.textContent).toContain('grant them where the driver reports they are missing');

    // Windows and Linux carry no such note: the question is macOS-only.
    await act(async () => { root.unmount(); });
    container.remove();
    env.mockResolvedValue({ platform: 'win32', arch: 'x64' } as never);
    queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await render();
    await settleUntil('[data-computer-state="ready"]');
    expect(container.textContent).not.toContain('grant them where the driver reports they are missing');
  });

  it('asks before replacing a connection that has unsaved edits', async () => {    mcpList.mockResolvedValue([
      managedEntry({ name: 'kiki-computer' }),
      managedEntry({ name: 'second-computer', config: { ...CUA_CONFIG, command: 'C:\\Users\\fixture\\bin\\cua-driver.exe' } }),
    ]);
    // The guard App owns only prompts for an id a reporter registered, so the
    // ask has to carry the draft footer's own id.
    const reported: string[] = [];
    const asked: string[] = [];
    const pending: (() => void)[] = [];
    const guard: DirtyGuardValue = {
      dirty: false,
      reportDirty: (id) => { reported.push(id); },
      navigate: () => undefined,
      confirmDiscard: (id, action) => { asked.push(id); pending.push(action); },
    };

    await render(guard);
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');
    setInput('[data-computer-name-input]', 'renamed-computer');
    await settle();

    await click('[data-computer-connection="second-computer"]');
    expect(asked).toEqual([reported.at(-1)]);
    // Still the edited draft, not the other connection.
    expect(query<HTMLInputElement>('[data-computer-name-input]')?.value).toBe('renamed-computer');

    await act(async () => { pending[0]?.(); });
    await settle();
    expect(query<HTMLInputElement>('[data-computer-name-input]')?.value).toBe('second-computer');
  });

  it('lets the draft footer discard without asking the guard again', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    const asked: string[] = [];
    const guard: DirtyGuardValue = {
      dirty: false,
      reportDirty: () => undefined,
      navigate: () => undefined,
      confirmDiscard: (id) => { asked.push(id); },
    };

    await render(guard);
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');
    setInput('[data-computer-command-input]', 'C:\\Users\\fixture\\other\\cua-driver.exe');
    await settle();

    await click('[data-settings-discard]');
    expect(asked).toEqual([]);
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe(CUA_CONFIG.command);
  });

  it('lists computer connections only, and reads the selected one back from the server', async () => {
    mcpList.mockResolvedValue([
      managedEntry({ name: 'kiki-computer' }),
      managedEntry({ name: 'fixture-fs', config: { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] } }),
    ]);

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    expect(query('[data-computer-connection="fixture-fs"]')).toBeNull();

    await click('[data-computer-connection="kiki-computer"]');
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe(CUA_CONFIG.command);
    expect(query<HTMLTextAreaElement>('[data-computer-args-input]')?.value).toBe('mcp');
    expect(query('[data-computer-executor]')?.dataset['computerExecutor']).toBe('local');
  });

  it('saves through the MCP API and adopts what the server echoed back', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    const edited = 'C:\\Users\\fixture\\bin\\cua-driver.exe';
    mcpUpdate.mockResolvedValue([
      managedEntry({ name: 'kiki-computer', config: { ...CUA_CONFIG, command: edited } }),
    ]);

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');

    setInput('[data-computer-command-input]', edited);
    await settle();
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(false);

    await click('[data-settings-draft] button');
    expect(mcpUpdate).toHaveBeenCalledTimes(1);
    const written = mcpUpdate.mock.calls[0]?.[0] as { server: { name: string; command: string; args?: string[]; executor?: string } };
    expect(written.server.name).toBe('kiki-computer');
    expect(written.server.command).toBe(edited);
    expect(written.server.args).toEqual(['mcp']);
    expect(written.server.executor).toBe('local');
    // Read back from the echo, and the bar closes because the draft matches.
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe(edited);
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the draft when the write fails', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    mcpUpdate.mockRejectedValue(new Error('config is read-only'));

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');

    setInput('[data-computer-command-input]', 'C:\\other\\cua-driver.exe');
    await settle();
    await click('[data-settings-draft] button');

    expect(query('[data-feedback-tone="error"]')?.textContent).toContain('config is read-only');
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe('C:\\other\\cua-driver.exe');
    expect(query('[data-settings-draft]')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows what the service reported for a stop, and never upgrades it on a timer', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    mcpStop.mockResolvedValue({ state: 'unconfirmed', output: 'could not confirm; configuration was disabled' });

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-stop-btn]');
    await click('[data-confirm-action="confirm"]');

    expect(mcpStop).toHaveBeenCalledWith({ name: 'kiki-computer' });
    expect(query('[data-computer-stop-result="unconfirmed"]')?.textContent).toContain('could not confirm; configuration was disabled');
    expect(container.textContent).not.toContain('Stopped the cua processes');

    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 700); }); });
    expect(query('[data-computer-stop-result="unconfirmed"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Stopped the cua processes');
  });

  it('keeps a read-only entry read-only, with its source link and no fake editor', async () => {
    mcpList.mockResolvedValue([
      managedEntry({
        name: 'plugin-computer',
        mutable: false,
        source: 'plugin',
        plugin: { id: 'desktop-pack', name: 'Desktop Pack' },
      }),
    ]);

    await render();
    await settleUntil('[data-computer-connection="plugin-computer"]');
    await click('[data-computer-connection="plugin-computer"]');

    expect(query<HTMLInputElement>('[data-computer-command-input]')?.closest('fieldset')?.disabled).toBe(true);
    expect(query('[data-settings-draft]')).toBeNull();
    expect(query('[data-computer-plugin-link]')?.getAttribute('href')).toBe('/capabilities?tab=plugins&plugin=desktop-pack');
    // Stopping is still offered: it stops this process's instance, it does not
    // rewrite the read-only source.
    expect(query('[data-computer-stop-btn]')).not.toBeNull();
  });

  it('creates a connection from the install plan and the server platform', async () => {
    env.mockResolvedValue({ platform: 'darwin', arch: 'arm64', homeDir: '/Users/fixture' } as never);
    mcpList.mockResolvedValue([]);
    mcpAdd.mockResolvedValue([managedEntry({ name: 'kiki-computer', config: { ...CUA_CONFIG, command: CAPABILITY.plan!.destination, args: ['mcp', '--direct'] } })]);

    await render();
    await settleUntil('[data-computer-new]');
    await click('[data-computer-new]');

    expect(query<HTMLInputElement>('[data-computer-name-input]')?.value).toBe('kiki-computer');
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe(CAPABILITY.plan!.destination);
    expect(query<HTMLTextAreaElement>('[data-computer-args-input]')?.value).toBe('mcp\n--direct');
    expect(query('[data-computer-executor]')?.dataset['computerExecutor']).toBe('local');

    await click('[data-settings-draft] button');
    expect(mcpAdd.mock.calls[0]?.[0]).toMatchObject({
      server: { name: 'kiki-computer', args: ['mcp', '--direct'], executor: 'local', command: CAPABILITY.plan!.destination },
    });
  });

  it('never shows one scope\u2019s connections under another', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    env.mockResolvedValue({ platform: 'win32', arch: 'x64' } as never);

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    expect(query('[data-computer-platform]')?.textContent).toContain('Windows · x64');

    connection.scopeId = 'ssh:office-mac';
    mcpList.mockResolvedValue([managedEntry({ name: 'office-mac-computer' })]);
    env.mockResolvedValue({ platform: 'darwin', arch: 'arm64' } as never);
    await act(async () => { root.render(
      <QueryClientProvider client={queries}>
        <I18nProvider>
          <MemoryRouter>
            <ComputerControlSection />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    ); });
    await settleUntil('[data-computer-connection="office-mac-computer"]');

    expect(query('[data-computer-connection="kiki-computer"]')).toBeNull();
    expect(query('[data-computer-platform]')?.textContent).toContain('macOS · arm64');
  });
});
