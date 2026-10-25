import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../../i18n';
import { connectionAddress } from '../../../lib/remoteConnections';
import { useConnection } from '../../../state/connection';
import { useInstalledPlugins, usePluginMarketplace, usePluginPanels } from '../../capabilities/usePlugins';

export function cloudflareDestination(installed: boolean, catalogued: boolean, panelReady: boolean): string | undefined {
  if (!installed && !catalogued) return undefined;
  return panelReady ? '/capabilities?plugin=kiki-cloudflare&panel=kiki-cloudflare%3Acloudflare' : '/capabilities?plugin=kiki-cloudflare';
}

export function CloudflareEntry() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { client } = useConnection();
  const installed = useInstalledPlugins();
  const marketplace = usePluginMarketplace();
  const panels = usePluginPanels();
  const plugin = installed.data?.plugins.find((item) => item.id === 'kiki-cloudflare');
  const catalogued = marketplace.data?.entries.some((item) => item.id === 'kiki-cloudflare') === true;
  const ready = plugin?.enabled === true && plugin.state === 'ok' && panels.data?.panels.some((item) => item.pluginId === 'kiki-cloudflare' && item.id === 'cloudflare') === true;
  const destination = cloudflareDestination(plugin !== undefined, catalogued, ready);
  if (destination === undefined) return null;
  return <div className="flex items-center justify-between gap-4 border-t border-hairline pt-3" data-remote-cloudflare-entry>
    <div className="min-w-0"><p className="text-[13px] text-ink">Cloudflare Tunnel</p>
      <p className="text-[12px] text-ink-faint">{t('st.remote.configuresNoHome', { origin: connectionAddress(client.baseUrl) })}</p></div>
    <button type="button" className="shrink-0 text-[12.5px] text-ink-soft underline decoration-hairline-strong underline-offset-2 hover:text-ink"
      onClick={() => { void navigate(destination); }}>{t(plugin === undefined ? 'cap.action.install' : 'cap.contrib.settings')}</button>
  </div>;
}
