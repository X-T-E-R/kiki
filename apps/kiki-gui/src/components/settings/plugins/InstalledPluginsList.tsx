/**
 * Settings → Extensions → Plugins: the plugins on this server.
 *
 * One row per plugin, the same frame as every other managed list: icon, name,
 * origin as a quiet tag, and one line that says what the plugin does for a new
 * session right now. The row body opens the plugin's own page; the switch on
 * the right is the only control here, and it only starts or stops the plugin —
 * the plugin's default for new sessions is kept as it is.
 *
 * Finding a new plugin is a different job, so the market is one link on the
 * card heading. The list reads the installed query the Capabilities page
 * reads, so a change on either surface is what the other one shows.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { pluginSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import type { PluginSummary } from '../../../lib/client';
import { pluginOrigin, type PluginOrigin } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { LINK_CLASS } from '../../capabilities/CapabilityLink';
import { CapabilityIcon } from '../../capabilities/CapabilityIcon';
import { Tag } from '../../capabilities/primitives';
import { useInstalledPlugins, useInvalidatePlugins, usePluginMarketplace } from '../../capabilities/usePlugins';
import { FeedbackLine, InlineError, Toggle } from '../../controls';
import { Icon } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { pluginDefaultOn, pluginStatusKey, usePluginContributions } from './pluginState';

export const ORIGIN_KEYS = {
  official: 'cap.origin.official',
  catalog: 'cap.origin.catalog',
  local: 'cap.origin.local',
  git: 'cap.origin.git',
  zip: 'cap.origin.zip',
} as const satisfies Record<PluginOrigin, string>;

export function InstalledPluginsList() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = useInstalledPlugins();
  // Only used to tell an official or catalogued plugin from a local one; its
  // failure is not this page's to report.
  const entriesQuery = usePluginMarketplace();
  const plugins = query.data?.plugins ?? [];

  return (
    <SectionCard
      id="st-card-plugins"
      title={t('st.plugins.installedTitle')}
      actions={(
        <Link to="/capabilities" className={LINK_CLASS} data-plugins-market-link>
          {t('st.plugins.browseMarket')}
          <Icon name="arrowRight" size={14} />
        </Link>
      )}
    >
      {query.isPending ? (
        <p className="py-3 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
      ) : query.isError ? (
        <ListFailure error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : plugins.length === 0 ? (
        <p className="py-3 text-[13px] text-ink-soft" data-plugins-installed-empty>{t('st.plugins.noneInstalledBody')}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-hairline bg-panel" data-plugins-installed-list>
          {plugins.map((plugin) => (
            <InstalledPluginRow
              key={plugin.id}
              plugin={plugin}
              origin={pluginOrigin(plugin, entriesQuery.data?.entries ?? [])}
              onOpen={() => { void navigate(pluginSettingsPath(plugin.id)); }}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function InstalledPluginRow({ plugin, origin, onOpen }: {
  readonly plugin: PluginSummary;
  readonly origin: PluginOrigin;
  readonly onOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const contributions = usePluginContributions(plugin);
  const status = t(pluginStatusKey(plugin));

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      if (plugin.defaultEnabled === undefined) await client.setPluginEnabled(plugin.id, enabled);
      else await client.setPluginState(plugin.id, { enabled, defaultEnabled: plugin.defaultEnabled });
      await invalidate();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-hairline last:border-b-0" data-plugin-row={plugin.id}
      data-plugin-enabled={plugin.enabled ? 'true' : 'false'} data-plugin-state={plugin.state}>
      <div className="flex min-w-0 items-center gap-3 pr-3">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('st.plugins.openSettings', { name: plugin.displayName })}
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left transition-colors hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selected-ink"
          data-plugin-open-settings={plugin.id}
        >
          <span className={plugin.enabled ? '' : 'opacity-50 grayscale'}><CapabilityIcon icon={plugin.icon} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className={`min-w-0 truncate text-[13px] font-medium ${plugin.enabled ? 'text-ink' : 'text-ink-soft'}`}>{plugin.displayName}</span>
              <Tag>{t(ORIGIN_KEYS[origin])}</Tag>
              {broken ? <Tag tone="danger">{t('cap.state.error')}</Tag> : null}
            </span>
            <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-faint" data-plugin-status={pluginDefaultOn(plugin) && plugin.enabled ? 'default-on' : plugin.enabled ? 'on-demand' : 'off'}>
              {contributions === '' ? status : `${status} · ${contributions}`}
            </span>
          </span>
          <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
        </button>
        <span className="shrink-0" data-plugin-row-switch={plugin.id}>
          <Toggle layout="bare" label={t('st.plugins.enableNamed', { name: plugin.displayName })}
            checked={plugin.enabled} disabled={busy} onChange={(checked) => { void toggle(checked); }} />
        </span>
      </div>
      {failure !== null ? <div className="px-3 pb-2"><FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /></div> : null}
    </li>
  );
}

function ListFailure({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 py-2" data-plugins-installed-error>
      <InlineError error={error} />
      <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>{t('common.retry')}</button>
    </div>
  );
}
