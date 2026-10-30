import { useState } from 'react';
import { Link } from 'react-router-dom';

import { installedPluginsPath, pluginSettingsPath } from '@kiki/session-core/settings';
import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { InstallFlow, type InstallRequest } from '../../capabilities/InstallFlow';
import { useInstalledPlugins, useInvalidatePlugins, usePluginInfo, usePluginMarketplace } from '../../capabilities/usePlugins';
import { FeedbackLine } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { PluginSettingsPanel, settingsPanelOf } from '../plugins/PluginSettingsPanel';
import { pluginDefaultOn } from '../plugins/pluginState';

export const QQ_PLUGIN_ID = 'kiki-qq';

/**
 * The official QQ bot route of "Add channel". The bot itself is set up by the
 * QQ plugin's own QR panel, so this route is that panel, embedded where the
 * reader already is: install the plugin when it is missing, switch it on when
 * it is off, then scan. Nothing is installed without the shared preview and
 * consent sheet.
 */
export function QqPluginSetup() {
  const { t } = useI18n();
  const { client } = useConnection();
  const installed = useInstalledPlugins();
  const marketplace = usePluginMarketplace();
  const invalidate = useInvalidatePlugins();
  const [install, setInstall] = useState<InstallRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugin = installed.data?.plugins.find((item) => item.id === QQ_PLUGIN_ID);
  const info = usePluginInfo(plugin?.enabled === true && plugin.state === 'ok' ? QQ_PLUGIN_ID : undefined);

  if (installed.isPending) return <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>;

  if (plugin === undefined) {
    const entry = marketplace.data?.entries.find((item) => item.id === QQ_PLUGIN_ID);
    return (
      <div className="space-y-3" data-im-qq-plugin="missing">
        <p className="text-[13px] leading-5 text-ink-soft">{t('st.channels.qq.needPlugin')}</p>
        {entry !== undefined ? (
          <button type="button" className={PRIMARY_BUTTON} data-im-qq-install
            onClick={() => { setInstall({ source: entry.source, sha256: entry.sha256, displayName: entry.displayName, icon: entry.icon, entry }); }}>
            {t('st.channels.qq.install')}
          </button>
        ) : marketplace.isPending ? null : (
          <div className="space-y-2" data-im-qq-unlisted>
            <p className="text-[12.5px] leading-5 text-ink-faint">{t('st.channels.qq.notListed')}</p>
            <Link to={installedPluginsPath()} className={SECONDARY_BUTTON}>{t('st.channels.qq.openExtensions')}</Link>
          </div>
        )}
        {install !== null ? (
          <InstallFlow request={install} onClose={() => { setInstall(null); }}
            onInstalled={() => { setInstall(null); void invalidate(); }} />
        ) : null}
      </div>
    );
  }

  if (!plugin.enabled) {
    const enable = async () => {
      setBusy(true);
      setError(null);
      try {
        await client.setPluginState(QQ_PLUGIN_ID, { enabled: true, defaultEnabled: pluginDefaultOn(plugin) });
        await invalidate();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="space-y-3" data-im-qq-plugin="disabled">
        <p className="text-[13px] leading-5 text-ink-soft">{t('st.channels.qq.disabledHint')}</p>
        <button type="button" className={PRIMARY_BUTTON} disabled={busy} data-im-qq-enable onClick={() => { void enable(); }}>
          {t('st.channels.qq.enable')}
        </button>
        <FeedbackLine feedback={error === null ? null : { tone: 'error', text: error }} />
      </div>
    );
  }

  const panel = settingsPanelOf(info.data?.manifest);
  if (plugin.state !== 'ok' || (info.isSuccess && panel === undefined) || info.isError) {
    return (
      <div className="space-y-3" data-im-qq-plugin="unavailable">
        <p className="text-[13px] leading-5 text-ink-soft">{t('st.channels.qq.notReady')}</p>
        <Link to={pluginSettingsPath(QQ_PLUGIN_ID)} className={SECONDARY_BUTTON}>{t('st.channels.qq.openPlugin')}</Link>
      </div>
    );
  }
  if (panel === undefined) return <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>;
  return (
    <div data-im-qq-plugin="ready">
      <PluginSettingsPanel pluginId={QQ_PLUGIN_ID} panelId={panel.id} label={panel.label} />
    </div>
  );
}
