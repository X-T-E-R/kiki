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
import type { CapabilityStatus, KikiConfigPatch, KikiConfigResponse } from '../../lib/client';
import { ComputerControlSection } from './ComputerControlSection';

const connection = { scopeId: 'local', sshLabel: null as string | null };

const env = vi.fn(async () => ({
  platform: 'win32', arch: 'x64', homeDir: 'C:\\Users\\fixture',
}));
const getCapability = vi.fn<() => Promise<CapabilityStatus>>();
const installCapability = vi.fn(async () => CAPABILITY);
const revealSecret = vi.fn(async () => ({ value: 'revealed' }));
const getConfig = vi.fn<() => Promise<KikiConfigResponse>>();
const patchConfig = vi.fn(async (_patch: KikiConfigPatch) => ({}) as KikiConfigResponse);
const setComputerControlEnabled = vi.fn(async (_enabled: boolean) => ({ computer_control: { enabled: _enabled } }) as unknown as KikiConfigResponse);
const mcpList = vi.fn<() => Promise<readonly McpManagedServer[]>>();
const mcpAdd = vi.fn(async (_input: { server: Record<string, unknown> }) => [] as readonly McpManagedServer[]);
const mcpUpdate = vi.fn(async (_input: { server: Record<string, unknown> }) => [] as readonly McpManagedServer[]);
const mcpRemove = vi.fn(async (_input: { name: string }) => [] as readonly McpManagedServer[]);
const mcpTest = vi.fn(async (_target: unknown) => ({ success: true, output: '5 tools' }));
const mcpStop = vi.fn(async (_target: { name: string }) => ({ state: 'unconfirmed' as const, output: 'still running' }));
const memoryRequest = vi.fn<(_method: 'GET' | 'POST', _path: string, _options?: { body?: unknown }) => Promise<unknown>>();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: { getCapability, installCapability, revealSecret, getConfig, patchConfig, setComputerControlEnabled, memoryRequest },
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

