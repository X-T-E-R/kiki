/**
 * Settings → Plugins: the plugins on this server, as the page's subject.
 *
 * This is a management list, not a market. Every row is one installed plugin
 * — the real name its own manifest carries, where it came from, its version,
 * whether it is on or broken — and the whole row is one move: to that
 * plugin's own settings page. Nothing configures in place here, so a list
 * stays readable however many plugins are installed.
 *
 * The list reads the installed query the Capabilities page reads, so a toggle
 * or a removal made on either surface is what the other one shows.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { pluginSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import type { PluginSummary } from '../../../lib/client';
import { pluginOrigin, type PluginOrigin } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { CapabilityIcon } from '../../capabilities/CapabilityIcon';
import { Tag } from '../../capabilities/primitives';
import { useInstalledPlugins, useInvalidatePlugins, usePluginMarketplace } from '../../capabilities/usePlugins';
import { FeedbackLine, InlineError, Toggle } from '../../controls';
import { Icon } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';

/** Where a plugin came from, in the words the plugin list already uses. */
const ORIGIN_KEYS = {
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
  // The catalog is only here to tell an official or catalogued plugin from a
  // local one. Its query key is the one the Capabilities page already holds, so
  // this costs no extra round-trip after a visit there — and its failure is
  // this page's not to report: a plugin that is installed is still installed.
  const entriesQuery = usePluginMarketplace();
  const plugins = query.data?.plugins ?? [];

  return (
    <SectionCard id="st-card-plugins" title={t('st.plugins.installedTitle')}>
      {query.isPending ? (
        <p className="py-3 text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
      ) : query.isError ? (
        <ListFailure error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : plugins.length === 0 ? (
        <div className="py-3" data-plugins-installed-empty>
          <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.plugins.noneInstalledBody')}</p>
          <MarketLink />
        </div>
      ) : (
        <>
          <ul className="mt-1" data-plugins-installed-list>
            {plugins.map((plugin) => (
              <InstalledPluginRow
                key={plugin.id}
                plugin={plugin}
                origin={pluginOrigin(plugin, entriesQuery.data?.entries ?? [])}
                onOpen={() => { void navigate(pluginSettingsPath(plugin.id)); }}
              />
            ))}
          </ul>
          <MarketLink />
        </>
      )}
    </SectionCard>
  );
}

/**
 * The market is where a plugin is found and installed, so this leaf only says
 * so once and links there. It is deliberately a link rather than a second
 * copy of the catalog.
 */
function MarketLink() {
  const { t } = useI18n();
  return (
    <div className="mt-5 border-t border-hairline pt-3">
      <Link
        to="/capabilities"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-selected-ink transition-colors hover:underline"
        data-plugins-market-link
      >
        {t('st.plugins.browseMarket')}
        <Icon name="arrowRight" size={14} />
      </Link>
    </div>
  );
}

/**
 * One installed plugin. The name is the target and the switch sits beside it,
 * so turning a plugin off never requires entering its settings page, and
 * entering it never takes a control away that belongs to the list.
 */
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

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      await client.setPluginEnabled(plugin.id, enabled);
      await invalidate();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-hairline last:border-b-0" data-plugin-row={plugin.id}
      data-plugin-enabled={plugin.enabled ? 'true' : 'false'}
      data-plugin-state={plugin.state}>
      <div className="flex min-w-0 items-center gap-3 py-2.5">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('st.plugins.openSettings', { name: plugin.displayName })}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
          data-plugin-open-settings={plugin.id}
        >
          <span className={plugin.enabled ? '' : 'opacity-60 grayscale'}><CapabilityIcon icon={plugin.icon} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className={`min-w-0 truncate text-[13px] font-medium ${plugin.enabled ? 'text-ink' : 'text-ink-soft'}`}>{plugin.displayName}</span>
              <span className="shrink-0"><Tag>{t(ORIGIN_KEYS[origin])}</Tag></span>
              {broken ? <span className="shrink-0"><Tag tone="danger">{t('cap.state.error')}</Tag></span> : null}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-ink-faint">
              {[plugin.version !== undefined ? `v${plugin.version}` : undefined, plugin.id]
                .filter((part) => part !== undefined).join(' · ')}
            </span>
          </span>
          <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
        </button>
        <span className="shrink-0">
          <Toggle
            label={plugin.enabled ? t('cap.state.on') : t('cap.state.off')}
            checked={plugin.enabled}
            disabled={busy}
            onChange={(checked) => { void toggle(checked); }}
          />
        </span>
      </div>
      {failure !== null ? <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /> : null}
    </li>
  );
}

/** The list's own failure: what went wrong, and the one move that retries it. */
function ListFailure({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 py-2" data-plugins-installed-error>
      <InlineError error={error} />
      <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}