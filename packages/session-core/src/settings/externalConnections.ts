import type { Klient, HttpRestFacade, HttpRestPluginMarketplaceEntry } from '@kiki/klient';
import {
  cloudflareStatusSchema, cloudflareSettingsPatchSchema, cloudflareTunnelsSchema,
  cloudflareAccountsSchema, cloudflareSetupSchema,
  type CloudflareStatus, type CloudflareSettingsPatch, type PluginInstallPlan,
} from '@kiki/protocol';

export const CLOUDFLARE_PLUGIN_ID = 'kiki-cloudflare';
export const CLOUDFLARE_PANEL_ID = 'cloudflare';

export interface ExternalConnectionClient {
  readonly global: { readonly plugins: Pick<Klient['global']['plugins'], 'list'> };
  readonly rest?: { readonly plugins: Pick<HttpRestFacade['plugins'], 'marketplace' | 'preview' | 'install' | 'info' | 'setEnabled' | 'installPrerequisite' | 'panelBridge'> };
}

export type CloudflareConnectionSnapshot =
  | { readonly state: 'not-installed'; readonly catalog?: HttpRestPluginMarketplaceEntry }
  | { readonly state: 'disabled' | 'invalid'; readonly source: string; readonly version?: string; readonly errors: readonly string[] }
  | { readonly state: 'available'; readonly source: string; readonly version?: string; readonly status: CloudflareStatus };

export interface ExternalConnectionAddress {
  readonly url: string;
  readonly source: 'user-configured';
  readonly reachability: 'unverified';
}

/** A connector's readiness is not proof that its hostname, origin or KAP authentication is reachable. */
export function cloudflareConnectionAddress(status: CloudflareStatus): ExternalConnectionAddress | undefined {
  const value = status.configuration.publicUrl;
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Cloudflare returned an invalid public endpoint. Update its configuration.');
  return { url: url.href, source: 'user-configured', reachability: 'unverified' };
}

/** Uses the connected server's plugin manager and resident plugin backend; never creates a session. */
export function createCloudflareConnection(client: ExternalConnectionClient) {
  const plugins = client.rest?.plugins;
  if (plugins === undefined) throw new Error('External connection management requires an HTTP connection to Kiki.');
  const call = async (action: string, args: unknown = {}) => (await plugins.panelBridge(CLOUDFLARE_PLUGIN_ID, CLOUDFLARE_PANEL_ID, { method: 'plugin.call', action, args })).result;
  const status = async () => cloudflareStatusSchema.parse(await call('status'));
  const lifecycle = async (action: 'start' | 'stop' | 'login' | 'cancelLogin') => cloudflareStatusSchema.parse(await call(action));
  return {
    async read(): Promise<CloudflareConnectionSnapshot> {
      const installed = (await client.global.plugins.list()).find((item) => item.id === CLOUDFLARE_PLUGIN_ID);
      if (installed === undefined) {
        const catalog = (await plugins.marketplace()).entries.find((item) => item.id === CLOUDFLARE_PLUGIN_ID);
        return { state: 'not-installed', catalog };
      }
      const info = await plugins.info(CLOUDFLARE_PLUGIN_ID);
      const source = info.originalSource ?? info.root;
      if (info.state !== 'ok' || !info.enabled) return {
        state: info.state !== 'ok' ? 'invalid' : 'disabled', source, version: info.version,
        errors: info.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message),
      };
      return { state: 'available', source, version: info.version, status: await status() };
    },
    status,
    async previewInstall(source: string): Promise<PluginInstallPlan> {
      const plan = await plugins.preview({ source });
      if (plan.id !== CLOUDFLARE_PLUGIN_ID) throw new Error('The selected package is not the Cloudflare Tunnel plugin.');
      return plan;
    },
    async install(input: { source: string; plan: PluginInstallPlan; consent: true }) {
      if (input.consent !== true || input.plan.id !== CLOUDFLARE_PLUGIN_ID) throw new Error('Review and approve the Cloudflare plugin installation first.');
      const result = await plugins.install({ source: input.source, fingerprint: input.plan.fingerprint, consent: true });
      if (result.id !== CLOUDFLARE_PLUGIN_ID) throw new Error('The installed package is not the Cloudflare Tunnel plugin.');
      await plugins.setEnabled(CLOUDFLARE_PLUGIN_ID, true);
      return result;
    },
    async enable() { await plugins.setEnabled(CLOUDFLARE_PLUGIN_ID, true); return status(); },
    async installDependency(consent: true) {
      if (consent !== true) throw new Error('Choose Install to allow downloading cloudflared.');
      await plugins.installPrerequisite(CLOUDFLARE_PLUGIN_ID, { id: 'cloudflared', consent });
      return status();
    },
    async configure(values: CloudflareSettingsPatch) {
      return cloudflareStatusSchema.parse(await call('configure', { values: cloudflareSettingsPatchSchema.parse(values) }));
    },
    start: () => lifecycle('start'),
    stop: () => lifecycle('stop'),
    login: () => lifecycle('login'),
    cancelLogin: () => lifecycle('cancelLogin'),
    async setAutoStart(autoStart: boolean) { return cloudflareStatusSchema.parse(await call('configure', { values: { autoStart } })); },
    async tunnels() { return cloudflareTunnelsSchema.parse(await call('tunnels')); },
    async accounts() { return cloudflareAccountsSchema.parse(await call('accounts')); },
    async selectTunnel(id: string) { return cloudflareStatusSchema.parse(await call('selectTunnel', { id })); },
    async setup() { return cloudflareSetupSchema.parse(await call('setup')); },
  };
}

export type CloudflareConnection = ReturnType<typeof createCloudflareConnection>;
