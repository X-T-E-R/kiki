import { describe, expect, it, vi } from 'vitest';
import type { CloudflareStatus } from '@kiki/protocol';
import { createCloudflareConnection, cloudflareConnectionAddress, type ExternalConnectionClient } from './externalConnections';

const status: CloudflareStatus = {
  schemaVersion: 1, dependency: { state: 'ready', path: 'cloudflared', version: '2026.10.0', installable: true },
  account: { certificate: false, apiToken: false },
  configuration: { mode: 'token', tunnelId: '', configPath: '', tokenFile: '', credentialsFile: '', certificatePath: '/fixture/cert.pem', publicUrl: 'https://service.example.test', accountId: '', cloudflaredPath: '', autoStart: true, tokenConfigured: false },
  service: { state: 'unconfigured', ready: false, manualStop: false, retryCount: 0 }, login: { state: 'idle' },
};

function fixture() {
  const info = {
    id: 'kiki-cloudflare', displayName: 'Cloudflare Tunnel', enabled: true, state: 'ok' as const,
    skillCount: 0, mcpServerCount: 0, enabledMcpServerCount: 0, hookCount: 0, commandCount: 0,
    hasErrors: false, source: 'local-path' as const, originalSource: '/fixture/source', root: '/fixture/managed',
    installedAt: '', mcpServers: [], diagnostics: [],
  };
  const plan = { id: info.id, fingerprint: '0'.repeat(64), changes: [], consentRequired: true, contributions: [], contextTokens: 0, unsupported: [] };
  const panelBridge = vi.fn(async () => ({ result: status }));
  const plugins = {
    marketplace: vi.fn(async () => ({ configured: true, entries: [] })),
    preview: vi.fn(async () => plan), install: vi.fn(async () => info), info: vi.fn(async () => info),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    installPrerequisite: vi.fn(async () => ({ ok: true as const })), panelBridge,
  };
  const client: ExternalConnectionClient = { global: { plugins: { list: vi.fn(async () => [info]) } }, rest: { plugins } };
  return { client, plugins, plan, info, api: createCloudflareConnection(client) };
}

describe('Cloudflare external connection', () => {
  it('reads the installed source without depending on marketplace and never sends a session', async () => {
    const f = fixture();
    expect(await f.api.read()).toMatchObject({ state: 'available', source: '/fixture/source', status });
    expect(f.plugins.marketplace).not.toHaveBeenCalled();
    expect(f.plugins.panelBridge).toHaveBeenCalledWith('kiki-cloudflare', 'cloudflare', { method: 'plugin.call', action: 'status', args: {} });
    expect(cloudflareConnectionAddress(status)).toEqual({ url: 'https://service.example.test/', source: 'user-configured', reachability: 'unverified' });
  });

  it('uses lifecycle handlers and omits secrets unless explicitly provided', async () => {
    const f = fixture();
    await f.api.configure({ autoStart: false });
    await f.api.start(); await f.api.stop(); await f.api.setAutoStart(true);
    expect(f.plugins.panelBridge.mock.calls).toEqual([
      ['kiki-cloudflare', 'cloudflare', { method: 'plugin.call', action: 'configure', args: { values: { autoStart: false } } }],
      ['kiki-cloudflare', 'cloudflare', { method: 'plugin.call', action: 'start', args: {} }],
      ['kiki-cloudflare', 'cloudflare', { method: 'plugin.call', action: 'stop', args: {} }],
      ['kiki-cloudflare', 'cloudflare', { method: 'plugin.call', action: 'configure', args: { values: { autoStart: true } } }],
    ]);
  });

  it('rejects invalid response and propagates real service failures', async () => {
    const f = fixture();
    f.plugins.panelBridge.mockResolvedValueOnce({ result: { ...status, service: { state: 'online' } } as unknown as CloudflareStatus });
    await expect(f.api.status()).rejects.toThrow();
    f.plugins.panelBridge.mockRejectedValueOnce(new Error('App plugin lifecycle is not enabled in this Kiki build'));
    await expect(f.api.status()).rejects.toThrow('App plugin lifecycle');
  });

  it('installs only after a reviewed plan and prerequisite consent', async () => {
    const f = fixture();
    await expect(f.api.installDependency(false as true)).rejects.toThrow('Install');
    expect(f.plugins.installPrerequisite).not.toHaveBeenCalled();
    const plan = await f.api.previewInstall('/fixture/source');
    await f.api.install({ source: '/fixture/source', plan, consent: true });
    expect(f.plugins.install).toHaveBeenCalledWith({ source: '/fixture/source', fingerprint: plan.fingerprint, consent: true });
    expect(f.plugins.setEnabled).toHaveBeenCalledWith('kiki-cloudflare', true);
    await f.api.installDependency(true);
    expect(f.plugins.installPrerequisite).toHaveBeenCalledWith('kiki-cloudflare', { id: 'cloudflared', consent: true });
  });

  it('does not turn an unavailable catalog or disabled plugin into an online connection', async () => {
    const f = fixture();
    f.client.global.plugins.list = async () => [];
    expect(await f.api.read()).toEqual({ state: 'not-installed', catalog: undefined });
    f.plugins.marketplace.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(f.api.read()).rejects.toThrow('catalog unavailable');
    f.info.enabled = false;
    f.client.global.plugins.list = async () => [f.info];
    expect(await f.api.read()).toMatchObject({ state: 'disabled', source: '/fixture/source' });
    expect(f.plugins.panelBridge).not.toHaveBeenCalled();
  });
});
