/**
 * One installed plugin's own settings page — `/settings/plugins?plugin=<id>`.
 *
 * Every way into a plugin's configuration ends up here, so there is exactly
 * one place a plugin's settings are edited: the list offers no inline form,
 * and the Capabilities detail links here instead of embedding its own.
 *
 * A plugin is not required to declare a settings schema. When it does not, the
 * page says so and still carries the management that does apply to it — on,
 * off, the version and origin it was installed from — rather than inventing an
 * empty form or sending the reader somewhere else to find the same switch.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { installedPluginsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import type { PluginSummary } from '../../../lib/client';
import { pluginOrigin, type PluginOrigin } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { CapabilityIcon } from '../../capabilities/CapabilityIcon';
import { PluginSettingsForm } from '../../capabilities/PluginSettingsForm';
import { Tag } from '../../capabilities/primitives';
import { useInstalledPlugins, useInvalidatePlugins, usePluginMarketplace } from '../../capabilities/usePlugins';
import { FeedbackLine, InlineError, Toggle } from '../../controls';
import { Icon } from '../../icons';
import { DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from '../../ui';

const ORIGIN_KEYS = {
  official: 'cap.origin.official',
  catalog: 'cap.origin.catalog',
  local: 'cap.origin.local',
  git: 'cap.origin.git',
  zip: 'cap.origin.zip',
} as const satisfies Record<PluginOrigin, string>;

export function PluginSettingsPage({ pluginId }: { readonly pluginId: string }) {
  const { t } = useI18n();
  const installed = useInstalledPlugins();
  const entries = usePluginMarketplace();
  // The list is the one source of "is it still installed". A deep link to a
  // plugin that was never installed, or has since been removed, is not an
  // error to repair here — it is a link that no longer points at anything.
  const plugin = useMemo(
    () => (installed.data?.plugins ?? []).find((item) => item.id === pluginId),
    [installed.data, pluginId],
  );

  if (installed.isPending) {
    return <p className="py-3 text-[13px] text-ink-faint" role="status" data-plugin-settings-loading>{t('cap.loading')}</p>;
  }
  if (installed.isError) {
    return (
      <div className="space-y-2" data-plugin-settings-error>
        <InlineError error={installed.error} />
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { void installed.refetch(); }}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (plugin === undefined) return <PluginNotInstalled pluginId={pluginId} />;

  return (
    <div className="space-y-6" data-plugin-settings-page={plugin.id}>
      <PluginHeader plugin={plugin} origin={pluginOrigin(plugin, entries.data?.entries ?? [])} />
      <PluginSettingsForm pluginId={plugin.id} />
      <PluginManagement plugin={plugin} />
    </div>
  );
}

/** Back to the list, the plugin's own name, and the state it is in now. */
function PluginHeader({ plugin, origin }: {
  readonly plugin: PluginSummary;
  readonly origin: PluginOrigin;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const broken = plugin.state === 'error' || plugin.hasErrors;
  return (
    <header className="border-t border-hairline pt-6 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => { void navigate(installedPluginsPath()); }}
        className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        data-plugin-settings-back
      >
        <Icon name="arrowLeft" size={14} />
        {t('st.plugins.backToInstalled')}
      </button>
      <div className="mt-4 flex min-w-0 flex-wrap items-start gap-4">
        <CapabilityIcon icon={plugin.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-display text-[18px] leading-6 text-ink">{plugin.displayName}</h2>
            <Tag>{t(ORIGIN_KEYS[origin])}</Tag>
            {broken ? <Tag tone="danger">{t('cap.state.error')}</Tag> : null}
          </div>
          <p className="mt-1 text-[12px] text-ink-faint">
            {[plugin.version !== undefined ? `v${plugin.version}` : undefined, plugin.id]
              .filter((part) => part !== undefined).join(' · ')}
          </p>
          {broken ? (
            <p role="alert" className="mt-2 text-[13px] text-danger" data-plugin-settings-broken>
              {t('st.plugins.brokenState')}
            </p>
          ) : null}
        </div>
        <PluginSwitch plugin={plugin} />
      </div>
    </header>
  );
}

/**
 * The on/off switch, beside the plugin's name. Turning a plugin off is a fact
 * about the plugin rather than a setting of it, so it belongs with the identity
 * and not in a block of its own below.
 */
function PluginSwitch({ plugin }: { readonly plugin: PluginSummary }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  return (
    <div className="shrink-0" data-plugin-settings-switch>
      <Toggle
        label={plugin.enabled ? t('cap.state.on') : t('cap.state.off')}
        checked={plugin.enabled}
        disabled={busy}
        onChange={(checked) => {
          setBusy(true);
          setFailure(null);
          void (async () => {
            try {
              await client.setPluginEnabled(plugin.id, checked);
              await invalidate();
            } catch (error) {
              setFailure(error);
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
      {failure !== null ? <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /> : null}
    </div>
  );
}

/**
 * Removing a plugin. It stays a separate, explicit step with the confirmation
 * it has always had, and it never shares a row with anything else.
 */
function PluginManagement({ plugin }: { readonly plugin: PluginSummary }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  /** Runs one management action; reports whether the server accepted it. */
  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await invalidate();
      return true;
    } catch (error) {
      setFailure(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-hairline pt-4">
      {failure !== null ? (
        <div className="mb-2"><FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /></div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className={DANGER_GHOST_BUTTON}
          disabled={busy}
          onClick={() => { setConfirmRemove(true); }}
          data-plugin-remove={plugin.id}
        >
          {t('cap.action.remove')}
        </button>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        overlayId="confirm-plugin-settings-remove"
        title={t('cap.remove.title', { name: plugin.displayName })}
        body={t('cap.remove.body')}
        confirmLabel={t('cap.action.remove')}
        tone="danger"
        busy={busy}
        onCancel={() => { setConfirmRemove(false); }}
        onConfirm={() => {
          setConfirmRemove(false);
          void act(() => client.removePlugin(plugin.id, { deleteData: false })).then((done) => {
            // A removal that failed leaves the plugin installed, so the page is
            // still true and the reader keeps their unsaved draft. One that
            // succeeded leaves nothing here to look at, so it returns to the
            // list rather than to this plugin's own now-missing page.
            if (done) void navigate(installedPluginsPath());
          });
        }}
      />
    </div>
  );
}

/**
 * A link to a plugin this server does not have installed. It says what is
 * true and offers the way back to the list, where the market is one click away
 * if the reader wants the plugin at all. It never installs anything itself, and
 * never falls back to some other plugin's page — a link that no longer points
 * anywhere should read as a dead link, not as a different plugin.
 */
function PluginNotInstalled({ pluginId }: { readonly pluginId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="space-y-4 py-2" data-plugin-settings-missing={pluginId}>
      <div>
        <h2 className="font-display text-[18px] leading-6 text-ink">{t('st.plugins.notInstalledTitle')}</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">
          {t('st.plugins.notInstalledBody', { id: pluginId })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => { void navigate(installedPluginsPath()); }}
          data-plugin-settings-back
        >
          {t('st.plugins.backToInstalled')}
        </button>
      </div>
    </div>
  );
}