async function settleUntil(selector: string, text?: string) {
  for (let i = 0; i < 60; i++) {
    const node = container.querySelector(selector);
    if (node !== null && (text === undefined || (node.textContent?.includes(text) ?? false))) return;
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
  throw new Error(text === undefined ? `Timed out waiting for ${selector}` : `Timed out waiting for ${selector} to contain ${text}`);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function preferenceConfig(
  usagePreference: 'avoid' | 'prefer',
  usagePreferenceSource: NonNullable<KikiConfigResponse['computer_control']>['usagePreferenceSource'],
): KikiConfigResponse {
  return { providers: {}, computer_control: { usagePreference, usagePreferenceSource, appliesOn: 'next-model-request' } };
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
  getConfig.mockResolvedValue({} as KikiConfigResponse);
  patchConfig.mockImplementation(async (patch) => ({
    computer_control: {
      usagePreference: patch.computer_control?.usage_preference ?? 'avoid',
      usagePreferenceSource: patch.computer_control?.usage_preference === null ? 'default' : 'home',
    },
  }) as KikiConfigResponse);
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
    await act(async () => { setInput('[data-computer-name-input]', 'renamed-computer'); });
    await settle();

    // Detail replaces the list on desktop too; pressing back asks the dirty guard.
    expect(query('[data-computer-connection="second-computer"]')).toBeNull();
    await click('[data-computer-back]');
    expect(asked).toEqual([reported.at(-1)]);
    // Still the edited draft, not the list.
    expect(query<HTMLInputElement>('[data-computer-name-input]')?.value).toBe('renamed-computer');

    await act(async () => { pending[0]?.(); });
    await settle();
    expect(query('[data-computer-connection="second-computer"]')).not.toBeNull();
    await click('[data-computer-connection="second-computer"]');
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

    await click('[data-settings-discard^="computer-control:"]');
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
    expect(query('[data-settings-draft^="computer-control:"]')?.hasAttribute('hidden')).toBe(false);

    await click('[data-settings-draft^="computer-control:"] button');
    expect(mcpUpdate).toHaveBeenCalledTimes(1);
    const written = mcpUpdate.mock.calls[0]?.[0] as { server: { name: string; command: string; args?: string[]; executor?: string } };
    expect(written.server.name).toBe('kiki-computer');
    expect(written.server.command).toBe(edited);
    expect(written.server.args).toEqual(['mcp']);
    expect(written.server.executor).toBe('local');
    // Read back from the echo, and the bar closes because the draft matches.
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe(edited);
    expect(query('[data-settings-draft^="computer-control:"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the draft when the write fails', async () => {
    mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
    mcpUpdate.mockRejectedValue(new Error('config is read-only'));

    await render();
    await settleUntil('[data-computer-connection="kiki-computer"]');
    await click('[data-computer-connection="kiki-computer"]');

    setInput('[data-computer-command-input]', 'C:\\other\\cua-driver.exe');
    await settle();
    await click('[data-settings-draft^="computer-control:"] button');

    expect(query('[data-feedback-tone="error"]')?.textContent).toContain('config is read-only');
    expect(query<HTMLInputElement>('[data-computer-command-input]')?.value).toBe('C:\\other\\cua-driver.exe');
    expect(query('[data-settings-draft^="computer-control:"]')?.hasAttribute('hidden')).toBe(false);
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
    expect(query('[data-settings-draft^="computer-control:"]')).toBeNull();
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

    await click('[data-settings-draft^="computer-control:"] button');
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
    const macEnv = deferred<{ platform: string; arch: string }>();
    env.mockReturnValue(macEnv.promise as never);
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
    const pendingPlatform = query('[data-computer-platform]')?.textContent ?? '';
    expect(pendingPlatform).not.toContain('Windows');
    expect(pendingPlatform).not.toContain('The server reported no platform');
    await act(async () => { macEnv.resolve({ platform: 'darwin', arch: 'arm64' }); });
    await settleUntil('[data-computer-platform]', 'macOS · arm64');
    expect(query('[data-computer-platform]')?.textContent).toContain('macOS · arm64');
  });

  it('reads effective default avoidance preference and displays default source without touching install or MCP', async () => {
    getConfig.mockResolvedValue({} as KikiConfigResponse);

    await render();
    await settleUntil('[data-computer-preference-choice="avoid"]');

    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('default');
    expect(query('[data-computer-preference-reset]')).toBeNull();
    expect(query('[data-settings-draft="computer-preference"]')).toBeNull();
    expect(installCapability).not.toHaveBeenCalled();
    expect(mcpAdd).not.toHaveBeenCalled();
  });

  it('switches to prefer immediately via POST patchConfig, echoing new value and updating source', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    } as KikiConfigResponse);
    patchConfig.mockResolvedValue({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'home' },
    } as KikiConfigResponse);

    await render();
    await settleUntil('[data-computer-preference-choice="prefer"]');

    await click('[data-computer-preference-choice="prefer"]');

    expect(patchConfig).toHaveBeenCalledWith({
      computer_control: { usage_preference: 'prefer' },
    });
    expect(installCapability).not.toHaveBeenCalled();

    // Cache updated from echo, source updated to home
    expect(queries.getQueryData(['config', 'local'])).toEqual({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'home' },
    });
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('home');
    expect(query('[data-computer-preference-reset]')).not.toBeNull();
    expect(query('[data-saved-tick]')).not.toBeNull();
  });

  it('restores inherited default when home override is active via null patch', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'home' },
    } as KikiConfigResponse);
    patchConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    } as KikiConfigResponse);

    await render();
    await settleUntil('[data-computer-preference-reset]');

    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('home');
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('true');

    await click('[data-computer-preference-reset]');

    expect(patchConfig).toHaveBeenCalledWith({
      computer_control: { usage_preference: null },
    });
    expect(installCapability).not.toHaveBeenCalled();

    // Echo applied: avoids, default source, reset button disappears, cache updated
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('default');
    expect(query('[data-computer-preference-reset]')).toBeNull();
    expect(queries.getQueryData(['config', 'local'])).toEqual({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    });
  });

  it('rolls back to stored preference and displays error on patch failure without claiming success', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    } as KikiConfigResponse);
    patchConfig.mockRejectedValue(new Error('Network error'));

    await render();
    await settleUntil('[data-computer-preference-choice="prefer"]');

    await click('[data-computer-preference-choice="prefer"]');

    expect(patchConfig).toHaveBeenCalledWith({
      computer_control: { usage_preference: 'prefer' },
    });
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(query('[data-feedback-tone="error"]')?.textContent).toContain('Network error');
    expect(query('[data-saved-tick]')).toBeNull();
    expect(installCapability).not.toHaveBeenCalled();
    // Cache remains unchanged
    expect(queries.getQueryData(['config', 'local'])).toEqual({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    });
  });

  it('disables preference choices and displays notice when overridden by higher source (env)', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'env' },
    } as KikiConfigResponse);

    await render();
    await settleUntil('[data-computer-preference-choice="avoid"]');

    expect(query<HTMLButtonElement>('[data-computer-preference-choice="avoid"]')?.disabled).toBe(true);
    expect(query<HTMLButtonElement>('[data-computer-preference-choice="prefer"]')?.disabled).toBe(true);
    expect(query('[data-computer-preference-override-notice]')).not.toBeNull();
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('env');
    expect(query('[data-computer-preference-reset]')).toBeNull();
  });

  it('reports failed config fetch without falling back to default or avoid and retries successfully', async () => {
    getConfig.mockRejectedValue(new Error('config service unavailable'));

    await render();
    await settleUntil('[data-computer-preference-state="failed"]');

    expect(query('[data-computer-preference-choice="avoid"]')).toBeNull();
    expect(query('[data-computer-preference-choice="prefer"]')).toBeNull();
    expect(query('[data-computer-preference-source]')).toBeNull();
    expect(container.textContent).toContain('config service unavailable');
    expect(query('[data-computer-preference-retry]')).not.toBeNull();
    // Machine, installation and MCP sections remain completely independent
    expect(query('[data-computer-platform]')?.textContent).toContain('Windows · x64');
    expect(query('[data-computer-state="not_installed"]')).not.toBeNull();

    // Now resolve successfully and click retry
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'preset' },
    } as KikiConfigResponse);

    await click('[data-computer-preference-retry]');
    await settleUntil('[data-computer-preference-choice="prefer"]');

    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('preset');
  });

  it('restores inheritance with null patch adopting non-default inherited prefer choice', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'home' },
    } as KikiConfigResponse);
    patchConfig.mockResolvedValue({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'preset' },
    } as KikiConfigResponse);

    await render();
    await settleUntil('[data-computer-preference-reset]');

    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('home');
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');

    await click('[data-computer-preference-reset]');

    expect(patchConfig).toHaveBeenCalledWith({
      computer_control: { usage_preference: null },
    });
    // Adopts echoed prefer from preset inheritance
    expect(query('[data-computer-preference-choice="prefer"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('preset');
    expect(query('[data-computer-preference-reset]')).toBeNull();
    expect(queries.getQueryData(['config', 'local'])).toEqual({
      computer_control: { usagePreference: 'prefer', usagePreferenceSource: 'preset' },
    });
  });

  it('updates the original scope cache without ending another scope’s in-flight save', async () => {
    const localSave = deferred<KikiConfigResponse>();
    const remoteSave = deferred<KikiConfigResponse>();
    getConfig.mockResolvedValue(preferenceConfig('avoid', 'default'));
    patchConfig.mockImplementationOnce(() => localSave.promise).mockImplementationOnce(() => remoteSave.promise);
    await render();
    await click('[data-computer-preference-choice="prefer"]');

    connection.scopeId = 'ssh:office-mac';
    getConfig.mockResolvedValue(preferenceConfig('prefer', 'base'));
    await render();
    await settleUntil('[data-computer-preference-source="base"]');
    await click('[data-computer-preference-choice="avoid"]');
    expect(patchConfig).toHaveBeenCalledTimes(2);

    const localEcho = preferenceConfig('prefer', 'home');
    await act(async () => { localSave.resolve(localEcho); });
    await settle();
    expect(queries.getQueryData(['config', 'local'])).toEqual(localEcho);
    expect(queries.getQueryData(['config', 'ssh:office-mac'])).toEqual(preferenceConfig('prefer', 'base'));
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(query<HTMLButtonElement>('[data-computer-preference-choice="avoid"]')?.disabled).toBe(true);
    expect(query('[data-saved-tick]')).toBeNull();

    await act(async () => { remoteSave.resolve(preferenceConfig('avoid', 'home')); });
    await settle();
    expect(query<HTMLButtonElement>('[data-computer-preference-choice="avoid"]')?.disabled).toBe(false);
    expect(query('[data-saved-tick]')).not.toBeNull();
  });

  it.each(['save', 'reset'] as const)('rejects late same-scope %s success after returning and saving a newer choice', async (oldAction) => {
    const oldRequest = deferred<KikiConfigResponse>();
    const newRequest = deferred<KikiConfigResponse>();
    getConfig.mockResolvedValue(preferenceConfig('avoid', 'home'));
    patchConfig.mockImplementationOnce(() => oldRequest.promise).mockImplementationOnce(() => newRequest.promise);
    await render();
    if (oldAction === 'save') {
      await click('[data-computer-preference-choice="prefer"]');
    } else {
      await click('[data-computer-preference-reset]');
    }
    connection.scopeId = 'ssh:remote';
    await render();
    connection.scopeId = 'local';
    await render();
    await act(async () => { queries.setQueryData(['config', 'local'], preferenceConfig('prefer', 'home')); });
    await settle();
    await click('[data-computer-preference-choice="avoid"]');
    expect(patchConfig).toHaveBeenNthCalledWith(2, { computer_control: { usage_preference: 'avoid' } });
    const newest = preferenceConfig('avoid', 'home');
    await act(async () => { newRequest.resolve(newest); });
    await settle();
    expect(query('[data-saved-tick]')).not.toBeNull();
    expect(query<HTMLButtonElement>('[data-computer-preference-choice="avoid"]')?.disabled).toBe(false);

    await act(async () => { oldRequest.resolve(preferenceConfig('prefer', oldAction === 'reset' ? 'base' : 'home')); });
    await settle();
    expect(queries.getQueryData(['config', 'local'])).toEqual(newest);
    expect(query('[data-computer-preference-source]')?.getAttribute('data-computer-preference-source')).toBe('home');
    expect(query('[data-computer-preference-choice="avoid"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps newer same-scope cache data when an older save succeeds', async () => {
    const save = deferred<KikiConfigResponse>();
    getConfig.mockResolvedValue(preferenceConfig('avoid', 'default'));
    patchConfig.mockImplementationOnce(() => save.promise);
    await render();
    await click('[data-computer-preference-choice="prefer"]');
    const newer = preferenceConfig('avoid', 'base');
    await act(async () => { queries.setQueryData(['config', 'local'], newer); });
    await act(async () => { save.resolve(preferenceConfig('prefer', 'home')); });
    await settle();
    expect(queries.getQueryData(['config', 'local'])).toEqual(newer);
    expect(query('[data-computer-preference-source="base"]')).not.toBeNull();
  });

  it('may update its original cache after unmount without creating a saved UI timer', async () => {
    const save = deferred<KikiConfigResponse>();
    getConfig.mockResolvedValue(preferenceConfig('avoid', 'default'));
    patchConfig.mockImplementationOnce(() => save.promise);
    await render();
    await click('[data-computer-preference-choice="prefer"]');
    await act(async () => { root.render(<></>); });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const echo = preferenceConfig('prefer', 'home');
    try {
      await act(async () => { save.resolve(echo); });
      expect(queries.getQueryData(['config', 'local'])).toEqual(echo);
      expect(container.childElementCount).toBe(0);
      expect(timer.mock.calls.some(([, delay]) => delay === 2500)).toBe(false);
    } finally {
      timer.mockRestore();
    }
  });

  it('drops stale deferred patch error when scope switches or returns to same scope', async () => {
    getConfig.mockResolvedValue({
      computer_control: { usagePreference: 'avoid', usagePreferenceSource: 'default' },
    } as KikiConfigResponse);

    let rejectPatch!: (reason: Error) => void;
    patchConfig.mockImplementation(() => new Promise((_, reject) => {
      rejectPatch = reject;
    }));

    await render();
    await settleUntil('[data-computer-preference-choice="prefer"]');

    await click('[data-computer-preference-choice="prefer"]');

    // Switch scope away and then back to local
    connection.scopeId = 'ssh:remote';
    await act(async () => {
      root.render(
        <QueryClientProvider client={queries}>
          <I18nProvider>
            <MemoryRouter>
              <ComputerControlSection />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    connection.scopeId = 'local';
    await act(async () => {
      root.render(
        <QueryClientProvider client={queries}>
          <I18nProvider>
            <MemoryRouter>
              <ComputerControlSection />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settleUntil('[data-computer-preference-choice="avoid"]');

    // Now reject the stale deferred patch
    await act(async () => {
      rejectPatch(new Error('Stale write failure'));
    });
    await settle();

    // Feedback error must NOT be shown for the stale generation
    expect(query('[data-feedback-tone="error"]')).toBeNull();
    expect(container.textContent).not.toContain('Stale write failure');
  });

  describe('Computer control master switch and tool policy', () => {
    it('renders master enabled card, toggles switch calling client contract, and retains components on disable', async () => {
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });
      getCapability.mockResolvedValue(CAPABILITY);
      mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);

      await render();
      await settleUntil('[data-computer-control-enabled]');

      const card = query('[data-computer-control-enabled]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-computer-control-enabled')).toBe('true');

      const toggleBtn = query<HTMLButtonElement>('[data-computer-enabled-switch]');
      expect(toggleBtn).not.toBeNull();
      expect(toggleBtn?.getAttribute('aria-checked')).toBe('true');

      // Toggle switch to off
      await act(async () => {
        toggleBtn?.click();
      });
      await settle();

      expect(setComputerControlEnabled).toHaveBeenCalledWith(false);

      // Verify components and MCP connections are NOT deleted when turned off
      expect(query('#st-card-computer-setup')).not.toBeNull();
      expect(query('#st-card-computer-mcp')).not.toBeNull();
    });

    it('displays explicit tool policy denied message in verdict when tools disable computer', async () => {
      getConfig.mockResolvedValue({
        providers: {},
        tools: { disabled: ['mcp__kiki-computer__*'] },
        computer_control: { enabled: true, enabledSource: 'default', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      } as unknown as KikiConfigResponse);
      getCapability.mockResolvedValue(CAPABILITY);
      mcpList.mockResolvedValue([]);

      await render();
      await settleUntil('[data-computer-control-enabled]');

      const denied = query('[data-computer-verdict="tool_denied"]');
      expect(denied).not.toBeNull();
      expect(denied?.textContent).toContain('Computer control tools are denied by tool policy.');
    });

    it('displays partial policy notice when only specific computer tools are disabled', async () => {
      getConfig.mockResolvedValue({
        providers: {},
        tools: { disabled: ['mcp__kiki-computer__click'] },
        computer_control: { enabled: true, enabledSource: 'default', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      } as unknown as KikiConfigResponse);
      getCapability.mockResolvedValue(CAPABILITY);
      mcpList.mockResolvedValue([]);

      await render();
      await settleUntil('[data-computer-control-enabled]');

      expect(query('[data-computer-toolpolicy-denied]')).toBeNull();
      const partial = query('[data-computer-toolpolicy-partial]');
      expect(partial).not.toBeNull();
      expect(partial?.textContent).toContain('Some computer control tools are denied by tool policy.');
    });

    it('switches active computer connection between CUA default and Windows-MCP 0.8.8 without auto-installing, and shows foreground lease notice', async () => {
      const windowsConfig = {
        transport: 'stdio' as const,
        command: 'C:\\Env\\venv\\Scripts\\python.exe',
        args: ['-m', 'windows_mcp', 'serve', '--transport', 'stdio', '--config', 'C:\\Env\\config.toml', '--tools', 'ControlStatus,DisplayInventory,Screenshot,Snapshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,App'],
        executor: 'local' as const,
        envKeys: ['ANONYMIZED_TELEMETRY', 'WINDOWS_MCP_WATCHDOG'],
      };
      mcpList.mockResolvedValue([
        managedEntry({ name: 'kiki-computer' }),
        managedEntry({ name: 'kiki-windows-mcp', config: windowsConfig as never }),
      ]);
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });
      patchConfig.mockImplementation(async (patch) => ({
        providers: {},
        computer_control: {
          enabled: true,
          enabledSource: 'default',
          usagePreference: 'avoid',
          usagePreferenceSource: 'default',
          appliesOn: 'next-model-request',
          toolsApplyOn: 'next-step',
          ...(patch.computer_control?.connection ? { connection: patch.computer_control.connection, connectionSource: 'home' as const } : {}),
        },
      }));

      await render();
      await settleUntil('[data-computer-active-connection]');

      expect(query('[data-computer-connection="kiki-computer"]')?.getAttribute('data-computer-connection-kind')).toBe('cua');
      expect(query('[data-computer-connection="kiki-windows-mcp"]')?.getAttribute('data-computer-connection-kind')).toBe('windows-mcp');
      expect(query('[data-computer-active-windows-mcp-hint]')).toBeNull();
      // Default CUA path with bundled CUA not installed reports not_installed and offers Install executor.
      expect(query('[data-computer-verdict="not_installed"]')).not.toBeNull();
      expect(query('[data-computer-install-btn]')).not.toBeNull();

      await click('[data-computer-active-connection] button');
      await act(async () => {
        [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((option) => option.textContent?.includes('kiki-windows-mcp'))?.click();
      });
      await settle();

      expect(patchConfig).toHaveBeenCalledWith({ computer_control: { connection: 'kiki-windows-mcp' } });
      expect(installCapability).not.toHaveBeenCalled();
      expect(query('[data-computer-active-windows-mcp-hint]')?.textContent).toContain('interactive desktop');
      // Selecting a serve-ready Windows-MCP connection reports ready without prompting to install bundled CUA.
      expect(query('[data-computer-verdict="ready"]')?.textContent).toContain('uses kiki-windows-mcp');
      expect(query('[data-computer-install-btn]')).toBeNull();

      await click('[data-computer-active-connection] button');
      await act(async () => {
        [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((option) => option.textContent?.includes('CUA default'))?.click();
      });
      await settle();

      expect(patchConfig).toHaveBeenCalledWith({ computer_control: { connection: null } });
      expect(query('[data-computer-verdict="not_installed"]')).not.toBeNull();
    });

    it('derives the verdict from the selected connection and its executor (missing, disabled, non-ready Windows-MCP, and MCP list failure)', async () => {
      const windowsReadyConfig = {
        transport: 'stdio' as const,
        command: 'C:\\Env\\venv\\Scripts\\python.exe',
        args: ['-m', 'windows_mcp', 'serve', '--transport', 'stdio', '--config', 'C:\\Env\\config.toml', '--tools', 'ControlStatus,DisplayInventory,Screenshot,Snapshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,App'],
        executor: 'local' as const,
        envKeys: ['ANONYMIZED_TELEMETRY', 'WINDOWS_MCP_WATCHDOG'],
      };
      const windowsNotReadyConfig = {
        ...windowsReadyConfig,
        args: ['-m', 'windows_mcp', 'serve'],
      };

      // 1. Selected connection is missing from MCP entries while CUA files are installed → no_connection (never ready)
      getCapability.mockResolvedValue(READY);
      mcpList.mockResolvedValue([managedEntry({ name: 'kiki-computer' })]);
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', connection: 'missing-computer', connectionSource: 'home', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });

      await render();
      await settleUntil('[data-computer-verdict="no_connection"]');
      expect(query('[data-computer-verdict="ready"]')).toBeNull();

      // 2. Selected CUA entry has enabled: false while CUA files are installed → connection_not_ready (never ready)
      mcpList.mockResolvedValue([
        managedEntry({ name: 'kiki-computer', config: { ...CUA_CONFIG, enabled: false } }),
      ]);
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', connection: 'kiki-computer', connectionSource: 'home', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });
      await act(async () => {
        await queries.invalidateQueries({ queryKey: ['config', 'local'] });
        await queries.invalidateQueries({ queryKey: ['computer-control-mcp', 'local'] });
      });
      await settleUntil('[data-computer-verdict="connection_not_ready"]');
      expect(query('[data-computer-verdict="ready"]')).toBeNull();

      // 3. Selected Windows-MCP entry is not serve-ready while bundled CUA is not installed → connection_not_ready (no CUA install prompt)
      getCapability.mockResolvedValue(CAPABILITY);
      mcpList.mockResolvedValue([
        managedEntry({ name: 'kiki-windows-mcp', config: windowsNotReadyConfig as never }),
      ]);
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', connection: 'kiki-windows-mcp', connectionSource: 'home', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });
      await act(async () => {
        await queries.invalidateQueries({ queryKey: ['capability', 'kiki-computer', 'local'] });
        await queries.invalidateQueries({ queryKey: ['config', 'local'] });
        await queries.invalidateQueries({ queryKey: ['computer-control-mcp', 'local'] });
      });
      await settleUntil('[data-computer-active-windows-mcp-not-ready]');
      expect(query('[data-computer-verdict="connection_not_ready"]')).not.toBeNull();
      expect(query('[data-computer-install-btn]')).toBeNull();

      // 4. MCP list read failure while CUA files are installed → unknown (never ready)
      getCapability.mockResolvedValue(READY);
      mcpList.mockRejectedValue(new Error('mcp list failed'));
      getConfig.mockResolvedValue({
        providers: {},
        computer_control: { enabled: true, enabledSource: 'default', usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request', toolsApplyOn: 'next-step' },
      });
      await act(async () => {
        await queries.invalidateQueries({ queryKey: ['capability', 'kiki-computer', 'local'] });
        await queries.invalidateQueries({ queryKey: ['config', 'local'] });
        await queries.invalidateQueries({ queryKey: ['computer-control-mcp', 'local'] });
      });
      await settleUntil('[data-computer-verdict="unknown"]');
      expect(query('[data-computer-verdict="ready"]')).toBeNull();
      expect(query('[data-computer-retry]')).not.toBeNull();
    });

    it('registers an external Windows-MCP 0.8.8 environment on Windows without auto-starting or auto-selecting', async () => {
      memoryRequest.mockImplementation(async (method, path, options) => {
        if (method === 'GET' && path === '/computer/windows-mcp') {
          return {
            id: 'windows-mcp',
            version: '0.8.8',
            commit: 'b74c507d9e709223a0904cf08019edf55f2a75bb',
            python: '>=3.14',
            wheelSha256: '597ef720e1902ba76510a4d2b946949f8a48f281dd210c183de5ded60ea3b873',
            wheelBytes: 257859,
            distribution: 'external-environment',
            managedInstall: 'withheld-until-gpl-acceptance',
            bundled: false,
            autoStart: false,
            connection: 'kiki-windows-mcp',
            licenses: [
              { name: 'windows-mcp', license: 'MIT' },
              { name: 'fuzzywuzzy', license: 'GPL-2.0-only' },
              { name: 'python-Levenshtein', license: 'GPL-2.0-or-later' },
            ],
            closureLock: 'windows-mcp-0.8.8.lock',
            note: 'External Windows-MCP 0.8.8 environment',
          };
        }
        if (method === 'POST' && path === '/computer/windows-mcp/register') {
          expect(options?.body).toEqual({
            python: 'C:\\Env\\venv\\Scripts\\python.exe',
            configPath: 'C:\\Env\\config.toml',
            version: '0.8.8',
          });
          return {
            result: 'mcp-configured',
            name: 'kiki-windows-mcp',
            connection: 'kiki-windows-mcp',
            started: false,
            bundled: false,
          };
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      });

      await render();
      await settleUntil('[data-computer-windows-mcp-register]');

      const details = query<HTMLDetailsElement>('[data-computer-windows-mcp-register]');
      expect(details).not.toBeNull();
      await act(async () => {
        details!.open = true;
        details!.dispatchEvent(new Event('toggle'));
      });
      await settleUntil('[data-computer-windows-mcp-plan]');
      expect(query('[data-computer-windows-mcp-plan]')?.textContent).toContain('Windows-MCP v0.8.8');

      await act(async () => {
        setInput('[data-computer-windows-mcp-python]', 'C:\\Env\\venv\\Scripts\\python.exe');
        setInput('[data-computer-windows-mcp-config]', 'C:\\Env\\config.toml');
      });
      await settle();

      await click('[data-computer-windows-mcp-submit]');
      expect(memoryRequest).toHaveBeenCalledWith('POST', '/computer/windows-mcp/register', {
        body: {
          python: 'C:\\Env\\venv\\Scripts\\python.exe',
          configPath: 'C:\\Env\\config.toml',
          version: '0.8.8',
        },
      });
      expect(patchConfig).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Registered as kiki-windows-mcp');
    });
  });
});
