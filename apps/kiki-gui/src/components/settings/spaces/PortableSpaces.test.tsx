// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PortableSpaceExportReceipt,
  PortableSpaceInspectResult,
  PortableSpacePreviewResult,
  PortableSpaceSourceRecord,
  PortableSpaceSourcesListResponse,
} from '@kiki/protocol';

import { HostProvider, type HostAdapter } from '../../../host';
import { I18nProvider } from '../../../i18n';
import * as clipboard from '../../../lib/clipboard';
import { KikiClient } from '../../../lib/client';
import { buildColabCommand, endpointCliArg, portableSpacesApi, type PortableSpacesApi } from '../../../lib/portableSpaces';
import { SettingsTransferCard } from '../settingsTransfer/SettingsTransferCard';
import { PortableSpacesCard } from './PortableSpacesCard';

const DEVICE_KEY = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const SOURCE_GIT: PortableSpaceSourceRecord = {
  id: 'src-git',
  label: 'Team Dotfiles',
  endpoint: { kind: 'git', repo: 'https://github.com/example/kiki-dotfiles.git', ref: 'main' },
  format: 'dir',
  spaceMode: 'full',
  secretMode: 'none',
  encryptionMode: 'none',
  gitBranch: 'main',
};

const SOURCE_AGE_A: PortableSpaceSourceRecord = {
  id: 'src-age-a',
  label: 'Workstation A',
  endpoint: { kind: 'archive', path: '/backups/workstation-a.kiki.age' },
  format: 'age',
  spaceMode: 'full',
  secretMode: 'sealed',
  encryptionMode: 'x25519',
};

const SOURCE_AGE_B: PortableSpaceSourceRecord = {
  id: 'src-age-b',
  label: 'Colab Overlay',
  endpoint: { kind: 'archive', path: '/backups/colab-overlay.kiki.age' },
  format: 'age',
  spaceMode: 'overlay',
  secretMode: 'sealed',
  encryptionMode: 'passphrase',
};

const SOURCE_DIR: PortableSpaceSourceRecord = {
  id: 'src-dir',
  label: 'Local Export',
  endpoint: { kind: 'dir', path: '/exports/local-space' },
  format: 'dir',
  spaceMode: 'full',
  secretMode: 'plain',
  encryptionMode: 'none',
};

const SOURCES_RESPONSE: PortableSpaceSourcesListResponse = {
  deviceRecipient: DEVICE_KEY,
  knownRecipients: [{ label: 'This device', recipient: DEVICE_KEY }],
  items: [SOURCE_GIT, SOURCE_AGE_A, SOURCE_AGE_B, SOURCE_DIR],
};

const INSPECT_AGE_A: PortableSpaceInspectResult = {
  endpoint: SOURCE_AGE_A.endpoint,
  label: SOURCE_AGE_A.label,
  format: 'age',
  spaceMode: 'full',
  secretMode: 'sealed',
  encryptionMode: 'x25519',
  recipients: [DEVICE_KEY],
  unset: [],
  domains: [
    { domain: 'config', count: 2 },
    { domain: 'skills', count: 1 },
  ],
  items: [
    {
      id: 'config:default_model',
      domain: 'config',
      path: 'default_model',
      label: 'Default model',
      summary: 'kimi-pro',
      scalarValue: 'kimi-pro',
    },
    {
      id: 'config:api_key',
      domain: 'config',
      path: 'providers.openai.api_key',
      label: 'OpenAI key',
      masked: true,
    },
    {
      id: 'skills:review',
      domain: 'skills',
      path: 'skills/review/SKILL.md',
      label: 'review',
      bytes: 1240,
    },
  ],
};

const PREVIEW_DIFF: PortableSpacePreviewResult = {
  previewToken: 'tok-preview-1',
  mode: 'sync',
  hasVerifiedBase: true,
  sourceLabels: ['Workstation A'],
  targetLabel: 'Main space',
  unchangedCount: 4,
  conflictCount: 1,
  dependencyErrors: [],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  rows: [
    {
      id: 'config:default_model',
      domain: 'config',
      path: 'default_model',
      label: 'Default model',
      change: 'conflict',
      direction: 'conflict',
      beforeSummary: 'kimi-lite',
      afterSummary: 'kimi-pro',
      selected: true,
    },
    {
      id: 'skills:review',
      domain: 'skills',
      path: 'skills/review/SKILL.md',
      label: 'review skill',
      change: 'only_left',
      direction: 'to_right',
      beforeSummary: null,
      afterSummary: '1.2 KB',
      selected: true,
    },
    {
      id: 'agents:local-only',
      domain: 'agents',
      path: 'agents/local.md',
      label: 'local agent',
      change: 'only_right',
      direction: 'to_left',
      beforeSummary: null,
      afterSummary: '0.8 KB',
      selected: true,
    },
    {
      id: 'mcp:blocked',
      domain: 'mcp',
      path: 'mcp.local-bin',
      label: 'Local MCP binary',
      change: 'modified',
      direction: 'none',
      beforeSummary: '/win/bin',
      afterSummary: '/mac/bin',
      selected: false,
      blockedReason: 'Local path differs on target',
    },
  ],
};

