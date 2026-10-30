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

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import type { PluginUsageResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { installedPluginsPath, workspacesSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import type { PluginSummary } from '../../../lib/client';
import { pluginOrigin, type PluginOrigin } from '../../../lib/pluginCatalog';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { CapabilityIcon } from '../../capabilities/CapabilityIcon';
import { LINK_CLASS } from '../../capabilities/CapabilityLink';
import { PluginSettingsForm } from '../../capabilities/PluginSettingsForm';
import { isStaleRevision, isStaleScope, scopeOf } from '../../capabilities/pluginUsage';
import { Tag } from '../../capabilities/primitives';
import { useInstalledPlugins, useInvalidatePlugins, usePluginInfo, usePluginMarketplace } from '../../capabilities/usePlugins';
import { PluginSettingsPanel, settingsPanelOf } from './PluginSettingsPanel';
import { ORIGIN_KEYS } from './InstalledPluginsList';
import { pluginDefaultOn, usePluginContributions } from './pluginState';
import { FeedbackLine, InlineError, Toggle } from '../../controls';
import { SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { Icon } from '../../icons';
import { SettingsSegmented } from '../SettingsPrimitives';
import { DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from '../../ui';

export function PluginSettingsPage({ pluginId }: { readonly pluginId: string }) {
  const { t } = useI18n();
  const installed = useInstalledPlugins();
  const entries = usePluginMarketplace();
  // The list is the one source of "is it still installed". A deep link to a
  // plugin that is not installed reads as a dead link, not as an error.
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
      <PluginEffectiveScope plugin={plugin} />
      <SectionCard id="st-card-plugin-settings" title={t('cap.settings.title')}>
        <PluginSettingsBody plugin={plugin} />
      </SectionCard>
      <PluginManagement plugin={plugin} />
    </div>
  );
}

interface CachedWorkspaceUsage {
  readonly queryKey: QueryKey;
  readonly response: PluginUsageResponse;
  readonly item: PluginUsageResponse['plugins'][number];
}

/**
 * Primitive cache token for one plugin. Workspace id, revision, this plugin's
 * override and the server's name — not the usage document. `useSyncExternalStore`
 * compares it with `Object.is`, so an unchanged cache does not re-render.
 */
export function workspaceUsageCacheToken(queryClient: QueryClient, pluginId: string): string {
  const parts: string[] = [];
  for (const [, data] of queryClient.getQueriesData<PluginUsageResponse>({ queryKey: ['plugin-usage'] })) {
    if (data?.target.workspace_id === undefined || data.target.session_id !== undefined) continue;
    const item = data.plugins.find((candidate) => candidate.id === pluginId);
    parts.push(`${data.target.workspace_id}\u0001${data.revision}\u0001${item?.override ?? ''}\u0001${data.target.name}`);
  }
  parts.sort();
  return parts.join('\u0002');
}

/** Follows workspace usage already in the cache. Subscribing to the cache does not register a usage query. */
export function useWorkspaceUsageCacheToken(pluginId: string): string {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) => queryClient.getQueryCache().subscribe(listener),
    [queryClient],
  );
  const read = useCallback(
    () => workspaceUsageCacheToken(queryClient, pluginId),
    [queryClient, pluginId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Workspace usage already in memory. Reading the cache does not register a usage query. */
function cachedWorkspaceUsages(queryClient: QueryClient, pluginId: string): readonly CachedWorkspaceUsage[] {
  const found = new Map<string, CachedWorkspaceUsage>();
  for (const [queryKey, data] of queryClient.getQueriesData<PluginUsageResponse>({ queryKey: ['plugin-usage'] })) {
    if (data?.target.workspace_id === undefined || data.target.session_id !== undefined) continue;
    const item = data.plugins.find((candidate) => candidate.id === pluginId);
    if (item === undefined) continue;
    const previous = found.get(data.target.workspace_id);
    if (previous !== undefined && isStaleRevision(previous.response.revision, data.revision)) continue;
    found.set(data.target.workspace_id, { queryKey, response: data, item });
  }
  return [...found.values()].sort((a, b) => a.response.target.workspace_id.localeCompare(b.response.target.workspace_id));
}

/**
 * The plugin's two switches, the same pair every optional system capability
 * has: 启用 (may it run at all) and 新会话默认开启 (does a session start with it
 * on). Below them, the workspaces that made their own choice — only those, and
 * only the ones already known to this page; each can go back to the default.
 */
function PluginEffectiveScope({ plugin }: { readonly plugin: PluginSummary }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePlugins();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const usageCacheToken = useWorkspaceUsageCacheToken(plugin.id);
  const exceptions = useMemo(
    () => cachedWorkspaceUsages(queryClient, plugin.id),
    [queryClient, plugin.id, usageCacheToken],
  );
  const defaultOn = pluginDefaultOn(plugin);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await invalidate();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const setWorkspaceOverride = (entry: CachedWorkspaceUsage, override: 'inherit' | 'on' | 'off') => run(async () => {
    if (typeof client.setPluginUsage !== 'function') return;
    const response = await client.setPluginUsage({
      target: { workspace_id: entry.response.target.workspace_id },
      plugin_id: plugin.id,
      override,
    });
    if (!isStaleScope(response, scopeOf(entry.response))) {
      const prev = queryClient.getQueryData<PluginUsageResponse>(entry.queryKey);
      if (prev === undefined || !isStaleRevision(prev.revision, response.revision)) queryClient.setQueryData(entry.queryKey, response);
    }
  });

  return (
    <section className="space-y-1" data-plugin-effective-scope={plugin.id} data-plugin-scope-global={plugin.enabled && defaultOn ? 'on' : 'off'}>
      <SettingField label={t('st.plugins.enable')} htmlFor={`plugin-${plugin.id}-enabled`} help={plugin.enabled ? undefined : t('st.plugins.enableOffHint')}>
        <span data-plugin-settings-switch>
          <Toggle id={`plugin-${plugin.id}-enabled`} layout="bare" label={t('st.plugins.enable')} checked={plugin.enabled} disabled={busy}
            onChange={(checked) => { void run(() => plugin.defaultEnabled === undefined
              ? client.setPluginEnabled(plugin.id, checked)
              : client.setPluginState(plugin.id, { enabled: checked, defaultEnabled: plugin.defaultEnabled })); }} />
        </span>
      </SettingField>
      <SettingField label={t('cap.defaultOn')} htmlFor={`plugin-${plugin.id}-default-on`} help={t(defaultOn ? 'st.plugins.defaultOnHint' : 'st.plugins.defaultOffHint')}>
        <span data-plugin-default-switch>
          <Toggle id={`plugin-${plugin.id}-default-on`} layout="bare" label={t('cap.defaultOn')} checked={plugin.enabled && defaultOn}
            disabled={busy || !plugin.enabled}
            onChange={(checked) => { void run(() => client.setPluginState(plugin.id, { enabled: true, defaultEnabled: checked })); }} />
        </span>
      </SettingField>
      {plugin.enabled ? (
        <div className="pt-2" data-plugin-scope-exceptions>
          <div className="flex items-center justify-between gap-3 py-1">
            <span className="text-[12px] text-ink-soft">
              {exceptions.some((entry) => entry.item.override !== 'inherit') ? t('st.plugins.exceptionsTitle') : t('st.plugins.exceptionsNone')}
            </span>
            <Link to={workspacesSettingsPath()} className={LINK_CLASS} data-plugin-scope-workspaces>
              {t('st.plugins.exceptionsManage')}
              <Icon name="arrowRight" size={14} />
            </Link>
          </div>
          {exceptions.filter((entry) => entry.item.override !== 'inherit').map((entry) => (
            <div key={entry.response.target.workspace_id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-[13px]" data-plugin-scope-workspace={entry.response.target.workspace_id}>
              <span className="min-w-0 truncate text-ink">{entry.response.target.name}</span>
              <SettingsSegmented
                choices={[
                  { value: 'inherit', label: t('st.plugins.followDefault') },
                  { value: 'on', label: t('cap.state.on') },
                  { value: 'off', label: t('cap.state.off') },
                ]}
                value={entry.item.override}
                disabled={busy}
                onChange={(next) => { void setWorkspaceOverride(entry, next); }}
                ariaLabel={entry.response.target.name}
                dataAttr="data-plugin-workspace-override"
              />
            </div>
          ))}
        </div>
      ) : null}
      {failure !== null ? <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /> : null}
    </section>
  );
}

/**
 * The plugin's own settings panel when it ships one and the master switch
 * still allows the document. Otherwise the generic schema form, which is also
 * what a turned-off plugin keeps: its document route refuses a disabled plugin.
 *
 * A manifest read that failed is reported in place instead of being read as
 * "this plugin declares no settings" — the page does not know yet, and saying
 * otherwise would send the reader away from a form that exists. Its retry asks
 * both reads again, so one click repairs the whole body.
 */
function PluginSettingsBody({ plugin }: { readonly plugin: PluginSummary }) {
  const { t } = useI18n();
  const { scopeId, meta } = useConnection();
  const queryClient = useQueryClient();
  const info = usePluginInfo(plugin.id);
  const panel = settingsPanelOf(info.data?.manifest);
  const canOpen = plugin.enabled && plugin.state === 'ok' && panel !== undefined;
  if (plugin.enabled && plugin.state === 'ok' && info.isPending) {
    return <p className="py-2 text-[13px] text-ink-faint" role="status" data-plugin-settings-panel-loading>{t('cap.loading')}</p>;
  }
  if (canOpen && panel !== undefined) {
    return (
      <PluginSettingsPanel
        key={`${scopeId}:${meta?.server_id ?? ''}:${plugin.id}:${panel.id}`}
        pluginId={plugin.id}
        panelId={panel.id}
        label={panel.label}
      />
    );
  }
  const manifestUnread = info.isError;
  return (
    <div className="space-y-2">
      {manifestUnread ? (
        <div className="space-y-2" data-plugin-settings-manifest-error>
          <InlineError error={info.error} />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              void info.refetch();
              void queryClient.invalidateQueries({ queryKey: ['plugin-settings', plugin.id] });
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : null}
      {panel !== undefined && !plugin.enabled ? (
        <p className="text-[13px] text-ink-faint" data-plugin-settings-panel-off>{t('cap.settings.panelOff')}</p>
      ) : null}
      <PluginSettingsForm pluginId={plugin.id} showEmptyNote={panel === undefined && !manifestUnread} />
    </div>
  );
}

/** Back to the list, the plugin's own name, where it came from, what it brings. */
function PluginHeader({ plugin, origin }: {
  readonly plugin: PluginSummary;
  readonly origin: PluginOrigin;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const broken = plugin.state === 'error' || plugin.hasErrors;
  const contributions = usePluginContributions(plugin);
  return (
    <header>
      <button
        type="button"
        onClick={() => { void navigate(installedPluginsPath()); }}
        className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        data-plugin-settings-back
      >
        <Icon name="arrowLeft" size={14} />
        {t('st.plugins.backToInstalled')}
      </button>
      <div className="mt-4 flex min-w-0 items-center gap-4">
        <span className={plugin.enabled ? '' : 'opacity-50 grayscale'}><CapabilityIcon icon={plugin.icon} size="lg" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-display text-[20px] leading-7 text-ink">{plugin.displayName}</h2>
            <Tag>{t(ORIGIN_KEYS[origin])}</Tag>
            {broken ? <Tag tone="danger">{t('cap.state.error')}</Tag> : null}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-faint" data-plugin-header-facts title={plugin.id}>
            {[plugin.version !== undefined ? `v${plugin.version}` : undefined, contributions === '' ? undefined : contributions]
              .filter((part) => part !== undefined).join(' · ')}
          </p>
        </div>
      </div>
      {broken ? (
        <p role="alert" className="mt-3 text-[13px] text-danger" data-plugin-settings-broken>{t('st.plugins.brokenState')}</p>
      ) : null}
    </header>
  );
}

/**
 * Taking a plugin back or off the server. Quiet, at the bottom, each behind
 * the confirmation it has always had; neither shares a row with a setting.
 */
function PluginManagement({ plugin }: { readonly plugin: PluginSummary }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const invalidate = useInvalidatePlugins();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<'remove' | 'rollback' | null>(null);
  const previous = plugin.rollback === undefined ? undefined : plugin.rollback.version ?? t('cap.detail.previous');

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
    <SectionCard id="st-card-plugin-manage" title={t('st.plugins.manageTitle')}>
      <div className="flex flex-wrap items-center gap-2">
        {previous !== undefined ? (
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => { setConfirm('rollback'); }} data-plugin-rollback={plugin.id}>
            {t('cap.action.rollback', { version: previous })}
          </button>
        ) : null}
        <button type="button" className={DANGER_GHOST_BUTTON} disabled={busy} onClick={() => { setConfirm('remove'); }} data-plugin-remove={plugin.id}>
          {t('cap.action.remove')}
        </button>
      </div>
      {failure !== null ? <div className="mt-2"><FeedbackLine feedback={{ tone: 'error', text: errorText(locale, failure) }} /></div> : null}
      <ConfirmDialog
        open={confirm === 'remove'}
        overlayId="confirm-plugin-settings-remove"
        title={t('cap.remove.title', { name: plugin.displayName })}
        body={t('cap.remove.body')}
        confirmLabel={t('cap.action.remove')}
        tone="danger"
        busy={busy}
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => {
          setConfirm(null);
          void act(() => client.removePlugin(plugin.id, { deleteData: false })).then((done) => {
            if (done) void navigate(installedPluginsPath());
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        overlayId="confirm-plugin-settings-rollback"
        title={t('cap.rollback.title', { name: plugin.displayName, version: previous ?? '' })}
        body={t('cap.rollback.body')}
        confirmLabel={t('cap.action.rollback', { version: previous ?? '' })}
        busy={busy}
        onCancel={() => { setConfirm(null); }}
        onConfirm={() => {
          setConfirm(null);
          void act(() => client.rollbackPlugin(plugin.id));
        }}
      />
    </SectionCard>
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