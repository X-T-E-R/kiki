// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ExternalConnectionSection } from './ExternalConnectionSection';

const sha256 = 'b'.repeat(64);
const source = 'https://github.com/X-T-E-R/kiki-plugins/releases/download/plugins-cloudflare-20261010.1/kiki-cloudflare-0.1.1.zip';
const plan = {
  id: 'kiki-cloudflare',
  fingerprint: 'a'.repeat(64),
  changes: [],
  consentRequired: true,
  contributions: ['entry'],
  contextTokens: 0,
  unsupported: [],
  version: '0.1.1',
};
const info = { id: 'kiki-cloudflare', displayName: 'Cloudflare Tunnel', enabled: true, globalEnabled: true, state: 'ok' as const, version: '0.1.1' };
const list = vi.fn(async () => []);
const marketplace = vi.fn(async () => ({
  configured: true,
  entries: [{ id: 'kiki-cloudflare', tier: 'official' as const, displayName: 'Cloudflare Tunnel', source, sha256 }],
}));
const preview = vi.fn(async () => plan);
const install = vi.fn(async () => info);
const plugins = {
  marketplace,
  preview,
  install,
  info: vi.fn(async () => info),
  setEnabled: vi.fn(async () => ({ ok: true as const })),
  installPrerequisite: vi.fn(async () => ({ ok: true as const })),
  panelBridge: vi.fn(async () => ({ result: {} })),
};
const requestApiJson = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const client: {
  klient: { global: { plugins: { list: typeof list } }; rest: { plugins: typeof plugins } };
  requestApiJson?: typeof requestApiJson;
} = { klient: { global: { plugins: { list } }, rest: { plugins } } };

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
}));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  list.mockClear();
  marketplace.mockClear();
  preview.mockClear();
  install.mockClear();
  requestApiJson.mockReset();
  delete client.requestApiJson;
  marketplace.mockResolvedValue({
    configured: true,
    entries: [{ id: 'kiki-cloudflare', tier: 'official' as const, displayName: 'Cloudflare Tunnel', source, sha256 }],
  });
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => { root.render(<I18nProvider><ExternalConnectionSection /></I18nProvider>); });
  return container;
}

describe('External connection Cloudflare install', () => {
  it('renders the market install and sends the published checksum', async () => {
    const container = await render();
    const button = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('[data-conn-ext-install]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(button.textContent).toContain('Install Cloudflare plugin');
    await act(async () => { button.click(); });
    await vi.waitFor(() => { expect(preview).toHaveBeenCalledWith({ source, sha256 }); });
    const confirm = document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]');
    expect(confirm).not.toBeNull();
    await act(async () => { confirm!.click(); });
    await vi.waitFor(() => {
      expect(install).toHaveBeenCalledWith({ source, sha256, fingerprint: plan.fingerprint, consent: true });
    });
  });

  it('says the market did not list Cloudflare instead of installing the bare id', async () => {
    marketplace.mockResolvedValue({ configured: true, entries: [] });
    const container = await render();
    const button = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('[data-conn-ext-install]');
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => { button.click(); });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('did not list Cloudflare');
    });
    expect(preview).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});

describe('External connection Encrypted Relay (kiki-relay)', () => {
  it('adds a kiki-relay:// share link and renders Home + Standby RTT status alongside reverse-proxy snippets', async () => {
    const emptyStatus = {
      schemaVersion: 1 as const,
      inboundEnabled: true,
      standbyNodeIds: [],
      nodes: [],
      subscriptions: [],
    };
    const populatedStatus = {
      schemaVersion: 1 as const,
      inboundEnabled: true,
      hostFingerprint: 'a'.repeat(64),
      homeNodeId: 'relay-hk',
      standbyNodeIds: ['relay-sg'],
      nodes: [
        {
          id: 'relay-hk',
          label: 'HK Edge',
          url: 'wss://relay-hk.example.com/relay',
          role: 'auto' as const,
          enabled: true,
          tokenConfigured: true,
          slot: 'home' as const,
          connected: true,
          rttMs: 18,
          publishedStreamUrl: `wss://relay-hk.example.com/relay/v1/stream?target=${'a'.repeat(64)}`,
        },
        {
          id: 'relay-sg',
          label: 'SG Backup',
          url: 'wss://relay-sg.example.com',
          role: 'auto' as const,
          enabled: true,
          tokenConfigured: false,
          subscriptionId: 'sub-team',
          slot: 'standby' as const,
          connected: true,
          rttMs: 41,
          publishedStreamUrl: `wss://relay-sg.example.com/v1/stream?target=${'a'.repeat(64)}`,
        },
      ],
      subscriptions: [
        {
          id: 'sub-team',
          url: 'https://team.example.com/relays.json',
          label: 'Lab Relays',
          enabled: true,
        },
      ],
    };

    requestApiJson
      .mockResolvedValueOnce(emptyStatus)
      .mockResolvedValueOnce(populatedStatus)
      .mockResolvedValueOnce(populatedStatus);
    client.requestApiJson = requestApiJson;

    const container = await render();
    const input = await vi.waitFor(() => {
      const found = container.querySelector<HTMLInputElement>('[data-conn-relay-input]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(container.querySelector('[data-conn-relay-empty]')?.textContent).toContain('No relay nodes configured');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'kiki-relay://relay-hk.example.com/relay?name=HK%20Edge&token=secret123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const addButton = container.querySelector<HTMLButtonElement>('[data-conn-relay-add]')!;
    await act(async () => { addButton.click(); });

    await vi.waitFor(() => {
      expect(requestApiJson).toHaveBeenCalledWith('POST', '/remote-connections/relays/nodes', {
        body: { uri: 'kiki-relay://relay-hk.example.com/relay?name=HK%20Edge&token=secret123' },
      });
      expect(container.querySelector('[data-conn-relay-node="relay-hk"]')?.textContent).toContain('18 ms');
      expect(container.querySelector('[data-conn-relay-node="relay-hk"]')?.textContent).toContain('Home');
      expect(container.querySelector('[data-conn-relay-node="relay-sg"]')?.textContent).toContain('Standby');
    });

    const nginxTab = container.querySelector<HTMLButtonElement>('[data-conn-relay-proxy-tab="nginx"]')!;
    await act(async () => { nginxTab.click(); });
    expect(container.querySelector('[data-conn-relay-deploy-proxy]')?.textContent).toContain('proxy_buffering off;');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'https://team.example.com/relays.json');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { addButton.click(); });
    await vi.waitFor(() => {
      expect(requestApiJson).toHaveBeenCalledWith('POST', '/remote-connections/relays/subscriptions', {
        body: { url: 'https://team.example.com/relays.json' },
      });
    });
  });
});