const SPACES = [
  { id: 'main', name: 'Main space', path: '/home/me/.kiki', primary: true, credentials_shared: true },
  { id: 'h-work', name: 'Work', path: '/home/me/.kiki-spaces/work', primary: false, credentials_shared: false },
];

const hostMock = {
  kind: 'tauri' as const,
  pickDirectory: vi.fn<() => Promise<string | null>>(async () => null),
};

const apiMocks: Record<keyof PortableSpacesApi, ReturnType<typeof vi.fn>> = {
  listSources: vi.fn(),
  registerSource: vi.fn(),
  removeSource: vi.fn(),
  inspect: vi.fn(),
  exportSpace: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  pack: vi.fn(),
  unpack: vi.fn(),
  fork: vi.fn(),
  mutate: vi.fn(),
  rekey: vi.fn(),
};

const fakeClient = {
  baseUrl: 'http://127.0.0.1:58627',
  portableSpaces: apiMocks as unknown as PortableSpacesApi,
} as unknown as KikiClient;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', platform: 'Linux', userAgent: 'Linux' });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  apiMocks.listSources.mockResolvedValue(SOURCES_RESPONSE);
  apiMocks.inspect.mockResolvedValue(INSPECT_AGE_A);
  apiMocks.preview.mockResolvedValue(PREVIEW_DIFF);
  apiMocks.apply.mockResolvedValue({
    mode: 'sync',
    appliedIds: ['config:default_model', 'skills:review'],
    skippedIds: [],
    deletedIds: [],
    restartRequired: false,
  });
  apiMocks.removeSource.mockResolvedValue({ removed: true });
  apiMocks.exportSpace.mockResolvedValue({
    destination: '/home/me/kiki-exports/main-space.kiki.age',
    format: 'age',
    spaceMode: 'full',
    secretMode: 'sealed',
    encryptionMode: 'passphrase',
    domains: [{ domain: 'config', count: 3 }],
    totalItems: 3,
  } satisfies PortableSpaceExportReceipt);
  apiMocks.fork.mockResolvedValue({
    destination: '/home/me/kiki-exports/workstation-a-overlay',
    format: 'dir',
    spaceMode: 'overlay',
    secretMode: 'sealed',
    encryptionMode: 'x25519',
    domains: [{ domain: 'config', count: 2 }],
    totalItems: 2,
  } satisfies PortableSpaceExportReceipt);
  apiMocks.registerSource.mockResolvedValue(SOURCE_GIT);
  apiMocks.pack.mockResolvedValue({
    destination: '/exports/local-space.kiki.age',
    format: 'age',
    spaceMode: 'full',
    secretMode: 'sealed',
    encryptionMode: 'x25519',
    domains: [{ domain: 'config', count: 2 }],
    totalItems: 2,
  } satisfies PortableSpaceExportReceipt);
  apiMocks.unpack.mockResolvedValue({
    destination: '/backups/workstation-a',
    format: 'dir',
    spaceMode: 'full',
    secretMode: 'sealed',
    encryptionMode: 'none',
    domains: [{ domain: 'config', count: 2 }],
    totalItems: 2,
  } satisfies PortableSpaceExportReceipt);
  apiMocks.mutate.mockResolvedValue({
    changed: true,
    appliedOps: 1,
    inspect: {
      ...INSPECT_AGE_A,
      items: INSPECT_AGE_A.items.map((item) =>
        item.id === 'config:default_model' ? { ...item, summary: 'kimi-ultra', scalarValue: 'kimi-ultra' } : item,
      ),
    },
  });
  apiMocks.rekey.mockResolvedValue({ ...INSPECT_AGE_A, encryptionMode: 'passphrase', recipients: [] });
  vi.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderNode(node: React.ReactNode, entries: string[] = ['/settings/spaces']) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={entries}>
        <HostProvider host={hostMock as unknown as HostAdapter}>
          <QueryClientProvider client={queryClient}>
            <I18nProvider>{node}</I18nProvider>
          </QueryClientProvider>
        </HostProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

async function click(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  expect(el, selector).not.toBeNull();
  await act(async () => { el!.click(); });
  await flush();
}

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(input, selector).not.toBeNull();
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PortableSpaces REST client', () => {
  it('sends bearer auth and validates envelopes against @kiki/protocol', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: SOURCES_RESPONSE, request_id: 'req-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const httpClient = new KikiClient({
      baseUrl: 'http://127.0.0.1:58627',
      token: 'secret-bearer',
      transport: { fetch: fetchMock, eventsUrl: 'ws://127.0.0.1:58627/api/ws' },
    });
    const list = await portableSpacesApi(httpClient).listSources();
    expect(list.deviceRecipient).toBe(DEVICE_KEY);
    expect(list.items).toHaveLength(4);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:58627/api/spaces/portable/sources');
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer secret-bearer');
    await httpClient.dispose();
  });

  it('generates Colab commands with --override, zero --yes, secret comment on single & stacked, and git subpath #HEAD', () => {
    expect(endpointCliArg({ kind: 'git', repo: 'https://github.com/example/dots.git', subpath: 'spaces/work' }))
      .toBe('https://github.com/example/dots.git#HEAD//spaces/work');

    const single = buildColabCommand({ source: SOURCE_AGE_A.endpoint });
    expect(single.split('\n')).toHaveLength(4);
    expect(single).toContain('# Set KIKI_AGE_PASSPHRASE (or KIKI_AGE_KEY) in Colab Secrets if encrypted');
    expect(single).toContain('curl -fsSL https://github.com/X-T-E-R/kiki/releases/latest/download/install.sh | sh -s --');
    expect(single).toContain("--apply '/backups/workstation-a.kiki.age'");
    expect(single).toContain('--override');
    expect(single).not.toContain('--yes');
    expect(single).not.toContain('passphrase=');

    const stacked = buildColabCommand({ source: SOURCE_GIT.endpoint, overlay: SOURCE_AGE_B.endpoint });
    expect(stacked.split('\n')).toHaveLength(5);
    expect(stacked).toContain('# Set KIKI_AGE_PASSPHRASE (or KIKI_AGE_KEY) in Colab Secrets if encrypted');
    expect(stacked).toContain("--apply 'https://github.com/example/kiki-dotfiles.git#main'");
    expect(stacked).toContain("--apply '/backups/colab-overlay.kiki.age'");
    expect(stacked).toContain('--override');
    expect(stacked).not.toContain('--yes');
  });
});

describe('PortableSpacesCard & workflows', () => {
  it('lists registered sources with kind and secret badges and removes a source from its menu', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    expect(document.querySelector('[data-portable-kind-badge="src-git"]')?.textContent).toBe('Git');
    expect(document.querySelector('[data-portable-secret-badge="src-git"]')?.textContent).toBe('No secrets');
    expect(document.querySelector('[data-portable-kind-badge="src-age-a"]')?.textContent).toBe('.kiki.age');
    expect(document.querySelector('[data-portable-secret-badge="src-age-a"]')?.textContent).toBe('Encrypted');
    expect(document.querySelector('[data-portable-kind-badge="src-age-b"]')?.textContent).toBe('Overlay');
    expect(document.querySelector('[data-portable-secret-badge="src-dir"]')?.textContent).toBe('Plaintext');

    await click('[data-portable-menu="src-git"]');
    await click('[data-space-menu-item="remove"]');
    expect(apiMocks.removeSource).toHaveBeenCalledWith('src-git');
  });

  it('shows a calm 1-line empty state when no sources are registered', async () => {
    apiMocks.listSources.mockResolvedValueOnce({ deviceRecipient: DEVICE_KEY, knownRecipients: [], items: [] });
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    expect(document.querySelector('[data-portable-empty]')?.textContent).toContain('.kiki.age');
    expect(document.querySelector('[data-settings-transfer-notices]')).toBeNull();
  });

  it('exports a passphrase-protected .kiki.age bundle with recent:5 sessions', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-portable-export-open]');
    await click('[data-portable-export-format="age"]');
    await click('[data-portable-secret-policy="passphrase"]');
    await type('[data-portable-export-passphrase]', 'colab-demo-pass');
    await click('[data-portable-sessions-choice="recent5"]');
    await click('[data-portable-export-submit]');

    expect(apiMocks.exportSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'live', spaceId: 'main' },
        format: 'age',
        spaceMode: 'full',
        secretMode: 'sealed',
        encryption: { mode: 'passphrase', passphrase: 'colab-demo-pass' },
        sessions: { mode: 'recent', count: 5 },
      }),
    );
  });

  it('links a Git repository source', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-portable-link-open]');
    await click('[data-portable-link-kind="git"]');
    await type('[data-portable-link-target]', 'https://github.com/example/kiki-dotfiles.git');
    await type('[data-portable-link-ref]', 'main');
    await type('[data-portable-link-label]', 'Team Dotfiles');
    await type('[data-portable-link-passphrase]', 'repo-cred-pass');
    await click('[data-portable-link-submit]');

    expect(apiMocks.registerSource).toHaveBeenCalledWith({
      endpoint: { kind: 'git', repo: 'https://github.com/example/kiki-dotfiles.git', ref: 'main', subpath: undefined },
      label: 'Team Dotfiles',
      unlock: { passphrase: 'repo-cred-pass' },
    });
  });

  it('inspects contents, mutates a scalar config value inline, and unpacks .kiki.age', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-detail-trigger="src-age-a"]');

    expect(document.querySelector('[data-portable-domain-row="config"]')).not.toBeNull();
    // Domain header should not echo the raw untranslated slug.
    expect(document.querySelector('[data-portable-domain-row="config"] > button')?.textContent).not.toContain('config');
    await click('[data-portable-item-edit="config:default_model"]');
    await type('[data-portable-item-edit-input="config:default_model"]', 'kimi-ultra');
    await click('[data-portable-item-edit-save="config:default_model"]');

    expect(apiMocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: SOURCE_AGE_A.endpoint,
        actions: [{ op: 'set', key: 'default_model', value: 'kimi-ultra' }],
      }),
    );

    // Structured non-file item removal uses unset with full item.id; file item removal uses rm.
    await click('[data-portable-item-remove="config:api_key"]');
    expect(apiMocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actions: [{ op: 'unset', key: 'config:api_key', recordOverlayUnset: false }],
      }),
    );

    await click('[data-portable-domain-row="skills"] > button');
    apiMocks.mutate.mockResolvedValueOnce({ changed: false, appliedOps: 0, inspect: INSPECT_AGE_A });
    await click('[data-portable-item-remove="skills:review"]');
    expect(apiMocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actions: [{ op: 'rm', paths: ['skills/review/SKILL.md'] }],
      }),
    );
    expect(document.body.textContent).toContain('No changes applied.');
    expect(document.body.textContent).not.toContain('Removed item.');

    await click('[data-portable-unpack-trigger]');
    await click('[data-portable-pack-submit]');
    expect(apiMocks.unpack).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'unpack',
        sourcePath: '/backups/workstation-a.kiki.age',
      }),
    );
  });

  it('hides inline mutation actions on read-only Git sources and resets detail unlock state on source switch', async () => {
    apiMocks.inspect
      .mockRejectedValueOnce(new Error('Passphrase required'))
      .mockResolvedValueOnce({ ...INSPECT_AGE_A, endpoint: SOURCE_GIT.endpoint, label: SOURCE_GIT.label, format: 'dir' });
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-detail-trigger="src-age-b"]');
    expect(document.querySelector('[data-portable-unlock-input]')).not.toBeNull();
    await type('[data-portable-unlock-input]', 'secret-b');

    // Switch to Git source in left rail -> detail remounts cleanly without leaking unlock state, and edit/remove are hidden.
    await click('[data-detail-rail-item="src-git"]');
    expect(document.querySelector('[data-portable-item-edit="config:default_model"]')).toBeNull();
    expect(document.querySelector('[data-portable-item-remove="config:default_model"]')).toBeNull();
  });

  it('supports passphrase sealing on plain folder export and sourceUnlock on fork', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-portable-menu="src-age-b"]');
    await click('[data-space-menu-item="fork"]');
    await type('[data-portable-source-unlock]', 'unlock-b');
    await click('[data-portable-dir-seal-enc="passphrase"]');
    await type('[data-portable-export-passphrase]', 'new-dir-pass');
    await click('[data-portable-export-submit]');

    expect(apiMocks.fork).toHaveBeenCalledWith(
      expect.objectContaining({
        source: SOURCE_AGE_B.endpoint,
        format: 'dir',
        secretMode: 'sealed',
        encryption: { mode: 'passphrase', passphrase: 'new-dir-pass' },
        sourceUnlock: { passphrase: 'unlock-b' },
      }),
    );
  });

  it('compares endpoints, resolves conflicts inline, shows blocked reason per row, and applies with previewToken', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-portable-compare="src-age-a"]');

    expect(apiMocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'sync',
        sources: [SOURCE_AGE_A.endpoint],
        target: { kind: 'live', spaceId: 'main' },
      }),
      expect.any(AbortSignal),
    );
    expect(document.querySelector('[data-portable-diff-blocked="mcp:blocked"]')?.textContent).toBe('Local path differs on target');
    expect(document.querySelector('[data-portable-unchanged-toggle]')?.textContent).toContain('4 unchanged');
    expect(document.querySelector('[data-portable-diff-row="config:default_model"] [data-portable-diff-direction]')?.getAttribute('data-portable-diff-direction')).toBe('conflict');
    expect(document.querySelector('[data-portable-diff-row="agents:local-only"] [data-portable-diff-direction]')?.getAttribute('data-portable-diff-direction')).toBe('to_left');

    // Resolve conflict inline to keep right side.
    await click('[data-portable-conflict-resolve="config:default_model"] [data-portable-conflict-side="right"]');
    await click('[data-portable-apply-submit]');

    expect(apiMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        previewToken: 'tok-preview-1',
        selectedIds: ['config:default_model', 'skills:review', 'agents:local-only'],
        resolutions: { 'config:default_model': 'right' },
        createBackup: true,
      }),
    );
  });

  it('supports comparing two portable archives (A.kiki.age vs B.kiki.age) with override mode', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-portable-compare="src-age-a"]');

    // Switch right endpoint to Colab Overlay (B.kiki.age), supply inline right unlock, and switch mode to override.
    await click('[data-portable-right-endpoint] button');
    const optionB = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes('Colab Overlay'),
    );
    expect(optionB).toBeDefined();
    await act(async () => { optionB!.click(); });
    await flush();
    await type('[data-portable-compare-unlock-right]', 'overlay-pass');
    await click('[data-portable-compare-unlock-right-submit]');
    await click('[data-portable-op-mode="override"]');

    expect(apiMocks.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'override',
        sources: [SOURCE_AGE_A.endpoint],
        target: SOURCE_AGE_B.endpoint,
        targetUnlock: { passphrase: 'overlay-pass' },
      }),
      expect.any(AbortSignal),
    );
  });

  it('renders Colab & keys tab, copies Colab command, and rekeys an archive', async () => {
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="/home/me/.kiki" />);
    await click('[data-detail-trigger="src-age-a"]');
    await click('[data-portable-tab="colab"]');

    expect(document.querySelector('[data-portable-device-recipient]')?.textContent).toBe(DEVICE_KEY);
    const command = document.querySelector('[data-portable-colab-command]')?.textContent ?? '';
    expect(command).toContain('curl -fsSL https://github.com/X-T-E-R/kiki/releases/latest/download/install.sh | sh -s --');
    await click('[data-portable-copy-colab]');
    expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(command);

    await click('[data-portable-rekey-mode="passphrase"]');
    await type('[data-portable-rekey-passphrase]', 'new-secret-pass');
    await click('[data-portable-rekey-submit]');
    expect(apiMocks.rekey).toHaveBeenCalledWith(
      expect.objectContaining({
        target: '/backups/workstation-a.kiki.age',
        encryption: { mode: 'passphrase', passphrase: 'new-secret-pass' },
      }),
    );
    // Subsequent rekey carries the newly set passphrase as unlock.
    await type('[data-portable-rekey-passphrase]', 'second-secret-pass');
    await click('[data-portable-rekey-submit]');
    expect(apiMocks.rekey).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: '/backups/workstation-a.kiki.age',
        unlock: { passphrase: 'new-secret-pass' },
        encryption: { mode: 'passphrase', passphrase: 'second-secret-pass' },
      }),
    );
  });
});

describe('SettingsTransferCard navigation replacement', () => {
  function LocationEcho() {
    const location = useLocation();
    return <output data-location>{location.pathname}{location.hash}</output>;
  }

  it('preserves #st-card-settings-transfer and navigates directly to /settings/spaces#st-card-portable-spaces', async () => {
    await renderNode(<><SettingsTransferCard /><LocationEcho /></>, ['/settings/general']);
    expect(document.querySelector('#st-card-settings-transfer')).not.toBeNull();
    await click('[data-settings-transfer-open]');
    expect(document.querySelector('[data-location]')?.textContent).toBe('/settings/spaces#st-card-portable-spaces');
  });
});
